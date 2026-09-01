/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/log.test.vitest.mjs
 *	@Date: 2026-08-30 15:58:26 -07:00 (1788130706)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import createDroidSock from "../src/droidsock.mjs";

// log.mjs reads config through self.config, so it's exercised through the
// composed slothlet API. Config is a module-level singleton, so each test
// resets the flags it cares about explicitly rather than relying on order.
let droidsock;

beforeEach(async () => {
	droidsock = await createDroidSock();
	droidsock.config.reset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("log.debug", () => {
	test("is silent when debug is disabled (the default)", () => {
		droidsock.log.debug("hidden");
		expect(console.log).not.toHaveBeenCalled();
	});

	test("prints when debug is enabled", () => {
		droidsock.config.set("debug", true);
		droidsock.log.debug("shown", 42);
		expect(console.log).toHaveBeenCalledWith("[adb][DEBUG]", "shown", 42);
	});

	test("is silenced entirely when silent is set, even with debug on", () => {
		droidsock.config.set("debug", true);
		droidsock.config.set("silent", true);
		droidsock.log.debug("should not print");
		expect(console.log).not.toHaveBeenCalled();
	});
});

describe("log.verbose", () => {
	test("is silent by default", () => {
		droidsock.log.verbose("hidden");
		expect(console.log).not.toHaveBeenCalled();
	});

	test("prints when verbose is enabled", () => {
		droidsock.config.set("verbose", true);
		droidsock.log.verbose("shown");
		expect(console.log).toHaveBeenCalledWith("[adb][VERBOSE]", "shown");
	});

	test("prints when debug is enabled even if verbose is not", () => {
		droidsock.config.set("debug", true);
		droidsock.log.verbose("shown via debug");
		expect(console.log).toHaveBeenCalledWith("[adb][VERBOSE]", "shown via debug");
	});

	test("is silenced entirely when silent is set, even with verbose on", () => {
		droidsock.config.set("verbose", true);
		droidsock.config.set("silent", true);
		droidsock.log.verbose("should not print");
		expect(console.log).not.toHaveBeenCalled();
	});
});

describe("log.info / warn / error", () => {
	test("info() prints by default and respects silent", () => {
		droidsock.log.info("hello");
		expect(console.log).toHaveBeenCalledWith("[adb][INFO]", "hello");

		droidsock.config.set("silent", true);
		droidsock.log.info("hidden");
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	test("warn() uses console.warn and respects silent", () => {
		droidsock.log.warn("careful");
		expect(console.warn).toHaveBeenCalledWith("[adb][WARN]", "careful");

		droidsock.config.set("silent", true);
		droidsock.log.warn("hidden");
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	test("error() uses console.error and respects silent", () => {
		droidsock.log.error("boom");
		expect(console.error).toHaveBeenCalledWith("[adb][ERROR]", "boom");

		droidsock.config.set("silent", true);
		droidsock.log.error("hidden");
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	test("uses the configured eventPrefix", () => {
		droidsock.config.set("eventPrefix", "custom");
		droidsock.log.info("hi");
		expect(console.log).toHaveBeenCalledWith("[custom][INFO]", "hi");
	});
});

describe("log.getApi", () => {
	test("returns an object exposing every logging method as a function", () => {
		const api = droidsock.log.getApi();
		for (const method of ["debug", "verbose", "info", "warn", "error", "child"]) {
			expect(typeof api[method], `api.${method}`).toBe("function");
		}
	});
});

describe("log.child", () => {
	test("prefixes messages with the parent prefix plus the given context", () => {
		const child = droidsock.log.child("connection");
		child.info("connected");
		expect(console.log).toHaveBeenCalledWith("[adb][connection][INFO]", "connected");
	});

	test("respects debug/verbose/silent the same way as the top-level logger", () => {
		const child = droidsock.log.child("shell");

		child.debug("hidden");
		expect(console.log).not.toHaveBeenCalled();

		droidsock.config.set("debug", true);
		child.debug("shown");
		expect(console.log).toHaveBeenCalledWith("[adb][shell][DEBUG]", "shown");

		droidsock.config.set("silent", true);
		child.warn("hidden");
		expect(console.warn).not.toHaveBeenCalled();
	});

	test("child.verbose() respects verbose/debug/silent independently", () => {
		const child = droidsock.log.child("stream");

		child.verbose("hidden");
		expect(console.log).not.toHaveBeenCalled();

		droidsock.config.set("verbose", true);
		child.verbose("shown via verbose");
		expect(console.log).toHaveBeenCalledWith("[adb][stream][VERBOSE]", "shown via verbose");

		droidsock.config.set("silent", true);
		child.verbose("hidden again");
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	test("child.warn() prints via console.warn and respects silent", () => {
		const child = droidsock.log.child("auth");

		child.warn("careful");
		expect(console.warn).toHaveBeenCalledWith("[adb][auth][WARN]", "careful");

		droidsock.config.set("silent", true);
		child.warn("hidden");
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	test("child.error() prints via console.error and respects silent", () => {
		const child = droidsock.log.child("device");

		child.error("boom");
		expect(console.error).toHaveBeenCalledWith("[adb][device][ERROR]", "boom");

		droidsock.config.set("silent", true);
		child.error("hidden");
		expect(console.error).toHaveBeenCalledTimes(1);
	});
});
