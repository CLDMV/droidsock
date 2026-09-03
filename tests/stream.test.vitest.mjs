/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/stream.test.vitest.mjs
 *	@Date: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import createDroidSock from "../index.mjs";

// stream.mjs's manager is exercised everywhere else only through a fully
// faked streamManager (forward/reverse/reboot tests), so its own handlePacket()
// dispatch - including the new device-initiated ("remoteOpen") path added for
// reverse forwarding - has no coverage anywhere else. These tests drive the
// real manager directly against hand-built ADB packet bytes and a fake socket
// that just captures writes, with no real TCP connection needed.

const MSG_OPEN = 0x4e45504f;
const MSG_OKAY = 0x59414b4f;
const MSG_WRTE = 0x45545257;
const MSG_CLSE = 0x45534c43;

let droidsock;

/**
 * Builds one raw ADB protocol packet (24-byte header + payload), matching
 * stream.mjs's own sendMessage() wire format.
 * @param {number} command - Message command (one of the MSG_* constants).
 * @param {number} arg0 - First header argument.
 * @param {number} arg1 - Second header argument.
 * @param {Buffer|string} [data=Buffer.alloc(0)] - Payload.
 * @returns {Buffer} The encoded packet.
 */
function buildPacket(command, arg0, arg1, data = Buffer.alloc(0)) {
	const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
	let checksum = 0;
	for (let i = 0; i < payload.length; i++) checksum += payload[i];

	const header = Buffer.alloc(24);
	header.writeUInt32LE(command, 0);
	header.writeUInt32LE(arg0, 4);
	header.writeUInt32LE(arg1, 8);
	header.writeUInt32LE(payload.length, 12);
	header.writeUInt32LE(checksum & 0xffffffff, 16);
	header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
	return Buffer.concat([header, payload]);
}

/**
 * Creates a fake socket that just captures every write() call as a Buffer,
 * with helpers to decode them back into {command, arg0, arg1, data}.
 * @returns {{write: Function, writes: Buffer[], packets: () => Array}} The fake socket.
 */
function createFakeSocket() {
	const socket = { writes: [] };
	socket.write = (chunk) => {
		socket.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	};
	socket.packets = () => {
		// sendMessage() issues one write() for the header and, only when there's
		// a payload, a second write() for the data - reassemble both shapes back
		// into discrete packets in the order they were written.
		const all = Buffer.concat(socket.writes);
		const packets = [];
		let offset = 0;
		while (offset + 24 <= all.length) {
			const command = all.readUInt32LE(offset);
			const arg0 = all.readUInt32LE(offset + 4);
			const arg1 = all.readUInt32LE(offset + 8);
			const dataLength = all.readUInt32LE(offset + 12);
			const data = all.subarray(offset + 24, offset + 24 + dataLength);
			packets.push({ command, arg0, arg1, data });
			offset += 24 + dataLength;
		}
		return packets;
	};
	return socket;
}

beforeEach(async () => {
	droidsock = await createDroidSock();
});

/**
 * Runs `fn` inside an active slothlet context. stream.mjs's manager methods
 * (openStream/handlePacket/sendMessage) resolve `self.config`/`self.log` at
 * call time, not up front - fine in the real app, where they're only ever
 * invoked from within slothlet's own call chain (device.mjs's setup runs
 * inside an active call, and slothlet propagates that context through the
 * EventEmitter listeners it registers), but calling the manager directly
 * from test code has no such context, and throws RUNTIME_NO_ACTIVE_CONTEXT_SELF.
 * @param {Function} fn - Function to run with an active context.
 * @returns {*} Whatever `fn` returns.
 */
function withContext(fn) {
	return droidsock.slothlet.context.run({}, fn);
}

afterEach(async () => {
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("stream.create", () => {
	test("openStream() resolves once the device's OKAY arrives, keyed by our local stream id", async () => {
		const socket = createFakeSocket();
		const manager = await droidsock.stream.create(socket);

		const opened = withContext(() => manager.openStream("shell:ls"));
		const openPacket = socket.packets()[0];
		expect(openPacket.command).toBe(MSG_OPEN);
		expect(openPacket.data.toString()).toBe("shell:ls");

		// openStream() writes the OPEN packet synchronously, but only attaches
		// its once("ready", ...) listener after its own internal await - a
		// same-tick OKAY delivery would emit "ready" before anyone's listening
		// (EventEmitter doesn't replay missed events). manager.streams exposes
		// the real stream object, so wait for "newListener" (fired synchronously
		// the moment .once("ready", ...) is called) before delivering the ack -
		// the same technique forward.test.vitest.mjs's fake stream uses.
		const pendingStream = manager.streams.get(openPacket.arg0);
		await new Promise((resolve) => pendingStream.once("newListener", resolve));
		withContext(() => manager.handlePacket(buildPacket(MSG_OKAY, 42, openPacket.arg0)));

		const stream = await opened;
		expect(stream.ready).toBe(true);
		expect(stream.remoteId).toBe(42);
	});

	test("a device-initiated OPEN allocates a fresh local id, acks OKAY, and emits remoteOpen", async () => {
		const socket = createFakeSocket();
		const manager = await droidsock.stream.create(socket);

		const remoteOpen = new Promise((resolve) => manager.once("remoteOpen", (stream, destination) => resolve({ stream, destination })));
		withContext(() => manager.handlePacket(buildPacket(MSG_OPEN, 7, 0, "tcp:9000")));

		const { stream, destination } = await remoteOpen;
		expect(destination).toBe("tcp:9000");
		expect(stream.ready).toBe(true);
		expect(stream.remoteId).toBe(7);

		const ack = socket.packets()[0];
		expect(ack.command).toBe(MSG_OKAY);
		expect(ack.arg0).toBe(stream.localId);
		expect(ack.arg1).toBe(7);
	});

	test("two device-initiated OPENs in one handlePacket() call each get a distinct local id", async () => {
		const socket = createFakeSocket();
		const manager = await droidsock.stream.create(socket);

		const seen = [];
		manager.on("remoteOpen", (stream, destination) => seen.push({ localId: stream.localId, destination }));

		const combined = Buffer.concat([buildPacket(MSG_OPEN, 1, 0, "tcp:9000"), buildPacket(MSG_OPEN, 2, 0, "tcp:9001")]);
		withContext(() => manager.handlePacket(combined));

		expect(seen).toHaveLength(2);
		expect(seen[0].destination).toBe("tcp:9000");
		expect(seen[1].destination).toBe("tcp:9001");
		expect(seen[0].localId).not.toBe(seen[1].localId);
	});

	test("WRTE/CLSE addressed to a device-initiated stream's local id route to that stream", async () => {
		const socket = createFakeSocket();
		const manager = await droidsock.stream.create(socket);

		const remoteOpen = new Promise((resolve) => manager.once("remoteOpen", (stream) => resolve(stream)));
		withContext(() => manager.handlePacket(buildPacket(MSG_OPEN, 7, 0, "tcp:9000")));
		const stream = await remoteOpen;

		const received = new Promise((resolve) => stream.once("data", resolve));
		withContext(() => manager.handlePacket(buildPacket(MSG_WRTE, 7, stream.localId, "hello")));
		expect((await received).toString()).toBe("hello");

		const closed = new Promise((resolve) => stream.once("close", resolve));
		withContext(() => manager.handlePacket(buildPacket(MSG_CLSE, 7, stream.localId)));
		await closed;
		expect(stream.closed).toBe(true);
	});
});
