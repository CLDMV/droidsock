/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/index.cjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T16:38:35-08:00 (1793579915)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * CommonJS entry point: a thin, synchronous re-export of the ESM entry.
 *
 * Node's `require()` loads an ES module synchronously as long as its module graph has no
 * top-level await, so this file re-exports ./index.mjs instead of a second, CommonJS build
 * of the library. tsup.config.mjs copies it verbatim to dist/index.cjs; `./index.mjs`
 * resolves to the sibling src/index.mjs in a checkout and to the build in dist/.
 *
 * The CommonJS shape is the factory itself (`module.exports = createDroidSock`), with the
 * named aliases as properties on it.
 *
 * @module droidsock
 */
"use strict";

// Node.js versions without require(esm) (before 20.19 / 22.12) would fail with a bare
// ERR_REQUIRE_ESM, so fail early with a message that says what to do instead.
if (!process.features?.require_module) {
	const error = new Error(
		`@cldmv/droidsock: require() needs Node.js >=22.15.0 (this is ${process.version}). On older Node.js, load the package with import() instead.`
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
