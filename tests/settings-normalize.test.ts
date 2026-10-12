import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CUSTOM_WORKFLOW_PROMPT,
	MAX_CUSTOM_WORKFLOWS,
	MAX_CUSTOM_WORKFLOW_NAME_LENGTH,
	MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH,
	MAX_MCP_ARGS,
	MAX_MCP_DISABLED_TOOLS,
	MAX_MCP_ENV_ENTRIES,
	MAX_MCP_LABEL_LENGTH,
	MAX_MCP_SERVERS,
	MAX_MCP_TOOL_NAME_LENGTH,
	MAX_WORKFLOW_SKILL_IDS
} from "../src/settings/constants";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import {
	formatOperationKind,
	formatRequestIntent,
	normalizeApiEndpoint,
	normalizeApplyScope,
	normalizeAskMateSettings,
	normalizeAskMateSettingsWithDiagnostics,
	normalizeBatchWorkflowOutputMode,
	normalizeBudgetEnforcementMode,
	normalizeComposerLayout,
	normalizeContextBudgetMode,
	normalizeCustomWorkflow,
	normalizeCustomWorkflows,
	normalizeCustomWorkflowsWithDiagnostics,
	normalizeDiagramSettings,
	normalizeFrontmatterApplyPolicy,
	normalizeMcpSettings,
	normalizeMcpSettingsWithDiagnostics,
	normalizeNoteHistoryStore,
	normalizeOperationKind,
	normalizeOperationStatus,
	normalizeOutputMode,
	normalizeReasoningEffort,
	normalizeSendShortcut,
	normalizeSkillsSettings,
	normalizeTextProviderId,
	normalizeTokenUsageStats,
	normalizeWorkflowOutputKind
} from "../src/settings/normalize";
import type { AskMateSettings, McpServerConfig } from "../src/shared/types";

describe("normalizeAskMateSettings", () => {
	test("load applies defaults and provider roles", () => {
		const settings = normalizeAskMateSettings({}, "load");
		expect(settings.selectedTextProvider).toBe(DEFAULT_SETTINGS.selectedTextProvider);
		expect(settings.providerRoles.chatProviderId).toBeTruthy();
		expect(settings.applyApprovalMode).toBe("manual");
		expect(settings.showApplyPreview).toBe(true);
		expect(settings.providers.openai.model).toBeTruthy();
	});

	test("save mirrors OpenAI provider fields and keeps approval sync", () => {
		const loaded = normalizeAskMateSettings({
			providers: {
				...DEFAULT_SETTINGS.providers,
				openai: {
					...DEFAULT_SETTINGS.providers.openai,
					model: "gpt-5.5",
					apiKeySecretName: "openai-key"
				}
			},
			applyApprovalMode: "auto-approve"
		}, "load");
		const saved = normalizeAskMateSettings(loaded, "save");
		expect(saved.model).toBe("gpt-5.5");
		expect(saved.openAiApiKeySecretName).toBe("openai-key");
		expect(saved.showApplyPreview).toBe(false);
		expect(saved.applyApprovalMode).toBe("auto-approve");
	});

	test("invalid output mode normalizes on load and save", () => {
		const loaded = normalizeAskMateSettings({ outputMode: "invalid" } as never, "load");
		expect(loaded.outputMode).toBe("chat");
		loaded.outputMode = "invalid" as never;
		expect(normalizeAskMateSettings(loaded, "save").outputMode).toBe("chat");
	});

	test("legacy showApplyPreview false migrates to auto-approve on load", () => {
		const settings = normalizeAskMateSettings({
			showApplyPreview: false
		} as Partial<typeof DEFAULT_SETTINGS>, "load");
		expect(settings.applyApprovalMode).toBe("auto-approve");
		expect(settings.showApplyPreview).toBe(false);
	});

	test("the new groups and onboarding fields have safe defaults", () => {
		const settings = normalizeAskMateSettings({}, "load");
		expect(settings.skills.enabled).toBe(true);
		expect(settings.skills.matching).toBe("builtin-auto");
		expect(settings.diagrams.enabled).toBe(true);
		expect(settings.mcp).toEqual({ enabled: false, servers: [], maxToolRoundsPerTurn: 5, maxOutputChars: 20000 });
		expect(settings.firstRunCompletedAt).toBeNull();
		expect(settings.lastSeenVersion).toBeNull();
	});

	test("onboarding fields accept an ISO date and a version, and reject anything else", () => {
		const good = normalizeAskMateSettings({ firstRunCompletedAt: "2026-10-12T09:00:00Z", lastSeenVersion: " 1.12.0 " } as Partial<AskMateSettings>, "load");
		expect(good.firstRunCompletedAt).toBe("2026-10-12T09:00:00.000Z");
		expect(good.lastSeenVersion).toBe("1.12.0");
		const bad = normalizeAskMateSettings({ firstRunCompletedAt: "yesterday", lastSeenVersion: "latest" } as Partial<AskMateSettings>, "load");
		expect(bad.firstRunCompletedAt).toBeNull();
		expect(bad.lastSeenVersion).toBeNull();
		expect(normalizeAskMateSettings({ lastSeenVersion: 12 } as unknown as Partial<AskMateSettings>, "load").lastSeenVersion).toBeNull();
	});
});

