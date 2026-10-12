import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildOptions, externalModules, findDisallowedRequires, findRequires, isAllowedRequire } from "../../esbuild.config.mjs";

let scratch = "";

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "askmate-bundle-"));
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function bundle(source: string, production = true): Promise<string> {
	const entryPoint = join(scratch, "entry.ts");
	const outfile = join(scratch, "out.js");
	await writeFile(entryPoint, source);
	await build({ ...createBuildOptions({ production, entryPoint, outfile }), logLevel: "silent" });
	return readFile(outfile, "utf8");
}

describe("MCP-01 node: built-ins in the bundle", () => {
	test("a file importing node:child_process and node:readline builds and keeps both as requires", async () => {
		const code = await bundle(
			'import { spawn } from "node:child_process";\nimport { createInterface } from "node:readline";\nexport const probe = { spawn, createInterface };\n'
		);
		expect(findRequires(code).sort()).toEqual(["node:child_process", "node:readline"]);
		expect(findDisallowedRequires(code)).toEqual([]);
	});

	test("bare built-in names keep working, and so do the host modules", async () => {
		const code = await bundle(
			'import { spawn } from "child_process";\nimport { Notice } from "obsidian";\nexport const probe = { spawn, Notice };\n',
			false
		);
		expect(findRequires(code).sort()).toEqual(["child_process", "obsidian"]);
		expect(findDisallowedRequires(code)).toEqual([]);
	});

	test("the external list names node:* explicitly", () => {
		expect(externalModules).toContain("node:*");
		expect(externalModules).toContain("obsidian");
	});
});

describe("post-build require check", () => {
	test("allows only the host, CodeMirror, Lezer and Node built-ins", () => {
		const allowed = ["obsidian", "electron", "@codemirror/view", "@lezer/common", "fs", "fs/promises", "child_process", "node:child_process", "node:readline", "node:sqlite"];
		expect(allowed.filter((name) => !isAllowedRequire(name))).toEqual([]);
		const refused = ["left-pad", "mermaid", "@scope/pkg", "node:not-a-module", "./local", "obsidian-extra"];
		expect(refused.filter(isAllowedRequire)).toEqual([]);
	});

	test("finds literal requires in plain and minified output and ignores computed ones", () => {
		const code = 'var a=require("obsidian"),b=require(\'node:child_process\');var c = __require("left-pad");var d=require(name);';
		expect(findRequires(code)).toEqual(["obsidian", "node:child_process", "left-pad"]);
		expect(findDisallowedRequires(code)).toEqual(["left-pad"]);
	});
});
