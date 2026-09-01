/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/auth.test.vitest.mjs
 *	@Date: 2026-08-30 15:58:01 -07:00 (1788130681)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import createDroidSock from "../src/droidsock.mjs";

// auth.mjs calls self.log.debug() internally, so it must be exercised through
// the composed slothlet API (which binds `self`), not by importing the module
// directly.
let droidsock;
let tmpKeyDir;

beforeAll(async () => {
	droidsock = await createDroidSock({ config: { silent: true } });
	tmpKeyDir = mkdtempSync(path.join(tmpdir(), "droidsock-auth-test-"));
});

afterAll(async () => {
	rmSync(tmpKeyDir, { recursive: true, force: true });
	if (droidsock.shutdown) await droidsock.shutdown();
});

describe("auth.generateKeys", () => {
	test("generates a usable RSA keypair without writing to disk when no directory is given", () => {
		const keys = droidsock.auth.generateKeys(1024);
		expect(keys.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
		expect(keys.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
		expect(typeof keys.adbPublicKey).toBe("string");
	});

	test("formats the ADB public key as base64 + comment + null terminator", () => {
		const keys = droidsock.auth.generateKeys(1024);
		expect(keys.adbPublicKey.endsWith("\0")).toBe(true);
		expect(keys.adbPublicKey).toMatch(/^[A-Za-z0-9+/=]+ .+\0$/);
	});

	test("writes adbkey/adbkey.pub when a save directory is given", () => {
		const dir = path.join(tmpKeyDir, "generate-with-save");
		droidsock.auth.generateKeys(1024, dir);
		expect(existsSync(path.join(dir, "adbkey"))).toBe(true);
		expect(existsSync(path.join(dir, "adbkey.pub"))).toBe(true);
	});
});

describe("auth.getKeys", () => {
	test("generates and persists a fresh keypair the first time a directory is used", () => {
		const dir = path.join(tmpKeyDir, "get-keys-fresh");
		const keys = droidsock.auth.getKeys(dir);
		expect(existsSync(path.join(dir, "adbkey"))).toBe(true);
		expect(keys.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
	});

	test("reuses an existing keypair instead of generating a new one", () => {
		const dir = path.join(tmpKeyDir, "get-keys-reuse");
		const first = droidsock.auth.getKeys(dir);
		const second = droidsock.auth.getKeys(dir);
		expect(second.privateKey).toBe(first.privateKey);
		expect(second.adbPublicKey).toBe(first.adbPublicKey);
	});

	test("re-derives the same public key from the persisted private key on reuse", () => {
		const dir = path.join(tmpKeyDir, "get-keys-derive");
		const first = droidsock.auth.getKeys(dir);
		const privateKeyOnDisk = readFileSync(path.join(dir, "adbkey"), "utf8");
		expect(privateKeyOnDisk).toBe(first.privateKey);
	});
});

describe("auth.sign", () => {
	test("produces a signature the same length as the RSA modulus", () => {
		const keys = droidsock.auth.generateKeys(1024);
		const token = crypto.randomBytes(20);
		const signature = droidsock.auth.sign(token, keys.privateKey);
		expect(signature.length).toBe(128); // 1024-bit key -> 128-byte signature
	});

	test("accepts a non-Buffer 20-byte token and converts it", () => {
		const keys = droidsock.auth.generateKeys(1024);
		const token = Array.from(crypto.randomBytes(20)); // plain array, not a Buffer
		const signature = droidsock.auth.sign(token, keys.privateKey);
		expect(signature.length).toBe(128);
	});

	// sign() accepts whatever PEM the caller hands it, not only keys this module
	// generated. asymmetricKeySize is undefined for every non-RSA key type on
	// Node (verified directly: RSA/DSA/EC/Ed25519/Ed448/X25519 all checked), so a
	// real key of the wrong type reaches the fallback path in the middle of
	// sign() - it still fails overall (RSA-specific privateEncrypt can't work on
	// a non-RSA key), but only after exercising that fallback for real.
	test("falls back to keyDetails.modulusLength for a DSA key, then fails at the RSA-only encrypt step", () => {
		const { privateKey } = crypto.generateKeyPairSync("dsa", {
			modulusLength: 1024,
			privateKeyEncoding: { type: "pkcs8", format: "pem" }
		});
		const token = crypto.randomBytes(20);
		expect(() => droidsock.auth.sign(token, privateKey)).toThrow();
	});

	test("falls back to getKeySizeFromPem for a curve-based key with no modulus, then fails at the RSA-only encrypt step", () => {
		const { privateKey } = crypto.generateKeyPairSync("ed25519", {
			privateKeyEncoding: { type: "pkcs8", format: "pem" }
		});
		const token = crypto.randomBytes(20);
		expect(() => droidsock.auth.sign(token, privateKey)).toThrow();
	});

	test("produces a verifiable signature over the AOSP-style DigestInfo(token) block", () => {
		const keys = droidsock.auth.generateKeys(2048);
		const token = crypto.randomBytes(20);
		const signature = droidsock.auth.sign(token, keys.privateKey);

		const DIGESTINFO_SHA1_PREFIX = Buffer.from([0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14]);
		const digestInfo = Buffer.concat([DIGESTINFO_SHA1_PREFIX, token]);

		// The signature was produced with raw RSA + manual PKCS#1v1.5 padding
		// (no hashing), so verify it the same way: decrypt with the public key
		// and confirm the recovered block ends with our DigestInfo(token).
		const publicKeyObj = crypto.createPublicKey(keys.publicKey);
		const recovered = crypto.publicDecrypt({ key: publicKeyObj, padding: crypto.constants.RSA_NO_PADDING }, signature);
		expect(recovered.subarray(recovered.length - digestInfo.length).equals(digestInfo)).toBe(true);
	});

	test("rejects a token that isn't exactly 20 bytes", () => {
		const keys = droidsock.auth.generateKeys(1024);
		expect(() => droidsock.auth.sign(Buffer.from("too short"), keys.privateKey)).toThrow("Token must be 20 bytes");
	});
});

describe("auth.validateAuth", () => {
	test("returns true for a token/key pair that signs successfully", () => {
		const keys = droidsock.auth.generateKeys(1024);
		const token = crypto.randomBytes(20);
		expect(droidsock.auth.validateAuth(token, keys.privateKey)).toBe(true);
	});

	test("returns false for a token that isn't a 20-byte buffer", () => {
		const keys = droidsock.auth.generateKeys(1024);
		expect(droidsock.auth.validateAuth(Buffer.from("short"), keys.privateKey)).toBe(false);
	});

	test("returns false for a key that isn't a PEM private key string", () => {
		const token = crypto.randomBytes(20);
		expect(droidsock.auth.validateAuth(token, "not a key")).toBe(false);
	});

	test("returns false when the key has the right header but is otherwise corrupt", () => {
		// Passes the naive header check but fails inside sign() itself
		// (crypto.createPrivateKey rejects it) - exercises validateAuth's catch path.
		const token = crypto.randomBytes(20);
		const corruptKey = "-----BEGIN PRIVATE KEY-----\nnot-actually-valid-base64-der\n-----END PRIVATE KEY-----";
		expect(droidsock.auth.validateAuth(token, corruptKey)).toBe(false);
	});
});
