/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/shell.test.vitest.mjs
 *	@Date: 2026-09-05 00:00:00 -07:00 (1788505200)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-05 00:00:00 -07:00 (1788505200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import createDroidSock from "../index.mjs";

// execute() talks directly to a raw ADB socket (not through streamManager) using the same
// 24-byte OPEN/OKAY/WRTE/CLSE framing connection.mjs itself uses - a plain EventEmitter with a
// captured write() is enough to drive it, since execute()'s own receive-side parser doesn't
// validate the checksum/magic fields it never itself needs on the way in.
const MSG_OKAY = 0x59414b4f;
const MSG_WRTE = 0x45545257;
const MSG_CLSE = 0x45534c43;
// execute() hardcodes its own local stream id rather than generating one - every simulated
// device response below must target this exact id to be recognized.
const EXECUTE_LOCAL_ID = 12345;

/**
 * Builds a raw 24-byte-header ADB packet for driving execute()'s receive-side parser, which
 * only reads command/arg0/arg1/dataLength off the wire and never validates checksum/magic.
 * @param {number} command - Message command.
 * @param {number} arg0 - First argument.
 * @param {number} arg1 - Second argument.
 * @param {Buffer} [data] - Message data.
 * @returns {Buffer} The framed packet.
 */
function buildRawPacket(command, arg0, arg1, data = Buffer.alloc(0)) {
	const header = Buffer.alloc(24);
	header.writeUInt32LE(command, 0);
	header.writeUInt32LE(arg0, 4);
	header.writeUInt32LE(arg1, 8);
	header.writeUInt32LE(data.length, 12);
	return Buffer.concat([header, data]);
}

/**
 * Creates a fake raw socket for execute() - just an EventEmitter with a capturing write().
 * @returns {EventEmitter & {write: Function, writes: Buffer[]}} The fake socket.
 */
function createFakeShellSocket() {
	const socket = new EventEmitter();
	socket.writes = [];
	socket.write = (data) => {
		socket.writes.push(data);
	};
	return socket;
}

/**
 * Extracts the destination string execute() encoded into its OPEN packet's data section.
 * @param {Buffer} openPacket - The OPEN packet captured from a fake socket's writes.
 * @returns {string} The decoded destination (e.g. "shell:ls").
 */
function destinationOf(openPacket) {
	return openPacket.subarray(24).toString("utf8");
}

let droidsock;
const fakeSocket = {};

beforeEach(async () => {
	droidsock = await createDroidSock();
});

afterEach(async () => {
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("shell.execute", () => {
	test("opens shell:<command> and resolves with WRTE output collected up to CLSE", async () => {
		const socket = createFakeShellSocket();
		const resultPromise = droidsock.shell.execute(socket, {}, "echo hi");

		expect(socket.writes).toHaveLength(1);
		expect(destinationOf(socket.writes[0])).toBe("shell:echo hi");

		socket.emit("data", buildRawPacket(MSG_OKAY, 0, EXECUTE_LOCAL_ID));
		socket.emit("data", buildRawPacket(MSG_WRTE, 0, EXECUTE_LOCAL_ID, Buffer.from("hi\n", "utf8")));
		socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));

		await expect(resultPromise).resolves.toBe("hi\n");
	});

	test("uses the shell,v2:<command> protocol string when the device advertises shell_v2", async () => {
		const socket = createFakeShellSocket();
		const resultPromise = droidsock.shell.execute(socket, {}, "echo hi", { deviceFeatures: ["shell_v2"] });

		expect(destinationOf(socket.writes[0])).toBe("shell,v2:echo hi");

		socket.emit("data", buildRawPacket(MSG_OKAY, 0, EXECUTE_LOCAL_ID));
		socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));
		await expect(resultPromise).resolves.toBe("");
	});

	test("reassembles output split across multiple WRTE packets and multiple socket chunks", async () => {
		const socket = createFakeShellSocket();
		const resultPromise = droidsock.shell.execute(socket, {}, "cat file");

		const wrte1 = buildRawPacket(MSG_WRTE, 0, EXECUTE_LOCAL_ID, Buffer.from("hello ", "utf8"));
		const wrte2 = buildRawPacket(MSG_WRTE, 0, EXECUTE_LOCAL_ID, Buffer.from("world", "utf8"));
		const clse = buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID);
		// One chunk carrying two full packets, then a chunk split mid-header of a third -
		// proves the internal responseBuffer correctly waits for a full 24-byte header plus
		// its declared data length before parsing, regardless of how the transport chunks it.
		const combined = Buffer.concat([wrte1, wrte2, clse]);
		socket.emit("data", combined.subarray(0, 10));
		socket.emit("data", combined.subarray(10));

		await expect(resultPromise).resolves.toBe("hello world");
	});

	test("respects a custom encoding option", async () => {
		const socket = createFakeShellSocket();
		const payload = Buffer.from("café", "utf8");
		const resultPromise = droidsock.shell.execute(socket, {}, "echo", { encoding: "hex" });

		socket.emit("data", buildRawPacket(MSG_WRTE, 0, EXECUTE_LOCAL_ID, payload));
		socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));

		await expect(resultPromise).resolves.toBe(payload.toString("hex"));
	});

	test("restores the socket's original data listeners once the command completes", async () => {
		const socket = createFakeShellSocket();
		const originalListener = vi.fn();
		socket.on("data", originalListener);
		const originalListenerCount = socket.listeners("data").length;

		const resultPromise = droidsock.shell.execute(socket, {}, "pwd");
		// execute() hijacks the socket's data listeners for the duration of the command - the
		// original listener is detached, so a "data" event during this window must not reach it
		// (the CLSE packet below is what execute()'s own hijacking listener consumes instead).
		socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));
		expect(originalListener).not.toHaveBeenCalled();
		await resultPromise;

		// Restored afterward - same listener count as before, and it fires again on a new event.
		expect(socket.listeners("data")).toHaveLength(originalListenerCount);
		socket.emit("data", Buffer.from("anything"));
		expect(originalListener).toHaveBeenCalledOnce();
	});

	test("rejects with a timeout error if CLSE never arrives in time", async () => {
		const socket = createFakeShellSocket();
		await expect(droidsock.shell.execute(socket, {}, "sleep 100", { timeout: 20 })).rejects.toThrow("Command timeout: sleep 100");
	});

	test("a late CLSE after the timeout has already fired is ignored, not a second resolve/reject", async () => {
		const socket = createFakeShellSocket();
		await expect(droidsock.shell.execute(socket, {}, "slow", { timeout: 20 })).rejects.toThrow("Command timeout");

		// Must not throw an unhandled rejection/exception from touching state after completion.
		expect(() => socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID))).not.toThrow();
	});

	test("rejects if writing the OPEN packet throws synchronously", async () => {
		const socket = createFakeShellSocket();
		socket.write = () => {
			throw new Error("socket destroyed");
		};
		await expect(droidsock.shell.execute(socket, {}, "ls")).rejects.toThrow("socket destroyed");
	});

	test("logs debug messages along the OPEN/OKAY/WRTE/CLSE path when config.debug is enabled", async () => {
		const debugDroidsock = await createDroidSock({ config: { debug: true } });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const socket = createFakeShellSocket();
			const resultPromise = debugDroidsock.shell.execute(socket, {}, "echo hi");

			socket.emit("data", buildRawPacket(MSG_OKAY, 0, EXECUTE_LOCAL_ID));
			socket.emit("data", buildRawPacket(MSG_WRTE, 0, EXECUTE_LOCAL_ID, Buffer.from("hi", "utf8")));
			socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));

			await resultPromise;
			expect(logSpy).toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			if (debugDroidsock.shutdown) await debugDroidsock.shutdown();
		}
	});
});

