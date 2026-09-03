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
