import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import { deriveSetupState } from "../src/setup";
import type { AskMateSettings, AskRequest, NoteContext, TextProviderId } from "../src/shared/types";
import { ThreadService } from "../src/threads/ThreadService";
import { assembleDiagram, designFromRecipe, STYLE_RECIPES } from "../src/diagrams";
import { DEFAULT_DIAGRAM_QUESTION } from "../src/ui/sidebar/components/diagramModel";
import { BUSY_RUN_MESSAGE } from "../src/ui/sidebar/runController";
import { hashSkillText, SkillService, type SkillConfig, type SkillFileInfo, type SkillHost, type SkillMatchMode } from "../src/skills";
import type { AskMatePlugin } from "../src/plugin/AskMatePlugin";
import { WORKFLOWS } from "../src/workflows/builtInWorkflows";
import { createFakeApp, FakeEditor, openFakeMarkdownView, type FakeApp } from "./support/fake-app";
import { createFakeMouseEvent, fireDomEvent, getFakeWindow, installDomGlobals } from "./support/fake-dom";
import { MarkdownRenderer, Menu, Modal, Notice, WorkspaceLeaf, type TFile } from "./support/obsidian-fakes";
import type { ExtendedBuildOptions, RunOptions, RunResult } from "../src/requests/runTypes";

const { AskMateView } = await import("../src/ui/sidebar/AskMateView");
const { ContextService } = await import("../src/context/ContextService");

let restoreGlobals: () => void;

beforeAll(() => {
	restoreGlobals = installDomGlobals();
	// Obsidian puts `doc` on every node; the sidebar reads it to stay correct in popout windows.
	Object.defineProperty(getFakeWindow().Node.prototype, "doc", {
		configurable: true,
		get(this: Node) {
			return this.ownerDocument;
		}
	});
});

afterAll(() => restoreGlobals());

const MODEL = "gpt-5.5";

/** A skills folder in memory, for a real SkillService behind the sidebar. */
class SkillTestHost implements SkillHost {
	files = new Map<string, string>();
	trusted: Record<string, string> = {};
	config: Omit<SkillConfig, "trusted"> = { enabled: true, folder: "AskMate/Skills", matchMode: "builtin-auto", disabledIds: [] };

	parseYaml(text: string): unknown {
		return Bun.YAML.parse(text);
	}
	sha256(text: string): Promise<string> {
		return hashSkillText(text);
	}
	getConfig(): SkillConfig {
		return { ...this.config, trusted: { ...this.trusted } };
	}
	listFiles(): Promise<readonly SkillFileInfo[]> {
		return Promise.resolve(Array.from(this.files, ([path, text]) => ({ path, size: new TextEncoder().encode(text).length })));
	}
	readFile(path: string): Promise<string> {
		return Promise.resolve(this.files.get(path) ?? "");
	}
	saveTrust(id: string, hash: string | null): Promise<void> {
		if (hash === null) {
			delete this.trusted[id];
		} else {
			this.trusted[id] = hash;
		}
		return Promise.resolve();
	}
	watch(): () => void {
		return () => undefined;
	}
	setTimer(): unknown {
		return 0;
	}
	clearTimer(): void {
		return;
	}
}

const MEETING_SKILL = [
	"---",
	"name: meeting-notes",
	"title: Meeting notes",
	"description: Turn a meeting transcript into decisions, action items and owners.",
	"triggers:",
	"  - summarise this meeting",
	"  - action items from the meeting",
	"---",
	"# Goal",
	"List decisions, action items and owners from the meeting notes.",
	""
].join("\n");

/** The open and close sequence Obsidian runs, which the shared fake exposes for tests. */
interface TestLifecycle {
	openForTest(): Promise<void>;
	closeForTest(): Promise<void>;
}

const lifecycle = (view: unknown): TestLifecycle => view as TestLifecycle;

type RunHandler = (request: AskRequest, options: RunOptions) => Promise<RunResult>;

interface Harness {
	fake: FakeApp;
	settings: AskMateSettings;
	plugin: AskMatePlugin;
	view: InstanceType<typeof AskMateView>;
	root: HTMLElement;
	context: InstanceType<typeof ContextService>;
	built: Array<{ question: string; title: string; options: ExtendedBuildOptions }>;
	ran: Array<{ request: AskRequest; options: RunOptions }>;
	applied: Array<{ text: string; scope: string | undefined }>;
	run: { handler: RunHandler };
	models: { name: string };
	opened: { count: number };
	skills: { service: SkillService; host: SkillTestHost };
}

function textResult(text: string, extra: Partial<RunResult> = {}): RunResult {
	return { kind: "text", model: MODEL, text, ...extra } as RunResult;
}

function makeRequest(question: string, title: string, options: ExtendedBuildOptions & { intentKind?: string }, context: NoteContext, model: string): AskRequest {
	return {
		context,
		question,
		title,
		evidenceSources: [],
		metadata: {
			intentKind: options.intentKind ?? "freeform_text",
			commandSource: "sidebar",
			outputMode: options.outputMode ?? "chat",
			promptVersion: "test",
			providerId: "openai",
			providerName: "OpenAI",
			selectedModel: model,
			modelCapability: "text",
			reasoningEffort: "medium",
			privacy: { includeNoteContext: true, includeImageReferences: true },
			contextBudgetMode: "expanded",
			forceImage: false,
			autoImage: false,
			workflowId: null,
			workflowName: null,
			createdAt: new Date().toISOString()
		}
	} as unknown as AskRequest;
}

async function settle(rounds = 6): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function createHarness(options: { configured?: boolean; layout?: "compact" | "expanded" | "console"; saved?: Partial<AskMateSettings>; skills?: SkillMatchMode; skillFiles?: Record<string, string> } = {}): Promise<Harness> {
	const fake = createFakeApp();
	const settings: AskMateSettings = {
		...structuredClone(normalizeAskMateSettings({}, "load")),
		composerLayout: options.layout ?? "compact",
		showRequestPreview: false,
		showOnboardingTips: false,
		...options.saved
	};
	if (options.configured !== false) {
		settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		fake.secretStorage.setSecret("askmate-openai-key", "sk-test-key-123456");
	}
	const context = new ContextService({ app: fake.app, getSettings: () => settings, getNoteHistoryForPath: () => [] });
	const threads = new ThreadService({
		getSettings: () => settings,
		saveSettings: () => Promise.resolve(),
		setTimer: () => 0,
		clearTimer: () => undefined,
		warn: () => undefined
	});
	const built: Harness["built"] = [];
	const ran: Harness["ran"] = [];
	const applied: Harness["applied"] = [];
	const run: Harness["run"] = { handler: () => Promise.resolve(textResult("An answer.")) };
	const models = { name: MODEL };
	const opened = { count: 0 };
	let configured = options.configured !== false;
	const plugin = {
		app: fake.app,
		get settings() {
			return settings;
		},
		threads,
		rememberActiveMarkdownContext: () => context.rememberActiveMarkdownContext(),
		getNoteContext: (editor?: unknown, file?: TFile | null) => context.getNoteContext(editor as never, file),
		getLastOpenMarkdownView: () => context.getLastOpenMarkdownView(),
		getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "Unknown error"),
		saveSettings: () => Promise.resolve(),
		refreshOpenAskMateViews: () => undefined,
		refreshSettingTab: () => undefined,
		isFreshInstall: () => false,
		getSelectedProviderModelRef: () => ({ providerId: "openai", providerName: "OpenAI", model: models.name, capability: "text" }),
		getChatProviderModelRef: () => ({ providerId: "openai", providerName: "OpenAI", model: models.name, capability: "text" }),
		getChatProviderId: () => "openai",
		getProviderSettings: () => settings.providers.openai,
		getSelectedReasoningEffort: () => "medium",
		supportsSelectedReasoningEffort: () => false,
		getTodayTokenUsage: () => 0,
		isSelectedProviderConfigured: () => Promise.resolve(configured),
		isImageGenerationConfigured: () => Promise.resolve(false),
		classifyRequestIntent: (_question: string, requestOptions: { intentKind?: string }) => requestOptions.intentKind ?? "freeform_text",
		buildRequest: async (question: string, title: string, requestOptions: ExtendedBuildOptions) => {
			built.push({ question, title, options: requestOptions });
			const noteContext = await context.getNoteContext(undefined, undefined, { allowNoNote: true });
			return makeRequest(question, title, requestOptions, noteContext as NoteContext, models.name);
		},
		confirmUsageGuardrails: () => Promise.resolve(),
		runOpenAIRequest: (request: AskRequest, runOptions: RunOptions) => {
			ran.push({ request, options: runOptions });
			return run.handler(request, runOptions);
		},
		recordNoteHistoryTurn: () => Promise.resolve(),
		extractEvidenceCitations: () => [],
		getAllWorkflows: () => WORKFLOWS,
		getVisibleWorkflows: () => WORKFLOWS,
		getWorkflowDisplayPreference: () => null,
		getWorkflowPrompt: (workflow: { prompt: string }) => workflow.prompt,
		inspectFinalPrompt: () => Promise.reject(new Error("not used")),
		describeLastVaultMentions: () => [],
		getVaultTags: () => [],
		createResultNote: () => Promise.resolve({ path: "AskMate/Result.md" }),
		applyResponseToContext: (_request: AskRequest, text: string, applyOptions?: { scope?: string }) => {
			applied.push({ text, scope: applyOptions?.scope });
			return Promise.resolve({ status: "applied", message: "Appended to A.md." });
		},
		queueReviewItemFromRequest: () => Promise.resolve({ sourcePath: "A.md" }),
		testSelectedProviderConnection: () => Promise.resolve("ok"),
		// The members the real plugin has for the sidebar, with working defaults. A test replaces the one it wants to watch.
		skillService: undefined,
		mcpService: null,
		getSetupState: () => deriveSetupState(settings, (name: string) => (fake.secretStorage.getSecret(name) ?? "") !== ""),
		saveProviderApiKey: (providerId: TextProviderId, key: string) => {
			settings.providers[providerId].apiKeySecretName = `askmate-${providerId}-key`;
			fake.secretStorage.setSecret(`askmate-${providerId}-key`, key);
			return Promise.resolve();
		},
		testProviderConnectionDetailed: async () => ({ ok: true, message: await plugin.testSelectedProviderConnection(), modelFound: null, latencyMs: 0, suggestedModel: null, copy: null }),
		openSettingsTab: () => undefined,
		loadMermaidApi: () => Promise.resolve(null),
		setReasoningEffort: () => Promise.resolve(),
		openEvidenceSource: () => Promise.resolve(),
		createConversationNote: () => Promise.resolve({ path: "AskMate/Chat.md" }),
		createImageResultNote: () => Promise.reject(new Error("not used")),
		applyImageToContext: () => Promise.reject(new Error("not used"))
	} as unknown as AskMatePlugin;
	Object.defineProperty(plugin, "setConfigured", { value: (value: boolean) => (configured = value) });
	const skillHost = new SkillTestHost();
	const service = new SkillService(skillHost);
	// Nothing is suggested or started on its own unless a test asks for a matching mode.
	skillHost.config = { ...skillHost.config, matchMode: options.skills ?? "off" };
	for (const [path, text] of Object.entries(options.skillFiles ?? {})) {
		skillHost.files.set(`AskMate/Skills/${path}`, text);
	}
	await service.scan();
	Object.assign(plugin, { skillService: service });
	const leaf = new WorkspaceLeaf(fake.app);
	const view = new AskMateView(leaf as never, plugin);
	activeDocument.body.appendChild(view.containerEl);
	await lifecycle(view).openForTest();
	return { fake, settings, plugin, view, root: view.containerEl, context, built, ran, applied, run, models, opened, skills: { service, host: skillHost } };
}

const ask = (harness: Harness, text: string): void => {
	const box = harness.root.querySelector<HTMLTextAreaElement>(".askmate-question");
	if (!box) {
		throw new Error("expected the question box");
	}
	box.value = text;
	fireDomEvent(box, "input");
};

const send = async (harness: Harness): Promise<void> => {
	harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
	await settle();
};

const box = (harness: Harness): HTMLTextAreaElement => {
	const element = harness.root.querySelector<HTMLTextAreaElement>(".askmate-question");
	if (!element) {
		throw new Error("expected the question box");
	}
	return element;
};

const bubbles = (harness: Harness, role: string): HTMLElement[] =>
	Array.from(harness.root.querySelectorAll<HTMLElement>(`.askmate-message-${role}`)).filter((element) => !element.classList.contains("askmate-console-echo") && !element.classList.contains("askmate-console-output"));

let open: Harness | null = null;

async function start(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	open = await createHarness(options);
	return open;
}

beforeEach(() => {
	Notice.clear();
	MarkdownRenderer.reset();
});

afterEach(async () => {
	if (open) {
		await lifecycle(open.view).closeForTest();
		open.root.remove();
		open = null;
	}
	Menu.lastMenu = null;
});

