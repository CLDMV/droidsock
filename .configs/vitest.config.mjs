/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:12:53-08:00 (1793563973)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { devCondition } from "@cldmv/configs/vitest.config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// devCondition() puts the package's droidsock-dev condition (which routes "@cldmv/droidsock"
// to src/ instead of a stale or unbuilt dist/) ahead of Vite's default conditions for the
// client and SSR resolvers, and on the worker command line so Node's own resolver uses it too.
export default mergeConfig(
	devCondition({ root }),
	defineConfig({
		test: {
			include: ["tests/**/*.test.vitest.mjs"],
			exclude: ["node_modules"],
			environment: "node",
			// Pays the one-time cold cost of composing a droidsock instance before each file is
			// collected, outside any timed hook - see the file's own doc comment.
			setupFiles: [fileURLToPath(new URL("../tests/setup/warm-droidsock.mjs", import.meta.url))],
			testTimeout: 30000,
			reporters: ["dot"],
			server: {
				deps: {
					// @cldmv/slothlet dynamically imports our src/api/*.mjs files under a fresh
					// per-instance query-string URL. Left external, v8 tracks each instance's
					// load as a separate script and code paths hit only through some instances
					// (not all) read as uncovered even though they genuinely executed. Inlining
					// routes those imports through Vitest's own module graph instead.
					inline: [/@cldmv\/slothlet/]
				}
			},
			coverage: {
				provider: "v8",
				// src/index.cjs is exercised by `npm run test:cjs` (node --test), not Vitest.
				include: ["src/**/*.mjs"],
				exclude: ["**/*.json", "tests/**"],
				reporter: ["text", "html", "json-summary", "json"]
			}
		}
	})
);
