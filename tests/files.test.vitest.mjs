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
import createDroidSock from "../index.mjs";

// files.mjs's implemented operations are thin shell-command builders - they call
// self.shell.execute(socket, streamManager, command) and nothing else. Spying on
// shell.execute lets these be tested for real (the exact command string built)
// without a device or any protocol-level mocking.
let droidsock;
const fakeSocket = {};
const fakeStreamManager = {};

beforeEach(async () => {
	droidsock = await createDroidSock();
	vi.spyOn(droidsock.shell, "execute").mockResolvedValue("");
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("files.mkdir", () => {
	test("builds mkdir -p with the default 0o755 mode", async () => {
		await droidsock.files.mkdir(fakeSocket, fakeStreamManager, "/sdcard/newdir");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(
			fakeSocket,
			fakeStreamManager,
			'mkdir -p "/sdcard/newdir" && chmod 755 "/sdcard/newdir"'
		);
	});

	test("honors a custom mode", async () => {
		await droidsock.files.mkdir(fakeSocket, fakeStreamManager, "/sdcard/newdir", 0o700);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(
			fakeSocket,
			fakeStreamManager,
			'mkdir -p "/sdcard/newdir" && chmod 700 "/sdcard/newdir"'
		);
	});
});

describe("files.remove", () => {
	test("builds a non-recursive rm by default", async () => {
		await droidsock.files.remove(fakeSocket, fakeStreamManager, "/sdcard/file.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'rm -f "/sdcard/file.txt"');
	});

	test("builds a recursive rm when requested", async () => {
		await droidsock.files.remove(fakeSocket, fakeStreamManager, "/sdcard/dir", true);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'rm -rf "/sdcard/dir"');
	});
});

describe("files.move", () => {
	test("builds mv with source and destination", async () => {
		await droidsock.files.move(fakeSocket, fakeStreamManager, "/sdcard/a.txt", "/sdcard/b.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'mv "/sdcard/a.txt" "/sdcard/b.txt"');
	});
});

describe("files.copy", () => {
	test("builds cp without -r by default", async () => {
		await droidsock.files.copy(fakeSocket, fakeStreamManager, "/sdcard/a.txt", "/sdcard/b.txt");
		const [, , command] = droidsock.shell.execute.mock.calls[0];
		expect(command).toContain("cp");
		expect(command).not.toContain("-r");
		expect(command).toContain('"/sdcard/a.txt" "/sdcard/b.txt"');
	});

	test("builds cp -r when recursive", async () => {
		await droidsock.files.copy(fakeSocket, fakeStreamManager, "/sdcard/dir", "/sdcard/dir2", true);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'cp -r "/sdcard/dir" "/sdcard/dir2"');
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
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'chmod -R 755 "/sdcard/dir"');
	});
});

describe("files.diskUsage", () => {
	test("defaults to checking /", async () => {
		await droidsock.files.diskUsage(fakeSocket, fakeStreamManager);
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'df -h "/"');
	});

	test("checks a specific path", async () => {
		await droidsock.files.diskUsage(fakeSocket, fakeStreamManager, "/sdcard");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'df -h "/sdcard"');
	});
});

describe("files.find", () => {
	test("builds a basic find by name", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt");
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'find "/sdcard" -name "*.txt"');
	});

	test("adds -maxdepth when given", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth: 2 });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'find "/sdcard" -maxdepth 2 -name "*.txt"');
	});

	test("adds -type when given", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { type: "f" });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'find "/sdcard" -type f -name "*.txt"');
	});

	test("combines -maxdepth and -type", async () => {
		await droidsock.files.find(fakeSocket, fakeStreamManager, "/sdcard", "*.txt", { maxDepth: 3, type: "d" });
		expect(droidsock.shell.execute).toHaveBeenCalledWith(fakeSocket, fakeStreamManager, 'find "/sdcard" -maxdepth 3 -type d -name "*.txt"');
	});
});

describe("files.push / pull / list / stat (not yet implemented)", () => {
	test("push() throws", async () => {
		await expect(droidsock.files.push()).rejects.toThrow("File push not yet implemented");
	});

	test("pull() throws", async () => {
		await expect(droidsock.files.pull()).rejects.toThrow("File pull not yet implemented");
	});

	test("list() throws", async () => {
		await expect(droidsock.files.list()).rejects.toThrow("Directory listing not yet implemented");
	});

	test("stat() throws", async () => {
		await expect(droidsock.files.stat()).rejects.toThrow("File stat not yet implemented");
	});
});
