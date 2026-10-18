import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ToolApprovalCard as McpApprovalCard, TrustRequest } from "../src/mcp";
import { listFolderFiles } from "../src/plugin/folderFiles";
import { McpApprovalRouter, createDeviceTrustStore, createHttpRequest, toApprovalDialogInput } from "../src/plugin/mcpHost";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import type { EvidenceSource } from "../src/shared/types";
import { createFakeApp, FakeEditor, leafFor, type FakeApp, type Position } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";
import { MarkdownView, Modal, Notice } from "./support/obsidian-fakes";

let restoreDom: () => void;

beforeAll(() => {
	restoreDom = installDomGlobals();
});

afterAll(() => {
	restoreDom();
});

beforeEach(() => {
	Notice.clear();
});

interface TestPlugin extends AskMatePlugin {
	storedData: unknown;
}

async function loadPlugin(stored: unknown = {}): Promise<{ plugin: TestPlugin; fake: FakeApp }> {
	const fake = createFakeApp();
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
	plugin.storedData = stored;
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake };
}

function hostCard(overrides: Partial<McpApprovalCard> = {}): McpApprovalCard {
	return {
		serverId: "notes",
		serverLabel: "Notes server",
		toolName: "search",
		toolTitle: "Search notes",
		argumentsText: "{\n  \"q\": \"roadmap\"\n}",
		warnings: [],
		description: "Finds notes",
		reason: "mode",
		changedSinceApproval: false,
		mode: "always-ask",
		canAllowForChat: true,
		claimsReadOnly: false,
		...overrides
	};
}

describe("McpApprovalRouter", () => {
	test("hands the card to whoever started the run, with the full arguments", async () => {
		const router = new McpApprovalRouter();
		const controller = new AbortController();
		const seen: string[] = [];
		router.register(controller.signal, (card) => {
			seen.push(`${card.server}/${card.tool}/${card.argumentsJson}/${String(card.canAllowForChat)}`);
			return Promise.resolve("allow-chat");
		});

		expect(await router.confirm(hostCard(), controller.signal)).toBe("allow-chat");
		expect(seen).toEqual(["Notes server/search/{\n  \"q\": \"roadmap\"\n}/true"]);
	});

	test("a call with nobody to ask, or after the handler is removed, is refused", async () => {
		const router = new McpApprovalRouter();
		const controller = new AbortController();
		expect(await router.confirm(hostCard(), controller.signal)).toBe("deny");
		const unregister = router.register(controller.signal, () => Promise.resolve("allow-once"));
		unregister();
		expect(await router.confirm(hostCard(), controller.signal)).toBe("deny");
	});

	test("two runs never see each other's cards", async () => {
		const router = new McpApprovalRouter();
		const one = new AbortController();
		const two = new AbortController();
		router.register(one.signal, () => Promise.resolve("allow-once"));
		router.register(two.signal, () => Promise.resolve("deny"));

		expect(await router.confirm(hostCard(), one.signal)).toBe("allow-once");
		expect(await router.confirm(hostCard(), two.signal)).toBe("deny");
	});

	test("Stop while the card is open refuses the call, and a stray answer is not consent", async () => {
		const router = new McpApprovalRouter();
		const controller = new AbortController();
		router.register(controller.signal, () => new Promise(() => undefined));
		const pending = router.confirm(hostCard(), controller.signal);
		controller.abort();
		expect(await pending).toBe("deny");

		const other = new AbortController();
		router.register(other.signal, () => Promise.resolve("maybe" as never));
		expect(await router.confirm(hostCard(), other.signal)).toBe("deny");
	});
});

