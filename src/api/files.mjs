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
import { readFile, writeFile, open } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

/**
 * Validates a POSIX file mode before it's interpolated (via `.toString(8)`)
 * into a chmod/mkdir shell command. `mode.toString(8)` only performs the
 * octal conversion for an actual number - passed a string, `String.prototype
 * .toString()` ignores the radix argument entirely and returns the string
 * as-is, which would let unvalidated input reach the shell unescaped. Rather
 * than coerce, this rejects anything that isn't already a plain integer in
 * the valid permission-bits range (rwx for user/group/other plus
 * setuid/setgid/sticky).
 * @param {*} mode - Value to validate.
 * @returns {number} The validated mode, unchanged.
 */
function assertValidMode(mode) {
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
		throw new Error(`Invalid mode: ${mode} (must be an integer between 0 and 0o7777)`);
	}
	return mode;
}

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

// SYNC V2 (64-bit) variants - see #8. Confirmed against AOSP's own
// file_sync_protocol.h: only the per-transfer SETUP/REQUEST frames get new
// V2-specific ids (below); the DATA/DONE/OKAY/FAIL/QUIT tail of a transfer is
// byte-for-byte identical to the V1 shapes above and is reused unchanged.
//
// SEND_V2/RECV_V2 requests are two frames: a generic id+pathlen+path frame
// (built with buildSyncFrame, same as V1), then a *raw* fixed-size struct
// carrying `id` again plus mode/flags (send_v2) or just flags (recv_v2) - not
// wrapped in the generic id+value+payload shape, so those are built by hand
// (see pushV2/pullV2). `flags` is the per-transfer compression selector;
// droidsock supports brotli (options.compression: "brotli", opt-in and off
// by default) via Node's built-in zlib - lz4/zstd aren't implemented (they'd
// need new dependencies) - see #8.
//
// STAT_V2/LIST_V2 requests are a single generic id+pathlen+path frame, same
// shape as V1. STAT_V2's reply is a single raw fixed-size sync_stat_v2
// struct (not the generic shape either). LIST_V2's DENT_V2 entries are a raw
// fixed-size header + name bytes (like V1's DENT, just with 64-bit fields),
// terminated by a generic DONE frame exactly like V1's LIST.
const SYNC_ID_SEND_V2 = "SND2";
const SYNC_ID_RECV_V2 = "RCV2";
const SYNC_ID_STAT_V2 = "STA2";
const SYNC_ID_LIST_V2 = "LIS2";
const SYNC_ID_DENT_V2 = "DNT2";
// AOSP SyncFlag enum (transport.cpp) - only kSyncFlagNone/kSyncFlagBrotli are
// used here; lz4/zstd need new dependencies and are tracked separately (#8
// follow-up) rather than implemented speculatively.
const SYNC_FLAG_NONE = 0;
const SYNC_FLAG_BROTLI = 1;
// Brotli (like any general-purpose compressor) can slightly expand
// incompressible input - the format's own worst-case overhead is a small,
// bounded per-block amount, not a multiplicative blowup, but chunking
// compressed input at the full SYNC_DATA_MAX would leave no margin at all
// and risks a DATA frame that violates the protocol's 64KB ceiling. Raw
// input for a compressed chunk is capped well below SYNC_DATA_MAX instead,
// with an explicit check on the compressed output as a backstop.
const SYNC_BROTLI_INPUT_MAX = 48 * 1024;
const SYNC_SEND_V2_SETUP_SIZE = 12; // id(4) + mode(4) + flags(4)
const SYNC_RECV_V2_SETUP_SIZE = 8; // id(4) + flags(4)
// id(4) + error(4) + dev(8) + ino(8) + mode(4) + nlink(4) + uid(4) + gid(4) + size(8) + atime(8) + mtime(8) + ctime(8)
const SYNC_STAT_V2_SIZE = 72;
// Same fields as stat_v2 minus `id` (already consumed to identify the frame as DNT2) plus a trailing namelen(4).
const SYNC_DENT_V2_TAIL_SIZE = 72;
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
 * Wraps an opened sync stream with a raw byte-accumulating reader, for the V2
 * SYNC replies (sync_stat_v2 / sync_dent_v2) that are fixed-size structs sent
 * directly on the wire rather than the generic id+value+payload frame shape
 * the V1 readers above expect. Same close/error-before-enough-bytes handling
 * as createListFrameReader, so a truncated reply rejects instead of hanging.
 * @param {Object} stream - An ADB stream already opened to "sync:".
 * @returns {{ readBytes: (size: number) => Promise<Buffer> }} Raw byte reader.
 */
