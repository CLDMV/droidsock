/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/device-connection.test.vitest.mjs
 *	@Date: 2026-08-30 16:00:52 -07:00 (1788130852)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect } from "vitest";
import createDroidSock from "../index.mjs";
import { isValidPort } from "../src/api/utils.mjs";

// These suites need a real Android/Fire TV device reachable on the network with
// ADB-over-network already enabled - not something CI can provide. They're
// skipped by default and only run when a real device is pointed at explicitly:
//
//   DROIDSOCK_TEST_DEVICE_HOST=10.6.0.108 npm test -- device-connection
//
// (DROIDSOCK_TEST_DEVICE_PORT defaults to 5555 if the host is set but the port isn't.)
const deviceHost = process.env.DROIDSOCK_TEST_DEVICE_HOST;
// Only compute/validate the port when a host is actually set - otherwise the whole
// suite is skipped below, and a stale/invalid DROIDSOCK_TEST_DEVICE_PORT left over
// in someone's shell shouldn't fail this file at import time for a suite that never runs.
const devicePort = (() => {
	if (!deviceHost) return undefined;
	const raw = process.env.DROIDSOCK_TEST_DEVICE_PORT;
	if (!raw) return 5555;
	const parsed = Number(raw);
	if (!isValidPort(parsed)) {
		throw new Error(`DROIDSOCK_TEST_DEVICE_PORT must be a valid port number (1-65535), got: "${raw}"`);
	}
	return parsed;
})();

describe.skipIf(!deviceHost)("live device connection", () => {
	test("connects, authenticates, and runs a shell command", async () => {
		const droidsock = await createDroidSock({ config: { debug: false, verbose: false } });
		try {
			const device = await droidsock.devices.connect(deviceHost, devicePort);
			expect(device.isConnected()).toBe(true);

			const result = await device.shell("echo droidsock-test-ok");
			expect(result.trim()).toBe("droidsock-test-ok");

			await device.disconnect();
			expect(device.isConnected()).toBe(false);
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("reuses an existing connection for the same host:port", async () => {
		const droidsock = await createDroidSock();
		try {
			const first = await droidsock.devices.connect(deviceHost, devicePort);
			const second = await droidsock.devices.connect(deviceHost, devicePort);
			expect(second).toBe(first);
			await first.disconnect();
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("the named createDroidSock export reaches the same device", async () => {
		const { createDroidSock: createDroidSockNamed } = await import("../index.mjs");
		const droidsock = await createDroidSockNamed();
		const device = await droidsock.devices.connect(deviceHost, devicePort);
		try {
			expect(device.isConnected()).toBe(true);
		} finally {
			await device.disconnect();
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("device connection without a reachable host", () => {
	test("rejects rather than hanging when the host refuses the connection", async () => {
		const droidsock = await createDroidSock();
		try {
			await expect(droidsock.devices.connect("127.0.0.1", 1)).rejects.toThrow();
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});
