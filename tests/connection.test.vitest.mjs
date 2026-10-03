/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/connection.test.vitest.mjs
 *	@Date: 2026-09-03T00:00:00-07:00 (1788418800)
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
 * A minimal fake ADB server: captures the client's CNXN payload, replies
 * AUTH(TOKEN) to it, then replies OKAY to whichever AUTH message the client
 * sends back first (droidsock sends the signature and the RSA pubkey as two
 * separate AUTH packets back-to-back without waiting in between - only one
 * needs a reply to complete connection.mjs's handshake). Doesn't validate
 * the signature at all - this only exercises the outgoing CNXN payload, not
 * real authentication. When `features` is given, the handshake is completed with a CNXN banner
 * advertising them instead of OKAY - the way a real device answers a successful AUTH, and the
 * only place connection.mjs sets connection.deviceFeatures from.
 * @param {Object} [options={}] - Options.
 * @param {string[]} [options.features] - Features to advertise in a CNXN reply instead of OKAY.
 * @returns {Promise<{port: number, server: net.Server, getCapturedCnxnPayload: () => string|null}>} The listening fake server.
 */
function createFakeAdbServer({ features } = {}) {
	return new Promise((resolve) => {
		let capturedCnxnPayload = null;
		const server = net.createServer((socket) => {
			let buffer = Buffer.alloc(0);
			let awaitingReply = false;
			socket.on("data", (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				while (buffer.length >= 24) {
					const dataLength = buffer.readUInt32LE(12);
					if (buffer.length < 24 + dataLength) break;
					const command = buffer.readUInt32LE(0);
					const data = buffer.subarray(24, 24 + dataLength);
					buffer = buffer.subarray(24 + dataLength);

					if (command === MSG_CNXN && capturedCnxnPayload === null) {
						capturedCnxnPayload = data.toString("utf8");
						// Real ADB AUTH tokens are exactly 20 bytes (auth.mjs validates this
						// before signing) - the fake server doesn't need a real random token,
						// just one of the right length.
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
			resolve({ port: server.address().port, server, getCapturedCnxnPayload: () => capturedCnxnPayload });
		});
	});
}

describe("connection.create - outgoing CNXN feature advertisement (see #8)", () => {
	let fakeServer;
	let keyDir;

	afterEach(async () => {
		if (fakeServer) {
			await new Promise((resolve) => fakeServer.server.close(resolve));
			fakeServer = null;
		}
		if (keyDir) rmSync(keyDir, { recursive: true, force: true });
	});

	test("advertises droidsock's supported features in the outgoing CNXN payload", async () => {
		fakeServer = await createFakeAdbServer();
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		const droidsock = await createDroidSock();
		try {
			const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
			expect(device.isConnected()).toBe(true);

			const payload = fakeServer.getCapturedCnxnPayload();
			expect(payload).toMatch(/^device::features=/);
			for (const feature of ["shell_v2", "cmd", "stat_v2", "ls_v2", "sendrecv_v2", "sendrecv_v2_brotli"]) {
				expect(payload.split("features=")[1].split(",")).toContain(feature);
			}

			await device.disconnect();
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("devices leaf isConnected() - reflects unexpected socket teardown, not just disconnect()", () => {
	let fakeServer;
	let keyDir;

	afterEach(async () => {
		if (fakeServer) {
			await new Promise((resolve) => fakeServer.server.close(resolve));
			fakeServer = null;
		}
		if (keyDir) rmSync(keyDir, { recursive: true, force: true });
	});

	test("flips to false when the underlying TCP socket is destroyed by a real RST, with no disconnect() call", async () => {
		fakeServer = await createFakeAdbServer();
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		let acceptedSocket;
		fakeServer.server.on("connection", (socket) => {
			acceptedSocket = socket;
		});

		const droidsock = await createDroidSock();
		try {
			const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
			expect(device.isConnected()).toBe(true);

			// connection.connected is only ever set false by disconnect() - a
			// real TCP RST (not a graceful end, and never disconnect()) leaves
			// it stuck at true unless isConnected() also consults the socket's
			// own (always-accurate) destroyed state.
			acceptedSocket.resetAndDestroy();
			await vi.waitUntil(() => device.isConnected() === false);
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("devices leaf install() - streaming-then-classic fallback error handling", () => {
	let fakeServer;
	let keyDir;

	afterEach(async () => {
		if (fakeServer) {
			await new Promise((resolve) => fakeServer.server.close(resolve));
			fakeServer = null;
		}
		if (keyDir) rmSync(keyDir, { recursive: true, force: true });
	});

	test("surfaces both failures when the streaming attempt fails and the classic fallback also fails", async () => {
		// The fake device advertises "cmd" in its handshake, so install() takes
		// the streaming path first. (Writing device.connection.deviceFeatures by
		// hand no longer reaches the leaf's own connection: that property is a
		// slothlet live-view mirror, and an object assigned through it stays on
		// the view.)
		fakeServer = await createFakeAdbServer({ features: ["cmd"] });
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		const droidsock = await createDroidSock();
		let device;
		try {
			device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });

			const streamingSpy = vi.spyOn(droidsock.install, "streaming").mockRejectedValue(new Error("device disconnected mid-transfer"));
			vi.spyOn(droidsock.install, "classic").mockRejectedValue(new Error("push failed: permission denied"));

			// Previously the streaming error was silently discarded (bare
			// `catch {}`), so the caller only ever saw the classic error -
			// losing the original failure that actually motivated the fallback.
			await expect(device.install("/local/app.apk")).rejects.toThrow(
				"Streaming install failed (device disconnected mid-transfer), and the classic fallback also failed: push failed: permission denied"
			);
			expect(streamingSpy).toHaveBeenCalledTimes(1);
		} finally {
			// Disconnect in finally, not after the assertions: a failed assertion
			// would otherwise leave this connection open, and the afterEach
			// hook's server.close() waits for every connection to end.
			if (device) device.disconnect();
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("falls back to classic silently when it succeeds, discarding the streaming error as intended", async () => {
		fakeServer = await createFakeAdbServer({ features: ["cmd"] });
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		const droidsock = await createDroidSock();
		let device;
		try {
			device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });

			const streamingSpy = vi.spyOn(droidsock.install, "streaming").mockRejectedValue(new Error("cmd package install not supported"));
			const classicSpy = vi.spyOn(droidsock.install, "classic").mockResolvedValue("Success\n");

			await expect(device.install("/local/app.apk")).resolves.toBe("Success\n");
			// Both paths ran: the streaming attempt failed and classic recovered.
			expect(streamingSpy).toHaveBeenCalledTimes(1);
			expect(classicSpy).toHaveBeenCalledTimes(1);
		} finally {
			if (device) device.disconnect();
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("devices leaf convenience shell shortcuts - quote user-controlled arguments before shelling out", () => {
	let fakeServer;
	let keyDir;

	afterEach(async () => {
		if (fakeServer) {
			await new Promise((resolve) => fakeServer.server.close(resolve));
			fakeServer = null;
		}
		if (keyDir) rmSync(keyDir, { recursive: true, force: true });
	});

	test("ls(), getprop(), screenshot(), keypress(), and launchApp() single-quote their arguments instead of interpolating unsafely", async () => {
		fakeServer = await createFakeAdbServer();
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		const droidsock = await createDroidSock();
		try {
			const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });
			const executeSpy = vi.spyOn(droidsock.shell, "execute").mockResolvedValue("");

			// Metacharacters and an embedded quote - single-quoting must neutralize
			// all of them (only the quote delimiter itself needs escaping).
			await device.ls("/sdcard/it's a test`$(touch /tmp/pwned)`");
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("ls -la '/sdcard/it'\\''s a test`$(touch /tmp/pwned)`'");

			await device.getprop("a; touch /tmp/pwned");
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("getprop 'a; touch /tmp/pwned'");

			await device.screenshot("/sdcard/$(touch /tmp/pwned).png");
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("screencap -p '/sdcard/$(touch /tmp/pwned).png'");

			await device.keypress("4; touch /tmp/pwned");
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("input keyevent '4; touch /tmp/pwned'");

			// package/activity must reach the device as one "/"-joined argument -
			// quoted as a single unit, not as two separately-quoted tokens.
			await device.launchApp("com.example.app`x`", "Main;Activity");
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("am start -n 'com.example.app`x`/Main;Activity'");

			// The remaining fixed-command convenience shortcuts.
			await device.pwd();
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("pwd");

			await device.getModel();
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("getprop ro.product.model");

			await device.getAndroidVersion();
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("getprop ro.build.version.release");

			await device.getBattery();
			expect(executeSpy.mock.calls.at(-1)[2]).toBe("dumpsys battery");

			await device.disconnect();
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("devices leaf remove() - tolerates a failed api leaf removal", () => {
	let fakeServer;
	let keyDir;

	afterEach(async () => {
		if (fakeServer) {
			await new Promise((resolve) => fakeServer.server.close(resolve));
			fakeServer = null;
		}
		if (keyDir) rmSync(keyDir, { recursive: true, force: true });
	});

	test("still resolves when self.slothlet.api.remove() rejects (e.g. the entry is already gone)", async () => {
		fakeServer = await createFakeAdbServer();
		keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-connection-test-"));

		const droidsock = await createDroidSock();
		try {
			const device = await droidsock.device.connect("127.0.0.1", fakeServer.port, { keyDir });

			vi.spyOn(droidsock.slothlet.api, "remove").mockRejectedValueOnce(new Error("devices.<key> not found"));

			// An unguarded await on api.remove() would propagate this rejection,
			// masking that the underlying socket had already been torn down
			// successfully by connection.disconnect() just before it. disconnect()
			// itself no longer touches api.remove() at all (see device.mjs) -
			// only remove() does, so this scenario now lives here.
			await expect(device.remove()).resolves.toBeUndefined();
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});
