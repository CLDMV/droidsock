/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /build.mjs
 *	@Date: 2026-08-30 15:38:36 -07:00 (1788129516)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * @fileoverview Build script: copies src/ into dist/, optionally strips comments/whitespace
 * via esbuild (transform-only, no bundling), then re-prepends the Apache license header.
 *
 * Produces dist/droidsock.mjs + dist/api/*.mjs, mirroring src/ 1:1 - no restructuring. This is
 * what exports["./main"]'s production `import` branch resolves to, and what `npm run build:types`
 * (tsc, via .configs/tsconfig.dts.jsonc) subsequently type-checks to emit
 * types/dist/droidsock.d.mts - the file exports["./main"]'s production `types` branch points to.
 * Run build.mjs BEFORE build:types (see package.json's build:ci/precommit ordering).
 *
 * esbuild is optional: if not installed, dist/ is a plain, fully-working copy of src/.
 */

import { cpSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(projectRoot, "src");
const distDir = path.join(projectRoot, "dist");

rmSync(distDir, { recursive: true, force: true });

if (!existsSync(srcDir)) {
	console.log("⚠️  src/ not found - nothing to build.");
	process.exit(0);
}

const entries = readdirSync(srcDir);
for (const entry of entries) {
	cpSync(path.join(srcDir, entry), path.join(distDir, entry), { recursive: true, force: true });
}
console.log(`✅ Copied ${entries.length} entries from src/ to dist/`);

/**
 * Recursively collects every .mjs file under a directory.
 * @param {string} dir - Directory to walk.
 * @returns {Promise<string[]>} Absolute paths of every .mjs file found.
 */
async function collectMjs(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectMjs(full)));
		else if (entry.name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

try {
	const esbuild = (await import("esbuild")).default;
	const files = await collectMjs(distDir);
	for (const file of files) {
		const result = await esbuild.transform(readFileSync(file, "utf8"), {
			loader: "js",
			target: "esnext", // no syntax lowering - keeps tsc's declaration emission accurate
			format: "esm",
			minifyWhitespace: true,
			minifyIdentifiers: false,
			minifySyntax: false,
			legalComments: "none"
		});
		writeFileSync(file, result.code, "utf8");
	}
	console.log(`🗜️  Stripped comments/whitespace from ${files.length} files`);
} catch {
	console.warn("⚠️  esbuild not installed - skipping strip pass (dist/ is a plain copy).");
}

const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const owner = [pkg.author?.company, pkg.author?.name].filter(Boolean).join("/") || pkg.name;
const year = String(new Date().getFullYear());
const template = readFileSync(path.join(projectRoot, ".configs", "license-header.txt"), "utf8")
	.replaceAll("[{date}]", year)
	.replaceAll("[{owner}]", owner);
const banner = `/*\n${template.trimEnd()}\n*/\n\n`;
const APACHE_MARKER = "Licensed under the Apache License, Version 2.0";

/**
 * Recursively prepends the license banner to every .mjs file under a directory, replacing any
 * stale leading block comment left over when the esbuild strip pass above was skipped.
 * @param {string} dir - Directory to walk.
 * @returns {void}
 */
function prependLicense(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			prependLicense(full);
			continue;
		}
		if (!entry.name.endsWith(".mjs")) continue;
		let content = readFileSync(full, "utf8");
		if (content.includes(APACHE_MARKER)) continue;
		content = content.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
		writeFileSync(full, banner + content, "utf8");
	}
}
prependLicense(distDir);
console.log("✅ Prepended license header to dist/*.mjs");
