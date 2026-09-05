/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/device.test.vitest.mjs
 *	@Date: 2026-09-05 00:00:00 -07:00 (1788505200)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-05 00:00:00 -07:00 (1788505200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import createDroidSock from "../index.mjs";

const MSG_CNXN = 0x4e584e43;
const MSG_AUTH = 0x48545541;
const MSG_OKAY = 0x59414b4f;

/**
 * Builds a raw 24-byte-header ADB packet, matching connection.mjs's own
 * sendMessage(), for driving the fake ADB server below.
 * @param {number} command - Message command.
 * @param {number} arg0 - First argument.
 * @param {number} arg1 - Second argument.
 * @param {Buffer} data - Message data.
 * @returns {Buffer} The framed packet.
 */
function buildPacket(command, arg0, arg1, data) {
	const header = Buffer.alloc(24);
	header.writeUInt32LE(command, 0);
	header.writeUInt32LE(arg0, 4);
	header.writeUInt32LE(arg1, 8);
	header.writeUInt32LE(data.length, 12);
	let checksum = 0;
	for (const byte of data) checksum += byte;
	header.writeUInt32LE(checksum >>> 0, 16);
	header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
	return Buffer.concat([header, data]);
}

/**
 * A minimal fake ADB server - see connection.test.vitest.mjs for the full rationale. Captures
 * the client's CNXN, replies AUTH(TOKEN), then OKAY on the client's first AUTH reply, completing
 * the handshake without validating the signature at all.
 * @returns {Promise<{port: number, server: net.Server}>} The listening fake server.
 */
function createFakeAdbServer() {
	return new Promise((resolve) => {
		const server = net.createServer((socket) => {
			let buffer = Buffer.alloc(0);
			let awaitingReply = false;
			socket.on("data", (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				while (buffer.length >= 24) {
					const dataLength = buffer.readUInt32LE(12);
					if (buffer.length < 24 + dataLength) break;
					const command = buffer.readUInt32LE(0);
					buffer = buffer.subarray(24 + dataLength);

					if (command === MSG_CNXN) {
						socket.write(buildPacket(MSG_AUTH, 1, 0, Buffer.alloc(20, 0x01)));
					} else if (command === MSG_AUTH && !awaitingReply) {
						awaitingReply = true;
						socket.write(buildPacket(MSG_OKAY, 0, 0, Buffer.alloc(0)));
					}
				}
			});
		});
		server.listen(0, "127.0.0.1", () => {
			resolve({ port: server.address().port, server });
		});
	});
}

let fakeServer;
let keyDir;
let droidsock;

afterEach(async () => {
	if (droidsock) {
		// A net.Server's close() callback only fires once every existing
		// connection has ended - a device left connected (as most tests here
		// leave it, since disconnecting isn't what they're testing) would
		// otherwise hang fakeServer.server.close() below until the hook
		// timeout. Disconnecting every device first guarantees the fake
		// server has nothing left open to wait on. Synchronous now - there's
		// no api-tree work left in disconnect() to await.
		droidsock.devices.disconnect();
		if (droidsock.shutdown) await droidsock.shutdown();
	}
	if (fakeServer) {
		await new Promise((resolve) => fakeServer.server.close(resolve));
		fakeServer = null;
	}
	if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

/**
 * Connects a fresh droidsock instance to a fresh fake ADB server, returning both the device
 * leaf and the droidsock instance so tests can spy on its composed modules.
 * @returns {Promise<{device: Object, droidsock: Object}>} The connected leaf and its instance.
 */
async function connectDevice() {
	fakeServer = await createFakeAdbServer();
	keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-device-test-"));
	droidsock = await createDroidSock();
	const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
	return { device, droidsock };
}

describe("devices leaf - assertReady() guards every method", () => {
	test("throws 'Device not connected' once the underlying socket is gone", async () => {
		const { device } = await connectDevice();
		device.connection.socket.destroy();
		await vi.waitUntil(() => device.isConnected() === false);

		await expect(device.push("/local", "/remote")).rejects.toThrow("Device not connected");
	});

	test("throws 'Device not authorized' when the socket is alive but the handshake never authorized", async () => {
		const { device } = await connectDevice();
		expect(device.isConnected()).toBe(true);
		device.connection.authorized = false;

		await expect(device.pull("/remote", "/local")).rejects.toThrow("Device not authorized. Please accept authorization dialog.");
	});
});

describe("devices leaf - thin delegation to the composed protocol modules", () => {
	test("push()/pull()/pushV2()/pullV2() delegate to files.* with (socket, streamManager, ...args)", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const pushSpy = vi.spyOn(instance.files, "push").mockResolvedValue("push-ok");
		const pullSpy = vi.spyOn(instance.files, "pull").mockResolvedValue("pull-ok");
		const pushV2Spy = vi.spyOn(instance.files, "pushV2").mockResolvedValue("pushV2-ok");
		const pullV2Spy = vi.spyOn(instance.files, "pullV2").mockResolvedValue("pullV2-ok");

		await expect(device.push("/local", "/remote", { onProgress: null })).resolves.toBe("push-ok");
		expect(pushSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/local", "/remote", { onProgress: null });

		await expect(device.pull("/remote", "/local", { compression: "brotli" })).resolves.toBe("pull-ok");
		expect(pullSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/remote", "/local", { compression: "brotli" });

		await expect(device.pushV2("/local", "/remote")).resolves.toBe("pushV2-ok");
		expect(pushV2Spy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/local", "/remote", {});

		await expect(device.pullV2("/remote", "/local")).resolves.toBe("pullV2-ok");
		expect(pullV2Spy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/remote", "/local", {});
	});

	test("list()/stat()/listV2()/statV2() delegate to files.* with (socket, streamManager, remotePath)", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const listSpy = vi.spyOn(instance.files, "list").mockResolvedValue(["a"]);
		const statSpy = vi.spyOn(instance.files, "stat").mockResolvedValue("stat-ok");
		const listV2Spy = vi.spyOn(instance.files, "listV2").mockResolvedValue(["b"]);
		const statV2Spy = vi.spyOn(instance.files, "statV2").mockResolvedValue("statV2-ok");

		await expect(device.list("/sdcard")).resolves.toEqual(["a"]);
		expect(listSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/sdcard");

		await expect(device.stat("/sdcard/f")).resolves.toBe("stat-ok");
		expect(statSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/sdcard/f");

		await expect(device.listV2("/sdcard")).resolves.toEqual(["b"]);
		expect(listV2Spy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/sdcard");

		await expect(device.statV2("/sdcard/f")).resolves.toBe("statV2-ok");
		expect(statV2Spy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/sdcard/f");
	});

	test("reboot() delegates to reboot.execute with (socket, streamManager, mode)", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const rebootSpy = vi.spyOn(instance.reboot, "execute").mockResolvedValue(undefined);

		await device.reboot("recovery");
		expect(rebootSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "recovery");
	});

	test("rebootBootloader()/rebootRecovery()/rebootSideload() call reboot() with the right fixed mode", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const rebootSpy = vi.spyOn(instance.reboot, "execute").mockResolvedValue(undefined);

		await device.rebootBootloader();
		expect(rebootSpy).toHaveBeenLastCalledWith(device.connection.socket, device.streamManager, "bootloader");

		await device.rebootRecovery();
		expect(rebootSpy).toHaveBeenLastCalledWith(device.connection.socket, device.streamManager, "recovery");

		await device.rebootSideload();
		expect(rebootSpy).toHaveBeenLastCalledWith(device.connection.socket, device.streamManager, "sideload");
	});

	test("forward()/reverse() delegate to forward.start/reverse.start with (socket, streamManager, ...args)", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const forwardSpy = vi.spyOn(instance.forward, "start").mockResolvedValue({ localPort: 9000, close: () => {} });
		const reverseSpy = vi.spyOn(instance.reverse, "start").mockResolvedValue({ close: () => {} });

		await device.forward(5555, { localPort: 9000 });
		expect(forwardSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, 5555, { localPort: 9000 });

		await device.reverse(6000, 7000);
		expect(reverseSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, 6000, 7000, {});
	});

	test("startStreamingShell()/startInteractiveShell() delegate to shell.startStreaming/startInteractive", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const control = { stop: () => {} };
		const streamingSpy = vi.spyOn(instance.shell, "startStreaming").mockReturnValue(control);
		const interactiveSpy = vi.spyOn(instance.shell, "startInteractive").mockReturnValue(control);

		expect(device.startStreamingShell("logcat", { onData: null })).toBe(control);
		expect(streamingSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "logcat", { onData: null });

		expect(device.startInteractiveShell("sh")).toBe(control);
		expect(interactiveSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "sh", {});
	});

	test("logcat()/top() convenience shortcuts delegate to startStreamingShell with the right fixed command", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const control = { stop: () => {} };
		const streamingSpy = vi.spyOn(instance.shell, "startStreaming").mockReturnValue(control);

		expect(device.logcat()).toBe(control);
		expect(streamingSpy).toHaveBeenLastCalledWith(device.connection.socket, device.streamManager, "logcat", {});

		expect(device.top()).toBe(control);
		expect(streamingSpy).toHaveBeenLastCalledWith(device.connection.socket, device.streamManager, "top -m 10", {});
	});

	test("shell() passes the device's own advertised features through to shell.execute", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const executeSpy = vi.spyOn(instance.shell, "execute").mockResolvedValue("output");
		device.connection.deviceFeatures = ["shell_v2"];

		await expect(device.shell("ls", { timeout: 500 })).resolves.toBe("output");
		expect(executeSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "ls", {
			timeout: 500,
			deviceFeatures: ["shell_v2"]
		});
	});

	test("install() goes straight to the classic flow when the device doesn't advertise the cmd feature", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const streamingSpy = vi.spyOn(instance.install, "streaming");
		const classicSpy = vi.spyOn(instance.install, "classic").mockResolvedValue("Success\n");
		// deviceFeatures deliberately left without "cmd" - the fake handshake doesn't advertise it.

		await expect(device.install("/local/app.apk")).resolves.toBe("Success\n");
		expect(streamingSpy).not.toHaveBeenCalled();
		expect(classicSpy).toHaveBeenCalledWith(device.connection.socket, device.streamManager, "/local/app.apk", {});
	});
});

describe("device.connect() - reuse and reconnect", () => {
	test("returns the exact same leaf on a second connect() call while still connected", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const second = await instance.device.connect("127.0.0.1", fakeServer.port, { keyDir });
		expect(second).toBe(device);
	});

	test("reconnects the SAME leaf in place when the socket died without disconnect() - no new object, no re-mount", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const oldSocket = device.connection.socket;
		device.connection.socket.destroy();
		await vi.waitUntil(() => device.isConnected() === false);

		const reconnected = await instance.device.connect("127.0.0.1", fakeServer.port, { keyDir });
		expect(reconnected).toBe(device);
		expect(reconnected.isConnected()).toBe(true);
		expect(reconnected.connection.socket).not.toBe(oldSocket);
	});

	test("reconnects a cleanly disconnect()'d device with no options re-supplied, reusing the remembered keyDir", async () => {
		const { device, droidsock: instance } = await connectDevice();
		instance.device.disconnect("127.0.0.1", fakeServer.port);
		expect(device.isConnected()).toBe(false);

		// No options argument at all - connect() must fall back to what this
		// leaf was created with (leaf.options), not require the caller to
		// remember and re-supply keyDir.
		const reconnected = await instance.device.connect("127.0.0.1", fakeServer.port);
		expect(reconnected).toBe(device);
		expect(reconnected.isConnected()).toBe(true);
	});
});

