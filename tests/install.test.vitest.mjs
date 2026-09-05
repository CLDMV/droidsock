/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/install.test.vitest.mjs
 *	@Date: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import createDroidSock from "../index.mjs";

// install.classic() is pure composition of files.push + shell.commands.installApk +
// files.remove - spying on all three lets this be tested for real without any
// protocol-level mocking.
let droidsock;
let tmpDir;
const fakeSocket = {};
const fakeStreamManager = {};

/**
 * Creates a fake "exec:" stream for install.streaming() tests. `onWrite` is
 * called synchronously with each stdin chunk the code under test writes (and
 * the stream itself, to emit "data"/"close"/"error" responses) - same
 * drive-off-the-real-exchange approach files.test.vitest.mjs's
 * createFakeSyncStream uses for the SYNC tests.
 * @param {(chunk: Buffer, stream: EventEmitter) => void} [onWrite] - Called on every stream.write().
 * @returns {EventEmitter & {write: Function, close: Function, writes: Buffer[]}} The fake stream.
 */
function createFakeExecStream(onWrite) {
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
	vi.spyOn(droidsock.files, "push").mockResolvedValue();
	vi.spyOn(droidsock.shell.commands, "installApk").mockResolvedValue("Success");
	vi.spyOn(droidsock.files, "remove").mockResolvedValue();
	tmpDir = mkdtempSync(path.join(tmpdir(), "droidsock-install-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	// Guarded - if beforeEach() threw before tmpDir was assigned (e.g.
	// createDroidSock() itself failed), an unguarded rmSync(undefined, ...)
	// would throw its own TypeError here and mask the real failure.
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	if (droidsock?.shutdown) await droidsock.shutdown();
});

describe("install.classic", () => {
	test("pushes to /data/local/tmp by default, installs, then removes the temp file", async () => {
		const result = await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk");

		expect(droidsock.files.push).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/local/app.apk", "/data/local/tmp/app.apk", {
			onProgress: undefined
		});
		expect(droidsock.shell.commands.installApk).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/data/local/tmp/app.apk", []);
		expect(droidsock.files.remove).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/data/local/tmp/app.apk");
		expect(result).toBe("Success");
	});

	test("honors a custom remoteDir", async () => {
		await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk", { remoteDir: "/sdcard" });
		expect(droidsock.files.push).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/local/app.apk", "/sdcard/app.apk", {
			onProgress: undefined
		});
		expect(droidsock.shell.commands.installApk).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/sdcard/app.apk", []);
	});

	test("doesn't produce a double slash when remoteDir already ends in one", async () => {
		await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk", { remoteDir: "/sdcard/" });
		expect(droidsock.files.push).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/local/app.apk", "/sdcard/app.apk", {
			onProgress: undefined
		});
	});

	test("passes flags through to pm install", async () => {
		await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk", { flags: ["-r", "-d"] });
		expect(droidsock.shell.commands.installApk).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/data/local/tmp/app.apk", [
			"-r",
			"-d"
		]);
	});

	test("passes onProgress through to push", async () => {
		const onProgress = vi.fn();
		await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk", { onProgress });
		expect(droidsock.files.push).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/local/app.apk", "/data/local/tmp/app.apk", {
			onProgress
		});
	});

	test("still removes the temp file, and rethrows, when pm install fails", async () => {
		droidsock.shell.commands.installApk.mockRejectedValue(new Error("INSTALL_FAILED_INSUFFICIENT_STORAGE"));

		await expect(droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk")).rejects.toThrow(
			"INSTALL_FAILED_INSUFFICIENT_STORAGE"
		);
		expect(droidsock.files.remove).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/data/local/tmp/app.apk");
	});

	test("still attempts cleanup, and rethrows, when push fails partway through", async () => {
		droidsock.files.push.mockRejectedValue(new Error("connection reset"));

		await expect(droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk")).rejects.toThrow("connection reset");
		// If push threw after sending some data, the device can be left with a
		// partial temp APK - cleanup must still be attempted (files.remove is a
		// harmless no-op if nothing was actually written).
		expect(droidsock.files.remove).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, "/data/local/tmp/app.apk");
		expect(droidsock.shell.commands.installApk).not.toHaveBeenCalled();
	});

	test("a failed cleanup doesn't mask a successful install result", async () => {
		droidsock.files.remove.mockRejectedValue(new Error("permission denied"));
		const result = await droidsock.install.classic(fakeSocket, fakeStreamManager, "/local/app.apk");
		expect(result).toBe("Success");
	});
});

