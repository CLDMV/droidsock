/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/reboot.mjs
 *	@Date: 2026-09-01 11:43:14 -07:00 (1788288194)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 11:43:14 -07:00 (1788288194)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Reboot service API module for DroidSock
 */

/**
 * Reboots the device via the real ADB `reboot:` service - a distinct
 * top-level service (like `shell:`/`sync:`), not a shell command. Supports
 * the standard mode variants (`""` for a normal reboot, `"bootloader"`,
 * `"recovery"`, `"sideload"`, `"sideload-auto-reboot"`) and passes any other
 * string through as-is, since some devices support additional
 * vendor-specific reboot targets.
 * EXPERIMENTAL - implemented from the ADB protocol spec, not yet validated
 * against a real device. See #2.
 * @param {Object} ___socket - ADB socket (unused - the stream is opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {string} [mode=""] - Reboot mode/target
 * @returns {Promise<void>}
 */
export async function execute(___socket, streamManager, mode = "") {
	const stream = await streamManager.openStream(`reboot:${mode}`);
	try {
		// closeStream() (not stream.close()) so the stream manager also drops
		// its registry entry - calling close() directly would leave a closed
		// stream referenced in streamManager.streams indefinitely.
		streamManager.closeStream(stream.localId);
	} catch {
		// The device is rebooting and may have already torn down the
		// connection by the time we try to close our end - not an error.
	}
}
