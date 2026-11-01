/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/cjs-source.test.vitest.mjs
 *	@Date: 2026-11-01T12:11:08-08:00 (1793563868)
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
 * @fileoverview Source-level check of the CommonJS entry: src/index.cjs, loaded through a real
 * `require()`, returns the same factory and aliases as src/index.mjs. The built dist/index.cjs is
 * covered by tests/cjs/entry.test.cjs (`npm run test:cjs`).
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);

describe("src/index.cjs", () => {
	test("exports the factory itself, with the named aliases as properties", async () => {
		const cjs = require("../src/index.cjs");
		// require(esm) runs under Node's own loader, so compare against the same instance of src/index.mjs.
		const esm = require("../src/index.mjs");

		expect(typeof cjs).toBe("function");
		expect(cjs).toBe(esm.default);
		for (const name of ["createDroidSock", "DroidSock", "ADB", "AndroidDebugBridge"]) {
			expect(cjs[name], name).toBe(esm[name]);
		}
	});
});
