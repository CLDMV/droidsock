/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/reboot.test.vitest.mjs
 *	@Date: 2026-09-01 11:43:14 -07:00 (1788288194)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 11:43:14 -07:00 (1788288194)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import createDroidSock from "../index.mjs";

// reboot.mjs's execute() is a thin wrapper around streamManager.openStream("reboot:<mode>")
// followed by a best-effort streamManager.closeStream() - no protocol-level mocking needed,
// just a fake stream manager that records what it was asked to open/close and mirrors
// stream.mjs's real registry behavior (closeStream deletes the entry, not just close()s it,
// and does so even if close() itself throws), so a regression back to calling stream.close()
// directly (leaving the registry entry referenced) would show up as the registry never
// being cleared.
let droidsock;
const fakeSocket = {};
let nextLocalId = 1;

function createFakeStreamManager(streamFactory) {
	const opened = [];
	const closedIds = [];
	const streams = new Map();
	return {
		opened,
		closedIds,
		streams,
		async openStream(destination) {
			opened.push(destination);
			const localId = nextLocalId++;
			const stream = streamFactory ? streamFactory() : { close: () => {} };
			stream.localId = localId;
			streams.set(localId, stream);
			return stream;
		},
		closeStream(localId) {
			closedIds.push(localId);
			const stream = streams.get(localId);
			if (stream) {
				try {
					stream.close();
				} finally {
					streams.delete(localId);
				}
			}
		}
	};
}

beforeEach(async () => {
	droidsock = await createDroidSock();
});

afterEach(async () => {
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("reboot.execute", () => {
	test("opens reboot: for a normal reboot with no mode", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager);
		expect(streamManager.opened).toEqual(["reboot:"]);
	});

	test("opens reboot:bootloader for the bootloader mode", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager, "bootloader");
		expect(streamManager.opened).toEqual(["reboot:bootloader"]);
	});

	test("opens reboot:recovery for the recovery mode", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager, "recovery");
		expect(streamManager.opened).toEqual(["reboot:recovery"]);
	});

	test("opens reboot:sideload for the sideload mode", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager, "sideload");
		expect(streamManager.opened).toEqual(["reboot:sideload"]);
	});

	test("passes through a device-specific mode it doesn't know about", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager, "edl");
		expect(streamManager.opened).toEqual(["reboot:edl"]);
	});

	test("closes the opened stream via the stream manager, removing it from the registry", async () => {
		const streamManager = createFakeStreamManager();
		await droidsock.reboot.execute(fakeSocket, streamManager);

		expect(streamManager.closedIds).toHaveLength(1);
		// The registry must be empty afterward - calling stream.close() directly instead of
		// streamManager.closeStream() would close the stream but leave it referenced here.
		expect(streamManager.streams.size).toBe(0);
	});

	test("resolves and still clears the registry even if closing the stream throws (device may have already dropped the connection)", async () => {
		const streamManager = createFakeStreamManager(() => ({
			close: () => {
				throw new Error("socket closed");
			}
		}));
		await expect(droidsock.reboot.execute(fakeSocket, streamManager)).resolves.toBeUndefined();
		// The main regression this guards against: streamManager.closeStream() must remove the
		// registry entry even when stream.close() itself throws, not just on the happy path.
		expect(streamManager.streams.size).toBe(0);
	});
});
