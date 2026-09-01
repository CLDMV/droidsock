/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /devcheck.mjs
 *	@Date: 2025-11-08 22:18:57 -08:00 (1762669137)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcPath = path.join(__dirname, "src");
// const distPath = path.join(__dirname, "dist");

// Detect if we're running in a CI environment
const isCI = !!(
	process.env.CI || // Generic CI flag
	process.env.GITHUB_ACTIONS || // GitHub Actions
	process.env.TRAVIS || // Travis CI
	process.env.CIRCLECI || // CircleCI
	process.env.GITLAB_CI || // GitLab CI
	process.env.BUILDKITE || // Buildkite
	process.env.JENKINS_URL || // Jenkins
	process.env.TF_BUILD // Azure DevOps
);

if (existsSync(srcPath) && !isCI) {
	// if (existsSync(srcPath) && !existsSync(distPath)) {
	// NODE_ENV plays no part in Node's conditional-exports resolution - only the
	// "--conditions=droidsock-dev" condition (via NODE_OPTIONS) actually routes
	// exports["./main"] to src/ instead of dist/. NODE_ENV=development alone
	// would previously pass this check while still resolving to dist/.
	const hasNodeOptions = process.env.NODE_OPTIONS?.includes("--conditions=droidsock-dev");

	if (!hasNodeOptions) {
		console.error("❌ Development environment not properly configured!");
		console.error("📁 Source folder detected but NODE_OPTIONS is not set for development.");
		console.error("");
		console.error("🔧 To fix this, run one of these commands:");
		console.error("   Windows (cmd):");
		console.error("     set NODE_OPTIONS=--conditions=droidsock-dev");
		console.error("");
		console.error("   Windows (PowerShell):");
		console.error("     $env:NODE_OPTIONS='--conditions=droidsock-dev'");
		console.error("");
		console.error("   Unix/Linux/macOS:");
		console.error("     export NODE_OPTIONS=--conditions=droidsock-dev");
		console.error("");
		console.error("💡 This ensures this module loads from src/ instead of dist/ for development.");
		console.error("   (NODE_ENV is not checked here - it has no effect on this resolution.)");
		console.error("🚀 CI environments automatically skip this check.");
		process.exit(1);
	}
}
