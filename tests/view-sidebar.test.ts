import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, AskRequest, NoteContext, RunRequestOptions, TextProviderId } from "../src/shared/types";
import { ThreadService } from "../src/threads/ThreadService";
import { assembleDiagram, designFromRecipe, STYLE_RECIPES } from "../src/diagrams";
import { hashSkillText, SkillService, type SkillConfig, type SkillFileInfo, type SkillHost, type SkillMatchMode } from "../src/skills";
import type { AskMatePlugin } from "../src/plugin/AskMatePlugin";
import { WORKFLOWS } from "../src/workflows/builtInWorkflows";
import { createFakeApp, FakeEditor, openFakeMarkdownView, type FakeApp } from "./support/fake-app";
import { createFakeMouseEvent, fireDomEvent, getFakeWindow, installDomGlobals } from "./support/fake-dom";
import { MarkdownRenderer, Menu, Notice, WorkspaceLeaf, type TFile } from "./support/obsidian-fakes";
import type { SidebarResult, Wave2RunOptions } from "../src/ui/sidebar/components/pluginApi";

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

type RunHandler = (request: AskRequest, options: Wave2RunOptions) => Promise<SidebarResult>;

interface Harness {
	fake: FakeApp;
	settings: AskMateSettings;
	plugin: AskMatePlugin;
	view: InstanceType<typeof AskMateView>;
	root: HTMLElement;
	context: InstanceType<typeof ContextService>;
	built: Array<{ question: string; title: string; options: RunRequestOptions }>;
	ran: Array<{ request: AskRequest; options: Wave2RunOptions }>;
	applied: Array<{ text: string; scope: string | undefined }>;
	run: { handler: RunHandler };
	models: { name: string };
	opened: { count: number };
	skills: { service: SkillService; host: SkillTestHost };
}

function textResult(text: string, extra: Partial<SidebarResult> = {}): SidebarResult {
	return { kind: "text", model: MODEL, text, ...extra } as SidebarResult;
}

function makeRequest(question: string, title: string, options: RunRequestOptions & { intentKind?: string }, context: NoteContext, model: string): AskRequest {
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
		buildRequest: async (question: string, title: string, requestOptions: RunRequestOptions) => {
			built.push({ question, title, options: requestOptions });
			const noteContext = await context.getNoteContext(undefined, undefined, { allowNoNote: true });
			return makeRequest(question, title, requestOptions, noteContext as NoteContext, models.name);
		},
		confirmUsageGuardrails: () => Promise.resolve(),
		runOpenAIRequest: (request: AskRequest, runOptions: Wave2RunOptions) => {
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
		setReasoningEffort: () => Promise.resolve(),
		openEvidenceSource: () => Promise.resolve(),
		createConversationNote: () => Promise.resolve({ path: "AskMate/Chat.md" }),
		createImageResultNote: () => Promise.reject(new Error("not used")),
		applyImageToContext: () => Promise.reject(new Error("not used"))
	} as unknown as AskMatePlugin;
	Object.defineProperty(plugin, "setConfigured", { value: (value: boolean) => (configured = value) });
	const skillHost = new SkillTestHost();
	const service = new SkillService(skillHost);
	if (options.skills) {
		skillHost.config = { ...skillHost.config, matchMode: options.skills };
		for (const [path, text] of Object.entries(options.skillFiles ?? {})) {
			skillHost.files.set(`AskMate/Skills/${path}`, text);
		}
		await service.scan();
		Object.assign(plugin, { skillService: service });
	}
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
		test(`in the ${layout} layout points to the workflow button and does not promise slash workflows`, async () => {
			const harness = await start({ layout, saved: { showOnboardingTips: true } });
			expect(tip(harness)).toContain("sparkles button to run a workflow");
			expect(tip(harness)).toContain("/diagram");
			expect(tip(harness)).not.toContain("type / to run");
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
		expect(saved?.messages[1]?.tools).toEqual([{ server: "Notes", tool: "search", status: "completed", summary: "3 notes" }]);
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

	function diagramResult(status: "valid" | "repaired" | "fallback" = "valid"): SidebarResult {
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
		expect(Array.from(card?.querySelectorAll(".askmate-diagram-actions button") ?? [], (button) => button.textContent)).toEqual(["Insert", "New note", "Copy source", "Another look"]);
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
		const insert = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button")).find((button) => button.textContent === "Insert");
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
		expect(buttons.find((button) => button.textContent === "Insert")?.disabled).toBe(true);
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

	test("a diagram request does not offer tools", async () => {
		const harness = await start({ layout: "console" });
		Object.assign(harness.plugin, { mcpService: { status: () => [{ id: "a", label: "A", transport: "http", state: { kind: "ready", tools: 2, hidden: 0, era: "x", version: "1", serverName: "S" } }] } });
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
		expect(transcript?.getAttribute("aria-label")).toBe("AskMate conversation");
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

	test("the picker is hidden when skills are not available", async () => {
		const harness = await start();
		expect(harness.root.querySelector<HTMLButtonElement>(".askmate-skill-picker")?.hidden).toBe(true);
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
				status: () => [{ id: "files", label: "Files", transport: "http", state: { kind: "ready", tools: 2, hidden: 0, era: "x", version: "1", serverName: "S" } }]
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
			mcpService: { status: () => [{ id: "files", label: "Files", transport: "http", state: { kind: "idle" } }] }
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