describe("the Connect card", () => {
	for (const layout of ["compact", "expanded", "console"] as const) {
		test(`is the first entry in the ${layout} layout while no provider is set up`, async () => {
			const harness = await start({ configured: false, layout });
			const first = harness.root.querySelector(".askmate-messages")?.firstElementChild;
			expect(first?.classList.contains("askmate-setup-host")).toBe(true);
			expect(first?.querySelector(".askmate-setup-card")).not.toBeNull();
			expect(first?.querySelector(".askmate-setup-title")?.textContent).toBe("Connect an AI provider");
			// The not connected segment sits in the status line, ready to open the card.
			const segment = harness.root.querySelector<HTMLElement>(".askmate-console-segment.is-setup");
			expect(segment?.hidden).toBe(false);
			expect(segment?.textContent).toBe("Not connected");
		});
	}

	const sidebarOf = (harness: Harness): HTMLElement | null =>
		harness.root.classList.contains("askmate-sidebar") ? harness.root : harness.root.querySelector<HTMLElement>(".askmate-sidebar");

	test("QA-01: while the card is unfinished the request preview makes way, and it sits below Send, Stop and the output mode", async () => {
		const harness = await start({ configured: false, saved: { showRequestPreview: true } });
		expect(sidebarOf(harness)?.classList.contains("askmate-setup-open")).toBe(true);
		const preview = harness.root.querySelector(".askmate-request-preview");
		expect(preview?.previousElementSibling?.classList.contains("askmate-composer-footer")).toBe(true);
	});

	test("QA-01: once a provider is set up the request preview is shown again, still below the footer", async () => {
		const harness = await start({ saved: { showRequestPreview: true } });
		expect(sidebarOf(harness)?.classList.contains("askmate-setup-open")).toBe(false);
		expect(harness.root.querySelector(".askmate-request-preview")?.previousElementSibling?.classList.contains("askmate-composer-footer")).toBe(true);
	});

	test("QA-10: the card's provider, address and model are kept for a reload, and the key never is", async () => {
		const harness = await start({ configured: false });
		chip(harness, "Local")?.click();
		await settle();
		const fields = Array.from(harness.root.querySelectorAll<HTMLInputElement>(".askmate-setup-key-row input"));
		const model = fields[1];
		if (!model) {
			throw new Error("expected the model field");
		}
		model.value = "qwen2.5:7b";
		fireDomEvent(model, "input");
		const stored = harness.fake.app.loadLocalStorage("askmate-setup-draft") as Record<string, unknown> | null;
		expect(stored).toEqual({ provider: "openai-compatible", baseUrl: expect.any(String), model: "qwen2.5:7b" });
		expect(JSON.stringify(stored)).not.toContain("apiKey");
	});

	test("D-03: a genuine first install starts the card on Local, and the model chip names no provider yet", async () => {
		const harness = await start({ configured: false });
		Object.assign(harness.plugin, { isFreshInstall: () => true });
		const view = harness.view as unknown as { restoreSetupDraft(): void; refreshSetupCard(): void };
		view.restoreSetupDraft();
		view.refreshSetupCard();
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toContain("Local");
		expect(harness.root.querySelector(".askmate-composer-model")?.textContent).toBe("No provider connected yet");
	});

	test("D-03: an existing install that is not set up still starts the card on its chat provider", async () => {
		const harness = await start({ configured: false });
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toContain("OpenAI");
	});

	test("does not appear for someone who is already set up", async () => {
		const harness = await start();
		expect(harness.root.querySelector(".askmate-setup-card")).toBeNull();
		expect(harness.root.querySelector<HTMLElement>(".askmate-console-segment.is-setup")?.hidden).toBe(true);
	});

	test("an unconfigured send keeps the typed question and opens the card", async () => {
		const harness = await start({ configured: false });
		ask(harness, "What is this note about?");
		await send(harness);
		expect(box(harness).value).toBe("What is this note about?");
		expect(harness.built).toHaveLength(0);
		expect(harness.root.querySelector(".askmate-setup-card")).not.toBeNull();
		expect(Notice.messages.at(-1)).toBe("Connect an AI provider before sending.");
		expect(bubbles(harness, "user")).toHaveLength(0);
	});

	test("the readiness chip opens the card when it is clicked", async () => {
		const harness = await start({ configured: false });
		await settle();
		const chip = harness.root.querySelector<HTMLElement>(".askmate-composer-brand");
		expect(chip?.classList.contains("is-not-ready")).toBe(true);
		expect(chip?.getAttribute("role")).toBe("button");
	});

	test("QA-09: after a failed connection test the readiness chip says so instead of Ready, and opens the card", async () => {
		const harness = await start();
		Object.assign(harness.plugin, {
			testProviderConnectionDetailed: () => Promise.resolve({ ok: false, message: "HTTP 401 invalid api key", modelFound: null })
		});
		ask(harness, "/test");
		await send(harness);
		await settle(12);
		const chip = harness.root.querySelector<HTMLElement>(".askmate-composer-brand");
		expect(chip?.textContent).toBe("AskMate · Connection failed");
		expect(chip?.classList.contains("is-not-ready")).toBe(true);
		expect(chip?.getAttribute("role")).toBe("button");
	});

	test("/setup and /welcome work in the console, and /welcome on a connected setup shows the starters", async () => {
		const harness = await start({ layout: "console" });
		ask(harness, "/welcome");
		await send(harness);
		expect(harness.root.querySelector(".askmate-setup-card")).not.toBeNull();
		expect(harness.root.querySelectorAll(".askmate-starter-chip")).toHaveLength(3);
		ask(harness, "/setup");
		await send(harness);
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connect")).toBe(true);
	});

	test("D-11: a starter's bubble shows the words on the chip, not the workflow's name", async () => {
		const harness = await start();
		const note = harness.fake.vault.add("Plan.md", "# Plan\nAlpha beta gamma");
		const noteView = openFakeMarkdownView(harness.fake.workspace, note, "# Plan\nAlpha beta gamma");
		harness.fake.workspace.activeView = noteView;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();
		await (harness.view as unknown as { updateContextLabel(): Promise<void> }).updateContextLabel();
		ask(harness, "/welcome");
		await send(harness);
		const summarise = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-starter-chip")).find((button) => button.textContent === "Summarise this note");
		summarise?.click();
		await settle(12);
		expect(bubbles(harness, "user").map((bubble) => bubble.textContent ?? "").join(" ")).toContain("Summarise this note");
	});

	test("D-11: once a provider works and a question is sent, the welcome card goes away", async () => {
		const harness = await start();
		ask(harness, "/welcome");
		await send(harness);
		expect(harness.root.querySelector(".askmate-setup-card")).not.toBeNull();
		ask(harness, "What is this note about?");
		await send(harness);
		expect(harness.root.querySelector(".askmate-setup-card")).toBeNull();
	});

	test("D-11: the request context button's name starts with its own label", async () => {
		const harness = await start();
		await settle();
		expect(harness.root.querySelector(".askmate-context-button")?.getAttribute("aria-label")).toMatch(/^Show request context\. /);
	});

	test("Connect saves the pasted key through the plugin, tests the connection and then offers starters", async () => {
		const harness = await start({ configured: false });
		const saved: Array<[string, string]> = [];
		Object.assign(harness.plugin, {
			saveProviderApiKey: (providerId: string, key: string) => {
				saved.push([providerId, key]);
				harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
				harness.fake.secretStorage.setSecret("askmate-openai-key", key);
				return Promise.resolve();
			},
			testProviderConnectionDetailed: () => Promise.resolve({ ok: true, message: "OpenAI answered.", modelFound: true })
		});
		const field = harness.root.querySelector<HTMLInputElement>(".askmate-setup-key-row input");
		if (!field) {
			throw new Error("expected the key field");
		}
		field.value = "sk-live-abcdefgh";
		fireDomEvent(field, "input");
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-actions .mod-cta")?.click();
		await settle(12);
		expect(saved).toEqual([["openai", "sk-live-abcdefgh"]]);
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connected")).toBe(true);
		expect(harness.root.querySelectorAll(".askmate-starter-chip")).toHaveLength(3);
		expect(harness.settings.firstRunCompletedAt).not.toBeNull();
		// The key never reaches the DOM again.
		expect(harness.root.textContent).not.toContain("sk-live-abcdefgh");
	});

	test("a rejected key shows one sentence and the Update key button", async () => {
		const harness = await start({ configured: false });
		Object.assign(harness.plugin, {
			saveProviderApiKey: () => {
				harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
				harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-bad-key-1234");
				return Promise.resolve();
			},
			testProviderConnectionDetailed: () => Promise.resolve({ ok: false, message: "HTTP 401 invalid api key", modelFound: null })
		});
		const field = harness.root.querySelector<HTMLInputElement>(".askmate-setup-key-row input");
		field!.value = "sk-bad-key-1234";
		fireDomEvent(field!, "input");
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-actions .mod-cta")?.click();
		await settle(12);
		const error = harness.root.querySelector(".askmate-setup-error");
		expect(error?.textContent).toContain("rejected the API key");
		expect(error?.querySelector("button")?.textContent).toBe("Update key");
	});

	test("an empty key field says so instead of calling the provider", async () => {
		const harness = await start({ configured: false });
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-actions .mod-cta")?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("Paste your API key first.");
	});
});

/** What the Connect card keeps between redraws, read from the view the way the tests read nothing else. */
const setupState = (harness: Harness): { draft: { apiKey: string; baseUrl: string; model: string }; draftProvider: string | null } =>
	(harness.view as unknown as { setup: { draft: { apiKey: string; baseUrl: string; model: string }; draftProvider: string | null } }).setup;

const keyField = (harness: Harness): HTMLInputElement => {
	const field = harness.root.querySelector<HTMLInputElement>(".askmate-setup-key-row input[type=\"password\"]");
	if (!field) {
		throw new Error("expected the key field");
	}
	return field;
};

const typeKey = (harness: Harness, key: string): void => {
	const field = keyField(harness);
	field.value = key;
	fireDomEvent(field, "input");
};

const pressConnect = async (harness: Harness): Promise<void> => {
	harness.root.querySelector<HTMLButtonElement>(".askmate-setup-actions .mod-cta")?.click();
	await settle(12);
};

const chip = (harness: Harness, label: string): HTMLButtonElement | undefined =>
	Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-setup-provider")).find((button) => button.textContent === label);

/** A plugin that stores keys under their provider and answers the connection test with the given verdict. */
function storeKeys(harness: Harness, saved: Array<[string, string]>, verdict: { ok: boolean; message: string }): void {
	Object.assign(harness.plugin, {
		getProviderSettings: (id: TextProviderId) => harness.settings.providers[id],
		saveProviderApiKey: (providerId: TextProviderId, key: string) => {
			saved.push([providerId, key]);
			harness.settings.providers[providerId].apiKeySecretName = `askmate-${providerId}-key`;
			harness.fake.secretStorage.setSecret(`askmate-${providerId}-key`, key);
			return Promise.resolve();
		},
		testProviderConnectionDetailed: () => Promise.resolve({ ...verdict, modelFound: verdict.ok ? true : null })
	});
}

const chatProviderSaved = (provider: TextProviderId): Partial<AskMateSettings> => ({
	selectedTextProvider: provider,
	providerRoles: { ...normalizeAskMateSettings({}, "load").providerRoles, chatProviderId: provider }
});

describe("the Connect card and the key it is given", () => {
	test("a rejected key is gone from the field and from memory, and Update key leaves an empty field with the focus", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: false, message: "HTTP 401 invalid api key" });
		typeKey(harness, "sk-bad-key-1234");
		await pressConnect(harness);
		expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("rejected the API key");
		expect(keyField(harness).value).toBe("");
		expect(setupState(harness).draft.apiKey).toBe("");
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-error button")?.click();
		await settle();
		expect(keyField(harness).value).toBe("");
		expect(activeDocument.activeElement).toBe(keyField(harness));
		// A new paste is the whole value, not added to the end of the old key.
		typeKey(harness, "sk-new-key-5678");
		expect(setupState(harness).draft.apiKey).toBe("sk-new-key-5678");
	});

	test("a key that was saved is not kept in memory or in any field", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: true, message: "OpenAI answered." });
		// The moment right after the key is stored, before the card is drawn again.
		const fieldAfterSave: string[] = [];
		Object.assign(harness.plugin, { refreshOpenAskMateViews: () => fieldAfterSave.push(keyField(harness).value) });
		typeKey(harness, "sk-live-abcdefgh");
		await pressConnect(harness);
		expect(fieldAfterSave).toEqual([""]);
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connected")).toBe(true);
		expect(setupState(harness).draft.apiKey).toBe("");
		expect(Array.from(harness.root.querySelectorAll<HTMLInputElement>("input"), (input) => input.value)).not.toContain("sk-live-abcdefgh");
		// Opening the card again for the same provider starts empty.
		ask(harness, "/setup");
		await send(harness);
		expect(Array.from(harness.root.querySelectorAll<HTMLInputElement>("input"), (input) => input.value)).not.toContain("sk-live-abcdefgh");
	});

	test("a key typed for one provider is not carried to the next provider's field or saved under it", async () => {
		const harness = await start({ configured: false });
		const saved: Array<[string, string]> = [];
		storeKeys(harness, saved, { ok: true, message: "Anthropic answered." });
		typeKey(harness, "sk-openai-SECRET-1234567890");
		chip(harness, "Anthropic")?.click();
		await settle();
		expect(keyField(harness).value).toBe("");
		expect(setupState(harness).draft.apiKey).toBe("");
		expect(setupState(harness).draftProvider).toBe("anthropic");
		await pressConnect(harness);
		// Nothing was typed for Anthropic, so nothing is saved or sent.
		expect(saved).toEqual([]);
		expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("Paste your API key first.");
		typeKey(harness, "sk-anthropic-9876543210");
		await pressConnect(harness);
		expect(saved).toEqual([["anthropic", "sk-anthropic-9876543210"]]);
	});

	test("Update key after an empty Connect stays on the chip in use and saves the next key under that provider", async () => {
		const harness = await start({ configured: false });
		const saved: Array<[string, string]> = [];
		storeKeys(harness, saved, { ok: true, message: "Anthropic answered." });
		chip(harness, "Anthropic")?.click();
		await settle();
		await pressConnect(harness);
		expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("Paste your API key first.");
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("Anthropic");
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-error button")?.click();
		await settle();
		// The chat provider is still OpenAI; the chip in use is not.
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("Anthropic");
		expect(setupState(harness).draftProvider).toBe("anthropic");
		expect(activeDocument.activeElement).toBe(keyField(harness));
		typeKey(harness, "sk-ant-api03-abcdefgh");
		await pressConnect(harness);
		expect(saved).toEqual([["anthropic", "sk-ant-api03-abcdefgh"]]);
		expect(harness.settings.providerRoles.chatProviderId).toBe("anthropic");
	});

	test("Update key after a key that is not one key stays on the chip in use, with the bad key gone", async () => {
		const harness = await start({ configured: false });
		const saved: Array<[string, string]> = [];
		storeKeys(harness, saved, { ok: true, message: "Gemini answered." });
		chip(harness, "Gemini")?.click();
		await settle();
		typeKey(harness, "bad key with spaces");
		await pressConnect(harness);
		const error = harness.root.querySelector(".askmate-setup-error");
		expect(error?.querySelector("button")?.textContent).toBe("Update key");
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("Gemini");
		error?.querySelector<HTMLButtonElement>("button")?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("Gemini");
		expect(keyField(harness).value).toBe("");
		expect(setupState(harness).draft.apiKey).toBe("");
		expect(saved).toEqual([]);
		typeKey(harness, "AIzaSyGeminiKey1234567");
		await pressConnect(harness);
		expect(saved).toEqual([["google-gemini", "AIzaSyGeminiKey1234567"]]);
	});

	describe("Check the address", () => {
		const addressField = (harness: Harness): HTMLInputElement => {
			const field = harness.root.querySelector<HTMLInputElement>(".askmate-setup-key-row input[type=\"text\"]");
			if (!field) {
				throw new Error("expected the address field");
			}
			return field;
		};
		const selectedChip = (harness: Harness): string | undefined => harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent ?? undefined;
		const errorButton = (harness: Harness): HTMLButtonElement | null => harness.root.querySelector<HTMLButtonElement>(".askmate-setup-error button");

		test("after a bad local address it stays on the Local chip, keeps what was typed and does not leave for settings", async () => {
			const harness = await start({ configured: false });
			const opened: string[] = [];
			Object.assign(harness.plugin, { openSettingsTab: () => opened.push("settings") });
			chip(harness, "Local")?.click();
			await settle();
			addressField(harness).value = "ftp://localhost:11434";
			fireDomEvent(addressField(harness), "input");
			await pressConnect(harness);
			expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("The address must start with http://");
			expect(errorButton(harness)?.textContent).toBe("Check the address");
			// The chat provider is still OpenAI; the chip in use is not.
			expect(selectedChip(harness)).toBe("Local");

			errorButton(harness)?.click();
			await settle();

			expect(opened).toEqual([]);
			expect(selectedChip(harness)).toBe("Local");
			expect(addressField(harness).value).toBe("ftp://localhost:11434");
			expect(activeDocument.activeElement).toBe(addressField(harness));
		});

		test("after the chat provider itself failed on its address it opens the card on that provider", async () => {
			const harness = await start({ configured: false, layout: "console", saved: chatProviderSaved("openai-compatible") });
			const opened: string[] = [];
			Object.assign(harness.plugin, {
				openSettingsTab: () => opened.push("settings"),
				getChatProviderId: () => "openai-compatible",
				getChatProviderModelRef: () => ({ providerId: "openai-compatible", providerName: "Local", model: harness.settings.providers["openai-compatible"].model, capability: "text" }),
				getProviderSettings: (id: TextProviderId) => harness.settings.providers[id],
				testProviderConnectionDetailed: () => Promise.resolve({ ok: false, message: "Base URL must start with http:// or https://", modelFound: null })
			});
			// The Local server has a default address, so nothing is missing and the card opens only when asked for.
			ask(harness, "/setup");
			await send(harness);
			await pressConnect(harness);
			expect(errorButton(harness)?.textContent).toBe("Check the address");

			errorButton(harness)?.click();
			await settle();

			expect(opened).toEqual([]);
			expect(selectedChip(harness)).toBe("Local");
			expect(addressField(harness)).toBeDefined();
		});

		test("a provider whose address the card cannot edit is sent to settings", async () => {
			const harness = await start({ configured: false });
			const opened: string[] = [];
			storeKeys(harness, [], { ok: false, message: "Base URL must start with https://" });
			Object.assign(harness.plugin, { openSettingsTab: () => opened.push("settings") });
			typeKey(harness, "sk-live-abcdefgh");
			await pressConnect(harness);
			expect(errorButton(harness)?.textContent).toBe("Check the address");
			expect(selectedChip(harness)).toBe("OpenAI");

			errorButton(harness)?.click();
			await settle();

			expect(opened).toEqual(["settings"]);
		});
	});

	test("switching back to a provider does not bring its old draft back", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: true, message: "ok" });
		typeKey(harness, "sk-openai-SECRET-1234567890");
		chip(harness, "Gemini")?.click();
		await settle();
		chip(harness, "OpenAI")?.click();
		await settle();
		expect(keyField(harness).value).toBe("");
	});

	test("a provider other than the four chips is shown and kept, not replaced by OpenAI", async () => {
		const harness = await start({ configured: false, saved: chatProviderSaved("openrouter") });
		const saved: Array<[string, string]> = [];
		storeKeys(harness, saved, { ok: true, message: "OpenRouter answered." });
		Object.assign(harness.plugin, { getChatProviderId: () => "openrouter" });
		// The card is first on open, because the stage is not ready, whichever provider it is for.
		expect(harness.root.querySelector(".askmate-messages")?.firstElementChild?.querySelector(".askmate-setup-card")).not.toBeNull();
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("OpenRouter");
		expect(Array.from(harness.root.querySelectorAll(".askmate-setup-provider"), (button) => button.textContent)).toEqual(["OpenRouter", "OpenAI", "Anthropic", "Gemini", "Local"]);
		typeKey(harness, "sk-or-v1-abcdefgh");
		await pressConnect(harness);
		expect(saved).toEqual([["openrouter", "sk-or-v1-abcdefgh"]]);
		expect(harness.settings.providerRoles.chatProviderId).toBe("openrouter");
	});

	test("an unconfigured send for such a provider opens the card on that provider", async () => {
		const harness = await start({ configured: false, saved: chatProviderSaved("openrouter") });
		Object.assign(harness.plugin, { getChatProviderId: () => "openrouter" });
		ask(harness, "What is this note about?");
		await send(harness);
		expect(harness.built).toHaveLength(0);
		expect(harness.root.querySelector(".askmate-setup-provider.is-selected")?.textContent).toBe("OpenRouter");
		expect(harness.root.querySelector<HTMLElement>(".askmate-console-segment.is-setup")?.hidden).toBe(false);
	});

	test("a chip picked in an earlier visit does not hide a later gap in the chat provider", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: true, message: "OpenAI answered." });
		chip(harness, "OpenAI")?.click();
		await settle();
		typeKey(harness, "sk-live-abcdefgh");
		await pressConnect(harness);
		const hide = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-setup-actions button")).find((button) => button.textContent === "Hide this card");
		hide?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-setup-card")).toBeNull();
		// The chat provider is changed elsewhere to one that has nothing set up yet.
		harness.settings.selectedTextProvider = "azure-openai";
		harness.settings.providerRoles.chatProviderId = "azure-openai";
		(harness.view as unknown as { refreshSetupCard(): void }).refreshSetupCard();
		expect(harness.root.querySelector(".askmate-setup-title")?.textContent).toBe("Finish setting up Azure OpenAI");
	});

	test("Azure needs more than a key, so the card names it, says what is missing and makes Open settings the main button", async () => {
		const harness = await start({ configured: false, saved: chatProviderSaved("azure-openai") });
		const opened: string[] = [];
		Object.assign(harness.plugin, { openSettingsTab: () => opened.push("settings") });
		expect(harness.root.querySelector(".askmate-setup-title")?.textContent).toBe("Finish setting up Azure OpenAI");
		expect(harness.root.querySelector(".askmate-setup-card p")?.textContent).toContain("Add an API key for Azure OpenAI.");
		expect(harness.root.querySelectorAll(".askmate-setup-key-row input")).toHaveLength(0);
		const buttons = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-setup-actions button"));
		expect(buttons.map((button) => button.textContent)).toEqual(["Open settings"]);
		buttons[0]?.click();
		expect(opened).toEqual(["settings"]);
	});
});

