/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/auth.mjs
 *	@Date: 2025-11-21 12:18:55 -08:00 (1763756335)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:06:08 -08:00 (1763762768)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Authentication and key management API module for DroidSock
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Gets or creates RSA key pair for ADB authentication
 * @param {string} [keyDir] - Directory to store keys (default: ~/.adb)
 * @returns {Object} Key pair object with publicKey, privateKey, and adbPublicKey
 */
export function getKeys(keyDir) {
	const adbDir = keyDir || path.join(os.homedir(), ".adb");
	const privateKeyPath = path.join(adbDir, "adbkey");
	const publicKeyPath = path.join(adbDir, "adbkey.pub");

	// Create directory if it doesn't exist
	if (!fs.existsSync(adbDir)) {
		fs.mkdirSync(adbDir, { recursive: true });
	}

	// Check if keys exist
	if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
		const privateKey = fs.readFileSync(privateKeyPath, "utf8");
		const adbPublicKey = fs.readFileSync(publicKeyPath, "utf8").trim();

		// Extract public key from private key
		const keyObject = crypto.createPrivateKey(privateKey);
		const publicKey = crypto.createPublicKey(keyObject).export({
			type: "spki",
			format: "pem"
		});

		return { privateKey, publicKey, adbPublicKey };
	}

	// Generate new keys
	return generateKeys(2048, adbDir);
}

/**
 * Generates a new RSA key pair for ADB authentication
 * @param {number} [keySize=2048] - Key size in bits
 * @param {string} [saveDir] - Directory to save keys
 * @returns {Object} Key pair object with publicKey, privateKey, and adbPublicKey
 */
export function generateKeys(keySize = 2048, saveDir = null) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: keySize,
		publicKeyEncoding: {
			type: "spki",
			format: "pem"
		},
		privateKeyEncoding: {
			type: "pkcs8",
			format: "pem"
		}
	});

	// Create ADB-compatible public key
	const adbPublicKey = formatAdbPublicKey(publicKey);

	// Save keys if directory provided
	if (saveDir) {
		const privateKeyPath = path.join(saveDir, "adbkey");
		const publicKeyPath = path.join(saveDir, "adbkey.pub");

		fs.writeFileSync(privateKeyPath, privateKey);
		fs.writeFileSync(publicKeyPath, adbPublicKey);
	}

	return { privateKey, publicKey, adbPublicKey };
}

/**
 * Signs an ADB authentication token using AOSP-style signature
 * @param {Buffer} token - Token to sign (20-byte SHA1 hash)
 * @param {string} privateKey - Private key in PEM format
 * @returns {Buffer} Signature bytes
 */
export function sign(token, privateKey) {
	self.log.debug("[DEBUG] AOSP-STYLE ADB SIGNATURE (token as digest):");
	self.log.debug("[DEBUG] Token:", token.toString("hex"), `(${token.length} bytes)`);

	if (!Buffer.isBuffer(token)) {
		token = Buffer.from(token);
	}
	if (token.length !== 20) {
		throw new Error(`Token must be 20 bytes, got ${token.length}`);
	}

	// CRITICAL: use token directly as the "digest" (no hashing!)
	// This matches the AOSP adbd_auth.cpp: RSA_verify(NID_sha1, token, token_size, sig, sig_len, key)
	const DIGESTINFO_SHA1_PREFIX = Buffer.from([0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14]);
	const digestInfo = Buffer.concat([DIGESTINFO_SHA1_PREFIX, token]);
	self.log.debug("[DEBUG] DigestInfo:", digestInfo.toString("hex"));

	const keyObject = crypto.createPrivateKey(privateKey);
	let keySize = keyObject.asymmetricKeySize;

	// Fallback for older Node.js versions that don't have asymmetricKeySize
	if (keySize === undefined) {
		const keyDetails = keyObject.asymmetricKeyDetails || {};
		if (keyDetails.modulusLength) {
			keySize = Math.ceil(keyDetails.modulusLength / 8);
		} else {
			keySize = getKeySizeFromPem(privateKey);
		}
	}

	self.log.debug("[DEBUG] Key size:", keySize, "bytes");

	const paddedBlock = buildPkcs1v15Block(digestInfo, keySize);
	self.log.debug("[DEBUG] PKCS#1 v1.5 block length:", paddedBlock.length, "bytes");
	self.log.debug("[DEBUG] Block starts:", paddedBlock.slice(0, 16).toString("hex") + "...");
	self.log.debug("[DEBUG] Block ends: ..." + paddedBlock.slice(-16).toString("hex"));

	// Raw RSA exponentiation with NO_PADDING; we already did the PKCS#1 v1.5
	const signature = crypto.privateEncrypt(
		{
			key: keyObject,
			padding: crypto.constants.RSA_NO_PADDING
		},
		paddedBlock
	);

	self.log.debug("[DEBUG] Signature length:", signature.length, "bytes");
	self.log.debug("[DEBUG] Signature starts with:", signature.slice(0, 8).toString("hex"));

	return signature;
}

/**
 * Builds PKCS#1 v1.5 padded block
 * @param {Buffer} data - Data to pad
 * @param {number} keySize - Key size in bytes
 * @returns {Buffer} Padded block
 */