function createRawByteReader(stream) {
	let buffer = Buffer.alloc(0);
	const waiters = [];
	let endError = null;

	function drain() {
		while (waiters.length > 0 && buffer.length >= waiters[0].size) {
			const { size, resolve } = waiters.shift();
			resolve(Buffer.from(buffer.subarray(0, size)));
			buffer = buffer.subarray(size);
		}
	}

	function endWith(error) {
		if (endError) return;
		endError = error || new Error("Sync stream ended before enough bytes arrived");
		while (waiters.length > 0) {
			waiters.shift().reject(endError);
		}
	}

	stream.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		drain();
	});
	stream.on("close", () => endWith());
	stream.on("error", (error) => endWith(error));

	return {
		readBytes(size) {
			if (endError && buffer.length < size) return Promise.reject(endError);
			return new Promise((resolve, reject) => {
				waiters.push({ size, resolve, reject });
				drain();
			});
		}
	};
}

/**
 * Parses a raw sync_stat_v2 struct (see SYNC_STAT_V2_SIZE), including the
 * leading 4-byte id.
 * @param {Buffer} buf - Exactly SYNC_STAT_V2_SIZE bytes.
 * @returns {{id: string, error: number, dev: bigint, ino: bigint, mode: number, nlink: number, uid: number, gid: number, size: bigint, atime: bigint, mtime: bigint, ctime: bigint}} Parsed record.
 */
function parseStatV2Record(buf) {
	return {
		id: buf.toString("ascii", 0, 4),
		error: buf.readUInt32LE(4),
		dev: buf.readBigUInt64LE(8),
		ino: buf.readBigUInt64LE(16),
		mode: buf.readUInt32LE(24),
		nlink: buf.readUInt32LE(28),
		uid: buf.readUInt32LE(32),
		gid: buf.readUInt32LE(36),
		size: buf.readBigUInt64LE(40),
		atime: buf.readBigInt64LE(48),
		mtime: buf.readBigInt64LE(56),
		ctime: buf.readBigInt64LE(64)
	};
}

/**
 * Parses the fixed-size tail of a sync_dent_v2 struct (everything after the
 * already-consumed leading id) - see SYNC_DENT_V2_TAIL_SIZE. The variable-
 * length name that follows (namelen bytes) is read separately by the caller.
 * @param {Buffer} buf - Exactly SYNC_DENT_V2_TAIL_SIZE bytes.
 * @returns {{error: number, dev: bigint, ino: bigint, mode: number, nlink: number, uid: number, gid: number, size: bigint, atime: bigint, mtime: bigint, ctime: bigint, namelen: number}} Parsed record (minus id/name).
 */
function parseDentV2Tail(buf) {
	return {
		error: buf.readUInt32LE(0),
		dev: buf.readBigUInt64LE(4),
		ino: buf.readBigUInt64LE(12),
		mode: buf.readUInt32LE(20),
		nlink: buf.readUInt32LE(24),
		uid: buf.readUInt32LE(28),
		gid: buf.readUInt32LE(32),
		size: buf.readBigUInt64LE(36),
		atime: buf.readBigInt64LE(44),
		mtime: buf.readBigInt64LE(52),
		ctime: buf.readBigInt64LE(60),
		namelen: buf.readUInt32LE(68)
	};
}

/**
 * Wraps an opened sync stream with a reader for LIST_V2 responses: repeated
 * raw sync_dent_v2 records (fixed tail + variable-length name), terminated by
 * a generic DONE frame (or FAIL) in the same shape V1's LIST uses. Same
 * stream-ended-before-DONE/FAIL rejection behavior as createListFrameReader.
 * @param {Object} stream - An ADB stream already opened to "sync:".
 * @returns {{ next: () => Promise<Object> }} Frame reader.
 */
