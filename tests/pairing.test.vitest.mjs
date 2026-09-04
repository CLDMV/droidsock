/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/pairing.test.vitest.mjs
 *	@Date: 2026-09-03 14:00:00 -07:00 (1788383600)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-03 14:00:00 -07:00 (1788383600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import selfsigned from "selfsigned";
import createDroidSock from "../index.mjs";

// pairing.mjs's internal SPAKE2/PairingPacket/PeerInfo/AES-GCM machinery is
// deliberately unexported (matching discover.mjs's own convention) and is
// only exercised end-to-end through pair(), against a fake TLS "device"
// pairing server implemented independently below - not by importing and
// reusing pairing.mjs's own functions, which would only prove the code
// agrees with itself. This fake server plays the real AOSP server role
// (masks its own message with N, unmasks the client's with M) using the
// same M/N constants and canonical key-derivation transcript order
// pairing.mjs documents at its own definitions.

const Point = ed25519.Point;
const Fn = Point.Fn;
const M_POINT = Point.fromHex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
const N_POINT = Point.fromHex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");
const CLIENT_NAME = Buffer.from("adb pair client", "utf8");
const SERVER_NAME = Buffer.from("adb pair server", "utf8");
const PACKET_TYPE_SPAKE2_MSG = 0;
const PACKET_TYPE_PEER_INFO = 1;

function bytesToBigIntLE(bytes) {
	let result = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i]);
	return result;
}

function updateLengthPrefixed(hash, value) {
	const len = Buffer.alloc(8);
	len.writeBigUInt64LE(BigInt(value.length));
	hash.update(len);
	hash.update(value);
}

function deriveSessionKeyServer({ clientMsg, serverMsg, dhShared, passwordHash }, keyLength) {
	const hash = crypto.createHash("sha512");
	updateLengthPrefixed(hash, CLIENT_NAME);
	updateLengthPrefixed(hash, SERVER_NAME);
	updateLengthPrefixed(hash, clientMsg);
	updateLengthPrefixed(hash, serverMsg);
	updateLengthPrefixed(hash, dhShared);
	updateLengthPrefixed(hash, passwordHash);
	return hash.digest().subarray(0, keyLength);
}

function encodePairingPacket(type, payload) {
	const header = Buffer.alloc(6);
	header.writeUInt8(1, 0);
	header.writeUInt8(type, 1);
	header.writeUInt32BE(payload.length, 2);
	return Buffer.concat([header, payload]);
}

function createPacketReader() {
	let buffered = Buffer.alloc(0);
	return {
		push(chunk) {
			buffered = Buffer.concat([buffered, chunk]);
			const packets = [];
			for (;;) {
				if (buffered.length < 6) break;
				const payloadLength = buffered.readUInt32BE(2);
				if (buffered.length < 6 + payloadLength) break;
				packets.push({ type: buffered.readUInt8(1), payload: buffered.subarray(6, 6 + payloadLength) });
				buffered = buffered.subarray(6 + payloadLength);
			}
			return packets;
		}
	};
}

function createServerCipher(keyMaterial) {
	const key = Buffer.from(
		crypto.hkdfSync("sha256", keyMaterial, Buffer.alloc(0), Buffer.from("adb pairing_auth aes-128-gcm key", "utf8"), 16)
	);
	let encSequence = 0n;
	let decSequence = 0n;
	const nonceFor = (sequence) => {
		const nonce = Buffer.alloc(12);
		nonce.writeBigUInt64LE(sequence, 0);
		return nonce;
	};
	return {
		encrypt(plaintext) {
			const cipher = crypto.createCipheriv("aes-128-gcm", key, nonceFor(encSequence++));
			return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
		},
		decrypt(ciphertextAndTag) {
			const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
			const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
			const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonceFor(decSequence++));
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		}
	};
}

/**
 * Starts a fake ADB pairing server: plays the real device/server role of
 * the protocol against a real TLS 1.3 connection, using an independent
 * SPAKE2 implementation (not pairing.mjs's own).
 * @param {string} pairingCode - Expected pairing code (must match what pair() is called with).
 * @param {Object} [opts] - Overrides for deliberately testing failure paths.
 * @param {boolean} [opts.wrongPassword] - Derive the server's password scalar from a different code, simulating a PIN mismatch.
 * @param {boolean} [opts.corruptPeerInfoAck] - Send back garbage instead of a valid encrypted PeerInfo ack.
 * @param {boolean} [opts.emptyPeerInfoAck] - Send back a validly-encrypted PeerInfo ack whose plaintext is 0 bytes.
 * @param {boolean} [opts.oversizedPayload] - Reply to the client's first packet with a header claiming an oversized payload, no payload sent.
 * @param {boolean} [opts.wrongVersion] - Reply to the client's first packet with a header carrying an unsupported version byte.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} Server handle.
 */
