/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/install.mjs
 *	@Date: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 16:20:29 -07:00 (1788304829)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Local APK install API module for DroidSock (adb install equivalent)
 */

import { self } from "@cldmv/slothlet/runtime";
import path from "node:path";

/**
 * Installs a local APK using the classic push-then-install flow: pushes the
 * file to a device temp directory via the existing SYNC-based push, runs
 * `pm install` against it, then removes the pushed temp file regardless of
 * whether the install succeeded. Pure composition of two already-implemented
 * primitives (files.push, shell.commands.installApk) - no new protocol work.
 * EXPERIMENTAL - depends on files.push(), which hasn't been validated
 * against a real device yet. See #2.
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} localPath - Local APK file path
 * @param {Object} [options={}] - Options
 * @param {Array<string>} [options.flags=[]] - `pm install` flags (e.g. ["-r"] to reinstall)
 * @param {string} [options.remoteDir="/data/local/tmp"] - Device directory to push the APK into
 * @param {Function} [options.onProgress] - Push progress callback, see files.push
 * @returns {Promise<string>} `pm install`'s output
 */
export async function classic(socket, streamManager, localPath, options = {}) {
	const { flags = [], remoteDir = "/data/local/tmp", onProgress } = options;
	// path.posix specifically - the device path is always POSIX regardless of
	// the host OS running droidsock, and join() also normalizes a remoteDir
	// that already ends in "/" instead of producing a double slash.
	const remotePath = path.posix.join(remoteDir, path.basename(localPath));

	try {
		await self.files.push(socket, streamManager, localPath, remotePath, { onProgress });
		return await self.shell.commands.installApk(socket, streamManager, remotePath, flags);
	} finally {
		// Best-effort cleanup regardless of whether push or install failed - if push
		// threw partway through, the device can be left with a partial temp APK at
		// remotePath, and files.push itself doesn't clean up after its own failures.
		await self.files.remove(socket, streamManager, remotePath).catch(() => {
			// A failed remove here shouldn't mask the install result/error.
		});
	}
}
