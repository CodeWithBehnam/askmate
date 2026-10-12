#!/usr/bin/env bun

/*
 * Repository guards that the bun unit tests cannot express.
 *
 * Behaviour lives in tests/*.test.ts. This script only checks:
 * - release metadata that must agree across files;
 * - APIs the plugin must never use, and the Obsidian review rules from rules.md that eslint does not cover;
 * - safety wiring inside Obsidian glue code (plugin and sidebar view) that cannot be loaded in bun;
 * - CSS selectors that no source file uses any more, and CSS features the review scan flags;
 * - GitHub workflow and issue-form YAML that would be rejected (GitHub silently drops a broken issue form);
 * - documentation that Obsidian's developer policies or the project's Apply contract require, and that the README links resolve;
 * - documentation claims that code decides and that have drifted before: the diagram example phrases, plain-http MCP addresses and what Insert does to a selection.
 *
 * `bun run scripts/roadmap-smoke-tests.ts --bundle` instead inspects the built main.js (run it after `bun run build`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { validateServerUrl } from "../src/mcp/httpTransport";
import { detectDiagramIntent, shouldGenerateImage } from "../src/shared/imageIntent";

/** Release metadata and README asset rules apply from the release that introduced them. 1.11.1 already shipped without them. */
const RELEASE_GATE_VERSION = "1.12.0";
/** The release bundle has no runtime dependencies. A bundled Mermaid or MCP SDK would be several times this size. */
const MAX_BUNDLE_BYTES = 800 * 1024; // TODO(lead): re-measure after the wave 2 merge and set this about 15% above main.js.
/** The README is the first thing people read. It stays short; reference material belongs in docs/. */
const MAX_README_WORDS = 2000;
/** Files that call window.fetch on purpose: the streaming transport, which requestUrl cannot provide. */
const WINDOW_FETCH_ALLOWED = new Set([join("src", "plugin", "AskMatePlugin.ts"), join("src", "providers", "sseTransport.ts")]);
/** The only module allowed to import child_process, behind Platform.isDesktopApp. */
const CHILD_PROCESS_ALLOWED = new Set([join("src", "mcp", "launch.ts")]);

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

function listMarkdownFiles(dir: string, skip: ReadonlySet<string>): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir).sort((a, b) => a.localeCompare(b)).flatMap((entry) => {
		const path = posix.join(dir.split("\\").join("/"), entry);
		if (skip.has(entry)) {
			return [];
		}
		if (statSync(path).isDirectory()) {
			return listMarkdownFiles(path, skip);
		}
		return path.endsWith(".md") ? [path] : [];
	});
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes line comments and block comments that start a line, so rules are checked against code and not against prose. */
export function stripComments(source: string): string {
	return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) {
			return difference < 0 ? -1 : 1;
		}
	}
	return 0;
}

/** Line numbers of opening code fences that name no language. Closing fences are not reported. */
export function findUntaggedFences(markdown: string): number[] {
	const found: number[] = [];
	let open: { char: string; length: number } | null = null;
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
		if (!match) {
			continue;
		}
		const fence = match[1];
		const info = match[2].trim();
		if (open === null) {
			open = { char: fence[0], length: fence.length };
			if (info === "") {
				found.push(index + 1);
			}
		} else if (fence[0] === open.char && fence.length >= open.length && info === "") {
			open = null;
		}
	}
	return found;
}

/** Relative file targets of Markdown links and images and of src, srcset and href attributes. Web, mail and anchor links are skipped. */
export function findRelativeTargets(markdown: string): string[] {
	const withoutCode = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1[ \t]*$/gm, "").replace(/`[^`\n]*`/g, "");
	const withoutComments = withoutCode.replace(/<!--[\s\S]*?-->/g, "");
	const targets = [
		...Array.from(withoutComments.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), (match) => match[1]),
		...Array.from(withoutComments.matchAll(/\b(?:src|srcset|href)\s*=\s*"([^"\s]+)"/g), (match) => match[1])
	];
	return Array.from(new Set(targets
		.filter((target) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target))
		.map((target) => target.split("#")[0].split("?")[0])
		.filter((target) => target !== "")));
}

/** Sentences of a Markdown document with HTML comments removed. A backticked span is never split, so `data.json` or `127.0.0.1` stay whole. */
export function splitSentences(markdown: string): string[] {
	const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, " ");
	return Array.from(withoutComments.match(/(?:[^.!?`\n]|`[^`\n]*`)+(?:[.!?]|$)/gm) ?? [], (sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

/** The backticked phrases inside every sentence that matches the given pattern. */
export function findQuotedPhrases(markdown: string, sentencePattern: RegExp): string[] {
	return splitSentences(markdown)
		.filter((sentence) => sentencePattern.test(sentence))
		.flatMap((sentence) => Array.from(sentence.matchAll(/`([^`\n]+)`/g), (match) => match[1]));
}

