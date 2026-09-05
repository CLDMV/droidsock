/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/pairing.mjs
 *	@Date: 2026-09-03 14:00:00 -07:00 (1788383600)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-03 14:00:00 -07:00 (1788383600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * ADB Wi-Fi pairing API module for DroidSock (`adb pair` equivalent) - the
 * PIN-based pairing flow Android 11+ uses for wireless debugging.
 *
 * This is a SEPARATE protocol from the classic CNXN/AUTH/RSA handshake the
 * rest of droidsock implements - raw TLS 1.3 from the first byte, its own
 * SPAKE2-authenticated key exchange, no CNXN framing at all. A successful
 * pairing's real effect is getting droidsock's RSA public key (the same
 * identity `auth.getKeys()` manages) written into the device's `adb_keys`
 * trust store - the same trust store the classic flow's "Allow this
 * computer?" tap populates, just automated via the shared PIN instead.
 *
 * EXPERIMENTAL, same as the rest of droidsock's protocol work, but built
 * with unusually direct sourcing: every constant and structural detail here
 * - the curve, the M/N mask points, password-scalar derivation, the
 * key-derivation transcript order, the PairingPacketHeader layout and its
 * version byte, the PeerInfo struct, and the AES-128-GCM cipher's key
 * derivation and nonce construction - is confirmed directly from AOSP's own
 * pairing source (platform/packages/modules/adb - pairing_auth/,
 * pairing_connection/, tls/) and BoringSSL's SPAKE2-over-edwards25519
 * implementation (crypto/curve25519/spake25519.cc), cross-checked across
 * multiple independent reads of each file. Not yet run against a real
 * device - tracked by #1 same as everything else - but that's the only gap
 * left; nothing here is a guessed byte value.
 */

import tls from "node:tls";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { self } from "@cldmv/slothlet/runtime";
import { ed25519 } from "@noble/curves/ed25519.js";
import selfsigned from "selfsigned";

// ─────────────────────────────────────────────────────────────────────────
// SPAKE2 over edwards25519 (BoringSSL's bespoke construction - NOT RFC 9382
// SPAKE2, which specifies NIST curves with a different M/N derivation).
// Source: crypto/curve25519/spake25519.cc.
// ─────────────────────────────────────────────────────────────────────────

const Point = ed25519.Point;
const Fn = Point.Fn; // scalar field mod the curve's prime subgroup order

// M/N mask points, confirmed via two independent reads of BoringSSL's
// spake25519.cc (the encoded forms documented directly in that file's own
// comments). Client (us) always masks with M; the device (server) masks
// with N - droidsock only ever plays the client role, since `adb pair` is
// always run from the host side.
const M_POINT = Point.fromHex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
const N_POINT = Point.fromHex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");

// Role names, hashed into the key-derivation transcript. Source: pairing_auth.cpp.
const CLIENT_NAME = Buffer.from("adb pair client", "utf8");
const SERVER_NAME = Buffer.from("adb pair server", "utf8");

/**
 * Generates a fresh ephemeral SPAKE2 private scalar.
 * @returns {bigint} A scalar reduced mod the curve's subgroup order.
 */
function randomScalar() {
	return Fn.create(bytesToBigIntLE(crypto.randomBytes(64)));
}

/**
 * Interprets a byte buffer as a little-endian bigint - the convention
 * curve25519/ed25519 scalars use.
 * @param {Buffer|Uint8Array} bytes - Bytes to interpret.
 * @returns {bigint} The decoded value.
 */
function bytesToBigIntLE(bytes) {
	let result = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) {
		result = (result << 8n) | BigInt(bytes[i]);
	}
	return result;
}

/**
 * Hashes the SPAKE2 password (the pairing code, channel-bound to this TLS
 * session - see buildPairingPassword()) with SHA-512. The raw 64-byte
 * output is both reduced into the password scalar below AND hashed as-is
 * into the final key-derivation transcript (BoringSSL keeps both forms).
 * @param {Buffer} password - The channel-bound password.
 * @returns {Buffer} 64-byte SHA-512 digest.
 */
