/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.cjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T15:29:45-07:00 (1790980185)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * CommonJS entry point for DroidSock
 *
 * This file provides CommonJS (require) support for the DroidSock library.
 * It imports and re-exports the main DroidSock functions from the ESM module.
 *
 * @module droidsock
 */
"use strict";

// index.cjs is a thin wrapper: it loads index.mjs through Node's synchronous require(esm).
// Node.js versions without require(esm) would fail with a bare ERR_REQUIRE_ESM, so fail
// early with a message that says what to do instead.
if (!process.features?.require_module) {
	const error = new Error(
		`@cldmv/droidsock: require() needs Node.js ^20.19.0 or >=22.12.0 (this is ${process.version}). On older Node.js, load the package with import() instead.`
	);
	error.code = "ERR_REQUIRE_ESM";
	throw error;
}

const { default: droidsock } = require("./index.mjs");

// Export main function - the quick path, also callable with options
module.exports = droidsock; // Default export
module.exports.createDroidSock = droidsock;

// Common DroidSock aliases
module.exports.DroidSock = droidsock;
module.exports.ADB = droidsock;
module.exports.AndroidDebugBridge = droidsock;
