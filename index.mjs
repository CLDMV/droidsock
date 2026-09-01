/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 21:00:34 -07:00 (1788148834)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

// Development environment check (must happen before droidsock imports)
(async () => {
	try {
		await import("./devcheck.mjs");
	} catch {
		// ignore
	}
})();

/**
 * Creates a DroidSock instance for ADB communication. This is the default export - the
 * quick path - and also available under the explicit name `createDroidSock` for callers
 * who prefer it.
 * @param {object} [options={}] - Configuration options
 * @returns {Promise<object>} DroidSock instance
 */
async function droidsock(options = {}) {
	// Dynamic import after environment check
	const mod = await import("@cldmv/droidsock/main");
	return await mod.default(options);
}

export default droidsock;
export { droidsock as createDroidSock };

// Named export aliases
export { droidsock as DroidSock };
export { droidsock as ADB };
export { droidsock as AndroidDebugBridge };
