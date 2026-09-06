/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/utils.mjs
 *	@Date: 2025-11-21 12:19:49 -08:00 (1763756389)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Utility functions API module for DroidSock
 */

import net from "node:net";

/**
 * Parses Android property output into key-value pairs
 * @param {string} propOutput - Output from getprop command
 * @returns {Object} Parsed properties object
 */
export function parseProperties(propOutput) {
	const props = {};
	const lines = propOutput.split("\n");

	for (const line of lines) {
		const match = line.match(/^\[([^\]]+)\]:\s*\[([^\]]*)\]$/);
		if (match) {
			const [, key, value] = match;
			props[key] = value;
		}
	}

	return props;
}

/**
 * Parses ls -la output into structured data
 * @param {string} lsOutput - Output from ls -la command
 * @returns {Array} Array of file/directory objects
 */
export function parseListing(lsOutput) {
	const entries = [];
	const lines = lsOutput.split("\n").filter((line) => line.trim());

	// Skip the first line if it's a total
	const startIdx = lines[0]?.startsWith("total") ? 1 : 0;

	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^([drwx-]+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\d+)\s+(.+?)\s+(.+)$/);

		if (match) {
			const [, permissions, links, owner, group, size, dateTime, name] = match;

			entries.push({
				name,
				permissions,
				links: parseInt(links),
				owner,
				group,
				size: parseInt(size),
				dateTime,
				isDirectory: permissions.startsWith("d"),
				isFile: permissions.startsWith("-"),
				isSymlink: permissions.startsWith("l")
			});
		}
	}

	return entries;
}

/**
 * Parses battery status output
 * @param {string} batteryOutput - Output from dumpsys battery
 * @returns {Object} Parsed battery information
 */
export function parseBattery(batteryOutput) {
	const battery = {};
	const lines = batteryOutput.split("\n");

	for (const line of lines) {
		const match = line.match(/^\s*([^:]+):\s*(.+)$/);
		if (match) {
			let [, key, value] = match;
			key = key.trim();
			value = value.trim();

			// Convert numeric values
			if (/^\d+$/.test(value)) {
				value = parseInt(value);
			}

			battery[key] = value;
		}
	}

	return battery;
}

/**
 * Formats bytes into human-readable format
 * @param {number} bytes - Number of bytes
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted string (e.g., "1.23 MB")
 */
export function formatBytes(bytes, decimals = 2) {
	if (bytes === 0) return "0 Bytes";

	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["Bytes", "KB", "MB", "GB", "TB"];

	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

/**
 * Waits for a specified amount of time
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} [options={}] - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retries. Negative values are clamped to 0 (fn still runs once) with a console.warn.
 * @param {number} [options.baseDelay=1000] - Base delay in ms
 * @param {number} [options.maxDelay=10000] - Maximum delay in ms
 * @param {Function} [options.shouldRetry] - Function to determine if error should be retried
 * @returns {Promise<any>} Result of the function
 */
export async function retry(fn, options = {}) {
	const { baseDelay = 1000, maxDelay = 10000, shouldRetry = () => true } = options;
	let { maxRetries = 3 } = options;

	if (maxRetries < 0) {
		console.warn(`retry: maxRetries must be >= 0, got ${maxRetries} - clamping to 0`);
		maxRetries = 0;
	}

	let lastError;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxRetries || !shouldRetry(error)) {
				throw error;
			}

			const delayMs = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
			await delay(delayMs);
		}
	}

	throw lastError;
}

/**
 * Validates if a string is a valid IP address
 * @param {string} ip - IP address to validate
 * @returns {boolean} True if valid IP address
 */
export function isValidIP(ip) {
	const parts = ip.split(".");
	if (parts.length !== 4) return false;

	return parts.every((part) => {
		const num = parseInt(part, 10);
		return num >= 0 && num <= 255 && part === num.toString();
	});
}

/**
 * Validates if a port number is valid
 * @param {number} port - Port number to validate
 * @returns {boolean} True if valid port
 */
export function isValidPort(port) {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Parses a host:port string. An IPv6 host MUST be bracketed when a port is
 * attached ("[2001:db8::1]:5555") - the standard URL/curl convention - since
 * an IPv6 literal's own colons make a bare "host:port" split ambiguous (which
 * trailing segment is the port?). A bare, unbracketed IPv6 literal with no
 * port is still accepted and gets `defaultPort`.
 * @param {string} hostPort - Host, or host:port string (e.g., "192.168.1.100:5555", "[2001:db8::1]:5555", "2001:db8::1")
 * @param {number} [defaultPort=5555] - Default port if not specified
 * @returns {Object} Object with host and port properties
 */