describe("custom workflow limits", () => {
	const longPrompt = (length: number): string => "x".repeat(length);

	test("the limits are exported for the UI and the load path", () => {
		expect(MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH).toBe(12000);
		expect(MAX_CUSTOM_WORKFLOW_NAME_LENGTH).toBe(80);
		expect(MAX_CUSTOM_WORKFLOWS).toBe(30);
		expect(MAX_WORKFLOW_SKILL_IDS).toBe(3);
	});

	test("a prompt over the cap is cut at 12,000 characters and reported", () => {
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics([{ name: "Long", prompt: longPrompt(13000) }]);
		expect(workflows[0].prompt).toHaveLength(12000);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].code).toBe("workflow-prompt-truncated");
		expect(diagnostics[0].subject).toBe("Long");
		expect(diagnostics[0].message).toContain("12,000");
	});

	test("a prompt of exactly the cap is untouched and not reported", () => {
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics([{ name: "Edge", prompt: longPrompt(12000) }]);
		expect(workflows[0].prompt).toHaveLength(12000);
		expect(diagnostics).toEqual([]);
	});

	test("a named workflow with an empty prompt gets the generic prompt and is reported", () => {
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics([{ name: "Blank", prompt: "   " }]);
		expect(workflows[0].prompt).toBe(DEFAULT_CUSTOM_WORKFLOW_PROMPT);
		expect(diagnostics.map((item) => item.code)).toEqual(["workflow-prompt-empty"]);
	});

	test("workflows beyond the cap of 30 are dropped and the count is reported", () => {
		const raw = Array.from({ length: 35 }, (_, index) => ({ id: `custom-${index}`, name: `Workflow ${index}`, prompt: "p" }));
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics(raw);
		expect(workflows).toHaveLength(30);
		expect(workflows[29].id).toBe("custom-29");
		const dropped = diagnostics.filter((item) => item.code === "workflows-dropped");
		expect(dropped).toHaveLength(1);
		expect(dropped[0].message).toContain("5");
	});

	test("entries that are not workflows are reported as invalid", () => {
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics([null, 4, "text", {}, { name: "", prompt: "" }, { name: "Keep", prompt: "p" }]);
		expect(workflows.map((workflow) => workflow.name)).toEqual(["Keep"]);
		expect(diagnostics.filter((item) => item.code === "workflow-invalid")).toHaveLength(5);
	});

	test("a long name is cut to 80 characters and reported", () => {
		const { workflows, diagnostics } = normalizeCustomWorkflowsWithDiagnostics([{ name: "N".repeat(120), prompt: "p" }]);
		expect(workflows[0].name).toHaveLength(80);
		expect(diagnostics.map((item) => item.code)).toEqual(["workflow-name-truncated"]);
	});

	test("clean lists, and a non-array value, give no diagnostics", () => {
		expect(normalizeCustomWorkflowsWithDiagnostics([{ name: "A", prompt: "p" }]).diagnostics).toEqual([]);
		expect(normalizeCustomWorkflowsWithDiagnostics(undefined)).toEqual({ workflows: [], diagnostics: [] });
	});

	test("the plain functions keep returning just the workflows", () => {
		expect(normalizeCustomWorkflows([{ name: "A", prompt: "p" }])).toHaveLength(1);
		expect(normalizeCustomWorkflow({ name: "A", prompt: "p" }, 0)?.name).toBe("A");
		expect(normalizeCustomWorkflow(null, 0)).toBeNull();
	});

	test("settings normalisation hands the workflow diagnostics back to the load path", () => {
		const raw = { customWorkflows: [{ name: "Long", prompt: longPrompt(12500) }] } as unknown as Partial<AskMateSettings>;
		const loaded = normalizeAskMateSettingsWithDiagnostics(raw, "load");
		expect(loaded.settings.customWorkflows[0].prompt).toHaveLength(12000);
		expect(loaded.diagnostics.map((item) => item.code)).toContain("workflow-prompt-truncated");
		// Once the data is clean the same pass reports nothing, so the notice appears only once.
		expect(normalizeAskMateSettingsWithDiagnostics(loaded.settings, "save").diagnostics).toEqual([]);
	});

	test("skill ids are trimmed, de-duplicated, capped and omitted when empty", () => {
		const [withSkills] = normalizeCustomWorkflows([{ name: "A", prompt: "p", skillIds: [" built-in:mermaid-diagrams ", "built-in:mermaid-diagrams", "vault:notes", 7, "", "a b", "vault:c", "vault:d"] }]);
		expect(withSkills.skillIds).toEqual(["built-in:mermaid-diagrams", "vault:notes", "vault:c"]);
		const [none] = normalizeCustomWorkflows([{ name: "B", prompt: "p", skillIds: [] }]);
		expect("skillIds" in none).toBe(false);
		const [notArray] = normalizeCustomWorkflows([{ name: "C", prompt: "p", skillIds: "built-in:x" }]);
		expect("skillIds" in notArray).toBe(false);
	});
});

