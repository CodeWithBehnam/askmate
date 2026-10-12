import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findImageTargets, findSettingReferences, findUntaggedFences } from "../scripts/roadmap-smoke-tests";
import { validateServerUrl } from "../src/mcp/httpTransport";
import { offersChatGrant } from "../src/mcp/toolPolicy";
import { DEFAULT_TOOL_LOOP_LIMITS } from "../src/providers/tools/loop";
import { MCP_OUTPUT_CHARS_BOUNDS, MCP_TOOL_ROUNDS_BOUNDS } from "../src/settings/constants";
import { MAX_SAVED_MESSAGE_CHARACTERS, MAX_SAVED_THREADS, MAX_THREAD_MESSAGES, MAX_THREAD_STORE_BYTES } from "../src/threads/threadModel";
import { trimBackupName } from "../src/plugin/settingsLoad";
import {
	ADDRESS_HELP,
	APPROVAL_HELP,
	APPROVAL_LABELS,
	PLAIN_HTTP_HOSTS_TEXT,
	PLAIN_HTTP_KEPT_OFF_NOTICE,
	describeTokenSaved,
	newServer
} from "../src/ui/settings/mcpPage";

/*
 * The words the settings use about what the code does, and the same facts in the README and docs. Each test ties a sentence to the
 * code that decides it, so the sentence cannot drift on its own.
 */

const read = (path: string): string => readFileSync(path, "utf8");

describe("the address of a remote tool server", () => {
	const hosts = PLAIN_HTTP_HOSTS_TEXT.replace(" and ", ", ").split(", ");

	test("help and notice name the hosts that plain HTTP really works for, and nothing wider", () => {
		expect(hosts).toEqual(["localhost", "127.0.0.1", "[::1]"]);
		for (const host of hosts) {
			expect(() => validateServerUrl(`http://${host}:8080/mcp`)).not.toThrow();
		}
		for (const host of ["192.168.1.20", "10.0.0.5", "mcp.local", "homeserver"]) {
			expect(() => validateServerUrl(`http://${host}:8080/mcp`)).toThrow("Plain http:// is only allowed for localhost");
		}
		expect(ADDRESS_HELP).toContain(`Plain HTTP is accepted only for ${PLAIN_HTTP_HOSTS_TEXT}`);
		expect(ADDRESS_HELP).toContain("needs HTTPS");
		expect(PLAIN_HTTP_KEPT_OFF_NOTICE).toContain(`plain HTTP is only allowed for ${PLAIN_HTTP_HOSTS_TEXT}`);
		for (const text of [ADDRESS_HELP, PLAIN_HTTP_KEPT_OFF_NOTICE]) {
			expect(text).not.toMatch(/own (?:computer or )?network/i);
		}
	});

	test("docs/mcp.md says the same thing", () => {
		const doc = read("docs/mcp.md");
		for (const host of hosts) {
			expect(doc).toContain(`\`${host}\``);
		}
		expect(doc).toContain("a server on another machine in your network needs HTTPS");
	});
});

