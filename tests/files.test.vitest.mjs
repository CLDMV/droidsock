/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/files.test.vitest.mjs
 *	@Date: 2026-08-30 21:13:01 -07:00 (1788149581)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 21:22:26 -07:00 (1788150146)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import createDroidSock from "../index.mjs";

// files.mjs's implemented operations are thin shell-command builders - they call
// self.shell.execute(socket, streamManager, command) and nothing else. Spying on
// shell.execute lets these be tested for real (the exact command string built)
// without a device or any protocol-level mocking.
let droidsock;
let tmpDir;
const fakeSocket = {};
const fakeStreamManager = {};

/**
 * Builds a raw SYNC frame (id + 4-byte LE value, optionally followed by
 * payload bytes) matching files.mjs's own buildSyncFrame, for driving the
 * fake sync stream in push/pull tests.
 * @param {string} id - Four-character SYNC frame id.
 * @param {number|Buffer} valueOrPayload - Payload buffer, or a raw header value for a payload-less frame.
 * @returns {Buffer} The framed packet.
 */
function buildFrame(id, valueOrPayload) {
	const payload = Buffer.isBuffer(valueOrPayload) ? valueOrPayload : Buffer.alloc(0);
	const value = Buffer.isBuffer(valueOrPayload) ? valueOrPayload.length : valueOrPayload;
	const header = Buffer.alloc(8);
	header.write(id, 0, 4, "ascii");
	header.writeUInt32LE(value >>> 0, 4);
	return Buffer.concat([header, payload]);
}

/**
 * Builds a raw DENT frame (id + mode + size + mtime + namelen, all 4-byte LE,
 * followed by the name bytes) matching files.mjs's own createListFrameReader,
 * for driving the fake sync stream in list() tests. DENT doesn't follow the
 * generic id+value+payload shape buildFrame() produces.
 * @param {number} mode - POSIX file mode (including file-type bits).
 * @param {number} size - File size in bytes.
 * @param {number} mtime - Modification time (seconds since epoch).
 * @param {string} name - Entry name.
 * @returns {Buffer} The framed packet.
 */
function buildDentFrame(mode, size, mtime, name) {
	const nameBuf = Buffer.from(name, "utf8");
	const header = Buffer.alloc(20);
	header.write("DENT", 0, 4, "ascii");
	header.writeUInt32LE(mode, 4);
	header.writeUInt32LE(size, 8);
	header.writeUInt32LE(mtime, 12);
	header.writeUInt32LE(nameBuf.length, 16);
	return Buffer.concat([header, nameBuf]);
}

/**
 * Builds a raw sync_stat_v2 struct (id + error + dev + ino + mode + nlink +
 * uid + gid + size + atime + mtime + ctime, 72 bytes total, no generic
 * id+value+payload envelope) matching files.mjs's own parseStatV2Record, for
 * driving the fake sync stream in statV2()/listV2() tests.
 * @param {Object} [fields={}] - Struct field overrides.
 * @param {string} [fields.id="STA2"] - Leading 4-byte record id (override to simulate a desynced/unexpected reply).
 * @param {number} [fields.error=0] - errno (0 = success).
 * @param {number} [fields.mode=0] - POSIX file mode (including file-type bits).
 * @param {bigint|number} [fields.size=0n] - File size.
 * @param {bigint|number} [fields.atime=0n] - Access time (seconds since epoch).
 * @param {bigint|number} [fields.mtime=0n] - Modification time (seconds since epoch).
 * @param {bigint|number} [fields.ctime=0n] - Status-change time (seconds since epoch).
 * @param {bigint|number} [fields.dev=0n] - Device id.
 * @param {bigint|number} [fields.ino=0n] - Inode number.
 * @param {number} [fields.nlink=1] - Hard-link count.
 * @param {number} [fields.uid=0] - Owner uid.
 * @param {number} [fields.gid=0] - Owner gid.
 * @returns {Buffer} The 72-byte raw struct.
 */
function buildStatV2Frame({
	id = "STA2",
	error = 0,
	mode = 0,
	size = 0n,
	atime = 0n,
	mtime = 0n,
	ctime = 0n,
	dev = 0n,
	ino = 0n,
	nlink = 1,
	uid = 0,
	gid = 0
} = {}) {
	const buf = Buffer.alloc(72);
	buf.write(id, 0, 4, "ascii");
	buf.writeUInt32LE(error, 4);
	buf.writeBigUInt64LE(BigInt(dev), 8);
	buf.writeBigUInt64LE(BigInt(ino), 16);
	buf.writeUInt32LE(mode, 24);
	buf.writeUInt32LE(nlink, 28);
	buf.writeUInt32LE(uid, 32);
	buf.writeUInt32LE(gid, 36);
	buf.writeBigUInt64LE(BigInt(size), 40);
	buf.writeBigInt64LE(BigInt(atime), 48);
	buf.writeBigInt64LE(BigInt(mtime), 56);
	buf.writeBigInt64LE(BigInt(ctime), 64);
	return buf;
}

