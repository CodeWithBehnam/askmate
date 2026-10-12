import { describe, expect, test } from "bun:test";
import { parseMcpImport, type McpServerState, type McpServerStatus, type TrustOutcome } from "../src/mcp";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import { EXAMPLE_SKILL_TEMPLATES, SkillService, createSkillScaffold, hashSkillText, type Skill, type SkillConfig, type SkillFileInfo, type SkillHost } from "../src/skills";
import type { McpServerConfig, McpSettings } from "../src/shared/types";
import type { PluginWave2Api } from "../src/ui/settings/connectionPage";
import {
	APPROVAL_LABELS,
	applyMcpImport,
	canRevokeTrust,
	chooseServerSecretId,
	checkServerCandidate,
	describeServerDeletion,
	describeServerState,
	describeTrustUnreachable,
	describeTestStatus,
	describeUnwipedSecrets,
	formatArgsText,
	isSensitiveName,
	newServer,
	ownedSecretIds,
	parseArgsText,
	planVariable,
	revokeServerTrust,
	runTrustAndTest,
	setToolAllowed,
	staticServerState,
	summarizeServerStatuses,
	transportLabel,
	wipeSecrets
} from "../src/ui/settings/mcpPage";
import {
	ancestorFolders,
	countSkills,
	describeSkillRow,
	diagramStyleOptions,
	diagramTypeOptions,
	planSkillFiles,
	skillStatusChip,
	toggleDisabledId
} from "../src/ui/settings/skillsPage";

// ---------------------------------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------------------------------

function makeSkillHost(files: Record<string, string>, trusted: Record<string, string> = {}, disabledIds: string[] = []): SkillHost {
	return {
		getConfig: (): SkillConfig => ({ enabled: true, folder: "AskMate/Skills", matchMode: "builtin-auto", disabledIds, trusted }),
		listFiles: async (): Promise<readonly SkillFileInfo[]> => Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
		readFile: async (path: string): Promise<string> => files[path] ?? "",
		parseYaml: (text: string): unknown => Bun.YAML.parse(text),
		saveTrust: async (): Promise<void> => undefined,
		watch: () => () => undefined
	};
}

const SKILL = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Explains ${name} clearly. Use when asked about ${name}.\n${extra}---\n# Goal\nExplain ${name}.\n`;

