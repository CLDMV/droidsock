/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/discover.test.vitest.mjs
 *	@Date: 2026-09-02 16:10:37 -07:00 (1788390637)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-02 16:12:09 -07:00 (1788390729)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import createDroidSock from "../index.mjs";
import { ipv6ToBigInt } from "../src/api/utils.mjs";

// CI runners aren't guaranteed to have IPv6 loopback available - probe once
// and skip only the tests that need a real IPv6 socket bind. The pure
// BigInt/CIDR-math tests need no network at all and always run.
const hasIpv6Loopback = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.once("error", () => resolve(false));
	probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

/**
 * Encodes an IPv6 address string into its raw 16-byte AAAA rdata form.
 * @param {string} address - IPv6 literal.
 * @returns {Buffer} 16-byte address.
 */
function ipv6ToBytes(address) {
	const value = ipv6ToBigInt(address);
	const buf = Buffer.alloc(16);
	buf.writeBigUInt64BE(value >> 64n, 0);
	buf.writeBigUInt64BE(value & 0xffffffffffffffffn, 8);
	return buf;
}

// Following the repo's established preference for real loopback I/O over
// mocking node:net/node:dgram (see forward.test.vitest.mjs): subnet() is
// exercised against real listeners bound to distinct 127.0.0.0/8 addresses
// (all of which route to loopback on Linux), and mdns() against a real UDP
// responder on 127.0.0.1 instead of the actual multicast group.

let droidsock;
const openServers = [];
const openSockets = [];

afterEach(async () => {
	while (openServers.length) {
		const server = openServers.pop();
		await new Promise((resolve) => server.close(() => resolve()));
	}
	while (openSockets.length) {
		const socket = openSockets.pop();
		await new Promise((resolve) => socket.close(() => resolve()));
	}
	if (droidsock?.shutdown) await droidsock.shutdown();
	droidsock = undefined;
});

/**
 * Starts a bare TCP listener on a specific loopback address, tracked for
 * automatic teardown in afterEach().
 * @param {string} address - Address to bind (e.g. "127.0.0.5").
 * @returns {Promise<number>} The bound port.
 */
function listenOn(address) {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => socket.end());
		server.once("error", reject);
		server.listen(0, address, () => {
			openServers.push(server);
			resolve(server.address().port);
		});
	});
}