export function parseHostPort(hostPort, defaultPort = 5555) {
	const str = String(hostPort);

	if (str.startsWith("[")) {
		const closeIdx = str.indexOf("]");
		if (closeIdx === -1) {
			throw new Error(`Invalid host:port (unterminated '[': ${hostPort})`);
		}
		const host = str.slice(1, closeIdx);
		if (!net.isIPv6(host)) {
			throw new Error(`Invalid host:port (bracketed host is not a valid IPv6 address: ${hostPort})`);
		}
		const rest = str.slice(closeIdx + 1);
		if (rest === "") {
			return { host, port: defaultPort };
		}
		if (!rest.startsWith(":")) {
			throw new Error(`Invalid host:port (expected ':' after ']': ${hostPort})`);
		}
		const portStr = rest.slice(1);
		const port = parseInt(portStr, 10);
		if (!isValidPort(port)) {
			throw new Error(`Invalid port: ${portStr}`);
		}
		return { host, port };
	}

	// More than one colon and no brackets is only unambiguous if it's a bare
	// IPv6 literal with no port attached at all - lastIndexOf(":") would
	// otherwise silently chop off the address's own trailing hextet and call
	// it a port (confirmed: parseHostPort("::1") used to return {host: ":",
	// port: 1}). Require brackets to attach a port instead of guessing.
	const colonCount = (str.match(/:/g) || []).length;
	if (colonCount > 1) {
		if (net.isIPv6(str)) {
			return { host: str, port: defaultPort };
		}
		throw new Error(`Invalid host:port - bracket an IPv6 address with a port: [${str}]:<port> (got: ${hostPort})`);
	}

	const colonIndex = str.lastIndexOf(":");

	if (colonIndex === -1) {
		return { host: str, port: defaultPort };
	}

	const host = str.substring(0, colonIndex);
	const portStr = str.substring(colonIndex + 1);
	const port = parseInt(portStr, 10);

	if (!isValidPort(port)) {
		throw new Error(`Invalid port: ${portStr}`);
	}

	return { host, port };
}

/**
 * Sanitizes a "host:port" device id into a slothlet-safe api-path segment.
 * `.` and `:` are ordinary characters in an IP:port string but are the
 * tree's own path-separator-adjacent punctuation, so both are replaced -
 * with DIFFERENT substitutions so the two remain distinguishable. Mapping
 * both to a single "_" (the original scheme) is lossy: an IPv4 dotted quad
 * and an IPv6 literal's colons become indistinguishable runs of underscores.
 * A single "_" marks a former ".", a double "__" marks a former ":" - still
 * fully identifier-safe (letters/digits/underscore only), so
 * `api.devices.<key>` dot-access still works.
 * @param {string} deviceId - `${host}:${port}`
 * @returns {string} A path-safe key, e.g. "10_6_0_108__5555" (from "10.6.0.108:5555"), "fe80____1__5555" (from "fe80::1:5555")
 */
export function sanitizeKey(deviceId) {
	return deviceId.replace(/\./g, "_").replace(/:/g, "__");
}

/**
 * Escapes shell special characters in a string
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeShell(str) {
	return str.replace(/[\\$`"]/g, "\\$&");
}

/**
 * Wraps a string in single quotes for safe interpolation into a POSIX shell
 * command, using the standard close-quote/escaped-quote/reopen-quote technique
 * (`'` -> `'\''`) for any embedded single quotes. Unlike double-quote-based
 * escaping (see escapeShell), a single-quoted string has no metacharacters at
 * all - `$`, backticks, and `"` all pass through inert - so the only character
 * that needs handling is the quote delimiter itself.
 * @param {*} str - Value to quote; coerced via String() if not already a string
 * @returns {string} Single-quoted, shell-safe string
 */
export function quoteShellArg(str) {
	return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validates a `pm install`/`cmd package install` flags array before it's
 * joined and interpolated into a shell command. A non-array throws a
 * confusing TypeError from .join()/.map() with no context; a flag containing
 * whitespace (e.g. a caller passing "--user 0" as one element instead of
 * ["--user", "0"]) would either silently split into multiple argv tokens once
 * joined and re-parsed by the device shell (unquoted interpolation), or - once
 * quoted via quoteShellArg - collapse into a single argv token that `pm
 * install` won't parse as intended. Either way it changes what's actually
 * passed to the device from what the caller specified, so it's rejected
 * outright rather than silently mishandled.
 * @param {*} flags - Value to validate.
 * @returns {Array<string>} The validated flags, unchanged.
 */
export function assertValidFlags(flags) {
	if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === "string" && flag.length > 0 && !/\s/.test(flag))) {
		// JSON.stringify() throws on a circular value - fall back to String()
		// (which can't throw for this) so the validation error itself is never
		// masked by a formatting failure.
		let described;
		try {
			described = JSON.stringify(flags);
		} catch {
			described = String(flags);
		}
		throw new Error(`Invalid flags: ${described} (must be an array of non-empty, whitespace-free strings)`);
	}
	return flags;
}

/** Largest value representable in 128 bits (2**128 - 1). */
const MAX_IPV6 = (1n << 128n) - 1n;