function createListV2FrameReader(stream) {
	const raw = createRawByteReader(stream);
	return {
		async next() {
			const idBuf = await raw.readBytes(4);
			const id = idBuf.toString("ascii");

			if (id === SYNC_ID_DENT_V2) {
				const tail = parseDentV2Tail(await raw.readBytes(SYNC_DENT_V2_TAIL_SIZE));
				const name = (await raw.readBytes(tail.namelen)).toString("utf8");
				return { id, ...tail, name };
			}
			if (id === SYNC_ID_DONE) {
				await raw.readBytes(4); // trailing value field, unused
				return { id };
			}
			if (id === SYNC_ID_FAIL) {
				const value = (await raw.readBytes(4)).readUInt32LE(0);
				const payload = await raw.readBytes(value);
				return { id, payload };
			}
			throw new Error(`Unexpected SYNC frame during list_v2: ${id}`);
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
 * Pushes a file to the device via the ADB SYNC sub-protocol's 64-bit
 * SEND_V2 command - see #8. Only usable against a device that advertised the
 * "stat_v2"/"sendrecv_v2" CNXN feature (droidsock declares "sendrecv_v2" in
 * its own outgoing banner, see connection.mjs). EXPERIMENTAL - implemented
 * from spec (AOSP file_sync_protocol.h), not yet validated against a real
 * device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} localPath - Local file path
 * @param {string} remotePath - Remote file path on device
 * @param {Object} [options={}] - Transfer options
 * @param {Function} [options.onProgress] - Progress callback, called with {bytesTransferred, totalBytes} (counts uncompressed bytes read from the local file, regardless of `compression`)
 * @param {number} [options.mode=0o644] - File permissions
 * @param {"none"|"brotli"} [options.compression="none"] - Per-chunk compression, only if the device advertised the matching CNXN feature (`sendrecv_v2_brotli`) - droidsock declares support but doesn't enable it unless asked, since it hasn't been validated against a real device. `lz4`/`zstd` aren't implemented - see #8.
 * @returns {Promise<void>}
 */
export async function pushV2(___socket, streamManager, localPath, remotePath, options = {}) {
	const { onProgress, mode = 0o644, compression = "none" } = options;
	assertValidMode(mode);
	if (compression !== "none" && compression !== "brotli") {
		throw new Error(`Invalid compression: ${compression} (must be "none" or "brotli")`);
	}
	const flag = compression === "brotli" ? SYNC_FLAG_BROTLI : SYNC_FLAG_NONE;

	// Read from an open file handle in inputChunkMax-sized pieces, mirroring
	// install.streaming() - the whole point of the 64-bit V2 path is
	// supporting files well beyond what fits comfortably in memory, so
	// buffering the entire file up front (as the 32-bit V1 push() above does)
	// would defeat it for the large-file transfers V2 exists for.
	const fileHandle = await open(localPath, "r");
	try {
		const { size: totalBytes } = await fileHandle.stat();

		const stream = await streamManager.openStream("sync:");
		const reader = createSyncFrameReader(stream);
		try {
			await stream.write(buildSyncFrame(SYNC_ID_SEND_V2, Buffer.from(remotePath, "utf8")));

			const setup = Buffer.alloc(SYNC_SEND_V2_SETUP_SIZE);
			setup.write(SYNC_ID_SEND_V2, 0, 4, "ascii");
			setup.writeUInt32LE(mode >>> 0, 4);
			setup.writeUInt32LE(flag, 8);
			await stream.write(setup);

			const inputChunkMax = flag === SYNC_FLAG_BROTLI ? SYNC_BROTLI_INPUT_MAX : SYNC_DATA_MAX;
			let bytesTransferred = 0;
			for (;;) {
				// A fresh buffer per read, never reused - see install.streaming()'s
				// identical rationale (stream.write() may queue rather than copy
				// the buffer immediately).
				const buffer = Buffer.alloc(inputChunkMax);
				const { bytesRead } = await fileHandle.read(buffer, 0, inputChunkMax, null);
				if (bytesRead === 0) break;
				const chunk = bytesRead === inputChunkMax ? buffer : buffer.subarray(0, bytesRead);
				const wireChunk = flag === SYNC_FLAG_BROTLI ? brotliCompressSync(chunk) : chunk;
				if (wireChunk.length > SYNC_DATA_MAX) {
					throw new Error(`Compressed SYNC DATA chunk exceeds the protocol ceiling: ${wireChunk.length} bytes (max ${SYNC_DATA_MAX})`);
				}
				await stream.write(buildSyncFrame(SYNC_ID_DATA, wireChunk));
				bytesTransferred += bytesRead;
				if (onProgress) onProgress({ bytesTransferred, totalBytes });
			}

			await stream.write(buildSyncFrame(SYNC_ID_DONE, Math.floor(Date.now() / 1000)));

			const frame = await reader.next();
			if (frame.id === SYNC_ID_FAIL) {
				throw new Error(`SYNC send_v2 failed: ${frame.payload.toString("utf8")}`);
			}
			if (frame.id !== SYNC_ID_OKAY) {
				throw new Error(`Unexpected SYNC frame during send_v2: ${frame.id}`);
			}
		} finally {
			await quitSyncStream(stream);
		}
	} finally {
		await fileHandle.close();
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
 * Pulls a file from the device via the ADB SYNC sub-protocol's 64-bit
 * RECV_V2 command - see #8. Only usable against a device that advertised the
 * "sendrecv_v2" CNXN feature. EXPERIMENTAL - implemented from spec, not yet
 * validated against a real device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote file path on device
 * @param {string} localPath - Local file path
 * @param {Object} [options={}] - Transfer options
 * @param {Function} [options.onProgress] - Progress callback, called with {bytesTransferred} (counts bytes as received on the wire, i.e. compressed size when `compression` is set)
 * @param {"none"|"brotli"} [options.compression="none"] - Requests per-chunk compression from the device, only if it advertised the matching CNXN feature (`sendrecv_v2_brotli`) - droidsock declares support but doesn't request it unless asked, since it hasn't been validated against a real device. `lz4`/`zstd` aren't implemented - see #8.
 * @returns {Promise<void>}
 */
export async function pullV2(___socket, streamManager, remotePath, localPath, options = {}) {
	const { onProgress, compression = "none" } = options;
	if (compression !== "none" && compression !== "brotli") {
		throw new Error(`Invalid compression: ${compression} (must be "none" or "brotli")`);
	}
	const flag = compression === "brotli" ? SYNC_FLAG_BROTLI : SYNC_FLAG_NONE;
	const stream = await streamManager.openStream("sync:");
	const reader = createSyncFrameReader(stream);
	try {
		await stream.write(buildSyncFrame(SYNC_ID_RECV_V2, Buffer.from(remotePath, "utf8")));

		const setup = Buffer.alloc(SYNC_RECV_V2_SETUP_SIZE);
		setup.write(SYNC_ID_RECV_V2, 0, 4, "ascii");
		setup.writeUInt32LE(flag, 4);
		await stream.write(setup);

		// Write each decompressed chunk straight to disk as it arrives instead
		// of accumulating an array + Buffer.concat() at the end - for the
		// large-file transfers that motivate the 64-bit V2 path, buffering the
		// whole file in JS memory is exactly what V2 exists to avoid.
		const fileHandle = await open(localPath, "w");
		try {
			let totalBytes = 0;
			for (;;) {
				const frame = await reader.next();
				if (frame.id === SYNC_ID_DATA) {
					const chunk = flag === SYNC_FLAG_BROTLI ? brotliDecompressSync(frame.payload) : frame.payload;
					await fileHandle.write(chunk);
					totalBytes += frame.payload.length;
					if (onProgress) onProgress({ bytesTransferred: totalBytes });
				} else if (frame.id === SYNC_ID_DONE) {
					break;
				} else if (frame.id === SYNC_ID_FAIL) {
					throw new Error(`SYNC recv_v2 failed: ${frame.payload.toString("utf8")}`);
				} else {
					throw new Error(`Unexpected SYNC frame during recv_v2: ${frame.id}`);
				}
			}
		} finally {
			await fileHandle.close();
		}
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
 * Lists directory contents via the ADB SYNC sub-protocol's 64-bit LIST_V2
 * command - see #8. Entries carry the same fields as listSync()'s plus the
 * additional 64-bit-struct fields (atime/ctime/uid/gid/nlink/dev/ino);
 * size/atime/mtime/ctime/dev/ino are returned as BigInt since the whole
 * point of V2 is representing values beyond Number.MAX_SAFE_INTEGER. Only
 * usable against a device that advertised the "ls_v2" CNXN feature.
 * EXPERIMENTAL - implemented from spec, not yet validated against a real
 * device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @returns {Promise<Array<Object>>} Directory entries
 */
export async function listV2(___socket, streamManager, remotePath) {
	const stream = await streamManager.openStream("sync:");
	const reader = createListV2FrameReader(stream);
	try {
		await stream.write(buildSyncFrame(SYNC_ID_LIST_V2, Buffer.from(remotePath, "utf8")));

		const entries = [];
		for (;;) {
			const frame = await reader.next();
			if (frame.id === SYNC_ID_DENT_V2) {
				entries.push({
					name: frame.name,
					mode: frame.mode,
					size: frame.size,
					atime: frame.atime,
					mtime: frame.mtime,
					ctime: frame.ctime,
					uid: frame.uid,
					gid: frame.gid,
					nlink: frame.nlink,
					dev: frame.dev,
					ino: frame.ino,
					isDirectory: (frame.mode & S_IFMT) === S_IFDIR,
					isFile: (frame.mode & S_IFMT) === S_IFREG,
					isSymlink: (frame.mode & S_IFMT) === S_IFLNK
				});
			} else if (frame.id === SYNC_ID_DONE) {
				break;
			} else if (frame.id === SYNC_ID_FAIL) {
				throw new Error(`SYNC list_v2 failed: ${frame.payload.toString("utf8")}`);
			}
		}
		return entries;
	} finally {
		await quitSyncStream(stream);
	}
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
 * Gets file/directory stats via the ADB SYNC sub-protocol's 64-bit STAT_V2
 * command - see #8. Unlike stat() (shell `stat` text parsing), this is
 * binary-safe and returns structured fields directly off the wire;
 * size/atime/mtime/ctime/dev/ino are BigInt for the same reason as
 * listV2(). Only usable against a device that advertised the "stat_v2" CNXN
 * feature. Throws if the device reports a non-zero `error` (e.g. ENOENT) in
 * the reply struct - STAT_V2 has no separate FAIL frame, the error is a
 * field on the reply itself. EXPERIMENTAL - implemented from spec, not yet
 * validated against a real device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the sync stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path
 * @returns {Promise<Object>} Structured stat result
 */
export async function statV2(___socket, streamManager, remotePath) {
	const stream = await streamManager.openStream("sync:");
	const raw = createRawByteReader(stream);
	try {
		await stream.write(buildSyncFrame(SYNC_ID_STAT_V2, Buffer.from(remotePath, "utf8")));

		const record = parseStatV2Record(await raw.readBytes(SYNC_STAT_V2_SIZE));
		if (record.error !== 0) {
			throw new Error(`SYNC stat_v2 failed for ${remotePath}: errno ${record.error}`);
		}
		return {
			mode: record.mode,
			size: record.size,
			atime: record.atime,
			mtime: record.mtime,
			ctime: record.ctime,
			uid: record.uid,
			gid: record.gid,
			nlink: record.nlink,
			dev: record.dev,
			ino: record.ino,
			isDirectory: (record.mode & S_IFMT) === S_IFDIR,
			isFile: (record.mode & S_IFMT) === S_IFREG,
			isSymlink: (record.mode & S_IFMT) === S_IFLNK
		};
	} finally {
		await quitSyncStream(stream);
	}
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
	assertValidMode(mode);
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
	assertValidMode(mode);
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
 * @param {number} [options.maxDepth] - Maximum search depth (non-negative integer; 0 is valid and means the starting point only)
 * @param {string} [options.type] - File type: one of b, c, d, p, f, l, s (see find(1))
 * @returns {Promise<string>} Find results
 */
export async function find(socket, streamManager, path, pattern, options = {}) {
	let command = `find ${quoteShellArg(path)}`;

	if (options.maxDepth !== undefined) {
		if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
			throw new Error(`Invalid maxDepth: ${options.maxDepth} (must be a non-negative integer)`);
		}
		command += ` -maxdepth ${options.maxDepth}`;
	}

	if (options.type !== undefined) {
		if (!/^[bcdpfls]$/.test(options.type)) {
			throw new Error(`Invalid type: ${options.type} (must be one of b, c, d, p, f, l, s)`);
		}
		command += ` -type ${options.type}`;
	}

	command += ` -name ${quoteShellArg(pattern)}`;

	return await self.shell.execute(socket, streamManager, command);
}