/**
 * Builds a raw sync_dent_v2 struct (same layout as buildStatV2Frame() minus
 * the id, but with id "DNT2" and a trailing namelen + name) matching
 * files.mjs's own parseDentV2Tail, for driving the fake sync stream in
 * listV2() tests.
 * @param {Object} fields - Struct field overrides, same shape as buildStatV2Frame(), plus:
 * @param {string} fields.name - Entry name.
 * @returns {Buffer} The 76-byte struct header plus the name bytes.
 */
function buildDentV2Frame({
	error = 0,
	mode = 0,
	size = 0n,
	atime = 0n,
	mtime = 0n,
	ctime = 0n,
	dev = 0n,
	ino = 0n,
	nlink = 1,
	uid = 0,
	gid = 0,
	name,
	namelenOverride
}) {
	const nameBuf = Buffer.from(name, "utf8");
	const buf = Buffer.alloc(76);
	buf.write("DNT2", 0, 4, "ascii");
	buf.writeUInt32LE(error, 4);
	buf.writeBigUInt64LE(BigInt(dev), 8);
	buf.writeBigUInt64LE(BigInt(ino), 16);
	buf.writeUInt32LE(mode, 24);
	buf.writeUInt32LE(nlink, 28);
	buf.writeUInt32LE(uid, 32);
	buf.writeUInt32LE(gid, 36);
	buf.writeBigUInt64LE(BigInt(size), 40);
	buf.writeBigInt64LE(BigInt(atime), 48);
	buf.writeBigInt64LE(BigInt(mtime), 56);
	buf.writeBigInt64LE(BigInt(ctime), 64);
	// namelenOverride lets a test claim a namelen that doesn't match the actual
	// name bytes sent - simulating a malformed/hostile device for the
	// oversized-namelen rejection test, without needing to actually send
	// however many bytes the claimed length says.
	buf.writeUInt32LE(namelenOverride ?? nameBuf.length, 72);
	return Buffer.concat([buf, nameBuf]);
}

/**
 * Creates a fake "sync:" stream. `onWrite` is called synchronously with each
 * frame the code under test writes (and the stream itself, to emit "data"
 * responses) - this drives the fake device's responses deterministically off
 * the actual protocol exchange rather than guessed timing.
 * @param {(frame: Buffer, stream: EventEmitter) => void} [onWrite] - Called on every stream.write().
 * @returns {EventEmitter & {write: Function, close: Function, writes: Buffer[]}} The fake stream.
 */
function createFakeSyncStream(onWrite) {
	const stream = new EventEmitter();
	stream.writes = [];
	stream.write = async (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		stream.writes.push(buf);
		if (onWrite) onWrite(buf, stream);
	};
	stream.close = vi.fn();
	return stream;
}

