/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/device-lifecycle.test.vitest.mjs
 *	@Date: 2026-10-08T19:00:00-07:00 (1791511200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-08T19:00:00-07:00 (1791511200)
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
 * Builds a raw 24-byte-header ADB packet, matching connection.mjs's own sendMessage().
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
 * A fake ADB server (see device.test.vitest.mjs) that can also drop every client, stop listening, and start
 * again on the same port, so a test can play out a device going away and coming back.
 * @param {Object} [options={}] - Options.
 * @param {(connectionNumber: number) => boolean} [options.rejectAuth] - Called with the 1-based connection count; when true, the client's AUTH reply is answered with another AUTH, which connection.mjs reports as "Authentication failed".
 * @returns {Object} Controls: `port`, `start()`, `stop()` (closes the listener and destroys every client), `dropClients()`, `openClients()`.
 */
function createFakeAdbServer({ rejectAuth = () => false } = {}) {
	const sockets = new Set();
	let connections = 0;
	let server = null;
	const control = {
		port: 0,
		start: () =>
			new Promise((resolve) => {
				server = net.createServer((socket) => {
					sockets.add(socket);
					const reject = rejectAuth(++connections);
					socket.on("close", () => sockets.delete(socket));
					socket.on("error", () => {});
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
								socket.write(reject ? buildPacket(MSG_AUTH, 1, 0, Buffer.alloc(20, 0x02)) : buildPacket(MSG_OKAY, 0, 0, Buffer.alloc(0)));
							}
						}
					});
				});
				server.listen(control.port, "127.0.0.1", () => {
					control.port = server.address().port;
					resolve(control);
				});
			}),
		openClients: () => sockets.size,
		dropClients: () => {
			for (const socket of sockets) socket.destroy();
		},
		stop: async () => {
			control.dropClients();
			if (server) await new Promise((resolve) => server.close(resolve));
			server = null;
		}
	};
	return control;
}

let fake;
let keyDir;
let droidsock;

afterEach(async () => {
	vi.restoreAllMocks();
	if (droidsock) {
		droidsock.devices.disconnect();
		if (droidsock.shutdown) await droidsock.shutdown();
		droidsock = null;
	}
	if (fake) {
		await fake.stop();
		fake = null;
	}
	if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

/**
 * Connects a fresh droidsock to a fresh fake server, recording every lifecycle event the device emits. The
 * recorder is attached right after connect() resolves, so `connecting`/`connected` for the first connect are
 * asserted separately (see "first connect").
 * @param {Object} [config] - Options.
 * @param {Object} [config.server] - Options for the fake server.
 * @param {Object} [config.connect] - Extra connect() options.
 * @param {Object} [config.droidsockConfig] - Config passed to createDroidSock().
 * @returns {Promise<{device: Object, events: Array<[string, Object]>}>} The device and its event log.
 */
async function setup({ server, connect, droidsockConfig } = {}) {
	fake = createFakeAdbServer(server);
	await fake.start();
	keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-lifecycle-test-"));
	droidsock = await createDroidSock(droidsockConfig ? { config: droidsockConfig } : undefined);
	const device = await droidsock.device.connect("127.0.0.1", fake.port, { keyDir, ...connect });
	const events = [];
	for (const name of ["connecting", "connected", "disconnected", "reconnecting", "reconnected", "error", "gave-up"]) {
		device.on(name, (detail) => events.push([name, detail]));
	}
	return { device, events };
}

const names = (events) => events.map(([name]) => name);
const fast = { initialDelay: 20, maxDelay: 60, jitter: 0 };

describe("device lifecycle events", () => {
	test("first connect emits connecting then connected, with the device identity in the payload", async () => {
		fake = createFakeAdbServer();
		await fake.start();
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-lifecycle-test-"));
		droidsock = await createDroidSock();
		const events = [];
		const original = droidsock.device.connect;
		const device = await (async () => {
			// Subscribe from inside connect() isn't possible (the leaf doesn't exist yet), so a second
			// connect() on a disconnected leaf is the observable "connect" phase.
			const first = await original("127.0.0.1", fake.port, { keyDir });
			first.disconnect();
			await vi.waitUntil(() => !first.isConnected());
			for (const name of ["connecting", "connected"]) first.on(name, (detail) => events.push([name, detail]));
			return await original("127.0.0.1", fake.port, { keyDir });
		})();
		expect(device.isConnected()).toBe(true);
		expect(names(events)).toEqual(["connecting", "connected"]);
		expect(events[1][1]).toMatchObject({ deviceId: `127.0.0.1:${fake.port}`, host: "127.0.0.1", port: fake.port, phase: "connect" });
	});

	test("on/once/off return the device for chaining, and off removes the listener", async () => {
		const { device } = await setup();
		const seen = [];
		const listener = () => seen.push("a");
		expect(device.on("disconnected", listener)).toBe(device);
		expect(device.off("disconnected", listener)).toBe(device);
		device.once("disconnected", () => seen.push("once"));
		device.disconnect();
		await vi.waitUntil(() => seen.length > 0);
		expect(seen).toEqual(["once"]);
	});

	test("an unexpected drop emits disconnected (intentional: false) and does not reconnect by default", async () => {
		const { device, events } = await setup();
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("disconnected"));
		expect(events.find(([n]) => n === "disconnected")[1]).toMatchObject({ intentional: false });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(names(events)).toEqual(["disconnected"]);
		expect(device.isConnected()).toBe(false);
	});

	test("disconnect() emits disconnected (intentional: true) and never reconnects, even with autoReconnect on", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: fast } });
		device.disconnect();
		await vi.waitUntil(() => names(events).includes("disconnected"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events.find(([n]) => n === "disconnected")[1]).toMatchObject({ intentional: true });
		expect(names(events)).toEqual(["disconnected"]);
	});

	test("a throwing listener is logged and does not break the lifecycle", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: fast } });
		device.on("disconnected", () => {
			throw new Error("listener boom");
		});
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("reconnected"));
		expect(device.isConnected()).toBe(true);
	});

	test("emitEvents: false silences every lifecycle event", async () => {
		const { device, events } = await setup({ droidsockConfig: { emitEvents: false } });
		fake.dropClients();
		await vi.waitUntil(() => !device.isConnected());
		expect(events).toEqual([]);
	});
});