describe("the tips card", () => {
	const tip = (harness: Harness): string => harness.root.querySelector(".askmate-onboarding-card p")?.textContent ?? "";

	for (const layout of ["compact", "expanded"] as const) {
		test(`in the ${layout} layout offers the slash commands and the workflow button, which both work there`, async () => {
			const harness = await start({ layout, saved: { showOnboardingTips: true } });
			expect(tip(harness)).toContain("type / or press the Quick workflows button (the sparkles icon) to run a workflow");
			expect(tip(harness)).toContain("/diagram");
			// What it names exists in this layout.
			expect(harness.root.querySelector(".askmate-workflow-toggle[aria-label=\"Show quick workflows\"]")).not.toBeNull();
		});
	}

	test("in the console layout keeps the slash wording, which the console does run", async () => {
		const harness = await start({ layout: "console", saved: { showOnboardingTips: true } });
		expect(tip(harness)).toContain("type / to run a workflow");
	});
});

describe("a question and its answer", () => {
	test("sends the question, shows the reply, and clears the box only once the request was accepted", async () => {
		const harness = await start();
		ask(harness, "What is this?");
		await send(harness);
		expect(harness.built.map((entry) => entry.question)).toEqual(["What is this?"]);
		expect(harness.ran).toHaveLength(1);
		expect(box(harness).value).toBe("");
		expect(bubbles(harness, "user")).toHaveLength(1);
		expect(bubbles(harness, "assistant")).toHaveLength(1);
		expect(bubbles(harness, "assistant")[0]?.textContent).toContain("An answer.");
	});

	test("QA-14: the question box and every message follow the direction of their text", async () => {
		const harness = await start();
		ask(harness, "جلسه بعدی کی است؟");
		await send(harness);
		expect(box(harness).getAttribute("dir")).toBe("auto");
		for (const body of Array.from(harness.root.querySelectorAll(".askmate-message-body"))) {
			expect(body.getAttribute("dir")).toBe("auto");
		}
	});

	test("QA-05: avatars are decorative, so they carry no aria-label on a plain div", async () => {
		const harness = await start();
		ask(harness, "What is this?");
		await send(harness);
		const avatars = Array.from(harness.root.querySelectorAll<HTMLElement>(".askmate-avatar"));
		expect(avatars.length).toBeGreaterThanOrEqual(2);
		for (const avatar of avatars) {
			expect(avatar.getAttribute("aria-label")).toBeNull();
			expect(avatar.getAttribute("aria-hidden")).toBe("true");
		}
	});

	test("a failure while building the request leaves the typed text in the box", async () => {
		const harness = await start();
		Object.assign(harness.plugin, { buildRequest: () => Promise.reject(new Error("Open a Markdown note or select text to add context.")) });
		ask(harness, "Keep this text");
		await send(harness);
		expect(box(harness).value).toBe("Keep this text");
		expect(harness.ran).toHaveLength(0);
		expect(harness.root.querySelector(".askmate-message-error")?.textContent).toContain("Open a Markdown note");
	});

	test("the finished conversation is saved before the sidebar reports it is ready again", async () => {
		const harness = await start();
		ask(harness, "Save me");
		await send(harness);
		const stored = harness.plugin.threads.getActiveThread() ?? harness.plugin.threads.listThreads()[0];
		expect(stored?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(stored?.messages[0]?.text).toBe("Save me");
	});

	test("D-11: Escape in the question box stops a running request in the Compact layout too", async () => {
		const harness = await start();
		const signals: AbortSignal[] = [];
		harness.run.handler = (_request, runOptions) => new Promise((_resolve, reject) => {
			if (runOptions.abortSignal) {
				signals.push(runOptions.abortSignal);
				runOptions.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			}
		});
		ask(harness, "Long running");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		fireDomEvent(box(harness), "keydown", { key: "Escape" });
		await settle();
		expect(signals[0]?.aborted).toBe(true);
	});

	test("QA-10: a question still waiting when AskMate closes comes back in the box next time, with a word about why", async () => {
		const harness = await start();
		harness.run.handler = () => new Promise(() => undefined);
		ask(harness, "Will this survive a reload?");
		await send(harness);
		await lifecycle(harness.view).closeForTest();
		open = null;
		const stored = harness.fake.app.loadLocalStorage("askmate-pending-question") as { question?: string } | null;
		expect(stored?.question).toBe("Will this survive a reload?");

		const next = await start();
		next.fake.app.saveLocalStorage("askmate-pending-question", { question: "Will this survive a reload?", at: Date.now() });
		(next.view as unknown as { restorePendingQuestion(): void }).restorePendingQuestion();
		expect(box(next).value).toBe("Will this survive a reload?");
		expect(next.root.textContent).toContain("Your last question was not answered before AskMate closed.");
		expect(next.fake.app.loadLocalStorage("askmate-pending-question")).toBeNull();
	});

	test("QA-10: nothing is kept while Remember conversations is off", async () => {
		const harness = await start({ saved: { saveConversations: false } });
		harness.run.handler = () => new Promise(() => undefined);
		ask(harness, "Keep this private");
		await send(harness);
		expect(harness.fake.app.loadLocalStorage("askmate-pending-question")).toBeNull();
	});

	test("QA-10: an old question, or one that would replace what is already typed, is not brought back", async () => {
		const harness = await start();
		const view = harness.view as unknown as { restorePendingQuestion(): void };
		harness.fake.app.saveLocalStorage("askmate-pending-question", { question: "From yesterday", at: Date.now() - 25 * 60 * 60 * 1000 });
		view.restorePendingQuestion();
		expect(box(harness).value).toBe("");
		ask(harness, "Already typing");
		harness.fake.app.saveLocalStorage("askmate-pending-question", { question: "Earlier question", at: Date.now() });
		view.restorePendingQuestion();
		expect(box(harness).value).toBe("Already typing");
		expect(harness.fake.app.loadLocalStorage("askmate-pending-question")).toBeNull();
	});

	test("QA-10: an answered question is forgotten, so nothing comes back after a normal answer", async () => {
		const harness = await start();
		ask(harness, "Answer me");
		await send(harness);
		await settle();
		expect(harness.fake.app.loadLocalStorage("askmate-pending-question")).toBeNull();
	});

	test("a question whose answer has not arrived is not saved on its own", async () => {
		const harness = await start();
		const pending: { release: (() => void) | null } = { release: null };
		harness.run.handler = () => new Promise((resolve) => {
			pending.release = () => resolve(textResult("Late answer"));
		});
		ask(harness, "An earlier question");
		await send(harness);
		pending.release?.();
		await settle();
		harness.run.handler = () => new Promise((resolve) => {
			pending.release = () => resolve(textResult("Late answer"));
		});
		ask(harness, "Slow question");
		await send(harness);
		expect(bubbles(harness, "user")).toHaveLength(2);
		// Closing the sidebar while the second answer is still on its way saves the first turn and leaves the second question out.
		await lifecycle(harness.view).closeForTest();
		open = null;
		const saved = harness.plugin.threads.listThreads()[0];
		expect(saved?.messages.map((message) => message.text)).toEqual(["An earlier question", "Late answer"]);
		pending.release?.();
	});

	test("Stop denies a tool that is waiting for approval and ends the run", async () => {
		const harness = await start();
		const decision: { value: string | null } = { value: null };
		harness.run.handler = async (_request, runOptions) => {
			runOptions.onToolEvent?.({ id: "t1", server: "Notes", tool: "search", status: "pending-approval", argumentsJson: "{\"query\":\"plan\"}" });
			decision.value = (await runOptions.confirmToolCall?.({ id: "t1", server: "Notes", tool: "search", argumentsJson: "{\"query\":\"plan\"}", changedSinceApproval: false })) ?? null;
			return textResult("never shown");
		};
		ask(harness, "Use the tool");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-tool-card.is-pending")).not.toBeNull();
		expect(harness.root.querySelector(".askmate-tool-args")?.textContent).toContain("\"query\": \"plan\"");
		harness.root.querySelector<HTMLButtonElement>(".askmate-stop-button")?.click();
		await settle();
		expect(decision.value).toBe("deny");
		expect(harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.disabled).toBe(false);
	});

	test("a tool call is approved inside the answer and its card stays", async () => {
		const harness = await start();
		harness.run.handler = async (_request, runOptions) => {
			runOptions.onToolEvent?.({ id: "t1", server: "Notes", tool: "search", status: "pending-approval", argumentsJson: "{}" });
			const choice = await runOptions.confirmToolCall?.({ id: "t1", server: "Notes", tool: "search", argumentsJson: "{}", changedSinceApproval: false });
			runOptions.onToolEvent?.({ id: "t1", server: "Notes", tool: "search", status: choice === "deny" ? "denied" : "done", argumentsJson: "{}", resultPreview: "3 notes" });
			return textResult("Found three notes.", { toolCalls: [{ id: "t1", server: "Notes", tool: "search", status: "done", argumentsJson: "{}", resultPreview: "3 notes" }] });
		};
		ask(harness, "Search my notes");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		const allow = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-tool-approval-actions button")).find((button) => button.textContent === "Allow once");
		expect(allow).toBeDefined();
		allow?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-tool-card.is-done")).not.toBeNull();
		expect(harness.root.querySelector(".askmate-tool-result")?.textContent).toBe("3 notes");
		const saved = harness.plugin.threads.listThreads()[0];
		expect(saved?.messages[1]?.tools).toEqual([{ server: "Notes", tool: "search", status: "completed" }]);
	});

	describe("progress text before a tool call", () => {
		function answerBody(harness: Harness): string {
			return harness.root.querySelector(".askmate-message-assistant .askmate-message-body")?.textContent ?? "";
		}

		test("the run is told it may stream, because the sidebar can clear progress text", async () => {
			const harness = await start();
			harness.run.handler = () => Promise.resolve(textResult("Done."));
			ask(harness, "Search my notes");
			await send(harness);
			expect(typeof harness.ran[0]?.options.onTextDelta).toBe("function");
			expect(typeof harness.ran[0]?.options.onTextReset).toBe("function");
		});

		test("text written before a tool call is cleared, so the answer starts clean", async () => {
			const harness = await start();
			const steps: { reset: (() => void) | null; finish: (() => void) | null } = { reset: null, finish: null };
			harness.run.handler = (_request, runOptions) => new Promise((resolve) => {
				runOptions.onTextDelta?.("Checking.");
				steps.reset = () => runOptions.onTextReset?.();
				steps.finish = () => {
					runOptions.onTextDelta?.("We ship on Friday.");
					resolve(textResult("We ship on Friday."));
				};
			});
			ask(harness, "When do we ship?");
			harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
			await wait(260);
			expect(answerBody(harness)).toBe("Checking.");

			// The tool call starts: the narration goes, and nothing of it is left to be glued onto the answer.
			steps.reset?.();
			await wait(260);
			expect(answerBody(harness)).toBe("");

			steps.finish?.();
			await settle();
			expect(answerBody(harness)).toBe("We ship on Friday.");
			expect(harness.plugin.threads.listThreads()[0]?.messages[1]?.text).toBe("We ship on Friday.");
		});

		test("a render that was waiting for the cleared text never draws it", async () => {
			const harness = await start();
			const gate: { release: (() => void) | null } = { release: null };
			harness.run.handler = (_request, runOptions) => new Promise((resolve) => {
				runOptions.onTextDelta?.("Checking.");
				runOptions.onTextReset?.();
				gate.release = () => resolve(textResult("Done."));
			});
			ask(harness, "Look it up");
			harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
			await wait(260);
			expect(MarkdownRenderer.calls.some((call) => call.markdown.includes("Checking."))).toBe(false);
			expect(answerBody(harness)).toBe("");
			gate.release?.();
			await settle();
			expect(answerBody(harness)).toBe("Done.");
		});

		test("the same words written again after a clear are drawn again", async () => {
			const harness = await start();
			const steps: { again: (() => void) | null; finish: (() => void) | null } = { again: null, finish: null };
			harness.run.handler = (_request, runOptions) => new Promise((resolve) => {
				runOptions.onTextDelta?.("Checking.");
				steps.again = () => {
					runOptions.onTextReset?.();
					runOptions.onTextDelta?.("Checking.");
				};
				steps.finish = () => resolve(textResult("Checking."));
			});
			ask(harness, "Look it up");
			harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
			await wait(260);
			expect(answerBody(harness)).toBe("Checking.");

			steps.again?.();
			await wait(260);
			expect(answerBody(harness)).toBe("Checking.");
			steps.finish?.();
			await settle();
		});

		test("Stop after a tool call began leaves no narration behind", async () => {
			const harness = await start();
			harness.run.handler = (_request, runOptions) => new Promise((_resolve, reject) => {
				runOptions.onTextDelta?.("Checking.");
				runOptions.onTextReset?.();
				runOptions.onToolEvent?.({ id: "t1", server: "Notes", tool: "search", status: "running", argumentsJson: "{}" });
				runOptions.abortSignal?.addEventListener("abort", () => reject(new DOMException("The request was stopped.", "AbortError")));
			});
			ask(harness, "Look it up");
			harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
			await wait(260);
			harness.root.querySelector<HTMLButtonElement>(".askmate-stop-button")?.click();
			await settle();
			expect(answerBody(harness)).toBe("Stopped.");
			expect(harness.root.textContent).not.toContain("Checking.");
		});
	});
});

describe("Retry", () => {
	function failOnce(harness: Harness, error: Error): void {
		let calls = 0;
		harness.run.handler = () => {
			calls += 1;
			return calls === 1 ? Promise.reject(error) : Promise.resolve(textResult("Second time lucky."));
		};
	}

	test("starts a new request, replaces the error, and never adds a second copy of the question", async () => {
		const harness = await start();
		failOnce(harness, Object.assign(new Error("Request failed with status 429 rate limit"), { status: 429 }));
		ask(harness, "Why is the sky blue?");
		await send(harness);
		expect(bubbles(harness, "assistant")).toHaveLength(1);
		expect(harness.root.querySelector(".askmate-message-error")).not.toBeNull();
		// Something typed while the error is showing is not touched.
		ask(harness, "a follow-up I was typing");
		harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
		await settle();
		expect(harness.ran).toHaveLength(2);
		expect(bubbles(harness, "user")).toHaveLength(1);
		expect(bubbles(harness, "assistant")).toHaveLength(1);
		expect(harness.root.querySelector(".askmate-message-error")).toBeNull();
		expect(bubbles(harness, "assistant")[0]?.textContent).toContain("Second time lucky.");
		expect(box(harness).value).toBe("a follow-up I was typing");
	});

	test("reuses the built request when nothing changed", async () => {
		const harness = await start();
		failOnce(harness, new Error("Something went wrong"));
		ask(harness, "Same request");
		await send(harness);
		harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
		await settle();
		expect(harness.built).toHaveLength(1);
		expect(harness.ran[1]?.request).toBe(harness.ran[0]?.request);
	});

	test("builds the request again after the model was changed", async () => {
		const harness = await start();
		failOnce(harness, new Error("Something went wrong"));
		ask(harness, "Different model now");
		await send(harness);
		harness.models.name = "gpt-5.5-mini";
		harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
		await settle();
		expect(harness.built).toHaveLength(2);
		expect(harness.ran[1]?.request.metadata.selectedModel).toBe("gpt-5.5-mini");
	});

	test("a rejected key offers Update key next to Retry", async () => {
		const harness = await start();
		failOnce(harness, Object.assign(new Error("Request failed with status 401"), { status: 401 }));
		ask(harness, "Hello");
		await send(harness);
		const error = harness.root.querySelector(".askmate-message-error");
		expect(error?.textContent).toContain("rejected the API key");
		expect(error?.querySelector(".askmate-setup-actions button")?.textContent).toBe("Update key");
		expect(error?.querySelector("button[aria-label=\"Retry request\"]")).not.toBeNull();
	});

	test("a failed question is not saved without an answer", async () => {
		const harness = await start();
		failOnce(harness, new Error("Something went wrong"));
		ask(harness, "Will fail");
		await send(harness);
		await lifecycle(harness.view).closeForTest();
		open = null;
		const saved = harness.plugin.threads.listThreads()[0];
		expect(saved?.messages ?? []).toEqual([]);
	});
});

describe("diagrams", () => {
	const SOURCE = "---\nconfig:\n  theme: base\n---\nflowchart TD\n  A[Start] --> B[End]";

	function diagramResult(status: "valid" | "repaired" | "fallback" = "valid"): RunResult {
		return textResult("Here is the flow.\n\n```mermaid\nflowchart TD\n  A --> B\n```", {
			diagram: { status, kind: "flowchart", style: "blueprint", source: SOURCE, ...(status === "fallback" ? { errors: ["Parse error on line 2"] } : {}) }
		});
	}

	test("/diagram asks for a diagram of the note with the diagram skill and a first look", async () => {
		const harness = await start({ layout: "console" });
		harness.run.handler = () => Promise.resolve(diagramResult());
		ask(harness, "/diagram the login flow");
		await send(harness);
		const request = harness.ran[0]?.request;
		expect(request?.metadata.intentKind).toBe("diagram");
		expect(request?.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 0 });
		expect(request?.question).toBe("the login flow");
		expect(harness.ran[0]?.options.skillSelection?.explicitIds).toContain("built-in:mermaid-diagrams");
		expect(harness.ran[0]?.options.toolsEnabled).toBeUndefined();
	});

	test("draws a card with the five actions, renders only the words in the body, and saves the diagram with the reply", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, {
			loadMermaidApi: () => Promise.resolve({
				parse: () => Promise.resolve({ diagramType: "flowchart" }),
				render: () => Promise.resolve({ svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>drawn</title></svg>" })
			})
		});
		harness.run.handler = () => Promise.resolve(diagramResult());
		ask(harness, "/diagram");
		await send(harness);
		await settle();
		const card = harness.root.querySelector(".askmate-diagram-card");
		expect(card?.classList.contains("is-drawn")).toBe(true);
		expect(card?.querySelector(".askmate-diagram-preview svg")).not.toBeNull();
		expect(Array.from(card?.querySelectorAll(".askmate-diagram-actions button") ?? [], (button) => button.textContent)).toEqual(["Insert at end", "New note", "Copy source", "Another look"]);
		const body = bubbles(harness, "assistant")[0]?.querySelector(".askmate-message-body");
		expect(body?.textContent).toBe("Here is the flow.");
		const saved = harness.plugin.threads.listThreads()[0];
		expect(saved?.messages[1]?.text).toContain("```mermaid");
		expect(saved?.messages[1]?.diagram).toEqual({ type: "flowchart", status: "rendered", recipe: "Blueprint" });
	});

	test("Insert goes through the Apply preview and appends", async () => {
		const harness = await start({ layout: "console" });
		harness.fake.vault.add("A.md", "# A");
		harness.run.handler = () => Promise.resolve(diagramResult());
		const view = openFakeMarkdownView(harness.fake.workspace, harness.fake.vault.getFileByPath("A.md")!, "# A");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = harness.fake.vault.getFileByPath("A.md");
		harness.context.rememberActiveMarkdownContext();
		ask(harness, "/diagram");
		await send(harness);
		await settle();
		const insert = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button")).find((button) => button.textContent === "Insert at end");
		insert?.click();
		await settle();
		expect(harness.applied).toHaveLength(1);
		expect(harness.applied[0]?.scope).toBe("append");
		expect(harness.applied[0]?.text).toContain("```mermaid");
		expect(Notice.messages.at(-1)).toContain("choose Trust");
	});

	test("a diagram that did not draw shows its source, blocks Insert and Apply, and Fix asks again", async () => {
		const harness = await start({ layout: "console" });
		harness.run.handler = () => Promise.resolve(diagramResult("fallback"));
		ask(harness, "/diagram");
		await send(harness);
		const card = harness.root.querySelector(".askmate-diagram-card");
		expect(card?.classList.contains("is-fallback")).toBe(true);
		expect(card?.querySelector(".askmate-diagram-fallback pre")?.textContent).toBe(SOURCE);
		const buttons = Array.from(card?.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button") ?? []);
		expect(buttons.find((button) => button.textContent === "Insert at end")?.disabled).toBe(true);
		harness.run.handler = () => Promise.resolve(diagramResult());
		buttons.find((button) => button.textContent === "Fix")?.click();
		await settle();
		expect(harness.ran).toHaveLength(2);
		expect(harness.ran[1]?.request.question).toContain("Fix this Mermaid diagram");
		expect(harness.ran[1]?.request.question).toContain("Parse error on line 2");
		expect(harness.ran[1]?.request.metadata.intentKind).toBe("diagram");
	});

	for (const mode of ["note", "apply"] as const) {
		test(`a diagram that did not draw is not written in ${mode} mode, and the transcript says so`, async () => {
			const harness = await start({ layout: "console", saved: { outputMode: mode } });
			const notes: string[] = [];
			Object.assign(harness.plugin, { createResultNote: (_request: AskRequest, text: string) => (notes.push(text), Promise.resolve({ path: "AskMate/Result.md" })) });
			harness.run.handler = () => Promise.resolve(diagramResult("fallback"));
			ask(harness, "/diagram");
			await send(harness);
			expect(harness.ran[0]?.request.metadata.outputMode).toBe(mode);
			expect(notes).toEqual([]);
			expect(harness.applied).toEqual([]);
			expect(harness.root.querySelector(".askmate-message-system")?.textContent).toContain("did not draw, so it was not written to a note");
			expect(Notice.messages.at(-1)).toContain("did not draw");
		});

		test(`a diagram that drew is written in ${mode} mode as before`, async () => {
			const harness = await start({ layout: "console", saved: { outputMode: mode } });
			const notes: string[] = [];
			Object.assign(harness.plugin, { createResultNote: (_request: AskRequest, text: string) => (notes.push(text), Promise.resolve({ path: "AskMate/Result.md" })) });
			harness.run.handler = () => Promise.resolve(diagramResult("valid"));
			ask(harness, "/diagram");
			await send(harness);
			expect(mode === "note" ? notes : harness.applied).toHaveLength(1);
		});
	}

	test("Another look re-runs the same request with the next look", async () => {
		const harness = await start({ layout: "console" });
		harness.run.handler = () => Promise.resolve(diagramResult());
		ask(harness, "/diagram");
		await send(harness);
		await settle();
		Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button")).find((button) => button.textContent === "Another look")?.click();
		await settle();
		expect(harness.ran).toHaveLength(2);
		expect(harness.ran[1]?.request.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 1 });
		expect(harness.ran[1]?.request.question).toBe(harness.ran[0]?.request.question);
	});

	test("a plain answer to a diagram request is shown as the words it is, with the usual actions and nothing blocked", async () => {
		const harness = await start({ layout: "console" });
		harness.run.handler = () => Promise.resolve(textResult("The note has no structure to draw, so here is a summary in words."));
		ask(harness, "/diagram");
		await send(harness);
		expect(harness.root.querySelector(".askmate-diagram-card")).toBeNull();
		const body = bubbles(harness, "assistant")[0]?.querySelector(".askmate-message-body");
		expect(body?.textContent).toBe("The note has no structure to draw, so here is a summary in words.");
		expect(MarkdownRenderer.calls.some((call) => call.markdown.includes("```mermaid"))).toBe(false);
		const insert = bubbles(harness, "assistant")[0]?.querySelector<HTMLButtonElement>(".askmate-message-action.is-primary[aria-label=\"Insert\"]");
		expect(insert).not.toBeNull();
		expect(insert?.disabled).toBe(false);
		expect(harness.view.getLastAnswer()?.diagram).toBeUndefined();
	});

	test("a plain answer to a diagram request is still written in note mode", async () => {
		const harness = await start({ layout: "console", saved: { outputMode: "note" } });
		const notes: string[] = [];
		Object.assign(harness.plugin, { createResultNote: (_request: AskRequest, text: string) => (notes.push(text), Promise.resolve({ path: "AskMate/Result.md" })) });
		harness.run.handler = () => Promise.resolve(textResult("A summary in words."));
		ask(harness, "/diagram");
		await send(harness);
		expect(notes).toEqual(["A summary in words."]);
		expect(harness.root.querySelector(".askmate-message-system")?.textContent ?? "").not.toContain("did not draw");
	});

	for (const line of ["/mermaid-diagram", "/skill mermaid-diagrams the login flow", "@skill:mermaid-diagrams the login flow"]) {
		test(`Another look changes the look of a diagram that came from ${line.split(" ")[0]}`, async () => {
			const harness = await start({ layout: "console", skills: "builtin-auto" });
			harness.run.handler = () => Promise.resolve(diagramResult());
			ask(harness, line);
			await send(harness);
			await settle();
			expect(harness.root.querySelector(".askmate-diagram-card")).not.toBeNull();
			Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button")).find((button) => button.textContent === "Another look")?.click();
			await settle();
			expect(harness.ran).toHaveLength(2);
			expect(harness.ran[1]?.request.metadata.diagram?.nonce).toBe(1);
			// And again: the look keeps moving on instead of repeating the second one.
			Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button")).filter((button) => button.textContent === "Another look").at(-1)?.click();
			await settle();
			expect(harness.ran[2]?.request.metadata.diagram?.nonce).toBe(2);
		});
	}

	test("while the diagram is being drawn the reply shows a note instead of the half-written source", async () => {
		const harness = await start({ layout: "console" });
		const pending: { release: (() => void) | null } = { release: null };
		harness.run.handler = (_request, runOptions) => new Promise((resolve) => {
			runOptions.onPhase?.("drawing-diagram");
			runOptions.onTextDelta?.("```mermaid\nflowchart TD\n  A --");
			pending.release = () => resolve(diagramResult());
		});
		ask(harness, "/diagram");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-diagram-placeholder")?.textContent).toBe("Drawing the diagram...");
		expect(MarkdownRenderer.calls.some((call) => call.markdown.includes("flowchart TD"))).toBe(false);
		pending.release?.();
		await settle();
		expect(harness.root.querySelector(".askmate-diagram-placeholder")).toBeNull();
	});

	for (const layout of ["compact", "expanded", "console"] as const) {
		test(`startDiagram draws a diagram of the note in the ${layout} layout and leaves the composer alone`, async () => {
			const harness = await start({ layout });
			harness.run.handler = () => Promise.resolve(diagramResult());
			ask(harness, "a draft that is still being written");

			await harness.view.startDiagram();
			await settle();

			const request = harness.ran[0]?.request;
			expect(harness.ran).toHaveLength(1);
			expect(request?.metadata.intentKind).toBe("diagram");
			expect(request?.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 0 });
			expect(request?.question).toBe(DEFAULT_DIAGRAM_QUESTION);
			expect(harness.ran[0]?.options.skillSelection?.explicitIds).toContain("built-in:mermaid-diagrams");
			expect(harness.root.querySelector(".askmate-diagram-card")).not.toBeNull();
			expect(box(harness).value).toBe("a draft that is still being written");
		});
	}

	test("startDiagram takes what to draw, trimmed", async () => {
		const harness = await start();
		harness.run.handler = () => Promise.resolve(diagramResult());
		await harness.view.startDiagram("  the login flow \n");
		expect(harness.ran[0]?.request.question).toBe("the login flow");
	});

	test("startDiagram says so when diagrams are off, and runs nothing", async () => {
		const harness = await start({ saved: { diagrams: { ...normalizeAskMateSettings({}, "load").diagrams, enabled: false } } });
		await expect(harness.view.startDiagram()).rejects.toThrow("Diagrams are turned off");
		expect(harness.ran).toHaveLength(0);
	});

	test("startDiagram without a connected provider opens the Connect card and keeps the person where they are", async () => {
		const harness = await start({ configured: false });
		await harness.view.startDiagram();
		expect(harness.ran).toHaveLength(0);
		expect(harness.root.querySelector(".askmate-setup-card")).not.toBeNull();
		expect(Notice.messages.at(-1)).toBe("Connect an AI provider before drawing a diagram.");
	});

	test("startDiagram while a request runs does not start a second one", async () => {
		const harness = await start();
		const pending: { release: (() => void) | null } = { release: null };
		harness.run.handler = () => new Promise((resolve) => {
			pending.release = () => resolve(textResult("Done."));
		});
		ask(harness, "A slow question");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();

		await harness.view.startDiagram();

		expect(harness.ran).toHaveLength(1);
		expect(Notice.messages.at(-1)).toBe(BUSY_RUN_MESSAGE);
		pending.release?.();
		await settle();
	});

	test("a diagram request does not offer tools", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, { mcpService: { status: () => [{ id: "a", label: "A", transport: "http", state: { kind: "ready", tools: 2, hidden: 0, era: "x", version: "1", serverName: "S" } }], forgetChat: () => undefined } });
		harness.run.handler = () => Promise.resolve(diagramResult());
		ask(harness, "/diagram");
		await send(harness);
		expect(harness.ran[0]?.options.toolsEnabled).toBeUndefined();
		harness.run.handler = () => Promise.resolve(textResult("ok"));
		ask(harness, "/chat Plain question");
		await send(harness);
		expect(harness.ran[1]?.options.toolsEnabled).toBe(true);
	});
});

