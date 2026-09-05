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
	sanitizeKey,
	escapeShell,
	quoteShellArg,
	timeout,
	withTimeout,
	ipv6ToBigInt,
	bigIntToIpv6
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

	test("parses a bracketed IPv6 host:port", () => {
		expect(parseHostPort("[2001:db8::1]:5555")).toEqual({ host: "2001:db8::1", port: 5555 });
	});

	test("applies the default port to a bracketed IPv6 host with no port attached", () => {
		expect(parseHostPort("[::1]")).toEqual({ host: "::1", port: 5555 });
	});

	test("throws on an unterminated bracket", () => {
		expect(() => parseHostPort("[::1:5555")).toThrow("unterminated '['");
	});

	test("throws when a bracketed host isn't followed by ':port'", () => {
		expect(() => parseHostPort("[::1]5555")).toThrow("expected ':' after ']'");
	});

	test("throws on an invalid port after a bracketed host", () => {
		expect(() => parseHostPort("[::1]:not-a-port")).toThrow("Invalid port");
	});

	test("accepts a bare, complete IPv6 literal with no port attached", () => {
		expect(parseHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1", port: 5555 });
	});

	test("rejects an ambiguous bare multi-colon string that isn't a valid IPv6 literal", () => {
		expect(() => parseHostPort("not:a:valid:v6:literal")).toThrow("bracket an IPv6 address with a port");
	});
});

describe("utils.sanitizeKey", () => {
	test("maps '.' to a single underscore", () => {
		expect(sanitizeKey("10.6.0.108")).toBe("10_6_0_108");
	});

	test("maps ':' to a double underscore, distinguishable from '.'", () => {
		expect(sanitizeKey("10.6.0.108:5555")).toBe("10_6_0_108__5555");
	});

	test("a former '.' and a former ':' no longer collide", () => {
		// The original scheme mapped both to a single "_", so an IPv4 dotted
		// quad's separators and an IPv6 literal's colons could produce
		// identical keys for genuinely different addresses.
		const ipv4Key = sanitizeKey("1.2.3.4");
		const ipv6Key = sanitizeKey("1:2:3:4");
		expect(ipv4Key).not.toBe(ipv6Key);
	});

	test("handles an IPv6 host:port with adjacent colons", () => {
		expect(sanitizeKey("fe80::1:5555")).toBe("fe80____1__5555");
	});
});

describe("utils.ipv6ToBigInt / utils.bigIntToIpv6", () => {
	const canonicalCases = [
		["::", 0n],
		["::1", 1n],
		["1:2:3:4:5:6:7:8", 0x00010002000300040005000600070008n],
		["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", (1n << 128n) - 1n]
	];

	test.each(canonicalCases)("round-trips %s", (text, value) => {
		expect(ipv6ToBigInt(text)).toBe(value);
		expect(bigIntToIpv6(value)).toBe(text);
	});

	test("leading zeros in a group don't affect the parsed value", () => {
		expect(ipv6ToBigInt("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(1n);
	});

	test("is case-insensitive on input, and always emits lowercase", () => {
		expect(ipv6ToBigInt("FE80::1")).toBe(ipv6ToBigInt("fe80::1"));
		expect(bigIntToIpv6(ipv6ToBigInt("FE80::1"))).toBe("fe80::1");
	});

	test("collapses the longest zero run, first run wins a tie (RFC 5952 4.2.3)", () => {
		// 2001:db8:0:0:1:0:0:1 - two zero runs of length 2 - the first (before
		// the "1") must be the one collapsed, not the second.
		expect(bigIntToIpv6(0x20010db8000000000001000000000001n)).toBe("2001:db8::1:0:0:1");
	});

	test("never collapses a run of just one zero group (RFC 5952 4.2.2)", () => {
		expect(bigIntToIpv6(0x20010db8000000010001000100010001n)).toBe("2001:db8:0:1:1:1:1:1");
	});

	test("handles an embedded dotted-IPv4 tail (RFC 4291 2.2.3) numerically, re-emitting hex groups", () => {
		expect(ipv6ToBigInt("::ffff:192.0.2.1")).toBe(0xffffc0000201n);
		expect(bigIntToIpv6(ipv6ToBigInt("::ffff:192.0.2.1"))).toBe("::ffff:c000:201");
	});

	test("rejects a zone/scope id instead of silently dropping it", () => {
		expect(() => ipv6ToBigInt("fe80::1%eth0")).toThrow("Invalid IPv6 address");
	});

	test("rejects a non-IPv6 string", () => {
		expect(() => ipv6ToBigInt("192.168.1.1")).toThrow("Invalid IPv6 address");
		expect(() => ipv6ToBigInt("not-an-address")).toThrow("Invalid IPv6 address");
	});

	test("bigIntToIpv6 rejects a value outside 0..2**128-1", () => {
		expect(() => bigIntToIpv6(-1n)).toThrow("Invalid IPv6 value");
		expect(() => bigIntToIpv6(1n << 128n)).toThrow("Invalid IPv6 value");
	});

	test("bigIntToIpv6 rejects a non-BigInt value", () => {
		expect(() => bigIntToIpv6(1)).toThrow("Invalid IPv6 value");
		expect(() => bigIntToIpv6(null)).toThrow("Invalid IPv6 value");
	});

	test("cross-checked against the platform's own IPv6 canonicalization (WHATWG URL host parsing)", () => {
		for (const [text] of canonicalCases) {
			const oracle = new URL(`http://[${text}]/`).hostname.replace(/^\[|\]$/g, "");
			expect(bigIntToIpv6(ipv6ToBigInt(text))).toBe(oracle);
		}
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

describe("utils.quoteShellArg", () => {
	test("wraps a plain string in single quotes", () => {
		expect(quoteShellArg("/sdcard/file.txt")).toBe("'/sdcard/file.txt'");
	});

	test("escapes an embedded single quote via close-escape-reopen", () => {
		expect(quoteShellArg("it's a test")).toBe("'it'\\''s a test'");
	});

	test("leaves $()/backticks/double-quotes inert - they're not shell-special inside single quotes", () => {
		const input = '$(rm -rf /) `whoami` "quoted"';
		const quoted = quoteShellArg(input);
		expect(quoted).toBe(`'${input}'`);
	});

	test("coerces a non-string argument to a string before quoting", () => {
		expect(quoteShellArg(123)).toBe("'123'");
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