describe("approval modes", () => {
	test("each mode is named in the docs by the label the settings show", () => {
		const doc = read("docs/mcp.md");
		for (const label of Object.values(APPROVAL_LABELS)) {
			expect(doc).toContain(`\`${label}\``);
		}
		expect(Object.values(APPROVAL_LABELS)).toEqual(["Ask before every call", "Ask once for each tool in a chat", "Ask unless the tool only reads"]);
	});

	test("a new server asks before every call, which is the default the docs and README give", () => {
		expect(newServer("http", { label: "Docs", target: "https://example.com/mcp" }, new Set()).approval).toBe("always-ask");
		expect(read("docs/mcp.md")).toContain("`Ask before every call` (default)");
		expect(read("README.md")).toContain("`Ask before every call` (the default)");
	});

	test("always asking remembers nothing and offers no chat grant, and asking once per tool offers it and lets it cover later calls", () => {
		expect(offersChatGrant("always-ask")).toBe(false);
		expect(offersChatGrant("ask-once-per-chat")).toBe(true);
		expect(offersChatGrant("trusted-read-only")).toBe(true);
		expect(APPROVAL_HELP["always-ask"]).toContain("nothing is remembered");
		expect(APPROVAL_HELP["always-ask"]).toContain("only Allow once and Deny");
		expect(APPROVAL_HELP["always-ask"]).not.toContain("even if you chose Allow for this chat");
		expect(APPROVAL_HELP["ask-once-per-chat"]).toContain("The card then offers Allow for this chat");
		expect(APPROVAL_HELP["ask-once-per-chat"]).toContain("that tool runs without asking again in that conversation");
		expect(APPROVAL_HELP["trusted-read-only"]).toContain("its card offers Allow for this chat");
		const doc = read("docs/mcp.md");
		expect(doc).toContain("Every call waits for you and nothing is remembered. The card offers only Allow once and Deny.");
		expect(doc).toContain("later calls of that tool in the same conversation run without asking");
		expect(doc).not.toContain("is never reused");
		expect(read("docs/privacy.md")).toContain("`Ask before every call` offers only Allow once and Deny and remembers nothing");
		const readme = read("README.md");
		expect(readme).toContain("offers Allow once or Deny and remembers nothing");
		expect(readme).toContain("also offers Allow for this chat");
	});
});

describe("tool limits", () => {
	const rounds = MCP_TOOL_ROUNDS_BOUNDS;
	const characters = MCP_OUTPUT_CHARS_BOUNDS;
	const grouped = (value: number): string => value.toLocaleString("en-GB");

	test("the docs give the default and the bounds that the settings enforce", () => {
		const doc = read("docs/mcp.md");
		expect(doc).toContain(`\`Tool rounds per answer\` rounds of tool calls (${rounds.fallback} by default, from ${rounds.min} to ${rounds.max})`);
		expect(doc).toContain(`\`Longest tool result\` characters (${grouped(characters.fallback)} by default, from ${grouped(characters.min)} to ${grouped(characters.max)})`);
		expect(doc).toContain("AskMate applies both settings as you set them");
		const readme = read("README.md");
		expect(readme).toContain(`\`Tool rounds per answer\` (${rounds.fallback} by default, up to ${rounds.max})`);
		expect(readme).toContain(`\`Longest tool result\` (${grouped(characters.fallback)} characters by default)`);
	});

	test("the docs say the model gets that many tool turns and then one more turn without tools, and name the 12-call ceiling the loop enforces", () => {
		expect(DEFAULT_TOOL_LOOP_LIMITS.maxToolCalls).toBe(12);
		expect(rounds.max).toBeLessThanOrEqual(DEFAULT_TOOL_LOOP_LIMITS.maxToolCalls);
		const doc = read("docs/mcp.md");
		expect(doc).toContain("After the last round it gets one more turn, without tools, to write the answer");
		expect(doc).toContain(`An answer makes at most ${DEFAULT_TOOL_LOOP_LIMITS.maxToolCalls} calls in all`);
		expect(doc).toContain("cut at exactly `Longest tool result` characters");
		const readme = read("README.md");
		expect(readme).toContain("plus one last turn without tools to write the answer");
		expect(readme).toContain(`an answer makes at most ${DEFAULT_TOOL_LOOP_LIMITS.maxToolCalls} calls`);
		expect(readme).toContain("cuts each result at exactly that length");
	});

	test("tool replies arrive in one piece until the sidebar passes onTextReset, and the documents say so", () => {
		// RequestRunner streams a tool run only for a caller that supplies onTextReset. When the sidebar does, these sentences must change.
		const wired = read("src/ui/sidebar/AskMateView.ts").includes("onTextReset");
		for (const path of ["README.md", "docs/mcp.md", "docs/commands.md", "CHANGELOG.md"]) {
			expect(read(path).includes("arrives in one piece")).toBe(!wired);
		}
	});

	test("no document still says that a hidden lower cap applies", () => {
		const claims = ["README.md", "docs/mcp.md", "CHANGELOG.md"].flatMap((path) =>
			Array.from(read(path).matchAll(/never goes beyond \d+ rounds|never receives more than [\d,]+ characters|at most 7 rounds/g), (match) => `${path}: ${match[0]}`)
		);
		expect(claims).toEqual([]);
	});
});