describe("starting a conversation from a command", () => {
	for (const layout of ["compact", "expanded", "console"] as const) {
		test(`startNewConversation clears the transcript and says so in the ${layout} layout, with the draft left alone`, async () => {
			const harness = await start({ layout });
			ask(harness, "First question");
			await send(harness);
			expect(bubbles(harness, "user")).toHaveLength(1);
			expect(bubbles(harness, "assistant")).toHaveLength(1);
			ask(harness, "A draft not yet sent");

			await harness.view.startNewConversation();

			expect(bubbles(harness, "user")).toHaveLength(0);
			expect(bubbles(harness, "assistant")).toHaveLength(0);
			expect(harness.root.querySelector(".askmate-console-output .askmate-message-body")?.textContent).toContain("Started a new conversation");
			expect(box(harness).value).toBe("A draft not yet sent");
		});
	}

	test("startNewConversation keeps the old conversation in Saved conversations", async () => {
		const harness = await start();
		ask(harness, "First question");
		await send(harness);
		const before = (harness.plugin.threads as ThreadService).listThreads().length;
		await harness.view.startNewConversation();
		// The next question lands in a conversation of its own.
		ask(harness, "Second question");
		await send(harness);
		expect((harness.plugin.threads as ThreadService).listThreads().length).toBe(before + 1);
	});

	test("startNewConversation refuses, with the reason, while a request is running", async () => {
		const harness = await start();
		const pending: { release: (() => void) | null } = { release: null };
		harness.run.handler = () => new Promise((resolve) => {
			pending.release = () => resolve(textResult("Done."));
		});
		ask(harness, "A slow question");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();

		await expect(harness.view.startNewConversation()).rejects.toThrow("Stop the current request before starting a new conversation.");

		expect(bubbles(harness, "user")).toHaveLength(1);
		pending.release?.();
		await settle();
	});
});

