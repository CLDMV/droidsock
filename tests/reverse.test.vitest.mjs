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
		// Idempotent, matching the real AdbStream.close() (stream.mjs) - without
		// this guard, routing close() through streamManager.closeStream() (which
		// itself calls stream.close()) from inside a "close" listener re-emits
		// "close" and re-enters the same listener, recursing forever.
		if (stream.closed) return;
		stream.closed = true;
		stream.emit("close");
	});
	stream.nextWrite = () => new Promise((resolve) => resolvers.push(resolve));
	return stream;
}

/**
 * Creates a fake stream manager: openStream() resolves a fresh fake ADB
 * stream per call (captured in order in `openedStreams`, with the
 * destination each was opened for in `openedDestinations`, and a `localId`
 * assigned like the real stream.mjs manager does), on/off/emit proxy a real
 * EventEmitter for the "remoteOpen" pub/sub reverse.mjs uses, and
 * closeStream(localId) mirrors the real manager's close()-then-drop-from-
 * registry behavior - reverse.mjs must call this (not stream.close()
 * directly) so a closed stream doesn't linger in the registry.
 * @returns {Object} The fake stream manager.
 */
function createFakeStreamManager() {
	const emitter = new EventEmitter();
	const openedStreams = [];
	const openedDestinations = [];
	const streamsById = new Map();
	let nextLocalId = 1;
	return {
		openedStreams,
		openedDestinations,
		on: (...args) => emitter.on(...args),
		off: (...args) => emitter.off(...args),
		emit: (...args) => emitter.emit(...args),
		openStream: vi.fn((destination) => {
			openedDestinations.push(destination);
			const stream = createFakeAdbStream();
			stream.localId = nextLocalId++;
			streamsById.set(stream.localId, stream);
			openedStreams.push(stream);
			return Promise.resolve(stream);
		}),
		// Mirrors stream.mjs's own handling of a device-initiated OPEN: the real
		// manager registers the minted stream (streams.set(localId, stream))
		// BEFORE emitting "remoteOpen" - a fake deviceStream driving a
		// streamManager.emit("remoteOpen", ...) test must be registered the
		// same way for closeStream(deviceStream.localId) assertions to mean
		// anything (otherwise the id is undefined and closeStream() no-ops).
		registerDeviceStream: (stream) => {
			stream.localId = nextLocalId++;
			streamsById.set(stream.localId, stream);
			return stream;
		},
		closeStream: vi.fn((localId) => {
			const stream = streamsById.get(localId);
			if (stream) {
				stream.close();
				streamsById.delete(localId);
			}
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
		// closeStream() (not stream.close() directly) so the manager also drops
		// its registry entry - the underlying stream still gets closed either
		// way, but going through closeStream is what actually removes it.
		expect(streamManager.closeStream).toHaveBeenCalledWith(streamManager.openedStreams[0].localId);
		expect(streamManager.openedStreams[0].close).toHaveBeenCalled();
	});

	test("rejects with the device's message when registration is acked FAIL, and still cleans up via closeStream()", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);

		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		const registerStream = streamManager.openedStreams[0];
		registerStream.emit("data", Buffer.from("FAIL0009not found"));

		await expect(startPromise).rejects.toThrow(/not found/);
		expect(streamManager.closeStream).toHaveBeenCalledWith(registerStream.localId);
	});

	test("rejects with an empty message (not the length field) when acked a zero-length FAIL0000", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);

		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		streamManager.openedStreams[0].emit("data", Buffer.from("FAIL0000"));

		// Previously a falsy-empty-string fallback misread the length field
		// itself ("0000") as the message - assert the message is empty, not "0000".
		await expect(startPromise).rejects.toThrow("Failed to register reverse tunnel tcp:7000 -> tcp:8000: ");
	});

	test("rejects with an 'Unexpected response' error (not a silently-masked empty message) when FAIL's length field isn't valid hex", async () => {
		const streamManager = createFakeStreamManager();
		const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, 8000);

		await vi.waitUntil(() => streamManager.openedStreams.length > 0);
		// A malformed length field (not 4 hex digits) - parseInt() would return
		// NaN here, and a `NaN || 0` fallback previously treated this the same
		// as a valid zero-length FAIL, masking corrupted/desynced data instead
		// of surfacing a protocol error.
		streamManager.openedStreams[0].emit("data", Buffer.from("FAILzzzzsomething"));

		await expect(startPromise).rejects.toThrow(/^Unexpected response to register reverse tunnel tcp:7000 -> tcp:8000: /);
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
			const deviceStream = streamManager.registerDeviceStream(createFakeAdbStream());
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
			// closeStream() (not deviceStream.close() directly) so the manager
			// also drops its registry entry for the bridged device stream.
			expect(streamManager.closeStream).toHaveBeenCalledWith(deviceStream.localId);
		} finally {
			await new Promise((resolve) => target.close(resolve));
		}
	});

	test("closes the device stream via closeStream() when the LOCAL target ends the connection (not just when the device does)", async () => {
		let acceptedSocket;
		const target = net.createServer((socket) => {
			acceptedSocket = socket;
		});
		await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
		const hostPort = target.address().port;

		try {
			const streamManager = createFakeStreamManager();
			const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, hostPort);
			await vi.waitUntil(() => streamManager.openedStreams.length > 0);
			streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));
			await startPromise;

			const deviceStream = streamManager.registerDeviceStream(createFakeAdbStream());
			const localListenerAttached = onceEvent(deviceStream, "newListener");
			streamManager.emit("remoteOpen", deviceStream, `tcp:${hostPort}`);
			await localListenerAttached;
			await vi.waitUntil(() => acceptedSocket !== undefined);

			// The LOCAL target closes its end - reverse.mjs's localSocket "close"
			// handler is the code path under test here, distinct from the device
			// itself closing (covered by the bridging test above).
			acceptedSocket.end();
			await vi.waitUntil(() => streamManager.closeStream.mock.calls.some(([id]) => id === deviceStream.localId));
			expect(streamManager.closeStream).toHaveBeenCalledWith(deviceStream.localId);
		} finally {
			await new Promise((resolve) => target.close(resolve));
		}
	});

	test("stops writing to the local socket once it has failed, even if the device sends more data afterward", async () => {
		let acceptedSocket;
		const target = net.createServer((socket) => {
			acceptedSocket = socket;
		});
		await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
		const hostPort = target.address().port;

		try {
			const streamManager = createFakeStreamManager();
			const onError = vi.fn();
			const startPromise = droidsock.reverse.start(fakeSocket, streamManager, 7000, hostPort, { onError });
			await vi.waitUntil(() => streamManager.openedStreams.length > 0);
			streamManager.openedStreams[0].emit("data", Buffer.from("OKAY"));
			await startPromise;

			const deviceStream = streamManager.registerDeviceStream(createFakeAdbStream());
			const localListenerAttached = onceEvent(deviceStream, "newListener");
			streamManager.emit("remoteOpen", deviceStream, `tcp:${hostPort}`);
			await localListenerAttached;
			await vi.waitUntil(() => acceptedSocket !== undefined);

			// A real TCP RST (not a graceful end()) so the LOCAL socket itself
			// surfaces a genuine "error" event - the exact condition under test,
			// distinct from the graceful-close path covered above.
			acceptedSocket.resetAndDestroy();
			await vi.waitUntil(() => onError.mock.calls.length > 0);

			// The device keeps sending after the local socket has already
			// failed - localSocketConnected alone doesn't reflect that, so
			// without the fix this would attempt another write against the
			// already-destroyed local socket, surfacing as a second onError()
			// call from that write's own "error" event.
			deviceStream.emit("data", Buffer.from("more-data-after-failure"));
			await new Promise((resolve) => setImmediate(resolve));

			expect(onError).toHaveBeenCalledTimes(1);
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
			const killStream = streamManager.openedStreams[1];
			killStream.emit("data", Buffer.from("OKAY"));
			await closePromise;

			// closeStream() (not stream.close() directly) so the manager also
			// drops its registry entry.
			expect(streamManager.closeStream).toHaveBeenCalledWith(killStream.localId);

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

	test("close() cleans up the killforward stream via closeStream() even when no ack ever arrives", async () => {
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
			const killStream = streamManager.openedStreams[1];
			// The device closes the stream without ever acking - the ack promise
			// rejects. close() is best-effort and swallows this, but the stream
			// must still be cleaned up via closeStream() regardless.
			killStream.emit("close");
			await closePromise;

			expect(streamManager.closeStream).toHaveBeenCalledWith(killStream.localId);
		} finally {
			await new Promise((resolve) => target.close(resolve));
		}
	});
});