describe("shell.startStreaming", () => {
	function createFakeStream() {
		const stream = new EventEmitter();
		stream.close = vi.fn();
		stream.write = vi.fn();
		return stream;
	}

	test("opens shell:<command> and forwards data/close events to the callbacks", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onData = vi.fn();
		const onEnd = vi.fn();

		droidsock.shell.startStreaming(fakeSocket, streamManager, "logcat", { onData, onEnd });
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);
		expect(streamManager.openStream).toHaveBeenCalledWith("shell:logcat");

		stream.emit("data", Buffer.from("log line", "utf8"));
		stream.emit("close");

		expect(onData).toHaveBeenCalledWith("log line");
		expect(onEnd).toHaveBeenCalledOnce();
	});

	test("forwards a stream error to onError", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onError = vi.fn();

		droidsock.shell.startStreaming(fakeSocket, streamManager, "logcat", { onError });
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		const error = new Error("stream broke");
		stream.emit("error", error);
		expect(onError).toHaveBeenCalledWith(error);
	});

	test("calls onError instead of throwing when openStream() itself rejects", async () => {
		const streamManager = { openStream: vi.fn().mockRejectedValue(new Error("device gone")) };
		const onError = vi.fn();

		droidsock.shell.startStreaming(fakeSocket, streamManager, "logcat", { onError });
		await vi.waitUntil(() => onError.mock.calls.length > 0);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "device gone" }));
	});

	test("stop() closes the underlying stream once it has opened", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const control = droidsock.shell.startStreaming(fakeSocket, streamManager, "top -m 10");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		control.stop();
		expect(stream.close).toHaveBeenCalledOnce();

		// A second stop() must not throw or close an already-nulled stream again.
		expect(() => control.stop()).not.toThrow();
		expect(stream.close).toHaveBeenCalledOnce();
	});

	test("data/close/error events are silently dropped when no callbacks were given", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		droidsock.shell.startStreaming(fakeSocket, streamManager, "logcat");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		expect(() => {
			stream.emit("data", Buffer.from("line"));
			stream.emit("error", new Error("boom"));
			stream.emit("close");
		}).not.toThrow();
	});
});