describe("skills", () => {
	test("@skill:name must exist, and the typed text stays when it does not", async () => {
		const harness = await start({ layout: "console" });
		ask(harness, "Summarise this @skill:nonexistent");
		await send(harness);
		expect(harness.ran).toHaveLength(0);
		expect(box(harness).value).toBe("Summarise this @skill:nonexistent");
		expect(harness.root.querySelectorAll(".askmate-console-output.is-error")).toHaveLength(1);
	});

	test("a failure after an early echo does not echo the command twice", async () => {
		const harness = await start({ layout: "console" });
		ask(harness, "/skill nonexistent");
		await send(harness);
		const echoes = Array.from(harness.root.querySelectorAll(".askmate-console-echo .askmate-message-body")).filter((element) => element.textContent === "/skill nonexistent");
		expect(echoes).toHaveLength(1);
		expect(box(harness).value).toBe("/skill nonexistent");
	});
});

describe("sidebar focus", () => {
	test("a question asked from the focused sidebar still sees the note that was open", async () => {
		const harness = await start();
		const note = harness.fake.vault.add("Projects/Plan.md", "# Plan\nAlpha beta gamma");
		const view = openFakeMarkdownView(harness.fake.workspace, note, "# Plan\nAlpha beta gamma");
		(view.editor as FakeEditor).select("beta");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();
		harness.context.rememberEditorContext((view.editor as FakeEditor).asEditor(), note);

		// The person clicks into the sidebar: no Markdown view is active any more.
		harness.fake.workspace.activeView = null;
		harness.fake.workspace.activeFile = null;
		fireDomEvent(harness.root.querySelector(".askmate-sidebar") ?? harness.root, "pointerdown");
		fireDomEvent(box(harness), "focusin");

		ask(harness, "What does this say?");
		await send(harness);
		const request = harness.ran[0]?.request;
		expect(request?.context.file?.path).toBe("Projects/Plan.md");
		expect(request?.context.source).toBe("Selected text");
		expect(request?.context.content).toBe("beta");
	});

	test("Insert at the cursor writes into the remembered note when the sidebar has focus", async () => {
		const harness = await start();
		const note = harness.fake.vault.add("A.md", "# A\n");
		const view = openFakeMarkdownView(harness.fake.workspace, note, "# A\n");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();
		harness.fake.workspace.activeView = null;
		ask(harness, "Write me a line");
		harness.run.handler = () => Promise.resolve(textResult("A new line."));
		await send(harness);
		const insert = harness.root.querySelector<HTMLButtonElement>(".askmate-message-action.is-primary[aria-label=\"Insert\"]");
		insert?.click();
		await settle();
		expect((view.editor as FakeEditor).value).toContain("A new line.");
		expect(Notice.messages.at(-1)).toContain("A.md");
	});
});

describe("links in a reply", () => {
	function clickLink(harness: Harness, attrs: Record<string, string>, classes = "internal-link"): { prevented: boolean } {
		const body = bubbles(harness, "assistant")[0]?.querySelector(".askmate-message-body");
		const link = body?.createEl("a", { cls: classes, text: "link" });
		for (const [name, value] of Object.entries(attrs)) {
			link?.setAttribute(name, value);
		}
		const event = createFakeMouseEvent("click");
		link?.dispatchEvent(event);
		return { prevented: event.defaultPrevented };
	}

	test("a link to a note that does not exist is not opened, so no empty note is created", async () => {
		const harness = await start();
		ask(harness, "Link something");
		await send(harness);
		const result = clickLink(harness, { "data-href": "Made up note", href: "Made up note" });
		expect(result.prevented).toBe(true);
		expect(harness.fake.workspace.openedLinks).toHaveLength(0);
		expect(Notice.messages.at(-1)).toContain("Made up note");
	});

	test("a link to a note that exists opens it", async () => {
		const harness = await start();
		harness.fake.vault.add("Plan.md", "# Plan");
		ask(harness, "Link something");
		await send(harness);
		clickLink(harness, { "data-href": "Plan", href: "Plan" });
		expect(harness.fake.workspace.openedLinks.map((link) => link.linktext)).toEqual(["Plan"]);
	});

	test("a link that could trigger another app is stopped in the capture phase", async () => {
		const harness = await start();
		ask(harness, "Link something");
		await send(harness);
		let reachedOthers = false;
		const body = bubbles(harness, "assistant")[0]?.querySelector(".askmate-message-body");
		const link = body?.createEl("a", { cls: "external-link", text: "evil" });
		link?.setAttribute("href", "obsidian://new?vault=V&name=x");
		link?.addEventListener("click", () => {
			reachedOthers = true;
		});
		const event = createFakeMouseEvent("click");
		link?.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(reachedOthers).toBe(false);
		expect(Notice.messages.at(-1)).toBe("AskMate does not open this kind of link from an answer.");
	});

	test("a web link keeps its normal behaviour", async () => {
		const harness = await start();
		ask(harness, "Link something");
		await send(harness);
		const result = clickLink(harness, { href: "https://example.com" }, "external-link");
		expect(result.prevented).toBe(false);
	});
});

describe("conversation handling", () => {
	test("Clear chat starts a new conversation and keeps the old one saved", async () => {
		const harness = await start();
		ask(harness, "First question");
		await send(harness);
		harness.root.querySelector<HTMLButtonElement>(".askmate-clear-button")?.click();
		await settle(10);
		expect(bubbles(harness, "user")).toHaveLength(0);
		expect(harness.plugin.threads.listThreads().some((thread) => thread.messages.some((message) => message.text === "First question"))).toBe(true);
	});

	test("deleting the saved conversations in settings clears the open conversation", async () => {
		const harness = await start();
		ask(harness, "To be deleted");
		await send(harness);
		expect(bubbles(harness, "user")).toHaveLength(1);
		await harness.plugin.threads.clearAll();
		await settle();
		expect(bubbles(harness, "user")).toHaveLength(0);
		expect(harness.plugin.threads.listThreads()).toEqual([]);
		// The next save must not bring the deleted text back.
		await lifecycle(harness.view).closeForTest();
		open = null;
		expect(harness.plugin.threads.listThreads().flatMap((thread) => thread.messages)).toEqual([]);
	});

	test("a second sidebar is closed so the first one's conversation is not overwritten", async () => {
		const harness = await start();
		const existing = new WorkspaceLeaf(harness.fake.app);
		existing.view = harness.view;
		Object.assign(harness.fake.workspace, { leaves: [{ view: harness.view, getViewState: () => ({ type: "askmate-sidebar-view" }), detach: () => undefined }] });
		let revealed = 0;
		Object.assign(harness.fake.workspace, { revealLeaf: () => { revealed += 1; return Promise.resolve(); } });
		const second = new WorkspaceLeaf(harness.fake.app);
		const secondView = new AskMateView(second as never, harness.plugin);
		await lifecycle(secondView).openForTest();
		expect(second.detached).toBe(true);
		expect(revealed).toBe(1);
		expect(secondView.containerEl.querySelector(".askmate-composer")).toBeNull();
	});

	test("Edit on a question never overwrites a draft; the draft can be restored", async () => {
		const harness = await start();
		ask(harness, "Original question");
		await send(harness);
		ask(harness, "my unfinished thought");
		harness.root.querySelector<HTMLButtonElement>(".askmate-message-user button[aria-label=\"Edit\"]")?.click();
		expect(box(harness).value).toBe("my unfinished thought\n\n---\n\nOriginal question");
		const undo = harness.root.querySelector<HTMLButtonElement>(".askmate-draft-undo button");
		expect(undo).not.toBeNull();
		undo?.click();
		expect(box(harness).value).toBe("my unfinished thought");
	});

	test("a note output mode is spent by the request that uses it", async () => {
		const harness = await start({ saved: { outputMode: "note" } });
		ask(harness, "Make a note of this");
		await send(harness);
		expect(harness.ran[0]?.request.metadata.outputMode).toBe("note");
		expect(harness.settings.outputMode).toBe("chat");
	});

	test("the reply has three visible actions and a menu with the rest", async () => {
		const harness = await start();
		const note = harness.fake.vault.add("A.md", "# A");
		const view = openFakeMarkdownView(harness.fake.workspace, note, "# A");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();
		ask(harness, "Say something");
		await send(harness);
		const message = bubbles(harness, "assistant")[0];
		const primary = Array.from(message?.querySelectorAll(".askmate-message-action.is-primary") ?? [], (button) => button.getAttribute("aria-label"));
		expect(primary).toEqual(["Insert", "Copy", "Apply"]);
		message?.querySelector<HTMLButtonElement>(".askmate-message-action-more")?.click();
		const menu = Menu.lastMenu;
		expect(menu?.shown).toBe(true);
		expect(menu?.items.map((item) => item.title)).toEqual([
			"Show reply text",
			"Use reply as a new question",
			"Queue for review",
			"Save as new note",
			"Replace the whole note",
			"Apply to a heading"
		]);
		expect(menu?.separators).toBe(1);
	});

	test("the transcript is a labelled, focusable region and the status element is separate", async () => {
		const harness = await start();
		const transcript = harness.root.querySelector(".askmate-messages");
		expect(transcript?.getAttribute("role")).toBe("region");
		// QA-18: named through a hidden label, because Obsidian turns an aria-label into a tooltip.
		const labelId = transcript?.getAttribute("aria-labelledby") ?? "";
		expect(harness.root.querySelector(`[id="${labelId}"]`)?.textContent).toBe("AskMate conversation");
		expect(transcript?.hasAttribute("aria-label")).toBe(false);
		expect(transcript?.getAttribute("tabindex")).toBe("0");
		expect(transcript?.hasAttribute("aria-live")).toBe(false);
		const status = harness.root.querySelector("[role=\"status\"]");
		expect(status?.getAttribute("aria-live")).toBe("polite");
		ask(harness, "Announce me");
		await send(harness);
		expect(harness.root.querySelector(".askmate-visually-hidden[role=\"status\"]")?.textContent).toContain("AskMate finished a reply");
	});
});

const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const typeInto = async (harness: Harness, text: string): Promise<void> => {
	ask(harness, text);
	// The skill suggestion waits a moment after typing stops.
	await wait(380);
};

async function trustVaultSkills(harness: Harness): Promise<void> {
	for (const skill of harness.skills.service.list().filter((entry) => entry.source === "vault")) {
		await harness.skills.service.trust(skill.id, skill.hash);
	}
}

