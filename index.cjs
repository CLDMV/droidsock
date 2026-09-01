/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.cjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 21:00:34 -07:00 (1788148834)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * CommonJS entry point for DroidSock
 *
 * This file provides CommonJS (require) support for the DroidSock library.
 * It imports and re-exports the main DroidSock functions from the ESM module.
 *
 * @module droidsock
 */

const { createRequire } = require("module");
const requireESM = createRequire(__filename);

const { default: droidsock } = requireESM("./index.mjs");

// Export main function - the quick path, also callable with options
module.exports = droidsock; // Default export
module.exports.createDroidSock = droidsock;

// Common DroidSock aliases
module.exports.DroidSock = droidsock;
module.exports.ADB = droidsock;
module.exports.AndroidDebugBridge = droidsock;
