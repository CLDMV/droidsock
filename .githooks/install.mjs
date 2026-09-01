#!/usr/bin/env node
/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /.githooks/install.mjs
 *	@Date: 2026-08-30 15:45:58 -07:00 (1788129958)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * @fileoverview Installs the committed pre-commit hook into `.git/hooks/pre-commit`.
 *
 * Wire it into package.json so it runs on `npm install`:
 *   "scripts": { "prepare": "node .githooks/install.mjs" }
 * and copy this file + `pre-commit` (from CLDMV/.github examples/git-hooks/) into
 * the repo's `.githooks/` directory.
 *
 * Why copy into `.git/hooks` rather than set `core.hooksPath`: a per-repo
 * `core.hooksPath` SHADOWS a global `core.hooksPath` dispatcher, silently
 * disabling any global commit policy (no-coauthor / no-unsigned-push) for that
 * repo. A global dispatcher instead CHAINS to `.git/hooks/<name>`, so installing
 * here composes with global policy instead of replacing it.
 *
 * Guards (each exits 0 — install is best-effort, never fails a build):
 *   - CI:                nothing commits on CI, skip.
 *   - inside node_modules: this package installed as a dependency, skip.
 *   - no `.git` dir:     tarball / shallow export / worktree pointer, skip.
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

if (process.env.CI) process.exit(0);
if (repoRoot.split(sep).includes("node_modules")) process.exit(0);

const gitDir = join(repoRoot, ".git");
if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) process.exit(0);

const hooksDir = join(gitDir, "hooks");
mkdirSync(hooksDir, { recursive: true });

const dest = join(hooksDir, "pre-commit");
copyFileSync(join(here, "pre-commit"), dest);
try {
	chmodSync(dest, 0o755);
} catch {
	/* Windows has no executable bit — ignore. */
}
console.log("✓ installed .git/hooks/pre-commit (CLDMV lint/format gate)");
