/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/files.mjs
 *	@Date: 2025-11-21 12:19:19 -08:00 (1763756359)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * File transfer operations API module for DroidSock
 */

import { self } from "@cldmv/slothlet/runtime";
import { parseListing, quoteShellArg } from "./utils.mjs";
import { readFile, writeFile } from "node:fs/promises";

// ADB SYNC sub-protocol (nested inside a stream opened to the "sync:"
// destination). EXPERIMENTAL: implemented directly from the public protocol
// spec (AOSP adb/SYNC.TXT; cross-checked against Google's own reference
// client, google/python-adb's filesync_protocol.py) - not yet exercised
// against a real device. See #2 for the real-device validation this needs.
//
// Every SYNC frame is an 8-byte header - a 4-byte ASCII id followed by a
// 4-byte little-endian value - optionally followed by `value` bytes of
// payload. The one asymmetric special case: the DONE frame WE send to
// terminate a push repurposes that 4-byte value field to carry the desired
// mtime (seconds since epoch) instead of a payload length, and sends no
// payload bytes at all.
const SYNC_ID_SEND = "SEND";
const SYNC_ID_RECV = "RECV";
const SYNC_ID_LIST = "LIST";
const SYNC_ID_DENT = "DENT";
const SYNC_ID_DATA = "DATA";
const SYNC_ID_DONE = "DONE";
const SYNC_ID_OKAY = "OKAY";
const SYNC_ID_FAIL = "FAIL";
const SYNC_ID_QUIT = "QUIT";
const SYNC_DATA_MAX = 64 * 1024; // protocol ceiling per DATA chunk
const SYNC_DENT_HEADER_SIZE = 20; // id(4) + mode(4) + size(4) + mtime(4) + namelen(4)
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * Builds a SYNC frame: a 4-byte ascii id + 4-byte little-endian value,
 * followed by `payload` when given.
 * @param {string} id - Four-character SYNC frame id (e.g. "SEND").
 * @param {number|Buffer} valueOrPayload - The frame's payload (its own length becomes the header value), or a raw numeric header value for a payload-less frame (e.g. DONE's mtime).
 * @returns {Buffer} The framed packet, ready to write to the sync stream.
 */
function buildSyncFrame(id, valueOrPayload) {
	const payload = Buffer.isBuffer(valueOrPayload) ? valueOrPayload : Buffer.alloc(0);
	const value = Buffer.isBuffer(valueOrPayload) ? valueOrPayload.length : valueOrPayload;

	const header = Buffer.alloc(8);
	header.write(id, 0, 4, "ascii");
	header.writeUInt32LE(value >>> 0, 4);
	return Buffer.concat([header, payload]);
}

/**
 * Wraps an opened sync stream with a pull-based frame reader that buffers
 * incoming chunks and reassembles complete SYNC frames (id + value + payload)
 * regardless of how the underlying WRTE data happens to be chunked.
 * @param {Object} stream - An ADB stream already opened to "sync:".
 * @returns {{ next: () => Promise<{id: string, value: number, payload: Buffer}> }} Frame reader.
 */
function createSyncFrameReader(stream) {
	let buffer = Buffer.alloc(0);
	const pending = [];
	let waiter = null;

	function drain() {
		while (buffer.length >= 8) {
			const id = buffer.toString("ascii", 0, 4);
			const value = buffer.readUInt32LE(4);
			if (buffer.length < 8 + value) return;
			const payload = Buffer.from(buffer.subarray(8, 8 + value));
			buffer = buffer.subarray(8 + value);
			pending.push({ id, value, payload });
		}
		if (pending.length > 0 && waiter) {
			const resolve = waiter;
			waiter = null;
			resolve();
		}
	}

	stream.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		drain();
	});

	return {
		async next() {
			while (pending.length === 0) {
				await new Promise((resolve) => {
					waiter = resolve;
				});
			}
			return pending.shift();
		}
	};
}

/**
 * Wraps an opened sync stream with a reader for LIST responses. DENT entries
 * don't follow the generic SYNC frame shape (id + 4-byte value + payload) -
 * they pack four 4-byte fields (mode, size, mtime, namelen) before the
 * variable-length name, so LIST needs its own frame shape. DONE/FAIL on this
 * same stream still use the generic shape.
 *
 * If the stream closes or errors before a DONE/FAIL frame arrives (a real
 * disconnect or protocol error), a pending/future next() rejects instead of
 * waiting forever - otherwise a caller (and quitSyncStream()'s cleanup) would
 * hang indefinitely.
 * @param {Object} stream - An ADB stream already opened to "sync:".
 * @returns {{ next: () => Promise<{id: string, mode?: number, size?: number, mtime?: number, name?: string, value?: number, payload?: Buffer}> }} Frame reader.
 */
