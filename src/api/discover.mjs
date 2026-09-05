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
import { isValidPort, ipv6ToBigInt, bigIntToIpv6 } from "./utils.mjs";

// DNS record types/classes used by the mDNS query/response this module builds
// and parses. Only the handful mDNS device discovery actually needs.
const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_AAAA = 28;
const DNS_TYPE_SRV = 33;
const DNS_CLASS_IN = 1;

// ---------------------------------------------------------------------------
// Subnet sweep (classic fixed-port devices)
// ---------------------------------------------------------------------------

/**
 * Converts a dotted IPv4 string to its 32-bit form.
 * @param {string} ip - Dotted IPv4 address.
 * @returns {bigint} 32-bit unsigned value.
 */
function ipv4ToBigInt(ip) {
	return ip.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

/**
 * Converts a 32-bit BigInt back to a dotted IPv4 string.
 * @param {bigint} value - 0..2**32-1.
 * @returns {string} Dotted IPv4 address.
 */
function bigIntToIpv4(value) {
	return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");
}

/**
 * Parses a CIDR block (IPv4 or IPv6) into its sweepable host range. Family is
 * detected from the address via `net.isIP()`, which also validates its
 * general shape (malformed octets, wrong group counts, etc. are rejected
 * here rather than by a hand-rolled check) - though `net.isIP()` itself
 * accepts an IPv6 zone id ("fe80::1%eth0"), that specific case is rejected
 * later, inside `ipv6ToBigInt()` (see its doc comment for why). IPv4
 * excludes the network/broadcast address for
 * prefixes /1-/30; a /31 (point-to-point, RFC 3021) sweeps both, /32 sweeps
 * one, and /0 is accepted (rejecting it would just be an inaccurate error
 * message) but always astronomically larger than any sane `maxHosts`.
 *
 * IPv6 has no broadcast concept (RFC 4291) - the all-zeros host is the
 * legitimate subnet-router anycast address, not a reserved non-host address
 * - so an IPv6 prefix sweeps its FULL range with no exclusion: /128 -> 1,
 * /127 -> 2, /126 -> 4. A `/64` (the conventional IPv6 subnet size) has
 * 2**64 hosts, which the existing `maxHosts` guard rejects exactly like an
 * oversized IPv4 CIDR - no special-casing needed to keep an IPv6 sweep
 * bounded to something sane.
 * @param {string} cidr - CIDR block, e.g. "192.168.1.0/24" or "2001:db8::/120".
 * @returns {{family: 4|6, firstHost: bigint, lastHost: bigint, sweepCount: bigint, format: (value: bigint) => string}} The sweepable range.
 */
function parseCidr(cidr) {
	// Split into exactly ip + prefix - split("/") silently drops anything past
	// a second "/" (e.g. "1.2.3.4/24/extra") if only destructured, and an
	// empty prefix ("1.2.3.4/") coerces to 0 via Number("") rather than
	// failing, both of which a bare length/undefined check lets through.
	const parts = String(cidr).split("/");
	const family = parts.length === 2 ? net.isIP(parts[0]) : 0;
	if (family === 0 || !/^\d+$/.test(parts[1])) {
		throw new Error(`Invalid CIDR: ${cidr}`);
	}
	const [address, prefixStr] = parts;

	const addressBits = family === 6 ? 128 : 32;
	const prefix = Number(prefixStr);
	if (prefix > addressBits) {
		throw new Error(`Invalid CIDR prefix (must be 0-${addressBits}): ${cidr}`);
	}

	const format = family === 6 ? bigIntToIpv6 : bigIntToIpv4;
	const base = family === 6 ? ipv6ToBigInt(address) : ipv4ToBigInt(address);
	const hostBits = BigInt(addressBits - prefix);
	const size = 1n << hostBits;
	// Shift-down/shift-up rather than `base & ~(size - 1n)` - same result,
	// but never has to materialize a negative BigInt mask.
	const network = (base >> hostBits) << hostBits;
	const lastAddress = network + size - 1n;

	if (family === 6 || hostBits <= 1n) {
		return { family, firstHost: network, lastHost: lastAddress, sweepCount: size, format };
	}
	return { family, firstHost: network + 1n, lastHost: lastAddress - 1n, sweepCount: size - 2n, format };
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
				// Record the sweep index, not just {host, port}: hosts[] is already
				// built in ascending address order for both IPv4 and IPv6, so index
				// order IS address order - sorting on a re-parsed host would need
				// family-aware BigInt math, and a comparator that returns a BigInt
				// throws (Array.sort() coerces the result via ToNumber()).
				reachable.push({ index: i, host, port });
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker());
	await Promise.all(workers);

	return reachable.sort((a, b) => a.index - b.index).map(({ host, port: p }) => ({ host, port: p }));
}