beforeEach(async () => {
	droidsock = await createDroidSock();
	vi.spyOn(droidsock.shell, "execute").mockResolvedValue("");
	tmpDir = mkdtempSync(path.join(tmpdir(), "droidsock-files-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	rmSync(tmpDir, { recursive: true, force: true });
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("files.mkdir", () => {
	test("builds mkdir -p with the default 0o755 mode", async () => {
		await droidsock.files.mkdir(fakeSocket, fakeStreamManager, "/sdcard/newdir");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(
			fakeSocket,
			fakeStreamManager,
			"mkdir -p '/sdcard/newdir' && chmod 755 '/sdcard/newdir'"
		);
	});

	test("honors a custom mode", async () => {
		await droidsock.files.mkdir(fakeSocket, fakeStreamManager, "/sdcard/newdir", 0o700);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(
			fakeSocket,
			fakeStreamManager,
			"mkdir -p '/sdcard/newdir' && chmod 700 '/sdcard/newdir'"
		);
	});

	test("single-quote-escapes a path containing a single quote and shell metacharacters", async () => {
		const maliciousPath = "/sdcard/it's a test`$(rm -rf /)`";
		await droidsock.files.mkdir(fakeSocket, fakeStreamManager, maliciousPath);
		const [, , command] = droidsock.shell.execute.mock.calls[0];
		// The embedded ' closes-escapes-reopens; everything else (`, $, (, )) is
		// inert inside single quotes, so no metacharacter reaches the shell unescaped.
		expect(command).toBe("mkdir -p '/sdcard/it'\\''s a test`$(rm -rf /)`' && chmod 755 '/sdcard/it'\\''s a test`$(rm -rf /)`'");
	});

	test.each([["07777"], [0o10000], [-1], [420.5], [null]])("rejects an invalid mode (%p) without building a command", async (mode) => {
		await expect(droidsock.files.mkdir(fakeSocket, fakeStreamManager, "/sdcard/newdir", mode)).rejects.toThrow("Invalid mode");
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
	});
});

describe("files.remove", () => {
	test("builds a non-recursive rm by default", async () => {
		await droidsock.files.remove(fakeSocket, fakeStreamManager, "/sdcard/file.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "rm -f '/sdcard/file.txt'");
	});

	test("builds a recursive rm when requested", async () => {
		await droidsock.files.remove(fakeSocket, fakeStreamManager, "/sdcard/dir", true);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "rm -rf '/sdcard/dir'");
	});

	test("single-quote-escapes a path containing a single quote", async () => {
		await droidsock.files.remove(fakeSocket, fakeStreamManager, "/sdcard/it's a file");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "rm -f '/sdcard/it'\\''s a file'");
	});
});

describe("files.move", () => {
	test("builds mv with source and destination", async () => {
		await droidsock.files.move(fakeSocket, fakeStreamManager, "/sdcard/a.txt", "/sdcard/b.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "mv '/sdcard/a.txt' '/sdcard/b.txt'");
	});

	test("single-quote-escapes source and destination independently", async () => {
		await droidsock.files.move(fakeSocket, fakeStreamManager, "/sdcard/a's.txt", "/sdcard/$(whoami).txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "mv '/sdcard/a'\\''s.txt' '/sdcard/$(whoami).txt'");
	});
});

describe("files.copy", () => {
	test("builds cp without -r by default", async () => {
		await droidsock.files.copy(fakeSocket, fakeStreamManager, "/sdcard/a.txt", "/sdcard/b.txt");
		const [, , command] = droidsock.shell.execute.mock.calls[0];
		expect(command).toContain("cp");
		expect(command).not.toContain("-r");
		expect(command).toContain("'/sdcard/a.txt' '/sdcard/b.txt'");
	});

	test("builds cp -r when recursive", async () => {
		await droidsock.files.copy(fakeSocket, fakeStreamManager, "/sdcard/dir", "/sdcard/dir2", true);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "cp -r '/sdcard/dir' '/sdcard/dir2'");
	});
});

describe("files.chmod", () => {
	test("builds chmod without -R by default", async () => {
		await droidsock.files.chmod(fakeSocket, fakeStreamManager, "/sdcard/file.txt", 0o644);
		const [, , command] = droidsock.shell.execute.mock.calls[0];
		expect(command).toContain("644");
		expect(command).not.toContain("-R");
	});

	test("builds chmod -R when recursive", async () => {
		await droidsock.files.chmod(fakeSocket, fakeStreamManager, "/sdcard/dir", 0o755, true);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "chmod -R 755 '/sdcard/dir'");
	});

	test.each([["644"], [0o10000], [-1], [420.5]])("rejects an invalid mode (%p) without building a command", async (mode) => {
		await expect(droidsock.files.chmod(fakeSocket, fakeStreamManager, "/sdcard/dir", mode)).rejects.toThrow("Invalid mode");
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
	});
});

describe("files.diskUsage", () => {
	test("defaults to checking /", async () => {
		await droidsock.files.diskUsage(fakeSocket, fakeStreamManager);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "df -h '/'");
	});

	test("checks a specific path", async () => {
		await droidsock.files.diskUsage(fakeSocket, fakeStreamManager, "/sdcard");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "df -h '/sdcard'");
	});
});

describe("files.find", () => {
	test("builds a basic find by name", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "find '/sdcard' -name '*.txt'");
	});

	test("adds -maxdepth when given", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth: 2 });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "find '/sdcard' -maxdepth 2 -name '*.txt'");
	});

	test("honors maxDepth: 0 (a falsy-but-valid value)", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth: 0 });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "find '/sdcard' -maxdepth 0 -name '*.txt'");
	});

	test.each([[-1], [1.5], ["2"]])("rejects an invalid maxDepth (%p) without building a command", async (maxDepth) => {
		await expect(droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth })).rejects.toThrow("Invalid maxDepth");
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
	});

	test.each([["f; rm -rf /"], ["x"], [""]])("rejects an invalid type (%p) without building a command", async (type) => {
		await expect(droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { type })).rejects.toThrow("Invalid type");
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
	});

	test("adds -type when given", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { type: "f" });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "find '/sdcard' -type f -name '*.txt'");
	});

	test("combines -maxdepth and -type", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth: 3, type: "d" });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "find '/sdcard' -maxdepth 3 -type d -name '*.txt'");
	});

	test("single-quote-escapes path and pattern", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.tar'; rm -rf /;'");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(
			fakeSocket,
			fakeStreamManager,
			"find '/sdcard' -name '*.tar'\\''; rm -rf /;'\\'''"
		);
	});
});

