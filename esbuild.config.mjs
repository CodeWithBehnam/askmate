import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Modules the Obsidian host provides at runtime. They are never bundled. */
const HOST_MODULES = [
	"obsidian",
	"electron",
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr"
];

/**
 * `builtinModules` lists bare names ("child_process") and only a few prefixed ones, so a `node:child_process` import fails to
 * resolve unless `node:*` is external too.
 */
export const externalModules = [...HOST_MODULES, "node:*", ...builtinModules];

const NODE_BUILTINS = new Set(builtinModules);

function isNodeBuiltin(specifier) {
	return NODE_BUILTINS.has(specifier) || (specifier.startsWith("node:") && NODE_BUILTINS.has(specifier.slice("node:".length)));
}

/** True for the only modules a release bundle may require at runtime: the host, CodeMirror, Lezer and Node built-ins. */
export function isAllowedRequire(specifier) {
	return (
		specifier === "obsidian" ||
		specifier === "electron" ||
		specifier.startsWith("@codemirror/") ||
		specifier.startsWith("@lezer/") ||
		isNodeBuiltin(specifier)
	);
}

/** Every module name the bundle loads with a literal `require("...")`, in order of first appearance. */
export function findRequires(code) {
	const found = new Set();
	for (const match of code.matchAll(/\b(?:__)?require\(\s*(["'])((?:(?!\1)[^\\\n])+)\1\s*\)/g)) {
		found.add(match[2]);
	}
	return [...found];
}

/** Requires a release bundle must not contain. A non-empty result means something was left unbundled by mistake. */
export function findDisallowedRequires(code) {
	return findRequires(code).filter((specifier) => !isAllowedRequire(specifier));
}

/**
 * @param {{ production: boolean, entryPoint?: string, outfile?: string }} input
 * @returns {import("esbuild").BuildOptions}
 */
export function createBuildOptions({ production, entryPoint = "main.ts", outfile = "main.js" }) {
	return {
		banner: {
			js: "/* AskMate Obsidian plugin */"
		},
		entryPoints: [entryPoint],
		bundle: true,
		external: externalModules,
		format: "cjs",
		target: "es2018",
		logLevel: "info",
		sourcemap: production ? false : "inline",
		treeShaking: true,
		outfile,
		minify: production
	};
}

async function main() {
	const production = process.argv[2] === "production";
	const options = createBuildOptions({ production });
	const context = await esbuild.context(options);

	if (!production) {
		await context.watch();
		console.log("Watching for changes...");
		return;
	}

	await context.rebuild();
	await context.dispose();

	const disallowed = findDisallowedRequires(readFileSync(options.outfile, "utf8"));
	if (disallowed.length > 0) {
		throw new Error(`${options.outfile} requires modules that are not part of a release: ${disallowed.join(", ")}`);
	}
}

// Bun sets import.meta.main; the argv comparison keeps the file runnable under Node too. Importing it (tests) builds nothing.
const isEntryPoint =
	typeof import.meta.main === "boolean"
		? import.meta.main
		: process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
	await main();
}
