/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/device.test.vitest.mjs
 *	@Date: 2026-09-05T00:00:00-07:00 (1788591600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T15:29:46-07:00 (1790980186)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
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
 * the client's CNXN, replies AUTH(TOKEN), then completes the handshake on the client's first AUTH
 * reply without validating the signature at all: with OKAY by default, or - when `features` is
 * given - with a CNXN banner advertising them, the way a real device answers a successful AUTH
 * (connection.mjs parses `features=` out of that banner into connection.deviceFeatures).
 * @param {Object} [options={}] - Options.
 * @param {string[]} [options.features] - Features to advertise in a CNXN reply instead of OKAY.
 * @returns {Promise<{port: number, server: net.Server}>} The listening fake server.
 */
function createFakeAdbServer({ features } = {}) {
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
						socket.write(
							features
								? buildPacket(MSG_CNXN, 0x01000001, 256 * 1024, Buffer.from(`device::features=${features.join(",")}`))
								: buildPacket(MSG_OKAY, 0, 0, Buffer.alloc(0))
						);
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
 * Connects a fresh droidsock instance to a fresh fake ADB server, returning the device leaf, the
 * droidsock instance (so tests can spy on its composed modules), and the device's real session -
 * the socket and stream manager connection.create()/stream.create() actually returned, which is
 * what the leaf passes to every protocol module. `device.connection.socket`/`device.streamManager`
 * can't stand in for those: they're read back through slothlet's wrap-on-set mirror
 * (self.devices[key].connection = ...), which since slothlet 3.15.3 hands back a live Proxy view
 * of each object rather than the object itself, so they are never the same reference.
 * @param {Object} [options={}] - Options.
 * @param {string[]} [options.features] - Features the fake device advertises during the handshake.
 * @returns {Promise<{device: Object, droidsock: Object, session: {socket: Object, streamManager: Object}}>} The connected leaf, its instance, and its real session.
 */
async function connectDevice({ features } = {}) {
	fakeServer = await createFakeAdbServer({ features });
	keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-device-test-"));
	droidsock = await createDroidSock();
	const connectionCreateSpy = vi.spyOn(droidsock.connection, "create");
	const streamCreateSpy = vi.spyOn(droidsock.stream, "create");
	const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
	const session = {
		socket: (await connectionCreateSpy.mock.results[0].value).socket,
		streamManager: await streamCreateSpy.mock.results[0].value
	};
	connectionCreateSpy.mockRestore();
	streamCreateSpy.mockRestore();
	return { device, droidsock, session };
}

describe("device leaf - assertReady() guards every method", () => {
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

describe("device leaf - thin delegation to the composed protocol modules", () => {
	test("push()/pull()/pushV2()/pullV2() delegate to files.* with (socket, streamManager, ...args)", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const pushSpy = vi.spyOn(instance.files, "push").mockResolvedValue("push-ok");
		const pullSpy = vi.spyOn(instance.files, "pull").mockResolvedValue("pull-ok");
		const pushV2Spy = vi.spyOn(instance.files, "pushV2").mockResolvedValue("pushV2-ok");
		const pullV2Spy = vi.spyOn(instance.files, "pullV2").mockResolvedValue("pullV2-ok");

		await expect(device.push("/local", "/remote", { onProgress: null })).resolves.toBe("push-ok");
		expect(pushSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "/local", "/remote", { onProgress: null });

		await expect(device.pull("/remote", "/local", { compression: "brotli" })).resolves.toBe("pull-ok");
		expect(pullSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "/remote", "/local", { compression: "brotli" });

		await expect(device.pushV2("/local", "/remote")).resolves.toBe("pushV2-ok");
		expect(pushV2Spy).toHaveBeenCalledWith(session.socket, session.streamManager, "/local", "/remote", {});

		await expect(device.pullV2("/remote", "/local")).resolves.toBe("pullV2-ok");
		expect(pullV2Spy).toHaveBeenCalledWith(session.socket, session.streamManager, "/remote", "/local", {});
	});

	test("list()/stat()/listV2()/statV2() delegate to files.* with (socket, streamManager, remotePath)", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const listSpy = vi.spyOn(instance.files, "list").mockResolvedValue(["a"]);
		const statSpy = vi.spyOn(instance.files, "stat").mockResolvedValue("stat-ok");
		const listV2Spy = vi.spyOn(instance.files, "listV2").mockResolvedValue(["b"]);
		const statV2Spy = vi.spyOn(instance.files, "statV2").mockResolvedValue("statV2-ok");

		await expect(device.list("/sdcard")).resolves.toEqual(["a"]);
		expect(listSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "/sdcard");

		await expect(device.stat("/sdcard/f")).resolves.toBe("stat-ok");
		expect(statSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "/sdcard/f");

		await expect(device.listV2("/sdcard")).resolves.toEqual(["b"]);
		expect(listV2Spy).toHaveBeenCalledWith(session.socket, session.streamManager, "/sdcard");

		await expect(device.statV2("/sdcard/f")).resolves.toBe("statV2-ok");
		expect(statV2Spy).toHaveBeenCalledWith(session.socket, session.streamManager, "/sdcard/f");
	});

	test("reboot() delegates to reboot.execute with (socket, streamManager, mode)", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const rebootSpy = vi.spyOn(instance.reboot, "execute").mockResolvedValue(undefined);

		await device.reboot("recovery");
		expect(rebootSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "recovery");
	});

	test("rebootBootloader()/rebootRecovery()/rebootSideload() call reboot() with the right fixed mode", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const rebootSpy = vi.spyOn(instance.reboot, "execute").mockResolvedValue(undefined);

		await device.rebootBootloader();
		expect(rebootSpy).toHaveBeenLastCalledWith(session.socket, session.streamManager, "bootloader");

		await device.rebootRecovery();
		expect(rebootSpy).toHaveBeenLastCalledWith(session.socket, session.streamManager, "recovery");

		await device.rebootSideload();
		expect(rebootSpy).toHaveBeenLastCalledWith(session.socket, session.streamManager, "sideload");
	});

	test("forward()/reverse() delegate to forward.start/reverse.start with (socket, streamManager, ...args)", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const forwardSpy = vi.spyOn(instance.forward, "start").mockResolvedValue({ localPort: 9000, close: () => {} });
		const reverseSpy = vi.spyOn(instance.reverse, "start").mockResolvedValue({ close: () => {} });

		await device.forward(5555, { localPort: 9000 });
		expect(forwardSpy).toHaveBeenCalledWith(session.socket, session.streamManager, 5555, { localPort: 9000 });

		await device.reverse(6000, 7000);
		expect(reverseSpy).toHaveBeenCalledWith(session.socket, session.streamManager, 6000, 7000, {});
	});

	test("startStreamingShell()/startInteractiveShell() delegate to shell.startStreaming/startInteractive", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const control = { stop: () => {} };
		const streamingSpy = vi.spyOn(instance.shell, "startStreaming").mockReturnValue(control);
		const interactiveSpy = vi.spyOn(instance.shell, "startInteractive").mockReturnValue(control);

		expect(device.startStreamingShell("logcat", { onData: null })).toBe(control);
		expect(streamingSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "logcat", { onData: null });

		expect(device.startInteractiveShell("sh")).toBe(control);
		expect(interactiveSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "sh", {});
	});

	test("logcat()/top() convenience shortcuts delegate to startStreamingShell with the right fixed command", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const control = { stop: () => {} };
		const streamingSpy = vi.spyOn(instance.shell, "startStreaming").mockReturnValue(control);

		expect(device.logcat()).toBe(control);
		expect(streamingSpy).toHaveBeenLastCalledWith(session.socket, session.streamManager, "logcat", {});

		expect(device.top()).toBe(control);
		expect(streamingSpy).toHaveBeenLastCalledWith(session.socket, session.streamManager, "top -m 10", {});
	});

	test("shell() passes the device's own advertised features through to shell.execute", async () => {
		const { device, droidsock: instance, session } = await connectDevice({ features: ["shell_v2"] });
		const executeSpy = vi.spyOn(instance.shell, "execute").mockResolvedValue("output");

		await expect(device.shell("ls", { timeout: 500 })).resolves.toBe("output");
		expect(executeSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "ls", {
			timeout: 500,
			deviceFeatures: ["shell_v2"]
		});
	});

	test("install() goes straight to the classic flow when the device doesn't advertise the cmd feature", async () => {
		const { device, droidsock: instance, session } = await connectDevice();
		const streamingSpy = vi.spyOn(instance.install, "streaming");
		const classicSpy = vi.spyOn(instance.install, "classic").mockResolvedValue("Success\n");
		// deviceFeatures deliberately left without "cmd" - the fake handshake doesn't advertise it.

		await expect(device.install("/local/app.apk")).resolves.toBe("Success\n");
		expect(streamingSpy).not.toHaveBeenCalled();
		expect(classicSpy).toHaveBeenCalledWith(session.socket, session.streamManager, "/local/app.apk", {});
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

	test("options passed while already connected are still remembered for a LATER reconnect, not silently discarded", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const secondKeyDir = mkdtempSync(path.join(tmpdir(), "droidsock-device-test-2-"));
		try {
			// Already connected - connect() short-circuits without opening a new
			// session, but the new keyDir must still be remembered for later.
			const stillSame = await instance.device.connect("127.0.0.1", fakeServer.port, { keyDir: secondKeyDir });
			expect(stillSame).toBe(device);

			instance.device.disconnect("127.0.0.1", fakeServer.port);
			const getKeysSpy = vi.spyOn(instance.auth, "getKeys");
			await instance.device.connect("127.0.0.1", fakeServer.port);
			expect(getKeysSpy).toHaveBeenCalledWith(secondKeyDir);
		} finally {
			rmSync(secondKeyDir, { recursive: true, force: true });
		}
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
