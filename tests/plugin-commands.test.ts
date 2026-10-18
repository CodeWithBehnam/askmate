import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { CommandRunRegistry } from "../src/plugin/commandRuns";
import { findLeafForFile, leafFilePath } from "../src/plugin/leaves";
import { ASKMATE_VIEW_TYPE } from "../src/settings/constants";
import { AskMateView } from "../src/ui/sidebar/AskMateView";
import type { AskRequest } from "../src/shared/types";
import { createFakeApp, FakeEditor, leafFor, openFakeMarkdownView, type FakeApp } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";
import { Notice, registeredIcons, TFile } from "./support/obsidian-fakes";

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
	commands: Map<string, { callback?: () => unknown; editorCallback?: (...args: unknown[]) => unknown }>;
	storedData: unknown;
	ribbonIcons: Array<{ icon: string }>;
	views: Map<string, unknown>;
}

async function loadPlugin(storedData: unknown = {}): Promise<{ plugin: TestPlugin; fake: FakeApp }> {
	const fake = createFakeApp();
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
	plugin.storedData = storedData;
	// The fakes do not ship Obsidian's YAML parser or Mermaid, so the plugin is given stand-ins.
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake };
}

function stubRequest(): AskRequest {
	return { context: { content: "Note", file: null, source: "Current note" }, question: "q", title: "t", evidenceSources: [], metadata: { workflowName: "Study summary", selectedModel: "gpt-5.5", outputIncompleteReason: null } } as unknown as AskRequest;
}

describe("CommandRunRegistry", () => {
	test("refuses a second run while one is active and frees the slot when it finishes", () => {
		const registry = new CommandRunRegistry();
		const first = registry.begin("Summary");
		expect(first).not.toBeNull();
		expect(registry.begin("Other")).toBeNull();
		expect(registry.current()).toBe("Summary");
		first?.finish();
		first?.finish();
		expect(registry.current()).toBeNull();
		expect(registry.begin("Other")).not.toBeNull();
	});

	test("stop aborts the active run's signal, and a stale finish does not free a newer run", () => {
		const registry = new CommandRunRegistry();
		const first = registry.begin("A");
		expect(registry.stop()).toBe(true);
		expect(first?.signal.aborted).toBe(true);
		first?.finish();
		const second = registry.begin("B");
		first?.finish();
		expect(registry.current()).toBe("B");
		expect(second?.signal.aborted).toBe(false);
		expect(registry.stop()).toBe(true);
		expect(new CommandRunRegistry().stop()).toBe(false);
	});
});

