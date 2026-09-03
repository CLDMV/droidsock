/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/discover.mjs
 *	@Date: 2026-09-02 16:11:19 -07:00 (1788390679)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-02 16:12:09 -07:00 (1788390729)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Device discovery API module for DroidSock (adb devices / mDNS discovery equivalent)
 */

import { self } from "@cldmv/slothlet/runtime";
import net from "node:net";
import dgram from "node:dgram";
import { isValidIP } from "./utils.mjs";

// DNS record types/classes used by the mDNS query/response this module builds
// and parses. Only the handful mDNS device discovery actually needs.
const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_SRV = 33;
const DNS_CLASS_IN = 1;

// ---------------------------------------------------------------------------
// Subnet sweep (classic fixed-port devices)
// ---------------------------------------------------------------------------

/**
 * Converts a dotted IPv4 string to its 32-bit unsigned integer form.
 * @param {string} ip - Dotted IPv4 address.
 * @returns {number} 32-bit unsigned integer representation.
 */
function ipToInt(ip) {
	const parts = ip.split(".").map(Number);
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Converts a 32-bit unsigned integer back to a dotted IPv4 string.
 * @param {number} int - 32-bit unsigned integer representation.
 * @returns {string} Dotted IPv4 address.
 */
function intToIp(int) {
	return [24, 16, 8, 0].map((shift) => (int >>> shift) & 0xff).join(".");
}

/**
 * Parses a CIDR block into its sweepable host range. Network/broadcast
 * addresses are excluded for prefixes /1-/30; a /31 (point-to-point, RFC
 * 3021) sweeps both addresses, and a /32 sweeps the single address. /0 is
 * accepted per standard CIDR semantics (rejecting it would just be an
 * inaccurate error message) but is always astronomically larger than any
 * sane `maxHosts`, so `subnet()`'s guard rejects it before any sweeping.
 * @param {string} cidr - CIDR block, e.g. "192.168.1.0/24".
 * @returns {{firstHostInt: number, lastHostInt: number, sweepCount: number}} The sweepable range.
 */
function parseCidr(cidr) {
	const [ip, prefixStr] = String(cidr).split("/");
	if (!ip || !isValidIP(ip) || prefixStr === undefined) {
		throw new Error(`Invalid CIDR: ${cidr}`);
	}

	const prefix = Number(prefixStr);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
		throw new Error(`Invalid CIDR prefix (must be 0-32): ${cidr}`);
	}

	const base = ipToInt(ip);
	const hostBits = 32 - prefix;

	if (hostBits === 0) {
		return { firstHostInt: base, lastHostInt: base, sweepCount: 1 };
	}

	if (hostBits === 32) {
		// /0 - JS's `<<` treats a shift amount of 32 as 0 (masked mod 32), so
		// the general mask math below can't represent this case; compute the
		// whole-IPv4-space range directly instead.
		return { firstHostInt: 1, lastHostInt: 0xfffffffe, sweepCount: 0xfffffffe };
	}

	const mask = (~0 << hostBits) >>> 0;
	const network = (base & mask) >>> 0;
	const broadcast = (network | (~mask >>> 0)) >>> 0;

	if (hostBits === 1) {
		return { firstHostInt: network, lastHostInt: broadcast, sweepCount: 2 };
	}

	return { firstHostInt: network + 1, lastHostInt: broadcast - 1, sweepCount: broadcast - network - 1 };
}

/**
 * Attempts a bare TCP connect to `host:port`, resolving whether it succeeded
 * rather than rejecting - a sweep candidate that refuses/times out is just a
 * "not reachable" result, not an error condition.
 * @param {string} host - Candidate host.
 * @param {number} port - Candidate port.
 * @param {number} timeoutMs - Per-connection timeout.
 * @returns {Promise<boolean>} True if a TCP connection was established.
 */
function attemptConnect(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		let settled = false;

		const finish = (reachable) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(reachable);
		};

		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
		socket.connect(port, host);
	});
}

/**
 * Sweeps a list of candidate hosts for a reachable TCP port with bounded
 * concurrency - `concurrency` connect attempts in flight at a time, rather
 * than one at a time (slow) or all at once (can exhaust ephemeral ports/fds
 * on a large range).
 * @param {string[]} hosts - Candidate hosts, in sweep order.
 * @param {number} port - Port to attempt on every host.
 * @param {{timeoutMs: number, concurrency: number}} options - Sweep tuning.
 * @returns {Promise<Array<{host: string, port: number}>>} Reachable hosts, sorted.
 */