describe("skills settings", () => {
	test("defaults: enabled, built-in automatic matching, a visible default folder", () => {
		expect(normalizeSkillsSettings(undefined)).toEqual({
			enabled: true,
			folder: "AskMate/Skills",
			matching: "builtin-auto",
			disabledIds: [],
			trustedHashes: {}
		});
		expect(DEFAULT_SETTINGS.skills).toEqual(normalizeSkillsSettings(null));
	});

	test.each(["off", "suggest", "builtin-auto", "all-auto"])("matching mode %s is kept", (matching) => {
		expect(normalizeSkillsSettings({ matching }).matching).toBe(matching);
	});

	test("an unknown matching mode falls back to the safe default, never to all-auto", () => {
		expect(normalizeSkillsSettings({ matching: "everything" }).matching).toBe("builtin-auto");
		expect(normalizeSkillsSettings({ matching: 3 }).matching).toBe("builtin-auto");
	});

	test("the folder must be a visible vault folder", () => {
		expect(normalizeSkillsSettings({ folder: "My Skills" }).folder).toBe("My Skills");
		expect(normalizeSkillsSettings({ folder: " /Notes\\Skills/ " }).folder).toBe("Notes/Skills");
		for (const folder of ["", "   ", ".obsidian/skills", "Notes/.hidden", "../Outside", "Notes/../x", ".", 4, null]) {
			expect(normalizeSkillsSettings({ folder }).folder).toBe("AskMate/Skills");
		}
	});

	test("trusted hashes keep valid SHA-256 hex only, lower-cased, and never for built-ins", () => {
		const settings = normalizeSkillsSettings({
			trustedHashes: {
				"vault:ok": "A".repeat(64),
				"vault:short": "abc",
				"vault:not-hex": "z".repeat(64),
				"built-in:mermaid-diagrams": "b".repeat(64),
				"": "c".repeat(64),
				"vault:number": 5
			}
		});
		expect(settings.trustedHashes).toEqual({ "vault:ok": "a".repeat(64) });
		expect(normalizeSkillsSettings({ trustedHashes: ["x"] }).trustedHashes).toEqual({});
	});

	test("disabled ids are trimmed, de-duplicated and capped", () => {
		expect(normalizeSkillsSettings({ disabledIds: [" a ", "a", "", 3, "b"] }).disabledIds).toEqual(["a", "b"]);
		expect(normalizeSkillsSettings({ disabledIds: Array.from({ length: 500 }, (_, index) => `s${index}`) }).disabledIds).toHaveLength(200);
		expect(normalizeSkillsSettings({ disabledIds: "a" }).disabledIds).toEqual([]);
	});

	test("enabled keeps an explicit false and ignores non-booleans", () => {
		expect(normalizeSkillsSettings({ enabled: false }).enabled).toBe(false);
		expect(normalizeSkillsSettings({ enabled: "no" }).enabled).toBe(true);
	});
});