describe("host adapters", () => {
	test("device trust is stored in the device's local storage under its own prefix", () => {
		const fake = createFakeApp();
		const store = createDeviceTrustStore(fake.app as never);

		expect(store.get("server:a")).toBeNull();
		store.set("server:a", "hash-1");
		expect(store.get("server:a")).toBe("hash-1");
		expect(fake.localStorage.get("askmate-mcp-trust:server:a")).toBe("hash-1");
		store.remove("server:a");
		expect(store.get("server:a")).toBeNull();
	});

	test("HTTP replies carry lower-case header names", async () => {
		const send = createHttpRequest((params) => Promise.resolve({ status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "s" }, text: params.body ?? "" }));
		const response = await send({ url: "https://example.test/mcp", method: "POST", headers: { Accept: "application/json" }, body: "{}" });

		expect(response.headers).toEqual({ "content-type": "application/json", "mcp-session-id": "s" });
		expect(response.status).toBe(200);
		expect(response.text).toBe("{}");
	});

	test("the trust dialog is the dedicated one: it names the exact command and spells out characters nobody can see", async () => {
		const { plugin } = await loadPlugin();
		const request: TrustRequest = {
			transport: "stdio",
			serverId: "files",
			label: "Files",
			reason: "first-use",
			commandLine: `npx${"\u200B"} -y some-server --root /tmp`,
			command: "npx",
			args: ["-y", "some-server"],
			env: [{ name: "TOKEN", value: "", secret: true, secretId: "askmate-mcp-files-token" }, { name: "MODE", value: "read", secret: false, secretId: null }],
			risks: ["It uses a stored secret that AskMate did not create for MCP."]
		};

		const answer = plugin.mcpPrompts.confirmTrust(request);
		const modal = Modal.opened.at(-1);
		const text = modal?.contentEl.textContent ?? "";

		expect(modal?.titleEl.textContent).toBe("Trust this local server?");
		expect(text).toContain("npx[U+200B] -y some-server --root /tmp");
		expect(text).toContain("TOKEN = stored secret \"askmate-mcp-files-token\"");
		expect(text).toContain("MODE = read");
		expect(text).toContain("It uses a stored secret");
		expect(text).toContain("characters you cannot normally see");
		expect(Array.from(modal?.contentEl.querySelectorAll("button") ?? []).map((button) => button.textContent)).toEqual(["Cancel", "Trust and start"]);

		modal?.contentEl.querySelector<HTMLElement>("button.mod-cta")?.click();
		expect(await answer).toBe(true);
	});

	test("closing the trust dialog without choosing answers no", async () => {
		const { plugin } = await loadPlugin();
		const answer = plugin.mcpPrompts.confirmTrust({
			transport: "http", serverId: "w", label: "Web", reason: "changed", url: "https://tools.example.com/mcp", host: "tools.example.com",
			headerNames: ["X-Key"], hasBearerToken: true, bearerSecretId: "askmate-mcp-web-token", secretHeaders: [], risks: []
		});
		const modal = Modal.opened.at(-1);
		expect(modal?.titleEl.textContent).toBe("Trust the changed remote server?");
		expect(modal?.contentEl.textContent).toContain("askmate-mcp-web-token");

		modal?.close();

		expect(await answer).toBe(false);
	});

	test("a run without an inline approval card asks in the one approval dialog, with the exact arguments", async () => {
		const card = { id: "c1", server: "Notes server", tool: "search", title: "Search notes", description: "Looks up notes.", argumentsJson: "{\n  \"q\": \"a\u200Bb\"\n}", changedSinceApproval: false, canAllowForChat: true };
		expect(toApprovalDialogInput(card)).toEqual({
			serverLabel: "Notes server", toolName: "search", toolTitle: "Search notes", argumentsText: card.argumentsJson,
			description: "Looks up notes.", changedSinceApproval: false, canAllowForChat: true
		});
		expect(toApprovalDialogInput({ id: "c2", server: "S", tool: "t", argumentsJson: "{}", changedSinceApproval: true })).toEqual({
			serverLabel: "S", toolName: "t", argumentsText: "{}", changedSinceApproval: true, canAllowForChat: false
		});

		const { plugin } = await loadPlugin({ mcp: { enabled: true, servers: [] } });
		const controller = new AbortController();
		const choice = plugin.confirmToolCall(card, controller.signal);
		const modal = Modal.opened.at(-1);
		expect(modal?.titleEl.textContent).toBe("Allow this tool call?");
		expect(modal?.contentEl.textContent).toContain("a[U+200B]b");
		controller.abort();
		expect(await choice).toBe("deny");
	});
});

