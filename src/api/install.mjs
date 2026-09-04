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
import { readFile } from "node:fs/promises";

// Chunk size for stdin writes on the exec:cmd stream. Not protocol-mandated -
// ADB streams are otherwise unbounded per WRTE frame - but kept aligned with
// the SYNC sub-protocol's own 64KB DATA ceiling (files.mjs) for consistency
// and to stay safely under every known device max-payload negotiation.
const EXEC_WRITE_CHUNK = 64 * 1024;

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
 * stdin-close signal (ADB streams have no half-close). EXPERIMENTAL - this is
 * droidsock's first use of an `exec:` stream and its first case of writing
 * raw binary data as a command's stdin; not yet validated against a real
 * device, and requires the device to advertise the "cmd" feature. See #2.
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
	const data = await readFile(localPath);
	const flagsStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
	const destination = `exec:cmd package install -S ${data.length}${flagsStr}`;

	const stream = await streamManager.openStream(destination);
	try {
		let output = Buffer.alloc(0);
		const closed = new Promise((resolve, reject) => {
			stream.on("data", (chunk) => {
				output = Buffer.concat([output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
			});
			stream.once("close", resolve);
			stream.once("error", reject);
		});

		let offset = 0;
		while (offset < data.length) {
			const chunk = data.subarray(offset, Math.min(offset + EXEC_WRITE_CHUNK, data.length));
			await stream.write(chunk);
			offset += chunk.length;
			if (onProgress) onProgress({ bytesTransferred: offset, totalBytes: data.length });
		}

		await closed;
		return output.toString("utf8");
	} finally {
		stream.close();
	}
}
