/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.mjs
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

// Development environment check. devcheck.mjs exists only in a source checkout and exits the
// process when the checkout runs without --conditions=droidsock-dev. It is loaded synchronously,
// through require(esm), so it finishes before this module's exports can be called from ESM or
// CJS: nothing runs against the wrong tree first. There is no top-level await, which
// index.cjs's require(esm) would reject (ERR_REQUIRE_ASYNC_MODULE).
//
// node:module is looked up at runtime with process.getBuiltinModule instead of a static import,
// so bundlers never see a Node built-in: without process (a browser) the check is skipped.
// devcheck.mjs is never published, so MODULE_NOT_FOUND is expected outside a checkout; any other
// error is a real failure.
/* v8 ignore start -- the false branch is a non-Node runtime and the catch runs in the published
   package (no devcheck.mjs) or when devcheck.mjs fails to load; the suite always runs on Node
   from a checkout where devcheck.mjs exists and loads */
const nodeModule = typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:module");
if (nodeModule) {
	try {
		nodeModule.createRequire(import.meta.url)("./devcheck.mjs");
	} catch (error) {
		if (error?.code !== "MODULE_NOT_FOUND") throw error;
	}
}
/* v8 ignore stop */

/**
 * Creates a DroidSock instance for ADB communication. This is the default export - the
 * quick path - and also available under the explicit name `createDroidSock` for callers
 * who prefer it.
 * @param {object} [options={}] - Configuration options
 * @returns {Promise<object>} DroidSock instance
 */
async function droidsock(options = {}) {
	// Dynamic import after environment check
	const mod = await import("@cldmv/droidsock/main");
	return await mod.default(options);
}

export default droidsock;
export { droidsock as createDroidSock };

// Named export aliases
export { droidsock as DroidSock };
export { droidsock as ADB };
export { droidsock as AndroidDebugBridge };