describe("shell.startInteractive", () => {
	function createFakeStream() {
		const stream = new EventEmitter();
		stream.close = vi.fn();
		stream.write = vi.fn().mockResolvedValue(undefined);
		return stream;
	}

	test("opens shell:<command> and forwards data/close/error events to the callbacks", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };
		const onData = vi.fn();
		const onEnd = vi.fn();
		const onError = vi.fn();

		droidsock.shell.startInteractive(fakeSocket, streamManager, "sh", { onData, onEnd, onError });
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);
		expect(streamManager.openStream).toHaveBeenCalledWith("shell:sh");

		stream.emit("data", Buffer.from("$ ", "utf8"));
		expect(onData).toHaveBeenCalledWith("$ ");

		const error = new Error("broke");
		stream.emit("error", error);
		expect(onError).toHaveBeenCalledWith(error);

		stream.emit("close");
		expect(onEnd).toHaveBeenCalledOnce();
	});

	test("sendInput() writes to the stream once it has opened", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const control = droidsock.shell.startInteractive(fakeSocket, streamManager, "sh");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		await control.sendInput("ls\n");
		expect(stream.write).toHaveBeenCalledWith("ls\n");
	});

	test("sendInput() is a silent no-op before the stream has opened", async () => {
		const streamManager = { openStream: vi.fn(() => new Promise(() => {})) }; // never resolves
		const control = droidsock.shell.startInteractive(fakeSocket, streamManager, "sh");

		await expect(control.sendInput("ls\n")).resolves.toBeUndefined();
	});

	test("calls onError instead of throwing when openStream() itself rejects", async () => {
		const streamManager = { openStream: vi.fn().mockRejectedValue(new Error("device gone")) };
		const onError = vi.fn();

		droidsock.shell.startInteractive(fakeSocket, streamManager, "sh", { onError });
		await vi.waitUntil(() => onError.mock.calls.length > 0);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "device gone" }));
	});

	test("stop() closes the underlying stream once it has opened", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		const control = droidsock.shell.startInteractive(fakeSocket, streamManager, "sh");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		control.stop();
		expect(stream.close).toHaveBeenCalledOnce();
	});

	test("data/close/error events are silently dropped when no callbacks were given", async () => {
		const stream = createFakeStream();
		const streamManager = { openStream: vi.fn().mockResolvedValue(stream) };

		droidsock.shell.startInteractive(fakeSocket, streamManager, "sh");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		expect(() => {
			stream.emit("data", Buffer.from("$ "));
			stream.emit("error", new Error("boom"));
			stream.emit("close");
		}).not.toThrow();
	});
});