function buildPkcs1v15Block(data, keySize) {
	self.log.debug("[DEBUG] buildPkcs1v15Block - data length:", data.length, "keySize:", keySize, "keySize type:", typeof keySize);

	if (isNaN(keySize) || keySize <= 0) {
		throw new Error(`Invalid key size: ${keySize}`);
	}

	const paddingLength = keySize - data.length - 3;
	self.log.debug("[DEBUG] Padding length:", paddingLength);

	if (paddingLength < 8) {
		throw new Error(`Key too small for data - keySize: ${keySize}, dataLength: ${data.length}, paddingLength: ${paddingLength}`);
	}

	const padding = Buffer.alloc(paddingLength, 0xff);
	return Buffer.concat([Buffer.from([0x00, 0x01]), padding, Buffer.from([0x00]), data]);
}

/**
 * Validates a token and private key for signing
 * @param {Buffer} token - Token to validate
 * @param {string} privateKey - Private key to validate
 * @returns {boolean} True if valid
 */
export function validateAuth(token, privateKey) {
	try {
		if (!Buffer.isBuffer(token) || token.length !== 20) {
			return false;
		}
		if (typeof privateKey !== "string" || !privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
			return false;
		}
		// Try to sign the token
		sign(token, privateKey);
		return true;
	} catch (error) {
		return false;
	}
}

/**
 * Creates ADB-compatible public key format from RSA public key using SSH wire format
 * @param {string} publicKey - Public key in PEM format
 * @returns {string} ADB-compatible public key string with null terminator
 */
export function formatAdbPublicKey(publicKey) {
	self.log.debug("[DEBUG] Creating ADB public key format...");

	// Convert PEM to JWK to get modulus and exponent
	const pubKey = crypto.createPublicKey(publicKey);
	const jwk = pubKey.export({ format: "jwk" });

	// Convert base64url to Buffer
	const n = base64UrlToBuf(jwk.n); // modulus
	const e = base64UrlToBuf(jwk.e); // exponent

	self.log.debug("[DEBUG] Exponent length:", e.length, "bytes, first byte: 0x" + e[0].toString(16).padStart(2, "0"));
	self.log.debug("[DEBUG] Modulus length:", n.length, "bytes, first byte: 0x" + n[0].toString(16).padStart(2, "0"));

	// Strip leading zeros if present (SSH wire format requirement)
	const eStripped = e[0] === 0x00 ? e.slice(1) : e;
	const nStripped = n[0] === 0x00 ? n.slice(1) : n;

	self.log.debug("[DEBUG] After stripping - Exponent:", eStripped.length, "bytes, Modulus:", nStripped.length, "bytes");

	// Build SSH wire format: ssh-rsa + exponent + modulus
	const parts = [];
	writeSshString(parts, Buffer.from("ssh-rsa"));
	writeSshString(parts, eStripped);
	writeSshString(parts, nStripped);

	const sshBlob = Buffer.concat(parts);
	const base64Key = sshBlob.toString("base64");

	self.log.debug("[DEBUG] SSH blob length:", sshBlob.length, "bytes");
	self.log.debug("[DEBUG] Base64 length:", base64Key.length, "chars");
	self.log.debug("[DEBUG] Base64 preview:", base64Key.substring(0, 50) + "...");

	// ADB format: "<base64> <comment>\0" (NO ssh-rsa prefix)
	const hostname = os.hostname() || "unknown";
	const username = os.userInfo().username || "user";
	const comment = `${username}@${hostname}`;
	const result = `${base64Key} ${comment}\0`;

	self.log.debug("[DEBUG] Final ADB key length:", result.length, "chars");
	return result;
}

/**
 * Convert base64url (JWK format) to Buffer
 */
function base64UrlToBuf(b64url) {
	// Convert base64url (JWK) to normal base64
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	// Pad if needed
	const pad = b64.length % 4;
	const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
	return Buffer.from(padded, "base64");
}

/**
 * Write SSH string format (4-byte length + data)
 */
function writeSshString(bufs, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	bufs.push(len, data);
}

/**
 * Reads DER length encoding
 * @param {Buffer} buffer - DER buffer
 * @param {number} offset - Starting offset
 * @returns {Object} Object with length and new offset
 */
function readLength(buffer, offset) {
	const first = buffer[offset];
	offset++;

	if ((first & 0x80) === 0) {
		// Short form
		return { length: first, offset };
	}

	// Long form
	const lengthBytes = first & 0x7f;
	let length = 0;
	for (let i = 0; i < lengthBytes; i++) {
		length = (length << 8) | buffer[offset + i];
	}

	return { length, offset: offset + lengthBytes };
}

/**
 * Extracts key size from PEM private key (fallback for older Node.js)
 * @param {string} privateKey - Private key in PEM format
 * @returns {number} Key size in bytes
 */
function getKeySizeFromPem(privateKey) {
	try {
		// Convert PEM to DER
		const base64 = privateKey
			.replace(/-----BEGIN PRIVATE KEY-----/, "")
			.replace(/-----END PRIVATE KEY-----/, "")
			.replace(/\s/g, "");

		const derBuffer = Buffer.from(base64, "base64");

		// Parse PKCS#8 structure to find the RSA modulus
		// This is a simplified parser - for production use a proper ASN.1 library
		// PKCS#8: SEQUENCE { version, algorithm, privateKey }

		// For RSA-2048, return 256 bytes (2048/8)
		// For RSA-4096, return 512 bytes (4096/8)
		// Most ADB keys are 2048-bit
		if (derBuffer.length > 1000) {
			return 512; // Likely 4096-bit key
		} else {
			return 256; // Likely 2048-bit key
		}
	} catch (error) {
		self.log.debug("[DEBUG] Failed to parse key size from PEM, defaulting to 256 bytes:", error.message);
		return 256; // Default to 2048-bit (256 bytes)
	}
}
