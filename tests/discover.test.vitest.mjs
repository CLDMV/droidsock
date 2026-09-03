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
	return new Promise((resolve) => {
		const server = net.createServer((socket) => socket.end());
		openServers.push(server);
		server.listen(0, address, () => resolve(server.address().port));
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

	test("sweeps a /32 as a single host", async () => {
		droidsock = await createDroidSock();
		const port = await listenOn("127.0.0.9");
		const results = await droidsock.discover.subnet("127.0.0.9/32", port, { timeoutMs: 300 });
		expect(results).toEqual([{ host: "127.0.0.9", port }]);
	});
});

/**
 * Builds a minimal DNS name encoding (no compression) matching
 * discover.mjs's own encodeDnsName, for constructing fake mDNS responses.
 * @param {string} name - Dotted name.
 * @returns {Buffer} Encoded name.
 */
function encodeName(name) {
	const labels = name
		.replace(/\.$/, "")
		.split(".")
		.filter(Boolean)
		.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "utf8")]));
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

	const txtEntries = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
	const txtRdata = Buffer.concat(txtEntries.map((entry) => Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry, "utf8")])));
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
});