/** Sentences that say Insert replaces the selection. Insert collapses the selection and writes after it, so only a negated sentence is acceptable. */
export function findInsertSelectionClaims(markdown: string): string[] {
	return splitSentences(markdown).filter(
		(sentence) => /\binsert/i.test(sentence) && /\breplac(?:e|es|ed|ing)\b[^.]*\bselect/i.test(sentence) && !/\b(?:not|never|no longer|without|instead of)\b/i.test(sentence)
	);
}

/** Sentences that say a remote MCP server can use plain http on a wider network. The MCP gate allows plain http for loopback only. */
export function findMcpPlainHttpOverclaims(markdown: string): string[] {
	return splitSentences(markdown).filter(
		(sentence) =>
			/\bplain\s+`?http\b/i.test(sentence) &&
			/\bMCP\b|\bremote server\b|\bStreamable HTTP\b/i.test(sentence) &&
			/\b(?:own|local|private|home|internal)\s+network\b|\bLAN\b|\b192\.168\./i.test(sentence)
	);
}

function acceptsMcpUrl(url: string): boolean {
	try {
		validateServerUrl(url);
		return true;
	} catch {
		// validateServerUrl throws a McpClientError for every address it refuses; the refusal is the answer here.
		return false;
	}
}

/** Every Obsidian review rule that rules.md lists and a regular expression can express, applied to comment-free source. */
const reviewRules: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /(?<![\w$.])document\./, label: "bare document (use activeDocument so popout windows work)" },
	{ pattern: /\.obsidian\b/, label: "hard-coded .obsidian folder (use app.vault.configDir)" },
	{ pattern: /(?<![\w$.])(?:prompt|confirm|alert)\s*\(\s*["'`]|\bwindow\.(?:prompt|confirm|alert)\s*\(/, label: "native prompt, confirm or alert (use an Obsidian Modal)" },
	{ pattern: /\bsetInterval\s*\(/, label: "setInterval (a background timer must not sit beside network calls)" }
];

function descriptionProblems(description: unknown): string[] {
	if (typeof description !== "string") {
		return ["is missing"];
	}
	return [
		...(description.length < 10 || description.length > 250 ? ["must be 10 to 250 characters"] : []),
		...(/^[A-Z]/.test(description) ? [] : ["must start with a capital letter"]),
		...(description.endsWith(".") ? [] : ["must end with a full stop"]),
		...(/^[A-Za-z0-9\s.,!?'"-]+$/.test(description) ? [] : ["may only use letters, digits, spaces and . , ! ? ' \" -"]),
		...(/obsidian|plugin/i.test(description) ? ["must not say Obsidian or plugin"] : [])
	];
}

type WorkflowStep = { uses?: unknown; run?: unknown; with?: unknown };

function workflowSteps(workflow: unknown): WorkflowStep[] {
	if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
		return [];
	}
	return Object.values(workflow.jobs).flatMap((job) => (isRecord(job) && Array.isArray(job.steps) ? job.steps.filter(isRecord) : []));
}

function workflowRunners(workflow: unknown): string[] {
	if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
		return [];
	}
	return Object.values(workflow.jobs).flatMap((job) => (isRecord(job) && typeof job["runs-on"] === "string" ? [job["runs-on"]] : []));
}

/** Tracked or untracked-but-not-ignored files, so a README asset that .gitignore hides is caught even though it exists on disk. */
function listCommittableFiles(): ReadonlySet<string> | null {
	try {
		const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"]
		});
		return new Set(output.split("\0").filter((path) => path !== ""));
	} catch {
		// Not a git checkout (for example a source archive). The existence check still runs; the ignored-file check is skipped.
		return null;
	}
}

