/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/utils.test.vitest.mjs
 *	@Date: 2026-08-30 15:55:35 -07:00 (1788130535)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, vi } from "vitest";
import {
	parseProperties,
	parseListing,
	parseBattery,
	formatBytes,
	delay,
	retry,
	isValidIP,
	isValidPort,
	parseHostPort,
	escapeShell,
	timeout,
	withTimeout
} from "../src/api/utils.mjs";

describe("utils.parseProperties", () => {
	test("parses getprop-style bracketed key/value lines", () => {
		const output = "[ro.product.model]: [Pixel 6]\n[ro.build.version.release]: [13]\n";
		expect(parseProperties(output)).toEqual({
			"ro.product.model": "Pixel 6",
			"ro.build.version.release": "13"
		});
	});

	test("ignores lines that don't match the bracket format", () => {
		expect(parseProperties("not a property line\n[valid.key]: [value]")).toEqual({ "valid.key": "value" });
	});

	test("returns an empty object for empty input", () => {
		expect(parseProperties("")).toEqual({});
	});
});

describe("utils.parseListing", () => {
	// The dateTime field is captured non-greedily, so a single-token timestamp
	// (no embedded spaces) is required for the trailing filename to parse cleanly.
	test("parses `ls -la`-style output into structured entries", () => {
		const output = ["total 8", "drwxr-xr-x 2 root root 4096 2026-01-01 sdcard", "-rw-r--r-- 1 root root  123 2026-01-01 file.txt"].join(
			"\n"
		);
		const entries = parseListing(output);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ name: "sdcard", isDirectory: true, isFile: false });
		expect(entries[1]).toMatchObject({ name: "file.txt", isDirectory: false, isFile: true, size: 123 });
	});

	test("returns an empty array when there's nothing to parse", () => {
		expect(parseListing("")).toEqual([]);
	});

	test("silently skips a line that doesn't match the expected format", () => {
		const output = ["total 4", "not a valid ls line at all", "drwxr-xr-x 2 root root 4096 2026-01-01 sdcard"].join("\n");
		const entries = parseListing(output);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("sdcard");
	});
});

describe("utils.parseBattery", () => {
	test("parses dumpsys battery colon-separated key/value output", () => {
		const output = "Current Battery Service state:\n  AC powered: false\n  level: 87\n";
		const battery = parseBattery(output);
		expect(battery.level).toBe(87);
		expect(battery["AC powered"]).toBe("false");
	});
});

describe("utils.formatBytes", () => {
	test.each([
		[0, "0 Bytes"],
		[1024, "1 KB"],
		[1536, "1.5 KB"],
		[1048576, "1 MB"]
	])("formats %i bytes as %s", (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});

	test("clamps a negative decimals value to 0", () => {
		expect(formatBytes(1536, -2)).toBe("2 KB");
	});
});

describe("utils.delay", () => {
	test("resolves after roughly the requested delay", async () => {
		const start = Date.now();
		await delay(10);
		expect(Date.now() - start).toBeGreaterThanOrEqual(5);
	});
});

describe("utils.retry", () => {
	test("returns the result on first success without retrying", async () => {
		let calls = 0;
		const result = await retry(async () => {
			calls++;
			return "ok";
		});
		expect(result).toBe("ok");
		expect(calls).toBe(1);
	});

	test("retries until success within maxRetries", async () => {
		let calls = 0;
		const result = await retry(
			async () => {
				calls++;
				if (calls < 3) throw new Error("not yet");
				return "eventually";
			},
			{ maxRetries: 5, baseDelay: 1 }
		);
		expect(result).toBe("eventually");
		expect(calls).toBe(3);
	});

	test("throws the last error once maxRetries is exhausted", async () => {
		await expect(
			retry(
				async () => {
					throw new Error("always fails");
				},
				{ maxRetries: 2, baseDelay: 1 }
			)
		).rejects.toThrow("always fails");
	});

	test("stops retrying immediately when shouldRetry returns false", async () => {
		let calls = 0;
		await expect(
			retry(
				async () => {
					calls++;
					throw new Error("fatal");
				},
				{ maxRetries: 5, baseDelay: 1, shouldRetry: () => false }
			)
		).rejects.toThrow("fatal");
		expect(calls).toBe(1);
	});

	// A negative maxRetries is clamped to 0 (with a console.warn) rather than left
	// to fall through the for-loop and reject with a bare `undefined` - fn() still
	// runs exactly once, and a real failure propagates as a real Error.
	test("clamps a negative maxRetries to 0, warns, and still calls fn() exactly once", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		let calls = 0;
		await expect(
			retry(
				async () => {
					calls++;
					throw new Error("real failure");
				},
				{ maxRetries: -1 }
			)
		).rejects.toThrow("real failure");
		expect(calls).toBe(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("maxRetries"));
		warnSpy.mockRestore();
	});
});

describe("utils.isValidIP", () => {
	test.each([
		["192.168.1.1", true],
		["0.0.0.0", true],
		["255.255.255.255", true],
		["256.1.1.1", false],
		["1.2.3", false],
		["1.2.3.4.5", false],
		["not.an.ip.addr", false]
	])("isValidIP(%s) -> %s", (ip, expected) => {
		expect(isValidIP(ip)).toBe(expected);
	});
});

describe("utils.isValidPort", () => {
	test.each([
		[5555, true],
		[1, true],
		[65535, true],
		[0, false],
		[65536, false],
		[5555.5, false]
	])("isValidPort(%s) -> %s", (port, expected) => {
		expect(isValidPort(port)).toBe(expected);
	});
});

describe("utils.parseHostPort", () => {
	test("splits a host:port string", () => {
		expect(parseHostPort("10.6.0.108:5555")).toEqual({ host: "10.6.0.108", port: 5555 });
	});

	test("falls back to the default port when none is given", () => {
		expect(parseHostPort("10.6.0.108")).toEqual({ host: "10.6.0.108", port: 5555 });
	});

	test("honors a custom default port", () => {
		expect(parseHostPort("10.6.0.108", 22)).toEqual({ host: "10.6.0.108", port: 22 });
	});

	test("throws on an invalid port", () => {
		expect(() => parseHostPort("10.6.0.108:not-a-port")).toThrow("Invalid port");
	});
});

describe("utils.escapeShell", () => {
	test("escapes shell-special characters", () => {
		expect(escapeShell('echo "hi" $USER `whoami` \\end')).toBe('echo \\"hi\\" \\$USER \\`whoami\\` \\\\end');
	});

	test("leaves ordinary strings untouched", () => {
		expect(escapeShell("plain text")).toBe("plain text");
	});
});

describe("utils.timeout / withTimeout", () => {
	test("timeout() rejects after the given delay", async () => {
		await expect(timeout(5, "too slow")).rejects.toThrow("too slow");
	});

	test("withTimeout() resolves when the promise wins the race", async () => {
		await expect(withTimeout(Promise.resolve("fast"), 50)).resolves.toBe("fast");
	});

	test("withTimeout() rejects when the timeout wins the race", async () => {
		const neverResolves = new Promise(() => {});
		await expect(withTimeout(neverResolves, 5, "slow operation")).rejects.toThrow("slow operation");
	});
});
