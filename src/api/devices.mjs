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
 * counterpart to device.mjs's single-target connect()/disconnect()/remove().
 * Every device that has ever been connected lives directly on this module's
 * own slothlet namespace (self.devices / api.devices) as a real,
 * individually-addressable leaf mounted by device.connect() (docs/RELOAD.md)
 * - disconnecting a device does NOT unmount its leaf (see device.mjs's
 * module doc), so list/disconnect/remove/get here operate over every known
 * device, connected or not, unless noted. Naming: the module boundary itself
 * disambiguates single vs. collection, so `disconnect()`/`remove()` here
 * take no arguments and mean "all" - `api.device.disconnect(host, port)` /
 * `api.device.remove(host, port)` are the single-target ops.
 */

import { self } from "@cldmv/slothlet/runtime";
import { parseHostPort, sanitizeKey } from "./utils.mjs";

/**
 * Returns the live device-leaf entries under self.devices, excluding this
 * module's own list/disconnect/remove/get siblings (identified by having a
 * callable isConnected() - the module's own exports are functions, not
 * objects, so this needs no hardcoded name list).
 * @returns {Array<Object>} Device leaf entries (regardless of connected state)
 */
function deviceEntries() {
	const registry = self.devices || {};
	return Object.keys(registry)
		.map((key) => registry[key])
		.filter((entry) => entry && typeof entry === "object" && typeof entry.isConnected === "function");
}

/**
 * Lists all currently-connected devices. A device that's known but currently
 * disconnected (still mounted, reconnectable via device.connect()) is NOT
 * included here - use get()/deviceEntries-style enumeration if you need
 * every known device regardless of connection state.
 * @returns {Array<Object>} Connected device leaves
 */
export function list() {
	return deviceEntries().filter((entry) => entry.isConnected());
}

/**
 * Looks up a device leaf - connected or currently disconnected - by
 * "host:port" string or by the leaf object itself (as returned by
 * device.connect()). Since disconnect() no longer unmounts a leaf, this
 * reliably re-resolves the SAME object across a disconnect/reconnect cycle;
 * it only returns undefined for a device that was never connected or has
 * since been forgotten via remove().
 * @param {string|Object} idOrLeaf - "host:port" (bracket the host for IPv6,
 *   e.g. "[2001:db8::1]:5555"), a bare host with the default port applied, or
 *   a device leaf object.
 * @returns {Object|undefined} The device leaf, or undefined if not mounted.
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
 * Disconnects every known device (connected or not - a no-op for one
 * that's already disconnected), keeping every leaf mounted for later
 * reconnection. Takes no arguments - the module boundary already means
 * "all"; use `api.device.disconnect(host, port)` to disconnect one.
 * Rejecting any argument here (rather than silently ignoring it) catches a
 * caller who confuses this with the single-target op before it disconnects
 * everything by accident. Synchronous - see device.mjs's disconnect() for why.
 * @returns {number} Number of devices disconnected
 */
export function disconnect() {
	if (arguments.length > 0) {
		throw new Error("devices.disconnect() takes no arguments - it disconnects ALL devices. Use device.disconnect(host, port) for one.");
	}
	// Only count (and call disconnect() on) entries that are actually
	// connected - deviceEntries() returns every known device regardless of
	// state, and disconnect() is a no-op for one that's already
	// disconnected, so counting all of them would make two consecutive
	// calls report the same "number disconnected" even though the second
	// call disconnected nothing.
	let count = 0;
	for (const entry of deviceEntries()) {
		if (!entry.isConnected()) continue;
		entry.disconnect();
		count++;
	}
	return count;
}

/**
 * Forgets every known device - disconnects each one (if still connected)
 * and unmounts its leaf. Takes no arguments, same reasoning as
 * disconnect(); use `api.device.remove(host, port)` to forget just one.
 * Async - this is the operation that does real api-tree surgery.
 * @returns {Promise<number>} Number of devices removed
 */
export async function remove() {
	if (arguments.length > 0) {
		throw new Error("devices.remove() takes no arguments - it removes ALL devices. Use device.remove(host, port) for one.");
	}
	const entries = deviceEntries();
	let count = 0;
	for (const entry of entries) {
		await entry.remove();
		count++;
	}
	return count;
}