describe("discover.subnet", () => {
	test("finds only the reachable host, excluding network/broadcast addresses", async () => {
		droidsock = await createDroidSock();
		// 127.0.0.4/30 -> network .4, usable .5/.6, broadcast .7. Only .5 listens.
		const port = await listenOn("127.0.0.5");

		const results = await droidsock.discover.subnet("127.0.0.4/30", port, { timeoutMs: 300 });

		expect(results).toEqual([{ host: "127.0.0.5", port }]);
	});

	test("returns an empty array when nothing in range is reachable", async () => {
		droidsock = await createDroidSock();
		const results = await droidsock.discover.subnet("127.0.0.8/30", 65534, { timeoutMs: 200 });
		expect(results).toEqual([]);
	});

	test("rejects a CIDR whose sweep range exceeds maxHosts, without attempting any connection", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("10.0.0.0/8", 5555, { maxHosts: 1024 })).rejects.toThrow(/maxHosts/);
	});

	test("rejects a malformed CIDR", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("not-a-cidr", 5555)).rejects.toThrow("Invalid CIDR");
	});

	test.each([["1.2.3.4/24/extra"], ["1.2.3.4/"], ["1.2.3.4/1e1"], ["1.2.3.4/-1"]])(
		"rejects a malformed CIDR prefix (%p) instead of silently coercing it",
		async (cidr) => {
			droidsock = await createDroidSock();
			await expect(droidsock.discover.subnet(cidr, 5555)).rejects.toThrow("Invalid CIDR");
		}
	);

	test("rejects an invalid port without attempting any connection", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("127.0.0.4/30", 0)).rejects.toThrow("Invalid port");
		await expect(droidsock.discover.subnet("127.0.0.4/30", 70000)).rejects.toThrow("Invalid port");
	});

	test("rejects a non-positive timeoutMs", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { timeoutMs: 0 })).rejects.toThrow("Invalid timeoutMs");
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { timeoutMs: -5 })).rejects.toThrow("Invalid timeoutMs");
	});

	test("rejects a non-positive concurrency instead of silently sweeping nothing", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { concurrency: 0 })).rejects.toThrow("Invalid concurrency");
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { concurrency: -1 })).rejects.toThrow("Invalid concurrency");
	});

	test("rejects a non-positive maxHosts", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { maxHosts: 0 })).rejects.toThrow("Invalid maxHosts");
	});

	test("sweeps a /32 as a single host", async () => {
		droidsock = await createDroidSock();
		const port = await listenOn("127.0.0.9");
		const results = await droidsock.discover.subnet("127.0.0.9/32", port, { timeoutMs: 300 });
		expect(results).toEqual([{ host: "127.0.0.9", port }]);
	});

	test("accepts /0 as valid CIDR syntax, rejecting it via maxHosts rather than as an invalid prefix", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("0.0.0.0/0", 5555, { maxHosts: 1024 })).rejects.toThrow(/maxHosts/);
	});

	test("reachable hosts stay in ascending address order across a sweep", async () => {
		// Targets the sort comparator directly: sorting by a re-parsed host
		// (rather than sweep index) either throws for an IPv6 BigInt result or
		// silently no-sorts on NaN - this pins the correct (sorted) outcome for
		// the plain-IPv4 case the comparator has always had to handle too.
		droidsock = await createDroidSock();
		const portA = await listenOn("127.0.0.5");
		const server6 = net.createServer((socket) => socket.end());
		await new Promise((resolve, reject) => {
			server6.once("error", reject);
			server6.listen(portA, "127.0.0.6", resolve);
		});
		openServers.push(server6);

		const results = await droidsock.discover.subnet("127.0.0.4/30", portA, { timeoutMs: 300 });
		expect(results).toEqual([
			{ host: "127.0.0.5", port: portA },
			{ host: "127.0.0.6", port: portA }
		]);
	});
});

describe("discover.subnet - IPv6 CIDR boundaries (host counts, no network needed)", () => {
	test("a /126 has exactly 4 sweepable hosts - no network/broadcast exclusion, unlike IPv4", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("2001:db8::/126", 5555, { maxHosts: 3 })).rejects.toThrow(/has 4 sweepable host\(s\)/);
	});

	test("a /127 has exactly 2 sweepable hosts", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("2001:db8::/127", 5555, { maxHosts: 1 })).rejects.toThrow(/has 2 sweepable host\(s\)/);
	});

	test("a /128 has exactly 1 sweepable host - the maxHosts guard does not fire", async () => {
		droidsock = await createDroidSock();
		const results = await droidsock.discover.subnet("2001:db8::1/128", 5555, { maxHosts: 1, timeoutMs: 200 });
		expect(results).toEqual([]);
	});

	test("IPv4 exclusion regression: a /30 still excludes network+broadcast (2 sweepable hosts, not 4)", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("127.0.0.4/30", 5555, { maxHosts: 1 })).rejects.toThrow(/has 2 sweepable host\(s\)/);
	});

	test("an IPv6 /64 is rejected with its real, exact BigInt count", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("2001:db8::/64", 5555, { maxHosts: 1024 })).rejects.toThrow(
			/has 18446744073709551616 sweepable host\(s\)/
		);
	});

	test("::/0 is rejected with its real, exact (astronomically large) BigInt count", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("::/0", 5555, { maxHosts: 1024 })).rejects.toThrow(
			/has 340282366920938463463374607431768211456 sweepable host\(s\)/
		);
	});

	test("a huge count never renders as Infinity or scientific notation", async () => {
		droidsock = await createDroidSock();
		try {
			await droidsock.discover.subnet("2001:db8::/32", 5555, { maxHosts: 1024 });
			throw new Error("expected subnet() to reject");
		} catch (error) {
			expect(error.message).toMatch(/sweepable host\(s\)/);
			expect(error.message).not.toMatch(/Infinity|e\+/);
		}
	});

	test("rejects an IPv6 prefix over 128", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("2001:db8::/129", 5555)).rejects.toThrow("Invalid CIDR prefix (must be 0-128)");
	});

	test("the prefix bound is family-derived, not a hardcoded number - the same numeral means different limits", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("192.168.0.0/33", 5555)).rejects.toThrow("Invalid CIDR prefix (must be 0-32)");
		await expect(droidsock.discover.subnet("2001:db8::/33", 5555, { maxHosts: 1024 })).rejects.toThrow(/maxHosts/);
	});

	test("rejects a zone/scope id in a CIDR base address", async () => {
		// net.isIP() accepts a zone id (so the CIDR's family detection succeeds),
		// but ipv6ToBigInt() rejects it - see utils.mjs's ipv6ToBigInt for why a
		// zone can't be represented in a 128-bit value. The more specific error
		// from ipv6ToBigInt surfaces here rather than a generic "Invalid CIDR".
		droidsock = await createDroidSock();
		await expect(droidsock.discover.subnet("fe80::1%eth0/128", 5555)).rejects.toThrow("Invalid IPv6 address");
	});
});