function hashPassword(password) {
	// Not a stored credential: this is SPAKE2's ephemeral session "password"
	// (a channel-bound pairing code), hashed exactly once per session as an
	// input to a proper AKE protocol - never persisted, never compared
	// directly. The wire protocol itself mandates plain SHA-512 here
	// (confirmed directly from AOSP's pairing_auth.cpp:
	// `SHA512(password, password_len, password_tmp);`); substituting
	// bcrypt/scrypt/Argon2 would silently break interop with a real device,
	// not improve security - the slow-hash threat model (offline cracking of
	// a stored hash) doesn't apply to a value that's never written anywhere.
	// CodeQL flags this as js/insufficient-password-hash - a false positive
	// against this protocol, per the above; dismiss via the alert itself
	// (inline `codeql[...]` suppression comments aren't respected by GitHub's
	// hosted Code Scanning flow - confirmed against GitHub's own docs, which
	// document only UI/API dismissal as the real mechanism).
	return crypto.createHash("sha512").update(password).digest();
}

/**
 * Reduces a password hash into a SPAKE2 scalar.
 *
 * BoringSSL additionally clears the resulting scalar's bottom 3 bits by
 * conditionally adding multiples of the group order (a side-channel
 * countermeasure for BoringSSL's own precomputed-table scalar-mult
 * implementation) - deliberately NOT replicated here. Adding a multiple of
 * the group order doesn't change a scalar's value mod that order, so
 * `@noble/curves`'s generic (already constant-time) point multiplication
 * produces the mathematically identical point either way; the extra step
 * only exists to harden BoringSSL's specific optimization strategy against
 * a timing side-channel; it has no effect on the wire-visible result.
 * @param {Buffer} passwordHash - 64-byte SHA-512 output from hashPassword().
 * @returns {bigint} The password scalar.
 */
function passwordToScalar(passwordHash) {
	return Fn.create(bytesToBigIntLE(passwordHash));
}

/**
 * Generates this side's outgoing SPAKE2 message: an ephemeral public point
 * masked with the password scalar via M (client's mask point).
 * @param {bigint} ephemeralScalar - This side's ephemeral private scalar.
 * @param {bigint} passwordScalar - The shared password scalar.
 * @returns {Buffer} 32-byte encoded masked point (the outgoing SPAKE2_MSG payload).
 */
function generateSpakeMessage(ephemeralScalar, passwordScalar) {
	const ephemeralPublic = Point.BASE.multiply(ephemeralScalar);
	const mask = M_POINT.multiply(passwordScalar);
	return Buffer.from(ephemeralPublic.add(mask).toBytes());
}

/**
 * Computes the SPAKE2 shared secret from the device's masked point: removes
 * the device's mask (via N, the server's mask point) to recover its
 * ephemeral public point, then multiplies by this side's ephemeral private
 * scalar - standard SPAKE2 Diffie-Hellman, converging to the same point
 * `ephemeralPrivateClient * ephemeralPrivateServer * G` both sides compute
 * independently.
 * @param {bigint} ephemeralScalar - This side's ephemeral private scalar.
 * @param {bigint} passwordScalar - The shared password scalar.
 * @param {Buffer} theirMessage - The device's 32-byte SPAKE2_MSG payload.
 * @returns {Buffer} 32-byte encoded shared point (dh_shared_encoded).
 */
function computeSharedSecret(ephemeralScalar, passwordScalar, theirMessage) {
	const theirMasked = Point.fromBytes(theirMessage);
	const theirMask = N_POINT.multiply(passwordScalar);
	const theirEphemeralPublic = theirMasked.subtract(theirMask);
	const shared = theirEphemeralPublic.multiply(ephemeralScalar);
	return Buffer.from(shared.toBytes());
}