function createListFrameReader(stream) {
	let buffer = Buffer.alloc(0);
	const pending = [];
	let waiter = null;
	let endError = null;

	function drain() {
		for (;;) {
			if (buffer.length < 4) break;
			const id = buffer.toString("ascii", 0, 4);

			if (id === SYNC_ID_DENT) {
				if (buffer.length < SYNC_DENT_HEADER_SIZE) break;
				const mode = buffer.readUInt32LE(4);
				const size = buffer.readUInt32LE(8);
				const mtime = buffer.readUInt32LE(12);
				const namelen = buffer.readUInt32LE(16);
				if (buffer.length < SYNC_DENT_HEADER_SIZE + namelen) break;
				const name = buffer.toString("utf8", SYNC_DENT_HEADER_SIZE, SYNC_DENT_HEADER_SIZE + namelen);
				buffer = buffer.subarray(SYNC_DENT_HEADER_SIZE + namelen);
				pending.push({ id, mode, size, mtime, name });
				continue;
			}

			if (buffer.length < 8) break;
			const value = buffer.readUInt32LE(4);
			if (buffer.length < 8 + value) break;
			const payload = Buffer.from(buffer.subarray(8, 8 + value));
			buffer = buffer.subarray(8 + value);
			pending.push({ id, value, payload });
		}
		if (pending.length > 0 && waiter) {
			const resolve = waiter.resolve;
			waiter = null;
			resolve();
		}
	}

	function endWith(error) {
		if (endError) return;
		endError = error || new Error("Sync stream ended before a DONE/FAIL frame arrived");
		if (waiter) {
			const reject = waiter.reject;
			waiter = null;
			reject(endError);
		}
	}

	stream.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		drain();
	});
	stream.on("close", () => endWith());
	stream.on("error", (error) => endWith(error));

	return {
		async next() {
			while (pending.length === 0) {
				if (endError) throw endError;
				await new Promise((resolve, reject) => {
					waiter = { resolve, reject };
				});
			}
			return pending.shift();
		}
	};
}

/**
 * Sends QUIT to end the sync session and closes the underlying stream,
 * swallowing write errors so cleanup never masks the real failure.
 * @param {Object} stream - The sync stream to quit and close.
 * @returns {Promise<void>}
 */
async function quitSyncStream(stream) {
	try {
		await stream.write(buildSyncFrame(SYNC_ID_QUIT, Buffer.alloc(0)));
	} catch {
		// Best-effort - the stream may already be closed or erroring.
	}
	stream.close();
}

/**
 * Pushes a file to the device via the ADB SYNC sub-protocol's SEND command.
 * EXPERIMENTAL - implemented from spec, not yet validated against a real
 * device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} localPath - Local file path
 * @param {string} remotePath - Remote file path on device
 * @param {Object} [options={}] - Transfer options
 * @param {Function} [options.onProgress] - Progress callback, called with {bytesTransferred, totalBytes}
 * @param {number} [options.mode=0o644] - File permissions
 * @returns {Promise<void>}
 */
export async function push(___socket, streamManager, localPath, remotePath, options = {}) {
	const { onProgress, mode = 0o644 } = options;
	const data = await readFile(localPath);

	const stream = await streamManager.openStream("sync:");
	const reader = createSyncFrameReader(stream);
	try {
		const pathAndMode = Buffer.from(`${remotePath},${mode.toString(10)}`, "utf8");
		await stream.write(buildSyncFrame(SYNC_ID_SEND, pathAndMode));

		let offset = 0;
		while (offset < data.length) {
			const chunk = data.subarray(offset, Math.min(offset + SYNC_DATA_MAX, data.length));
			await stream.write(buildSyncFrame(SYNC_ID_DATA, chunk));
			offset += chunk.length;
			if (onProgress) onProgress({ bytesTransferred: offset, totalBytes: data.length });
		}

		await stream.write(buildSyncFrame(SYNC_ID_DONE, Math.floor(Date.now() / 1000)));

		const frame = await reader.next();
		if (frame.id === SYNC_ID_FAIL) {
			throw new Error(`SYNC push failed: ${frame.payload.toString("utf8")}`);
		}
		if (frame.id !== SYNC_ID_OKAY) {
			throw new Error(`Unexpected SYNC frame during push: ${frame.id}`);
		}
	} finally {
		await quitSyncStream(stream);
	}
}