describe("diagram settings", () => {
	test("defaults: enabled, automatic type and style, one repair turn allowed", () => {
		expect(normalizeDiagramSettings(undefined)).toEqual({ enabled: true, defaultType: "auto", defaultStyle: "auto", allowRepairTurn: true });
		expect(DEFAULT_SETTINGS.diagrams).toEqual(normalizeDiagramSettings(null));
	});

	test("type and style are lower-case slugs, anything else becomes auto", () => {
		expect(normalizeDiagramSettings({ defaultType: "Sequence", defaultStyle: "Editorial-Ink" })).toMatchObject({ defaultType: "sequence", defaultStyle: "editorial-ink" });
		expect(normalizeDiagramSettings({ defaultType: "flow chart" }).defaultType).toBe("flow-chart");
		for (const value of ["", "../x", "a/b", "x".repeat(60), 5, null, "{{note}}"]) {
			expect(normalizeDiagramSettings({ defaultType: value, defaultStyle: value })).toMatchObject({ defaultType: "auto", defaultStyle: "auto" });
		}
	});

	test("booleans keep an explicit false", () => {
		expect(normalizeDiagramSettings({ enabled: false, allowRepairTurn: false })).toMatchObject({ enabled: false, allowRepairTurn: false });
		expect(normalizeDiagramSettings({ enabled: "off", allowRepairTurn: 0 })).toMatchObject({ enabled: true, allowRepairTurn: true });
	});
});