/**
 * Writes an 8-byte little-endian length prefix followed by `value` into a
 * hash instance - BoringSSL's transcript-hashing convention.
 * @param {crypto.Hash} hash - Hash instance being updated.
 * @param {Buffer} value - Value to length-prefix and hash.
 * @returns {void}
 */
function updateLengthPrefixed(hash, value) {
	const len = Buffer.alloc(8);
	len.writeBigUInt64LE(BigInt(value.length));
	hash.update(len);
	hash.update(value);
}

/**
 * Derives the final SPAKE2 session key material. SHA-512 over the
 * length-prefixed transcript (client_name, server_name, client_msg,
 * server_msg, dh_shared_encoded, password_hash) - the exact field order
 * both roles converge on (verified against BOTH of BoringSSL's role
 * branches, which hash in a mirrored order that produces an identical
 * transcript regardless of which side computes it).
 * @param {Object} parts - Transcript components.
 * @param {Buffer} parts.clientMsg - Client's (our) 32-byte SPAKE2 message.
 * @param {Buffer} parts.serverMsg - Server's (device's) 32-byte SPAKE2 message.
 * @param {Buffer} parts.dhShared - 32-byte shared point from computeSharedSecret().
 * @param {Buffer} parts.passwordHash - 64-byte SHA-512 password hash.
 * @param {number} keyLength - Bytes of key material to return (SHA-512 output truncated/used as-is up to 64).
 * @returns {Buffer} Derived key material.
 */
function deriveSessionKey({ clientMsg, serverMsg, dhShared, passwordHash }, keyLength) {
	const hash = crypto.createHash("sha512");
	updateLengthPrefixed(hash, CLIENT_NAME);
	updateLengthPrefixed(hash, SERVER_NAME);
	updateLengthPrefixed(hash, clientMsg);
	updateLengthPrefixed(hash, serverMsg);
	updateLengthPrefixed(hash, dhShared);
	updateLengthPrefixed(hash, passwordHash);
	return hash.digest().subarray(0, keyLength);
}

// ─────────────────────────────────────────────────────────────────────────
// PairingPacket wire framing. Source: pairing_connection.cpp
// (PairingPacketHeader: {uint8 version; uint8 type; uint32 payload (network
// byte order)}, confirmed directly - 6 bytes total, big-endian length).
// ─────────────────────────────────────────────────────────────────────────

// Confirmed directly: pairing_connection.cpp defines
// `const uint8_t kCurrentKeyHeaderVersion = 1;` and uses it to populate
// every outgoing PairingPacketHeader's version field.
const PAIRING_PACKET_VERSION = 1;
const PACKET_TYPE_SPAKE2_MSG = 0;
const PACKET_TYPE_PEER_INFO = 1;

/**
 * Encodes one PairingPacket: 6-byte header + payload.
 * @param {number} type - PACKET_TYPE_SPAKE2_MSG or PACKET_TYPE_PEER_INFO.
 * @param {Buffer} payload - Packet payload.
 * @returns {Buffer} The encoded packet.
 */
function encodePairingPacket(type, payload) {
	const header = Buffer.alloc(6);
	header.writeUInt8(PAIRING_PACKET_VERSION, 0);
	header.writeUInt8(type, 1);
	header.writeUInt32BE(payload.length, 2);
	return Buffer.concat([header, payload]);
}

// Real pairing packets are small - the largest legitimate payload is an
// AES-128-GCM-encrypted PeerInfo (AOSP's PeerInfo::data[8191] fixed buffer +
// the 1-byte type + the 16-byte GCM tag = 8208 bytes at most); SPAKE2_MSG
// payloads are a fixed 32 bytes. pair() connects to an arbitrary host/port,
// so a misbehaving or hostile peer advertising an enormous payload length
// must be rejected before buffering, not trusted to bound how much memory
// this allocates while waiting for the rest of a frame that may never come.
const MAX_PACKET_PAYLOAD = 16 * 1024;

