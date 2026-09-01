/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/files.mjs
 *	@Date: 2025-11-21 12:19:19 -08:00 (1763756359)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * File transfer operations API module for DroidSock
 */

import { self } from "@cldmv/slothlet/runtime";

/**
 * Pushes a file to the device
 * @param {Object} ___socket - ADB socket
 * @param {Object} ___streamManager - Stream manager instance
 * @param {string} ___localPath - Local file path
 * @param {string} ___remotePath - Remote file path on device
 * @param {Object} [___options={}] - Transfer options
 * @param {Function} [___options.onProgress] - Progress callback
 * @param {number} [___options.mode=0o644] - File permissions
 * @returns {Promise<void>}
 */
export async function push(___socket, ___streamManager, ___localPath, ___remotePath, ___options = {}) {
	throw new Error("File push not yet implemented in slothlet structure");
}

/**
 * Pulls a file from the device
 * @param {Object} ___socket - ADB socket
 * @param {Object} ___streamManager - Stream manager instance
 * @param {string} ___remotePath - Remote file path on device
 * @param {string} ___localPath - Local file path
 * @param {Object} [___options={}] - Transfer options
 * @param {Function} [___options.onProgress] - Progress callback
 * @returns {Promise<void>}
 */
export async function pull(___socket, ___streamManager, ___remotePath, ___localPath, ___options = {}) {
	throw new Error("File pull not yet implemented in slothlet structure");
}

/**
 * Lists directory contents on device
 * @param {Object} ___socket - ADB socket
 * @param {Object} ___streamManager - Stream manager instance
 * @param {string} ___remotePath - Remote directory path
 * @returns {Promise<Array>} Array of directory entries
 */
export async function list(___socket, ___streamManager, ___remotePath) {
	throw new Error("Directory listing not yet implemented in slothlet structure");
}

/**
 * Gets file/directory stats on device
 * @param {Object} ___socket - ADB socket
 * @param {Object} ___streamManager - Stream manager instance
 * @param {string} ___remotePath - Remote path
 * @returns {Promise<Object>} Stat information
 */
export async function stat(___socket, ___streamManager, ___remotePath) {
	throw new Error("File stat not yet implemented in slothlet structure");
}

/**
 * Creates a directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote directory path
 * @param {number} [mode=0o755] - Directory permissions
 * @returns {Promise<void>}
 */
export async function mkdir(socket, streamManager, remotePath, mode = 0o755) {
	// Use shell command to create directory
	const command = `mkdir -p "${remotePath}" && chmod ${mode.toString(8)} "${remotePath}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Removes a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path to remove
 * @param {boolean} [recursive=false] - Remove recursively
 * @returns {Promise<void>}
 */
export async function remove(socket, streamManager, remotePath, recursive = false) {
	const flag = recursive ? "-rf" : "-f";
	const command = `rm ${flag} "${remotePath}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Moves/renames a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @returns {Promise<void>}
 */
export async function move(socket, streamManager, sourcePath, destPath) {
	const command = `mv "${sourcePath}" "${destPath}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Copies a file or directory on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @param {boolean} [recursive=false] - Copy recursively
 * @returns {Promise<void>}
 */
export async function copy(socket, streamManager, sourcePath, destPath, recursive = false) {
	const flag = recursive ? "-r" : "";
	const command = `cp ${flag} "${sourcePath}" "${destPath}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Changes file permissions on device
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} remotePath - Remote path
 * @param {number} mode - Permission mode (e.g., 0o644)
 * @param {boolean} [recursive=false] - Apply recursively
 * @returns {Promise<void>}
 */
export async function chmod(socket, streamManager, remotePath, mode, recursive = false) {
	const flag = recursive ? "-R" : "";
	const command = `chmod ${flag} ${mode.toString(8)} "${remotePath}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Gets disk usage information
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} [path='/'] - Path to check
 * @returns {Promise<string>} Disk usage output
 */
export async function diskUsage(socket, streamManager, path = "/") {
	const command = `df -h "${path}"`;
	return await self.shell.execute(socket, streamManager, command);
}

/**
 * Finds files matching a pattern
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} path - Starting path
 * @param {string} pattern - File pattern (e.g., '*.txt')
 * @param {Object} [options={}] - Find options
 * @param {number} [options.maxDepth] - Maximum search depth
 * @param {string} [options.type] - File type (f=file, d=directory)
 * @returns {Promise<string>} Find results
 */
export async function find(socket, streamManager, path, pattern, options = {}) {
	let command = `find "${path}"`;

	if (options.maxDepth) {
		command += ` -maxdepth ${options.maxDepth}`;
	}

	if (options.type) {
		command += ` -type ${options.type}`;
	}

	command += ` -name "${pattern}"`;

	return await self.shell.execute(socket, streamManager, command);
}
