#!/usr/bin/env bun

/*
 * Repository guards that the bun unit tests cannot express.
 *
 * Behaviour lives in tests/*.test.ts. This script only checks:
 * - release metadata that must agree across files;
 * - APIs the plugin must never use;
 * - safety wiring inside Obsidian glue code (plugin and sidebar view) that cannot be loaded in bun;
 * - CSS selectors that no source file uses any more;
 * - GitHub workflow and issue-form YAML that would be rejected (GitHub silently drops a broken issue form);
 * - documentation that Obsidian's developer policies or the project's Apply contract require.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
	if (!condition) {
		failures.push(message);
	}
}

function readSourceFiles(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const entry of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			for (const [childPath, contents] of readSourceFiles(path)) {
				files.set(childPath, contents);
			}
		} else if (path.endsWith(".ts")) {
			files.set(path, readFileSync(path, "utf8"));
		}
	}
	return files;
}

function getYamlParser(): (text: string) => unknown {
	// Bun ships a YAML parser; reading it through Reflect keeps this script free of a bun-types dependency.
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const yaml: unknown = bun && typeof bun === "object" ? Reflect.get(bun, "YAML") : undefined;
	const parse: unknown = yaml && typeof yaml === "object" ? Reflect.get(yaml, "parse") : undefined;
	if (typeof parse !== "function") {
		throw new Error("Bun.YAML.parse is not available. Run the repository guards with Bun 1.2.21 or later.");
	}
	return (text: string): unknown => parse.call(yaml, text);
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const sources = readSourceFiles("src");
const allSource = [readFileSync("main.ts", "utf8"), ...sources.values()].join("\n");
const plugin = sources.get(join("src", "plugin", "AskMatePlugin.ts")) ?? "";
const view = sources.get(join("src", "ui", "sidebar", "AskMateView.ts")) ?? "";
const builders = sources.get(join("src", "requests", "requestBuilders.ts")) ?? "";
const styles = readFileSync("styles.css", "utf8");
const readme = readFileSync("README.md", "utf8");

// Release metadata: Obsidian reads manifest.json and versions.json; the release workflow checks the tag against both.
const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
check(manifest.version === packageJson.version, `manifest.json version ${String(manifest.version)} differs from package.json ${String(packageJson.version)}`);
check(typeof manifest.version === "string" && manifest.version in versions, `versions.json has no entry for ${String(manifest.version)}`);
check(typeof manifest.version === "string" && versions[manifest.version] === manifest.minAppVersion, "versions.json minAppVersion differs from manifest.json minAppVersion");
check(!("fundingUrl" in manifest) || Boolean(manifest.fundingUrl), "manifest.json fundingUrl must be removed rather than left empty");

// Forbidden APIs: network only through requestUrl, no HTML injection sinks, no vault-wide enumeration, no clipboard reads.
const forbidden: Array<[RegExp, string]> = [
	[/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/, "HTML injection sink"],
	[/\beval\s*\(|new Function\s*\(/, "dynamic code evaluation"],
	[/(?<![.\w])fetch\s*\(/, "fetch (use Obsidian requestUrl)"],
	[/console\.log\s*\(/, "console.log"],
	[/navigator\.clipboard/, "direct clipboard access"],
	[/getMarkdownFiles\s*\(/, "vault-wide Markdown enumeration"]
];
for (const [path, contents] of sources) {
	for (const [pattern, label] of forbidden) {
		check(!pattern.test(contents), `${label} used in ${path}`);
	}
}

// Safety wiring in glue code that bun cannot load (it imports the Obsidian runtime).
const wiring: Array<[string, string, string]> = [
	[view, "sanitizeModelMarkdown(markdown)", "sidebar renders model replies through the sanitiser"],
	[builders, "escapePromptDelimiters", "prompt builders escape delimiter tags in untrusted content"],
	[plugin, "confirmReplaceScopeRisks", "replace-scope Apply asks before using truncated context"],
	[plugin, "assertNoteUnchangedDuringPreview", "Apply refuses to write over edits made during the preview"],
	[plugin, "outputIncompleteReason", "Apply refuses incomplete replies for replace scopes"],
	[plugin, "removeCommand", "custom workflow commands are removed when workflows change"],
	[plugin, "vault.on(\"rename\"", "note history and context follow renamed notes"],
	[plugin, "vault.on(\"delete\"", "note history and context forget deleted notes"],
	[plugin, "syncObjectInPlace", "saveSettings keeps settings object identity"]
];
for (const [contents, needle, label] of wiring) {
	check(contents.includes(needle), `missing safety wiring: ${label} (${needle})`);
}

// CSS selectors must still be used somewhere, either literally or through a dynamically built class prefix.
const dynamicPrefixes = new Set<string>();
for (const match of allSource.matchAll(/askmate-[a-z0-9-]*-(?=\$\{|"\s*\+)/g)) {
	dynamicPrefixes.add(match[0]);
}
const cssClasses = new Set(Array.from(styles.matchAll(/\.(askmate-[a-z0-9-]+)/g), (match) => match[1]));
for (const cssClass of cssClasses) {
	const used = allSource.includes(cssClass) || Array.from(dynamicPrefixes).some((prefix) => cssClass.startsWith(prefix));
	check(used, `styles.css selector .${cssClass} is not used in src`);
}

// YAML that GitHub reads.
const parseYaml = getYamlParser();
for (const dir of [join(".github", "workflows"), join(".github", "ISSUE_TEMPLATE")]) {
	for (const entry of readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
		const path = join(dir, entry);
		try {
			parseYaml(readFileSync(path, "utf8"));
		} catch (error) {
			failures.push(`${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

// Documentation required by Obsidian's developer policies and by the Apply contract.
const readmeRequirements: Array<[RegExp, string]> = [
	[/network/i, "network use disclosure"],
	[/API key/i, "API key requirement"],
	[/paid|billing|charges/i, "paid account disclosure"],
	[/data\.json/, "local storage of history, review queue and usage stats"],
	[/Apply approval mode/, "Apply approval modes"],
	[/appends generated output to the captured note/, "default no-selection Apply appends"],
	[/Azure AI Foundry/, "Azure AI Foundry provider"],
	[/gpt-image-2/, "OpenAI image model"]
];
for (const [pattern, label] of readmeRequirements) {
	check(pattern.test(readme), `README.md is missing: ${label}`);
}
check(!/^- \[ \]/m.test(readme), "README.md has unchecked roadmap boxes");

if (failures.length > 0) {
	throw new Error(`AskMate repository guards failed:\n- ${failures.join("\n- ")}`);
}

console.log("AskMate repository guards passed.");
