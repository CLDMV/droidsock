/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: src/index.cjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-28T09:53:41-08:00 (1795888421)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview CommonJS entry point: `require("@cldmv/droidsock")` returns the `createDroidSock` function, the one
 * value the ESM entry exports (under `default`, `createDroidSock`, `DroidSock`, `ADB` and `AndroidDebugBridge`), so
 * `require(x)(...)` works. It carries no alias properties; use `import { ADB } from "@cldmv/droidsock"` for the
 * named exports. tsup.config.mjs copies this file verbatim to dist/index.cjs.
 *
 * @module droidsock
 */
"use strict";

if (!process.features?.require_module) {
	const error = new Error(
		`@cldmv/droidsock: require() needs Node.js >=22.15.0 (this is ${process.version}). On older Node.js, load the package with import() instead.`
	);
	error.code = "ERR_REQUIRE_ESM";
	throw error;
}

// Same exports as `import`. One distinct exported value (aliases of it count once) comes back as that value,
// so require(x)(...) works; anything else comes back as the module object ({ default, ...named }).
const esm = require("./index.mjs");
const values = new Set(
	Object.keys(esm)
		.filter((key) => key !== "__esModule")
		.map((key) => esm[key])
);
module.exports = values.size === 1 ? values.values().next().value : esm;