/**
 * Creates a streaming PairingPacket reader: feed it raw TLS bytes as they
 * arrive via push(), and it yields complete {version, type, payload}
 * packets as soon as enough bytes have accumulated - mirroring the same
 * accumulate-until-a-full-frame-exists shape stream.mjs's handlePacket()
 * uses for the classic protocol's packet framing, since TLS delivers bytes
 * as a stream with no guarantee one write() lines up with one packet.
 * Throws if a header advertises a payload beyond MAX_PACKET_PAYLOAD, or a
 * version other than PAIRING_PACKET_VERSION.
 * @returns {{push: (chunk: Buffer) => Array<{version: number, type: number, payload: Buffer}>}} The reader.
 */
function createPacketReader() {
	let buffered = Buffer.alloc(0);

	return {
		push(chunk) {
			buffered = Buffer.concat([buffered, chunk]);
			const packets = [];

			for (;;) {
				if (buffered.length < 6) break;
				const payloadLength = buffered.readUInt32BE(2);
				if (payloadLength > MAX_PACKET_PAYLOAD) {
					throw new Error(`Pairing packet payload too large: ${payloadLength} bytes (max ${MAX_PACKET_PAYLOAD})`);
				}
				if (buffered.length < 6 + payloadLength) break;

				const version = buffered.readUInt8(0);
				if (version !== PAIRING_PACKET_VERSION) {
					throw new Error(`Unsupported pairing packet version: ${version} (expected ${PAIRING_PACKET_VERSION})`);
				}

				packets.push({
					version,
					type: buffered.readUInt8(1),
					payload: buffered.subarray(6, 6 + payloadLength)
				});
				buffered = buffered.subarray(6 + payloadLength);
			}

			return packets;
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────
// PeerInfo. Source: pairing_connection/include/adb/pairing/pairing_connection.h
// (confirmed directly: `struct PeerInfo { uint8_t type; uint8_t data[8191]; }
// __attribute__((packed))`, with `enum PeerInfoType { ADB_RSA_PUB_KEY = 0,
// ADB_DEVICE_GUID = 1 }`). The 8191-byte `data` array is AOSP's fixed-size
// internal buffer, not a fixed wire size - the actual PairingPacket payload
// length (tracked by the packet header, not this struct) covers only the
// bytes actually used, matching how every other variable-length field in
// this protocol already works.
// ─────────────────────────────────────────────────────────────────────────

const PEER_INFO_TYPE_RSA_PUB_KEY = 0;

/**
 * Encodes a PeerInfo payload: a 1-byte type followed by the actual data
 * bytes (not padded to the struct's full 8191-byte buffer size).
 * @param {number} type - A PeerInfoType value.
 * @param {Buffer} data - Payload data.
 * @returns {Buffer} The encoded PeerInfo.
 */
function encodePeerInfo(type, data) {
	return Buffer.concat([Buffer.from([type]), data]);
}

/**
 * Decodes a PeerInfo payload.
 * @param {Buffer} buf - Raw PeerInfo bytes.
 * @returns {{type: number, data: Buffer}} The decoded PeerInfo.
 */
function decodePeerInfo(buf) {
	if (buf.length < 1) {
		throw new Error("PeerInfo payload is empty (expected at least a 1-byte type)");
	}
	return { type: buf.readUInt8(0), data: buf.subarray(1) };
}

// ─────────────────────────────────────────────────────────────────────────
// AES-128-GCM message cipher for the PEER_INFO exchange. Source:
// pairing_auth/aes_128_gcm.cpp and its header (confirmed: AES-128, 12-byte
// nonce, 16-byte tag, key derived from the SPAKE2 key material via
// HKDF-SHA256). The header confirms enc_sequence_/dec_sequence_ are each a
// `uint64_t = 0` - an 8-byte little-endian counter starting at 0, matching
// exactly what's implemented below.
// ─────────────────────────────────────────────────────────────────────────

// Confirmed directly from aes_128_gcm.cpp's HKDF call.
const AES_KEY_INFO = Buffer.from("adb pairing_auth aes-128-gcm key", "utf8");

/**
 * Derives the 16-byte AES-128-GCM key from raw SPAKE2 key material via
 * HKDF-SHA256.
 * @param {Buffer} keyMaterial - Raw key material from deriveSessionKey().
 * @returns {Buffer} 16-byte AES key.
 */
function deriveAesKey(keyMaterial) {
	return Buffer.from(crypto.hkdfSync("sha256", keyMaterial, Buffer.alloc(0), AES_KEY_INFO, 16));
}

/**
 * Creates an AES-128-GCM message cipher over a derived key, with
 * independent incrementing per-direction nonce counters (encrypt/decrypt),
 * matching aes_128_gcm.cpp's design. Ciphertext output is
 * `ciphertext || 16-byte tag`, matching how BoringSSL's EVP_AEAD_CTX_seal
 * appends the tag to its output by default.
 * @param {Buffer} keyMaterial - Raw key material from deriveSessionKey().
 * @returns {{encrypt: (plaintext: Buffer) => Buffer, decrypt: (ciphertext: Buffer) => Buffer}} The cipher.
 */
function createMessageCipher(keyMaterial) {
	const key = deriveAesKey(keyMaterial);
	let encSequence = 0n;
	let decSequence = 0n;

	const nonceFor = (sequence) => {
		const nonce = Buffer.alloc(12);
		nonce.writeBigUInt64LE(sequence, 0);
		return nonce;
	};

	return {
		encrypt(plaintext) {
			const nonce = nonceFor(encSequence++);
			const cipher = crypto.createCipheriv("aes-128-gcm", key, nonce);
			const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			return Buffer.concat([ciphertext, cipher.getAuthTag()]);
		},
		decrypt(ciphertextAndTag) {
			const nonce = nonceFor(decSequence++);
			const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
			const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
			const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────
// TLS setup + persistent pairing certificate.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a persisted cert's embedded public key still matches the
 * current RSA keypair - compared as the raw key material (PKCS#1 DER), not
 * the PEM encoding, since a cert's embedded key and a standalone PEM can
 * differ in wrapper format (PKCS#1 vs SPKI) despite being the same key.
 * @param {string} certPem - Persisted certificate PEM.
 * @param {string} publicKeyPem - Current RSA public key PEM (from auth.getKeys()).
 * @returns {boolean} True if the cert's public key matches the current keypair.
 */
function certMatchesKey(certPem, publicKeyPem) {
	const certPublicKey = new crypto.X509Certificate(certPem).publicKey;
	const currentPublicKey = crypto.createPublicKey(publicKeyPem);
	return certPublicKey.export({ type: "pkcs1", format: "der" }).equals(currentPublicKey.export({ type: "pkcs1", format: "der" }));
}

/**
 * Loads (or generates and persists) a self-signed X.509 certificate
 * wrapping droidsock's existing RSA identity, alongside the adbkey files
 * auth.getKeys() already manages. AOSP's pairing flow uses "the caller's
 * own already-existing, persistent X.509 cert + RSA keypair - the same
 * identity used for the classic ADB auth flow" (confirmed from
 * pairing_connection.cpp), so this wraps the SAME key rather than
 * generating a separate one, and persists the cert so repeated pairing
 * attempts present a stable identity rather than a fresh one each time. If
 * the persisted cert wraps a different key than the current adbkey/
 * adbkey.pub (e.g. the user regenerated the keypair), it's regenerated
 * rather than presenting a stale identity that would fail the TLS handshake.
 * @param {Object} keys - Result of auth.getKeys() - {privateKey, publicKey}.
 * @param {string} certPath - Path to persist/load the cert PEM at.
 * @returns {Promise<{cert: string, key: string}>} TLS-ready cert + key PEM pair.
 */
async function getOrCreatePairingCert(keys, certPath) {
	// A single read attempt rather than existsSync() + readFileSync() - the
	// separate check-then-act let the file be created, removed, or replaced
	// between the two calls (CodeQL js/file-system-race).
	try {
		const cert = fs.readFileSync(certPath, "utf8");
		if (certMatchesKey(cert, keys.publicKey)) {
			return { cert, key: keys.privateKey };
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const pems = await selfsigned.generate(null, {
		keyPair: { publicKey: keys.publicKey, privateKey: keys.privateKey },
		days: 3650
	});

	fs.writeFileSync(certPath, pems.cert);
	return { cert: pems.cert, key: keys.privateKey };
}

/**
 * Pairs with a device advertising ADB Wi-Fi pairing (`_adb-tls-pairing._tcp`
 * over mDNS - see discover.mdns()) using the 6-digit pairing code shown on
 * the device. The `adb pair host:port pairing-code` equivalent.
 *
 * On success, droidsock's RSA public key has been written into the
 * device's `adb_keys` trust store - the same store the classic auth flow's
 * on-device "Allow this computer?" tap populates - so a later
 * `device.connect()` to the device's normal wireless-debugging port no
 * longer needs manual authorization.
 *
 * EXPERIMENTAL - see this module's own top-of-file note for exactly which
 * parts of the protocol are precisely confirmed against AOSP/BoringSSL
 * source vs. best-effort placeholders. Not yet run against a real device.
 * See #1.
 * @param {string} host - Pairing service host/IP.
 * @param {number} port - Pairing service port (from the mDNS TXT/SRV record - it's ephemeral per session, not a fixed port).
 * @param {string} pairingCode - The 6-digit pairing code displayed on the device.
 * @param {Object} [options={}] - Options.
 * @param {string} [options.keyDir] - Directory for RSA keys/cert (default: ~/.adb, same as auth.getKeys()).
 * @param {number} [options.timeoutMs=10000] - Overall pairing timeout.
 * @returns {Promise<{success: boolean}>} Pairing result.
 */
export async function pair(host, port, pairingCode, options = {}) {
	const { keyDir, timeoutMs = 10000 } = options;

	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`Invalid timeoutMs: ${timeoutMs} (must be a positive integer)`);
	}
	if (typeof pairingCode !== "string" || pairingCode.length === 0) {
		throw new Error("pairingCode must be a non-empty string");
	}

	const adbDir = keyDir || path.join(os.homedir(), ".adb");
	const keys = self.auth.getKeys(adbDir);
	const certPath = path.join(adbDir, "adbkey.cert.pem");
	const { cert, key } = await getOrCreatePairingCert(keys, certPath);

	return new Promise((resolve, reject) => {
		let settled = false;
		// Declared (and implicitly initialized to undefined) before finish() is
		// defined, rather than `const socket = tls.connect(...)` further down -
		// if tls.connect() throws synchronously (e.g. an invalid port), the
		// still-pending timer below would later call finish() while `socket`
		// was never assigned; with `const`, that's a temporal-dead-zone
		// ReferenceError inside a setTimeout callback Node can't attribute back
		// to this promise. With `let` declared up front, finish() just sees
		// `socket` as undefined and skips the cleanup that needs it.
		let socket;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (socket) {
				socket.removeAllListeners();
				socket.destroy();
			}
			fn(value);
		};

		const timer = setTimeout(() => finish(reject, new Error("Pairing timed out")), timeoutMs);

		try {
			socket = tls.connect({
				host,
				port,
				cert,
				key,
				minVersion: "TLSv1.3",
				maxVersion: "TLSv1.3",
				// AOSP's pairing server presents an ephemeral, unpinned cert - trust
				// here comes from the shared pairing code via SPAKE2, not from
				// certificate validation (confirmed: pairing_connection.cpp sets a
				// cert-verify callback that unconditionally accepts,
				// `SetCertVerifyCallback([](X509_STORE_CTX*) { return 1; })`).
				// Requiring a valid cert here would just make pairing itself
				// impossible - a compliant device has nothing for this connection to
				// validate against yet. CodeQL flags this as
				// js/disabling-certificate-validation - a false positive against this
				// protocol, per the above; dismiss via the alert itself (inline
				// `codeql[...]` suppression comments aren't respected by GitHub's
				// hosted Code Scanning flow - confirmed against GitHub's own docs,
				// which document only UI/API dismissal as the real mechanism).
				rejectUnauthorized: false
			});
		} catch (error) {
			finish(reject, error);
			return;
		}

		const reader = createPacketReader();
		let stage = "spake2"; // "spake2" -> "peerInfo" -> done
		let ephemeralScalar;
		let passwordScalar;
		let passwordHash;
		let clientMsg;
		let cipher;

		socket.on("error", (error) => finish(reject, error));

		socket.on("secureConnect", () => {
			// Channel binding: the exported keying material is appended to the
			// pairing code to form the actual SPAKE2 password, cryptographically
			// binding the exchange to this specific TLS session (confirmed:
			// pairing_connection.cpp). The label passed here intentionally
			// includes a trailing NUL - AOSP's C++ passes `sizeof(kExportedKeyLabel)`
			// on a `char[]` literal, which includes the array's implicit NUL
			// terminator (10 bytes for "adb-label", not 9); Node's API takes a
			// plain string with no implicit terminator, so the NUL has to be
			// added explicitly to match the same bytes going into the TLS PRF.
			const exportedKeyMaterial = Buffer.from(socket.exportKeyingMaterial(64, "adb-label\0"));
			const password = Buffer.concat([Buffer.from(pairingCode, "utf8"), exportedKeyMaterial]);

			passwordHash = hashPassword(password);
			passwordScalar = passwordToScalar(passwordHash);
			ephemeralScalar = randomScalar();
			clientMsg = generateSpakeMessage(ephemeralScalar, passwordScalar);

			socket.write(encodePairingPacket(PACKET_TYPE_SPAKE2_MSG, clientMsg));
		});

		socket.on("data", (chunk) => {
			try {
				for (const packet of reader.push(chunk)) {
					if (stage === "spake2") {
						if (packet.type !== PACKET_TYPE_SPAKE2_MSG) {
							throw new Error(`Expected SPAKE2_MSG, got packet type ${packet.type}`);
						}

						const serverMsg = packet.payload;
						const dhShared = computeSharedSecret(ephemeralScalar, passwordScalar, serverMsg);
						const keyMaterial = deriveSessionKey({ clientMsg, serverMsg, dhShared, passwordHash }, 64);
						cipher = createMessageCipher(keyMaterial);

						const peerInfo = encodePeerInfo(PEER_INFO_TYPE_RSA_PUB_KEY, Buffer.from(keys.adbPublicKey, "utf8"));
						socket.write(encodePairingPacket(PACKET_TYPE_PEER_INFO, cipher.encrypt(peerInfo)));
						stage = "peerInfo";
					} else if (stage === "peerInfo") {
						if (packet.type !== PACKET_TYPE_PEER_INFO) {
							throw new Error(`Expected PEER_INFO, got packet type ${packet.type}`);
						}

						// Decrypting the device's PeerInfo confirms it derived the
						// same session key we did - i.e. pairing succeeded. The
						// decoded content itself (the device's own identity) isn't
						// needed for anything droidsock does with a successful pair.
						decodePeerInfo(cipher.decrypt(packet.payload));
						finish(resolve, { success: true });
					}
				}
			} catch (error) {
				finish(reject, error);
			}
		});
	});
}