describe("skill rows", () => {
	test("a service with built-in and vault skills gives each the right status and chip", async () => {
		const reviewed = SKILL("reviewed");
		const files = {
			"AskMate/Skills/reviewed/SKILL.md": reviewed,
			"AskMate/Skills/fresh/SKILL.md": SKILL("fresh"),
			"AskMate/Skills/off/SKILL.md": SKILL("off"),
			"AskMate/Skills/broken/SKILL.md": "no frontmatter at all"
		};
		const service = new SkillService(makeSkillHost(files, { "vault:reviewed": await hashSkillText(reviewed) }, ["vault:off"]));
		await service.scan();
		const byName = new Map(service.list().map((skill) => [skill.name, skill]));
		const status = (name: string): string => service.statusOf(byName.get(name) as Skill);
		expect(status("mermaid-diagrams")).toBe("built-in");
		expect(status("reviewed")).toBe("ready");
		expect(status("fresh")).toBe("needs-review");
		expect(status("off")).toBe("disabled");
		const invalid = service.list().find((skill) => !skill.valid);
		expect(invalid).toBeDefined();
		expect(service.statusOf(invalid as Skill)).toBe("invalid");

		expect(skillStatusChip("built-in")).toEqual({ tone: "off", label: "Built-in" });
		expect(skillStatusChip("ready")).toEqual({ tone: "ready", label: "Ready" });
		expect(skillStatusChip("needs-review")).toEqual({ tone: "warning", label: "Needs review" });
		expect(skillStatusChip("disabled")).toEqual({ tone: "off", label: "Disabled" });
		expect(skillStatusChip("invalid")).toEqual({ tone: "error", label: "Invalid" });

		const counts = countSkills(service.list(), (skill) => service.statusOf(skill));
		expect(counts.needsReview).toBe(1);
		expect(counts.invalid).toBe(1);
		expect(counts.total).toBe(service.list().filter((skill) => skill.valid).length);
	});

	test("a row shows one sentence of the description and where the skill lives", async () => {
		const service = new SkillService(makeSkillHost({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") }));
		await service.scan();
		const skill = service.list().find((candidate) => candidate.name === "fresh") as Skill;
		const row = describeSkillRow(skill, service.statusOf(skill));
		expect(row.title).toBe("fresh");
		expect(row.desc).toBe("AskMate/Skills/fresh/SKILL.md · Explains fresh clearly.");
		const builtIn = service.list().find((candidate) => candidate.source === "built-in") as Skill;
		expect(describeSkillRow(builtIn, "built-in").desc).toStartWith("Built in · ");
	});

	test("an unreadable file says why instead of showing a description", async () => {
		const service = new SkillService(makeSkillHost({ "AskMate/Skills/broken/SKILL.md": "no frontmatter at all" }));
		await service.scan();
		const broken = service.list().find((skill) => !skill.valid) as Skill;
		const row = describeSkillRow(broken, "invalid");
		expect(row.title).toContain("AskMate/Skills/broken/SKILL.md");
		expect(row.desc.length).toBeGreaterThan(0);
	});

	test("switching a skill off adds its id once, and back on removes it", () => {
		expect(toggleDisabledId([], "vault:a", true)).toEqual(["vault:a"]);
		expect(toggleDisabledId(["vault:a"], "vault:a", true)).toEqual(["vault:a"]);
		expect(toggleDisabledId(["vault:a", "vault:b"], "vault:a", false)).toEqual(["vault:b"]);
	});
});

describe("skill files", () => {
	test("plans the examples under the skills folder and leaves existing ones alone", () => {
		const existing = new Set(["AskMate/Skills/meeting-minutes/SKILL.md"]);
		const plan = planSkillFiles("AskMate/Skills", EXAMPLE_SKILL_TEMPLATES, existing);
		expect(plan.skipped).toEqual(["Meeting minutes"]);
		expect(plan.create).toHaveLength(EXAMPLE_SKILL_TEMPLATES.length - 1);
		expect(plan.create.every((file) => file.path.startsWith("AskMate/Skills/") && file.path.endsWith("/SKILL.md"))).toBe(true);
	});

	test("a trailing slash on the folder does not double up", () => {
		const plan = planSkillFiles("Notes/Skills/", [createSkillScaffold("My skill", "")], new Set());
		expect(plan.create[0]?.path).toBe("Notes/Skills/my-skill/SKILL.md");
	});

	test("lists the folders above a file, outermost first", () => {
		expect(ancestorFolders("AskMate/Skills/my-skill/SKILL.md")).toEqual(["AskMate", "AskMate/Skills", "AskMate/Skills/my-skill"]);
		expect(ancestorFolders("SKILL.md")).toEqual([]);
	});

	test("a scaffold made by the editor can be approved as saved", async () => {
		const template = createSkillScaffold("Weekly notes", "Summarise the week.");
		const service = new SkillService(makeSkillHost({ [`AskMate/Skills/${template.path}`]: template.content }));
		await service.scan();
		const skill = service.list().find((candidate) => candidate.name === "weekly-notes") as Skill;
		expect(skill.valid).toBe(true);
		expect(skill.id).toBe(`vault:${template.id}`);
		expect(skill.hash).toBe(await hashSkillText(template.content));
	});
});

describe("diagram defaults", () => {
	test("offer automatic and every supported type under the stored lower-case slug", () => {
		const options = diagramTypeOptions();
		expect(options.auto).toBe("Choose from the note");
		expect(options.flowchart).toBe("Flowchart");
		expect(options.gitgraph).toBe("Git graph");
		expect(Object.keys(options).every((key) => key === key.toLowerCase())).toBe(true);
		const reloaded = normalizeAskMateSettings({ ...structuredClone(DEFAULT_SETTINGS), diagrams: { ...DEFAULT_SETTINGS.diagrams, defaultType: "gitgraph" } }, "load");
		expect(reloaded.diagrams.defaultType).toBe("gitgraph");
	});

	test("offer automatic and the named style recipes", () => {
		const options = diagramStyleOptions();
		expect(options.auto).toBe("A new look for each note");
		expect(options.blueprint).toBe("Blueprint");
		expect(options["editorial-ink"]).toBe("Editorial Ink");
		expect(Object.keys(options)).toHaveLength(9);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Tool servers
// ---------------------------------------------------------------------------------------------------------------------

const stdio = (patch: Partial<Extract<McpServerConfig, { transport: "stdio" }>> = {}): McpServerConfig => ({
	id: "files",
	label: "Files",
	enabled: true,
	approval: "always-ask",
	trustsAnnotations: false,
	trustedConfigHash: null,
	transport: "stdio",
	command: "npx",
	args: ["-y", "files-server"],
	env: {},
	...patch
});

const http = (patch: Partial<Extract<McpServerConfig, { transport: "http" }>> = {}): McpServerConfig => ({
	id: "web",
	label: "Web",
	enabled: true,
	approval: "always-ask",
	trustsAnnotations: false,
	trustedConfigHash: null,
	transport: "http",
	url: "https://example.com/mcp",
	headers: {},
	bearerSecretId: null,
	...patch
});

describe("server status chips", () => {
	test("every state has words and a tone", () => {
		const chip = (state: McpServerState): string => {
			const described = describeServerState(state);
			return `${described.tone}:${described.label}`;
		};
		expect(chip({ kind: "off" })).toBe("off:Off");
		expect(chip({ kind: "needs-trust" })).toBe("warning:Needs trust");
		expect(chip({ kind: "idle" })).toBe("off:Not started");
		expect(chip({ kind: "connecting" })).toBe("busy:Connecting");
		expect(chip({ kind: "ready", tools: 1, hidden: 0, era: "legacy", version: "2025-11-25", serverName: "x" })).toBe("ready:Ready, 1 tool");
		expect(chip({ kind: "ready", tools: 12, hidden: 3, era: "legacy", version: "2025-11-25", serverName: "x" })).toBe("ready:Ready, 12 tools");
		expect(chip({ kind: "needs-auth", hint: "Add a token." })).toBe("warning:Needs a token");
		expect(chip({ kind: "error", error: "transport", message: "ENOENT", fix: "Check the command." })).toBe("error:Error");
	});

	test("an error shows its message and the suggested fix", () => {
		const described = describeServerState({ kind: "error", error: "transport", message: "The connection failed.", fix: "Restart the server." });
		expect(described.detail).toBe("The connection failed. Restart the server.");
	});

	test("without a service an enabled valid server still needs trust, never shows as ready", () => {
		const mcp = { enabled: true };
		expect(staticServerState(mcp, stdio()).kind).toBe("needs-trust");
		expect(staticServerState({ enabled: false }, stdio()).kind).toBe("off");
		expect(staticServerState(mcp, stdio({ enabled: false })).kind).toBe("off");
		const invalid = staticServerState(mcp, stdio({ command: "" }));
		expect(invalid.kind).toBe("error");
	});

	test("counts servers that need attention, preferring the live status", () => {
		const mcp = { enabled: true, servers: [stdio(), http(), stdio({ id: "other" })] };
		const statuses: McpServerStatus[] = [
			{ id: "files", label: "Files", transport: "stdio", state: { kind: "ready", tools: 2, hidden: 0, era: "legacy", version: "x", serverName: "x" } },
			{ id: "web", label: "Web", transport: "http", state: { kind: "error", error: "transport", message: "down", fix: null } }
		];
		expect(summarizeServerStatuses(mcp, statuses)).toEqual({ total: 3, ready: 1, attention: 2 });
	});

	test("labels the two kinds of server", () => {
		expect(transportLabel("stdio")).toBe("Local program");
		expect(transportLabel("http")).toBe("Remote server");
		expect(Object.values(APPROVAL_LABELS)).toHaveLength(3);
	});
});

describe("new servers", () => {
	test("start switched off, asking every time, with no trust", () => {
		const server = newServer("stdio", { label: "Files", target: " npx " }, new Set());
		expect(server).toMatchObject({ id: "files", label: "Files", enabled: false, approval: "always-ask", trustsAnnotations: false, trustedConfigHash: null, transport: "stdio", command: "npx", args: [], env: {} });
	});

	test("a remote server starts with no headers and no token", () => {
		const server = newServer("http", { label: "Docs", target: "https://example.com/mcp" }, new Set());
		expect(server).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: {}, bearerSecretId: null, enabled: false });
	});

	test("an empty name falls back to the kind of server, and a taken id gets a counter", () => {
		const first = newServer("stdio", { label: "  ", target: "npx" }, new Set());
		expect(first.label).toBe("Local program");
		const second = newServer("stdio", { label: "", target: "npx" }, new Set([first.id]));
		expect(second.id).not.toBe(first.id);
		expect(newServer("http", { label: "", target: "https://a.example" }, new Set()).label).toBe("Remote server");
	});

	test("a long name is cut to what the loader keeps", () => {
		expect(newServer("stdio", { label: "x".repeat(100), target: "npx" }, new Set()).label).toHaveLength(60);
	});
});

describe("checkServerCandidate", () => {
	test("accepts a complete definition", () => {
		expect(checkServerCandidate(stdio())).toBeNull();
		expect(checkServerCandidate(http())).toBeNull();
	});

	test("refuses what the loader would drop, in plain words", () => {
		expect(checkServerCandidate(stdio({ command: "" }))).toBe("The command is missing, too long or spans several lines.");
		expect(checkServerCandidate(stdio({ command: "a\nb" }))).toContain("command");
		expect(checkServerCandidate(http({ url: "not a url" }))).toContain("https://");
		expect(checkServerCandidate(http({ url: "ftp://example.com" }))).toContain("https://");
		expect(checkServerCandidate(http({ url: "https://user:pass@example.com" }))).toContain("user name or password");
		expect(checkServerCandidate(http({ url: "https://example.com/mcp?api_key=1" }))).toContain("query string");
	});

	test("refuses a plain value the loader would strip because it looks like a credential", () => {
		expect(checkServerCandidate(stdio({ env: { NOTE: { kind: "plain", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } } }))).toContain("secret storage");
		expect(checkServerCandidate(stdio({ env: { API_TOKEN: { kind: "plain", value: "x" } } }))).toContain("secret storage");
		expect(checkServerCandidate(stdio({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } } }))).toBeNull();
	});

	test("keeps a remote plain http server, which the loader only switches off", () => {
		expect(checkServerCandidate(http({ url: "http://example.com/mcp" }))).toBeNull();
	});

	test("agrees with the loader: whatever it accepts is what a save keeps", () => {
		const candidates = [stdio(), http(), stdio({ command: "" }), http({ url: "nope" }), stdio({ env: { MODE: { kind: "plain", value: "fast" } } })];
		for (const candidate of candidates) {
			const kept = normalizeAskMateSettings({ ...structuredClone(DEFAULT_SETTINGS), mcp: { ...DEFAULT_SETTINGS.mcp, servers: [candidate] } }, "save").mcp.servers.length === 1;
			expect(checkServerCandidate(candidate) === null).toBe(kept);
		}
	});
});

describe("arguments", () => {
	test("one per line, ignoring blank lines and carriage returns", () => {
		expect(parseArgsText("-y\r\n\r\n@scope/server\n  spaced value  \n")).toEqual(["-y", "@scope/server", "  spaced value  "]);
		expect(formatArgsText(["-y", "server"])).toBe("-y\nserver");
		expect(parseArgsText(formatArgsText(["a", "b c"]))).toEqual(["a", "b c"]);
	});
});

describe("variables and headers", () => {
	const plan = (overrides: Partial<Parameters<typeof planVariable>[0]>): ReturnType<typeof planVariable> =>
		planVariable({ kind: "env", serverId: "files", name: "MODE", value: "fast", asSecret: false, ...overrides });

	test("keeps an ordinary value in the open", () => {
		expect(plan({})).toEqual({ ok: true, name: "MODE", value: { kind: "plain", value: "fast" }, secret: null, forcedSecret: false });
	});

	test("stores a secret in the keychain under a name made for this server", () => {
		const result = plan({ name: "API_TOKEN", value: "abc123", asSecret: true });
		expect(result).toEqual({
			ok: true,
			name: "API_TOKEN",
			value: { kind: "secret", secretId: "askmate-mcp-files-api-token" },
			secret: { id: "askmate-mcp-files-api-token", value: "abc123" },
			forcedSecret: false
		});
	});

	test("forces a secret for a credential-looking name or value, whatever was ticked", () => {
		const byName = plan({ name: "GITHUB_TOKEN", value: "x" });
		expect(byName.ok && byName.forcedSecret).toBe(true);
		expect(byName.ok && byName.value.kind).toBe("secret");
		const byValue = plan({ name: "NOTE", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
		expect(byValue.ok && byValue.forcedSecret).toBe(true);
	});

	test("refuses a bad name or an empty value with a plain reason", () => {
		expect(plan({ name: "" })).toEqual({ ok: false, message: "Enter a variable name." });
		expect(plan({ name: "1BAD" }).ok).toBe(false);
		expect(plan({ value: "" })).toEqual({ ok: false, message: "Enter a value for MODE." });
		expect(plan({ kind: "header", name: "Host", value: "x" }).ok).toBe(false);
		expect(plan({ kind: "header", name: "X-Mode", value: "a\nb" }).ok).toBe(false);
		expect(plan({ kind: "header", name: "X-Mode", value: "fine" }).ok).toBe(true);
	});

	test("anything stored this way loads again unchanged", () => {
		const secret = plan({ name: "API_TOKEN", value: "abc123", asSecret: true });
		const plain = plan({});
		expect(secret.ok && plain.ok).toBe(true);
		if (secret.ok && plain.ok) {
			const server = stdio({ env: { [secret.name]: secret.value, [plain.name]: plain.value } });
			const reloaded = normalizeAskMateSettings({ ...structuredClone(DEFAULT_SETTINGS), mcp: { ...DEFAULT_SETTINGS.mcp, servers: [server] } }, "load");
			expect(reloaded.mcp.servers[0]).toEqual(server);
		}
	});

	test("recognises credential-like names", () => {
		for (const name of ["API_KEY", "token", "Authorization", "SESSION_ID", "client_secret", "PASSWORD"]) {
			expect(isSensitiveName(name)).toBe(true);
		}
		expect(isSensitiveName("MODE")).toBe(false);
	});
});

describe("secret ids", () => {
	test("reuses an id made for this server and never touches any other", () => {
		expect(chooseServerSecretId("web", "token", "askmate-mcp-web-token")).toBe("askmate-mcp-web-token");
		expect(chooseServerSecretId("web", "token", undefined)).toBe("askmate-mcp-web-token");
		// The provider key and another server's secret are not this server's to overwrite.
		expect(chooseServerSecretId("web", "token", "askmate-openai-key")).toBe("askmate-mcp-web-token");
		expect(chooseServerSecretId("web", "token", "askmate-mcp-other-token")).toBe("askmate-mcp-web-token");
	});

	test("lists only the secrets AskMate made for a server, so a delete wipes nothing else", () => {
		const server = http({
			bearerSecretId: "askmate-mcp-web-token",
			headers: { "X-One": { kind: "secret", secretId: "askmate-mcp-web-x-one" }, "X-Two": { kind: "secret", secretId: "askmate-openai-key" }, "X-Three": { kind: "plain", value: "v" } }
		});
		expect(ownedSecretIds(server).sort()).toEqual(["askmate-mcp-web-token", "askmate-mcp-web-x-one"]);
		expect(ownedSecretIds(stdio({ env: { A: { kind: "secret", secretId: "askmate-mcp-files-a" }, B: { kind: "secret", secretId: "someone-elses" } } }))).toEqual(["askmate-mcp-files-a"]);
	});
});

describe("revoking trust and deleting a server", () => {
	const service = (calls: string[]): NonNullable<PluginWave2Api["mcpService"]> => ({
		revokeTrust: async (id: string): Promise<void> => {
			calls.push(`service:${id}`);
		}
	}) as never;

	test("asks the running service first", async () => {
		const calls: string[] = [];
		const reach = { mcpService: service(calls), revokeMcpTrust: async (id: string): Promise<void> => { calls.push(`plugin:${id}`); } };
		expect(canRevokeTrust(reach)).toBe(true);
		expect(await revokeServerTrust(reach, "files")).toBe(true);
		expect(calls).toEqual(["service:files"]);
	});

	test("falls back to the plugin's own path while tools are off", async () => {
		const calls: string[] = [];
		const reach = { mcpService: null, revokeMcpTrust: async (id: string): Promise<void> => { calls.push(`plugin:${id}`); } };
		expect(canRevokeTrust(reach)).toBe(true);
		expect(await revokeServerTrust(reach, "files")).toBe(true);
		expect(calls).toEqual(["plugin:files"]);
	});

	test("says nothing was revoked when neither path exists", async () => {
		for (const reach of [{}, { mcpService: null }]) {
			expect(canRevokeTrust(reach)).toBe(false);
			expect(await revokeServerTrust(reach, "files")).toBe(false);
		}
	});

	test("keeps `this` when it calls the plugin's own path", async () => {
		const plugin = {
			seen: [] as string[],
			async revokeMcpTrust(id: string): Promise<void> {
				this.seen.push(id);
			}
		};
		expect(await revokeServerTrust(plugin, "files")).toBe(true);
		expect(plugin.seen).toEqual(["files"]);
	});

	test("lets a failure from the trust record reach the caller", async () => {
		const reach = { mcpService: null, revokeMcpTrust: async (): Promise<void> => { throw new Error("storage is unavailable"); } };
		await expect(revokeServerTrust(reach, "files")).rejects.toThrow("storage is unavailable");
	});

	test("the delete question only mentions trust when it cannot be cleared", () => {
		expect(describeServerDeletion("Files", { canRevoke: true, toolsEnabled: false })).toBe("Delete the server \"Files\"? AskMate also wipes the secrets it stored for this server. The program or service itself is not touched.");
		expect(describeServerDeletion("Files", { canRevoke: false, toolsEnabled: false })).toContain("Tools are off, so AskMate cannot clear any trust you gave it on this device.");
	});

	test("on a device that cannot run tools the advice is not to turn tools on", () => {
		expect(describeServerDeletion("Files", { canRevoke: false, toolsEnabled: true })).toContain("Tools do not run on this device");
		expect(describeServerDeletion("Files", { canRevoke: false, toolsEnabled: true })).not.toContain("turn on tools");
		expect(describeTrustUnreachable(true)).toContain("Tools do not run on this device");
		expect(describeTrustUnreachable(true)).not.toContain("Turn on tools");
		expect(describeTrustUnreachable(false)).toBe("Tools are off, so AskMate cannot reach the trust it keeps on this device. Turn on tools, then revoke trust.");
	});

	test("wipes every secret it can and returns the ones that refused", () => {
		const wiped: string[] = [];
		const failed = wipeSecrets((id) => {
			if (id === "b") {
				throw new Error("locked");
			}
			wiped.push(id);
		}, ["a", "b", "c"]);
		expect(wiped).toEqual(["a", "c"]);
		expect(failed).toEqual(["b"]);
		expect(wipeSecrets(() => undefined, [])).toEqual([]);
	});

	test("names the unwiped secrets and where to remove them, or says nothing when all were wiped", () => {
		expect(describeUnwipedSecrets("Files", [])).toBeNull();
		expect(describeUnwipedSecrets("Files", ["askmate-mcp-files-token"])).toBe("Deleted \"Files\", but AskMate could not wipe 1 stored secret: askmate-mcp-files-token. Remove it from the keychain in Obsidian's settings.");
		expect(describeUnwipedSecrets("Files", ["a-one", "a-two"])).toContain("2 stored secrets: a-one, a-two. Remove them");
	});
});

describe("per-tool permissions", () => {
	test("turning a tool off lists it once, and back on removes it", () => {
		expect(setToolAllowed(undefined, "read", false)).toEqual(["read"]);
		expect(setToolAllowed(["read"], "read", false)).toEqual(["read"]);
		expect(setToolAllowed(["read", "write"], "read", true)).toEqual(["write"]);
	});
});

describe("import", () => {
	const claudeStyle = JSON.stringify({
		mcpServers: {
			github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", MODE: "fast" } },
			docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret-token-value" } }
		}
	});
	const emptyMcp: McpSettings = structuredClone(DEFAULT_SETTINGS.mcp);

	test("adds the servers switched off, with no trust and their secrets set aside", () => {
		const result = parseMcpImport(claudeStyle, new Set());
		const applied = applyMcpImport(emptyMcp, result);
		expect(applied.added).toBe(2);
		expect(applied.mcp.servers.every((server) => !server.enabled && server.trustedConfigHash === null && !server.trustsAnnotations)).toBe(true);
		expect(applied.mcp.servers.every((server) => server.approval === "always-ask")).toBe(true);
		expect(applied.secrets.map((secret) => secret.value).sort()).toEqual(["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "secret-token-value"]);
		// The token never reaches the saved definitions.
		expect(JSON.stringify(applied.mcp)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(JSON.stringify(applied.mcp)).not.toContain("secret-token-value");
	});

	test("keeps the master switch and existing servers as they were", () => {
		const existing: McpSettings = { ...emptyMcp, enabled: true, servers: [stdio()] };
		const applied = applyMcpImport(existing, parseMcpImport(claudeStyle, new Set(["files"])));
		expect(applied.mcp.enabled).toBe(true);
		expect(applied.mcp.servers[0]).toEqual(existing.servers[0]);
		expect(applied.mcp.servers).toHaveLength(3);
	});

	test("what is imported loads again unchanged", () => {
		const applied = applyMcpImport(emptyMcp, parseMcpImport(claudeStyle, new Set()));
		const reloaded = normalizeAskMateSettings({ ...structuredClone(DEFAULT_SETTINGS), mcp: applied.mcp }, "load");
		expect(reloaded.mcp.servers).toEqual(applied.mcp.servers);
	});

	test("an import that finds nothing adds nothing", () => {
		expect(applyMcpImport(emptyMcp, parseMcpImport("not json", new Set())).added).toBe(0);
		expect(applyMcpImport(emptyMcp, parseMcpImport("{\"mcpServers\":{}}", new Set())).added).toBe(0);
	});
});

describe("trust and test", () => {
	function fakeService(outcome: TrustOutcome, status: McpServerStatus | null) {
		const calls: string[] = [];
		return {
			calls,
			trust: async (id: string): Promise<TrustOutcome> => {
				calls.push(`trust:${id}`);
				return outcome;
			},
			testConnection: async (id: string): Promise<McpServerStatus | null> => {
				calls.push(`test:${id}`);
				return status;
			}
		};
	}
	const ready: McpServerStatus = { id: "files", label: "Files", transport: "stdio", state: { kind: "ready", tools: 3, hidden: 0, era: "legacy", version: "2025-11-25", serverName: "Files" } };
	const errorStatus: McpServerStatus = { id: "files", label: "Files", transport: "stdio", state: { kind: "error", error: "transport", message: "The connection failed.", fix: "Check the command." } };
	const run = (service: ReturnType<typeof fakeService>, server: McpServerConfig, enabled = true, enable: () => Promise<void> = async () => undefined) =>
		runTrustAndTest({ service, mcp: { enabled }, server, enable, errorMessage: (error) => (error instanceof Error ? error.message : String(error)) });

	test("starts nothing while tools are off", async () => {
		const service = fakeService({ kind: "trusted" }, ready);
		const result = await run(service, stdio(), false);
		expect(result.kind).toBe("tools-off");
		expect(service.calls).toEqual([]);
	});

	test("starts nothing for a definition that is not valid", async () => {
		const service = fakeService({ kind: "trusted" }, ready);
		const result = await run(service, stdio({ command: "" }));
		expect(result.kind).toBe("invalid");
		expect(service.calls).toEqual([]);
	});

	test("a declined trust dialog starts and enables nothing", async () => {
		const service = fakeService({ kind: "declined" }, ready);
		let enabled = false;
		const result = await run(service, stdio({ enabled: false }), true, async () => {
			enabled = true;
		});
		expect(result).toEqual({ kind: "declined", message: "Not trusted, so the server was not started." });
		expect(service.calls).toEqual(["trust:files"]);
		expect(enabled).toBe(false);
	});

	test("trusting a server that was off turns it on, then tests it", async () => {
		const service = fakeService({ kind: "trusted" }, ready);
		const order: string[] = [];
		const result = await run(service, stdio({ enabled: false }), true, async () => {
			order.push("enable");
		});
		expect(service.calls).toEqual(["trust:files", "test:files"]);
		expect(order).toEqual(["enable"]);
		expect(result.kind === "tested" && result.ready).toBe(true);
		expect(result.message).toBe("Ready, 3 tools.");
	});

	test("a server that is already on is not switched again", async () => {
		const service = fakeService({ kind: "trusted" }, ready);
		let enableCalls = 0;
		await run(service, stdio(), true, async () => {
			enableCalls += 1;
		});
		expect(enableCalls).toBe(0);
	});

	test("a failed start says what went wrong and is not ready", async () => {
		const result = await run(fakeService({ kind: "trusted" }, errorStatus), stdio());
		expect(result.kind === "tested" && result.ready).toBe(false);
		expect(result.message).toBe("Error. The connection failed. Check the command.");
	});

	test("a thrown error becomes a message instead of escaping", async () => {
		const service = {
			trust: async (): Promise<TrustOutcome> => {
				throw new Error("dialog crashed");
			},
			testConnection: async (): Promise<McpServerStatus | null> => null
		};
		const result = await runTrustAndTest({ service, mcp: { enabled: true }, server: stdio(), enable: async () => undefined, errorMessage: (error) => String(error instanceof Error ? error.message : error) });
		expect(result).toEqual({ kind: "failed", message: "dialog crashed" });
	});

	test("describes a server that vanished", () => {
		expect(describeTestStatus(null)).toEqual({ ready: false, message: "That server no longer exists." });
	});
});