describe("skills in the sidebar", () => {
	test("/skills lists the skills, with their status, and says how to use one", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		ask(harness, "/skills");
		await send(harness);
		const output = harness.root.querySelector(".askmate-console-output .askmate-message-body")?.textContent ?? "";
		expect(output).toContain("mermaid-diagrams");
		expect(output).toContain("built in");
		expect(output).toContain("meeting-notes");
		expect(output).toContain("needs review");
		expect(output).toContain("/skill <name>");
	});

	test("/skill name keeps a skill on for the conversation, shows its chip and is sent with every question", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto" });
		ask(harness, "/skill mermaid-diagrams");
		await send(harness);
		const chip = harness.root.querySelector(".askmate-skill-chips .askmate-skill-chip.is-active");
		expect(chip).not.toBeNull();
		expect(harness.root.querySelector(".askmate-console-segment.is-skills")?.textContent).toBe("1 skill");
		ask(harness, "What is this note?");
		await send(harness);
		expect(harness.ran[0]?.options.skillSelection).toEqual({ explicitIds: [], stickyIds: ["built-in:mermaid-diagrams"], autoEnabled: true });
		const saved = harness.plugin.threads.listThreads()[0];
		expect(saved?.skillIds).toEqual(["built-in:mermaid-diagrams"]);
		// Clicking the chip turns it off again.
		(chip as HTMLElement | null)?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-skill-chips .askmate-skill-chip")).toBeNull();
	});

	test("@skill:name applies a skill to one question only", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto" });
		ask(harness, "@skill:mermaid-diagrams What is this note?");
		await send(harness);
		expect(harness.ran[0]?.options.skillSelection?.explicitIds).toEqual(["built-in:mermaid-diagrams"]);
		expect(harness.ran[0]?.request.question).toBe("What is this note?");
		ask(harness, "And now?");
		await send(harness);
		expect(harness.ran[1]?.options.skillSelection?.explicitIds).toEqual([]);
	});

	test("the request is built with the skills the run carries, so the size check and the inspector see their text", async () => {
		const harness = await start({ skills: "builtin-auto" });
		harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker")?.click();
		Menu.lastMenu?.items.find((item) => item.title === "Mermaid diagrams")?.click();
		await settle();
		ask(harness, "Draw the process");
		await send(harness);
		expect(harness.built[0]?.options.skillSelection).toEqual({ explicitIds: [], stickyIds: ["built-in:mermaid-diagrams"], autoEnabled: true });
		expect(harness.built[0]?.options.skillSelection).toEqual(harness.ran[0]?.options.skillSelection);
	});

	test("a skill named with @skill: is built into that question's request, and into no other", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto" });
		ask(harness, "@skill:mermaid-diagrams What is this note?");
		await send(harness);
		expect(harness.built[0]?.options.skillSelection?.explicitIds).toEqual(["built-in:mermaid-diagrams"]);
		ask(harness, "And now?");
		await send(harness);
		expect(harness.built[1]?.options.skillSelection?.explicitIds).toEqual([]);
	});

	test("a chip is built into the request and used up by it", async () => {
		const harness = await start({ skills: "suggest", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		await trustVaultSkills(harness);
		await typeInto(harness, "Please summarise this meeting and list the action items");
		harness.root.querySelector<HTMLButtonElement>(".askmate-skill-chip.is-suggested")?.click();
		await settle();
		await send(harness);
		expect(harness.built[0]?.options.skillSelection?.explicitIds).toEqual(["vault:meeting-notes"]);
		expect(harness.ran[0]?.options.skillSelection).toEqual(harness.built[0]?.options.skillSelection);
		expect(harness.root.querySelector(".askmate-skill-chip")).toBeNull();
	});

	test("Inspect prompt and the request preview read the skills the question will carry, and use up no chip", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto", saved: { showRequestPreview: true } });
		const inspected: Array<{ question: string; skillSelection: unknown }> = [];
		Object.assign(harness.plugin, {
			inspectFinalPrompt: (question: string, _title: string, options: { skillSelection?: unknown }) => {
				inspected.push({ question, skillSelection: options.skillSelection });
				return Promise.reject(new Error("preview only"));
			}
		});
		ask(harness, "/skill mermaid-diagrams");
		await send(harness);
		ask(harness, "@skill:mermaid-diagrams What is this note?");
		await wait(300);
		expect(inspected.at(-1)?.skillSelection).toEqual({ explicitIds: ["built-in:mermaid-diagrams"], stickyIds: [], autoEnabled: true });
		ask(harness, "What is this note?");
		await wait(300);
		expect(inspected.at(-1)?.skillSelection).toEqual({ explicitIds: [], stickyIds: ["built-in:mermaid-diagrams"], autoEnabled: true });
		const before = inspected.length;
		ask(harness, "/inspect @skill:mermaid-diagrams What is this note?");
		await send(harness);
		expect(inspected.length).toBeGreaterThan(before);
		expect(inspected.at(-1)?.skillSelection).toEqual({ explicitIds: ["built-in:mermaid-diagrams"], stickyIds: [], autoEnabled: true });
	});

	test("the request preview calls the previous conversation earlier turns, not an attachment", async () => {
		const harness = await start({ layout: "console", saved: { showRequestPreview: true } });
		const attachment = (kind: string, content: string): unknown => ({ kind, title: kind, sourcePath: `${kind}.md`, content, originalCharacters: content.length, finalCharacters: content.length, truncated: false });
		Object.assign(harness.plugin, {
			inspectFinalPrompt: () => Promise.resolve({
				request: {
					context: {
						source: "Current note",
						file: { path: "Plan.md" },
						attachments: [attachment("thread_history", "Chat history.\n\nUser: First\nAskMate: One\nUser: Second\nAskMate: Two"), attachment("vault_note", "Other note")]
					},
					metadata: { privacy: { includeNoteContext: true }, outputMode: "chat", contextTruncated: false, promptContextCharacters: 120, contextCharacters: 120 }
				},
				blockers: [],
				warnings: [],
				providerName: "OpenAI",
				model: "gpt-5.5",
				estimatedInputTokens: 30
			})
		});
		ask(harness, "What is this note?");
		await wait(300);
		const summary = harness.root.querySelector(".askmate-request-preview-summary")?.textContent ?? "";
		expect(summary).toContain("1 attachment, 2 earlier turns");
		expect(summary).not.toContain("2 attachments");
		// D-06: plain words a B1 reader can follow, instead of "input tokens" and "context chars".
		expect(summary).toContain("Answer goes to: Chat");
		expect(summary).toContain("about 30 tokens to send (word pieces the provider counts)");
		expect(summary).toContain("120 characters from your notes");
		expect(summary).not.toContain("context chars");
	});

	test("a skill that needs review is refused with a sentence that says what to do, and nothing is sent", async () => {
		const harness = await start({ layout: "console", skills: "builtin-auto", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		ask(harness, "@skill:meeting-notes Summarise");
		await send(harness);
		expect(harness.ran).toHaveLength(0);
		expect(harness.root.querySelector(".askmate-console-output.is-error")?.textContent).toContain("needs your review");
		expect(box(harness).value).toBe("@skill:meeting-notes Summarise");
	});

	test("a matching skill is suggested as one chip, used for the next question only when chosen", async () => {
		const harness = await start({ skills: "suggest", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		await trustVaultSkills(harness);
		await typeInto(harness, "Please summarise this meeting and list the action items");
		const suggestion = harness.root.querySelector<HTMLButtonElement>(".askmate-skill-chip.is-suggested");
		expect(suggestion?.textContent).toBe("Meeting notes?");
		suggestion?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-skill-chip.is-suggested")).toBeNull();
		expect(harness.root.querySelector(".askmate-skill-chip.is-active")?.textContent).toBe("Meeting notes");
		await send(harness);
		expect(harness.ran[0]?.options.skillSelection?.explicitIds).toEqual(["vault:meeting-notes"]);
		// Used up by the question it was chosen for.
		expect(harness.root.querySelector(".askmate-skill-chip")).toBeNull();
	});

	test("Retry runs the question with the skill that was chosen for it with a chip, and the chip stays used up", async () => {
		const harness = await start({ skills: "suggest", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		await trustVaultSkills(harness);
		let calls = 0;
		harness.run.handler = () => {
			calls += 1;
			return calls === 1 ? Promise.reject(new Error("Something went wrong")) : Promise.resolve(textResult("Second time lucky."));
		};
		await typeInto(harness, "Please summarise this meeting and list the action items");
		harness.root.querySelector<HTMLButtonElement>(".askmate-skill-chip.is-suggested")?.click();
		await settle();
		await send(harness);
		expect(harness.ran[0]?.options.skillSelection?.explicitIds).toEqual(["vault:meeting-notes"]);
		expect(harness.root.querySelector(".askmate-skill-chip")).toBeNull();
		harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
		await settle();
		expect(harness.ran).toHaveLength(2);
		expect(harness.ran[1]?.options.skillSelection?.explicitIds).toEqual(["vault:meeting-notes"]);
		expect(harness.root.querySelector(".askmate-skill-chip")).toBeNull();
	});

	test("Retry runs the question with a skill kept on from the picker as well", async () => {
		const harness = await start({ skills: "builtin-auto" });
		let calls = 0;
		harness.run.handler = () => {
			calls += 1;
			return calls === 1 ? Promise.reject(new Error("Something went wrong")) : Promise.resolve(textResult("Second time lucky."));
		};
		harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker")?.click();
		Menu.lastMenu?.items.find((item) => item.title === "Mermaid diagrams")?.click();
		await settle();
		ask(harness, "Draw the process");
		await send(harness);
		harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
		await settle();
		expect(harness.ran.map((entry) => entry.options.skillSelection?.stickyIds)).toEqual([["built-in:mermaid-diagrams"], ["built-in:mermaid-diagrams"]]);
	});

	test("a reply that used a skill on its own is badged, and can be run again without it", async () => {
		const harness = await start({ skills: "builtin-auto" });
		harness.run.handler = () => Promise.resolve(textResult("A diagram-ish answer.", {
			skillsUsed: [{ id: "built-in:mermaid-diagrams", name: "mermaid-diagrams", source: "built-in", channel: "auto" }]
		}));
		ask(harness, "Draw the process");
		await send(harness);
		expect(harness.root.querySelector(".askmate-skill-badge")?.textContent).toBe("Skill: mermaid-diagrams");
		harness.run.handler = () => Promise.resolve(textResult("Plain answer."));
		bubbles(harness, "assistant")[0]?.querySelector<HTMLButtonElement>(".askmate-message-action-more")?.click();
		Menu.lastMenu?.items.find((item) => item.title === "Run again without skill")?.click();
		await settle();
		expect(harness.ran).toHaveLength(2);
		expect(harness.ran[1]?.options.skillSelection?.autoEnabled).toBe(false);
	});

	test("the skill picker lists skills, marks the ones that are on, and cannot pick one that needs review", async () => {
		const harness = await start({ skills: "builtin-auto", skillFiles: { "meeting-notes.md": MEETING_SKILL } });
		const picker = harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker");
		expect(picker?.hidden).toBe(false);
		picker?.click();
		const menu = Menu.lastMenu;
		const titles = menu?.items.map((item) => item.title);
		expect(titles).toContain("Mermaid diagrams");
		expect(titles).toContain("Meeting notes (needs review)");
		expect(menu?.items.find((item) => item.title.startsWith("Meeting notes"))?.disabled).toBe(true);
		expect(titles?.at(-1)).toBe("Manage skills in settings");
		menu?.items.find((item) => item.title === "Mermaid diagrams")?.click();
		await settle();
		expect(harness.root.querySelector(".askmate-skill-chip.is-active")).not.toBeNull();
	});

	test("the picker is hidden when skills are turned off", async () => {
		const harness = await start({ saved: { skills: { ...normalizeAskMateSettings({}, "load").skills, enabled: false } } });
		expect(harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker")?.hidden).toBe(true);
	});

	test("the picker is shown when skills are on", async () => {
		const harness = await start();
		expect(harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker")?.hidden).toBe(false);
	});
});

describe("tools and status", () => {
	test("/mcp says that tools are off when no server is set up", async () => {
		const harness = await start({ layout: "console" });
		ask(harness, "/mcp");
		await send(harness);
		expect(harness.root.querySelector(".askmate-console-output .askmate-message-body")?.textContent).toContain("Tools are off by default");
	});

	test("/mcp lists the servers, and the status line shows how many tools are ready", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, {
			mcpService: {
				status: () => [{ id: "files", label: "Files", transport: "http", state: { kind: "ready", tools: 2, hidden: 0, era: "x", version: "1", serverName: "S" } }],
				forgetChat: () => undefined
			}
		});
		ask(harness, "/mcp");
		await send(harness);
		expect(harness.root.querySelector(".askmate-console-output .askmate-message-body")?.textContent).toContain("ready, 2 tools");
		expect(harness.root.querySelector(".askmate-console-segment.is-mcp")?.textContent).toBe("tools 2");
	});

	test("tools are offered on a chat question and the run is told so", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, {
			mcpService: { status: () => [{ id: "files", label: "Files", transport: "http", state: { kind: "idle" } }], forgetChat: () => undefined }
		});
		ask(harness, "What notes mention the budget?");
		await send(harness);
		expect(harness.ran[0]?.options.toolsEnabled).toBe(true);
		harness.settings.outputMode = "apply";
		ask(harness, "Rewrite the intro");
		await send(harness);
		expect(harness.ran[1]?.options.toolsEnabled).toBeUndefined();
	});

	test("Stop aborts the signal the plugin hands to the tool calls", async () => {
		const harness = await start();
		const signals: AbortSignal[] = [];
		harness.run.handler = (_request, runOptions) => new Promise((_resolve, reject) => {
			if (runOptions.abortSignal) {
				signals.push(runOptions.abortSignal);
				runOptions.abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			}
		});
		ask(harness, "Long running");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		harness.root.querySelector<HTMLButtonElement>(".askmate-stop-button")?.click();
		await settle();
		expect(signals[0]?.aborted).toBe(true);
		expect(harness.root.querySelector(".askmate-send-button")?.hasAttribute("disabled")).toBe(false);
	});

	test("/test reports a good connection in one line, and a bad one with the card that fixes it", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, { testProviderConnectionDetailed: () => Promise.resolve({ ok: true, message: "Fine.", modelFound: true }) });
		ask(harness, "/test");
		await send(harness);
		expect(harness.root.querySelector(".askmate-console-output .askmate-message-body")?.textContent).toBe("Connected to OpenAI.");
		Object.assign(harness.plugin, { testProviderConnectionDetailed: () => Promise.resolve({ ok: false, message: "HTTP 401 invalid api key", modelFound: null }) });
		ask(harness, "/test");
		await send(harness);
		const outputs = harness.root.querySelectorAll(".askmate-console-output.is-error");
		expect(outputs[0]?.textContent).toContain("rejected the API key");
		expect(harness.root.querySelector(".askmate-setup-error button")?.textContent).toBe("Update key");
	});

	test("the output mode badge shows whenever the mode is not chat", async () => {
		const harness = await start({ saved: { outputMode: "apply" } });
		const badge = harness.root.querySelector<HTMLElement>(".askmate-output-badge");
		expect(badge?.hidden).toBe(false);
		expect(badge?.textContent).toBe("Next answer: apply to note");
		const chat = await createHarness();
		expect(chat.root.querySelector<HTMLElement>(".askmate-output-badge")?.hidden).toBe(true);
		await lifecycle(chat.view).closeForTest();
	});
});

describe("streaming, images and focus", () => {
	test("a diagram fence that is still open shows a note and is drawn once, when the reply ends", async () => {
		const harness = await start();
		const gate: { release: (() => void) | null } = { release: null };
		harness.run.handler = (_request, runOptions) => new Promise((resolve) => {
			runOptions.onTextDelta?.("Here you go.\n\n```mermaid\nflowchart TD\n  A --> B");
			gate.release = () => resolve(textResult("Here you go.\n\n```mermaid\nflowchart TD\n  A --> B\n```"));
		});
		ask(harness, "Draw it in the reply");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await wait(260);
		expect(harness.root.querySelector(".askmate-diagram-placeholder")?.textContent).toBe("Drawing the diagram...");
		expect(MarkdownRenderer.calls.some((call) => call.markdown.includes("flowchart TD"))).toBe(false);
		gate.release?.();
		await settle();
		expect(harness.root.querySelector(".askmate-diagram-placeholder")).toBeNull();
		expect(MarkdownRenderer.calls.filter((call) => call.markdown.includes("flowchart TD"))).toHaveLength(1);
	});

	test("pictures a note links to are previewed only after /images on, and not for the word diagram", async () => {
		const harness = await start({ layout: "console" });
		const note = harness.fake.vault.add("Pics.md", "![chart](data:image/png;base64,AAAA)");
		const view = openFakeMarkdownView(harness.fake.workspace, note, "![chart](data:image/png;base64,AAAA)");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();

		ask(harness, "Show me the image");
		await send(harness);
		expect(harness.root.querySelector(".askmate-context-image-preview")).toBeNull();

		ask(harness, "/images on");
		await send(harness);
		expect(harness.fake.localStorage.get("askmate-image-previews")).toBe("on");
		ask(harness, "Draw a diagram of this");
		await send(harness);
		expect(harness.root.querySelector(".askmate-context-image-preview")).toBeNull();
		ask(harness, "Show me the image");
		await send(harness);
		expect(harness.root.querySelector(".askmate-context-image-preview")).not.toBeNull();

		ask(harness, "/images off");
		await send(harness);
		expect(harness.fake.localStorage.has("askmate-image-previews")).toBe(false);
	});

	test("the keyboard focus goes back to the box when the control that had it is disabled by a running request", async () => {
		const harness = await start();
		const gate: { release: (() => void) | null } = { release: null };
		harness.run.handler = () => new Promise((resolve) => {
			gate.release = () => resolve(textResult("Done."));
		});
		ask(harness, "Take your time");
		const sendButton = harness.root.querySelector<HTMLButtonElement>(".askmate-send-button");
		sendButton?.focus();
		expect(activeDocument.activeElement).toBe(sendButton);
		sendButton?.click();
		await settle();
		expect(sendButton?.disabled).toBe(true);
		expect(activeDocument.activeElement).toBe(box(harness));
		gate.release?.();
		await settle();
	});

	test("with no note open a question is still answered, and applying the reply says why it is off", async () => {
		const harness = await start();
		ask(harness, "Tell me a joke");
		await send(harness);
		expect(harness.built[0]?.options).toMatchObject({ allowNoNote: true });
		const apply = bubbles(harness, "assistant")[0]?.querySelector<HTMLButtonElement>(".askmate-message-action.is-primary[aria-label=\"Apply\"]");
		expect(apply?.disabled).toBe(true);
		expect(apply?.getAttribute("title")).toBe("Apply. Open a note to apply this reply to it.");
	});

	test("the preview for a workflow command names the workflow and Inspect prompt reads the same thing", async () => {
		const harness = await start({ layout: "console", saved: { showRequestPreview: true } });
		const inspected: Array<{ question: string; title: string }> = [];
		Object.assign(harness.plugin, {
			inspectFinalPrompt: (question: string, title: string) => {
				inspected.push({ question, title });
				return Promise.reject(new Error("preview only"));
			}
		});
		ask(harness, "/summarise focus on dates");
		await wait(300);
		expect(inspected.at(-1)?.title).toBe("Study summary");
		ask(harness, "/model");
		await wait(300);
		expect(harness.root.querySelector(".askmate-request-preview-summary")?.textContent).toBe("This is a command, not a question. Press Enter to run it.");
	});
});

describe("keeping the keyboard where it was", () => {
	test("the model button in the status line keeps its focus while the line refreshes", async () => {
		const harness = await start({ layout: "console" });
		const modelButton = harness.root.querySelector<HTMLButtonElement>(".askmate-console-segment.is-model");
		modelButton?.focus();
		expect(activeDocument.activeElement).toBe(modelButton);
		// Every click and focus change refreshes the status line.
		fireDomEvent(harness.root.querySelector(".askmate-sidebar") ?? harness.root, "pointerdown");
		fireDomEvent(modelButton!, "focusin");
		expect(harness.root.querySelector(".askmate-console-segment.is-model")).toBe(modelButton);
		expect(activeDocument.activeElement).toBe(modelButton);
	});

	test("Retry can fail again and be tried a third time", async () => {
		const harness = await start();
		let calls = 0;
		harness.run.handler = () => {
			calls += 1;
			return calls < 3 ? Promise.reject(new Error("Still failing")) : Promise.resolve(textResult("Third time."));
		};
		ask(harness, "Persist");
		await send(harness);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]")?.click();
			await settle();
		}
		expect(harness.ran).toHaveLength(3);
		expect(bubbles(harness, "user")).toHaveLength(1);
		expect(harness.root.querySelectorAll(".askmate-message-error")).toHaveLength(0);
		expect(bubbles(harness, "assistant")[0]?.textContent).toContain("Third time.");
	});

	test("the Retry button that had the focus hands it to the box when its error goes away", async () => {
		const harness = await start();
		let calls = 0;
		harness.run.handler = () => {
			calls += 1;
			return calls === 1 ? Promise.reject(new Error("Boom")) : Promise.resolve(textResult("Fine."));
		};
		ask(harness, "Focus test");
		await send(harness);
		const retry = harness.root.querySelector<HTMLButtonElement>("button[aria-label=\"Retry request\"]");
		retry?.focus();
		retry?.click();
		await settle();
		expect(activeDocument.activeElement).toBe(box(harness));
	});
});

