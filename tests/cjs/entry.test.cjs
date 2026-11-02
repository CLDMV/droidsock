/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/cjs/entry.test.cjs
 *	@Date: 2026-10-03T00:00:00-07:00 (1791010800)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T16:38:36-08:00 (1793579916)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Checks the built dist/ output: the CJS entry re-exports the ESM entry, the deprecated
 * ./main alias re-exports the root, dist/ mirrors the api folder slothlet scans, and a DroidSock
 * instance composes from dist/api. Runs under Node's own test runner (`node --test`), not Vitest, after
 * `npm run build` (see `test:cjs`): Vitest loads files through its own module runner, so it cannot show
 * whether a plain `require()` of the package works the way it does for a CommonJS consumer.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const dist = path.join(root, "dist");
const aliases = ["createDroidSock", "DroidSock", "ADB", "AndroidDebugBridge"];

test("dist/index.cjs is a verbatim copy of src/index.cjs, not a second bundle", () => {
	assert.equal(fs.readFileSync(path.join(dist, "index.cjs"), "utf8"), fs.readFileSync(path.join(root, "src/index.cjs"), "utf8"));
});

test("require() returns the same droidsock factory as import", async () => {
	const droidsock = require(path.join(dist, "index.cjs"));
	const esm = await import(pathToFileURL(path.join(dist, "index.mjs")).href);

	// droidsock() opens no connection by itself, but only identity/type is checked here.
	assert.equal(typeof droidsock, "function");
	assert.equal(droidsock, esm.default);
	assert.deepEqual(Object.keys(esm).sort(), ["ADB", "AndroidDebugBridge", "DroidSock", "createDroidSock", "default"]);
	for (const name of aliases) assert.equal(droidsock[name], esm[name], name);
});

test('require("dist/index.cjs") returns the same function as the ESM default of dist/index.mjs and dist/droidsock.mjs', async () => {
	const droidsock = require(path.join(dist, "index.cjs"));
	const esm = await import(pathToFileURL(path.join(dist, "index.mjs")).href);
	const factory = await import(pathToFileURL(path.join(dist, "droidsock.mjs")).href);

	assert.equal(droidsock, esm.default);
	// index.mjs re-exports the factory directly, so the package default is createDroidSock itself.
	assert.equal(esm.default, factory.default);
	assert.equal(droidsock.name, "createDroidSock");
});

test("dist/main.mjs re-exports dist/index.mjs and warns once", () => {
	const script = `
		const warnings = [];
		process.on("warning", (w) => warnings.push(w));
		const alias = await import(${JSON.stringify(pathToFileURL(path.join(dist, "main.mjs")).href)});
		await import(${JSON.stringify(pathToFileURL(path.join(dist, "main.mjs")).href)});
		const rootEntry = await import(${JSON.stringify(pathToFileURL(path.join(dist, "index.mjs")).href)});
		await new Promise((resolve) => setImmediate(resolve));
		const same = Object.keys(rootEntry).every((key) => alias[key] === rootEntry[key]);
		console.log(JSON.stringify({ same, keys: Object.keys(alias).sort(), codes: warnings.map((w) => w.code) }));
	`;
	const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const out = JSON.parse(res.stdout);
	assert.equal(out.same, true);
	assert.deepEqual(out.keys, ["ADB", "AndroidDebugBridge", "DroidSock", "createDroidSock", "default"]);
	assert.deepEqual(out.codes, ["CLDMV_DROIDSOCK_MAIN"]);
	// dist/main.mjs imports ./index.mjs rather than carrying its own copy of the library.
	assert.ok(fs.statSync(path.join(dist, "main.mjs")).size < 1024);
});

test("dist mirrors the api folder slothlet scans", () => {
	for (const file of ["droidsock.mjs", "api/connection.mjs", "api/device.mjs", "api/shell.mjs", "api/utils.mjs"]) {
		assert.ok(fs.existsSync(path.join(dist, file)), `${file} is missing from dist`);
	}
});

test("a DroidSock instance composes from dist/api", async () => {
	const droidsock = require(path.join(dist, "index.cjs"));
	const api = await droidsock({ config: { debug: true } });
	try {
		for (const mod of ["auth", "config", "connection", "device", "devices", "shell", "stream", "utils"]) {
			assert.ok(api[mod], `missing module: ${mod}`);
		}
		assert.equal(typeof api.device.connect, "function");
		assert.equal(api.config.get("debug"), true);
	} finally {
		if (api.shutdown) await api.shutdown();
	}
});

test("require() fails with a clear message where Node.js has no require(esm)", () => {
	// --no-experimental-require-module turns require(esm) off, which is what Node.js
	// versions before 20.19 / 22.12 look like to the entry.
	const res = spawnSync(process.execPath, ["--no-experimental-require-module", "-e", "require('./dist/index.cjs')"], {
		cwd: root,
		encoding: "utf8"
	});

	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /ERR_REQUIRE_ESM/);
	assert.match(res.stderr, /require\(\) needs Node\.js >=22\.15\.0/);
	assert.match(res.stderr, /import\(\)/);
});