describe("saving a bearer token", () => {
	test("pasting a new token under the same name leaves the server trusted, and only a new name asks again", () => {
		expect(describeTokenSaved("askmate-mcp-docs-token", "askmate-mcp-docs-token")).toContain("stays trusted");
		expect(describeTokenSaved(null, "askmate-mcp-docs-token")).toContain("asks for trust again");
		expect(describeTokenSaved("someone-elses-secret", "askmate-mcp-docs-token")).toContain("asks for trust again");
	});
});

describe("the README", () => {
	const readme = read("README.md");

	test("shows only artwork that ships, with no screenshot folder", () => {
		expect(findImageTargets(readme).sort()).toEqual(["assets/hero-dark.svg", "assets/hero-light.svg"]);
		expect(readme.includes("assets/screenshots")).toBe(false);
	});

	test("stays short, in British English, without an em dash", () => {
		const prose = readme.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
		expect(prose.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length).toBeLessThanOrEqual(1900);
		expect(readme.includes("\u2014")).toBe(false);
		expect(findUntaggedFences(readme)).toEqual([]);
		expect(Array.from(prose.matchAll(/\b(?:color|summarize|organize|behavior)\b/gi), (match) => match[0])).toEqual([]);
	});

	test("says that commands and mentions work in every layout", () => {
		expect(readme).toContain("Slash commands and `@` mentions work in every sidebar layout");
		expect(read("docs/commands.md")).toContain("Slash commands and `@` mentions work in all of them");
	});
});

describe("saved conversations and sync", () => {
	const sync = "If this vault's plugin data syncs between devices, repeat the deletion on each device. A device that still holds a conversation or a queued review puts it back.";
	const mebibytes = MAX_THREAD_STORE_BYTES / (1024 * 1024);

	test("the documents give the limits the store enforces, in the order it applies them", () => {
		const limits = `${MAX_SAVED_THREADS} threads of ${MAX_THREAD_MESSAGES} messages`;
		expect(mebibytes).toBe(2);
		expect(read("docs/privacy.md")).toContain(`Up to ${limits} each, within ${mebibytes} MiB in all`);
		expect(read("docs/commands.md")).toContain(`AskMate keeps up to ${limits} each, within ${mebibytes} MiB in all`);
		expect(read("README.md")).toContain(`up to ${limits}, ${mebibytes} MiB in all with the oldest first`);
		for (const path of ["README.md", "docs/privacy.md", "docs/commands.md", "CHANGELOG.md"]) {
			const doc = read(path);
			expect(doc).toContain(`${MAX_SAVED_MESSAGE_CHARACTERS.toLocaleString("en-GB")} characters`);
			expect(doc).toContain("data.json.before-trim-");
		}
		expect(trimBackupName(new Date("2026-10-12T09:11:00.000Z"))).toBe("data.json.before-trim-2026-10-12T09-11-00Z");
	});

	test("every delete control and the documents say that a deletion has to be repeated on each synced device", () => {
		expect(read("src/ui/settings/AskMateSettingTab.ts").split(sync)).toHaveLength(4);
		for (const path of ["docs/privacy.md", "docs/troubleshooting.md", "docs/commands.md", "CHANGELOG.md"]) {
			expect(read(path)).toMatch(/on (?:every|each) device/);
		}
		expect(read("README.md")).toContain("repeat a deletion on each device");
	});

	test("the Apply approval choices carry the labels the settings show", () => {
		const mode = "Yes or no, only when replacing the whole note";
		for (const path of ["README.md", "docs/apply.md"]) {
			expect(read(path)).toContain(`\`${mode}\``);
			expect(read(path)).not.toContain("`Only when replacing the whole note`");
		}
		expect(read("docs/apply.md")).toContain("Shows no diff. Asks a plain yes or no before a whole note is replaced");
	});
});

