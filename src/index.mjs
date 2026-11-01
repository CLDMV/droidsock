/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/index.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:20:54-08:00 (1793564454)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Public entry point for @cldmv/droidsock.
 *
 * The default export is `createDroidSock(options)` from ./droidsock.mjs, which composes the slothlet api in ./api
 * and resolves to the DroidSock instance. It is also exported as `createDroidSock`, `DroidSock`, `ADB` and
 * `AndroidDebugBridge`; all five are the same function.
 *
 * The module graph has no top-level await, so src/index.cjs can load this file through `require(esm)`.
 *
 * @module @cldmv/droidsock
 */

export { default, default as createDroidSock, default as DroidSock, default as ADB, default as AndroidDebugBridge } from "./droidsock.mjs";
