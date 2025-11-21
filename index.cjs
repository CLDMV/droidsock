/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.cjs
 *	@Date: 2025-11-21 14:04:10 -08:00
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 16:22:18 -08:00
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
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

const { default: createDroidSock, connect, listDevices } = requireESM("./index.mjs");

// Export main function
module.exports = createDroidSock; // Default export
module.exports.createDroidSock = createDroidSock;
module.exports.connect = connect;
module.exports.listDevices = listDevices;

// Common DroidSock aliases
module.exports.DroidSock = createDroidSock;
module.exports.ADB = createDroidSock;
module.exports.AndroidDebugBridge = createDroidSock;
