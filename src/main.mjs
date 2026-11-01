/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/main.mjs
 *	@Date: 2026-11-01T12:08:30-08:00 (1793563710)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:12:57-08:00 (1793563977)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Deprecated alias for the package root: `@cldmv/droidsock/main` re-exports
 * `@cldmv/droidsock` and prints a DeprecationWarning (code CLDMV_DROIDSOCK_MAIN) once per
 * process. Import "@cldmv/droidsock" instead. The alias is removed in the next major version.
 *
 * @module @cldmv/droidsock/main
 * @deprecated Import "@cldmv/droidsock" instead.
 */

const message = '"@cldmv/droidsock/main" is deprecated; import "@cldmv/droidsock" instead.';
if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
	process.emitWarning(message, { type: "DeprecationWarning", code: "CLDMV_DROIDSOCK_MAIN" });
} else {
	console.warn(`DeprecationWarning: ${message}`);
}
export * from "./index.mjs";
export { default } from "./index.mjs";