describe("install.streaming (EXPERIMENTAL - exec:cmd package install, not yet validated against a real device)", () => {
	test("opens exec:cmd package install -S <size> and streams the APK bytes as stdin, resolving with the command's output", async () => {
		const localFile = path.join(tmpDir, "app.apk");
		writeFileSync(localFile, "fake-apk-bytes");
		const size = Buffer.byteLength("fake-apk-bytes");

		let totalWritten = 0;
		const stream = createFakeExecStream((chunk, s) => {
			totalWritten += chunk.length;
			if (totalWritten === size) {
				s.emit("data", Buffer.from("Success\n"));
				s.emit("close");
			}
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const result = await droidsock.install.streaming(fakeSocket, streamManager, localFile);

		expect(streamManager.openStream).toHaveBeenCalledWith(`exec:cmd package install -S ${size}`);
		expect(Buffer.concat(stream.writes).toString("utf8")).toBe("fake-apk-bytes");
		expect(result).toBe("Success\n");
		expect(stream.close).toHaveBeenCalled();
	});

	test("passes flags through to the exec destination string", async () => {
		const localFile = path.join(tmpDir, "app.apk");
		writeFileSync(localFile, "x");
		const stream = createFakeExecStream((___chunk, s) => s.emit("close"));
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.install.streaming(fakeSocket, streamManager, localFile, { flags: ["-r", "-d"] });

		expect(streamManager.openStream).toHaveBeenCalledWith("exec:cmd package install -S 1 -r -d");
	});

	test("chunks stdin larger than the 64KB write chunk into multiple stream.write() calls", async () => {
		const localFile = path.join(tmpDir, "big.apk");
		const big = Buffer.alloc(64 * 1024 + 10, 0x42);
		writeFileSync(localFile, big);

		let totalWritten = 0;
		const stream = createFakeExecStream((chunk, s) => {
			totalWritten += chunk.length;
			if (totalWritten === big.length) s.emit("close");
		});
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await droidsock.install.streaming(fakeSocket, streamManager, localFile);

		expect(stream.writes).toHaveLength(2);
		expect(stream.writes[0].length).toBe(64 * 1024);
		expect(stream.writes[1].length).toBe(10);
	});

	test("calls onProgress with cumulative bytes transferred", async () => {
		const localFile = path.join(tmpDir, "app.apk");
		writeFileSync(localFile, "hello");
		const stream = createFakeExecStream((___chunk, s) => s.emit("close"));
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onProgress = vi.fn();

		await droidsock.install.streaming(fakeSocket, streamManager, localFile, { onProgress });

		expect(onProgress).toHaveBeenCalledWith({ bytesTransferred: 5, totalBytes: 5 });
	});

	test("closes the stream and rejects when the device errors before closing", async () => {
		const localFile = path.join(tmpDir, "app.apk");
		writeFileSync(localFile, "hello");
		const stream = createFakeExecStream((___chunk, s) => s.emit("error", new Error("device disconnected")));
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.install.streaming(fakeSocket, streamManager, localFile)).rejects.toThrow("device disconnected");
		expect(stream.close).toHaveBeenCalled();
	});

	test("stops the write loop (without throwing) when the stream closes normally mid-transfer, not just on error", async () => {
		const localFile = path.join(tmpDir, "big.apk");
		// 2 chunks - if the loop kept writing after the first chunk's close,
		// there would be a second stream.write() call to catch.
		const big = Buffer.alloc(64 * 1024 + 10, 0x42);
		writeFileSync(localFile, big);

		// The device ends the exec stream normally (no error) before the full
		// APK was sent - `closed` only ever REJECTS on "error", so this
		// previously left `stopped` false and let the loop attempt another
		// write against the already-closed stream.
		const stream = createFakeExecStream((___chunk, s) => s.emit("close"));
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		await expect(droidsock.install.streaming(fakeSocket, streamManager, localFile)).resolves.toBe("");
		expect(stream.writes).toHaveLength(1);
	});
});