describe("MCP settings", () => {
	const stdio = {
		id: "git",
		label: "Git",
		transport: "stdio",
		enabled: true,
		approval: "always-ask",
		trustsAnnotations: false,
		trustedConfigHash: null,
		command: "uvx",
		args: ["mcp-server-git", "--repository", "/tmp/repo"],
		env: { LOG_LEVEL: { kind: "plain", value: "info" }, GITHUB_TOKEN: { kind: "secret", secretId: "askmate-mcp-git-token" } }
	};
	const http = {
		id: "docs",
		label: "Docs",
		transport: "http",
		enabled: false,
		approval: "ask-once-per-chat",
		trustsAnnotations: true,
		callTimeoutMs: 20000,
		trustedConfigHash: "a".repeat(64),
		url: "https://mcp.example.com/mcp",
		headers: { "X-Org": { kind: "plain", value: "acme" }, "X-Api-Key": { kind: "secret", secretId: "askmate-mcp-docs-key" } },
		bearerSecretId: "askmate-mcp-docs-bearer"
	};

	function servers(...entries: unknown[]): McpServerConfig[] {
		return normalizeMcpSettings({ enabled: true, servers: entries }).servers;
	}

	test("defaults: off, no servers, 5 rounds, 20,000 characters", () => {
		expect(normalizeMcpSettings(undefined)).toEqual({ enabled: false, servers: [], maxToolRoundsPerTurn: 5, maxOutputChars: 20000 });
		expect(DEFAULT_SETTINGS.mcp).toEqual(normalizeMcpSettings(null));
	});

	test("enabled is true only for an explicit true", () => {
		expect(normalizeMcpSettings({ enabled: true }).enabled).toBe(true);
		for (const value of ["true", 1, null, undefined, {}]) {
			expect(normalizeMcpSettings({ enabled: value }).enabled).toBe(false);
		}
	});

	test("well-formed stdio and http servers round trip unchanged", () => {
		const first = normalizeMcpSettings({ enabled: true, servers: [stdio, http] });
		expect(first.servers).toEqual([stdio, http] as unknown as McpServerConfig[]);
		expect(normalizeMcpSettings(structuredClone(first))).toEqual(first);
	});

	test("a server is off and asks before every call unless the user said otherwise", () => {
		const [server] = servers({ id: "bare", transport: "stdio", command: "node" });
		expect(server.enabled).toBe(false);
		expect(server.approval).toBe("always-ask");
		expect(server.trustsAnnotations).toBe(false);
		expect(server.trustedConfigHash).toBeNull();
		const [odd] = servers({ id: "odd", transport: "stdio", command: "node", enabled: "yes", approval: "never-ask", trustsAnnotations: "true", trustedConfigHash: "not-a-hash" });
		expect(odd.enabled).toBe(false);
		expect(odd.approval).toBe("always-ask");
		expect(odd.trustsAnnotations).toBe(false);
		expect(odd.trustedConfigHash).toBeNull();
	});

	test("entries store secret ids only: a plain value under a sensitive name is dropped and reported", () => {
		const result = normalizeMcpSettingsWithDiagnostics({
			enabled: true,
			servers: [
				{ ...stdio, env: { GITHUB_TOKEN: { kind: "plain", value: "ghp_realtoken" }, API_KEY: "sk-live", OPENAI_API_KEY: { kind: "plain", value: "sk-x" }, SAFE: "yes" } },
				{ ...http, headers: { Authorization: { kind: "plain", value: "Bearer abc" }, "X-Session": "s", Cookie: "a=b", "X-Org": "acme" } }
			]
		});
		const [first, second] = result.settings.servers;
		expect(first.transport === "stdio" ? first.env : null).toEqual({ SAFE: { kind: "plain", value: "yes" } });
		expect(second.transport === "http" ? second.headers : null).toEqual({ "X-Org": { kind: "plain", value: "acme" } });
		expect(result.diagnostics.filter((item) => item.code === "mcp-value-dropped")).toHaveLength(6);
		expect(JSON.stringify(result.settings)).not.toContain("ghp_realtoken");
		expect(JSON.stringify(result.settings)).not.toContain("sk-live");
		expect(JSON.stringify(result.settings)).not.toContain("Bearer abc");
	});

	test("secret references must look like SecretStorage ids, not tokens", () => {
		const [stdioServer] = servers({ ...stdio, env: { A: { kind: "secret", secretId: "ghp_AbC123realtoken" }, B: { kind: "secret", secretId: "UPPER" }, C: { kind: "secret", secretId: "x".repeat(200) }, D: { kind: "secret", secretId: "good-id-1" } } });
		expect(stdioServer.transport === "stdio" ? Object.keys(stdioServer.env) : []).toEqual(["D"]);
		const [httpServer] = servers({ ...http, bearerSecretId: "Bearer abc.def" });
		expect(httpServer.transport === "http" ? httpServer.bearerSecretId : "x").toBeNull();
	});

	test("fields that could hold a token are never carried onto an entry", () => {
		const [server] = servers({ ...stdio, token: "ghp_x", apiKey: "sk-x", bearerToken: "t", password: "p", authorization: "a", note: "n" });
		const text = JSON.stringify(server);
		for (const leaked of ["ghp_x", "sk-x", "bearerToken", "password", "authorization"]) {
			expect(text).not.toContain(leaked);
		}
		expect(Object.keys(server).sort()).toEqual(["approval", "args", "command", "enabled", "env", "id", "label", "transport", "trustedConfigHash", "trustsAnnotations"]);
	});

	test("an HTTP url may not carry credentials, and plain http is for the local network only", () => {
		expect(servers({ ...http, url: "https://user:pass@mcp.example.com/mcp" })).toEqual([]);
		expect(servers({ ...http, url: "https://mcp.example.com/mcp?access_token=abc" })).toEqual([]);
		expect(servers({ ...http, url: "https://mcp.example.com/mcp?api_key=abc" })).toEqual([]);
		expect(servers({ ...http, url: "ftp://mcp.example.com" })).toEqual([]);
		expect(servers({ ...http, url: "not a url" })).toEqual([]);
		expect(servers({ ...http, url: "http://localhost:8080/mcp" })).toHaveLength(1);
		expect(servers({ ...http, url: "https://mcp.example.com/mcp?version=2" })).toHaveLength(1);
	});

	test("plain http to a remote host is kept but forced off and reported, so the settings page can show the problem", () => {
		const { settings, diagnostics } = normalizeMcpSettingsWithDiagnostics({ enabled: true, servers: [{ ...http, enabled: true, url: "http://mcp.example.com/mcp" }] });
		expect(settings.servers).toHaveLength(1);
		expect(settings.servers[0]).toMatchObject({ id: "docs", enabled: false, url: "http://mcp.example.com/mcp" });
		expect(diagnostics.map((item) => item.code)).toEqual(["mcp-server-disabled"]);
		// Already off: nothing to report, and the result is stable.
		const second = normalizeMcpSettingsWithDiagnostics(settings);
		expect(second.settings).toEqual(settings);
		expect(second.diagnostics).toEqual([]);
		// A local-network address is still allowed to stay on.
		expect(servers({ ...http, enabled: true, url: "http://192.168.1.20:8080/mcp" })[0].enabled).toBe(true);
	});

	test("dropped servers are reported with the reason", () => {
		const { settings, diagnostics } = normalizeMcpSettingsWithDiagnostics({ servers: [{ id: "x", transport: "carrier-pigeon" }, { id: "y", transport: "stdio", command: "  " }, 5, null, { id: "docs", transport: "http", url: "https://user:pw@h.example/mcp" }] });
		expect(settings.servers).toEqual([]);
		expect(diagnostics).toHaveLength(5);
		expect(diagnostics.every((item) => item.code === "mcp-server-dropped")).toBe(true);
	});

	test("ids are lower-case slugs, derived from the label when missing, and unique", () => {
		const list = servers(
			{ transport: "stdio", command: "a", label: "My Git Server" },
			{ id: "Bad ID!", transport: "stdio", command: "b", label: "Second" },
			{ id: "my-git-server", transport: "stdio", command: "c" },
			{ id: "ok", transport: "stdio", command: "d" },
			{ transport: "stdio", command: "e" }
		);
		expect(list.map((server) => server.id)).toEqual(["my-git-server", "second", "ok"]);
		expect(list.map((server) => server.label)).toEqual(["My Git Server", "Second", "ok"]);
	});

	test("the number of servers, arguments and variables is capped", () => {
		const many = Array.from({ length: MAX_MCP_SERVERS + 10 }, (_, index) => ({ id: `s${index}`, transport: "stdio", command: "node" }));
		expect(servers(...many)).toHaveLength(MAX_MCP_SERVERS);
		const [server] = servers({ id: "big", transport: "stdio", command: "node", args: Array.from({ length: MAX_MCP_ARGS + 100 }, (_, index) => `a${index}`), env: Object.fromEntries(Array.from({ length: MAX_MCP_ENV_ENTRIES + 50 }, (_, index) => [`V${index}`, "1"])) });
		expect(server.transport === "stdio" ? server.args.length : 0).toBe(MAX_MCP_ARGS);
		expect(server.transport === "stdio" ? Object.keys(server.env).length : 0).toBe(MAX_MCP_ENV_ENTRIES);
	});

	// src/mcp/config.ts checks a server against these figures when it is used. A smaller figure here would silently cut a definition
	// it accepts, and a larger one would let through an entry it flags, so the two files are pinned to the same numbers.
	test("the size limits match the ones src/mcp/config.ts enforces", () => {
		expect({ servers: MAX_MCP_SERVERS, args: MAX_MCP_ARGS, label: MAX_MCP_LABEL_LENGTH, disabledTools: MAX_MCP_DISABLED_TOOLS, toolName: MAX_MCP_TOOL_NAME_LENGTH })
			.toEqual({ servers: 50, args: 100, label: 60, disabledTools: 500, toolName: 128 });
		const [server] = servers({ id: "wide", transport: "stdio", command: "node", label: "L".repeat(200), args: ["x".repeat(5000)] });
		expect(server.label).toHaveLength(MAX_MCP_LABEL_LENGTH);
		expect(server.transport === "stdio" ? server.args[0].length : 0).toBe(4096);
	});

	test("disabled tools round trip, are de-duplicated and are left out when empty", () => {
		const [server] = servers({ ...stdio, disabledTools: ["danger", "danger", 5, null, "", "x".repeat(MAX_MCP_TOOL_NAME_LENGTH + 1), "also"] });
		expect(server.disabledTools).toEqual(["danger", "also"]);
		const again = normalizeMcpSettings({ enabled: true, servers: [server] });
		expect(again.servers[0]).toEqual(server);
		for (const empty of [[], "danger", 5, null, undefined, [5, ""]]) {
			expect("disabledTools" in servers({ ...stdio, disabledTools: empty })[0]).toBe(false);
		}
		const [capped] = servers({ ...http, disabledTools: Array.from({ length: MAX_MCP_DISABLED_TOOLS + 20 }, (_, index) => `tool-${index}`) });
		expect(capped.disabledTools).toHaveLength(MAX_MCP_DISABLED_TOOLS);
	});

	test("disabled tools survive a settings load and save", () => {
		const raw = { mcp: { enabled: true, servers: [{ ...http, disabledTools: ["delete_everything"] }] } } as unknown as Partial<AskMateSettings>;
		const loaded = normalizeAskMateSettings(raw, "load");
		expect(loaded.mcp.servers[0].disabledTools).toEqual(["delete_everything"]);
		expect(normalizeAskMateSettings(JSON.parse(JSON.stringify(loaded)) as Partial<AskMateSettings>, "save").mcp.servers[0].disabledTools).toEqual(["delete_everything"]);
	});

	test("a server id starts with a letter, as src/mcp/config.ts requires", () => {
		const list = servers(
			{ id: "9lives", transport: "stdio", command: "a", label: "Nine Lives" },
			{ transport: "stdio", command: "b", label: "42 tools" },
			{ id: "ok-1", transport: "stdio", command: "c" }
		);
		expect(list.map((server) => server.id)).toEqual(["nine-lives", "server-42-tools", "ok-1"]);
		for (const server of list) {
			expect(server.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
		}
	});

	test("arguments keep only strings, and invalid variable or header names are dropped", () => {
		const [stdioServer, httpServer] = servers(
			{ id: "a", transport: "stdio", command: "node", args: ["ok", 5, null, "also"], env: { "BAD NAME": "x", "1BAD": "x", GOOD: "x" } },
			{ ...http, id: "b", headers: { "Bad Header": "x", "X-Good": "x" } }
		);
		expect(stdioServer.transport === "stdio" ? stdioServer.args : []).toEqual(["ok", "also"]);
		expect(stdioServer.transport === "stdio" ? Object.keys(stdioServer.env) : []).toEqual(["GOOD"]);
		expect(httpServer.transport === "http" ? Object.keys(httpServer.headers) : []).toEqual(["X-Good"]);
	});

	test("limits are bounded and fall back to the defaults", () => {
		expect(normalizeMcpSettings({ maxToolRoundsPerTurn: 99 }).maxToolRoundsPerTurn).toBe(12);
		expect(normalizeMcpSettings({ maxToolRoundsPerTurn: 0 }).maxToolRoundsPerTurn).toBe(1);
		expect(normalizeMcpSettings({ maxToolRoundsPerTurn: "many" }).maxToolRoundsPerTurn).toBe(5);
		expect(normalizeMcpSettings({ maxOutputChars: 10 }).maxOutputChars).toBe(1000);
		expect(normalizeMcpSettings({ maxOutputChars: 9e9 }).maxOutputChars).toBe(200000);
		const [timed] = servers({ id: "t", transport: "stdio", command: "node", callTimeoutMs: 5 }, { id: "u", transport: "stdio", command: "node", callTimeoutMs: "slow" });
		expect(timed.callTimeoutMs).toBe(1000);
		expect(servers({ id: "u", transport: "stdio", command: "node", callTimeoutMs: "slow" })[0].callTimeoutMs).toBeUndefined();
	});

	test("the settings-level pass reports dropped values and stays stable", () => {
		const raw = { mcp: { enabled: true, servers: [{ ...stdio, env: { GITHUB_TOKEN: "ghp_leak" } }] } } as unknown as Partial<AskMateSettings>;
		const first = normalizeAskMateSettingsWithDiagnostics(raw, "load");
		expect(first.diagnostics.map((item) => item.code)).toContain("mcp-value-dropped");
		expect(JSON.stringify(first.settings)).not.toContain("ghp_leak");
		expect(normalizeAskMateSettingsWithDiagnostics(first.settings, "save").diagnostics).toEqual([]);
	});
});

describe("unknown values fall back to the safe option", () => {
	test.each<[string, (value: unknown) => unknown, unknown]>([
		["reasoning effort", normalizeReasoningEffort, "medium"],
		["send shortcut", normalizeSendShortcut, "enter"],
		["composer layout", normalizeComposerLayout, "console"],
		["apply scope", normalizeApplyScope, "auto"],
		["frontmatter policy", normalizeFrontmatterApplyPolicy, "preserve"],
		["batch output mode", normalizeBatchWorkflowOutputMode, "note"],
		["budget enforcement", normalizeBudgetEnforcementMode, "warn"],
		["output mode", normalizeOutputMode, "chat"],
		["context budget", normalizeContextBudgetMode, "expanded"],
		["text provider", normalizeTextProviderId, "openai"],
		["workflow output kind", normalizeWorkflowOutputKind, "note-edit"],
		["operation kind", normalizeOperationKind, "text_response"],
		["operation status", normalizeOperationStatus, "completed"],
		["api endpoint", normalizeApiEndpoint, "responses"]
	])("%s", (_name, normalise, expected) => {
		for (const value of ["bogus", "", 7, null, undefined, {}, ["x"], "BLOCK"]) {
			expect(normalise(value)).toBe(expected);
		}
	});
});

describe("new request and operation variants", () => {
	test("diagram repair and tool rounds survive usage normalisation", () => {
		const record = (operationKind: string) => ({ timestamp: "2026-10-12T09:00:00.000Z", inputTokens: 10, outputTokens: 5, operationKind });
		const stats = normalizeTokenUsageStats({ records: [record("diagram_repair"), record("tool_round"), record("text_response"), record("nonsense")] });
		expect(stats.records.map((item) => item.operationKind)).toEqual(["diagram_repair", "tool_round", "text_response", "text_response"]);
	});

	test("have readable labels", () => {
		expect(formatOperationKind("diagram_repair")).toBe("Diagram repair");
		expect(formatOperationKind("tool_round")).toBe("Tool round");
		expect(formatOperationKind("image_generation")).toBe("Image");
		expect(formatRequestIntent("diagram")).toBe("Diagram");
		expect(formatRequestIntent("freeform_text")).toBe("Freeform text");
	});

	test("a saved note-history turn keeps the diagram intent", () => {
		const turn = { id: "t1", sourcePath: "Note.md", createdAt: "2026-10-12T09:00:00.000Z", question: "Draw it", answer: "```mermaid```" };
		const store = normalizeNoteHistoryStore({ turns: [{ ...turn, intentKind: "diagram" }, { ...turn, id: "t2", intentKind: "made-up" }] });
		expect(store.turns.map((item) => item.intentKind)).toEqual(["diagram", "freeform_text"]);
	});
});