/**
 * Discovers classic fixed-port ADB devices by sweeping a CIDR block with raw
 * TCP connect attempts on a configurable port - the `adb devices`-equivalent
 * mechanism for devices that don't advertise over mDNS. Accepts an IPv4 or
 * IPv6 CIDR (e.g. "192.168.1.0/24" or "2001:db8::/120") - IPv6 sweeps its
 * full range (no network/broadcast exclusion, see parseCidr), so `maxHosts`
 * is what keeps a `/64`-or-larger sweep from being attempted at all.
 *
 * Note: sweeping a range that includes the IPv4 "any" address (0.0.0.0) or
 * its IPv6 equivalent (::) will report it reachable whenever ANYTHING on the
 * local machine listens on the probed port, regardless of the actual remote
 * network - the same hazard either family has for its own "any" address.
 * @param {string} cidr - CIDR block to sweep, e.g. "192.168.1.0/24" or "2001:db8::/120".
 * @param {number} [port=5555] - Port to probe on every candidate host.
 * @param {Object} [options={}] - Sweep options.
 * @param {number} [options.timeoutMs=500] - Per-host connect timeout in ms.
 * @param {number} [options.concurrency=32] - Maximum in-flight connect attempts.
 * @param {number} [options.maxHosts=1024] - Safety ceiling on the number of addresses a CIDR may sweep; throws rather than sweeping an unbounded range.
 * @returns {Promise<Array<{host: string, port: number}>>} Reachable host:port pairs, sorted by host.
 */