function runRepoGuards(): void {
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
	const version = String(manifest.version);
	const releaseGatesActive = compareVersions(version, RELEASE_GATE_VERSION) >= 0;
	check(manifest.version === packageJson.version, `manifest.json version ${version} differs from package.json ${String(packageJson.version)}`);
	check(typeof manifest.version === "string" && manifest.version in versions, `versions.json has no entry for ${version}`);
	check(typeof manifest.version === "string" && versions[manifest.version] === manifest.minAppVersion, "versions.json minAppVersion differs from manifest.json minAppVersion");
	check(!("fundingUrl" in manifest) || Boolean(manifest.fundingUrl), "manifest.json fundingUrl must be removed rather than left empty");
	check(manifest.description === packageJson.description, "package.json description differs from manifest.json description");
	if (releaseGatesActive) {
		// The community review runs the validate-manifest rule on every release. 1.11.1 shipped a description that fails it.
		for (const problem of descriptionProblems(manifest.description)) {
			check(false, `manifest.json description ${problem}`);
		}
	}

	// Forbidden APIs: network only through requestUrl, no HTML injection sinks, no vault-wide enumeration, no clipboard reads.
	const forbidden: Array<[RegExp, string]> = [
		[/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/, "HTML injection sink"],
		[/\beval\s*\(|new Function\s*\(/, "dynamic code evaluation"],
		[/(?<![.\w])fetch\s*\(/, "fetch (use Obsidian requestUrl)"],
		[/console\.log\s*\(/, "console.log"],
		[/navigator\.clipboard\.read(?:Text)?\b/, "clipboard read"],
		[/getMarkdownFiles\s*\(/, "vault-wide Markdown enumeration"]
	];
	for (const [path, contents] of sources) {
		for (const [pattern, label] of forbidden) {
			check(!pattern.test(contents), `${label} used in ${path}`);
		}
	}

	// Review rules from rules.md that eslint-plugin-obsidianmd does not cover, checked on source with the comments removed.
	const codeOnly = new Map<string, string>([...sources, ["main.ts", readFileSync("main.ts", "utf8")]].map(([path, contents]) => [path, stripComments(contents)]));
	for (const [path, contents] of codeOnly) {
		for (const { pattern, label } of reviewRules) {
			check(!pattern.test(contents), `${label} used in ${path}`);
		}
		check(!/\bwindow\.fetch\s*\(/.test(contents) || WINDOW_FETCH_ALLOWED.has(path), `window.fetch used in ${path}; only the streaming transport may call it, everything else uses requestUrl`);
		check(!/(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?child_process["']/.test(contents) || CHILD_PROCESS_ALLOWED.has(path), `child_process imported in ${path}; only src/mcp/launch.ts may import it`);
		for (const match of contents.matchAll(/addCommand\(\s*\{\s*id:\s*(["'`])([^"'`$]*)\1\s*,\s*name:\s*(["'`])([^"'`$]*)\3/g)) {
			check(!/askmate/i.test(match[2]), `command id "${match[2]}" in ${path} repeats the plugin id (Obsidian prefixes it already)`);
			check(!/askmate/i.test(match[4]), `command name "${match[4]}" in ${path} repeats the plugin name (Obsidian prefixes it already)`);
		}
		for (const match of contents.matchAll(/\bcommandId:\s*(["'`])([^"'`$]*)\1/g)) {
			check(!/askmate/i.test(match[2]), `commandId "${match[2]}" in ${path} repeats the plugin id`);
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

	// CSS features the community review scan flags (rules.md). State classes set from TypeScript replace :has.
	const cssWithoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const [pattern, label] of [[/:has\(/, ":has() selector"], [/clip-path\s*:/, "clip-path"], [/column-gap\s*:/, "column-gap (use gap)"]] as Array<[RegExp, string]>) {
		check(!pattern.test(cssWithoutComments), `styles.css uses ${label}`);
	}

	// YAML that GitHub reads.
	const parseYaml = getYamlParser();
	const parsedYaml = new Map<string, unknown>();
	for (const dir of [join(".github", "workflows"), join(".github", "ISSUE_TEMPLATE")]) {
		for (const entry of readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
			const path = join(dir, entry);
			try {
				parsedYaml.set(path, parseYaml(readFileSync(path, "utf8")));
			} catch (error) {
				failures.push(`${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Workflows: reproducible runner, pinned actions, the same checks in CI and release, and a release that cannot ship a partial asset set.
	for (const name of ["ci.yml", "release.yml"]) {
		const path = join(".github", "workflows", name);
		const workflow = parsedYaml.get(path);
		const steps = workflowSteps(workflow);
		const commands = steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
		check(steps.length > 0, `${path} has no steps`);
		check(workflowRunners(workflow).every((runner) => runner !== "ubuntu-latest"), `${path} uses ubuntu-latest; pin a runner image`);
		for (const step of steps) {
			if (typeof step.uses === "string") {
				check(/@[0-9a-f]{40}$/.test(step.uses.split(/\s/)[0]), `${path} action ${step.uses} is not pinned to a full commit SHA`);
			}
		}
		for (const command of ["bun run lint", "bun run typecheck:tests", "bun run test", "bun run build", "--bundle"]) {
			check(commands.some((run) => run.includes(command)), `${path} does not run ${command}`);
		}
	}
	const releaseSteps = workflowSteps(parsedYaml.get(join(".github", "workflows", "release.yml")));
	const publishStep = releaseSteps.find((step) => typeof step.uses === "string" && step.uses.startsWith("softprops/action-gh-release@"));
	const publishInputs = publishStep && isRecord(publishStep.with) ? publishStep.with : {};
	check(publishInputs.fail_on_unmatched_files === true, "release.yml must set fail_on_unmatched_files: true on the publish step");
	check(typeof publishInputs.body_path === "string" && publishInputs.body_path.includes("release-notes"), "release.yml must use the CHANGELOG.md section as the release body (body_path)");
	check(releaseSteps.some((step) => typeof step.run === "string" && step.run.includes("CHANGELOG.md")), "release.yml does not read CHANGELOG.md");
	check(releaseSteps.some((step) => typeof step.run === "string" && step.run.includes("main.js") && step.run.includes("-s")), "release.yml does not assert that every release asset is non-empty before the attestation");
	check(existsSync(join(".github", "dependabot.yml")) && /github-actions/.test(readFileSync(join(".github", "dependabot.yml"), "utf8")), ".github/dependabot.yml must keep the pinned actions current");

	// Documentation: the README, CHANGELOG, CONTRIBUTING, SECURITY and docs/ (investigation notes are working papers and are left alone).
	const docFiles = ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", ...listMarkdownFiles("docs", new Set(["investigations", "plans", "reviews"]))];
	const docText = new Map(docFiles.map((path) => [path, readFileSync(path, "utf8")]));
	const docCorpus = Array.from(docText.values()).join("\n");

	// Required by Obsidian's developer policies and by the Apply contract. README plus docs/, because reference material lives in docs/.
	const documentationRequirements: Array<[RegExp, string]> = [
		[/network/i, "network use disclosure"],
		[/API key/i, "API key requirement"],
		[/paid|billing|charges/i, "paid account disclosure"],
		[/data\.json/, "local storage of history, review queue and usage stats"],
		[/Apply approval mode/, "Apply approval modes"],
		[/appends generated output to the captured note/, "default no-selection Apply appends"],
		[/Azure AI Foundry/, "Azure AI Foundry provider"],
		[/gpt-image-2/, "OpenAI image model"],
		[/SecretStorage/, "API keys and MCP secrets are stored in SecretStorage"],
		[/telemetry/i, "telemetry statement"],
		[/child process/i, "child process disclosure for local MCP servers"],
		[/200 turns/, "global cap on stored note history"],
		[/100\.64\.0\.0\/10/, "complete list of plain-http local addresses"],
		[/Mermaid/, "Mermaid Diagram Studio"],
		[/Model Context Protocol|MCP/, "MCP tools"]
	];
	for (const [pattern, label] of documentationRequirements) {
		check(pattern.test(docCorpus), `README.md and docs/ are missing: ${label}`);
	}
	// The README alone must carry the disclosures Obsidian asks every plugin page to make.
	for (const [pattern, label] of [
		[/network/i, "network use"],
		[/API key/i, "the API key requirement"],
		[/paid|billing|charges/i, "the provider cost"],
		[/child process/i, "child processes for local MCP servers"],
		[/SecretStorage/, "where keys are stored"],
		[/https:\/\/obsidian\.md\/plugins\?id=askmate/, "the install link"],
		[/Apply approval mode/, "Apply approval modes"],
		[/appends generated output to the captured note/, "the default no-selection Apply behaviour"]
	] as Array<[RegExp, string]>) {
		check(pattern.test(readme), `README.md does not mention ${label}`);
	}
	check(!/^- \[ \]/m.test(readme), "README.md has unchecked roadmap boxes");
	check(!/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(readme), "README.md uses a GitHub alert, which the Obsidian directory page does not render");
	const readmeWords = readme.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
	check(readmeWords <= MAX_README_WORDS, `README.md has ${readmeWords} words; keep it under ${MAX_README_WORDS} and move reference material to docs/`);

	for (const [path, text] of docText) {
		for (const line of findUntaggedFences(text)) {
			check(false, `${path}:${line} has a code fence without a language tag`);
		}
		check(!/\u2014/.test(text), `${path} contains an em dash`);
		check(!/\/Users\/[A-Za-z]|[A-Za-z]:\\Users\\/.test(text), `${path} contains a local user path`);
		for (const sentence of findInsertSelectionClaims(text)) {
			check(false, `${path} says Insert replaces the selection ("${sentence}"); Insert at cursor writes after the selection and Apply is the way to replace it`);
		}
		for (const sentence of findMcpPlainHttpOverclaims(text)) {
			check(false, `${path} says a remote MCP server can use plain http beyond localhost ("${sentence}"); the MCP address gate allows loopback only`);
		}
	}

	// Documentation claims that code decides. The detectors are checked against the wording they replaced, so a loosened pattern cannot pass silently.
	check(findInsertSelectionClaims("Insert goes into the note you last edited, replacing the selection if there is one, even when the sidebar has focus.").length === 1, "findInsertSelectionClaims no longer flags the old Insert wording");
	check(findInsertSelectionClaims("It never replaces a selection: if text is selected, the reply goes after it.").length === 0, "findInsertSelectionClaims flags a sentence that denies the replacement");
	check(findMcpPlainHttpOverclaims("A remote server is contacted over HTTPS (or plain HTTP on your own network) with the bearer token or headers you set.").length === 1, "findMcpPlainHttpOverclaims no longer flags the old MCP wording");
	check(findMcpPlainHttpOverclaims("Remote provider addresses must use https. Plain http is accepted only for addresses that stay on your machine or network.").length === 0, "findMcpPlainHttpOverclaims flags the provider rule, which is wider on purpose");
	check(findQuotedPhrases("- Say it: `Draw this as a diagram`, `127.0.0.1`. Then `skip this`.", /Say it:/).join("|") === "Draw this as a diagram|127.0.0.1", "findQuotedPhrases does not return exactly the phrases of the matching sentence");

	// The MCP address gate is loopback only. The docs say so; if the code ever widens it, the docs must change with it.
	const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
	check(loopbackHosts.every((host) => acceptsMcpUrl(`http://${host}:8080/mcp`)), "validateServerUrl no longer accepts plain http for localhost; update docs/mcp.md and docs/privacy.md");
	check(["192.168.1.10", "10.0.0.5", "mcp.local"].every((host) => !acceptsMcpUrl(`http://${host}/mcp`)), "validateServerUrl now accepts plain http beyond localhost; docs/mcp.md and docs/privacy.md say localhost only, so update them");
	check(acceptsMcpUrl("https://example.com/mcp"), "validateServerUrl rejects an https address");
	for (const path of [posix.join("docs", "mcp.md"), posix.join("docs", "privacy.md")]) {
		const states = splitSentences(docText.get(path) ?? "").some((sentence) => /\bplain\s+`?http\b/i.test(sentence) && /\blocalhost\b/.test(sentence));
		check(states, `${path} must say that plain http is accepted for localhost only on MCP server addresses`);
	}

	// The example phrases in the diagram guide must start the path the guide says they start.
	const diagramsDoc = docText.get(posix.join("docs", "diagrams.md")) ?? "";
	const diagramPhrases = findQuotedPhrases(diagramsDoc, /Say it:|Wording that asks for a diagram/);
	const picturePhrases = findQuotedPhrases(diagramsDoc, /A request for a picture/);
	check(diagramPhrases.length >= 4, `docs/diagrams.md lists ${diagramPhrases.length} diagram example phrases; the guard expects the "Say it:" line and the "Wording that asks for a diagram" sentence`);
	check(picturePhrases.length >= 2, "docs/diagrams.md no longer lists picture example phrases after \"A request for a picture\"");
	for (const phrase of diagramPhrases) {
		check(detectDiagramIntent(phrase), `docs/diagrams.md says "${phrase}" starts the diagram path, but detectDiagramIntent rejects it`);
	}
	for (const phrase of picturePhrases) {
		check(shouldGenerateImage(phrase, true) && !detectDiagramIntent(phrase), `docs/diagrams.md says "${phrase}" goes to image generation, but shouldGenerateImage or detectDiagramIntent disagrees`);
	}

	// CHANGELOG: the release workflow publishes this section as the release body.
	const changelog = docText.get("CHANGELOG.md") ?? "";
	const changelogHeading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m").exec(changelog);
	check(changelogHeading !== null, `CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry for the current version`);
	if (changelogHeading) {
		const section = changelog.slice(changelogHeading.index + changelogHeading[0].length).split(/^## /m)[0];
		check(section.trim().length > 40, `CHANGELOG.md entry for ${version} is empty`);
		check(findRelativeTargets(section).length === 0, `CHANGELOG.md entry for ${version} has relative links, which do not resolve in a GitHub release body; use absolute URLs`);
	}

	// Every relative link and image resolves to a committable file. Assets are only required once the release gate is active,
	// because the screenshots are captured from a real Obsidian vault shortly before the release is cut.
	const committable = listCommittableFiles();
	for (const [path, text] of docText) {
		for (const target of findRelativeTargets(text)) {
			const resolved = posix.normalize(posix.join(posix.dirname(path), decodeURI(target)));
			if (resolved.startsWith("assets/") && !releaseGatesActive) {
				continue;
			}
			const isDirectory = existsSync(resolved) && statSync(resolved).isDirectory();
			check(existsSync(resolved), `${path} links to ${target}, which does not exist`);
			if (committable && existsSync(resolved) && !isDirectory) {
				check(committable.has(resolved), `${path} links to ${target}, which exists but is ignored by git`);
			}
		}
	}

	if (failures.length > 0) {
		throw new Error(`AskMate repository guards failed:\n- ${failures.join("\n- ")}`);
	}

	console.log("AskMate repository guards passed.");
}

/** Looks at the built main.js. It is the file Obsidian loads, so this is the last check before the attestation. */
async function runBundleChecks(): Promise<void> {
	const { findDisallowedRequires } = await import("../esbuild.config.mjs");
	for (const asset of ["main.js", "manifest.json", "styles.css"]) {
		check(existsSync(asset) && statSync(asset).size > 0, `${asset} is missing or empty; run bun run build first`);
	}
	if (failures.length === 0) {
		const code = readFileSync("main.js", "utf8");
		const size = statSync("main.js").size;
		check(size <= MAX_BUNDLE_BYTES, `main.js is ${Math.round(size / 1024)} KB, over the ${Math.round(MAX_BUNDLE_BYTES / 1024)} KB ceiling; something large was bundled`);
		const disallowed = findDisallowedRequires(code);
		check(disallowed.length === 0, `main.js requires modules that are not part of a release: ${disallowed.join(", ")}`);
		check(!/sourceMappingURL/.test(code), "main.js carries a source map reference; release builds must not");
		check(!/\beval\s*\(|new Function\s*\(/.test(code), "main.js contains dynamic code evaluation");
	}
	if (failures.length > 0) {
		throw new Error(`AskMate bundle checks failed:\n- ${failures.join("\n- ")}`);
	}
	console.log("AskMate bundle checks passed.");
}

// Bun sets import.meta.main; it is read through Reflect so this file needs no bun-types. Importing the file (tests) runs nothing.
if (Reflect.get(import.meta, "main") === true) {
	if (process.argv.includes("--bundle")) {
		await runBundleChecks();
	} else {
		runRepoGuards();
	}
}