describe("choosing Cancel at the size warning", () => {
	test("is not reported as a failure, and the typed text stays in the box", async () => {
		const harness = await start();
		Object.assign(harness.plugin, { confirmUsageGuardrails: () => Promise.reject(new Error("AskMate request cancelled by usage guardrails.")) });
		ask(harness, "A very large request");
		await send(harness);
		expect(harness.ran).toHaveLength(0);
		expect(box(harness).value).toBe("A very large request");
		expect(harness.root.querySelector(".askmate-message-error")).toBeNull();
		expect(bubbles(harness, "assistant")[0]?.textContent).toContain("Not sent. You chose not to continue after the size warning.");
		expect(harness.root.querySelector("button[aria-label=\"Retry request\"]")).not.toBeNull();
	});
});

describe("a saved conversation with a diagram", () => {
	test("is drawn again when the sidebar reopens, and its header is not shown as code", async () => {
		const harness = await start({ layout: "console" });
		const source = assembleDiagram("flowchart TD\n  A[Start] --> B[End]", "flowchart", designFromRecipe(STYLE_RECIPES[0]!, 7));
		harness.run.handler = () => Promise.resolve(textResult("Here is the flow.", { diagram: { status: "valid", kind: "flowchart", style: "blueprint", source } }));
		ask(harness, "/diagram");
		await send(harness);
		await lifecycle(harness.view).closeForTest();
		MarkdownRenderer.reset();

		const reopened = new AskMateView(new WorkspaceLeaf(harness.fake.app) as never, harness.plugin);
		activeDocument.body.appendChild(reopened.containerEl);
		await lifecycle(reopened).openForTest();
		await settle();
		const restored = MarkdownRenderer.calls.find((call) => call.markdown.includes("Here is the flow."));
		expect(restored?.markdown).toContain("```mermaid");
		expect(restored?.markdown).not.toContain("```text");
		expect(restored?.markdown).toContain("flowchart TD");
		await lifecycle(reopened).closeForTest();
		reopened.containerEl.remove();
		open = null;
		harness.root.remove();
	});

	/** Runs /diagram in a harness that has a note open, then reopens the sidebar so the reply is a restored one. */
	async function reopenWithDiagram(status: "valid" | "fallback"): Promise<{ reopened: InstanceType<typeof AskMateView>; editor: FakeEditor; harness: Harness }> {
		const harness = await start({ layout: "console" });
		const note = harness.fake.vault.add("A.md", "# A\n");
		const view = openFakeMarkdownView(harness.fake.workspace, note, "# A\n");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = note;
		harness.context.rememberActiveMarkdownContext();
		const source = assembleDiagram("flowchart TD\n  A[Start] --> B[End]", "flowchart", designFromRecipe(STYLE_RECIPES[0]!, 7));
		harness.run.handler = () => Promise.resolve(textResult("Here is the flow.", {
			diagram: { status, kind: "flowchart", style: "blueprint", source, ...(status === "fallback" ? { errors: ["Parse error on line 2"] } : {}) }
		}));
		ask(harness, "/diagram");
		await send(harness);
		await lifecycle(harness.view).closeForTest();
		harness.fake.workspace.activeView = null;
		const reopened = new AskMateView(new WorkspaceLeaf(harness.fake.app) as never, harness.plugin);
		activeDocument.body.appendChild(reopened.containerEl);
		await lifecycle(reopened).openForTest();
		await settle();
		return { reopened, editor: view.editor as FakeEditor, harness };
	}

	async function closeReopened(reopened: InstanceType<typeof AskMateView>, harness: Harness): Promise<void> {
		await lifecycle(reopened).closeForTest();
		reopened.containerEl.remove();
		open = null;
		harness.root.remove();
	}

	test("Insert on a restored diagram writes its fence as it is, without asking about active content", async () => {
		const { reopened, editor, harness } = await reopenWithDiagram("valid");
		const insert = reopened.containerEl.querySelector<HTMLButtonElement>(".askmate-message-action.is-primary[aria-label=\"Insert\"]");
		expect(insert?.disabled).toBe(false);
		insert?.click();
		await settle();
		expect(editor.value).toContain("```mermaid");
		expect(editor.value).not.toContain("```text");
		expect(editor.value).toContain("flowchart TD");
		await closeReopened(reopened, harness);
	});

	test("Insert at the cursor on the newest reply, as the palette does, keeps the diagram fence", async () => {
		const { reopened, editor, harness } = await reopenWithDiagram("valid");
		const answer = reopened.getLastAnswer();
		expect(answer?.diagram).toBe("drawn");
		const { insertAnswerIntoEditor } = await import("../src/ui/sidebar/answerShell");
		insertAnswerIntoEditor(editor.asEditor(), answer);
		expect(editor.value).toContain("```mermaid");
		expect(editor.value).not.toContain("```text");
		await closeReopened(reopened, harness);
	});

	test("a restored diagram that did not draw has no Insert, and the palette inserts it only as text", async () => {
		const { reopened, editor, harness } = await reopenWithDiagram("fallback");
		const insert = reopened.containerEl.querySelector<HTMLButtonElement>(".askmate-message-action.is-primary[aria-label=\"Insert\"]");
		expect(insert?.disabled).toBe(true);
		expect(insert?.getAttribute("title")).toContain("did not draw");
		const answer = reopened.getLastAnswer();
		expect(answer?.diagram).toBe("fallback");
		const { insertAnswerIntoEditor } = await import("../src/ui/sidebar/answerShell");
		insertAnswerIntoEditor(editor.asEditor(), answer);
		expect(editor.value).not.toContain("```mermaid");
		await closeReopened(reopened, harness);
	});
});


describe("tool approval and chat grants", () => {
	async function approvalLabels(harness: Harness, card: { canAllowForChat?: boolean }): Promise<string[]> {
		harness.run.handler = async (_request, runOptions) => {
			runOptions.onToolEvent?.({ id: "t1", server: "Notes", tool: "search", status: "pending-approval", argumentsJson: "{}" });
			await runOptions.confirmToolCall?.({ id: "t1", server: "Notes", tool: "search", argumentsJson: "{}", changedSinceApproval: false, ...card });
			return textResult("Done.");
		};
		ask(harness, "Search my notes");
		harness.root.querySelector<HTMLButtonElement>(".askmate-send-button")?.click();
		await settle();
		const buttons = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-tool-approval-actions button"));
		const labels = buttons.map((button) => button.textContent ?? "");
		buttons.find((button) => button.textContent === "Deny")?.click();
		await settle();
		return labels;
	}

	test("a run carries the id of its conversation, and a new conversation has another", async () => {
		const harness = await start();
		ask(harness, "First");
		await send(harness);
		ask(harness, "Second");
		await send(harness);
		const first = harness.ran[0]?.options.chatId;
		expect(typeof first).toBe("string");
		expect(harness.ran[1]?.options.chatId).toBe(first);
		await harness.view.startNewConversation();
		ask(harness, "Third");
		await send(harness);
		const third = harness.ran[2]?.options.chatId;
		expect(typeof third).toBe("string");
		expect(third).not.toBe(first);
	});

	test("Allow for this chat is offered only when the approval says a grant can be scoped to the conversation", async () => {
		expect(await approvalLabels(await start(), { canAllowForChat: true })).toEqual(["Allow once", "Allow for this chat", "Deny"]);
		await lifecycle(open!.view).closeForTest();
		expect(await approvalLabels(await start(), { canAllowForChat: false })).toEqual(["Allow once", "Deny"]);
		await lifecycle(open!.view).closeForTest();
		// A card that does not say is not offered a grant that nothing would honour.
		expect(await approvalLabels(await start(), {})).toEqual(["Allow once", "Deny"]);
	});

	test("starting a new conversation or closing the sidebar forgets the grants of the conversation that ended", async () => {
		const harness = await start();
		const forgotten: string[] = [];
		Object.assign(harness.plugin, { mcpService: { status: () => [], forgetChat: (id: string) => forgotten.push(id) } });
		ask(harness, "First");
		await send(harness);
		const first = harness.ran[0]?.options.chatId as string;
		await harness.view.startNewConversation();
		expect(forgotten).toEqual([first]);
		ask(harness, "Second");
		await send(harness);
		const second = harness.ran[1]?.options.chatId as string;
		expect(second).not.toBe(first);
		await lifecycle(harness.view).closeForTest();
		open = null;
		expect(forgotten).toEqual([first, second]);
		harness.root.remove();
	});
});

describe("tools after a server failed", () => {
	const failed = { id: "files", label: "Files", transport: "http" } as const;
	const withStatus = (harness: Harness, state: Record<string, unknown>): void => {
		Object.assign(harness.plugin, { mcpService: { status: () => [{ ...failed, state }], forgetChat: () => undefined } });
	};

	for (const state of [
		{ kind: "error", error: "transport", message: "The server returned HTTP 503.", fix: null },
		{ kind: "needs-auth", hint: "Sign in again." }
	]) {
		test(`a server that is ${state.kind} is still offered to the run, so the service can retry it`, async () => {
			const harness = await start();
			withStatus(harness, state);
			ask(harness, "What notes mention the budget?");
			await send(harness);
			expect(harness.ran[0]?.options.toolsEnabled).toBe(true);
		});
	}

	test("a server that is off, not yet trusted or still connecting is not offered, and a trust problem is said once", async () => {
		const harness = await start();
		withStatus(harness, { kind: "needs-trust" });
		ask(harness, "What notes mention the budget?");
		await send(harness);
		expect(harness.ran[0]?.options.toolsEnabled).toBeUndefined();
		expect(Notice.messages.filter((message) => message.includes("needs your trust"))).toHaveLength(1);
		ask(harness, "And the plan?");
		await send(harness);
		expect(Notice.messages.filter((message) => message.includes("needs your trust"))).toHaveLength(1);
		withStatus(harness, { kind: "off" });
		ask(harness, "Once more");
		await send(harness);
		expect(harness.ran[2]?.options.toolsEnabled).toBeUndefined();
		// A connection that is still being made is not waited for: the question is answered now, without tools.
		withStatus(harness, { kind: "connecting" });
		ask(harness, "And once more");
		await send(harness);
		expect(harness.ran[3]?.options.toolsEnabled).toBeUndefined();
	});
});


