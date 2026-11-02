/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/main.test.vitest.mjs
 *	@Date: 2026-11-01T12:09:30-08:00 (1793563770)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:12:57-08:00 (1793563977)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview The deprecated "@cldmv/droidsock/main" alias: it re-exports the package root
 * and prints one DeprecationWarning per process.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const message = '"@cldmv/droidsock/main" is deprecated; import "@cldmv/droidsock" instead.';

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("@cldmv/droidsock/main", () => {
	test("warns exactly once with code CLDMV_DROIDSOCK_MAIN, however often it is imported", async () => {
		vi.resetModules();
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

		await import("@cldmv/droidsock/main");
		await import("@cldmv/droidsock/main");

		expect(emitWarning).toHaveBeenCalledTimes(1);
		expect(emitWarning).toHaveBeenCalledWith(message, { type: "DeprecationWarning", code: "CLDMV_DROIDSOCK_MAIN" });
	});

	test("re-exports the package root: the same default and named exports", async () => {
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		vi.resetModules();
		const [alias, fresh] = await Promise.all([import("@cldmv/droidsock/main"), import("@cldmv/droidsock")]);

		expect(Object.keys(alias).sort()).toEqual(Object.keys(fresh).sort());
		for (const key of Object.keys(fresh)) expect(alias[key], key).toBe(fresh[key]);
		expect(typeof alias.default).toBe("function");
		expect(alias.default).toBe(fresh.default);
		expect(alias.default).toBe(fresh.createDroidSock);
	});

	test("falls back to console.warn where process.emitWarning is unavailable", async () => {
		vi.resetModules();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const original = process.emitWarning;
		process.emitWarning = undefined;
		try {
			await import("@cldmv/droidsock/main");
		} finally {
			process.emitWarning = original;
		}

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(`DeprecationWarning: ${message}`);
	});
});
