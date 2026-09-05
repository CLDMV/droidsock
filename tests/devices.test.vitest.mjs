/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/devices.test.vitest.mjs
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
		// See device.test.vitest.mjs for why every device is disconnected before
		// closing the fake server (net.Server.close()'s callback waits for every
		// open connection to end). Synchronous now - there's no api-tree work
		// left in disconnect() to await.
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
 * leaf and the droidsock instance so tests can exercise the collection-wide functions.
 * @returns {Promise<{device: Object, droidsock: Object}>} The connected leaf and its instance.
 */
async function connectDevice() {
	fakeServer = await createFakeAdbServer();
	keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-devices-test-"));
	droidsock = await createDroidSock();
	const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
	return { device, droidsock };
}

describe("devices.list()", () => {
	test("only returns currently-connected devices, excluding a stale one", async () => {
		const { device, droidsock: instance } = await connectDevice();
		expect(instance.devices.list()).toEqual([device]);

		device.connection.socket.destroy();
		await vi.waitUntil(() => device.isConnected() === false);
		expect(instance.devices.list()).toEqual([]);
	});
});

describe("devices.disconnect() - collection-wide, zero-arg only, synchronous", () => {
	test("disconnects every connected device, keeps every leaf mounted, and returns the count", async () => {
		const { droidsock: instance } = await connectDevice();
		const secondServer = await createFakeAdbServer();
		try {
			const second = await instance.device.connect("127.0.0.1", secondServer.port, { keyDir });
			expect(instance.devices.list()).toHaveLength(2);

			expect(instance.devices.disconnect()).toBe(2);
			expect(instance.devices.list()).toHaveLength(0);
			// disconnect() (all) is not remove() (all) - both leaves stay mounted.
			expect(instance.devices.get(second)).toBe(second);
		} finally {
			await new Promise((resolve) => secondServer.server.close(resolve));
		}
	});

	test("throws synchronously on any argument rather than silently disconnecting everything - the mix-up with device.disconnect(host, port) it exists to catch", async () => {
		droidsock = await createDroidSock();
		expect(() => droidsock.devices.disconnect("127.0.0.1", 5555)).toThrow(
			"devices.disconnect() takes no arguments - it disconnects ALL devices. Use device.disconnect(host, port) for one."
		);
	});
});

describe("devices.remove() - collection-wide, zero-arg only, async", () => {
	test("disconnects and unmounts every device, returning the count", async () => {
		const { device, droidsock: instance } = await connectDevice();
		const secondServer = await createFakeAdbServer();
		try {
			const second = await instance.device.connect("127.0.0.1", secondServer.port, { keyDir });
			expect(instance.devices.list()).toHaveLength(2);

			await expect(instance.devices.remove()).resolves.toBe(2);
			expect(instance.devices.get(device)).toBeUndefined();
			expect(instance.devices.get(second)).toBeUndefined();
		} finally {
			await new Promise((resolve) => secondServer.server.close(resolve));
		}
	});

	test("rejects any argument rather than silently removing everything - the mix-up with device.remove(host, port) it exists to catch", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.devices.remove("127.0.0.1", 5555)).rejects.toThrow(
			"devices.remove() takes no arguments - it removes ALL devices. Use device.remove(host, port) for one."
		);
	});
});

describe("devices.get(idOrLeaf)", () => {
	test("looks up a connected leaf by 'host:port' string", async () => {
		const { device, droidsock: instance } = await connectDevice();
		expect(instance.devices.get(`127.0.0.1:${fakeServer.port}`)).toBe(device);
	});

	test("looks up a connected leaf by the leaf object itself (idempotent pass-through)", async () => {
		const { device, droidsock: instance } = await connectDevice();
		expect(instance.devices.get(device)).toBe(device);
	});

	test("returns undefined for a host:port with nothing mounted", async () => {
		droidsock = await createDroidSock();
		expect(droidsock.devices.get("10.0.0.1:5555")).toBeUndefined();
	});

	test("accepts a bracketed IPv6 host:port string", async () => {
		droidsock = await createDroidSock();
		// No device connected at this address - just proving the bracket
		// notation parses through to a lookup instead of throwing.
		expect(droidsock.devices.get("[2001:db8::1]:5555")).toBeUndefined();
	});

	test("still returns the SAME leaf after disconnect() - it's not unmounted, only remove() unmounts it", async () => {
		const { device, droidsock: instance } = await connectDevice();
		device.disconnect();
		expect(instance.devices.get(device)).toBe(device);
	});

	test("returns undefined once the device has actually been removed", async () => {
		const { device, droidsock: instance } = await connectDevice();
		await device.remove();
		expect(instance.devices.get(device)).toBeUndefined();
	});
});
