/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/log.mjs
 *	@Date: 2025-11-21 13:35:03 -08:00 (1763760903)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:05:31 -08:00 (1763762731)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Logger module for DroidSock ADB client
 * Provides configurable logging throughout the API
 */

import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Get current configuration
 * @returns {Object} Configuration object
 */
function getConfig() {
	return self.config;
}

/**
 * Get log prefix
 * @returns {string} Log prefix
 */
function getPrefix() {
	return getConfig().get("eventPrefix", "adb");
}

/**
 * Log a debug message
 * @param {...*} args - Arguments to log
 */
export function debug(...args) {
	if (getConfig().get("silent")) return;
	if (!getConfig().get("debug")) return;
	console.log(`[${getPrefix()}][DEBUG]`, ...args);
}

/**
 * Log a verbose message
 * @param {...*} args - Arguments to log
 */
export function verbose(...args) {
	if (getConfig().get("silent")) return;
	if (!getConfig().get("verbose") && !getConfig().get("debug")) return;
	console.log(`[${getPrefix()}][VERBOSE]`, ...args);
}

/**
 * Log an info message
 * @param {...*} args - Arguments to log
 */
export function info(...args) {
	if (getConfig().get("silent")) return;
	console.log(`[${getPrefix()}][INFO]`, ...args);
}

/**
 * Log a warning message
 * @param {...*} args - Arguments to log
 */
export function warn(...args) {
	if (getConfig().get("silent")) return;
	console.warn(`[${getPrefix()}][WARN]`, ...args);
}

/**
 * Log an error message
 * @param {...*} args - Arguments to log
 */
export function error(...args) {
	if (getConfig().get("silent")) return;
	console.error(`[${getPrefix()}][ERROR]`, ...args);
}

/**
 * Create a child logger with additional context
 * @param {string} context - Additional context for the logger
 * @returns {Object} Child logger functions
 */
export function child(context) {
	const childPrefix = `[${getPrefix()}][${context}]`;

	return {
		debug: (...args) => {
			if (getConfig().get("silent")) return;
			if (!getConfig().get("debug")) return;
			console.log(`${childPrefix}[DEBUG]`, ...args);
		},
		verbose: (...args) => {
			if (getConfig().get("silent")) return;
			if (!getConfig().get("verbose") && !getConfig().get("debug")) return;
			console.log(`${childPrefix}[VERBOSE]`, ...args);
		},
		info: (...args) => {
			if (getConfig().get("silent")) return;
			console.log(`${childPrefix}[INFO]`, ...args);
		},
		warn: (...args) => {
			if (getConfig().get("silent")) return;
			console.warn(`${childPrefix}[WARN]`, ...args);
		},
		error: (...args) => {
			if (getConfig().get("silent")) return;
			console.error(`${childPrefix}[ERROR]`, ...args);
		}
	};
}

/**
 * Get the logger API
 * @returns {Object} Logger API
 */
export function getApi() {
	return {
		debug,
		verbose,
		info,
		warn,
		error,
		child
	};
}