/**
 * Pulls a file from the device via the ADB SYNC sub-protocol's RECV command.
 * EXPERIMENTAL - implemented from spec, not yet validated against a real
 * device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote file path on device
 * @param {string} localPath - Local file path
 * @param {Object} [options={}] - Transfer options
 * @param {Function} [options.onProgress] - Progress callback, called with {bytesTransferred}
 * @returns {Promise<void>}
 */
export async function pull(___socket, streamManager, remotePath, localPath, options = {}) {
	const { onProgress } = options;
	const stream = await streamManager.openStream("sync:");
	const reader = createSyncFrameReader(stream);
	try {
		await stream.write(buildSyncFrame(SYNC_ID_RECV, Buffer.from(remotePath, "utf8")));

		const chunks = [];
		let totalBytes = 0;
		for (;;) {
			const frame = await reader.next();
			if (frame.id === SYNC_ID_DATA) {
				chunks.push(frame.payload);
				totalBytes += frame.payload.length;
				if (onProgress) onProgress({ bytesTransferred: totalBytes });
			} else if (frame.id === SYNC_ID_DONE) {
				break;
			} else if (frame.id === SYNC_ID_FAIL) {
				throw new Error(`SYNC pull failed: ${frame.payload.toString("utf8")}`);
			} else {
				throw new Error(`Unexpected SYNC frame during pull: ${frame.id}`);
			}
		}

		await writeFile(localPath, Buffer.concat(chunks));
	} finally {
		await quitSyncStream(stream);
	}
}

/**
 * Runs the LIST exchange over an already-opened sync stream. Shared by
 * listSync() (which opens its own stream) and list() (which opens the stream
 * itself so it can distinguish "the sync service isn't usable" from "the
 * LIST command ran and failed" - see list() below).
 * @param {Object} stream - An ADB stream already opened to "sync:".
 * @param {string} remotePath - Remote directory path
 * @returns {Promise<Array<{name: string, size: number, mtime: number, mode: number, isDirectory: boolean, isFile: boolean, isSymlink: boolean}>>} Directory entries
 */
async function listOverStream(stream, remotePath) {
	const reader = createListFrameReader(stream);
	try {
		await stream.write(buildSyncFrame(SYNC_ID_LIST, Buffer.from(remotePath, "utf8")));

		const entries = [];
		for (;;) {
			const frame = await reader.next();
			if (frame.id === SYNC_ID_DENT) {
				entries.push({
					name: frame.name,
					size: frame.size,
					mtime: frame.mtime,
					mode: frame.mode,
					isDirectory: (frame.mode & S_IFMT) === S_IFDIR,
					isFile: (frame.mode & S_IFMT) === S_IFREG,
					isSymlink: (frame.mode & S_IFMT) === S_IFLNK
				});
			} else if (frame.id === SYNC_ID_DONE) {
				break;
			} else if (frame.id === SYNC_ID_FAIL) {
				throw new Error(`SYNC list failed: ${frame.payload.toString("utf8")}`);
			} else {
				throw new Error(`Unexpected SYNC frame during list: ${frame.id}`);
			}
		}
		return entries;
	} finally {
		await quitSyncStream(stream);
	}
}

/**
 * Lists directory contents via the ADB SYNC sub-protocol's binary-safe LIST
 * command. EXPERIMENTAL - implemented from spec, not yet validated against a
 * real device. See #2. Unlike `ls -la` text parsing, this can't be confused
 * by filenames containing shell-metacharacters, unusual whitespace, or
 * newlines.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @returns {Promise<Array<{name: string, size: number, mtime: number, mode: number, isDirectory: boolean, isFile: boolean, isSymlink: boolean}>>} Directory entries
 */
export async function listSync(___socket, streamManager, remotePath) {
	const stream = await streamManager.openStream("sync:");
	return await listOverStream(stream, remotePath);
}