describe("files.push (EXPERIMENTAL - ADB SYNC protocol, not yet validated against a real device)", () => {
	test("sends SEND + DATA + DONE and resolves on OKAY", async () => {
		const localFile = path.join(tmpDir, "push-src.txt");
		writeFileSync(localFile, "hello world");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.push(fakeSocket, streamManager, localFile, "/sdcard/dest.txt");

		expect(streamManager.openStream).toHaveBeenCalledWith("sync:");
		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("SEND");
		expect(stream.writes[0].subarray(8).toString("utf8")).toBe("/sdcard/dest.txt,420"); // 0o644 == 420
		expect(stream.writes[1].subarray(0, 4).toString("ascii")).toBe("DATA");
		expect(stream.writes[1].subarray(8).toString("utf8")).toBe("hello world");
		expect(stream.writes[2].subarray(0, 4).toString("ascii")).toBe("DONE");
		expect(stream.close).toHaveBeenCalled();
	});

	test("chunks data larger than the 64KB SYNC_DATA_MAX into multiple DATA frames", async () => {
		const localFile = path.join(tmpDir, "push-large.bin");
		const big = Buffer.alloc(64 * 1024 + 10, 0x41);
		writeFileSync(localFile, big);

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.push(fakeSocket, streamManager, localFile, "/sdcard/big.bin");

		const dataFrames = stream.writes.filter((w) => w.subarray(0, 4).toString("ascii") === "DATA");
		expect(dataFrames).toHaveLength(2);
		expect(dataFrames[0].subarray(8).length).toBe(64 * 1024);
		expect(dataFrames[1].subarray(8).length).toBe(10);
	});

	test("rejects with the device's message on FAIL", async () => {
		const localFile = path.join(tmpDir, "push-src.txt");
		writeFileSync(localFile, "data");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("FAIL", Buffer.from("Permission denied", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.push(fakeSocket, streamManager, localFile, "/system/dest.txt")).rejects.toThrow(
			"SYNC push failed: Permission denied"
		);
		expect(stream.close).toHaveBeenCalled();
	});
});

describe("files.pull (EXPERIMENTAL - ADB SYNC protocol, not yet validated against a real device)", () => {
	test("sends RECV, reassembles DATA frames, and writes the local file", async () => {
		const localFile = path.join(tmpDir, "pull-dest.txt");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RECV") {
				s.emit("data", buildFrame("DATA", Buffer.from("hello ", "utf8")));
				s.emit("data", buildFrame("DATA", Buffer.from("world", "utf8")));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pull(fakeSocket, streamManager, "/sdcard/source.txt", localFile);

		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("RECV");
		expect(stream.writes[0].subarray(8).toString("utf8")).toBe("/sdcard/source.txt");
		expect(readFileSync(localFile, "utf8")).toBe("hello world");
		expect(stream.close).toHaveBeenCalled();
	});

	test("reassembles a DATA frame split across multiple stream chunks", async () => {
		const localFile = path.join(tmpDir, "pull-split.txt");
		const frame = buildFrame("DATA", Buffer.from("split-data", "utf8"));

		const stream = createFakeSyncStream((writtenFrame, s) => {
			if (writtenFrame.subarray(0, 4).toString("ascii") === "RECV") {
				// Emit the DATA frame's header and payload as two separate chunks.
				s.emit("data", frame.subarray(0, 8));
				s.emit("data", frame.subarray(8));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pull(fakeSocket, streamManager, "/sdcard/source.txt", localFile);

		expect(readFileSync(localFile, "utf8")).toBe("split-data");
	});

	test("rejects with the device's message on FAIL", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RECV") {
				s.emit("data", buildFrame("FAIL", Buffer.from("No such file or directory", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(
			droidsock.files.pull(fakeSocket, streamManager, "/sdcard/missing.txt", path.join(tmpDir, "never-written.txt"))
		).rejects.toThrow("SYNC pull failed: No such file or directory");
		expect(stream.close).toHaveBeenCalled();
	});
});

describe("files.listSync (EXPERIMENTAL - ADB SYNC protocol, not yet validated against a real device)", () => {
	test("collects DENT entries until DONE", async () => {
		const S_IFDIR = 0o040000;
		const S_IFREG = 0o100000;
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("data", buildDentFrame(S_IFDIR | 0o755, 4096, 1767225600, "subdir"));
				s.emit("data", buildDentFrame(S_IFREG | 0o644, 123, 1767225600, "file.txt"));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const entries = await droidsock.files.listSync(fakeSocket, streamManager, "/sdcard");

		expect(streamManager.openStream).toHaveBeenCalledWith("sync:");
		expect(entries).toEqual([
			expect.objectContaining({ name: "subdir", isDirectory: true, isFile: false }),
			expect.objectContaining({ name: "file.txt", isFile: true, isDirectory: false, size: 123 })
		]);
		expect(stream.close).toHaveBeenCalled();
	});

	test("a DENT frame split across chunks reassembles correctly", async () => {
		const frame = buildDentFrame(0o100644, 5, 1767225600, "split.txt");
		const stream = createFakeSyncStream((writtenFrame, s) => {
			if (writtenFrame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("data", frame.subarray(0, 12));
				s.emit("data", frame.subarray(12));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const entries = await droidsock.files.listSync(fakeSocket, streamManager, "/sdcard");
		expect(entries).toEqual([expect.objectContaining({ name: "split.txt", size: 5 })]);
	});

	test("rejects on FAIL with the device's message", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("data", buildFrame("FAIL", Buffer.from("No such file or directory", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listSync(fakeSocket, streamManager, "/missing")).rejects.toThrow(
			"SYNC list failed: No such file or directory"
		);
		expect(stream.close).toHaveBeenCalled();
	});

	test("rejects rather than hanging if the stream closes before DONE/FAIL arrives", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				// Device disconnects mid-listing - no DONE/FAIL ever arrives.
				s.emit("close");
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listSync(fakeSocket, streamManager, "/sdcard")).rejects.toThrow(
			"Sync stream ended before a DONE/FAIL frame arrived"
		);
	});

	test("rejects with the stream's own error if it errors before DONE/FAIL arrives", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("error", new Error("ECONNRESET"));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listSync(fakeSocket, streamManager, "/sdcard")).rejects.toThrow("ECONNRESET");
	});

	test("still rejects (not hangs) when the stream closes after next() is already waiting on a frame", async () => {
		// Unlike the two tests above (where "close" fires synchronously during the
		// LIST write, before next() is ever called - so endError is already set on
		// next()'s first check), this defers the close to a later tick so next()
		// has already registered its waiter and is genuinely pending when endWith()
		// runs - the other of the two orderings next()/endWith() can occur in.
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				setImmediate(() => s.emit("close"));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listSync(fakeSocket, streamManager, "/sdcard")).rejects.toThrow(
			"Sync stream ended before a DONE/FAIL frame arrived"
		);
	});
});

describe("files.listShell", () => {
	test("builds ls -la and parses the output into structured entries", async () => {
		droidsock.shell.execute.mockResolvedValue("total 8\ndrwxr-xr-x 2 root root 4096 2026-01-01 sdcard\n");
		const entries = await droidsock.files.listShell(fakeSocket, fakeStreamManager, "/sdcard");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "ls -la '/sdcard'");
		expect(entries).toEqual([expect.objectContaining({ name: "sdcard", isDirectory: true })]);
	});
});

describe("files.list (prefers SYNC LIST, falls back to shell ls -la)", () => {
	test("uses the SYNC result when the sync stream is usable", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("data", buildDentFrame(0o040755, 4096, 1767225600, "sdcard"));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const entries = await droidsock.files.list(fakeSocket, streamManager, "/sdcard");

		expect(streamManager.openStream).toHaveBeenCalledWith("sync:");
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
		expect(entries).toEqual([expect.objectContaining({ name: "sdcard", isDirectory: true })]);
	});

	test("falls back to shell ls -la when the sync service isn't usable", async () => {
		droidsock.shell.execute.mockResolvedValue("total 8\ndrwxr-xr-x 2 root root 4096 2026-01-01 sdcard\n");
		// fakeStreamManager has no openStream() at all - simulates a connection state where SYNC can't be used.
		const entries = await droidsock.files.list(fakeSocket, fakeStreamManager, "/sdcard");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "ls -la '/sdcard'");
		expect(entries).toEqual([expect.objectContaining({ name: "sdcard", isDirectory: true })]);
	});

	test("does NOT fall back on a real LIST failure once the sync stream opened successfully", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIST") {
				s.emit("data", buildFrame("FAIL", Buffer.from("No such file or directory", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		// A real device-side failure must propagate as-is, not be masked by a
		// different-shaped (and misleading) shell fallback result.
		await expect(droidsock.files.list(fakeSocket, streamManager, "/missing")).rejects.toThrow(
			"SYNC list failed: No such file or directory"
		);
		expect(droidsock.shell.execute).not.toHaveBeenCalled();
	});
});

describe("files.stat", () => {
	test("builds a stat command and returns the raw output", async () => {
		droidsock.shell.execute.mockResolvedValue("  File: /sdcard/file.txt\n  Size: 123\n");
		const result = await droidsock.files.stat(fakeSocket, fakeStreamManager, "/sdcard/file.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "stat '/sdcard/file.txt'");
		expect(result).toBe("  File: /sdcard/file.txt\n  Size: 123\n");
	});

	test("single-quote-escapes a path containing a single quote", async () => {
		await droidsock.files.stat(fakeSocket, fakeStreamManager, "/sdcard/it's a file.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "stat '/sdcard/it'\\''s a file.txt'");
	});
});

describe("files.pushV2 (EXPERIMENTAL - ADB SYNC V2 protocol, not yet validated against a real device)", () => {
	test("sends an SND2 path frame, a raw send_v2 setup struct, DATA + DONE, and resolves on OKAY", async () => {
		const localFile = path.join(tmpDir, "push-v2-src.txt");
		writeFileSync(localFile, "hello world v2");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest-v2.txt");

		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("SND2");
		expect(stream.writes[0].subarray(8).toString("utf8")).toBe("/sdcard/dest-v2.txt");
		// Raw 12-byte send_v2_setup struct (id + mode + flags) - not the generic
		// id+value+payload shape, so it's exactly 12 bytes with no envelope.
		expect(stream.writes[1].length).toBe(12);
		expect(stream.writes[1].subarray(0, 4).toString("ascii")).toBe("SND2");
		expect(stream.writes[1].readUInt32LE(4)).toBe(0o644);
		expect(stream.writes[1].readUInt32LE(8)).toBe(0); // SYNC_FLAG_NONE
		expect(stream.writes[2].subarray(0, 4).toString("ascii")).toBe("DATA");
		expect(stream.writes[2].subarray(8).toString("utf8")).toBe("hello world v2");
		expect(stream.writes[3].subarray(0, 4).toString("ascii")).toBe("DONE");
		expect(stream.close).toHaveBeenCalled();
	});

	test("rejects with the device's message on FAIL", async () => {
		const localFile = path.join(tmpDir, "push-v2-src.txt");
		writeFileSync(localFile, "data");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("FAIL", Buffer.from("Permission denied", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/system/dest.txt")).rejects.toThrow(
			"SYNC send_v2 failed: Permission denied"
		);
		expect(stream.close).toHaveBeenCalled();
	});

	test('compression: "brotli" sets the SND2 setup flag and sends brotli-compressed DATA chunks', async () => {
		const localFile = path.join(tmpDir, "push-v2-brotli.txt");
		writeFileSync(localFile, "hello world v2");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest-v2.txt", { compression: "brotli" });

		expect(stream.writes[1].readUInt32LE(8)).toBe(1); // SYNC_FLAG_BROTLI
		const dataPayload = stream.writes[2].subarray(8);
		expect(brotliDecompressSync(dataPayload).toString("utf8")).toBe("hello world v2");
	});

	test('compression: "brotli" chunks raw input below the 64KB SYNC_DATA_MAX, leaving headroom for brotli expansion', async () => {
		const localFile = path.join(tmpDir, "push-v2-brotli-large.bin");
		// Incompressible random data - brotli can slightly expand this, which is
		// exactly the case that would overflow SYNC_DATA_MAX if raw input were
		// chunked at the full 64KB instead of the smaller compressed-mode chunk.
		const big = crypto.randomBytes(48 * 1024 + 10);
		writeFileSync(localFile, big);

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest-v2.bin", { compression: "brotli" });

		const dataFrames = stream.writes.filter((w) => w.subarray(0, 4).toString("ascii") === "DATA");
		// FileHandle.read() is permitted to return fewer bytes than requested even
		// before EOF, so more than 2 frames is legitimate - assert chunking
		// occurred (more than one frame) and each respects the ceiling, rather
		// than an exact count.
		expect(dataFrames.length).toBeGreaterThan(1);
		for (const frame of dataFrames) {
			expect(frame.subarray(8).length).toBeLessThanOrEqual(64 * 1024);
		}
		const decompressed = Buffer.concat(dataFrames.map((f) => brotliDecompressSync(f.subarray(8))));
		expect(decompressed.equals(big)).toBe(true);
	});

	test("rejects an invalid compression value without opening a stream", async () => {
		const localFile = path.join(tmpDir, "push-v2-invalid.txt");
		writeFileSync(localFile, "data");
		const streamManager = { openStream: vi.fn() };

		await expect(droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest.txt", { compression: "lz4" })).rejects.toThrow(
			'Invalid compression: lz4 (must be "none" or "brotli")'
		);
		expect(streamManager.openStream).not.toHaveBeenCalled();
	});

	test.each([["07777"], [0o10000], [-1], [420.5], [null]])("rejects an invalid mode (%p) without opening a stream", async (mode) => {
		const localFile = path.join(tmpDir, "push-v2-invalid-mode.txt");
		writeFileSync(localFile, "data");
		const streamManager = { openStream: vi.fn() };

		await expect(droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest.txt", { mode })).rejects.toThrow(
			"Invalid mode"
		);
		expect(streamManager.openStream).not.toHaveBeenCalled();
	});

	test("reads the local file from disk in SYNC_DATA_MAX-sized chunks rather than buffering it whole, sending multiple DATA frames", async () => {
		const localFile = path.join(tmpDir, "push-v2-large.bin");
		// One byte over the 64KB SYNC_DATA_MAX chunk ceiling - proves the file is
		// read/sent in bounded pieces via a file handle, not loaded whole via
		// readFile() (the pre-fix behavior this test guards against regressing to).
		const big = crypto.randomBytes(64 * 1024 + 1);
		writeFileSync(localFile, big);

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				s.emit("data", buildFrame("OKAY", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onProgress = vi.fn();

		await droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest-v2-large.bin", { onProgress });

		const dataFrames = stream.writes.filter((w) => w.subarray(0, 4).toString("ascii") === "DATA");
		// FileHandle.read() is permitted to return fewer bytes than requested even
		// before EOF, so more than 2 frames is legitimate - assert chunking
		// occurred (more than one frame) and each respects the ceiling, rather
		// than an exact count/size.
		expect(dataFrames.length).toBeGreaterThan(1);
		for (const frame of dataFrames) {
			expect(frame.subarray(8).length).toBeLessThanOrEqual(64 * 1024);
		}
		expect(Buffer.concat(dataFrames.map((f) => f.subarray(8))).equals(big)).toBe(true);
		expect(onProgress).toHaveBeenLastCalledWith({ bytesTransferred: big.length, totalBytes: big.length });
	});

	test("rejects rather than hanging if the stream closes before OKAY/FAIL arrives", async () => {
		const localFile = path.join(tmpDir, "push-v2-stall.txt");
		writeFileSync(localFile, "data");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "DONE") {
				// Device disconnects mid-transfer - no OKAY/FAIL ever arrives.
				s.emit("close");
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.pushV2(fakeSocket, streamManager, localFile, "/sdcard/dest.txt")).rejects.toThrow(
			"Sync stream ended before a terminal frame arrived"
		);
	});
});

describe("files.pullV2 (EXPERIMENTAL - ADB SYNC V2 protocol, not yet validated against a real device)", () => {
	test("sends an RCV2 path frame, a raw recv_v2 setup struct, reassembles DATA, and writes the local file", async () => {
		const localFile = path.join(tmpDir, "pull-v2-dest.txt");

		const stream = createFakeSyncStream((frame, s) => {
			// The setup struct is exactly 8 bytes (id + flags) - the path frame is
			// 8 + pathlen, so this distinguishes the two without tracking order.
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				s.emit("data", buildFrame("DATA", Buffer.from("hello ", "utf8")));
				s.emit("data", buildFrame("DATA", Buffer.from("world v2", "utf8")));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.txt", localFile);

		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("RCV2");
		expect(stream.writes[0].subarray(8).toString("utf8")).toBe("/sdcard/source.txt");
		expect(stream.writes[1].length).toBe(8);
		expect(stream.writes[1].readUInt32LE(4)).toBe(0); // SYNC_FLAG_NONE
		expect(readFileSync(localFile, "utf8")).toBe("hello world v2");
		expect(stream.close).toHaveBeenCalled();
	});

	test("rejects with the device's message on FAIL", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				s.emit("data", buildFrame("FAIL", Buffer.from("No such file or directory", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(
			droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/missing.txt", path.join(tmpDir, "never-written.txt"))
		).rejects.toThrow("SYNC recv_v2 failed: No such file or directory");
		expect(stream.close).toHaveBeenCalled();
	});

	test('compression: "brotli" sets the RCV2 setup flag and decompresses incoming DATA chunks', async () => {
		const localFile = path.join(tmpDir, "pull-v2-brotli.txt");
		const compressed = brotliCompressSync(Buffer.from("hello world v2", "utf8"));

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				s.emit("data", buildFrame("DATA", compressed));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.txt", localFile, { compression: "brotli" });

		expect(stream.writes[1].readUInt32LE(4)).toBe(1); // SYNC_FLAG_BROTLI
		expect(readFileSync(localFile, "utf8")).toBe("hello world v2");
	});

	test("rejects an invalid compression value without opening a stream", async () => {
		const streamManager = { openStream: vi.fn() };

		await expect(
			droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.txt", path.join(tmpDir, "never.txt"), {
				compression: "zstd"
			})
		).rejects.toThrow('Invalid compression: zstd (must be "none" or "brotli")');
		expect(streamManager.openStream).not.toHaveBeenCalled();
	});

	test("writes each DATA chunk to the local file as it arrives, reconstructing content across many chunks with cumulative progress", async () => {
		const localFile = path.join(tmpDir, "pull-v2-many-chunks.bin");
		// Random (not repeated) bytes per chunk, so an out-of-order or dropped
		// write would produce a detectably wrong file rather than accidentally
		// matching via a repeated pattern.
		const parts = Array.from({ length: 5 }, () => crypto.randomBytes(37));
		const expected = Buffer.concat(parts);

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				for (const part of parts) s.emit("data", buildFrame("DATA", part));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onProgress = vi.fn();

		await droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.bin", localFile, { onProgress });

		expect(readFileSync(localFile).equals(expected)).toBe(true);
		expect(onProgress).toHaveBeenCalledTimes(5);
		expect(onProgress).toHaveBeenLastCalledWith({ bytesTransferred: expected.length });
	});

	test("rejects rather than hanging if the stream closes before DONE/FAIL arrives", async () => {
		const localFile = path.join(tmpDir, "pull-v2-stall.bin");

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				// Device disconnects mid-transfer - no DONE/FAIL ever arrives.
				s.emit("close");
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.bin", localFile)).rejects.toThrow(
			"Sync stream ended before a terminal frame arrived"
		);
	});

	test("rejects a brotli chunk that decompresses past the output cap instead of allocating unbounded memory", async () => {
		const localFile = path.join(tmpDir, "pull-v2-brotli-bomb.bin");
		// Highly compressible input - a small compressed payload that expands
		// well past the 64KB SYNC_DATA_MAX cap, simulating a decompression bomb
		// from a malformed/hostile device.
		const bomb = brotliCompressSync(Buffer.alloc(200 * 1024, 0));

		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "RCV2" && frame.length === 8) {
				s.emit("data", buildFrame("DATA", bomb));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(
			droidsock.files.pullV2(fakeSocket, streamManager, "/sdcard/source.bin", localFile, { compression: "brotli" })
		).rejects.toThrow(/decompressed past the \d+-byte cap - rejecting as a likely decompression bomb/);
	});
});

describe("files.statV2 (EXPERIMENTAL - ADB SYNC V2 protocol, not yet validated against a real device)", () => {
	test("returns structured stat fields on success", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "STA2") {
				s.emit("data", buildStatV2Frame({ mode: 0o100644, size: 123n, mtime: 1767225600n }));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const result = await droidsock.files.statV2(fakeSocket, streamManager, "/sdcard/file.txt");

		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("STA2");
		expect(result).toEqual(expect.objectContaining({ mode: 0o100644, size: 123n, mtime: 1767225600n, isFile: true, isDirectory: false }));
		expect(stream.close).toHaveBeenCalled();
	});

	test("throws with the errno when the reply's error field is non-zero", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "STA2") {
				s.emit("data", buildStatV2Frame({ error: 2 })); // ENOENT
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.statV2(fakeSocket, streamManager, "/missing")).rejects.toThrow(
			"SYNC stat_v2 failed for /missing: errno 2"
		);
	});

	test("throws instead of silently interpreting a desynced reply whose leading id isn't STA2", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "STA2") {
				// A 72-byte buffer that happens to carry the right shape but a
				// different record id - e.g. a stale/misrouted reply from another
				// SYNC command. Without validating the id, this would silently
				// parse as a (wrong) successful stat result instead of erroring.
				s.emit("data", buildStatV2Frame({ id: "DNT2", mode: 0o100644, size: 999n }));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.statV2(fakeSocket, streamManager, "/sdcard/file.txt")).rejects.toThrow(
			"Unexpected SYNC frame during stat_v2: DNT2"
		);
	});

	test("reassembles a stat_v2 reply split across multiple stream chunks", async () => {
		const frame = buildStatV2Frame({ mode: 0o040755, size: 4096n });
		const stream = createFakeSyncStream((writtenFrame, s) => {
			if (writtenFrame.subarray(0, 4).toString("ascii") === "STA2") {
				s.emit("data", frame.subarray(0, 30));
				s.emit("data", frame.subarray(30));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const result = await droidsock.files.statV2(fakeSocket, streamManager, "/sdcard");
		expect(result).toEqual(expect.objectContaining({ isDirectory: true, size: 4096n }));
	});
});

describe("files.listV2 (EXPERIMENTAL - ADB SYNC V2 protocol, not yet validated against a real device)", () => {
	test("collects DNT2 entries until DONE", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIS2") {
				s.emit("data", buildDentV2Frame({ mode: 0o040755, size: 4096n, mtime: 1767225600n, name: "subdir" }));
				s.emit("data", buildDentV2Frame({ mode: 0o100644, size: 123n, mtime: 1767225600n, name: "file.txt" }));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const entries = await droidsock.files.listV2(fakeSocket, streamManager, "/sdcard");

		expect(stream.writes[0].subarray(0, 4).toString("ascii")).toBe("LIS2");
		expect(entries).toEqual([
			expect.objectContaining({ name: "subdir", isDirectory: true, size: 4096n }),
			expect.objectContaining({ name: "file.txt", isFile: true, size: 123n })
		]);
		expect(stream.close).toHaveBeenCalled();
	});

	test("rejects on FAIL with the device's message", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIS2") {
				s.emit("data", buildFrame("FAIL", Buffer.from("No such file or directory", "utf8")));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listV2(fakeSocket, streamManager, "/missing")).rejects.toThrow(
			"SYNC list_v2 failed: No such file or directory"
		);
	});

	test("a DNT2 entry split across chunks reassembles correctly", async () => {
		const frame = buildDentV2Frame({ mode: 0o100644, size: 5n, mtime: 1767225600n, name: "split.txt" });
		const stream = createFakeSyncStream((writtenFrame, s) => {
			if (writtenFrame.subarray(0, 4).toString("ascii") === "LIS2") {
				s.emit("data", frame.subarray(0, 40));
				s.emit("data", frame.subarray(40));
				s.emit("data", buildFrame("DONE", 0));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const entries = await droidsock.files.listV2(fakeSocket, streamManager, "/sdcard");
		expect(entries).toEqual([expect.objectContaining({ name: "split.txt", size: 5n })]);
	});

	test("rejects rather than hanging if the stream closes before DONE/FAIL arrives", async () => {
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIS2") {
				s.emit("close");
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listV2(fakeSocket, streamManager, "/sdcard")).rejects.toThrow(
			"Sync stream ended before enough bytes arrived"
		);
	});

	test("rejects a DNT2 entry claiming an oversized namelen instead of buffering forever waiting for it", async () => {
		// A malformed/hostile device could set namelen (a plain uint32, no
		// protocol-defined ceiling) arbitrarily large - readBytes(namelen) would
		// then wait indefinitely for that many bytes to arrive, growing the
		// reader's internal buffer without bound. The rejection must happen
		// before any name bytes are read, so the real (small) name below is
		// never actually sent - only the oversized claimed length is.
		const stream = createFakeSyncStream((frame, s) => {
			if (frame.subarray(0, 4).toString("ascii") === "LIS2") {
				s.emit("data", buildDentV2Frame({ mode: 0o100644, size: 1n, name: "x", namelenOverride: 10 * 1024 * 1024 }));
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.files.listV2(fakeSocket, streamManager, "/sdcard")).rejects.toThrow(
			"list_v2 entry name length 10485760 exceeds the maximum of 4096"
		);
	});
});
