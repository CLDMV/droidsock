/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/index.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T09:30:21-08:00 (1793554221)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Public entry point for @cldmv/droidsock.
 *
 * The default export is `createDroidSock(options)`, also exported as `createDroidSock`, `DroidSock`, `ADB`
 * and `AndroidDebugBridge`; all five are the same function.
 *
 * ./droidsock.mjs (and @cldmv/slothlet with it) is loaded with a dynamic `import()` on the first call
 * instead of a static import: slothlet's module graph uses top-level await, and `require()` of an ES
 * module (src/index.cjs) rejects any graph that contains one with ERR_REQUIRE_ASYNC_MODULE.
 *
 * @module @cldmv/droidsock
 */

/**
 * Creates a DroidSock instance for ADB communication: composes the slothlet api in ./api.
 * @param {object} [options={}] - Configuration options (see ./droidsock.mjs).
 * @param {string} [options.mode="eager"] - Loading mode: "lazy" or "eager".
 * @param {object} [options.context={}] - Context object for API modules.
 * @param {object} [options.config={}] - Initial configuration options.
 * @returns {Promise<object>} The DroidSock API instance.
 */
export default async function createDroidSock(options = {}) {
	const { default: create } = await import("./droidsock.mjs");
	return create(options);
}

export { createDroidSock, createDroidSock as DroidSock, createDroidSock as ADB, createDroidSock as AndroidDebugBridge };