/**
 * Lists directory contents on device via `ls -la`, parsed into structured entries.
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @returns {Promise<Array>} Array of directory entries (see utils.parseListing)
 */
export async function listShell(socket, streamManager, remotePath) {
	const output = await self.shell.execute(socket, streamManager, `ls -la ${quoteShellArg(remotePath)}`);
	return parseListing(output);
}

/**
 * Lists directory contents, preferring the binary-safe SYNC LIST command and
 * falling back to shell-based `ls -la` parsing for devices or connection
 * states where the SYNC service isn't usable. Both paths return entries with
 * at least `name`/`isDirectory`/`isFile`/`isSymlink`; the SYNC path also
 * includes `mode`/`mtime`, while the shell path also includes
 * `permissions`/`links`/`owner`/`group`/`dateTime` (see utils.parseListing).
 *
 * The fallback is narrow on purpose: it only triggers when the sync stream
 * itself can't be opened. A real LIST failure (a FAIL frame, e.g. "No such
 * file or directory", or a protocol error) is a genuine result and is
 * rethrown rather than silently masked by a different-shaped shell result.
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @returns {Promise<Array>} Directory entries
 */
export async function list(socket, streamManager, remotePath) {
	let stream;
	try {
		stream = await streamManager.openStream("sync:");
	} catch {
		return await listShell(socket, streamManager, remotePath);
	}
	return await listOverStream(stream, remotePath);
}

/**
 * Gets file/directory stats on device via the shell `stat` command.
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path
 * @returns {Promise<string>} Raw `stat` command output
 */
export async function stat(socket, streamManager, remotePath) {
	return await self.shell.execute(socket, streamManager, `stat ${quoteShellArg(remotePath)}`);
}

/**
 * Creates a directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @param {number} [mode=0o755] - Directory permissions
 * @returns {Promise<void>}
 */
export async function mkdir(socket, streamManager, remotePath, mode = 0o755) {
	// Use shell command to create directory
	const command = `mkdir -p ${quoteShellArg(remotePath)} && chmod ${mode.toString(8)} ${quoteShellArg(remotePath)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Removes a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path to remove
 * @param {boolean} [recursive=false] - Remove recursively
 * @returns {Promise<void>}
 */
export async function remove(socket, streamManager, remotePath, recursive = false) {
	const flag = recursive ? "-rf" : "-f";
	const command = `rm ${flag} ${quoteShellArg(remotePath)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Moves/renames a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @returns {Promise<void>}
 */
export async function move(socket, streamManager, sourcePath, destPath) {
	const command = `mv ${quoteShellArg(sourcePath)} ${quoteShellArg(destPath)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Copies a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @param {boolean} [recursive=false] - Copy recursively
 * @returns {Promise<void>}
 */
export async function copy(socket, streamManager, sourcePath, destPath, recursive = false) {
	const flag = recursive ? "-r" : "";
	const command = `cp ${flag} ${quoteShellArg(sourcePath)} ${quoteShellArg(destPath)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Changes file permissions on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path
 * @param {number} mode - Permission mode (e.g., 0o644)
 * @param {boolean} [recursive=false] - Apply recursively
 * @returns {Promise<void>}
 */
export async function chmod(socket, streamManager, remotePath, mode, recursive = false) {
	const flag = recursive ? "-R" : "";
	const command = `chmod ${flag} ${mode.toString(8)} ${quoteShellArg(remotePath)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Gets disk usage information
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} [path='/'] - Path to check
 * @returns {Promise<string>} Disk usage output
 */
export async function diskUsage(socket, streamManager, path = "/") {
	const command = `df -h ${quoteShellArg(path)}`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Finds files matching a pattern
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} path - Starting path
 * @param {string} pattern - File pattern (e.g., '*.txt')
 * @param {Object} [options={}] - Find options
 * @param {number} [options.maxDepth] - Maximum search depth
 * @param {string} [options.type] - File type (f=file, d=directory)
 * @returns {Promise<string>} Find results
 */
export async function find(socket, streamManager, path, pattern, options = {}) {
	let command = `find ${quoteShellArg(path)}`;

	if (options.maxDepth) {
		command += ` -maxdepth ${options.maxDepth}`;
	}

	if (options.type) {
		command += ` -type ${options.type}`;
	}

	command += ` -name ${quoteShellArg(pattern)}`;

	return await self.shell.execute(socket, streamManager, command);
}