describe.skipIf(!hasIpv6Loopback)("discover.subnet - real IPv6 loopback", () => {
	test("finds a real IPv6 loopback listener via a /128 sweep", async () => {
		droidsock = await createDroidSock();
		const port = await listenOn("::1");
		const results = await droidsock.discover.subnet("::1/128", port, { timeoutMs: 300 });
		expect(results).toEqual([{ host: "::1", port }]);
	});

	test("finds nothing on a /127 sweep of ::2 - deliberately never sweeps :: itself (matches any local listener, like 0.0.0.0)", async () => {
		droidsock = await createDroidSock();
		const results = await droidsock.discover.subnet("::2/127", 65534, { timeoutMs: 200 });
		expect(results).toEqual([]);
	});
});

/**
 * Builds a minimal DNS name encoding (no compression) matching
 * discover.mjs's own encodeDnsName, for constructing fake mDNS responses.
 * @param {string} name - Dotted name.
 * @returns {Buffer} Encoded name.
 */
function encodeName(name) {
	// Length-prefix each label with its UTF-8 BYTE length, not the source
	// string's .length (UTF-16 code units) - the two diverge for any
	// non-ASCII label, matching discover.mjs's own encodeDnsName.
	const labels = name
		.replace(/\.$/, "")
		.split(".")
		.filter(Boolean)
		.map((label) => {
			const labelBuf = Buffer.from(label, "utf8");
			return Buffer.concat([Buffer.from([labelBuf.length]), labelBuf]);
		});
	return Buffer.concat([...labels, Buffer.from([0])]);
}

/**
 * Builds a raw resource record (owner name + type/class/ttl/rdata), matching
 * the wire format discover.mjs's readDnsRecord parses.
 * @param {string} name - Owner name.
 * @param {number} type - DNS record type.
 * @param {Buffer} rdata - Pre-built rdata for this record type.
 * @returns {Buffer} The encoded record.
 */
function buildRecord(name, type, rdata) {
	const header = Buffer.alloc(10);
	header.writeUInt16BE(type, 0);
	header.writeUInt16BE(1, 2); // class IN
	header.writeUInt32BE(120, 4); // ttl
	header.writeUInt16BE(rdata.length, 8);
	return Buffer.concat([encodeName(name), header, rdata]);
}

/**
 * Builds a full fake mDNS response: one PTR (answer) naming an instance,
 * plus SRV/TXT/A for that instance in the additional section - mirroring how
 * a real responder commonly splits records across sections.
 * @param {Object} device - Device fields to encode.
 * @param {string} device.serviceType - Queried service type.
 * @param {string} device.instanceName - Service instance name.
 * @param {string} device.hostname - SRV target hostname.
 * @param {number} device.port - SRV port.
 * @param {string} device.address - A record IPv4 address.
 * @param {Object} device.txt - TXT key/value pairs.
 * @returns {Buffer} A complete DNS message.
 */
