/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/forward.test.vitest.mjs
 *	@Date: 2026-09-01 12:20:00 -07:00 (1788290400)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 12:20:00 -07:00 (1788290400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import createDroidSock from "../index.mjs";

// forward.mjs bridges a real local TCP listener to a fake ADB stream. The local
// socket side is real (net.connect against the server forward.start() actually
// opens), so tests wait on real socket events; the device side is a fake stream
// whose write()/close() are driven deterministically via captured resolvers
// rather than polling, to avoid any timing races.
let droidsock;
const fakeSocket = {};

/**
 * Waits for one event from an emitter and resolves with its first argument.
 * For "data" specifically, also calls resume() when available - a Node
 * socket that's had several event-loop ticks pass since it was created (as
 * happens here, behind a chain of awaits) can stay in paused mode even after
 * a "data" listener is attached, silently buffering instead of delivering.
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
 * write() resolves a deferred `nextWrite()` promise per call, so tests can
 * await a specific write deterministically instead of polling.
 * @returns {EventEmitter & {write: Function, close: Function, writes: Buffer[], nextWrite: () => Promise<Buffer>}} The fake stream.
 */
function createFakeAdbStream() {
	const stream = new EventEmitter();
	stream.writes = [];
	let resolvers = [];
	stream.write = async (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		stream.writes.push(buf);
		const pending = resolvers;
		resolvers = [];
		pending.forEach((resolve) => resolve(buf));
	};
	stream.close = vi.fn();
	stream.nextWrite = () => new Promise((resolve) => resolvers.push(resolve));

	// forward.mjs attaches its "data" listener to the stream first, synchronously,
	// right after the stream-open promise resolves - "newListener" fires before that
	// listener is actually added, so by the time this microtask runs, every listener
	// forward.mjs registers in that same synchronous block (stream and local-socket
	// side alike) has already been attached. Awaiting this is how tests avoid racing
	// an emit("data", ...) against forward.mjs still being mid-setup.
	let resolveReady;
	stream.ready = new Promise((resolve) => {
		resolveReady = resolve;
	});
	stream.once("newListener", () => resolveReady());

	return stream;
}

/**
 * Creates a fake stream manager whose openStream() resolves the given stream
 * and resolves an `opened` promise with the requested destination, so tests
 * can await "the stream was opened" deterministically.
 * @param {Object} stream - The (fake) stream openStream() should resolve to.
 * @returns {{openStream: Function, opened: Promise<string>}} The fake stream manager.
 */
function createFakeStreamManager(stream) {
	let resolveOpened;
	const opened = new Promise((resolve) => {
		resolveOpened = resolve;
	});
	return {
		opened,
		openStream: vi.fn((destination) => {
			resolveOpened(destination);
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

describe("forward.start", () => {
	test("opens a device stream for tcp:<devicePort> per accepted connection", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000);
		expect(handle.localPort).toBeGreaterThan(0);

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		try {
			await onceEvent(localSocket, "connect");
			await expect(streamManager.opened).resolves.toBe("tcp:7000");
		} finally {
			localSocket.destroy();
			await handle.close();
		}
	});

	test("forwards bytes written locally to the device stream", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000);

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		try {
			await onceEvent(localSocket, "connect");
			await streamManager.opened;
			await fakeStream.ready;

			const written = fakeStream.nextWrite();
			localSocket.write("hello-device");
			expect((await written).toString()).toBe("hello-device");
		} finally {
			localSocket.destroy();
			await handle.close();
		}
	});

	test("forwards device stream data to the local socket", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000);

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		try {
			await onceEvent(localSocket, "connect");
			await streamManager.opened;
			await fakeStream.ready;

			const received = onceEvent(localSocket, "data");
			fakeStream.emit("data", Buffer.from("hello-local"));
			expect((await received).toString()).toBe("hello-local");
		} finally {
			localSocket.destroy();
			await handle.close();
		}
	});

	test("closes the device stream when the local socket closes", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000);

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		await onceEvent(localSocket, "connect");
		await streamManager.opened;

		localSocket.end();
		await vi.waitUntil(() => fakeStream.close.mock.calls.length > 0);
		expect(fakeStream.close).toHaveBeenCalled();

		await handle.close();
	});

	test("closes the device stream when the stream itself errors", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const onError = vi.fn();
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000, { onError });

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		const localClosed = onceEvent(localSocket, "close");
		await onceEvent(localSocket, "connect");
		await streamManager.opened;
		await fakeStream.ready;

		fakeStream.emit("error", new Error("device stream reset"));
		await localClosed;

		expect(fakeStream.close).toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	test("tears down both sides when writing to the device stream fails", async () => {
		const fakeStream = createFakeAdbStream();
		fakeStream.write = vi.fn().mockRejectedValue(new Error("stream closed"));
		const streamManager = createFakeStreamManager(fakeStream);
		const onError = vi.fn();
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000, { onError });

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		const localClosed = onceEvent(localSocket, "close");
		await onceEvent(localSocket, "connect");
		await streamManager.opened;
		await fakeStream.ready;

		localSocket.write("data-that-cant-be-forwarded");
		await localClosed;

		expect(fakeStream.close).toHaveBeenCalled();
		expect(onError.mock.calls[0][0].message).toBe("stream closed");

		await handle.close();
	});

	test("destroys the local socket and reports the error when opening the device stream fails", async () => {
		const streamManager = { openStream: vi.fn().mockRejectedValue(new Error("device gone")) };
		const onError = vi.fn();
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000, { onError });

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		await onceEvent(localSocket, "connect");
		await onceEvent(localSocket, "close");

		// onError's second argument is the server-side accepted socket for this
		// connection - a distinct object from our client-side `localSocket` - so
		// only assert the error itself, not socket identity.
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toBe("device gone");

		await handle.close();
	});

	test("an early client reset while openStream() is still pending doesn't crash and closes the stream once it opens", async () => {
		const fakeStream = createFakeAdbStream();
		let resolveOpenStream;
		const streamManager = {
			openStream: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveOpenStream = resolve;
					})
			)
		};
		const onError = vi.fn();
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000, { onError });

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		await onceEvent(localSocket, "connect");
		await vi.waitUntil(() => streamManager.openStream.mock.calls.length > 0);

		// resetAndDestroy() sends an actual RST, which is what makes the accepted
		// server-side socket emit a real "error" (ECONNRESET) rather than just
		// "close" - reproducing the race the fix guards against: the client resets
		// while streamManager.openStream() is still awaiting.
		localSocket.resetAndDestroy();
		await vi.waitUntil(() => onError.mock.calls.length > 0);
		expect(onError.mock.calls[0][0].code).toBe("ECONNRESET");

		// Resolving the stream open AFTER the local socket already failed must not
		// wire up a stream to a dead socket - it should just be closed.
		resolveOpenStream(fakeStream);
		await vi.waitUntil(() => fakeStream.close.mock.calls.length > 0);
		expect(fakeStream.close).toHaveBeenCalled();

		await handle.close();
	});

	test("close() stops accepting new connections", async () => {
		const fakeStream = createFakeAdbStream();
		const streamManager = createFakeStreamManager(fakeStream);
		const handle = await droidsock.forward.start(fakeSocket, streamManager, 7000);
		await handle.close();

		const localSocket = net.connect(handle.localPort, "127.0.0.1");
		await onceEvent(localSocket, "error");
		localSocket.destroy();
	});
});
