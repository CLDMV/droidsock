/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/api-surface.test.vitest.mjs
 *	@Date: 2026-08-30 16:00:07 -07:00 (1788130807)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect } from "vitest";
import createDroidSock, { createDroidSock as createDroidSockNamed, DroidSock, ADB, AndroidDebugBridge } from "../index.mjs";

describe("index.mjs default export", () => {
	test("createDroidSock() builds an API with every expected module", async () => {
		const droidsock = await createDroidSock();
		try {
			for (const mod of ["auth", "config", "connection", "device", "files", "log", "shell", "stream", "utils"]) {
				expect(droidsock[mod], `missing module: ${mod}`).toBeDefined();
			}
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("device module exposes the documented connection-management functions", async () => {
		const droidsock = await createDroidSock();
		try {
			expect(typeof droidsock.device.connect).toBe("function");
			expect(typeof droidsock.device.list).toBe("function");
			expect(typeof droidsock.device.disconnect).toBe("function");
			expect(typeof droidsock.device.disconnectAll).toBe("function");
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("shell module exposes execute/startStreaming/startInteractive/commands", async () => {
		const droidsock = await createDroidSock();
		try {
			expect(typeof droidsock.shell.execute).toBe("function");
			expect(typeof droidsock.shell.startStreaming).toBe("function");
			expect(typeof droidsock.shell.startInteractive).toBe("function");
			expect(typeof droidsock.shell.commands).toBe("object");
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("device.list() starts empty with no active connections", async () => {
		const droidsock = await createDroidSock();
		try {
			expect(droidsock.device.list()).toEqual([]);
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});

	test("applies initial config options passed to createDroidSock()", async () => {
		const droidsock = await createDroidSock({ config: { debug: true, eventPrefix: "custom" } });
		try {
			expect(droidsock.config.get("debug")).toBe(true);
			expect(droidsock.config.get("eventPrefix")).toBe("custom");
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});

describe("index.mjs named exports", () => {
	test("createDroidSock, DroidSock, ADB, and AndroidDebugBridge are all aliases of the default export", () => {
		expect(createDroidSockNamed).toBe(createDroidSock);
		expect(DroidSock).toBe(createDroidSock);
		expect(ADB).toBe(createDroidSock);
		expect(AndroidDebugBridge).toBe(createDroidSock);
	});

	test("the named createDroidSock alias accepts options exactly like the default export", async () => {
		const droidsock = await createDroidSockNamed({ config: { debug: true } });
		try {
			expect(droidsock.config.get("debug")).toBe(true);
		} finally {
			if (droidsock.shutdown) await droidsock.shutdown();
		}
	});
});
