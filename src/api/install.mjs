/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/install.mjs
 *	@Date: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Local APK install API module for DroidSock (adb install equivalent)
 */

import { self } from "@cldmv/slothlet/runtime";
import path from "node:path";
import { open } from "node:fs/promises";

// Chunk size for stdin writes on the exec:cmd stream. Not protocol-mandated -
// ADB streams are otherwise unbounded per WRTE frame - but kept aligned with
// the SYNC sub-protocol's own 64KB DATA ceiling (files.mjs) for consistency
// and to stay safely under every known device max-payload negotiation.
const EXEC_WRITE_CHUNK = 64 * 1024;

/**
 * Validates flags before they're joined and interpolated into the
 * `exec:cmd package install ...` destination string. A non-array throws a
 * confusing TypeError from .join() with no context; a flag containing
 * whitespace would silently split into multiple argv tokens once joined and
 * re-parsed by the device shell, changing what's actually passed to `pm
 * install` from what the caller specified.
 * @param {*} flags - Value to validate.
 * @returns {Array<string>} The validated flags, unchanged.
 */
function assertValidFlags(flags) {
	if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === "string" && flag.length > 0 && !/\s/.test(flag))) {
		// JSON.stringify() throws on a circular value - fall back to String()
		// (which can't throw for this) so the validation error itself is never
		// masked by a formatting failure.
		let described;
		try {
			described = JSON.stringify(flags);
		} catch {
			described = String(flags);
		}
		throw new Error(`Invalid flags: ${described} (must be an array of non-empty, whitespace-free strings)`);
	}
	return flags;
}

/**
 * Installs a local APK using the classic push-then-install flow: pushes the
 * file to a device temp directory via the existing SYNC-based push, runs
 * `pm install` against it, then removes the pushed temp file regardless of
 * whether the install succeeded. Pure composition of two already-implemented
 * primitives (files.push, shell.commands.installApk) - no new protocol work.
 * EXPERIMENTAL - depends on files.push(), which hasn't been validated
 * against a real device yet. See #2.
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} localPath - Local APK file path
 * @param {Object} [options={}] - Options
 * @param {Array<string>} [options.flags=[]] - `pm install` flags (e.g. ["-r"] to reinstall)
 * @param {string} [options.remoteDir="/data/local/tmp"] - Device directory to push the APK into
 * @param {Function} [options.onProgress] - Push progress callback, see files.push
 * @returns {Promise<string>} `pm install`'s output
 */
export async function classic(socket, streamManager, localPath, options = {}) {
	const { flags = [], remoteDir = "/data/local/tmp", onProgress } = options;
	// path.posix specifically - the device path is always POSIX regardless of
	// the host OS running droidsock, and join() also normalizes a remoteDir
	// that already ends in "/" instead of producing a double slash.
	const remotePath = path.posix.join(remoteDir, path.basename(localPath));

	try {
		await self.files.push(socket, streamManager, localPath, remotePath, { onProgress });
		return await self.shell.commands.installApk(socket, streamManager, remotePath, flags);
	} finally {
		// Best-effort cleanup regardless of whether push or install failed - if push
		// threw partway through, the device can be left with a partial temp APK at
		// remotePath, and files.push itself doesn't clean up after its own failures.
		await self.files.remove(socket, streamManager, remotePath).catch(() => {
			// A failed remove here shouldn't mask the install result/error.
		});
	}
}

/**
 * Installs a local APK using the modern streaming install service: opens an
 * `exec:cmd package install -S <size>` stream and writes the raw APK bytes
 * directly as the command's stdin over WRTE frames - no on-device file is
 * ever written. The `-S <size>` flag tells `pm install` exactly how many
 * stdin bytes to expect, which is what lets this work without any explicit
 * stdin-close signal (ADB streams have no half-close). Reads the local file
 * in EXEC_WRITE_CHUNK-sized pieces via a file handle rather than loading the
 * whole APK into memory up front, so peak host memory stays bounded to one
 * chunk regardless of APK size. The file is opened once and its size is read
 * from that open handle (fileHandle.stat(), not fs.stat(localPath)) - a
 * separate stat-then-open on the path would be a TOCTOU (CodeQL
 * js/file-system-race): the file could be replaced between the two calls,
 * making the declared `-S <size>` not match what's actually read. Once
 * opened, the handle's descriptor refers to the file's inode regardless of
 * what later happens to the path. EXPERIMENTAL - this is droidsock's first
 * use of an `exec:` stream and its first case of writing raw binary data as
 * a command's stdin; not yet validated against a real device, and requires
 * the device to advertise the "cmd" feature. See #2.
 * @param {Object} ___socket - ADB socket (unused - the exec stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} localPath - Local APK file path
 * @param {Object} [options={}] - Options
 * @param {Array<string>} [options.flags=[]] - `cmd package install` flags (e.g. ["-r"] to reinstall)
 * @param {Function} [options.onProgress] - Progress callback, called with {bytesTransferred, totalBytes}
 * @returns {Promise<string>} `cmd package install`'s output
 */
