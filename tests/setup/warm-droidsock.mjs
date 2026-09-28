/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/setup/warm-droidsock.mjs
 *	@Date: 2026-09-28 00:39:07 -07:00 (1790581147)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-28 00:39:07 -07:00 (1790581147)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * @fileoverview Vitest setup file: composes (and immediately shuts down) one droidsock
 * instance before each test file is collected.
 *
 * @cldmv/vitest-runner runs every test file in its own process, so the first
 * createDroidSock() in a file pays a one-time cold cost: Vitest transforms slothlet's inlined
 * runtime (see server.deps.inline in .configs/vitest.config.mjs) and loads every src/api
 * module for the first time. On an idle machine that takes about a second, but under load it
 * was measured at 7-11 seconds, against about 1-3 seconds for every later instance in the same
 * process. When that cold cost landed in a test file's first beforeEach/beforeAll, it raced
 * the 10-second hook timeout, so whichever test ran first in a file could fail for reasons
 * unrelated to what it tests (and its afterEach then failed on the undefined instance).
 *
 * Setup files run before collection and have no timeout, so paying the cold cost here leaves
 * each hook with only its own per-test work. This is the same code path every test already
 * exercises; it only moves the one-time warm-up out of the timed hooks.
 */

import createDroidSock from "../../index.mjs";

const warmInstance = await createDroidSock();
if (warmInstance.shutdown) await warmInstance.shutdown();
