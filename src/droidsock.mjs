/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/droidsock.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * DroidSock - Android Debug Bridge Client
 * Entry point for slothlet-based modular API
 */

import slothlet from "@cldmv/slothlet";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a new DroidSock API instance with slothlet modular loading
 * @param {Object} options - Configuration options
 * @param {string} [options.mode='eager'] - Loading mode: 'lazy' or 'eager'
 * @param {Object} [options.context={}] - Context object for API modules
 * @param {Object} [options.config={}] - Initial configuration options
 * @returns {Promise<Object>} The DroidSock API instance
 */
export default async function createDroidSock(options = {}) {
	const { mode = "eager", context = {}, config = {}, ...slothletOptions } = options;

	// Create slothlet API with our api folder
	const api = await slothlet({
		base: path.join(__dirname, "api"),
		mode,
		runtime: "async", // AsyncLocalStorage context propagation for self-references
		context: {
			...context
			// Add any default context here
		},
		debug: false, // Will be controlled by config module
		// Sanitize options for clean API naming
		sanitize: {
			lowerFirst: false,
			rules: {
				leave: ["ADB", "TCP", "USB", "Auth", "Sync"],
				upper: ["adb*", "tcp*", "usb*"]
			}
		},
		...slothletOptions
	});

	// Initialize config with provided options
	if (Object.keys(config).length > 0) {
		api.config.init(config);
	}

	return api;
}
