/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/reverse.test.vitest.mjs
 *	@Date: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import createDroidSock from "../index.mjs";

// reverse.mjs's device-facing side (registering/unregistering the tunnel) is
// tested against a fully fake stream manager, matching forward.test.vitest.mjs's
// approach - openStream() resolves to a fake ADB stream the test drives by
// hand. Its local-facing side (bridging a device-initiated connection to a
// real local TCP target) uses a real net.createServer, since that's the real
// thing reverse.mjs actually opens a socket to.
let droidsock;
const fakeSocket = {};

/**
 * Waits for one event from an emitter and resolves with its first argument.
 * @param {EventEmitter} emitter - The emitter to listen on.
 * @param {string} event - Event name.
 * @returns {Promise<*>} The event's first argument.
 */
function onceEvent(emitter, event) {
	const promise = new Promise((resolve) => emitter.once(event, (arg) => resolve(arg)));
	if (event === "data" && typeof emitter.resume === "function") {
		emitter.resume();
	}
	return promise;
}

/**
 * Creates a fake ADB stream (matching stream.mjs's AdbStream interface) whose
 * write() resolves a deferred `nextWrite()` promise per call.
 * @returns {EventEmitter & {write: Function, close: Function, closed: boolean, writes: Buffer[], nextWrite: () => Promise<Buffer>}} The fake stream.
 */
function createFakeAdbStream() {
	const stream = new EventEmitter();
	stream.writes = [];
	stream.closed = false;
	let resolvers = [];
	stream.write = async (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		stream.writes.push(buf);
		const pending = resolvers;
		resolvers = [];
		pending.forEach((resolve) => resolve(buf));
	};
	stream.close = vi.fn(() => {
		stream.closed = true;
		stream.emit("close");
	});
	stream.nextWrite = () => new Promise((resolve) => resolvers.push(resolve));
	return stream;
}

/**
 * Creates a fake stream manager: openStream() resolves a fresh fake ADB
 * stream per call (captured in order in `openedStreams`, with the
 * destination each was opened for in `openedDestinations`), and on/off/emit
 * proxy a real EventEmitter for the "remoteOpen" pub/sub reverse.mjs uses.
 * @returns {Object} The fake stream manager.
 */
function createFakeStreamManager() {
	const emitter = new EventEmitter();
	const openedStreams = [];
	const openedDestinations = [];
	return {
		openedStreams,
		openedDestinations,
		on: (...args) => emitter.on(...args),
		off: (...args) => emitter.off(...args),
		emit: (...args) => emitter.emit(...args),
		openStream: vi.fn((destination) => {
			openedDestinations.push(destination);
			const stream = createFakeAdbStream();
			openedStreams.push(stream);
			return Promise.resolve(stream);
		})
	};
}

beforeEach(async () => {
	droidsock = await createDroidSock();
});

afterEach(async () => {
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("reverse.start", () => {
	test("registers the tunnel via reverse:forward:tcp:<devicePort>;tcp:<hostPort> and resolves once acked", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);

		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		expect(streamManager.openedDestinations[0]).toBe("reverse:forward:tcp:7000;tcp:8000");
		streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));

		const handle = await startPromise;
		expect(handle.devicePort).toBe(7000);
		expect(handle.hostPort).toBe(8000);
		expect(streamManager.openedStreams[0].close).toHaveBeenCalled();
	});

	test("rejects with the device's message when registration is acked FAIL", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);

		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		streamManager.openedStreams[0].emit("data", Buffer.from("FAIL0009not found"));

		await expect(startPromise).rejects.toThrow(/not found/);
	});

	test("bridges a device-initiated connection tagged for this mapping's hostPort to a real local TCP target", async () => {
		let acceptedSocket;
		const target = net.createServer((socket) => {
			acceptedSocket = socket;
			socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
		});
		await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
		const hostPort = target.address().port;

		try {
			const streamManager = createFakeStreamManager();
			const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, hostPort);
			await vi.waitUntil(() => streamManager.openedStreams.length > 0);
			streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));
			await startPromise;

			// reverse.mjs only wires deviceStream.on("data", ...) up once the real
			// local TCP connect() completes, inside its "connect" callback - wait
			// for that listener attachment ("newListener" fires synchronously the
			// moment it's registered) before emitting, or the emit is dropped with
			// no listener yet attached.
			const deviceStream = createFakeAdbStream();
			const localListenerAttached = onceEvent(deviceStream, "newListener");
			streamManager.emit("remoteOpen", deviceStream, `tcp:${hostPort}`);
			await localListenerAttached;

			const written = deviceStream.nextWrite();
			deviceStream.emit("data", Buffer.from("hello-from-device"));
			expect((await written).toString()).toBe("echo:hello-from-device");

			// Tear down the bridged connection before closing the server -
			// server.close()'s callback only fires once every accepted
			// connection has ended, and nothing else here would end this one.
			deviceStream.close();
			await onceEvent(acceptedSocket, "close");
		} finally {
			await new Promise((resolve) => target.close(resolve));
		}
	});

	test("ignores a remoteOpen tagged for a different hostPort - another reverse() call owns it", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);
		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));
		await startPromise;

		const deviceStream = createFakeAdbStream();
		streamManager.emit("remoteOpen", deviceStream, "tcp:9999");

		// Nothing should happen - specifically, deviceStream.close() (which the
		// bridging path calls on a local connection failure) is never invoked
		// because reverse.mjs never touches a stream tagged for another mapping.
		await new Promise((resolve) => setImmediate(resolve));
		expect(deviceStream.close).not.toHaveBeenCalled();
	});

	test("close() unregisters via reverse:killforward:tcp:<devicePort> and stops bridging new connections", async () => {
		const target = net.createServer();
		await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
		const hostPort = target.address().port;

		try {
			const streamManager = createFakeStreamManager();
			const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, hostPort);
			await vi.waitUntil(() => streamManager.openedStreams.length > 0);
			streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));
			const handle = await startPromise;

			const closePromise = handle.close();
			await vi.waitUntil(() => streamManager.openedStreams.length > 1);
			expect(streamManager.openedDestinations[1]).toBe("reverse:killforward:tcp:7000");
			streamManager.openedStreams[1].emit("data", Buffer.from("OKAY"));
			await closePromise;

			const deviceStream = createFakeAdbStream();
			streamManager.emit("remoteOpen", deviceStream, `tcp:${hostPort}`);
			await new Promise((resolve) => setImmediate(resolve));
			// The listener was removed by close() - no local connection attempt,
			// and the fake stream was never even written to.
			expect(deviceStream.writes).toEqual([]);
		} finally {
			await new Promise((resolve) => target.close(resolve));
		}
	});
});