describe("Azure OpenAI keys", () => {
	test("the documents say that a stored key waits for approval of its host, with the one-off question after upgrading", () => {
		expect(read("docs/providers.md")).toContain("For Azure OpenAI, Azure AI Foundry and Local or self-hosted addresses that are not on this computer");
		expect(read("docs/privacy.md")).toContain("an Azure OpenAI, Azure AI Foundry or Local address that is not on this computer");
		expect(read("docs/privacy.md")).toContain("on the first request after upgrading");
		expect(read("docs/troubleshooting.md")).toContain("Local, Azure OpenAI or Azure AI Foundry address");
		expect(read("CHANGELOG.md")).toContain("Azure OpenAI keys go only to a host this device has approved, and first use asks once");
	});
});

describe("skills and the prompt inspector", () => {
	test("the documents say what happens with Use skills off and what the inspector adds at send time", () => {
		const skills = read("docs/skills.md");
		expect(skills).toContain("While it is off, a skill named with `/skill` or `@skill:`, kept on for the conversation or carried by a workflow is skipped and AskMate says so in a notice");
		expect(skills).toContain("The built-in diagram guidance still applies to diagram requests");
		expect(skills).toContain("The diagram brief and the MCP tools section are added when the request is sent");
		expect(read("docs/commands.md")).toContain("adds its diagram brief");
		expect(read("docs/diagrams.md")).toContain("diagram requests still use it when `Use skills` is off");
	});

	test("skill files are described as read on the device and sent only when the skill is used", () => {
		for (const path of ["README.md", "docs/privacy.md"]) {
			expect(read(path)).toContain("a skill's text is sent to the model only when that skill is used");
		}
	});
});

describe("the changelog for 1.12.0", () => {
	const section = read("CHANGELOG.md").split("\n## [")[1] ?? "";

	test("lists the security, hardening and sync changes of the final fixes", () => {
		expect(section.startsWith("1.12.0]")).toBe(true);
		for (const phrase of [
			"Azure OpenAI keys go only to a host this device has approved",
			"one dedicated dialog that marks invisible characters, and there is a single tool approval dialog",
			"names note templates that hold code another plugin runs",
			"two devices with different open conversations no longer rewrite `data.json` for each other",
			"A device still on 1.11.1 no longer resets a 1.12.0 device's MCP servers, skill trust or diagram settings",
			"Note paths with `#`, `^` or `|` in the file name",
			"shows a notice and keeps a copy of the file as `data.json.before-trim-`",
			"Quitting Obsidian stops local MCP servers",
			"has the server's own secret values masked",
			"ends the processes it started too",
			"labels a JSON reply as an event stream, or the reverse",
			"connects sooner",
			"a deletion does not travel"
		]) {
			expect(section).toContain(phrase);
		}
	});

	test("keeps the tone rules: no em dash, no American spellings", () => {
		expect(section.includes("\u2014")).toBe(false);
		expect(Array.from(section.matchAll(/\b(?:color|summarize|organize|behavior|recognize)\b/gi), (match) => match[0])).toEqual([]);
	});
});

describe("the reference extraction", () => {
	test("finds the names a sentence ties to the settings, and skips paths and commands", () => {
		const text = "Turn saving off with `Remember conversations` on the `Privacy and memory` page, under `Kept on this device`. Requests go to `/models/chat` and `data.json`. Open `Workflow sidebar`, then set `Per-note memory` to `Off`.";
		expect(findSettingReferences(text).sort()).toEqual(["Kept on this device", "Off", "Per-note memory", "Privacy and memory", "Remember conversations", "Workflow sidebar"]);
	});

	test("ignores names inside code blocks and comments", () => {
		const text = "```text\nTurn on `Fake setting` on the `Fake page` page.\n```\n\n<!-- Turn on `Hidden` on the `Nowhere` page. -->";
		expect(findSettingReferences(text)).toEqual([]);
	});

	test("finds images of every kind and nothing in code", () => {
		const text = "![Alt](a.png) <img src=\"b.svg\" alt=\"x\"> <source srcset=\"c.svg\"> [link](d.md) ![web](https://example.com/e.png) `![code](f.png)`";
		expect(findImageTargets(text)).toEqual(["a.png", "b.svg", "c.svg"]);
	});
});