describe("commands and mentions in every layout", () => {
	const outputs = (harness: Harness): string[] =>
		Array.from(harness.root.querySelectorAll<HTMLElement>(".askmate-console-output .askmate-message-body"), (element) => element.textContent ?? "");

	for (const layout of ["compact", "expanded"] as const) {
		describe(`in the ${layout} layout`, () => {
			test("a workflow command runs the workflow with the words after it", async () => {
				const harness = await start({ layout });
				ask(harness, "/summarise focus on dates");
				await send(harness);
				expect(harness.ran).toHaveLength(1);
				expect(harness.built[0]?.options.workflow?.id).toBe("study-summary");
				expect(harness.built[0]?.options.workflowExtra).toBe("focus on dates");
				expect(box(harness).value).toBe("");
			});

			test("an @mention is read and taken out of the question", async () => {
				const harness = await start({ layout });
				ask(harness, "@backlinks What do these notes agree on?");
				await send(harness);
				expect(harness.built[0]?.question).toBe("What do these notes agree on?");
				expect(harness.built[0]?.options.vaultMentions).toEqual([{ kind: "backlinks" }]);
			});

			test("a mode command applies to that question only", async () => {
				const harness = await start({ layout });
				ask(harness, "/note Rewrite the intro");
				await send(harness);
				expect(harness.ran[0]?.request.metadata.outputMode).toBe("note");
				expect(harness.settings.outputMode).toBe("chat");
			});

			test("a command that sends nothing runs here instead of going to the model", async () => {
				const harness = await start({ layout });
				ask(harness, "/model");
				await send(harness);
				expect(harness.ran).toHaveLength(0);
				expect(outputs(harness).join("\n")).toContain("gpt-5.5");
				ask(harness, "/help");
				await send(harness);
				expect(harness.ran).toHaveLength(0);
				expect(outputs(harness).at(-1)).toContain("/summarise");
			});

			test("an unknown command is reported with the way to send it as text, and the line stays to be fixed", async () => {
				const harness = await start({ layout });
				ask(harness, "/foo bar");
				await send(harness);
				expect(harness.ran).toHaveLength(0);
				expect(harness.root.querySelector(".askmate-console-output.is-error")?.textContent).toContain("Unknown command /foo");
				expect(harness.root.querySelector(".askmate-console-output.is-error")?.textContent).toContain("//");
				expect(box(harness).value).toBe("/foo bar");
			});

			test("// sends a line that starts with a slash as text", async () => {
				const harness = await start({ layout });
				ask(harness, "//usr is a folder, what is it for?");
				await send(harness);
				expect(harness.built[0]?.question).toBe("/usr is a folder, what is it for?");
				expect(harness.built[0]?.options.intentKind).toBe("freeform_text");
			});

			test("a plain question stays a plain question, even with an email address in it", async () => {
				const harness = await start({ layout });
				ask(harness, "Write to alice@example.com about the plan");
				await send(harness);
				expect(harness.built[0]?.question).toBe("Write to alice@example.com about the plan");
				expect(harness.built[0]?.options).not.toHaveProperty("vaultMentions");
				expect(harness.built[0]?.options).not.toHaveProperty("contextScope");
				expect(harness.built[0]?.options).not.toHaveProperty("workflow");
				expect(harness.root.querySelector(".askmate-console-echo")).toBeNull();
				const user = bubbles(harness, "user")[0]?.querySelector(".askmate-message-body")?.textContent;
				expect(user).toBe("Write to alice@example.com about the plan");
			});

			test("the request preview reads a workflow command the way sending does", async () => {
				const harness = await start({ layout, saved: { showRequestPreview: true } });
				const inspected: string[] = [];
				Object.assign(harness.plugin, {
					inspectFinalPrompt: (_question: string, title: string) => {
						inspected.push(title);
						return Promise.reject(new Error("preview only"));
					}
				});
				ask(harness, "/summarise focus on dates");
				await wait(300);
				expect(inspected.at(-1)).toBe("Study summary");
				ask(harness, "/model");
				await wait(300);
				expect(harness.root.querySelector(".askmate-request-preview-summary")?.textContent).toBe("This is a command, not a question. Press Enter to run it.");
			});

			test("typing / lists the commands, Tab completes one, and the prompt says it has a list", async () => {
				const harness = await start({ layout });
				ask(harness, "/summ");
				const list = harness.root.querySelector<HTMLElement>(".askmate-console-completions");
				expect(list?.hidden).toBe(false);
				expect(list?.querySelectorAll("[role=\"option\"]").length).toBeGreaterThan(0);
				expect(box(harness).getAttribute("role")).toBe("combobox");
				expect(box(harness).getAttribute("aria-expanded")).toBe("true");
				fireDomEvent(box(harness), "keydown", { key: "Tab" });
				expect(box(harness).value.startsWith("/summarise")).toBe(true);
				expect(harness.ran).toHaveLength(0);
			});

			test("Enter sends a plain question even though the list is closed, and Escape closes an open list", async () => {
				const harness = await start({ layout });
				ask(harness, "/summ");
				fireDomEvent(box(harness), "keydown", { key: "Escape" });
				expect(harness.root.querySelector<HTMLElement>(".askmate-console-completions")?.hidden).toBe(true);
				ask(harness, "Just a question");
				fireDomEvent(box(harness), "keydown", { key: "Enter" });
				await settle();
				expect(harness.ran).toHaveLength(1);
			});

			test("/layout console still switches, and the other layouts' own buttons still run a workflow", async () => {
				const harness = await start({ layout });
				const saved: string[] = [];
				Object.assign(harness.plugin, { saveSettings: () => (saved.push(harness.settings.composerLayout), Promise.resolve()) });
				ask(harness, "/layout console");
				await send(harness);
				expect(harness.settings.composerLayout).toBe("console");
				expect(saved).toEqual(["console"]);
				expect(box(harness).value).toBe("");
			});
		});
	}

	test("the hint for turning saved conversations on names the setting as it is labelled, and /threads answers in Compact too", async () => {
		const harness = await start({ layout: "compact", saved: { saveConversations: false } });
		ask(harness, "/threads");
		await send(harness);
		expect(harness.ran).toHaveLength(0);
		expect(Notice.messages.at(-1)).toBe("Saving conversations is off. Turn on Remember conversations in AskMate settings, under Privacy and memory, to keep threads.");
		const saving = await createHarness({ layout: "compact" });
		ask(saving, "/threads");
		await send(saving);
		expect(Notice.messages.at(-1)).toBe("No saved conversations yet. Ask a question first.");
		await lifecycle(saving.view).closeForTest();
	});

	test("a missing image key points at the Connection page, the Images group and the row", async () => {
		const expected = "Images use OpenAI. In AskMate settings, open Connection and add an OpenAI API key (under Images, if another provider is selected) before generating an image.";
		const harness = await start({ layout: "compact" });
		ask(harness, "/image a red fox");
		await send(harness);
		expect(harness.ran).toHaveLength(0);
		expect(Notice.messages.at(-1)).toBe(expected);

		Notice.clear();
		harness.root.querySelector<HTMLButtonElement>(".askmate-image-button")?.click();
		await settle();
		expect(harness.ran).toHaveLength(0);
		expect(Notice.messages.at(-1)).toBe(expected);
	});

	test("the Console layout still reads every line as a command line", async () => {
		const harness = await start({ layout: "console" });
		ask(harness, "Write to alice@example.com about the plan");
		await send(harness);
		expect(harness.built[0]?.options).toHaveProperty("vaultMentions");
	});
});


describe("setting up a local server", () => {
	const LOCAL = "openai-compatible";
	const addressField = (harness: Harness): HTMLInputElement => {
		const field = harness.root.querySelector<HTMLInputElement>(".askmate-setup-key-row input[type=\"text\"]");
		if (!field) {
			throw new Error("expected the address field");
		}
		return field;
	};
	const errorButton = (harness: Harness): HTMLButtonElement | null => harness.root.querySelector<HTMLButtonElement>(".askmate-setup-error button");

	/** A view whose chat provider is a local server on its own port, as an LM Studio user has it. */
	async function startLocal(baseUrl: string, model: string): Promise<Harness> {
		const harness = await start({ layout: "console", saved: chatProviderSaved(LOCAL) });
		harness.settings.providers[LOCAL].baseUrl = baseUrl;
		harness.settings.providers[LOCAL].model = model;
		Object.assign(harness.plugin, {
			getChatProviderId: () => LOCAL,
			getChatProviderModelRef: () => ({ providerId: LOCAL, providerName: "Local or self-hosted", model: harness.settings.providers[LOCAL].model, capability: "text" }),
			getProviderSettings: (id: TextProviderId) => harness.settings.providers[id]
		});
		return harness;
	}

	test("/setup shows the saved address and model, and Connect keeps them", async () => {
		const harness = await startLocal("http://localhost:1234/v1", "qwen2.5");
		const tested: string[] = [];
		Object.assign(harness.plugin, {
			testProviderConnectionDetailed: () => {
				tested.push(harness.settings.providers[LOCAL].baseUrl);
				return Promise.resolve({ ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null });
			}
		});
		ask(harness, "/setup");
		await send(harness);
		expect(addressField(harness).value).toBe("http://localhost:1234/v1");
		expect(harness.root.querySelectorAll<HTMLInputElement>(".askmate-setup-key-row input")[1]?.placeholder).toBe("qwen2.5");
		await pressConnect(harness);
		expect(harness.settings.providers[LOCAL].baseUrl).toBe("http://localhost:1234/v1");
		expect(harness.settings.providers[LOCAL].model).toBe("qwen2.5");
		expect(tested).toEqual(["http://localhost:1234/v1"]);
	});

	test("QA-02: Connect rebuilds the settings tab, so its Connection page shows the provider just chosen", async () => {
		const harness = await startLocal("http://localhost:1234/v1", "qwen2.5");
		let rebuilds = 0;
		Object.assign(harness.plugin, {
			refreshSettingTab: () => {
				rebuilds += 1;
			},
			testProviderConnectionDetailed: () => Promise.resolve({ ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null })
		});
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		expect(rebuilds).toBe(1);
	});

	test("a failed /test opens the card on the saved address, and Try again does not move the server to another port", async () => {
		const harness = await startLocal("http://localhost:1234/v1", "qwen2.5");
		let running = false;
		Object.assign(harness.plugin, {
			testProviderConnectionDetailed: () => Promise.resolve(running && harness.settings.providers[LOCAL].baseUrl.includes(":1234")
				? { ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null }
				: { ok: false, message: "Failed to fetch", modelFound: null, suggestedModel: null, copy: null })
		});
		ask(harness, "/test");
		await send(harness);
		expect(addressField(harness).value).toBe("http://localhost:1234/v1");
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-failed")).toBe(true);
		running = true;
		await pressConnect(harness);
		expect(harness.settings.providers[LOCAL].baseUrl).toBe("http://localhost:1234/v1");
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connected")).toBe(true);
	});

	test("an address typed in the card still replaces the saved one", async () => {
		const harness = await startLocal("http://localhost:1234/v1", "qwen2.5");
		Object.assign(harness.plugin, { testProviderConnectionDetailed: () => Promise.resolve({ ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null }) });
		ask(harness, "/setup");
		await send(harness);
		addressField(harness).value = "http://192.168.1.20:8080/v1";
		fireDomEvent(addressField(harness), "input");
		await pressConnect(harness);
		expect(harness.settings.providers[LOCAL].baseUrl).toBe("http://192.168.1.20:8080/v1");
	});

	function missingModel(harness: Harness, listed: string | null): void {
		Object.assign(harness.plugin, {
			testProviderConnectionDetailed: () => Promise.resolve(listed !== null && harness.settings.providers[LOCAL].model === listed
				? { ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null }
				: { ok: true, message: "AskMate Local connected, but model \"llama3.1\" was not found. 1 model is visible.", modelFound: false, suggestedModel: listed, copy: null })
		});
	}

	test("QA-09: on a first connection with the model left empty, the server's own model is used instead of an error", async () => {
		const harness = await startLocal("http://localhost:11434/v1", "llama3.1");
		harness.settings.firstRunCompletedAt = null;
		missingModel(harness, "gemma3");
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		await settle(12);
		expect(harness.settings.providers[LOCAL].model).toBe("gemma3");
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connected")).toBe(true);
	});

	test("QA-09: on a first connection, a model the person saved is kept, and the button offers the server's model", async () => {
		const harness = await startLocal("http://localhost:11434/v1", "mistral-nemo");
		harness.settings.firstRunCompletedAt = null;
		missingModel(harness, "gemma3");
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		await settle(12);
		expect(harness.settings.providers[LOCAL].model).toBe("mistral-nemo");
		expect(errorButton(harness)?.textContent).toBe("Use gemma3");
	});

	test("a model the server does not have is answered with the one it does: one button uses it and checks again", async () => {
		const harness = await startLocal("http://localhost:11434/v1", "llama3.1");
		// A returning user saved this model, so AskMate does not swap it without asking.
		harness.settings.firstRunCompletedAt = "2026-10-01T09:00:00.000Z";
		missingModel(harness, "gemma3");
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		const error = harness.root.querySelector(".askmate-setup-error");
		expect(error?.textContent).toContain("does not have the model llama3.1");
		expect(error?.textContent).toContain("The closest model it lists is gemma3.");
		expect(errorButton(harness)?.textContent).toBe("Use gemma3");
		errorButton(harness)?.click();
		await settle(12);
		expect(harness.settings.providers[LOCAL].model).toBe("gemma3");
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-connected")).toBe(true);
		expect(harness.root.querySelector(".askmate-setup-title")?.textContent).toBe("Connected to Local or self-hosted");
	});

	test("with nothing to suggest, Choose another model reads the server's list first and opens the picker with it", async () => {
		const harness = await startLocal("http://localhost:11434/v1", "llama3.1");
		missingModel(harness, null);
		let refreshed = 0;
		Object.assign(harness.plugin, {
			refreshSelectedProviderModels: () => {
				refreshed += 1;
				harness.settings.providers[LOCAL].modelOptions = ["gemma3", "llama3.1"];
				return Promise.resolve(["gemma3", "llama3.1"]);
			}
		});
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		expect(errorButton(harness)?.textContent).toBe("Choose another model");
		errorButton(harness)?.click();
		await settle(12);
		expect(refreshed).toBe(1);
		const picker = Modal.opened.at(-1) as unknown as { getItems(): Array<{ model: string }> } | undefined;
		expect(picker?.getItems().map((choice) => choice.model)).toContain("gemma3");
		Modal.closeAll();
	});

	test("if the server's list cannot be read the picker still opens, and the person is told why it may be short", async () => {
		const harness = await startLocal("http://localhost:11434/v1", "llama3.1");
		missingModel(harness, null);
		Object.assign(harness.plugin, { refreshSelectedProviderModels: () => Promise.reject(new Error("connection refused")) });
		ask(harness, "/setup");
		await send(harness);
		await pressConnect(harness);
		errorButton(harness)?.click();
		await settle(12);
		expect(Notice.messages.at(-1)).toBe("AskMate could not read the model list from the server. connection refused");
		expect(Modal.opened.at(-1)).toBeDefined();
		Modal.closeAll();
	});
});

describe("the Connect card for assistive technology and the keyboard", () => {
	const status = (harness: Harness): string => harness.root.querySelector(".askmate-visually-hidden[role=\"status\"]")?.textContent ?? "";

	async function openNote(harness: Harness): Promise<void> {
		harness.fake.vault.add("A.md", "# A");
		const view = openFakeMarkdownView(harness.fake.workspace, harness.fake.vault.getFileByPath("A.md")!, "# A");
		harness.fake.workspace.activeView = view;
		harness.fake.workspace.activeFile = harness.fake.vault.getFileByPath("A.md");
		harness.context.rememberActiveMarkdownContext();
		await (harness.view as unknown as { updateContextLabel(): Promise<void> }).updateContextLabel();
	}

	test("a successful connection is announced, and the keyboard goes to the first starter", async () => {
		const harness = await start({ configured: false });
		await openNote(harness);
		storeKeys(harness, [], { ok: true, message: "OpenAI answered." });
		const seen: string[] = [];
		const region = harness.root.querySelector<HTMLElement>(".askmate-visually-hidden[role=\"status\"]");
		const original = region?.setText.bind(region);
		if (region && original) {
			region.setText = (text: string) => {
				seen.push(text.trim());
				original(text);
			};
		}
		typeKey(harness, "sk-live-abcdefgh");
		keyField(harness).focus();
		await pressConnect(harness);
		expect(seen).toContain("Checking OpenAI.");
		expect(status(harness).trim()).toBe("Connected to OpenAI. Starter buttons are below.");
		const focused = activeDocument.activeElement;
		expect(focused?.classList.contains("askmate-starter-chip")).toBe(true);
		expect(focused?.textContent).toBe("Summarise this note");
	});

	test("with no note open the keyboard goes to the card's heading, and the card says why the starters wait", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: true, message: "OpenAI answered." });
		typeKey(harness, "sk-live-abcdefgh");
		keyField(harness).focus();
		await pressConnect(harness);
		expect(activeDocument.activeElement?.classList.contains("askmate-setup-title")).toBe(true);
		expect(harness.root.querySelector(".askmate-setup-card p")?.textContent).toBe("Open a note, then pick a starter. They work on the note you have open.");
	});

	test("a failed connection is announced in the same words the card shows, and the key field keeps the keyboard", async () => {
		const harness = await start({ configured: false });
		storeKeys(harness, [], { ok: false, message: "HTTP 401 invalid api key" });
		typeKey(harness, "sk-bad-key-1234");
		keyField(harness).focus();
		await pressConnect(harness);
		expect(status(harness)).toContain("rejected the API key");
		expect(harness.root.querySelector(".askmate-setup-error")?.textContent).toContain("rejected the API key");
		expect(activeDocument.activeElement).toBe(keyField(harness));
	});

	test("the field keeps the keyboard while the check runs", async () => {
		const harness = await start({ configured: false });
		const gate: { release: (() => void) | null } = { release: null };
		storeKeys(harness, [], { ok: true, message: "OpenAI answered." });
		Object.assign(harness.plugin, {
			testProviderConnectionDetailed: () => new Promise((resolve) => {
				gate.release = () => resolve({ ok: true, message: "ok", modelFound: true, suggestedModel: null, copy: null });
			})
		});
		typeKey(harness, "sk-live-abcdefgh");
		keyField(harness).focus();
		harness.root.querySelector<HTMLButtonElement>(".askmate-setup-actions .mod-cta")?.click();
		await settle(12);
		expect(harness.root.querySelector(".askmate-setup-card")?.classList.contains("is-testing")).toBe(true);
		expect(activeDocument.activeElement?.tagName).toBe("INPUT");
		expect(status(harness).trim()).toBe("Checking OpenAI.");
		gate.release?.();
		await settle(12);
	});
});