export async function subnet(cidr, port = 5555, options = {}) {
	const { timeoutMs = 500, concurrency = 32, maxHosts = 1024 } = options;

	// concurrency <= 0 would silently spawn zero workers (Array.from clamps a
	// non-positive length to 0), resolving to [] even when hosts ARE reachable
	// - a silent-wrong-result bug, not an error, so it needs an explicit guard
	// rather than relying on something downstream to catch it.
	if (!isValidPort(port)) {
		throw new Error(`Invalid port: ${port}`);
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`Invalid timeoutMs: ${timeoutMs} (must be a positive integer)`);
	}
	if (!Number.isInteger(concurrency) || concurrency <= 0) {
		throw new Error(`Invalid concurrency: ${concurrency} (must be a positive integer)`);
	}
	if (!Number.isInteger(maxHosts) || maxHosts <= 0) {
		throw new Error(`Invalid maxHosts: ${maxHosts} (must be a positive integer)`);
	}

	const range = parseCidr(cidr);
	if (range.sweepCount > maxHosts) {
		throw new Error(
			`CIDR ${cidr} has ${range.sweepCount} sweepable host(s), exceeding maxHosts (${maxHosts}). Use a narrower CIDR or raise maxHosts.`
		);
	}

	const hosts = [];
	for (let value = range.firstHost; value <= range.lastHost; value++) {
		hosts.push(range.format(value));
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
		// RFC 1035 3.1: a label's length byte's top two bits are reserved for
		// compression-pointer signaling, so a real label length is 0-63 - not
		// just "fits in a byte". Without this check, a label >=64 bytes writes
		// a wrong/misleading length (and one >255 bytes silently wraps, since
		// Buffer.from([n]) truncates n to a byte), corrupting the message in a
		// way a receiver (including our own decodeDnsName) can't recover from.
		if (labelBuf.length > 63) {
			throw new Error(`DNS label too long (max 63 bytes): "${label}"`);
		}
		return Buffer.concat([Buffer.from([labelBuf.length]), labelBuf]);
	});
	const encoded = Buffer.concat([...parts, Buffer.from([0])]);
	if (encoded.length > 255) {
		throw new Error(`DNS name too long (max 255 bytes): "${name}"`);
	}
	return encoded;
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
		case DNS_TYPE_PTR: {
			// decodeDnsName() doesn't know rdlength and will happily follow labels
			// past rdataEnd into whatever bytes follow (the next record's header,
			// or beyond) for a truncated/malformed record. Its returned `next` is
			// the position right after the *local* encoding (the pointer bytes, or
			// the terminating zero) - not where a compression pointer leads - so
			// comparing it against rdataEnd catches an over-long name without
			// needing to pre-validate label lengths. A record failing this check
			// gets `data: null`, which ingestDnsRecords() must skip rather than use.
			const ptr = decodeDnsName(buffer, rdataStart);
			data = ptr.next <= rdataEnd ? { target: ptr.name } : null;
			break;
		}
		case DNS_TYPE_SRV: {
			if (rdlength < 6) {
				data = null;
				break;
			}
			const srv = decodeDnsName(buffer, rdataStart + 6);
			data =
				srv.next <= rdataEnd
					? {
							priority: buffer.readUInt16BE(rdataStart),
							weight: buffer.readUInt16BE(rdataStart + 2),
							port: buffer.readUInt16BE(rdataStart + 4),
							target: srv.name
						}
					: null;
			break;
		}
		case DNS_TYPE_TXT: {
			// Null-prototype: TXT keys come straight from network input, and a
			// plain {} would let a key like "__proto__" interact with
			// Object.prototype's accessor once assigned or later merged.
			const txt = Object.create(null);
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
		case DNS_TYPE_AAAA:
			// Unlike A (whose byte-join above produces a string for any length,
			// which the caller then validates), a wrong-length AAAA has no
			// meaningful string form to format at all - and throwing here would
			// abort parseDnsMessage() for the WHOLE datagram, discarding every
			// other valid record alongside it. Emit null instead, which
			// ingestDnsRecords() already treats the same way it treats a
			// malformed A record.
			data = rdlength === 16 ? bigIntToIpv6((buffer.readBigUInt64BE(rdataStart) << 64n) | buffer.readBigUInt64BE(rdataStart + 8)) : null;
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
 * Checks whether an address (IPv4 or IPv6) falls in its family's multicast
 * range - 224.0.0.0-239.255.255.255 (first octet 224-239) for IPv4, ff00::/8
 * (RFC 4291 2.7) for IPv6 - the whole range, not just the well-known mDNS
 * group address. Must stay total (never throw): called with arbitrary
 * caller-supplied `options.address` input, including a plain hostname.
 * @param {string} address - Dotted IPv4 or IPv6 address, optionally with a "%zone" suffix.
 * @returns {boolean} True if `address` is a multicast address.
 */
function isMulticastAddress(address) {
	// A scoped IPv6 group ("ff02::fb%eth0") is still multicast - strip the
	// zone before the numeric check, since ipv6ToBigInt() deliberately
	// rejects a zone id (it has no bit representation).
	const bare = address.split("%", 1)[0];
	if (net.isIPv6(bare)) {
		return ipv6ToBigInt(bare) >> 120n === 0xffn;
	}
	const firstOctet = Number(bare.split(".", 1)[0]);
	return Number.isInteger(firstOctet) && firstOctet >= 224 && firstOctet <= 239;
}

/**
 * Ranks a resolved address so a later record can't downgrade an earlier,
 * better one when both an A and an AAAA arrive for the same hostname (a real
 * Android wireless-debugging responder routinely advertises both, with the
 * AAAA often a link-local address). An address in the family this query is
 * running over beats the other family, and any routable address beats a
 * link-local one (fe80::/10, 169.254.0.0/16) - which is unusable here
 * without a zone/scope id this API has no way to carry.
 * @param {string} address - A resolved IPv4 or IPv6 address.
 * @param {4|6} queryFamily - The family mdns() is querying over.
 * @returns {number} 3 (preferred family, routable), 2 (other family, routable), or 1 (link-local).
 */
function addressRank(address, queryFamily) {
	const isSix = net.isIPv6(address);
	const isLinkLocal = isSix ? /^fe[89ab]/i.test(address) : address.startsWith("169.254.");
	if (isLinkLocal) return 1;
	return (isSix ? 6 : 4) === queryFamily ? 3 : 2;
}

/**
 * Folds a batch of parsed records into the running discovery map, keyed by
 * service instance name (PTR's target = SRV/TXT's owner name). A record can
 * arrive before the records it depends on (e.g. an SRV before its target's A
 * record), so entries are updated in place as later records fill them in.
 * `addresses` is owned by the caller and persists across every message in a
 * single mdns() call - an A/AAAA record and the SRV that needs it commonly
 * arrive in the same message, but a larger/split response can send them in
 * separate messages, and a map rebuilt fresh per-message would never see the
 * earlier one by the time the later message's SRV needs it.
 * @param {Array<{name: string, type: number, data: *}>} records - Records parsed from one message.
 * @param {Map<string, {name: string, host?: string, port?: number, txt: Object, _target?: string}>} results - Running discovery map, mutated in place.
 * @param {Map<string, string>} addresses - Hostname -> IP cache spanning every message in this discovery call, mutated in place.
 * @param {4|6} queryFamily - The family mdns() is querying over, used to rank a same-name A vs. AAAA (see addressRank).
 * @returns {void}
 */
function ingestDnsRecords(records, results, addresses, queryFamily) {
	for (const record of records) {
		// readDnsRecord() joins whatever bytes rdata holds regardless of rdlength
		// for an A record (and yields null for a wrong-length AAAA) - either way
		// `data` isn't guaranteed to be a valid address string. Validate before
		// caching: `typeof === "string"` guards the AAAA-null case (net.isIP()
		// on null/non-string input would be a meaningless comparison, not a
		// throw, but is still not a real address), and `net.isIP() !== 0` covers
		// a malformed A the same way isValidIP() used to.
		if ((record.type !== DNS_TYPE_A && record.type !== DNS_TYPE_AAAA) || typeof record.data !== "string" || net.isIP(record.data) === 0) {
			continue;
		}
		// Don't let a worse address (wrong family, or link-local) overwrite a
		// better one already cached for this name - see addressRank.
		const existing = addresses.get(record.name);
		if (!existing || addressRank(record.data, queryFamily) >= addressRank(existing, queryFamily)) {
			addresses.set(record.name, record.data);
		}
	}

	for (const record of records) {
		// data is null for a PTR record whose rdata failed readDnsRecord()'s
		// bounds check (truncated/malformed rdlength) - skip it rather than
		// fabricate an instance name from whatever bytes followed.
		if (record.type !== DNS_TYPE_PTR || !record.data) continue;
		const instanceName = record.data.target;
		if (!results.has(instanceName)) {
			results.set(instanceName, { name: instanceName, txt: Object.create(null) });
		}
	}

	// Only fold SRV/TXT into an instance name a PTR record actually introduced
	// (this message or an earlier one) - joining the multicast group means this
	// socket also receives every OTHER service's mDNS traffic on the segment,
	// and an unrelated SRV+TXT pair must not turn into a fabricated "device".
	for (const record of records) {
		if (record.type === DNS_TYPE_SRV) {
			// data is null for a malformed/truncated SRV record (see
			// readDnsRecord()) - skip rather than read priority/weight/port/target
			// off a null.
			if (!record.data) continue;
			const entry = results.get(record.name);
			if (!entry) continue;
			entry.port = record.data.port;
			entry._target = record.data.target;
			entry.host = addresses.get(record.data.target) || entry.host;
		} else if (record.type === DNS_TYPE_TXT) {
			const entry = results.get(record.name);
			if (!entry) continue;
			// Object.assign mutates entry.txt in place, preserving its
			// null prototype - a `{...entry.txt, ...record.data}` spread would
			// always produce a normal Object.prototype-based object regardless
			// of the source's own prototype, reintroducing the exact risk the
			// null-proto txt objects exist to avoid.
			Object.assign(entry.txt, record.data);
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
 * correlates PTR/SRV/TXT/A/AAAA records sharing a name into device entries.
 *
 * Dual-stack: an explicit literal `address` infers the family on its own
 * (the common case needs no `family` at all); an explicit `family` cross-
 * validates against a literal `address` if both are given. With neither, it
 * defaults to IPv4 exactly as before (`224.0.0.251`/udp4) - `family: 6` with
 * no `address` targets the IPv6 mDNS group `ff02::fb`/udp6 instead.
 * `address`/`port` are always overridable so callers (and tests) can target
 * a specific responder directly instead of joining the multicast group.
 * @param {Object} [options={}] - Query options.
 * @param {string} [options.serviceType="_adb-tls-connect._tcp.local"] - mDNS service to query.
 * @param {string} [options.address] - Destination address for the query. Defaults to the real mDNS group for the resolved family.
 * @param {4|6} [options.family] - IP family to query over. Inferred from a literal `address` if omitted; defaults to 4.
 * @param {number} [options.port=5353] - Destination port for the query.
 * @param {number} [options.timeoutMs=3000] - How long to collect responses before resolving.
 * @param {string} [options.multicastInterface] - Interface to join the multicast group on (e.g. an interface address, or "::%eth0" for IPv6) - needed on a multi-homed or interface-less host, where joining/sending without one can fail with ENETUNREACH.
 * @returns {Promise<Array<{name: string, host: string, port: number, txt: Object}>>} Discovered devices with a resolved host and port.
 */
export async function mdns(options = {}) {
	const { serviceType = "_adb-tls-connect._tcp.local", address, family, port = 5353, timeoutMs = 3000, multicastInterface } = options;

	if (family !== undefined && family !== 4 && family !== 6) {
		throw new Error(`Invalid family: ${family} (must be 4 or 6)`);
	}
	if (!isValidPort(port)) {
		throw new Error(`Invalid port: ${port}`);
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`Invalid timeoutMs: ${timeoutMs} (must be a positive integer)`);
	}
	// A non-string here would otherwise surface much later and much less
	// clearly - isMulticastAddress() calling .split() on it, or a dgram
	// method rejecting it - once inside the async bind/send flow below.
	if (address !== undefined && typeof address !== "string") {
		throw new Error(`Invalid address: ${address} (must be a string)`);
	}
	if (multicastInterface !== undefined && typeof multicastInterface !== "string") {
		throw new Error(`Invalid multicastInterface: ${multicastInterface} (must be a string)`);
	}

	// A literal address selects the family on its own; a non-literal (a plain
	// hostname, or nothing) leaves it undetected and falls through to the
	// IPv4 default below, exactly as before this option existed.
	const detectedFamily = typeof address === "string" ? net.isIP(address) : 0;
	if (family !== undefined && detectedFamily !== 0 && detectedFamily !== family) {
		throw new Error(`Invalid address: ${address} (not an IPv${family} address)`);
	}
	const queryFamily = family ?? (detectedFamily === 6 ? 6 : 4);
	// ff02::fb is the IPv6 mDNS group (RFC 6762 section 3), the peer of
	// 224.0.0.251 - only used when no explicit address override was given.
	const target = address ?? (queryFamily === 6 ? "ff02::fb" : "224.0.0.251");

	// Built up front, synchronously, rather than inside the bind callback
	// below - a throw there (e.g. an oversized serviceType hitting
	// encodeDnsName's length guards) would occur inside dgram's event-emission
	// machinery, outside any try/catch, and could crash the process instead
	// of cleanly rejecting this promise. Building it here lets the `async`
	// wrapper turn that throw into a normal rejection, matching the
	// port/timeoutMs validation above.
	const query = buildPtrQuery(serviceType);

	// A compliant mDNS responder replies via MULTICAST back to target:port,
	// not to the querier's source port - so receiving real replies requires
	// binding to that exact port, not an ephemeral one. Direct-unicast targets
	// (tests, or a caller pointing at a specific responder) reply straight to
	// whatever port the query came from, so an ephemeral bind is fine - and
	// avoids a same-host port clash when the target is a loopback responder.
	const isMulticast = isMulticastAddress(target);

	const socket = dgram.createSocket({ type: queryFamily === 6 ? "udp6" : "udp4", reuseAddr: true });
	const results = new Map();
	const addresses = new Map();
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
				ingestDnsRecords(parseDnsMessage(message), results, addresses, queryFamily);
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
					// IPv6 mDNS uses the link-local ff02::fb group, so on a
					// multi-homed or interface-less host the kernel needs to be
					// told WHICH link - without one, addMembership()/send() can
					// fail with ENETUNREACH.
					if (multicastInterface) socket.setMulticastInterface(multicastInterface);
					socket.addMembership(target, multicastInterface);
				} catch (error) {
					self.log.debug(`discover.mdns: couldn't join multicast group ${target} - ${error.message}`);
				}
			}

			// RFC 6762 section 11: mDNS queries/responses SHOULD be sent with IP
			// TTL 255, not the platform's regular multicast TTL default (usually
			// 1) - a querier not sending TTL 255 risks being ignored by strict
			// responders. Harmless to set even on the direct-unicast test path,
			// since it only governs multicast-destined packets. Maps to
			// IPV6_MULTICAST_HOPS on a udp6 socket.
			try {
				socket.setMulticastTTL(255);
			} catch (error) {
				self.log.debug(`discover.mdns: couldn't set multicast TTL - ${error.message}`);
			}

			self.log.debug(`discover.mdns: querying ${serviceType} via ${target}:${port}`);
			socket.send(query, port, target, (error) => {
				if (error) finish(reject, error);
			});
		});
	});
}