describe("MCP in the plugin", () => {
	test("trusting a server asks first, and the trust lands on this device only", async () => {
		const { plugin, fake } = await loadPlugin({
			mcp: {
				enabled: true,
				servers: [{ id: "web", label: "Web tools", enabled: true, approval: "always-ask", trustsAnnotations: false, transport: "http", url: "https://tools.example.com/mcp", headers: {}, bearerSecretId: null, trustedConfigHash: null }]
			}
		});
		const service = plugin.mcpService;
		expect(service?.status().map((server) => server.state.kind)).toEqual(["needs-trust"]);

		const seen: string[] = [];
		const timer = setInterval(() => {
			for (const modal of [...Modal.opened]) {
				seen.push(modal.contentEl.textContent ?? "");
				modal.contentEl.querySelector<HTMLElement>("button.mod-cta")?.click();
			}
		}, 1);
		const outcome = await service?.trust("web");
		clearInterval(timer);

		expect(outcome?.kind).toBe("trusted");
		expect(seen.join(" ")).toContain("https://tools.example.com/mcp");
		expect([...fake.localStorage.keys()].some((key) => key.startsWith("askmate-mcp-trust:"))).toBe(true);
		expect(JSON.stringify(plugin.storedData)).not.toContain("askmate-mcp-trust");
	});

	test("quitting Obsidian stops the MCP servers and saves the conversation still waiting to be written", async () => {
		const { plugin, fake } = await loadPlugin({ mcp: { enabled: true, servers: [WEB_SERVER] } });
		const service = plugin.mcpService;
		let stopped = 0;
		Object.assign(service ?? {}, { shutdown: () => {
			stopped += 1;
			return Promise.resolve();
		} });
		plugin.threads.scheduleSave({ id: "t1", title: "Waiting", autoTitle: true, createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", messages: [{ role: "user", text: "Waiting", createdAt: "2026-10-01T09:00:00.000Z" }] });
		const tasks: Array<() => Promise<void>> = [];

		fake.workspace.trigger("quit", { add: (task: () => Promise<void>) => tasks.push(task) });
		expect(tasks).toHaveLength(1);
		await Promise.all(tasks.map((task) => task()));

		expect(stopped).toBe(1);
		expect((plugin.storedData as { threadStore: { threads: Array<{ id: string }> } }).threadStore.threads.map((thread) => thread.id)).toEqual(["t1"]);
	});

	test("with MCP off nothing is created and nothing can start", async () => {
		const { plugin } = await loadPlugin({});
		expect(plugin.mcpService).toBeNull();
	});

	const WEB_SERVER = { id: "web", label: "Web tools", enabled: true, approval: "always-ask", trustsAnnotations: false, transport: "http", url: "https://tools.example.com/mcp", headers: {}, bearerSecretId: null, trustedConfigHash: null };

	test("revokeMcpTrust forgets trust while tools are off and no service exists", async () => {
		const { plugin, fake } = await loadPlugin({});
		expect(plugin.mcpService).toBeNull();
		fake.localStorage.set("askmate-mcp-trust:server:web", "hash-1");
		fake.localStorage.set("askmate-mcp-trust:server:other", "hash-2");

		await plugin.revokeMcpTrust("web");

		expect(fake.localStorage.has("askmate-mcp-trust:server:web")).toBe(false);
		// Only the named server is touched.
		expect(fake.localStorage.get("askmate-mcp-trust:server:other")).toBe("hash-2");
	});

	test("revokeMcpTrust clears trust that was given while tools were on, so the server asks again when they come back", async () => {
		const { plugin, fake } = await loadPlugin({ mcp: { enabled: true, servers: [WEB_SERVER] } });
		const timer = setInterval(() => {
			for (const modal of [...Modal.opened]) {
				modal.contentEl.querySelector<HTMLElement>("button.mod-cta")?.click();
			}
		}, 1);
		await plugin.mcpService?.trust("web");
		clearInterval(timer);
		expect([...fake.localStorage.keys()].some((key) => key.startsWith("askmate-mcp-trust:"))).toBe(true);

		// Tools are switched off, which is the default state, so the page has no service to ask.
		plugin.settings.mcp.enabled = false;
		expect(plugin.mcpService).toBeNull();
		await plugin.revokeMcpTrust("web");

		expect([...fake.localStorage.keys()].some((key) => key.startsWith("askmate-mcp-trust:"))).toBe(false);
		plugin.settings.mcp.enabled = true;
		expect(plugin.mcpService?.status().map((server) => server.state.kind)).toEqual(["needs-trust"]);
	});

	test("revokeMcpTrust with tools on goes through the service, which also tells listeners", async () => {
		const { plugin, fake } = await loadPlugin({ mcp: { enabled: true, servers: [WEB_SERVER] } });
		const service = plugin.mcpService;
		fake.localStorage.set("askmate-mcp-trust:server:web", "hash-1");
		let changes = 0;
		service?.onStatusChange(() => {
			changes += 1;
		});

		await plugin.revokeMcpTrust("web");

		expect(fake.localStorage.has("askmate-mcp-trust:server:web")).toBe(false);
		expect(changes).toBeGreaterThan(0);
	});

	test("revoking trust for a server that was never trusted is not an error", async () => {
		const { plugin } = await loadPlugin({});
		await expect(plugin.revokeMcpTrust("never-seen")).resolves.toBeUndefined();
	});
});

describe("skills in the plugin", () => {
	const SKILL = "---\nname: note-tidy\ndescription: Tidies a note by merging duplicate headings.\n---\n\nMerge duplicate headings and keep the order.\n";

	test("a vault skill is listed, needs review, and approval is stored in settings", async () => {
		const { plugin, fake } = await loadPlugin({});
		fake.vault.add("AskMate/Skills/note-tidy/SKILL.md", SKILL);
		await plugin.skillService.scan();

		const skill = plugin.skillService.get("vault:note-tidy");
		expect(skill?.valid).toBe(true);
		expect(skill && plugin.skillService.statusOf(skill)).toBe("needs-review");

		await plugin.skillService.trust("vault:note-tidy", skill?.hash ?? "");

		expect(plugin.settings.skills.trustedHashes["vault:note-tidy"]).toBe(skill?.hash ?? "");
		expect((plugin.storedData as { skills: { trustedHashes: Record<string, string> } }).skills.trustedHashes["vault:note-tidy"]).toBe(skill?.hash ?? "");
		expect(plugin.skillService.statusOf(skill ?? plugin.skillService.list()[0])).toBe("ready");
	});

	test("the settings tab redraws when the catalogue changes, so its Skills page does not keep the empty first list", async () => {
		const { plugin } = await loadPlugin({});
		const tab = Reflect.get(plugin, "settingTab") as { updateCount: number };
		const before = tab.updateCount;
		await plugin.skillService.scan();
		expect(plugin.skillService.list().length).toBeGreaterThan(0);
		expect(tab.updateCount).toBeGreaterThan(before);
	});

	test("the scan reads the skills folder itself and never lists the vault", async () => {
		const { plugin, fake } = await loadPlugin({});
		fake.vault.add("AskMate/Skills/note-tidy/SKILL.md", SKILL);
		fake.vault.add("AskMate/Skills/note-tidy/refs/deep/example.md", "an example");
		fake.vault.add("Elsewhere/other.md", "not a skill");
		const refuse = (): never => {
			throw new Error("the whole vault was listed");
		};
		Object.assign(fake.vault, { getFiles: refuse, getMarkdownFiles: refuse, getAllLoadedFiles: refuse });

		await plugin.skillService.scan();

		expect(plugin.skillService.get("vault:note-tidy")?.valid).toBe(true);
		expect(plugin.skillService.list().filter((skill) => skill.source === "vault")).toHaveLength(1);
	});

	test("every file below the folder is listed with its size, however deep, and a missing folder gives nothing", async () => {
		const { fake } = await loadPlugin({});
		fake.vault.add("AskMate/Skills/a/SKILL.md", "12345");
		fake.vault.add("AskMate/Skills/a/refs/deep/x.md", "123");
		fake.vault.add("AskMate/Skills/b.md", "1");
		fake.vault.add("AskMate/Other/c.md", "1");

		const listed = listFolderFiles(fake.vault.getFolderByPath("AskMate/Skills"));

		expect(listed.map((file) => file.path).sort()).toEqual(["AskMate/Skills/a/SKILL.md", "AskMate/Skills/a/refs/deep/x.md", "AskMate/Skills/b.md"]);
		expect(listed.find((file) => file.path.endsWith("x.md"))?.size).toBe(fake.vault.getFileByPath("AskMate/Skills/a/refs/deep/x.md")?.stat.size);
		expect(listFolderFiles(fake.vault.getFolderByPath("AskMate/Nothing"))).toEqual([]);
		expect(listFolderFiles(null)).toEqual([]);
	});

	test("changing the skills folder in settings scans the new folder", async () => {
		const { plugin, fake } = await loadPlugin({});
		fake.vault.add("My skills/tidy.md", SKILL);
		plugin.settings.skills.folder = "My skills";
		await plugin.saveSettings();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(plugin.skillService.list().map((skill) => skill.id)).toContain("vault:note-tidy");
	});
});

/** Just enough editor for the evidence jump: lines, a selection and a scroll. */
class JumpEditor extends FakeEditor {
	selection: { from: Position; to: Position } | null = null;

	lastLine(): number {
		return this.value.split("\n").length - 1;
	}

	getLine(line: number): string {
		return this.value.split("\n")[line] ?? "";
	}

	setSelection(from: Position, to: Position): void {
		this.selection = { from, to };
	}

	scrollIntoView(): void {
		return undefined;
	}
}

describe("opening an evidence source", () => {
	const SOURCE: EvidenceSource = { id: "S1", sourcePath: "Notes/Evidence.md", title: "Evidence", lineStart: 3, lineEnd: 4, excerpt: "x" } as unknown as EvidenceSource;

	test("a tab restored at start-up is matched by its file, loaded, and shown without replacing the note being read", async () => {
		const { plugin, fake } = await loadPlugin({});
		fake.vault.add("Notes/Evidence.md", "one\ntwo\nthree\nfour\nfive");
		fake.vault.add("Notes/Reading.md", "reading");
		const editor = new JumpEditor("one\ntwo\nthree\nfour\nfive");
		const view = new MarkdownView(editor, fake.vault.getFileByPath("Notes/Evidence.md"));
		const deferred = Object.assign(leafFor({ placeholder: true }, "markdown", "Notes/Evidence.md"), {
			view: { placeholder: true } as unknown,
			loadIfDeferred: () => {
				deferred.view = view;
				return Promise.resolve();
			},
			getViewState: () => ({ type: "markdown", state: { file: "Notes/Evidence.md", mode: "source" } })
		});
		fake.workspace.leaves.push(deferred);
		const calls: string[] = [];
		Object.assign(fake.workspace, {
			revealLeaf: () => Promise.resolve(),
			getLeaf: () => {
				calls.push("getLeaf");
				return {};
			}
		});

		await plugin.openEvidenceSource(SOURCE);

		expect(calls).toEqual([]);
		expect(editor.selection?.from.line).toBe(2);
		expect(editor.selection?.to.line).toBe(3);
	});

	test("a note that is not open is shown in a new tab, in editing mode, at the evidence line", async () => {
		const { plugin, fake } = await loadPlugin({});
		const file = fake.vault.add("Notes/Evidence.md", "one\ntwo\nthree\nfour\nfive");
		const opened: Array<{ path: string; state: unknown }> = [];
		const kinds: unknown[] = [];
		Object.assign(fake.workspace, {
			revealLeaf: () => Promise.resolve(),
			getLeaf: (kind: unknown) => {
				kinds.push(kind);
				return {
					view: null,
					openFile: (target: { path: string }, state: unknown) => {
						opened.push({ path: target.path, state });
						return Promise.resolve();
					}
				};
			}
		});

		await plugin.openEvidenceSource(SOURCE);

		expect(file.path).toBe("Notes/Evidence.md");
		expect(kinds).toEqual(["tab"]);
		expect(opened).toEqual([{ path: "Notes/Evidence.md", state: { state: { mode: "source" }, eState: { line: 2 } } }]);
	});
});