describe("device.disconnect(host, port) - single-target disconnect", () => {
	test("returns false when no matching device is connected", async () => {
		droidsock = await createDroidSock();
		expect(droidsock.device.disconnect("10.0.0.1", 5555)).toBe(false);
	});

	test("disconnects a matching device, keeps its leaf mounted (reconnectable), and returns true", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const socket = device.connection.socket;
		expect(instance.device.disconnect("127.0.0.1", fakeServer.port)).toBe(true);

		expect(socket.destroyed).toBe(true);
		expect(device.isConnected()).toBe(false);
		// list() only shows connected devices, but the leaf itself is still
		// mounted and reconnectable - disconnect() is not remove().
		expect(instance.devices.list()).toEqual([]);
		expect(instance.devices.get(device)).toBe(device);
	});
});

describe("device.remove(host, port) - forgets a specific device", () => {
	test("returns false when no matching device exists", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.device.remove("10.0.0.1", 5555)).resolves.toBe(false);
	});

	test("disconnects (if needed) and unmounts the leaf, unlike disconnect()", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const socket = device.connection.socket;

		await expect(instance.device.remove("127.0.0.1", fakeServer.port)).resolves.toBe(true);

		expect(socket.destroyed).toBe(true);
		expect(instance.devices.get(device)).toBeUndefined();
	});
});
