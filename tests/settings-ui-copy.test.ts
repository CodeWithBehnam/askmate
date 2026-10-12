import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findImageTargets, findSettingReferences, findUntaggedFences } from "../scripts/roadmap-smoke-tests";
import { validateServerUrl } from "../src/mcp/httpTransport";
import { MCP_OUTPUT_CHARS_BOUNDS, MCP_TOOL_ROUNDS_BOUNDS } from "../src/settings/constants";
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

	test("always asking never reuses a chat grant, and asking once per tool lets it cover later calls of that tool", () => {
		expect(APPROVAL_HELP["always-ask"]).toContain("even if you chose Allow for this chat earlier");
		expect(APPROVAL_HELP["ask-once-per-chat"]).toContain("later calls of that tool in the same conversation run without asking");
		const doc = read("docs/mcp.md");
		expect(doc).toContain("An earlier Allow for this chat is never reused");
		expect(doc).toContain("later calls of that tool in the same conversation run without asking");
		expect(read("docs/privacy.md")).toContain("while `Ask before every call` never reuses it");
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
