/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/config.test.vitest.mjs
 *	@Date: 2026-08-30 15:56:37 -07:00 (1788130597)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { init, get, set, merge, reset, all, getDefaults, validateConfig } from "../src/api/config.mjs";

// config.mjs holds a single module-level instance created lazily on first
// access, and init() only ever seeds it once - a later init() call is a
// no-op while the instance already exists. This describe block runs first
// (declaration order) so it observes that real first-access behavior before
// any other test in this file establishes state via reset().
describe("config.init (first-access behavior)", () => {
	test("get() auto-initializes with defaults before any explicit init()", () => {
		expect(get("port")).toBe(5555);
	});

	test("a later init() call does not re-seed an already-initialized instance", () => {
		init({ host: "10.0.0.5" });
		expect(get("host")).toBe("127.0.0.1");
	});
});

describe("config API (each test starts from a reset baseline)", () => {
	beforeEach(() => {
		reset();
	});

	test("get() supports dot-notation for nested lookups", () => {
		set("nested.deep.value", 42);
		expect(get("nested.deep.value")).toBe(42);
	});

	test("get() returns the provided default for a missing key", () => {
		expect(get("does.not.exist", "fallback")).toBe("fallback");
	});

	test("all() returns a copy, not a live reference", () => {
		const snapshot = all();
		snapshot.host = "mutated";
		expect(get("host")).not.toBe("mutated");
	});

	test("set() sets a top-level key", () => {
		set("debug", true);
		expect(get("debug")).toBe(true);
	});

	test("set() creates intermediate objects for a dot-notation path", () => {
		set("a.b.c", "leaf");
		expect(get("a.b.c")).toBe("leaf");
		expect(typeof get("a.b")).toBe("object");
	});

	test("set() overwrites a non-object value found along the path", () => {
		set("debug", true);
		set("debug.nested", "value");
		expect(get("debug.nested")).toBe("value");
	});

	test("merge() recursively merges nested objects without clobbering siblings", () => {
		set("group", { a: 1, b: 2 });
		merge({ group: { b: 20, c: 3 } });
		expect(get("group")).toEqual({ a: 1, b: 20, c: 3 });
	});

	test("merge() replaces non-object values wholesale", () => {
		merge({ port: 9999 });
		expect(get("port")).toBe(9999);
	});

	test("merge() creates a nested object for a key that doesn't exist yet", () => {
		merge({ brandNewGroup: { x: 1 } });
		expect(get("brandNewGroup")).toEqual({ x: 1 });
	});

	test("reset() discards all overrides", () => {
		set("host", "changed");
		reset();
		expect(get("host")).toBe("127.0.0.1");
	});

	test("getDefaults() returns the default config without requiring init", () => {
		const defaults = getDefaults();
		expect(defaults.port).toBe(5555);
		expect(defaults.keyDir).toBeNull();
	});

	test("getDefaults() returns a copy, not the live defaults object", () => {
		const defaults = getDefaults();
		defaults.port = 1;
		expect(getDefaults().port).toBe(5555);
	});
});

describe("config.validateConfig", () => {
	test("accepts a valid configuration with no errors", () => {
		const result = validateConfig({ port: 5555, timeout: 1000, bufferSize: 2048, chunkSize: 65536 });
		expect(result).toEqual({ valid: true, errors: [] });
	});

	test("flags an out-of-range port", () => {
		const result = validateConfig({ port: 70000 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("port must be a number between 1 and 65535");
	});

	test("flags a negative timeout", () => {
		const result = validateConfig({ timeout: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("timeout must be a non-negative number");
	});

	test("flags a negative streamTimeout/shellTimeout/fileTimeout", () => {
		const result = validateConfig({ streamTimeout: -1, shellTimeout: -1, fileTimeout: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("streamTimeout must be a non-negative number");
		expect(result.errors).toContain("shellTimeout must be a non-negative number");
		expect(result.errors).toContain("fileTimeout must be a non-negative number");
	});

	test("flags an undersized buffer setting", () => {
		const result = validateConfig({ bufferSize: 512 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("bufferSize must be a number >= 1024");
	});

	test("ignores unset fields rather than flagging them", () => {
		expect(validateConfig({})).toEqual({ valid: true, errors: [] });
	});
});
