/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tools/fix-headers.mjs
 *	@Date: 2026-08-30 15:45:02 -07:00 (1788129902)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * @fileoverview Scans droidsock's source files and validates or updates their standard file
 * header block (project name, filename, date, author, copyright). Delegates to the shared
 * `@cldmv/fix-headers` package.
 * @module @cldmv/droidsock/tools/fix-headers
 * @title npm run fix:headers
 *
 * @example
 * // Run via npm script
 * npm run fix:headers
 *
 * @example
 * // Preview changes without writing
 * npm run fix:headers -- --dry-run
 */

import { fixHeaders } from "@cldmv/fix-headers";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/**
 * Print CLI help.
 * @returns {void}
 */
function showHelp() {
	console.log(`
Droidsock File Header Fixer
Delegates execution to @cldmv/fix-headers.

USAGE:
  node tools/fix-headers.mjs [OPTIONS]

OPTIONS:
  --dry-run     Compute changes without writing files (also enables --diff)
  --verbose     List each file that was changed
  --diff        List each file that was changed (currently identical to --verbose)
  --help, -h    Show this help message
`);
}

/**
 * Parse CLI arguments into runner options.
 * @param {string[]} args - Raw process arguments excluding node and script path.
 * @returns {{ help: boolean, dryRun: boolean, verbose: boolean, diff: boolean }} Parsed options.
 */
function parseArguments(args) {
	let help = false;
	let dryRun = false;
	let verbose = false;
	let diff = false;

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--dry-run") {
			dryRun = true;
			diff = true;
		} else if (arg === "--verbose") {
			verbose = true;
		} else if (arg === "--diff") {
			diff = true;
		}
	}

	return { help, dryRun, verbose, diff };
}

/**
 * Print the run result summary to stdout.
 * @param {object} result - Result from `@cldmv/fix-headers`.
 * @param {{ verbose: boolean, diff: boolean, dryRun: boolean }} opts - Display options.
 * @returns {void}
 */
function printSummary(result, opts) {
	if (opts.dryRun) {
		console.log("🔍 DRY RUN MODE - No files will be modified\n");
	}

	if (opts.verbose || opts.diff) {
		const changed = result.changes.filter((c) => c.changed);
		if (changed.length > 0) {
			console.log("Files with changes:\n");
			for (const entry of changed) {
				console.log(`  ✓ ${entry.file}`);
			}
			console.log();
		}
	}

	console.log("📊 Statistics:");
	console.log(`  Files scanned:  ${result.filesScanned}`);
	console.log(`  Files updated:  ${result.filesUpdated}`);
	console.log();

	if (opts.dryRun && result.filesUpdated > 0) {
		console.log("✅ Dry run complete. Run without --dry-run to apply fixes.");
	} else if (result.filesUpdated > 0) {
		console.log(`✅ Fixed ${result.filesUpdated} file(s).`);
	} else {
		console.log("✅ All files have proper headers!");
	}

	console.log();
}

/**
 * Execute the header fixer.
 * @returns {Promise<void>} Resolves when all header processing is complete.
 */
async function main() {
	const parsed = parseArguments(process.argv.slice(2));

	if (parsed.help) {
		showHelp();
		process.exit(0);
	}

	console.log("\n=== Droidsock File Header Fixer ===\n");

	const result = await fixHeaders({
		cwd: projectRoot,
		dryRun: parsed.dryRun,
		projectName: "@cldmv/droidsock",
		company: "CLDMV",
		companyName: "Catalyzed Motivation Inc.",
		copyrightStartYear: 2013,
		includeExtensions: [".mjs", ".cjs", ".js"],
		includeFolders: ["."],
		excludeFolders: ["node_modules", "dist", "build", "coverage", "tmp", "trash", "types", "references"]
	});

	printSummary(result, parsed);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
