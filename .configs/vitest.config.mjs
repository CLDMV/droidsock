/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Needed so tests load from src/ (via the "./main" export's droidsock-dev
		// condition) instead of dist/, which may be stale or unbuilt locally.
		conditions: ["droidsock-dev", "module", "browser", "development", "production"]
	},
	ssr: {
		resolve: {
			conditions: ["droidsock-dev", "node", "development", "production"]
		}
	},
	test: {
		include: ["tests/**/*.test.vitest.mjs"],
		exclude: ["node_modules"],
		environment: "node",
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
			include: ["src/**"],
			exclude: ["**/*.json", "tests/**"],
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});