async function startFakePairingServer(pairingCode, opts = {}) {
	// TLS 1.3 rejects an end-entity cert under 2048 bits outright ("ee key too
	// small") - unlike droidsock's own client-side identity below, this key
	// can't use the fast 1024-bit test shortcut.
	const serverKeys = crypto.generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" }
	});
	const pems = await selfsigned.generate(null, { keyPair: serverKeys, days: 1 });

	const server = tls.createServer({ cert: pems.cert, key: serverKeys.privateKey, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });

	server.on("secureConnection", (socket) => {
		const exportedKeyMaterial = Buffer.from(socket.exportKeyingMaterial(64, "adb-label\0"));
		const codeForPassword = opts.wrongPassword ? "000000" : pairingCode;
		const password = Buffer.concat([Buffer.from(codeForPassword, "utf8"), exportedKeyMaterial]);
		const passwordHash = crypto.createHash("sha512").update(password).digest();
		const passwordScalar = Fn.create(bytesToBigIntLE(passwordHash));
		const ephemeralScalar = Fn.create(bytesToBigIntLE(crypto.randomBytes(64)));

		const reader = createPacketReader();
		let serverMsg;
		let cipher;

		socket.on("data", (chunk) => {
			for (const packet of reader.push(chunk)) {
				if (packet.type === PACKET_TYPE_SPAKE2_MSG) {
					if (opts.oversizedPayload) {
						const header = Buffer.alloc(6);
						header.writeUInt8(1, 0);
						header.writeUInt8(PACKET_TYPE_SPAKE2_MSG, 1);
						header.writeUInt32BE(1024 * 1024, 2); // claims 1MB, never sends it
						socket.write(header);
						continue;
					}
					if (opts.wrongVersion) {
						const payload = Buffer.alloc(32);
						const header = Buffer.alloc(6);
						header.writeUInt8(99, 0); // bogus version
						header.writeUInt8(PACKET_TYPE_SPAKE2_MSG, 1);
						header.writeUInt32BE(payload.length, 2);
						socket.write(Buffer.concat([header, payload]));
						continue;
					}

					const clientMsg = packet.payload;

					const ephemeralPublic = Point.BASE.multiply(ephemeralScalar);
					const mask = N_POINT.multiply(passwordScalar); // server masks with N
					serverMsg = Buffer.from(ephemeralPublic.add(mask).toBytes());

					const clientMasked = Point.fromBytes(clientMsg);
					const clientMask = M_POINT.multiply(passwordScalar); // client masked with M
					const clientEphemeralPublic = clientMasked.subtract(clientMask);
					const dhShared = Buffer.from(clientEphemeralPublic.multiply(ephemeralScalar).toBytes());

					const keyMaterial = deriveSessionKeyServer({ clientMsg, serverMsg, dhShared, passwordHash }, 64);
					cipher = createServerCipher(keyMaterial);

					socket.write(encodePairingPacket(PACKET_TYPE_SPAKE2_MSG, serverMsg));
				} else if (packet.type === PACKET_TYPE_PEER_INFO) {
					// Decrypting proves the client derived the same key. The
					// wrongPassword test deliberately makes this fail (the server
					// derived a different key) - a real server would just drop the
					// connection rather than crash, so this mirrors that instead of
					// letting the exception escape the "data" handler uncaught.
					try {
						cipher.decrypt(packet.payload);
					} catch {
						socket.destroy();
						continue;
					}
					const ackPayload = opts.corruptPeerInfoAck
						? crypto.randomBytes(32)
						: opts.emptyPeerInfoAck
							? cipher.encrypt(Buffer.alloc(0))
							: cipher.encrypt(Buffer.concat([Buffer.from([1]), Buffer.from("fake-device-guid", "utf8")]));
					socket.write(encodePairingPacket(PACKET_TYPE_PEER_INFO, ackPayload));
				}
			}
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	return {
		port: server.address().port,
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}

let droidsock;
let tmpKeyDir;

beforeAll(async () => {
	droidsock = await createDroidSock({ config: { silent: true } });
	tmpKeyDir = mkdtempSync(path.join(tmpdir(), "droidsock-pairing-test-"));
	// TLS 1.3 rejects an under-2048-bit key even when it's only configured as
	// the local client identity and never actually requested/transmitted -
	// pair()'s own key can't use the fast 1024-bit shortcut other tests use.
	// Generated once here (not per-test) so pair()'s own auth.getKeys() finds
	// it already on disk instead of regenerating a 2048-bit key every test.
	droidsock.auth.generateKeys(2048, tmpKeyDir);
});

afterAll(async () => {
	rmSync(tmpKeyDir, { recursive: true, force: true });
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("pairing.pair", () => {
	let server;

	afterEach(async () => {
		if (server) await server.close();
		server = undefined;
	});

	test("succeeds against a real TLS 1.3 SPAKE2 exchange with the correct pairing code", async () => {
		server = await startFakePairingServer("123456");
		const result = await droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir });
		expect(result).toEqual({ success: true });
	});

	test("fails when the pairing code doesn't match the device's", async () => {
		server = await startFakePairingServer("123456", { wrongPassword: true });
		await expect(droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir, timeoutMs: 2000 })).rejects.toThrow();
	});

	test("fails when the device's PEER_INFO ack doesn't decrypt", async () => {
		server = await startFakePairingServer("123456", { corruptPeerInfoAck: true });
		await expect(droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir, timeoutMs: 2000 })).rejects.toThrow();
	});

	test("rejects an empty pairing code without opening a connection", async () => {
		await expect(droidsock.pairing.pair("127.0.0.1", 12345, "", { keyDir: tmpKeyDir })).rejects.toThrow(/pairingCode/);
	});

	test("rejects a non-positive timeoutMs", async () => {
		await expect(droidsock.pairing.pair("127.0.0.1", 12345, "123456", { keyDir: tmpKeyDir, timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
	});

	test("rejects a packet header advertising an oversized payload rather than buffering it unbounded", async () => {
		server = await startFakePairingServer("123456", { oversizedPayload: true });
		await expect(droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir, timeoutMs: 2000 })).rejects.toThrow(
			/payload too large/
		);
	});

	test("rejects a packet with an unsupported version byte", async () => {
		server = await startFakePairingServer("123456", { wrongVersion: true });
		await expect(droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir, timeoutMs: 2000 })).rejects.toThrow(
			/[Uu]nsupported pairing packet version/
		);
	});

	test("rejects a PeerInfo payload that decrypts to 0 bytes with a clear error, not a raw RangeError", async () => {
		server = await startFakePairingServer("123456", { emptyPeerInfoAck: true });
		await expect(droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir: tmpKeyDir, timeoutMs: 2000 })).rejects.toThrow(
			/PeerInfo payload is empty/
		);
	});

	test("regenerates the persisted pairing cert when the RSA keypair changes", async () => {
		const keyDir = mkdtempSync(path.join(tmpdir(), "droidsock-pairing-cert-test-"));
		try {
			droidsock.auth.generateKeys(2048, keyDir);
			const keysBefore = droidsock.auth.getKeys(keyDir);

			server = await startFakePairingServer("123456");
			await droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir });
			const certPath = path.join(keyDir, "adbkey.cert.pem");
			const certBefore = readFileSync(certPath, "utf8");
			await server.close();
			server = undefined;

			// Simulate the user regenerating their RSA identity - overwrite
			// adbkey/adbkey.pub, leaving the old cert (wrapping the old key) in place.
			rmSync(path.join(keyDir, "adbkey"));
			rmSync(path.join(keyDir, "adbkey.pub"));
			droidsock.auth.generateKeys(2048, keyDir);
			const keysAfter = droidsock.auth.getKeys(keyDir);
			expect(keysAfter.publicKey).not.toBe(keysBefore.publicKey);

			server = await startFakePairingServer("123456");
			await droidsock.pairing.pair("127.0.0.1", server.port, "123456", { keyDir });

			const certAfter = readFileSync(certPath, "utf8");
			expect(certAfter).not.toBe(certBefore);
		} finally {
			rmSync(keyDir, { recursive: true, force: true });
		}
	});

	test("times out when nothing answers", async () => {
		// An unroutable TEST-NET-1 address (RFC 5737) - connection attempt
		// stalls until pair()'s own timeout fires rather than TCP's slower
		// connect-timeout/ECONNREFUSED.
		await expect(droidsock.pairing.pair("192.0.2.1", 5555, "123456", { keyDir: tmpKeyDir, timeoutMs: 300 })).rejects.toThrow(/timed out/);
	});
});