/**
 * Converts an IPv6 address string to its 128-bit BigInt form. Accepts every
 * form `net.isIPv6()` accepts - including an embedded dotted-IPv4 tail
 * ("::ffff:192.0.2.1", RFC 4291 2.2.3) - except a zone/scope id
 * ("fe80::1%eth0"): `net.isIPv6()` accepts one, but a zone has no bit
 * representation in a 128-bit value, and silently dropping it would make the
 * address unusable (a link-local address is meaningless without its zone)
 * rather than just less precise, so it's rejected outright instead of
 * stripped.
 * @param {string} address - IPv6 literal, e.g. "2001:db8::1".
 * @returns {bigint} The address as a 0..2**128-1 BigInt.
 * @throws {Error} If `address` is not a zone-free IPv6 literal.
 */
export function ipv6ToBigInt(address) {
	if (typeof address !== "string" || !net.isIPv6(address) || address.includes("%")) {
		throw new Error(`Invalid IPv6 address: ${String(address)}`);
	}

	let text = address;
	// A trailing dotted quad occupies the last two 16-bit groups - rewrite it
	// into hex groups before the generic split/parse below, which otherwise
	// has no notion of a dotted segment.
	const lastColon = text.lastIndexOf(":");
	if (text.indexOf(".", lastColon) !== -1) {
		const tail = text.slice(lastColon + 1);
		if (!net.isIPv4(tail)) {
			throw new Error(`Invalid IPv6 address: ${address}`);
		}
		const octets = tail.split(".").map(Number);
		const high = ((octets[0] << 8) | octets[1]).toString(16);
		const low = ((octets[2] << 8) | octets[3]).toString(16);
		text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) {
		throw new Error(`Invalid IPv6 address: ${address}`);
	}
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
	// No "::" means all eight groups must be spelled out; with "::" present,
	// the elided run just needs to be zero or more groups.
	const fillCount = tail === null ? 0 : 8 - head.length - tail.length;
	if (tail === null ? head.length !== 8 : fillCount < 0) {
		throw new Error(`Invalid IPv6 address: ${address}`);
	}
	const groups = tail === null ? head : [...head, ...Array(fillCount).fill("0"), ...tail];

	let value = 0n;
	for (const group of groups) {
		// Defensive: net.isIPv6() already guaranteed a well-formed address, but
		// parseInt("") is NaN and BigInt(NaN) throws a RangeError that wouldn't
		// match this module's "Invalid IPv6 address: ..." error style.
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
			throw new Error(`Invalid IPv6 address: ${address}`);
		}
		value = (value << 16n) | BigInt(parseInt(group, 16));
	}
	return value;
}

/**
 * Formats a 128-bit BigInt as a canonical IPv6 string per RFC 5952 section 4:
 * lowercase hex, no leading zeros per group, and the single longest run of
 * two-or-more all-zero groups collapsed to "::" (the first such run wins a
 * tie, and a lone zero group is never collapsed). Byte-identical to a
 * browser/WHATWG IPv6 serialization for the same address. Note this is a
 * numeric, not textual, inverse of ipv6ToBigInt() for an IPv4-mapped address:
 * `bigIntToIpv6(ipv6ToBigInt("::ffff:192.0.2.1"))` re-emits "::ffff:c000:201"
 * rather than the original dotted-quad tail form - the same behavior a
 * browser's URL parser produces.
 * @param {bigint} value - Address value, 0..2**128-1.
 * @returns {string} Canonical IPv6 string, e.g. "2001:db8::1".
 * @throws {Error} If `value` is not a BigInt in range.
 */
export function bigIntToIpv6(value) {
	if (typeof value !== "bigint" || value < 0n || value > MAX_IPV6) {
		throw new Error(`Invalid IPv6 value: ${String(value)} (must be a BigInt in 0..2**128-1)`);
	}

	const groups = [];
	for (let i = 7n; i >= 0n; i--) {
		groups.push(Number((value >> (i * 16n)) & 0xffffn));
	}

	// RFC 5952 4.2.1/4.2.3: the longest zero run is collapsed; a strict ">"
	// (not ">=") keeps the FIRST run on a tie.
	let bestStart = -1;
	let bestLen = 0;
	let curStart = -1;
	let curLen = 0;
	for (let i = 0; i < 8; i++) {
		if (groups[i] !== 0) {
			curStart = -1;
			curLen = 0;
			continue;
		}
		if (curStart === -1) curStart = i;
		curLen++;
		if (curLen > bestLen) {
			bestLen = curLen;
			bestStart = curStart;
		}
	}

	const hex = groups.map((group) => group.toString(16)); // lowercase + no leading zeros, both for free
	// RFC 5952 4.2.2: "::" must never shorten a run of just ONE zero group.
	if (bestLen < 2) {
		return hex.join(":");
	}
	return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/**
 * Creates a timeout promise that rejects after specified time
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Timeout error message
 * @returns {Promise<never>} Promise that rejects on timeout
 */
export function timeout(ms, message = "Operation timed out") {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error(message)), ms);
	});
}

/**
 * Wraps a promise with a timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Timeout error message
 * @returns {Promise<any>} Promise that resolves/rejects with timeout
 */
export function withTimeout(promise, ms, message) {
	return Promise.race([promise, timeout(ms, message)]);
}