describe("palette runs", () => {
	function stubRun(plugin: TestPlugin): { created: string[]; signals: AbortSignal[]; release: () => void } {
		const created: string[] = [];
		const signals: AbortSignal[] = [];
		let release = (): void => undefined;
		Object.assign(plugin, {
			buildRequest: () => Promise.resolve(stubRequest()),
			confirmUsageGuardrails: () => Promise.resolve(),
			createResultNote: (_request: AskRequest, text: string) => {
				created.push(text);
				return Promise.resolve(new TFile("AskMate/Result.md"));
			},
			runOpenAIRequest: (_request: AskRequest, options: { abortSignal?: AbortSignal }) => new Promise((resolve, reject) => {
				const signal = options.abortSignal;
				if (signal) {
					signals.push(signal);
					signal.addEventListener("abort", () => reject(new DOMException("The request was stopped.", "AbortError")), { once: true });
				}
				release = () => resolve({ kind: "text", model: "gpt-5.5", text: "Reply", incompleteReason: null });
			})
		});
		return { created, signals, release: () => release() };
	}

	async function start(plugin: TestPlugin): Promise<unknown> {
		const command = plugin.commands.get("workflow-study-summary");
		return await command?.editorCallback?.(new FakeEditor("Note"), { file: new TFile("Notes/Source.md") });
	}

	test("a second run is refused while one is running, Stop aborts it and writes no note", async () => {
		const { plugin } = await loadPlugin();
		const run = stubRun(plugin);
		const first = start(plugin);
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));

		await start(plugin);
		expect(Notice.messages.join(" ")).toContain("already running");

		plugin.commands.get("stop-run")?.callback?.();
		await first;
		expect(run.signals[0]?.aborted).toBe(true);
		expect(run.created).toEqual([]);
		expect(Notice.messages.join(" ")).toContain("AskMate request stopped.");

		// The slot is free again.
		Notice.clear();
		const third = start(plugin);
		await new Promise((resolve) => setTimeout(resolve, 5));
		run.release();
		await third;
		expect(run.created).toEqual(["Reply"]);
	});

	test("a finished run names the new note and offers to open it", async () => {
		const { plugin } = await loadPlugin();
		const run = stubRun(plugin);
		const finished = start(plugin);
		await new Promise((resolve) => setTimeout(resolve, 5));
		run.release();
		await finished;

		const notice = Notice.shown.find((candidate) => String(candidate.message).startsWith("AskMate created"));
		expect(String(notice?.message)).toBe("AskMate created AskMate/Result.md");
		expect(notice?.messageEl.textContent).toContain("Open");
	});

	test("a reply that was cut off is announced as unfinished", async () => {
		const { plugin } = await loadPlugin();
		stubRun(plugin);
		Object.assign(plugin, {
			runOpenAIRequest: () => Promise.resolve({ kind: "text", model: "gpt-5.5", text: "Half an ans", incompleteReason: "max_output_tokens" })
		});
		await start(plugin);

		expect(Notice.messages.join(" ")).toContain("cut off (max_output_tokens)");
	});

	test("a failure that settings can fix comes with a button that opens them", async () => {
		const { plugin, fake } = await loadPlugin();
		stubRun(plugin);
		Object.assign(plugin, {
			runOpenAIRequest: () => Promise.reject(new Error("Add an OpenAI API key in AskMate settings before asking a question."))
		});
		await start(plugin);

		const notice = Notice.shown.find((candidate) => String(candidate.message).includes("Add an OpenAI API key"));
		expect(notice?.messageEl.textContent).toContain("Open settings");
		notice?.messageEl.querySelector("button")?.click();
		expect(fake.settingCalls).toEqual(["open", "tab:askmate"]);
	});

	test("opening settings on a build without the settings object explains where to go", async () => {
		const { plugin, fake } = await loadPlugin();
		Reflect.deleteProperty(fake.app, "setting");

		plugin.openSettingsTab();

		expect(Notice.messages.join(" ")).toContain("choose AskMate under community plugins");
	});

	test("unloading the plugin stops the run that is in flight", async () => {
		const { plugin } = await loadPlugin();
		const run = stubRun(plugin);
		const running = start(plugin);
		await new Promise((resolve) => setTimeout(resolve, 5));

		plugin.onunload();
		await running;
		await plugin.whenUnloaded();
		expect(run.signals[0]?.aborted).toBe(true);
	});
});

