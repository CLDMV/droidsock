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