export async function streaming(___socket, streamManager, localPath, options = {}) {
	const { flags = [], onProgress } = options;
	assertValidFlags(flags);
	const fileHandle = await open(localPath, "r");
	try {
		const { size: totalBytes } = await fileHandle.stat();
		const flagsStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
		const destination = `exec:cmd package install -S ${totalBytes}${flagsStr}`;

		const stream = await streamManager.openStream(destination);
		try {
			// Collected and concatenated once at the end rather than
			// Buffer.concat()'d on every "data" event - the latter reallocates
			// and copies the entire output so far on each chunk, which is
			// quadratic in the number of chunks for `pm install`'s (typically
			// short, but unbounded) stdout.
			const outputChunks = [];
			// Set synchronously inside the "close"/"error" listeners themselves
			// (not via a .then()/.catch() reaction on `closed`) - a device can
			// close the stream normally mid-transfer, not just error it, and
			// `closed` only ever REJECTS (on "error"), never on a plain "close".
			// A promise reaction would also add a microtask hop of delay; setting
			// the flag directly in the listener closes the race window as soon
			// as the event fires, with no indirection.
			let stopped = false;
			const closed = new Promise((resolve, reject) => {
				stream.on("data", (chunk) => {
					outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				stream.once("close", () => {
					stopped = true;
					resolve();
				});
				stream.once("error", (error) => {
					stopped = true;
					reject(error);
				});
			});
			// Reading from disk and writing to the stream both cross real async
			// boundaries, unlike a synchronous loop over an already-buffered file -
			// this attaches a handler immediately so a mid-transfer stream error
			// can't surface as an unhandled rejection in the gap before the loop
			// reaches `await closed` below (the flag itself is set above, not here).
			closed.catch(() => {});

			let bytesTransferred = 0;
			while (!stopped) {
				// A fresh buffer per read, never reused across iterations - Node's
				// socket.write() may queue the buffer it's given rather than copy it
				// immediately, so writing the same backing buffer again before a
				// prior write has actually flushed would corrupt in-flight data.
				const buffer = Buffer.alloc(EXEC_WRITE_CHUNK);
				const { bytesRead } = await fileHandle.read(buffer, 0, EXEC_WRITE_CHUNK, null);
				if (bytesRead === 0) break;
				// `stopped` is set synchronously inside the "close"/"error"
				// listeners above, but the stream can still die while the read
				// itself was in flight - re-check right here rather than relying
				// solely on the `while` condition checked before the read started,
				// as a belt-and-suspenders guard against writing to an already-dead
				// stream.
				if (stopped) break;
				await stream.write(bytesRead === EXEC_WRITE_CHUNK ? buffer : buffer.subarray(0, bytesRead));
				bytesTransferred += bytesRead;
				if (onProgress) onProgress({ bytesTransferred, totalBytes });
			}

			// A rejection here (from the stream's "error" listener) surfaces the
			// real underlying error and takes priority over the check below.
			await closed;

			// AdbStream only ever emits "close", never "error", for a normal
			// CLSE - so a device disconnecting before consuming the full APK
			// resolves `closed` cleanly with no distinguishing error, even
			// though the install never actually completed. Compare against
			// totalBytes (not "did the loop reach a zero-byte read") since the
			// stream can legitimately close right after the last chunk is
			// written, before the loop gets another read to confirm EOF - that
			// case already sent everything and must not be flagged as
			// incomplete. Without this check at all, callers (and
			// devices.install()'s classic-path fallback) would treat a
			// genuinely partial transfer as a successful install.
			if (bytesTransferred < totalBytes) {
				throw new Error(`Exec stream closed before the full APK was sent (${bytesTransferred} of ${totalBytes} bytes transferred)`);
			}
			return Buffer.concat(outputChunks).toString("utf8");
		} finally {
			stream.close();
		}
	} finally {
		await fileHandle.close();
	}
}