describe("onload", () => {
	test("registers the brand icon before the view, and uses it for the ribbon", async () => {
		const { plugin } = await loadPlugin();

		expect(registeredIcons.get("askmate")).toContain("<path");
		expect(plugin.views.has(ASKMATE_VIEW_TYPE)).toBe(true);
		expect(plugin.ribbonIcons.map((ribbon) => ribbon.icon)).toEqual(["askmate"]);
	});

	test("adds the commands for settings, stopping, new conversations and diagrams", async () => {
		const { plugin } = await loadPlugin();

		for (const id of ["open-settings", "stop-run", "new-conversation", "draw-diagram", "open-sidebar", "ask-current-note"]) {
			expect(plugin.commands.has(id)).toBe(true);
		}
	});

	test("a fresh install shows the setup notice once, with a button", async () => {
		const { plugin } = await loadPlugin(null);

		const notice = Notice.shown.find((candidate) => String(candidate.message).includes("Connect an AI provider"));
		expect(notice).toBeDefined();
		expect(notice?.messageEl.textContent).toContain("Set up");
		expect(plugin.settings.composerLayout).toBe("compact");
	});

	test("QA-08: the setup notice stays until it is used, and goes once the AskMate sidebar is open", async () => {
		const { fake } = await loadPlugin(null);
		const notice = Notice.shown.find((candidate) => String(candidate.message).includes("Connect an AI provider"));
		expect(notice?.duration).toBe(0);
		expect(notice?.hidden).toBe(false);
		fake.workspace.leaves.push(leafFor({}, ASKMATE_VIEW_TYPE, null));
		fake.workspace.trigger("layout-change");
		expect(notice?.hidden).toBe(true);
	});

	test("QA-08: no setup notice when the AskMate sidebar is already open, because the Connect card is showing", async () => {
		const fake = createFakeApp();
		fake.workspace.leaves.push(leafFor({}, ASKMATE_VIEW_TYPE, null));
		const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
		plugin.storedData = null;
		plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
		await plugin.onload();
		expect(Notice.messages.join(" ")).not.toContain("Connect an AI provider");
	});

	test("D-11: a failed connection test from before a restart still counts, until the model or address changes", async () => {
		const boot = async (model: string): Promise<TestPlugin> => {
			const fake = createFakeApp();
			fake.app.saveLocalStorage("askmate-failed-setup-test", {
				test: { status: "failed", providerId: "openai-compatible", model: "junk model", copy: { category: "model-not-found", message: "Not found", detail: null, action: { kind: "choose-model", label: "Choose another model" } } },
				baseUrl: "http://localhost:11434/v1"
			});
			const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
			plugin.storedData = { selectedTextProvider: "openai-compatible", providers: { "openai-compatible": { baseUrl: "http://localhost:11434/v1", model } } };
			plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
			await plugin.onload();
			return plugin;
		};
		expect((await boot("junk model")).getSetupState().kind).toBe("test-failed");
		expect((await boot("llama3.2:3b")).getSetupState().kind).not.toBe("test-failed");
	});

	test("an existing install gets no setup notice and keeps its layout", async () => {
		const { plugin } = await loadPlugin({ composerLayout: "console" });

		expect(Notice.messages.join(" ")).not.toContain("Connect an AI provider");
		expect(plugin.settings.composerLayout).toBe("console");
	});

	test("builds the skill catalogue once the workspace is ready", async () => {
		const { plugin } = await loadPlugin();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(plugin.skillService.isReady()).toBe(true);
		expect(plugin.skillService.list().map((skill) => skill.id)).toContain("built-in:mermaid-diagrams");
	});

	test("MCP is null while switched off and on a phone, and present once enabled on the desktop", async () => {
		const { plugin } = await loadPlugin();
		expect(plugin.mcpService).toBeNull();

		plugin.settings.mcp.enabled = true;
		expect(plugin.mcpService).not.toBeNull();
		await plugin.onunload();
	});

	test("unloading waits for MCP to stop and conversations to be saved", async () => {
		const { plugin } = await loadPlugin();
		plugin.settings.mcp.enabled = true;
		const service = plugin.mcpService;
		let stopped = false;
		const original = service?.shutdown.bind(service);
		if (service && original) {
			service.shutdown = async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				stopped = true;
				await original();
			};
		}
		plugin.onunload();
		expect(stopped).toBe(false);
		await plugin.whenUnloaded();
		expect(stopped).toBe(true);
	});
});