function buildMdnsResponse({ serviceType, instanceName, hostname, port, address, txt }) {
	const ptrRdata = encodeName(instanceName);
	const srvRdata = Buffer.alloc(6);
	srvRdata.writeUInt16BE(0, 0); // priority
	srvRdata.writeUInt16BE(0, 2); // weight
	srvRdata.writeUInt16BE(port, 4);
	const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));

	// Length-prefix each entry with its UTF-8 BYTE length, not the source
	// string's .length (UTF-16 code units) - see encodeName()'s comment above.
	const txtEntries = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
	const txtRdata = Buffer.concat(
		txtEntries.map((entry) => {
			const entryBuf = Buffer.from(entry, "utf8");
			return Buffer.concat([Buffer.from([entryBuf.length]), entryBuf]);
		})
	);
	const txtRecord = buildRecord(instanceName, 16, txtRdata.length > 0 ? txtRdata : Buffer.from([0]));

	const aRdata = Buffer.from(address.split(".").map(Number));
	const aRecord = buildRecord(hostname, 1, aRdata);

	const ptrRecord = buildRecord(serviceType, 12, ptrRdata);

	// PTR + TXT go in the answer section, SRV + A in additional - an arbitrary
	// but valid split (parseDnsMessage merges all three sections anyway), just
	// exercising that the parser doesn't assume every record lives in ANCOUNT.
	const header = Buffer.alloc(12);
	header.writeUInt16BE(2, 6); // ANCOUNT: PTR + TXT
	header.writeUInt16BE(2, 10); // ARCOUNT: SRV + A

	return Buffer.concat([header, ptrRecord, txtRecord, srvRecord, aRecord]);
}