describe("shell.commands - shell-quote every user-controlled argument", () => {
	// Every shortcut calls this module's own execute() directly (not self.shell.execute), so
	// spying on the composed droidsock.shell.execute wouldn't intercept it - drive each one
	// through a real fake socket instead and read the destination straight off the OPEN packet
	// it actually sent, then resolve immediately with a CLSE. This proves the exact command
	// string reaching the device, without guessing anything about real device output.
	async function commandDestination(fn, ...args) {
		const socket = createFakeShellSocket();
		const resultPromise = fn(socket, {}, ...args);
		socket.emit("data", buildRawPacket(MSG_CLSE, 0, EXECUTE_LOCAL_ID));
		await resultPromise;
		return destinationOf(socket.writes[0]);
	}

	test("ls() quotes its path argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.ls, "/sdcard/it's a test`$(touch /tmp/pwned)`");
		expect(dest).toBe("shell:ls -la '/sdcard/it'\\''s a test`$(touch /tmp/pwned)`'");
	});

	test("ls() defaults to the current directory", async () => {
		expect(await commandDestination(droidsock.shell.commands.ls)).toBe("shell:ls -la '.'");
	});

	test("pwd() runs the bare command with no arguments to quote", async () => {
		expect(await commandDestination(droidsock.shell.commands.pwd)).toBe("shell:pwd");
	});

	test("getprop() quotes a given property name", async () => {
		const dest = await commandDestination(droidsock.shell.commands.getprop, "a; touch /tmp/pwned");
		expect(dest).toBe("shell:getprop 'a; touch /tmp/pwned'");
	});

	test("getprop() with no property name lists everything, unquoted", async () => {
		expect(await commandDestination(droidsock.shell.commands.getprop)).toBe("shell:getprop");
	});

	test("getModel() and getAndroidVersion() run fixed getprop commands", async () => {
		expect(await commandDestination(droidsock.shell.commands.getModel)).toBe("shell:getprop ro.product.model");
		expect(await commandDestination(droidsock.shell.commands.getAndroidVersion)).toBe("shell:getprop ro.build.version.release");
	});

	test("getBattery() runs a fixed dumpsys command", async () => {
		expect(await commandDestination(droidsock.shell.commands.getBattery)).toBe("shell:dumpsys battery");
	});

	test("screenshot() quotes its filename argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.screenshot, "/sdcard/$(touch /tmp/pwned).png");
		expect(dest).toBe("shell:screencap -p '/sdcard/$(touch /tmp/pwned).png'");
	});

	test("screenshot() defaults to /sdcard/screenshot.png", async () => {
		expect(await commandDestination(droidsock.shell.commands.screenshot)).toBe("shell:screencap -p '/sdcard/screenshot.png'");
	});

	test("keypress() quotes its key argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.keypress, "4; touch /tmp/pwned");
		expect(dest).toBe("shell:input keyevent '4; touch /tmp/pwned'");
	});

	test("launchApp() quotes package and activity as a single combined argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.launchApp, "com.example.app`x`", "Main;Activity");
		expect(dest).toBe("shell:am start -n 'com.example.app`x`/Main;Activity'");
	});

	test("launchApp() without an activity quotes just the package name", async () => {
		const dest = await commandDestination(droidsock.shell.commands.launchApp, "com.example.app; touch /tmp/pwned");
		expect(dest).toBe("shell:am start -n 'com.example.app; touch /tmp/pwned'");
	});

	test("killApp() quotes its package name argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.killApp, "com.example.app; touch /tmp/pwned");
		expect(dest).toBe("shell:am force-stop 'com.example.app; touch /tmp/pwned'");
	});

	test("installApk() quotes the apk path and every flag", async () => {
		const dest = await commandDestination(droidsock.shell.commands.installApk, "/sdcard/it's an app.apk", ["-r", "--user 0"]);
		expect(dest).toBe("shell:pm install '-r' '--user 0' '/sdcard/it'\\''s an app.apk'");
	});

	test("installApk() with no flags quotes just the apk path", async () => {
		expect(await commandDestination(droidsock.shell.commands.installApk, "/sdcard/app.apk")).toBe("shell:pm install '/sdcard/app.apk'");
	});

	test("uninstallApp() quotes its package name argument", async () => {
		const dest = await commandDestination(droidsock.shell.commands.uninstallApp, "com.example.app; touch /tmp/pwned");
		expect(dest).toBe("shell:pm uninstall 'com.example.app; touch /tmp/pwned'");
	});

	test("logcat() and top() delegate to startStreaming with the right fixed commands", async () => {
		const openStream = vi.fn(() => new Promise(() => {})); // never resolves - just capture the call
		const streamManager = { openStream };

		droidsock.shell.commands.logcat(fakeSocket, streamManager);
		droidsock.shell.commands.top(fakeSocket, streamManager);

		await vi.waitUntil(() => openStream.mock.calls.length >= 2);
		expect(openStream).toHaveBeenCalledWith("shell:logcat");
		expect(openStream).toHaveBeenCalledWith("shell:top -m 10");
	});
});
