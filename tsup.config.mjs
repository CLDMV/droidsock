/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /tsup.config.mjs
 *	@Date: 2026-11-01T12:08:46-08:00 (1793563726)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:12:58-08:00 (1793563978)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * @fileoverview Bundler config: produces the published dist/ output from src/.
 *
 *  - dist/** mirrors src/** file by file (no bundling, minified, names kept). Slothlet composes the api by scanning
 *    the `api/` folder at runtime, so the per-file layout, including `dist/api/**`, must survive. Runtime
 *    dependencies (`@cldmv/slothlet`, `@noble/curves`, `selfsigned`) stay external imports.
 *  - dist/index.mjs is the ESM entry; dist/main.mjs is the deprecated `./main` alias and imports ./index.mjs, so it
 *    never carries a second copy of the library.
 *  - dist/index.cjs is the thin, hand-written CJS entry src/index.cjs, copied verbatim by onSuccess below and never
 *    transformed by esbuild. It `require()`s ./index.mjs, which Node loads synchronously because the module graph has
 *    no top-level await.
 *
 * Sourcemaps are generated for local debugging but excluded from the published tarball via package.json's `files`
 * negation entry.
 */
import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/**/*.mjs"],
	format: ["esm"],
	outDir: "dist",
	target: "node22",
	platform: "node",
	bundle: false,
	splitting: false,
	sourcemap: true,
	dts: false,
	minify: true,
	keepNames: true,
	removeNodeProtocol: false,
	clean: true,
	outExtension() {
		return { js: ".mjs" };
	},
	onSuccess() {
		copyFileSync("src/index.cjs", "dist/index.cjs");
	}
});