async function sweepPool(hosts, port, { timeoutMs, concurrency }) {
	const reachable = [];
	let nextIndex = 0;

	async function worker() {
		for (;;) {
			const i = nextIndex++;
			if (i >= hosts.length) return;
			const host = hosts[i];
			if (await attemptConnect(host, port, timeoutMs)) {
				reachable.push({ host, port });
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker());
	await Promise.all(workers);

	return reachable.sort((a, b) => ipToInt(a.host) - ipToInt(b.host));
}

/**
 * Discovers classic fixed-port ADB devices by sweeping a CIDR block with raw
 * TCP connect attempts on a configurable port - the `adb devices`-equivalent
 * mechanism for devices that don't advertise over mDNS.
 * @param {string} cidr - CIDR block to sweep, e.g. "192.168.1.0/24".
 * @param {number} [port=5555] - Port to probe on every candidate host.
 * @param {Object} [options={}] - Sweep options.
 * @param {number} [options.timeoutMs=500] - Per-host connect timeout in ms.
 * @param {number} [options.concurrency=32] - Maximum in-flight connect attempts.
 * @param {number} [options.maxHosts=1024] - Safety ceiling on the number of addresses a CIDR may sweep; throws rather than sweeping an unbounded range.
 * @returns {Promise<Array<{host: string, port: number}>>} Reachable host:port pairs, sorted by host.
 */
export async function subnet(cidr, port = 5555, options = {}) {
	const { timeoutMs = 500, concurrency = 32, maxHosts = 1024 } = options;

	const range = parseCidr(cidr);
	if (range.sweepCount > maxHosts) {
		throw new Error(
			`CIDR ${cidr} has ${range.sweepCount} sweepable host(s), exceeding maxHosts (${maxHosts}). Use a narrower CIDR or raise maxHosts.`
		);
	}

	const hosts = [];
	for (let ip = range.firstHostInt; ip <= range.lastHostInt; ip++) {
		hosts.push(intToIp(ip));
	}

	self.log.debug(`discover.subnet: sweeping ${hosts.length} host(s) in ${cidr} on port ${port}`);
	return await sweepPool(hosts, port, { timeoutMs, concurrency });
}

// ---------------------------------------------------------------------------
// mDNS discovery (wireless-debugging-advertised devices)
// ---------------------------------------------------------------------------

/**
 * Encodes a DNS name into its length-prefixed-label wire format, terminated
 * by a zero-length label.
 * @param {string} name - Dotted name, e.g. "_adb-tls-connect._tcp.local".
 * @returns {Buffer} Encoded name.
 */
function encodeDnsName(name) {
	const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
	const parts = labels.map((label) => {
		const labelBuf = Buffer.from(label, "utf8");
		return Buffer.concat([Buffer.from([labelBuf.length]), labelBuf]);
	});
	return Buffer.concat([...parts, Buffer.from([0])]);
}

/**
 * Decodes a DNS name starting at `offset`, following compression pointers
 * (the top two bits of a length byte set) as needed. A pointer may jump
 * backward to an earlier name in the same message; `next` always reflects
 * the position just past the *first* pointer/terminator encountered, i.e.
 * where the record continues in the message - not where a followed pointer
 * chain ends.
 * @param {Buffer} buffer - The full DNS message.
 * @param {number} offset - Offset to start decoding at.
 * @returns {{name: string, next: number}} Decoded dotted name and the next read offset.
 */
function decodeDnsName(buffer, offset) {
	const labels = [];
	let pos = offset;
	let next = -1;
	let guard = 0;

	for (;;) {
		if (guard++ > 128) throw new Error("DNS name decoding exceeded compression-pointer guard");
		const len = buffer.readUInt8(pos);

		if (len === 0) {
			pos += 1;
			if (next === -1) next = pos;
			break;
		}

		if ((len & 0xc0) === 0xc0) {
			const pointer = ((len & 0x3f) << 8) | buffer.readUInt8(pos + 1);
			if (next === -1) next = pos + 2;
			pos = pointer;
			continue;
		}

		labels.push(buffer.toString("utf8", pos + 1, pos + 1 + len));
		pos += 1 + len;
	}

	return { name: labels.join("."), next };
}

/**
 * Reads one resource record starting at `offset` - a decoded owner name
 * followed by type/class/ttl/rdlength, with `rdata` parsed according to
 * `type` (PTR/SRV/TXT/A; anything else is left as a raw Buffer).
 * @param {Buffer} buffer - The full DNS message.
 * @param {number} offset - Offset to start reading at.
 * @returns {{name: string, type: number, ttl: number, data: *, next: number}} The parsed record and the offset just past it.
 */
function readDnsRecord(buffer, offset) {
	const { name, next: afterName } = decodeDnsName(buffer, offset);
	let pos = afterName;

	const type = buffer.readUInt16BE(pos);
	pos += 2;
	pos += 2; // class - mDNS repurposes its top bit as a cache-flush flag; unused here
	const ttl = buffer.readUInt32BE(pos);
	pos += 4;
	const rdlength = buffer.readUInt16BE(pos);
	pos += 2;
	const rdataStart = pos;
	const rdataEnd = pos + rdlength;

	let data;
	switch (type) {
		case DNS_TYPE_PTR:
			data = { target: decodeDnsName(buffer, rdataStart).name };
			break;
		case DNS_TYPE_SRV:
			data = {
				priority: buffer.readUInt16BE(rdataStart),
				weight: buffer.readUInt16BE(rdataStart + 2),
				port: buffer.readUInt16BE(rdataStart + 4),
				target: decodeDnsName(buffer, rdataStart + 6).name
			};
			break;
		case DNS_TYPE_TXT: {
			const txt = {};
			let p = rdataStart;
			while (p < rdataEnd) {
				const len = buffer.readUInt8(p);
				p += 1;
				// A zero-length string is RFC 6763's canonical "no TXT data" -
				// not a real key/value entry, so it's skipped rather than
				// recorded as a bogus `{"": true}`. A length claiming more
				// bytes than remain in this record is truncated/malformed;
				// stop here rather than reading past rdataEnd into whatever
				// record follows.
				if (len === 0) continue;
				if (p + len > rdataEnd) break;
				const entry = buffer.toString("utf8", p, p + len);
				p += len;
				const eq = entry.indexOf("=");
				if (eq === -1) txt[entry] = true;
				else txt[entry.slice(0, eq)] = entry.slice(eq + 1);
			}
			data = txt;
			break;
		}
		case DNS_TYPE_A:
			data = Array.from(buffer.subarray(rdataStart, rdataEnd)).join(".");
			break;
		default:
			data = buffer.subarray(rdataStart, rdataEnd);
	}

	return { name, type, ttl, data, next: rdataEnd };
}

/**
 * Parses a full DNS/mDNS message into its resource records. Questions are
 * skipped (device discovery only needs the answer/authority/additional
 * records); the three record sections are merged into one list since a real
 * mDNS responder commonly splits PTR (answer) from SRV/TXT/A (additional).
 * @param {Buffer} buffer - Raw UDP payload.
 * @returns {Array<{name: string, type: number, ttl: number, data: *}>} All resource records in the message.
 */
function parseDnsMessage(buffer) {
	const qdcount = buffer.readUInt16BE(4);
	const ancount = buffer.readUInt16BE(6);
	const nscount = buffer.readUInt16BE(8);
	const arcount = buffer.readUInt16BE(10);

	let offset = 12;
	for (let i = 0; i < qdcount; i++) {
		const { next } = decodeDnsName(buffer, offset);
		offset = next + 4; // qtype + qclass
	}

	const records = [];
	for (let i = 0; i < ancount + nscount + arcount; i++) {
		const record = readDnsRecord(buffer, offset);
		records.push(record);
		offset = record.next;
	}

	return records;
}

/**
 * Builds a single-question mDNS PTR query for `serviceType`.
 * @param {string} serviceType - Service to query, e.g. "_adb-tls-connect._tcp.local".
 * @returns {Buffer} The complete DNS message, ready to send.
 */
function buildPtrQuery(serviceType) {
	const header = Buffer.alloc(12); // ID=0, FLAGS=0 (standard query), QDCOUNT=1, AN/NS/ARCOUNT=0
	header.writeUInt16BE(1, 4);
	const question = Buffer.alloc(4);
	question.writeUInt16BE(DNS_TYPE_PTR, 0);
	question.writeUInt16BE(DNS_CLASS_IN, 2);
	return Buffer.concat([header, encodeDnsName(serviceType), question]);
}

/**
 * Checks whether an IPv4 address falls in the multicast range
 * (224.0.0.0-239.255.255.255, i.e. a first octet of 224-239) - the whole
 * range, not just the well-known mDNS group address.
 * @param {string} address - Dotted IPv4 address.
 * @returns {boolean} True if `address` is a multicast address.
 */
function isMulticastAddress(address) {
	const firstOctet = Number(address.split(".", 1)[0]);
	return Number.isInteger(firstOctet) && firstOctet >= 224 && firstOctet <= 239;
}

/**
 * Folds a batch of parsed records into the running discovery map, keyed by
 * service instance name (PTR's target = SRV/TXT's owner name). A record can
 * arrive before the records it depends on (e.g. an SRV before its target's A
 * record), so entries are updated in place as later records fill them in.
 * @param {Array<{name: string, type: number, data: *}>} records - Records parsed from one message.
 * @param {Map<string, {name: string, host?: string, port?: number, txt: Object, _target?: string}>} results - Running discovery map, mutated in place.
 * @returns {void}
 */
function ingestDnsRecords(records, results) {
	const addresses = new Map();
	for (const record of records) {
		if (record.type === DNS_TYPE_A) addresses.set(record.name, record.data);
	}

	for (const record of records) {
		if (record.type !== DNS_TYPE_PTR) continue;
		const instanceName = record.data.target;
		if (!results.has(instanceName)) {
			results.set(instanceName, { name: instanceName, txt: {} });
		}
	}

	// Only fold SRV/TXT into an instance name a PTR record actually introduced
	// (this message or an earlier one) - joining the multicast group means this
	// socket also receives every OTHER service's mDNS traffic on the segment,
	// and an unrelated SRV+TXT pair must not turn into a fabricated "device".
	for (const record of records) {
		if (record.type === DNS_TYPE_SRV) {
			const entry = results.get(record.name);
			if (!entry) continue;
			entry.port = record.data.port;
			entry._target = record.data.target;
			entry.host = addresses.get(record.data.target) || entry.host;
		} else if (record.type === DNS_TYPE_TXT) {
			const entry = results.get(record.name);
			if (!entry) continue;
			entry.txt = { ...entry.txt, ...record.data };
		}
	}

	for (const entry of results.values()) {
		if (!entry.host && entry._target && addresses.has(entry._target)) {
			entry.host = addresses.get(entry._target);
		}
	}
}

/**
 * Discovers wireless-debugging-advertised devices via mDNS - the
 * `_adb-tls-connect._tcp` / `_adb-tls-pairing._tcp` services Android 11+
 * devices advertise. Hand-written on `dgram` per project decision (see
 * issue #5): sends one PTR query, collects responses for `timeoutMs`, and
 * correlates PTR/SRV/TXT/A records sharing a name into device entries.
 *
 * `address`/`port` default to the real mDNS multicast group/port but are
 * overridable so callers (and tests) can target a specific responder
 * directly instead of joining the multicast group.
 * @param {Object} [options={}] - Query options.
 * @param {string} [options.serviceType="_adb-tls-connect._tcp.local"] - mDNS service to query.
 * @param {string} [options.address="224.0.0.251"] - Destination address for the query.
 * @param {number} [options.port=5353] - Destination port for the query.
 * @param {number} [options.timeoutMs=3000] - How long to collect responses before resolving.
 * @returns {Promise<Array<{name: string, host: string, port: number, txt: Object}>>} Discovered devices with a resolved host and port.
 */
export function mdns(options = {}) {
	const { serviceType = "_adb-tls-connect._tcp.local", address = "224.0.0.251", port = 5353, timeoutMs = 3000 } = options;
	// A compliant mDNS responder replies via MULTICAST back to address:port,
	// not to the querier's source port - so receiving real replies requires
	// binding to that exact port, not an ephemeral one. Direct-unicast targets
	// (tests, or a caller pointing at a specific responder) reply straight to
	// whatever port the query came from, so an ephemeral bind is fine - and
	// avoids a same-host port clash when the target is a loopback responder.
	const isMulticast = isMulticastAddress(address);

	const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
	const results = new Map();
	let settled = false;

	return new Promise((resolve, reject) => {
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.close();
			fn(value);
		};

		socket.on("error", (error) => finish(reject, error));

		socket.on("message", (message) => {
			try {
				ingestDnsRecords(parseDnsMessage(message), results);
			} catch (error) {
				self.log.debug(`discover.mdns: ignoring unparseable response - ${error.message}`);
			}
		});

		const timer = setTimeout(() => {
			finish(
				resolve,
				Array.from(results.values())
					.filter((entry) => entry.host && entry.port)
					.map((entry) => ({ name: entry.name, host: entry.host, port: entry.port, txt: entry.txt }))
			);
		}, timeoutMs);

		socket.bind(isMulticast ? port : 0, () => {
			if (isMulticast) {
				try {
					socket.addMembership(address);
				} catch (error) {
					self.log.debug(`discover.mdns: couldn't join multicast group ${address} - ${error.message}`);
				}
			}

			self.log.debug(`discover.mdns: querying ${serviceType} via ${address}:${port}`);
			socket.send(buildPtrQuery(serviceType), port, address, (error) => {
				if (error) finish(reject, error);
			});
		});
	});
}
