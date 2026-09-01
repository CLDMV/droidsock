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
import createDroidSock from "../index.mjs";

// install.classic() is pure composition of files.push + shell.commands.installApk +
// files.remove - spying on all three lets this be tested for real without any
// protocol-level mocking.
let droidsock;
const fakeSocket = {};
const fakeStreamManager = {};

beforeEach(async () => {
	droidsock = await createDroidSock();
	vi.spyOn(droidsock.files, "push").mockResolvedValue();
	vi.spyOn(droidsock.shell.commands, "installApk").mockResolvedValue("Success");
	vi.spyOn(droidsock.files, "remove").mockResolvedValue();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (droidsock.shutdown) await droidsock.shutdown();
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