describe("device auto-reconnect", () => {
	test("reconnects after a drop: disconnected, reconnecting (attempt 1), connecting, connected, reconnected", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: fast } });
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("reconnected"));
		expect(names(events)).toEqual(["disconnected", "reconnecting", "connecting", "connected", "reconnected"]);
		expect(events[1][1]).toMatchObject({ attempt: 1, delay: 20 });
		expect(events[2][1]).toMatchObject({ phase: "reconnect" });
		expect(device.isConnected()).toBe(true);
	});

	test("backs off exponentially up to maxDelay while the device stays unreachable, then recovers", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: fast } });
		await fake.stop();
		await vi.waitUntil(() => events.filter(([n]) => n === "reconnecting").length >= 4, { timeout: 3000 });
		const delays = events.filter(([n]) => n === "reconnecting").map(([, d]) => d.delay);
		expect(delays.slice(0, 4)).toEqual([20, 40, 60, 60]);
		expect(events.filter(([n]) => n === "error").length).toBeGreaterThanOrEqual(3);

		await fake.start();
		await vi.waitUntil(() => names(events).includes("reconnected"), { timeout: 3000 });
		expect(device.isConnected()).toBe(true);
	});

	test("emits gave-up after maxAttempts failed attempts and stops retrying", async () => {
		const { events } = await setup({ connect: { autoReconnect: { ...fast, maxAttempts: 2 } } });
		await fake.stop();
		await vi.waitUntil(() => names(events).includes("gave-up"), { timeout: 3000 });
		const gaveUp = events.find(([n]) => n === "gave-up")[1];
		expect(gaveUp).toMatchObject({ reason: "max-attempts", attempts: 2 });
		const count = events.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(events.length).toBe(count);
	});

	test("stops with gave-up (reason: auth) when the device rejects authentication, without retrying", async () => {
		const { events } = await setup({ server: { rejectAuth: (n) => n > 1 }, connect: { autoReconnect: fast } });
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("gave-up"), { timeout: 3000 });
		expect(events.find(([n]) => n === "gave-up")[1]).toMatchObject({ reason: "auth", attempts: 1 });
		// The rejected handshake's socket is closed, not leaked.
		await vi.waitUntil(() => fake.openClients() === 0);
		const count = events.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(events.length).toBe(count);
	});

	test("a disconnect() while a retry is pending cancels it", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: { ...fast, initialDelay: 200, maxDelay: 200 } } });
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("reconnecting"));
		device.disconnect();
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(names(events)).toEqual(["disconnected", "reconnecting"]);
		expect(device.isConnected()).toBe(false);
	});

	test("an explicit reconnect() wins over a pending automatic attempt", async () => {
		const { device, events } = await setup({ connect: { autoReconnect: { ...fast, initialDelay: 300, maxDelay: 300 } } });
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("reconnecting"));
		await device.reconnect();
		expect(device.isConnected()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(names(events)).not.toContain("reconnected");
		expect(events.filter(([n]) => n === "connected")).toHaveLength(1);
	});

	test("autoReconnect: true uses the defaults (retryDelay config as the first delay)", async () => {
		const { events } = await setup({ connect: { autoReconnect: true }, droidsockConfig: { retryDelay: 25 } });
		fake.dropClients();
		await vi.waitUntil(() => names(events).includes("reconnecting"));
		const delay = events.find(([n]) => n === "reconnecting")[1].delay;
		expect(delay).toBeGreaterThanOrEqual(20); // 25ms +/- 20% jitter
		expect(delay).toBeLessThanOrEqual(30);
	});
});

describe("device keepalive", () => {
	test("enables TCP keepalive with the keepAliveInterval config on the connection socket", async () => {
		const spy = vi.spyOn(net.Socket.prototype, "setKeepAlive");
		await setup({ droidsockConfig: { keepAlive: true, keepAliveInterval: 12345 } });
		expect(spy).toHaveBeenCalledWith(true, 12345);
	});

	test("leaves keepalive alone when keepAlive is false", async () => {
		const spy = vi.spyOn(net.Socket.prototype, "setKeepAlive");
		await setup({ droidsockConfig: { keepAlive: false } });
		expect(spy).not.toHaveBeenCalled();
	});
});
