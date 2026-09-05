/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/devices.mjs
 *	@Date: 2025-11-21 12:18:12 -08:00 (1763756292)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Device connection registry API module for DroidSock - the collection-wide
 * counterpart to device.mjs's single-target connect()/disconnect(). Every
 * connected device lives directly on this module's own slothlet namespace
 * (self.devices / api.devices) as a real, individually-addressable leaf
 * mounted by device.connect() (docs/RELOAD.md), alongside this module's own
 * list/disconnect/get exports. Naming: the module boundary itself
 * disambiguates single vs. collection, so `disconnect()` here takes no
 * arguments and means "all" - `api.device.disconnect(host, port)` is the
 * single-target op.
 */

import { self } from "@cldmv/slothlet/runtime";
import { parseHostPort, sanitizeKey } from "./utils.mjs";

/**
 * Returns the live device-leaf entries under self.devices, excluding this
 * module's own list/disconnect/get siblings (identified by having a callable
 * isConnected() - the module's own exports are functions, not objects, so
 * this needs no hardcoded name list).
 * @returns {Array<Object>} Device leaf entries (regardless of connected state)
 */
function deviceEntries() {
	const registry = self.devices || {};
	return Object.keys(registry)
		.map((key) => registry[key])
		.filter((entry) => entry && typeof entry === "object" && typeof entry.isConnected === "function");
}

/**
 * Lists all currently-connected devices.
 * @returns {Array<Object>} Connected device leaves
 */
export function list() {
	return deviceEntries().filter((entry) => entry.isConnected());
}

/**
 * Looks up a connected device leaf by "host:port" string or by the leaf
 * object itself (as returned by device.connect()). This is the safe way to
 * re-resolve a leaf reference - e.g. after a prior disconnect() call left an
 * old reference with none of its composed methods (see device.mjs's
 * buildDeviceLeaf module doc) - instead of calling methods on a stale
 * object: get() returns undefined for anything not currently mounted, rather
 * than the stale reference itself.
 * @param {string|Object} idOrLeaf - "host:port" (bracket the host for IPv6,
 *   e.g. "[2001:db8::1]:5555"), a bare host with the default port applied, or
 *   a device leaf object.
 * @returns {Object|undefined} The live device leaf, or undefined if not mounted.
 */
export function get(idOrLeaf) {
	let host, port;
	if (idOrLeaf && typeof idOrLeaf === "object") {
		({ host, port } = idOrLeaf);
	} else {
		({ host, port } = parseHostPort(String(idOrLeaf)));
	}
	const key = sanitizeKey(`${host}:${port}`);
	return (self.devices && self.devices[key]) || undefined;
}

/**
 * Disconnects every connected device, including stale entries left over from
 * an unexpected disconnect (not just the ones list() returns). Takes no
 * arguments - the module boundary already means "all"; use
 * `api.device.disconnect(host, port)` to disconnect one. Rejecting any
 * argument here (rather than silently ignoring it) catches a caller who
 * confuses this with the single-target op before it disconnects everything
 * by accident.
 * @returns {Promise<number>} Number of devices disconnected
 */
export async function disconnect() {
	if (arguments.length > 0) {
		throw new Error("devices.disconnect() takes no arguments - it disconnects ALL devices. Use device.disconnect(host, port) for one.");
	}
	const entries = deviceEntries();
	let count = 0;
	for (const entry of entries) {
		await entry.disconnect();
		count++;
	}
	return count;
}