describe("discover.mdns", () => {
	test("parses a PTR+SRV+TXT+A response into a resolved device entry", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		responder.on("message", (_msg, rinfo) => {
			const response = buildMdnsResponse({
				serviceType,
				instanceName: "My Device._adb-tls-connect._tcp.local",
				hostname: "my-device.local",
				port: 12345,
				address: "10.6.0.42",
				txt: { name: "My Device" }
			});
			responder.send(response, rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([
			{
				name: "My Device._adb-tls-connect._tcp.local",
				host: "10.6.0.42",
				port: 12345,
				txt: { name: "My Device" }
			}
		]);
		// toEqual doesn't compare prototypes (a plain-object txt would still
		// pass the assertion above), so the null-proto hardening needs its own
		// explicit check to actually catch a regression back to {}.
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
	});

	test("resolves to an empty array when no responder answers", async () => {
		droidsock = await createDroidSock();
		const results = await droidsock.discover.mdns({ address: "127.0.0.1", port: 65533, timeoutMs: 200 });
		expect(results).toEqual([]);
	});

	test("ignores SRV/TXT/A records for a name no PTR record introduced", async () => {
		// Joining the multicast group also receives every OTHER service's mDNS
		// traffic on the segment - an unrelated SRV+TXT+A triple (no PTR for our
		// queried service) must not be fabricated into a device entry.
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		responder.on("message", (_msg, rinfo) => {
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(12345, 4);
			const srvRecord = buildRecord(
				"some-other-service._airplay._tcp.local",
				33,
				Buffer.concat([srvRdata, encodeName("other-host.local")])
			);
			const aRecord = buildRecord("other-host.local", 1, Buffer.from([10, 6, 0, 99]));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(2, 6); // ANCOUNT: SRV + A, no PTR
			responder.send(Buffer.concat([header, srvRecord, aRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType: "_adb-tls-connect._tcp.local",
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 300
		});

		expect(results).toEqual([]);
	});

	test("ignores a zero-length TXT entry and stops at a truncated one, keeping valid entries", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Weird TXT Device._adb-tls-connect._tcp.local";
		const hostname = "weird-txt-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));

			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(4321, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));

			const aRecord = buildRecord(hostname, 1, Buffer.from([10, 0, 0, 5]));

			// "a=1", then a zero-length entry (RFC 6763's "no TXT data"), then a
			// length byte claiming 10 bytes with only 2 actually remaining.
			const txtRdata = Buffer.concat([
				Buffer.from([3]),
				Buffer.from("a=1", "utf8"),
				Buffer.from([0]),
				Buffer.from([10]),
				Buffer.from("xy", "utf8")
			]);
			const txtRecord = buildRecord(instanceName, 16, txtRdata);

			const header = Buffer.alloc(12);
			header.writeUInt16BE(2, 6); // ANCOUNT: PTR + TXT
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + A
			responder.send(Buffer.concat([header, ptrRecord, txtRecord, srvRecord, aRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.5", port: 4321, txt: { a: "1" } }]);
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
	});

	test("keeps a __proto__ TXT key inert - txt objects are null-prototype, not plain objects", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Proto Device._adb-tls-connect._tcp.local";
		const hostname = "proto-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));

			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(9999, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));

			const aRecord = buildRecord(hostname, 1, Buffer.from([10, 0, 0, 6]));

			// A TXT entry literally keyed "__proto__" - on a plain {} this key
			// interacts with Object.prototype's __proto__ accessor; on a
			// null-prototype object it's just an ordinary own property.
			const protoEntry = "__proto__=polluted";
			const txtRdata = Buffer.concat([Buffer.from([protoEntry.length]), Buffer.from(protoEntry, "utf8")]);
			const txtRecord = buildRecord(instanceName, 16, txtRdata);

			const header = Buffer.alloc(12);
			header.writeUInt16BE(2, 6); // ANCOUNT: PTR + TXT
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + A
			responder.send(Buffer.concat([header, ptrRecord, txtRecord, srvRecord, aRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toHaveLength(1);
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
		expect(results[0].txt["__proto__"]).toBe("polluted");
		// Sanity: the global Object.prototype itself was never touched.
		expect(Object.getPrototypeOf({})).toBe(Object.prototype);
	});

	test("round-trips a non-ASCII instance name correctly", async () => {
		// A label's DNS length-prefix byte must be its UTF-8 BYTE length, not
		// its JS string .length (UTF-16 code units) - the two diverge for any
		// non-ASCII character. This exercises both this test file's encodeName
		// helper and discover.mjs's own decodeDnsName/encodeDnsName.
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Café Device ☕._adb-tls-connect._tcp.local";
		const hostname = "cafe-device.local";

		responder.on("message", (_msg, rinfo) => {
			const response = buildMdnsResponse({
				serviceType,
				instanceName,
				hostname,
				port: 4444,
				address: "10.0.0.9",
				txt: {}
			});
			responder.send(response, rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.9", port: 4444, txt: {} }]);
	});

	test("round-trips a non-ASCII TXT value correctly", async () => {
		// Same UTF-8-byte-length-vs-JS-.length distinction as the instance-name
		// test above, but for buildMdnsResponse()'s TXT encoding specifically.
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Emoji TXT Device._adb-tls-connect._tcp.local";
		const hostname = "emoji-txt-device.local";

		responder.on("message", (_msg, rinfo) => {
			const response = buildMdnsResponse({
				serviceType,
				instanceName,
				hostname,
				port: 7777,
				address: "10.0.0.10",
				txt: { name: "Café ☕ Device" }
			});
			responder.send(response, rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.10", port: 7777, txt: { name: "Café ☕ Device" } }]);
	});

	test("rejects a serviceType with a DNS label longer than 63 bytes", async () => {
		droidsock = await createDroidSock();
		const longLabel = "a".repeat(64);
		await expect(
			droidsock.discover.mdns({ serviceType: `${longLabel}._tcp.local`, address: "127.0.0.1", port: 1, timeoutMs: 200 })
		).rejects.toThrow("DNS label too long");
	});

	test("rejects a serviceType whose encoded name exceeds 255 bytes", async () => {
		droidsock = await createDroidSock();
		const label = "a".repeat(63);
		const longName = `${Array.from({ length: 5 }, () => label).join(".")}.local`;
		await expect(droidsock.discover.mdns({ serviceType: longName, address: "127.0.0.1", port: 1, timeoutMs: 200 })).rejects.toThrow(
			"DNS name too long"
		);
	});

	test("resolves host when the A record arrives in an earlier message than its SRV", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Split Device._adb-tls-connect._tcp.local";
		const hostname = "split-device.local";

		responder.on("message", (_msg, rinfo) => {
			// First message: PTR + A only - the SRV that needs this A record
			// hasn't been sent yet, exercising the cross-message address cache.
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const aRecord = buildRecord(hostname, 1, Buffer.from([10, 0, 0, 7]));
			const header1 = Buffer.alloc(12);
			header1.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header1.writeUInt16BE(1, 10); // ARCOUNT: A

			// UDP doesn't guarantee delivery order - sending the second message
			// from the first send()'s own completion callback (rather than just
			// issuing both synchronously) makes the enqueue order deterministic
			// instead of relying on it.
			responder.send(Buffer.concat([header1, ptrRecord, aRecord]), rinfo.port, rinfo.address, () => {
				// Second, separate message: SRV only.
				const srvRdata = Buffer.alloc(6);
				srvRdata.writeUInt16BE(6789, 4);
				const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
				const header2 = Buffer.alloc(12);
				header2.writeUInt16BE(1, 10); // ARCOUNT: SRV
				responder.send(Buffer.concat([header2, srvRecord]), rinfo.port, rinfo.address);
			});
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.7", port: 6789, txt: {} }]);
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
	});

	test("ignores a malformed A record (wrong rdlength) instead of caching a garbage address", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Bad A Device._adb-tls-connect._tcp.local";
		const hostname = "bad-a-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));

			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(5555, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));

			// Malformed A record: only 2 rdata bytes instead of the required 4.
			const badARecord = buildRecord(hostname, 1, Buffer.from([10, 0]));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + bad A
			responder.send(Buffer.concat([header, ptrRecord, srvRecord, badARecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 300
		});

		// The entry never resolves a host, so it's filtered out of the final
		// results rather than surfacing a bogus address like "10.0".
		expect(results).toEqual([]);
	});

	test("a malformed A record never overwrites a previously cached valid address", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Stale A Device._adb-tls-connect._tcp.local";
		const hostname = "stale-a-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(5556, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			const goodARecord = buildRecord(hostname, 1, Buffer.from([10, 0, 0, 8]));

			// First message: PTR + SRV + a valid A record.
			const header1 = Buffer.alloc(12);
			header1.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header1.writeUInt16BE(2, 10); // ARCOUNT: SRV + A

			// UDP doesn't guarantee delivery order - sending the second message
			// from the first send()'s own completion callback makes the enqueue
			// order deterministic instead of relying on it.
			responder.send(Buffer.concat([header1, ptrRecord, srvRecord, goodARecord]), rinfo.port, rinfo.address, () => {
				// Second, separate message: a malformed A record for the same
				// hostname - must not clobber the already-cached valid address.
				const badARecord = buildRecord(hostname, 1, Buffer.from([9, 9]));
				const header2 = Buffer.alloc(12);
				header2.writeUInt16BE(1, 10); // ARCOUNT: bad A
				responder.send(Buffer.concat([header2, badARecord]), rinfo.port, rinfo.address);
			});
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.8", port: 5556, txt: {} }]);
	});

	test("ignores a PTR record whose declared rdlength is too small for the encoded name, without corrupting the record that follows it", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const goodInstanceName = "Good Device._adb-tls-connect._tcp.local";
		const goodHostname = "good-device.local";

		responder.on("message", (_msg, rinfo) => {
			// A PTR record whose header declares an rdlength (2 bytes) too small to
			// hold a complete name - the rdata is just a label-length byte of 1
			// followed by a single letter, with no terminating zero byte inside
			// those 2 bytes. Without a bounds check, decodeDnsName() doesn't know
			// about rdlength and keeps reading labels past it, straight into the
			// real record that immediately follows on the wire (fabricating a
			// name from those bytes instead of stopping at this record's
			// boundary). The record that follows is placed directly after these
			// 2 rdata bytes, matching the declared rdlength exactly, so
			// readDnsRecord()'s resync to the next record (always rdataStart +
			// rdlength, regardless of how far a malformed record's own parsing
			// wandered) lands exactly on it either way.
			const badPtrHeader = Buffer.alloc(10);
			badPtrHeader.writeUInt16BE(12, 0); // type PTR
			badPtrHeader.writeUInt16BE(1, 2); // class IN
			badPtrHeader.writeUInt32BE(120, 4); // ttl
			badPtrHeader.writeUInt16BE(2, 8); // rdlength: 2 bytes, no room for a full name
			const badPtrRdata = Buffer.from([1, 0x46]); // label length 1, then "F" - never terminates
			const badPtrRecord = Buffer.concat([encodeName(serviceType), badPtrHeader, badPtrRdata]);

			const goodPtrRecord = buildRecord(serviceType, 12, encodeName(goodInstanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(5555, 4);
			const goodSrvRecord = buildRecord(goodInstanceName, 33, Buffer.concat([srvRdata, encodeName(goodHostname)]));
			const goodTxtRecord = buildRecord(goodInstanceName, 16, Buffer.from([0])); // zero-length entry = "no data"
			const goodARecord = buildRecord(goodHostname, 1, Buffer.from([10, 0, 0, 9]));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(2, 6); // ANCOUNT: bad PTR + good PTR
			header.writeUInt16BE(3, 10); // ARCOUNT: good SRV + TXT + A
			responder.send(
				Buffer.concat([header, badPtrRecord, goodPtrRecord, goodSrvRecord, goodTxtRecord, goodARecord]),
				rinfo.port,
				rinfo.address
			);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		// No "Fake..." entry from the malformed PTR, and the legitimate device
		// after it still parses correctly - readDnsRecord() always resyncs to the
		// next record via the header's declared rdlength, regardless of how far
		// a malformed record's own rdata parsing wandered.
		expect(results).toEqual([{ name: goodInstanceName, host: "10.0.0.9", port: 5555, txt: {} }]);
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
	});

	test("ignores an SRV record whose declared rdlength is too small to hold priority/weight/port", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Bad SRV Device._adb-tls-connect._tcp.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));

			// SRV rdata needs at least 6 bytes (priority+weight+port) before the
			// target name even starts; this one declares only 2.
			const badSrvHeader = Buffer.alloc(10);
			badSrvHeader.writeUInt16BE(33, 0); // type SRV
			badSrvHeader.writeUInt16BE(1, 2); // class IN
			badSrvHeader.writeUInt32BE(120, 4); // ttl
			badSrvHeader.writeUInt16BE(2, 8); // rdlength: too small for priority/weight/port
			const badSrvRecord = Buffer.concat([encodeName(instanceName), badSrvHeader, Buffer.from([0, 0])]);

			const header = Buffer.alloc(12);
			header.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header.writeUInt16BE(1, 10); // ARCOUNT: bad SRV
			responder.send(Buffer.concat([header, ptrRecord, badSrvRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 300
		});

		// The PTR introduces the entry, but the malformed SRV never resolves a
		// host/port for it, so it's filtered out of the final results.
		expect(results).toEqual([]);
	});

	test("rejects an invalid port without opening a socket", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.mdns({ port: 0 })).rejects.toThrow("Invalid port");
		await expect(droidsock.discover.mdns({ port: 70000 })).rejects.toThrow("Invalid port");
	});

	test("rejects a non-positive timeoutMs", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.mdns({ timeoutMs: 0 })).rejects.toThrow("Invalid timeoutMs");
		await expect(droidsock.discover.mdns({ timeoutMs: -5 })).rejects.toThrow("Invalid timeoutMs");
	});
});

describe("discover.mdns - IPv6 (AAAA), over the existing IPv4 (udp4) transport", () => {
	test("rejects an invalid family", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.mdns({ family: 5 })).rejects.toThrow("Invalid family");
	});

	test("rejects a family that doesn't match a given literal address", async () => {
		droidsock = await createDroidSock();
		await expect(droidsock.discover.mdns({ family: 6, address: "127.0.0.1", port: 5353 })).rejects.toThrow("Invalid address");
	});

	test("AAAA rdata resolves a device entry - correlation doesn't depend on the query's own transport family", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "AAAA Device._adb-tls-connect._tcp.local";
		const hostname = "aaaa-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(4242, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			const aaaaRecord = buildRecord(hostname, 28, ipv6ToBytes("2001:db8::42"));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + AAAA
			responder.send(Buffer.concat([header, ptrRecord, srvRecord, aaaaRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "2001:db8::42", port: 4242, txt: {} }]);
	});

	test("ignores a malformed AAAA record (wrong rdlength) instead of caching a garbage address", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Bad AAAA Device._adb-tls-connect._tcp.local";
		const hostname = "bad-aaaa-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(5555, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			// Malformed AAAA: only 8 rdata bytes instead of the required 16.
			const badAaaaRecord = buildRecord(hostname, 28, Buffer.alloc(8));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + bad AAAA
			responder.send(Buffer.concat([header, ptrRecord, srvRecord, badAaaaRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 300
		});

		expect(results).toEqual([]);
	});

	test("a malformed AAAA record never clobbers a previously cached valid address", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Stale AAAA Device._adb-tls-connect._tcp.local";
		const hostname = "stale-aaaa-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(5557, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			const goodAaaaRecord = buildRecord(hostname, 28, ipv6ToBytes("2001:db8::99"));

			const header1 = Buffer.alloc(12);
			header1.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header1.writeUInt16BE(2, 10); // ARCOUNT: SRV + AAAA
			// UDP doesn't guarantee delivery order - sending the second message
			// from the first send()'s own completion callback makes the enqueue
			// order deterministic instead of relying on it.
			responder.send(Buffer.concat([header1, ptrRecord, srvRecord, goodAaaaRecord]), rinfo.port, rinfo.address, () => {
				const badAaaaRecord = buildRecord(hostname, 28, Buffer.alloc(8));
				const header2 = Buffer.alloc(12);
				header2.writeUInt16BE(1, 10); // ARCOUNT: bad AAAA
				responder.send(Buffer.concat([header2, badAaaaRecord]), rinfo.port, rinfo.address);
			});
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "2001:db8::99", port: 5557, txt: {} }]);
	});

	test("a routable A record beats a link-local AAAA for the same hostname, regardless of which arrives first (address ranking)", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp4");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "127.0.0.1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "Dual Stack Device._adb-tls-connect._tcp.local";
		const hostname = "dual-stack-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(6001, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			// A real Android wireless-debugging responder routinely advertises
			// both - the link-local AAAA is unusable here (no zone/scope id to
			// carry it), so the routable A must win even though it's processed
			// FIRST here (a naive last-record-wins would let the AAAA below
			// clobber it - only the ranking prevents that).
			const aRecord = buildRecord(hostname, 1, Buffer.from([10, 0, 0, 55]));
			const aaaaRecord = buildRecord(hostname, 28, ipv6ToBytes("fe80::1"));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(1, 6); // ANCOUNT: PTR
			header.writeUInt16BE(3, 10); // ARCOUNT: SRV + A + AAAA
			responder.send(Buffer.concat([header, ptrRecord, srvRecord, aRecord, aaaaRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			address: "127.0.0.1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "10.0.0.55", port: 6001, txt: {} }]);
	});
});

describe.skipIf(!hasIpv6Loopback)("discover.mdns - real IPv6 (udp6) transport", () => {
	test("queries over a real udp6 socket and resolves a PTR+SRV+TXT+AAAA response", async () => {
		droidsock = await createDroidSock();

		const responder = dgram.createSocket("udp6");
		openSockets.push(responder);
		const responderPort = await new Promise((resolve) => {
			responder.bind(0, "::1", () => resolve(responder.address().port));
		});

		const serviceType = "_adb-tls-connect._tcp.local";
		const instanceName = "IPv6 Device._adb-tls-connect._tcp.local";
		const hostname = "ipv6-device.local";

		responder.on("message", (_msg, rinfo) => {
			const ptrRecord = buildRecord(serviceType, 12, encodeName(instanceName));
			const srvRdata = Buffer.alloc(6);
			srvRdata.writeUInt16BE(6002, 4);
			const srvRecord = buildRecord(instanceName, 33, Buffer.concat([srvRdata, encodeName(hostname)]));
			const txtRdata = Buffer.concat([Buffer.from([4]), Buffer.from("a=v6", "utf8")]);
			const txtRecord = buildRecord(instanceName, 16, txtRdata);
			const aaaaRecord = buildRecord(hostname, 28, ipv6ToBytes("2001:db8::6"));

			const header = Buffer.alloc(12);
			header.writeUInt16BE(2, 6); // ANCOUNT: PTR + TXT
			header.writeUInt16BE(2, 10); // ARCOUNT: SRV + AAAA
			responder.send(Buffer.concat([header, ptrRecord, txtRecord, srvRecord, aaaaRecord]), rinfo.port, rinfo.address);
		});

		const results = await droidsock.discover.mdns({
			serviceType,
			family: 6,
			address: "::1",
			port: responderPort,
			timeoutMs: 400
		});

		expect(results).toEqual([{ name: instanceName, host: "2001:db8::6", port: 6002, txt: { a: "v6" } }]);
		expect(Object.getPrototypeOf(results[0].txt)).toBeNull();
	});
});
