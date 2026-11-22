/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/resolve.test.vitest.mjs
 *	@Date: 2026-11-07T21:58:44-08:00 (1794117524)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-07T21:59:31-08:00 (1794117571)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * The tests import "@cldmv/droidsock" by name, so the droidsock-dev condition decides what they run against: src/ for `npm test`, the
 * build in dist/ for `npm run test:dist` (`--mode=dist`). This checks the name resolved to that tree.
 */
import { describe, it, expect } from "vitest";
import * as pkg from "@cldmv/droidsock";

describe("the @cldmv/droidsock import", () => {
	it(`resolves to ${import.meta.env.MODE === "dist" ? "dist/" : "src/"}`, async () => {
		const expected = import.meta.env.MODE === "dist" ? await import("../dist/index.mjs") : await import("../src/index.mjs");
		expect(pkg.default).toBe(expected.default);
		expect(pkg.createDroidSock).toBe(expected.createDroidSock);
	});
});