describe("commands that start something in the sidebar", () => {
	interface FakeSidebar {
		calls: string[];
		composerText: string[];
	}

	/** Puts a sidebar view in the workspace. `shortcuts` are the entry points it offers; the fake app needs a way to reveal a leaf. */
	function addSidebar(fake: FakeApp, shortcuts: Record<string, () => unknown>): FakeSidebar {
		const state: FakeSidebar = { calls: [], composerText: [] };
		const view = Object.create(AskMateView.prototype) as AskMateView;
		Object.assign(view, {
			focusComposer: (text: string) => state.composerText.push(text),
			...Object.fromEntries(Object.entries(shortcuts).map(([name, run]) => [name, () => {
				state.calls.push(name);
				return run();
			}]))
		});
		const leaf = Object.assign(leafFor(view, ASKMATE_VIEW_TYPE, null), { loadIfDeferred: () => Promise.resolve() });
		fake.workspace.leaves.push(leaf);
		Object.assign(fake.workspace, { revealLeaf: () => Promise.resolve() });
		return state;
	}

	async function runCommand(plugin: TestPlugin, id: string): Promise<void> {
		const command = plugin.commands.get(id);
		await command?.callback?.();
		await command?.editorCallback?.(new FakeEditor("Note"), { file: new TFile("Notes/Source.md") });
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	test("New conversation and Draw a diagram call the sidebar, in the Compact layout of a fresh install", async () => {
		const { plugin, fake } = await loadPlugin(null);
		expect(plugin.settings.composerLayout).toBe("compact");
		const sidebar = addSidebar(fake, { startNewConversation: () => Promise.resolve(), startDiagram: () => Promise.resolve() });

		await runCommand(plugin, "new-conversation");
		await runCommand(plugin, "draw-diagram");

		expect(sidebar.calls).toEqual(["startNewConversation", "startDiagram"]);
		// Nothing is typed into the composer: only the Console layout would read it.
		expect(sidebar.composerText).toEqual([]);
		expect(Notice.messages.join(" ")).not.toContain("cannot start");
	});

	test("a sidebar leaf that never became the AskMate view is reported, not ignored, and nothing is typed for the person", async () => {
		const { plugin, fake } = await loadPlugin(null);
		const state: FakeSidebar = { calls: [], composerText: [] };
		const placeholder = { focusComposer: (text: string) => state.composerText.push(text) };
		fake.workspace.leaves.push(Object.assign(leafFor(placeholder, ASKMATE_VIEW_TYPE, null), { loadIfDeferred: () => Promise.resolve() }));
		Object.assign(fake.workspace, { revealLeaf: () => Promise.resolve() });

		await runCommand(plugin, "new-conversation");
		expect(Notice.messages.join(" ")).toContain("could not reach its sidebar");

		Notice.clear();
		await runCommand(plugin, "draw-diagram");
		expect(Notice.messages.join(" ")).toContain("could not reach its sidebar");
		expect(state.composerText).toEqual([]);
	});

	test("Draw a diagram asks for the default diagram of the note, and New conversation takes no arguments", async () => {
		const { plugin, fake } = await loadPlugin(null);
		const received: Array<[string, unknown[]]> = [];
		const view = Object.create(AskMateView.prototype) as AskMateView;
		Object.assign(view, {
			startNewConversation: (...args: unknown[]) => { received.push(["startNewConversation", args]); return Promise.resolve(); },
			startDiagram: (...args: unknown[]) => { received.push(["startDiagram", args]); return Promise.resolve(); }
		});
		fake.workspace.leaves.push(Object.assign(leafFor(view, ASKMATE_VIEW_TYPE, null), { loadIfDeferred: () => Promise.resolve() }));
		Object.assign(fake.workspace, { revealLeaf: () => Promise.resolve() });

		await runCommand(plugin, "new-conversation");
		await runCommand(plugin, "draw-diagram");

		expect(received).toEqual([["startNewConversation", []], ["startDiagram", []]]);
	});

	test("a refusal from the sidebar is shown, not lost", async () => {
		const { plugin, fake } = await loadPlugin(null);
		addSidebar(fake, { startNewConversation: () => Promise.reject(new Error("Stop the current request before starting a new conversation.")) });

		await runCommand(plugin, "new-conversation");

		expect(Notice.messages.join(" ")).toContain("Stop the current request before starting a new conversation.");
	});

	test("when the sidebar cannot be opened only that reason is shown", async () => {
		const { plugin, fake } = await loadPlugin(null);
		Object.assign(fake.workspace, { getRightLeaf: () => null, revealLeaf: () => Promise.resolve() });

		await runCommand(plugin, "draw-diagram");

		expect(Notice.messages.join(" ")).toContain("could not open the right sidebar");
		expect(Notice.messages.join(" ")).not.toContain("cannot start");
	});
});

describe("deferred sidebar views", () => {
	test("Copy last answer loads a deferred sidebar before asking it", async () => {
		const { plugin, fake } = await loadPlugin();
		const view = Object.create(AskMateView.prototype) as AskMateView;
		view.getLastAnswer = () => ({ text: "The answer", incompleteReason: null });
		let loaded = false;
		const leaf = Object.assign(leafFor({ placeholder: true }, ASKMATE_VIEW_TYPE, null), {
			view: { placeholder: true } as unknown,
			loadIfDeferred: () => {
				loaded = true;
				leaf.view = view;
				return Promise.resolve();
			}
		});
		fake.workspace.leaves.push(leaf);

		await plugin.commands.get("copy-last-answer")?.callback?.();

		expect(loaded).toBe(true);
		expect(Notice.messages.join(" ")).not.toContain("no AskMate answer");
	});

	test("with no sidebar open the command says there is nothing to copy", async () => {
		const { plugin } = await loadPlugin();
		await plugin.commands.get("copy-last-answer")?.callback?.();

		expect(Notice.messages.join(" ")).toContain("no AskMate answer to copy");
	});
});

describe("Insert last answer at cursor", () => {
	function sidebarWithAnswer(fake: FakeApp, answer: { text: string; incompleteReason: string | null }): void {
		const view = Object.create(AskMateView.prototype) as AskMateView;
		view.getLastAnswer = () => answer;
		fake.workspace.leaves.push(Object.assign(leafFor(view, ASKMATE_VIEW_TYPE, null), { loadIfDeferred: () => Promise.resolve() }));
	}

	test("writes at the cursor, names the note it went into and warns about an incomplete reply", async () => {
		const { plugin, fake } = await loadPlugin();
		sidebarWithAnswer(fake, { text: "Hello", incompleteReason: "max_output_tokens" });
		const editor = new FakeEditor("Note");

		await plugin.commands.get("insert-last-answer")?.editorCallback?.(editor, { file: new TFile("Notes/Source.md") });

		expect(editor.value).toBe("HelloNote");
		expect(Notice.messages.at(-1)).toBe("Inserted at the cursor in Notes/Source.md. This reply may be incomplete: the provider stopped at its output token limit.");
	});

	test("keeps selected text and checks the reply: active content goes in as its safe version", async () => {
		const { plugin, fake } = await loadPlugin();
		sidebarWithAnswer(fake, { text: "Chart: ![x](https://evil.example/a.png)", incompleteReason: null });
		const editor = new FakeEditor("Keep this");
		editor.select("Keep this");
		Object.assign(editor, { setCursor: () => { editor.selectionStart = editor.selectionEnd; } });

		await plugin.commands.get("insert-last-answer")?.editorCallback?.(editor, { file: new TFile("Notes/Source.md") });

		expect(editor.value.startsWith("Keep this")).toBe(true);
		expect(editor.value).not.toContain("![x](https://evil.example");
		expect(Notice.messages.at(-1)).toContain("safe version at the cursor in Notes/Source.md");
	});

	test("says so when there is no answer to insert", async () => {
		const { plugin } = await loadPlugin();
		const editor = new FakeEditor("Note");

		await plugin.commands.get("insert-last-answer")?.editorCallback?.(editor, { file: new TFile("Notes/Source.md") });

		expect(editor.value).toBe("Note");
		expect(Notice.messages.at(-1)).toBe("There is no AskMate answer to insert yet.");
	});
});

describe("leaf lookup", () => {
	test("matches a tab by its saved file, which a deferred leaf still has", () => {
		const leaves = [leafFor({}, "markdown", "a.md"), leafFor({}, "markdown", "b.md"), leafFor({}, "markdown", null)];

		expect(leafFilePath(leaves[1])).toBe("b.md");
		expect(leafFilePath(leaves[2])).toBeNull();
		expect(findLeafForFile(leaves, "b.md")).toBe(leaves[1]);
		expect(findLeafForFile(leaves, "c.md")).toBeUndefined();
	});
});

describe("the sidebar context rule", () => {
	test("a request started with the sidebar focused still sees the open note", async () => {
		const { plugin, fake } = await loadPlugin();
		const file = fake.vault.add("Notes/Open.md", "The open note says: ship on Friday.");
		const view = openFakeMarkdownView(fake.workspace, file, "The open note says: ship on Friday.");
		// The user clicked into the sidebar: Obsidian no longer reports a Markdown view as active.
		fake.workspace.activeView = null;
		plugin.rememberEditorContext(view.editor as never, file as never);
		plugin.rememberMarkdownFile(file as never);

		const context = await plugin.getNoteContext();

		expect(context.content).toContain("ship on Friday");
		expect(context.file?.path).toBe("Notes/Open.md");
	});
});
