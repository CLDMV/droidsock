/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /.configs/vitest.config.mjs
 *	@Date: 2025-11-16 22:26:58 -08:00 (1763360818)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 12:37:14 -08:00 (1763757434)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.vest.mjs"],
		exclude: ["node_modules", "tests/old/**"],
		environment: "node",
		globals: true,
		testTimeout: 10000,
		hookTimeout: 10000,
		globalSetup: ["./tests/global-setup.mjs"],
		pool: "threads",
		poolOptions: {
			threads: {
				singleThread: true
			}
		},
		fileParallelism: false,
		maxConcurrency: 1,
		sequence: {
			shuffle: false,
			concurrent: false
		}
	}
});
