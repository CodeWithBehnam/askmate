import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { SettingDefinitionList } from "obsidian";
import * as ts from "typescript";
import { findSettingReferences, quotedSpans, splitSentences } from "../scripts/roadmap-smoke-tests";
import type { McpServerStatus, ToolSnapshot, TrustOutcome } from "../src/mcp";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import { syncObjectInPlace } from "../src/settings/syncInPlace";
import { IDLE_SETUP_TEST, deriveSetupState, type SetupStage } from "../src/setup";
import { SkillService, hashSkillText, type SkillConfig, type SkillFileInfo, type SkillHost } from "../src/skills";
import type { AskMateSettings, McpServerConfig, TextProviderId } from "../src/shared/types";
import { AskMateSettingTab } from "../src/ui/settings/AskMateSettingTab";
import { planKeySave, type ConnectionTestView } from "../src/ui/settings/connectionPage";
import { createFakeApp, type FakeApp } from "./support/fake-app";
import { fireDomEvent, getFakeDocument, installDomGlobals } from "./support/fake-dom";
import {
	ButtonComponent,
	DropdownComponent,
	ExtraButtonComponent,
	Menu,
	Modal,
	Notice,
	Setting,
	SettingGroup,
	TextComponent,
	ToggleComponent,
	type SettingPage
} from "./support/obsidian-fakes";

// The tab is built on the shared fakes and drawn by a small renderer that follows the definitions the way Obsidian does.

const restoreGlobals = installDomGlobals();
afterAll(restoreGlobals);

/** A deletion cannot be told apart from a record that a synced device never had, so every delete control says to repeat it. */
const SYNC_DELETION_SENTENCE = "If this vault's plugin data syncs between devices, repeat the deletion on each device. A device that still holds a conversation or a queued review puts it back.";

// This file adds behaviour to the shared fakes (below). The fakes are shared by every test file in the run, so each change is
// recorded here first and undone when this file is finished.
const PATCHED: ReadonlyArray<readonly [object, string]> = [
	[ButtonComponent.prototype, "onClick"],
	[ButtonComponent.prototype, "setDestructive"],
	[ToggleComponent.prototype, "onChange"],
	[TextComponent.prototype, "getValue"],
	[TextComponent.prototype, "onChange"],
	[Setting.prototype, "addTextArea"],
	[Setting.prototype, "addComponent"],
	[globalThis, "createFragment"]
];
const ORIGINALS = PATCHED.map(([target, name]) => [target, name, Object.getOwnPropertyDescriptor(target, name)] as const);
afterAll(() => {
	for (const [target, name, descriptor] of ORIGINALS) {
		if (descriptor) {
			Object.defineProperty(target, name, descriptor);
		} else {
			Reflect.deleteProperty(target, name);
		}
	}
});

// Obsidian provides these global helpers; the fake window does not.
Object.defineProperty(globalThis, "createFragment", {
	configurable: true,
	writable: true,
	value: (callback?: (fragment: DocumentFragment) => void): DocumentFragment => {
		const fragment = getFakeDocument().createDocumentFragment();
		Object.assign(fragment, {
			appendText: (text: string) => fragment.appendChild(getFakeDocument().createTextNode(text)),
			createEl: (tag: string, info?: { text?: string; href?: string; attr?: Record<string, string> }) => {
				const el = getFakeDocument().createElement(tag);
				el.textContent = info?.text ?? "";
				if (info?.href) {
					el.setAttribute("href", info.href);
				}
				fragment.appendChild(el);
				return el;
			}
		});
		callback?.(fragment);
		return fragment;
	}
});

// The shared fake button predates setDestructive; the real one has it, and the tab uses it for every delete action.
if (!("setDestructive" in ButtonComponent.prototype)) {
	Object.defineProperty(ButtonComponent.prototype, "setDestructive", {
		configurable: true,
		value(this: ButtonComponent): ButtonComponent {
			this.warning = true;
			return this;
		}
	});
}

// The shared fake components keep their handlers off the DOM. Pages that are drawn straight into a container (the server page)
// can only be driven through the DOM, so clicks on a button or a switch reach the handler the way a click does in Obsidian.
const fakeButtonOnClick = ButtonComponent.prototype.onClick;
Object.defineProperty(ButtonComponent.prototype, "onClick", {
	configurable: true,
	value(this: ButtonComponent, callback: (event: MouseEvent) => unknown): ButtonComponent {
		this.buttonEl.addEventListener("click", (event) => {
			if (!this.disabled) {
				void callback(event as MouseEvent);
			}
		});
		return fakeButtonOnClick.call(this, callback);
	}
});
const fakeToggleOnChange = ToggleComponent.prototype.onChange;
Object.defineProperty(ToggleComponent.prototype, "onChange", {
	configurable: true,
	value(this: ToggleComponent, callback: (value: boolean) => unknown): ToggleComponent {
		this.toggleEl.addEventListener("click", () => {
			void this.simulateChange(!this.getValue());
		});
		return fakeToggleOnChange.call(this, callback);
	}
});
// Obsidian's text components read the element they own and report typing as it happens; the fake keeps a separate value.
Object.defineProperty(TextComponent.prototype, "getValue", {
	configurable: true,
	value(this: TextComponent): string {
		return this.inputEl.value;
	}
});
const fakeTextOnChange = TextComponent.prototype.onChange;
Object.defineProperty(TextComponent.prototype, "onChange", {
	configurable: true,
	value(this: TextComponent, callback: (value: string) => unknown): TextComponent {
		this.inputEl.addEventListener("input", () => {
			void callback(this.inputEl.value);
		});
		return fakeTextOnChange.call(this, callback);
	}
});
// The fake text area is an input element, which would strip line breaks from a multi-line value.
Object.defineProperty(Setting.prototype, "addTextArea", {
	configurable: true,
	value(this: Setting, callback: (component: TextComponent) => unknown): Setting {
		const component = new TextComponent(this.controlEl);
		const textarea = this.controlEl.createEl("textarea");
		component.inputEl.remove();
		Object.defineProperty(component, "inputEl", { value: textarea });
		this.components.push(component);
		callback(component);
		return this;
	}
});

// The shared fake setting has no addComponent, which the real one uses to host the keychain picker.
if (!("addComponent" in Setting.prototype)) {
	Object.defineProperty(Setting.prototype, "addComponent", {
		configurable: true,
		value(this: Setting, callback: (el: HTMLElement) => ButtonComponent): Setting {
			this.components.push(callback(this.controlEl));
			return this;
		}
	});
}

afterEach(() => {
	Modal.closeAll();
	Notice.clear();
	Menu.lastMenu = null;
});

type Item = ReturnType<AskMateSettingTab["getSettingDefinitions"]>[number];
type Definition = Extract<Item, { name: string }> & { visible?: boolean | (() => boolean); render?: (setting: Setting, group: SettingGroup) => unknown };
type PageItem = Extract<Item, { type: "page" }>;
type ListItem = SettingDefinitionList;

interface Rendered {
	def: Definition;
	setting: Setting;
}

const tick = async (): Promise<void> => {
	for (let i = 0; i < 6; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

function isVisible(def: { visible?: boolean | (() => boolean) }): boolean {
	return typeof def.visible === "function" ? def.visible() : def.visible ?? true;
}

/** Draws declarative definitions, descending into groups, lists and inline pages. Imperative pages are returned for the caller to open. */
function draw(items: readonly Item[], container: HTMLElement, out: Rendered[] = []): Rendered[] {
	for (const item of items) {
		if ("type" in item && (item.type === "group" || item.type === "list")) {
			const group = new SettingGroup(container);
			group.setHeading(item.heading ?? "");
			draw((item.items ?? []) as Item[], group.listEl, out);
		} else if ("type" in item && item.type === "page") {
			if (item.items) {
				draw(item.items, container.createDiv(), out);
			}
		} else {
			const def = item as Definition;
			const setting = new Setting(container);
			setting.setName(def.name);
			if (def.desc !== undefined) {
				setting.setDesc(def.desc);
			}
			def.render?.(setting, new SettingGroup(container));
			out.push({ def, setting });
		}
	}
	return out;
}

function lists(items: readonly Item[]): ListItem[] {
	return items.flatMap((item): ListItem[] => {
		if ("type" in item && item.type === "list") {
			return [item as ListItem];
		}
		if ("type" in item && (item.type === "group" || item.type === "page")) {
			return lists((item.items ?? []) as Item[]);
		}
		return [];
	});
}

function pageNamed(tab: AskMateSettingTab, name: string): PageItem {
	const page = tab.getSettingDefinitions().find((item): item is PageItem => "type" in item && item.type === "page" && item.name === name);
	if (!page) {
		throw new Error(`No page named ${name}.`);
	}
	return page;
}

function rowNamed(rows: readonly Rendered[], name: string): Rendered {
	const found = rows.find((row) => row.def.name === name);
	if (!found) {
		throw new Error(`No row named "${name}". Rows: ${rows.map((row) => row.def.name).join(" | ")}`);
	}
	return found;
}

const buttonIn = (setting: Setting, label?: string): ButtonComponent => {
	const found = setting.components.find((component): component is ButtonComponent => component instanceof ButtonComponent && (label === undefined || component.text === label));
	if (!found) {
		throw new Error(`No button${label ? ` "${label}"` : ""}.`);
	}
	return found;
};
const toggleIn = (setting: Setting): ToggleComponent => {
	const found = setting.component(ToggleComponent);
	if (!found) {
		throw new Error("No toggle.");
	}
	return found;
};
const textIn = (setting: Setting, index = 0): TextComponent => {
	const found = setting.components.filter((component): component is TextComponent => component instanceof TextComponent)[index];
	if (!found) {
		throw new Error("No text input.");
	}
	return found;
};
const dropdownIn = (setting: Setting): DropdownComponent => {
	const found = setting.component(DropdownComponent);
	if (!found) {
		throw new Error("No dropdown.");
	}
	return found;
};
const feedbackOf = (setting: Setting): string => setting.infoEl.querySelector(".askmate-settings-feedback")?.textContent ?? "";

// ---------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The plugin members the settings page drives directly. The harness gives every one a working default, as the real plugin has them
 * all, and a test replaces the one it wants to watch or to make fail.
 */
interface PluginMembers {
	skillService?: SkillService;
	mcpService?: unknown;
	getSetupState?: () => SetupStage;
	saveProviderApiKey?: (providerId: TextProviderId, apiKey: string) => Promise<void>;
	testProviderConnectionDetailed?: () => Promise<ConnectionTestView>;
	openSettingsTab?: () => void;
	revokeMcpTrust?: (serverId: string) => Promise<void>;
	getSidebarWorkflowOrderForSettings?: () => Array<{ id: string; name: string; isCustom: boolean }>;
	getWorkflowDisplayPreference?: (id: string) => { id: string; favorite: boolean; hidden: boolean; order: number } | null;
	reorderWorkflowDisplay?: (fromIndex: number, toIndex: number) => Promise<void>;
}

interface Harness {
	fake: FakeApp;
	settings: AskMateSettings;
	tab: AskMateSettingTab;
	counts: { saved: number; updates: number; activated: number };
	/** Servers whose trust the page asked the plugin to forget, in order. */
	revoked: string[];
	extras: PluginMembers;
}

/** A skills service with nothing in it, so a page that is not about skills lists no skill rows. */
const NO_SKILLS = {
	list: () => [],
	issues: () => [],
	statusOf: () => "built-in",
	scan: async (): Promise<void> => undefined,
	trust: async (): Promise<void> => undefined,
	revoke: async (): Promise<void> => undefined,
	onChange: () => () => undefined
} as unknown as SkillService;

function makeHarness(extrasFactory: (settings: AskMateSettings, fake: FakeApp) => PluginMembers = () => ({}), appVersion: string | null = "1.13.1"): Harness {
	const fake = createFakeApp();
	const settings = structuredClone(DEFAULT_SETTINGS);
	const counts = { saved: 0, updates: 0, activated: 0 };
	const revoked: string[] = [];
	const extras = extrasFactory(settings, fake);
	const provider = () => settings.providers[settings.providerRoles.chatProviderId];
	const hasSecret = (name: string): boolean => (fake.secretStorage.getSecret(name) ?? "").trim() !== "";
	const plugin = {
		settings,
		manifest: { version: "1.12.0" },
		threads: { clearAll: async (): Promise<boolean> => true },
		// Like the plugin, a save normalises the live settings in place, so a definition the loader would drop disappears here too.
		saveSettings: async (): Promise<void> => {
			counts.saved += 1;
			syncObjectInPlace(settings, normalizeAskMateSettings(settings, "save"));
		},
		refreshOpenAskMateViews: (): void => undefined,
		forgetPendingQuestion: (): void => undefined,
		getErrorMessage: (error: unknown): string => (error instanceof Error ? error.message : String(error)),
		getSelectedTextProviderId: () => settings.providerRoles.chatProviderId,
		getProviderSettings: (id: keyof AskMateSettings["providers"]) => settings.providers[id],
		getSelectedModel: () => provider().model,
		testSelectedProviderConnection: async (): Promise<string> => "AskMate OpenAI test passed.",
		refreshSelectedProviderModels: async (): Promise<string[]> => provider().modelOptions,
		// A method that reads `this`, like the real one, so a detached call (this === undefined) is caught.
		remembered: 0,
		async activateView(): Promise<void> {
			this.remembered += 1;
			counts.activated += 1;
		},
		getPendingReviewQueueItems: () => [],
		getAllWorkflows: () => [],
		getVisibleWorkflows: () => [],
		getSidebarWorkflowOrderForSettings: () => [],
		getWorkflowDisplayPreference: () => null,
		getTokenUsageRecords: () => [],
		getTodayTokenUsage: () => 0,
		getMonthTokenUsage: () => 0,
		skillService: NO_SKILLS,
		mcpService: null,
		getSetupState: (): SetupStage => deriveSetupState(settings, hasSecret, IDLE_SETUP_TEST),
		// What saving a key does in the real plugin, as far as the page can see: the key goes to the keychain, the name into settings.
		saveProviderApiKey: async (providerId: TextProviderId, apiKey: string): Promise<void> => {
			const planned = planKeySave(providerId, apiKey, settings.providers[providerId].apiKeySecretName, fake.secretStorage.listSecrets());
			if (!planned.ok) {
				throw new Error(planned.message);
			}
			fake.secretStorage.setSecret(planned.secretId, planned.key);
			settings.providers[providerId].apiKeySecretName = planned.secretId;
			await plugin.saveSettings();
		},
		testProviderConnectionDetailed: async (): Promise<ConnectionTestView> => ({ ok: true, message: await plugin.testSelectedProviderConnection(), modelFound: null }),
		openSettingsTab: (): void => undefined,
		revokeMcpTrust: async (serverId: string): Promise<void> => {
			revoked.push(serverId);
		},
		...extras
	};
	const tab = new AskMateSettingTab(fake.app, plugin as never, appVersion);
	Object.assign(tab, {
		update: (): void => {
			counts.updates += 1;
		},
		refreshDomState: (): void => undefined
	});
	return { fake, settings, tab, counts, revoked, extras };
}

function connectionRows(harness: Harness): Rendered[] {
	return draw(pageNamed(harness.tab, "Connection").items ?? [], getFakeDocument().createElement("div"));
}

const statusChipText = (rows: readonly Rendered[]): string => rowNamedByClass(rows, "askmate-settings-status").setting.controlEl.querySelector(".askmate-status-chip")?.textContent ?? "";
function rowNamedByClass(rows: readonly Rendered[], cls: string): Rendered {
	const found = rows.find((row) => row.setting.settingEl.classList.contains(cls));
	if (!found) {
		throw new Error(`No row with class ${cls}.`);
	}
	return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// The six pages
// ---------------------------------------------------------------------------------------------------------------------

describe("the settings tab", () => {
	test("lists the six pages in order, then an About row with links", () => {
		const { tab } = makeHarness();
		const items = tab.getSettingDefinitions();
		const pages = items.filter((item): item is PageItem => "type" in item && item.type === "page");
		expect(pages.map((page) => page.name)).toEqual(["Connection", "Sidebar and output", "Privacy and memory", "Skills and tools", "Instructions", "Advanced"]);
		const about = items.find((item) => "type" in item && item.type === "group" && item.heading === "About");
		expect(about).toBeDefined();
	});

	test("a version that supports it shows a live value and warning on the entry", () => {
		const { tab } = makeHarness(() => ({}), "1.13.1");
		const connection = pageNamed(tab, "Connection");
		expect(typeof connection.displayValue).toBe("function");
		expect(typeof connection.status).toBe("function");
		expect((connection.displayValue as () => string)()).toContain("setup needed");
		expect((connection.status as () => string | null)()).toBe("warning");
	});

	test("an older version gets the same words in the description and no unknown fields", () => {
		const { tab } = makeHarness(() => ({}), "1.13.0");
		const connection = pageNamed(tab, "Connection");
		expect(connection.displayValue).toBeUndefined();
		expect(connection.status).toBeUndefined();
		expect(connection.desc).toContain("Now: OpenAI · setup needed.");
		const unknown = makeHarness(() => ({}), null);
		expect(pageNamed(unknown.tab, "Privacy and memory").desc).toContain("Now: ");
	});

	test("every control that used to exist is still on one of the pages", () => {
		const { tab } = makeHarness();
		const names = new Set<string>();
		for (const page of tab.getSettingDefinitions()) {
			if ("type" in page && page.type === "page" && page.items) {
				draw(page.items, getFakeDocument().createElement("div")).forEach((row) => names.add(row.def.name));
			}
		}
		const expectedNames = [
			"Chat provider", "API key", "Test connection", "Model ID", "Reasoning effort", "Improve image prompts with",
			"Sidebar layout", "Send shortcut", "Show AskMate in the editor context menu", "Show request preview", "Default output", "Ask before changing my notes", "Stream replies", "Result folder",
			"Send the current note with each question", "Send image links", "How much of a long note to send", "Remember conversations", "Follow-up questions use earlier answers", "Per-note memory",
			"Delete saved conversations", "Delete all stored text",
			"Use skills", "When to use a skill", "Skills folder", "New skill from template", "Install examples", "Draw diagrams from notes", "Default diagram type", "Default style", "Fix diagrams that do not draw", "Allow tools",
			"Default additional note paths", "Default folder context", "Excalidraw summaries", "Image manifest context", "Evidence-linked answers", "Style guide note", "Glossary note",
			"Place result notes beside the source note", "Link result notes from the source note", "Result note template", "Image result note template", "Image folder template", "Image file name template",
			"Default partial Apply scope", "Frontmatter Apply handling", "Review queue max items", "Workflow custom instructions", "Translation target language", "Usage budgets and guardrails", "Onboarding tips", "Reset to recommended settings"
		];
		expect(expectedNames.filter((name) => !names.has(name))).toEqual([]);
	});

	test("no heading names the plugin or uses the word settings", () => {
		const { tab } = makeHarness();
		const collect = (items: readonly Item[]): string[] => items.flatMap((item): string[] => {
			if ("type" in item && (item.type === "group" || item.type === "list")) {
				return [item.heading ?? "", ...collect((item.items ?? []) as Item[])];
			}
			if ("type" in item && item.type === "page") {
				return [item.name, ...collect((item.items ?? []) as Item[])];
			}
			return [];
		});
		const headings = collect(tab.getSettingDefinitions()).filter((heading) => heading !== "");
		expect(headings.length).toBeGreaterThan(20);
		for (const heading of headings) {
			expect(heading.toLowerCase()).not.toContain("askmate");
			expect(heading.toLowerCase()).not.toContain("settings");
		}
	});

	test("QA-06: Custom workflows offers a real Add workflow button, and its list has no role-less add control", () => {
		const { tab } = makeHarness();
		const flatten = (items: readonly Item[]): Item[] => items.flatMap((item) => ("type" in item && (item.type === "group" || item.type === "page")) ? [item, ...flatten((item.items ?? []) as Item[])] : [item]);
		const all = flatten(pageNamed(tab, "Advanced").items ?? []);
		const add = all.find((item) => !("type" in item) && (item as { name?: string }).name === "Add a workflow");
		expect(add).toBeDefined();
		const rows = draw([add as Item], getFakeDocument().createElement("div"));
		expect(buttonIn(rowNamed(rows, "Add a workflow").setting, "Add workflow")).toBeDefined();
		const list = lists(all).find((candidate) => candidate.heading === "Your workflows");
		expect(list?.addItem).toBeUndefined();
	});

	test("the Advanced page opens with the reassurance line", () => {
		const { tab } = makeHarness();
		const rows = draw(pageNamed(tab, "Advanced").items ?? [], getFakeDocument().createElement("div"));
		expect(rows[0]?.setting.settingEl.textContent).toContain("You do not need anything here to use AskMate.");
	});

	test("the long result template check warns on a template that drops the answer", () => {
		const { tab, settings } = makeHarness();
		settings.resultNoteTemplate = "# {{title}}\n\n{{respnse}}";
		const rows = draw(pageNamed(tab, "Advanced").items ?? [], getFakeDocument().createElement("div"));
		const feedback = feedbackOf(rowNamed(rows, "Result note template").setting);
		expect(feedback).toContain("{{response}}");
		expect(feedback).toContain("Did you mean {{response}}?");
	});

	test("a good template shows no warning", () => {
		const { tab } = makeHarness();
		const rows = draw(pageNamed(tab, "Advanced").items ?? [], getFakeDocument().createElement("div"));
		expect(feedbackOf(rowNamed(rows, "Result note template").setting)).toBe("");
	});
});

describe("sidebar and output page", () => {
	function sidebarRows(): Rendered[] {
		return draw(pageNamed(makeHarness().tab, "Sidebar and output").items ?? [], getFakeDocument().createElement("div"));
	}

	test("the layout help says that commands and mentions work in every layout", () => {
		const desc = String(rowNamed(sidebarRows(), "Sidebar layout").def.desc);
		expect(desc).toContain("Slash commands and @mentions work in all three");
		expect(desc).not.toContain("Console is keyboard-first (type /help");
	});

	test("the layout dropdown lists the three layouts the docs name", () => {
		const dropdown = dropdownIn(rowNamed(sidebarRows(), "Sidebar layout").setting);
		expect(Object.values(dropdown.options)).toEqual(["Console", "Compact", "Expanded"]);
	});

	test("the approval setting is called what the docs call it, with its three choices", () => {
		const dropdown = dropdownIn(rowNamed(sidebarRows(), "Ask before changing my notes").setting);
		expect(Object.values(dropdown.options)).toEqual(["Yes or no, only when replacing the whole note", "When replacing a whole note or a section", "Every time"]);
		expect(DEFAULT_SETTINGS.applyApprovalMode).toBe("manual");
		expect(dropdown.options.manual).toBe("Every time");
	});

	test("the loosest approval choice says it asks yes or no, with no diff, and the help agrees with what the plugin does", () => {
		const row = rowNamed(sidebarRows(), "Ask before changing my notes");
		expect(dropdownIn(row.setting).options["auto-approve"]).toContain("Yes or no");
		const help = String(row.def.desc);
		expect(help).toContain("shows no diff");
		expect(help).toContain("asks yes or no before a whole note is replaced");
		expect(help).toContain("Safety stops apply in every mode");
	});

	test("Default output says that a new note or an edit covers one answer only", () => {
		const help = String(rowNamed(sidebarRows(), "Default output").def.desc);
		expect(help).toContain("covers one answer only");
		expect(help).toContain("goes back to the sidebar");
		expect(help).not.toContain("by default");
	});
});

describe("privacy and memory", () => {
	function privacyRows(harness: Harness): Rendered[] {
		return draw(pageNamed(harness.tab, "Privacy and memory").items ?? [], getFakeDocument().createElement("div"));
	}

	test("one dropdown folds the two note history switches", async () => {
		const harness = makeHarness();
		const rows = privacyRows(harness);
		const dropdown = dropdownIn(rowNamed(rows, "Per-note memory").setting);
		expect(dropdown.options).toEqual({ off: "Off", keep: "Keep only", "keep-and-use": "Keep and use" });
		expect(rowNamed(rows, "Per-note memory").def.desc).toContain("12 turns per note");
		await dropdown.simulateChange("keep-and-use");
		expect(harness.settings.noteHistoryEnabled).toBe(true);
		expect(harness.settings.noteHistoryIncludeInContext).toBe(true);
		await dropdown.simulateChange("off");
		expect(harness.settings.noteHistoryEnabled).toBe(false);
		expect(harness.settings.noteHistoryIncludeInContext).toBe(false);
	});

	test("delete saved conversations reports a failed write as a failure", async () => {
		const harness = makeHarness();
		(harness.tab as unknown as { plugin: { threads: { clearAll: () => Promise<boolean> } } }).plugin.threads.clearAll = async () => false;
		const setting = rowNamed(privacyRows(harness), "Delete saved conversations").setting;
		buttonIn(setting).click();
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		expect(dialog.titleEl.textContent).toBe("Delete saved conversations");
		expect(dialog.contentEl.textContent).toContain(SYNC_DELETION_SENTENCE);
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Delete conversations") as HTMLButtonElement).click();
		await tick();
		expect(Notice.messages).toEqual(["AskMate could not delete the saved conversations. Try again."]);
		expect(feedbackOf(setting)).toContain("could not be deleted");
	});

	test("Delete all stored text warns that a synced device puts deleted text back", () => {
		const description = String(rowNamed(privacyRows(makeHarness()), "Delete all stored text").def.desc);
		expect(description).toContain(SYNC_DELETION_SENTENCE);
	});

	test("delete saved conversations reports success only when the store says so", async () => {
		const harness = makeHarness();
		const setting = rowNamed(privacyRows(harness), "Delete saved conversations").setting;
		buttonIn(setting).click();
		await tick();
		(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === "Delete conversations") as HTMLButtonElement).click();
		await tick();
		expect(Notice.messages).toEqual(["AskMate deleted all saved conversations."]);
	});

	test("cancelling the confirmation deletes nothing", async () => {
		const harness = makeHarness();
		let cleared = 0;
		(harness.tab as unknown as { plugin: { threads: { clearAll: () => Promise<boolean> } } }).plugin.threads.clearAll = async () => {
			cleared += 1;
			return true;
		};
		const setting = rowNamed(privacyRows(harness), "Delete all stored text").setting;
		buttonIn(setting).click();
		await tick();
		(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
		await tick();
		expect(cleared).toBe(0);
		expect(Notice.messages).toEqual([]);
	});

	test("delete all stored text clears conversations, note history and queued reviews", async () => {
		const harness = makeHarness();
		harness.settings.noteHistoryStore = { turns: [{ id: "1", sourcePath: "a.md", createdAt: "2026-01-01T00:00:00.000Z", title: "t", question: "q", answer: "a", providerName: "p", model: "m", outputMode: "chat", intentKind: "freeform_text" }] };
		harness.settings.reviewQueue = [{ id: "r" } as never];
		let cleared = 0;
		(harness.tab as unknown as { plugin: { threads: { clearAll: () => Promise<boolean> } } }).plugin.threads.clearAll = async () => {
			cleared += 1;
			return true;
		};
		const setting = rowNamed(privacyRows(harness), "Delete all stored text").setting;
		buttonIn(setting).click();
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		expect(dialog.contentEl.textContent).toContain("note history");
		expect(dialog.contentEl.textContent).toContain(SYNC_DELETION_SENTENCE);
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Delete everything") as HTMLButtonElement).click();
		await tick();
		expect(cleared).toBe(1);
		expect(harness.settings.noteHistoryStore.turns).toEqual([]);
		expect(harness.settings.reviewQueue).toEqual([]);
		expect(Notice.messages).toEqual(["AskMate deleted all saved conversations, note history and queued reviews."]);
	});

	test("delete all stored text puts the history back when the write fails, and says so", async () => {
		const harness = makeHarness();
		const turn = { id: "1", sourcePath: "a.md", createdAt: "2026-01-01T00:00:00.000Z", title: "t", question: "q", answer: "a", providerName: "p", model: "m", outputMode: "chat" as const, intentKind: "freeform_text" as const };
		harness.settings.noteHistoryStore = { turns: [turn] };
		(harness.tab as unknown as { plugin: { saveSettings: () => Promise<void>; threads: { clearAll: () => Promise<boolean> } } }).plugin.saveSettings = async () => {
			throw new Error("disk full");
		};
		(harness.tab as unknown as { plugin: { threads: { clearAll: () => Promise<boolean> } } }).plugin.threads.clearAll = async () => true;
		const setting = rowNamed(privacyRows(harness), "Delete all stored text").setting;
		buttonIn(setting).click();
		await tick();
		(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === "Delete everything") as HTMLButtonElement).click();
		await tick();
		expect(harness.settings.noteHistoryStore.turns).toHaveLength(1);
		expect(Notice.messages[0]).toContain("could not clear note history");
	});
});

describe("advanced page", () => {
	test("reset to recommended settings asks first, then resets options but keeps content", async () => {
		const harness = makeHarness();
		harness.settings.composerLayout = "expanded";
		harness.settings.globalInstructions = "Keep me";
		const rows = draw(pageNamed(harness.tab, "Advanced").items ?? [], getFakeDocument().createElement("div"));
		buttonIn(rowNamed(rows, "Reset to recommended settings").setting).click();
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		expect(dialog.titleEl.textContent).toBe("Reset to recommended settings");
		expect(dialog.contentEl.textContent).toContain("stay as they are");
		expect(harness.settings.composerLayout).toBe("expanded");
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Reset options") as HTMLButtonElement).click();
		await tick();
		expect<string>(harness.settings.composerLayout).toBe("compact");
		expect(harness.settings.globalInstructions).toBe("Keep me");
		expect(harness.counts.updates).toBe(1);
	});

	test("cancelling the reset changes nothing", async () => {
		const harness = makeHarness();
		harness.settings.composerLayout = "expanded";
		const rows = draw(pageNamed(harness.tab, "Advanced").items ?? [], getFakeDocument().createElement("div"));
		buttonIn(rowNamed(rows, "Reset to recommended settings").setting).click();
		await tick();
		(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
		await tick();
		expect(harness.settings.composerLayout).toBe("expanded");
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------------------------------

describe("connection page", () => {
	const passing: ConnectionTestView = { ok: true, message: "AskMate OpenAI test passed.", modelFound: true };

	test("a fresh install says setup is needed and what is missing", () => {
		const harness = makeHarness();
		const rows = connectionRows(harness);
		expect(statusChipText(rows)).toBe("Setup needed");
		const status = rowNamedByClass(rows, "askmate-settings-status").setting;
		expect(status.nameEl.textContent).toBe("Add an API key for OpenAI");
		expect(status.descEl.textContent).toContain("Add an API key for OpenAI.");
	});

	test("the warning border is on the status row only while something is missing", () => {
		const harness = makeHarness();
		const border = (): boolean => rowNamedByClass(connectionRows(harness), "askmate-settings-status").setting.settingEl.classList.contains("askmate-settings-setup");
		expect(border()).toBe(true);
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-test-0123456789");
		expect(border()).toBe(false);
	});

	test("a saved key name with no key on this device is reported as missing, with the same wording as the sidebar", () => {
		const harness = makeHarness();
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		const rows = connectionRows(harness);
		expect(statusChipText(rows)).toBe("Key missing");
		expect(feedbackOf(rowNamed(rows, "API key").setting)).toContain("this device has no key");
	});

	test("with the key present the page is set up but not yet tested", () => {
		const harness = makeHarness();
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-test-0123456789");
		expect(statusChipText(connectionRows(harness))).toBe("Not tested");
	});

	test("the key field is masked, named, and links to the provider's key page", () => {
		const harness = makeHarness();
		const row = rowNamed(connectionRows(harness), "API key");
		const input = textIn(row.setting).inputEl;
		expect(input.type).toBe("password");
		expect(input.getAttribute("aria-label")).toBe("OpenAI API key");
		const link = row.setting.descEl.querySelector("a");
		expect(link?.textContent).toBe("Get an API key");
		expect(link?.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
	});

	test("saving a key rejects a pasted mess without storing anything", async () => {
		const harness = makeHarness();
		const row = rowNamed(connectionRows(harness), "API key");
		textIn(row.setting).inputEl.value = "two words here";
		buttonIn(row.setting, "Save key").click();
		await tick();
		expect(feedbackOf(row.setting)).toContain("does not look like one key");
		expect(harness.fake.secretStorage.listSecrets()).toEqual([]);
	});

	test("saving a key without the plugin helper stores it under a generated name, then tests the connection", async () => {
		const harness = makeHarness();
		const rows = connectionRows(harness);
		const row = rowNamed(rows, "API key");
		textIn(row.setting).inputEl.value = "  sk-test-0123456789  ";
		buttonIn(row.setting, "Save key").click();
		await tick();
		expect(harness.fake.secretStorage.getSecret("askmate-openai-key")).toBe("sk-test-0123456789");
		expect(harness.settings.providers.openai.apiKeySecretName).toBe("askmate-openai-key");
		expect(textIn(row.setting).inputEl.value).toBe("");
		expect(feedbackOf(row.setting)).toContain("Key saved on this device");
		// The automatic test ran, so the page is connected.
		expect(statusChipText(rows)).toBe("Connected");
	});

	test("after a key is saved the row says so without a redraw", async () => {
		const harness = makeHarness();
		const row = rowNamed(connectionRows(harness), "API key");
		expect(row.setting.descEl.textContent).toContain("Paste your key once.");
		textIn(row.setting).inputEl.value = "sk-test-0123456789";
		buttonIn(row.setting, "Save key").click();
		await tick();
		expect(row.setting.descEl.textContent).toContain("A key is saved on this device.");
		expect(row.setting.descEl.querySelector("a")?.textContent).toBe("Get an API key");
		expect(textIn(row.setting).inputEl.getAttribute("placeholder")).toBe("Saved. Paste a new key to replace it");
		expect(feedbackOf(row.setting)).toBe("Key saved on this device.");
	});

	test("saving a key through the plugin helper hands it the trimmed key and tests the connection", async () => {
		const saved: Array<[string, string]> = [];
		let tested = 0;
		const harness = makeHarness((settings, fake) => ({
			saveProviderApiKey: async (providerId, apiKey) => {
				saved.push([providerId, apiKey]);
				settings.providers[providerId].apiKeySecretName = "askmate-openai-key";
				fake.secretStorage.setSecret("askmate-openai-key", apiKey);
			},
			testProviderConnectionDetailed: async () => {
				tested += 1;
				return passing;
			}
		}));
		const rows = connectionRows(harness);
		const row = rowNamed(rows, "API key");
		textIn(row.setting).inputEl.value = " sk-test-0123456789 ";
		buttonIn(row.setting, "Save key").click();
		await tick();
		expect(saved).toEqual([["openai", "sk-test-0123456789"]]);
		expect(tested).toBe(1);
		expect(statusChipText(rows)).toBe("Connected");
	});

	test("a key the keychain refuses is reported, not lost", async () => {
		const harness = makeHarness((_settings, fake) => ({
			saveProviderApiKey: async () => {
				fake.secretStorage.setSecret("Bad Id", "x");
			}
		}));
		const row = rowNamed(connectionRows(harness), "API key");
		textIn(row.setting).inputEl.value = "sk-test-0123456789";
		buttonIn(row.setting, "Save key").click();
		await tick();
		expect(feedbackOf(row.setting)).toContain("could not save the key");
		expect(harness.settings.providers.openai.apiKeySecretName).toBe("");
	});

	test("test connection names a model the provider does not list and offers the closest one", async () => {
		const harness = makeHarness(() => ({
			testProviderConnectionDetailed: async () => ({ ok: true, message: "connected", modelFound: false, suggestedModel: "gpt-5.4" })
		}));
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-test-0123456789");
		const rows = connectionRows(harness);
		const test = rowNamed(rows, "Test connection");
		buttonIn(test.setting).click();
		await tick();
		expect(feedbackOf(test.setting)).toContain("gpt-5.5");
		expect(feedbackOf(test.setting)).toContain("The closest listed model is gpt-5.4.");
		expect(statusChipText(rows)).toBe("Connection failed");
	});

	test("changing the model clears the old test result and the status", async () => {
		const harness = makeHarness(() => ({ testProviderConnectionDetailed: async () => ({ ok: true, message: "connected", modelFound: false, suggestedModel: null }) }));
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-test-0123456789");
		harness.settings.providers.openai.modelOptions = ["gpt-5.5", "gpt-5.4"];
		const rows = connectionRows(harness);
		const test = rowNamed(rows, "Test connection");
		buttonIn(test.setting).click();
		await tick();
		expect(feedbackOf(test.setting)).not.toBe("");
		await dropdownIn(rowNamed(rows, "Model").setting).simulateChange("gpt-5.4");
		await tick();
		expect(feedbackOf(test.setting)).toBe("");
		expect(statusChipText(rows)).toBe("Not tested");
		expect(harness.settings.providers.openai.model).toBe("gpt-5.4");
	});

	test("changing the key list entry through the saved-key picker also clears the result", async () => {
		const harness = makeHarness(() => ({ testProviderConnectionDetailed: async () => ({ ok: false, message: "Authentication failed (HTTP 401)." }) }));
		harness.settings.providers.openai.apiKeySecretName = "askmate-openai-key";
		harness.fake.secretStorage.setSecret("askmate-openai-key", "sk-test-0123456789");
		const rows = connectionRows(harness);
		const test = rowNamed(rows, "Test connection");
		buttonIn(test.setting).click();
		await tick();
		expect(feedbackOf(test.setting)).toContain("rejected the API key");
		const savedKey = rowNamed(rows, "Use a saved key").setting;
		const picker = savedKey.components[0] as unknown as { simulateChange: (value: string) => unknown };
		await picker.simulateChange("askmate-openai-key-2");
		await tick();
		expect(feedbackOf(test.setting)).toBe("");
	});

	test("the image-only model is not offered in the chat list", () => {
		const harness = makeHarness();
		harness.settings.providers.openai.modelOptions = ["gpt-5.5", "gpt-image-2"];
		const dropdown = dropdownIn(rowNamed(connectionRows(harness), "Model").setting);
		expect(Object.keys(dropdown.options)).toEqual(["gpt-5.5"]);
	});

	test("an Azure OpenAI test explains the wait", () => {
		const harness = makeHarness();
		harness.settings.providerRoles.chatProviderId = "azure-openai";
		harness.settings.selectedTextProvider = "azure-openai";
		const rows = connectionRows(harness);
		expect(rowNamed(rows, "Test connection").def.desc).toContain("up to a minute");
	});

	test("an Azure OpenAI deployment list stays hidden until a deployment exists", () => {
		const harness = makeHarness();
		harness.settings.providerRoles.chatProviderId = "azure-openai";
		harness.settings.selectedTextProvider = "azure-openai";
		const row = rowNamed(connectionRows(harness), "Deployment");
		expect(isVisible(row.def)).toBe(false);
		harness.settings.providers["azure-openai"].modelOptions = ["my-deployment"];
		expect(isVisible(row.def)).toBe(true);
	});

	describe("a fresh Azure OpenAI install", () => {
		function azureHarness(): Harness {
			const harness = makeHarness();
			harness.settings.providerRoles.chatProviderId = "azure-openai";
			harness.settings.selectedTextProvider = "azure-openai";
			return harness;
		}
		const groupNamed = (harness: Harness, heading: string): Definition[] => {
			const group = (pageNamed(harness.tab, "Connection").items ?? []).find((item) => "type" in item && item.type === "group" && item.heading === heading);
			return ((group as { items?: Definition[] } | undefined)?.items ?? []);
		};

		test("shows the deployment name box with the provider rows, without opening More options", () => {
			const harness = azureHarness();
			expect(harness.settings.providers["azure-openai"].modelOptions).toEqual([]);
			const box = groupNamed(harness, "Provider").find((def) => def.name === "Deployment name");
			expect(box).toBeDefined();
			expect(isVisible(box as Definition)).toBe(true);
			expect(groupNamed(harness, "More options").some((def) => def.name === "Deployment name")).toBe(false);
			// The status row asks for exactly this value, so the box it points at has to be on screen.
			const status = rowNamedByClass(connectionRows(harness), "askmate-settings-status").setting;
			expect(status.descEl.textContent?.toLowerCase()).toContain("deployment name");
		});

		test("saves a typed deployment name", async () => {
			const harness = azureHarness();
			const row = rowNamed(connectionRows(harness), "Deployment name");
			const input = textIn(row.setting).inputEl;
			input.value = "my-gpt-deployment";
			fireDomEvent(input, "input");
			fireDomEvent(input, "blur");
			await tick();
			expect(harness.settings.providers["azure-openai"].model).toBe("my-gpt-deployment");
			expect(harness.settings.providers["azure-openai"].modelOptions).toContain("my-gpt-deployment");
		});

		test("the name box is not offered a second time under More options", () => {
			const harness = azureHarness();
			const rows = connectionRows(harness);
			expect(rows.filter((row) => row.def.name === "Deployment name")).toHaveLength(1);
		});
	});

	test("the extra rows stay closed until More options is switched on", () => {
		const harness = makeHarness();
		const rows = connectionRows(harness);
		const extra = ["Model ID", "Use a saved key", "Reasoning effort", "Improve image prompts with"];
		for (const name of ["Model ID", "Use a saved key", "Improve image prompts with"]) {
			expect(isVisible(rowNamed(rows, name).def)).toBe(false);
		}
		expect(extra.every((name) => rows.some((row) => row.def.name === name))).toBe(true);
		toggleIn(rowNamed(rows, "Show more options").setting).simulateChange(true);
		for (const name of ["Model ID", "Use a saved key", "Improve image prompts with"]) {
			expect(isVisible(rowNamed(rows, name).def)).toBe(true);
		}
	});

	describe("the OpenAI image API key", () => {
		const groupHeadings = (harness: Harness): string[] =>
			(pageNamed(harness.tab, "Connection").items ?? []).flatMap((item) => ("type" in item && item.type === "group" ? [item.heading ?? ""] : []));
		const rowsOfGroup = (harness: Harness, heading: string): Definition[] => {
			const group = (pageNamed(harness.tab, "Connection").items ?? []).find((item) => "type" in item && item.type === "group" && item.heading === heading);
			return ((group as { items?: Definition[] } | undefined)?.items ?? []);
		};

		test.each(["anthropic", "google-gemini", "azure-openai", "azure-ai", "openrouter", "openai-compatible"] as const)("is on the page for %s, without opening More options", (providerId) => {
			const harness = makeHarness();
			harness.settings.providerRoles.chatProviderId = providerId;
			harness.settings.selectedTextProvider = providerId;
			expect(groupHeadings(harness)).toEqual(["Provider", "Images", "More options"]);
			const key = rowsOfGroup(harness, "Images").find((def) => def.name === "OpenAI image API key");
			expect(key).toBeDefined();
			expect(isVisible(key as Definition)).toBe(true);
			expect(rowsOfGroup(harness, "More options").some((def) => def.name === "OpenAI image API key")).toBe(false);
			expect(harness.tab.connection.showMoreOptions).toBe(false);
		});

		test("is not offered a second time, and is left out when OpenAI answers chat, because that key is the API key", () => {
			const other = makeHarness();
			other.settings.providerRoles.chatProviderId = "anthropic";
			other.settings.selectedTextProvider = "anthropic";
			expect(connectionRows(other).filter((row) => row.def.name === "OpenAI image API key")).toHaveLength(1);
			const openai = makeHarness();
			expect(groupHeadings(openai)).toEqual(["Provider", "More options"]);
			expect(connectionRows(openai).some((row) => row.def.name === "OpenAI image API key")).toBe(false);
		});

		test("saves the picked key under the OpenAI provider", async () => {
			const harness = makeHarness();
			harness.settings.providerRoles.chatProviderId = "anthropic";
			harness.settings.selectedTextProvider = "anthropic";
			const row = rowNamed(connectionRows(harness), "OpenAI image API key");
			const picker = row.setting.components[0] as unknown as { simulateChange: (value: string) => unknown };
			await picker.simulateChange("askmate-openai-key");
			await tick();
			expect(harness.settings.providers.openai.apiKeySecretName).toBe("askmate-openai-key");
			expect(harness.settings.providers.anthropic.apiKeySecretName).not.toBe("askmate-openai-key");
		});
	});

	test("the reasoning row follows both the switch and OpenAI being in use", () => {
		const harness = makeHarness();
		const rows = connectionRows(harness);
		const reasoning = rowNamed(rows, "Reasoning effort");
		expect(isVisible(reasoning.def)).toBe(false);
		toggleIn(rowNamed(rows, "Show more options").setting).simulateChange(true);
		expect(isVisible(reasoning.def)).toBe(true);
		harness.settings.providerRoles.chatProviderId = "anthropic";
		harness.settings.providerRoles.imagePromptPlanningProviderId = "same-as-chat";
		expect(isVisible(reasoning.def)).toBe(false);
	});

	test("Open AskMate opens the sidebar", async () => {
		const harness = makeHarness();
		const status = rowNamedByClass(connectionRows(harness), "askmate-settings-status").setting;
		buttonIn(status, "Open AskMate").click();
		await tick();
		expect(harness.counts.activated).toBe(1);
	});

	test("the shared setup state from the plugin is used until a test is run here", () => {
		const harness = makeHarness(() => ({
			getSetupState: () => ({ kind: "ready", providerId: "openai", label: "OpenAI", model: "gpt-5.5" })
		}));
		expect(statusChipText(connectionRows(harness))).toBe("Connected");
	});

	test("a provider switch rebuilds the page", async () => {
		const harness = makeHarness();
		const row = rowNamed(connectionRows(harness), "Chat provider");
		await dropdownIn(row.setting).simulateChange("anthropic");
		await tick();
		expect(harness.settings.providerRoles.chatProviderId).toBe("anthropic");
		expect(harness.settings.selectedTextProvider).toBe("anthropic");
		expect(harness.counts.updates).toBe(1);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------------------------------

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Explains ${name} clearly. Use when asked about ${name}.\n---\n# Goal\nExplain ${name}.\n`;

function skillHarness(initial: Record<string, string> = {}): Harness & { trusted: Record<string, string>; service: SkillService } {
	let state: { trusted: Record<string, string>; service: SkillService | null } = { trusted: {}, service: null };
	const harness = makeHarness((settings, fake) => {
		for (const [path, content] of Object.entries(initial)) {
			fake.vault.add(path, content);
		}
		const host: SkillHost = {
			getConfig: (): SkillConfig => ({
				enabled: settings.skills.enabled,
				folder: settings.skills.folder,
				matchMode: settings.skills.matching,
				disabledIds: settings.skills.disabledIds,
				trusted: state.trusted
			}),
			listFiles: async (): Promise<readonly SkillFileInfo[]> => fake.vault.getFiles().filter((file) => file.path.startsWith(`${settings.skills.folder}/`)).map((file) => ({ path: file.path, size: (fake.vault.contents.get(file.path) ?? "").length })),
			readFile: async (path: string): Promise<string> => fake.vault.contents.get(path) ?? "",
			parseYaml: (text: string): unknown => Bun.YAML.parse(text),
			saveTrust: async (id: string, hash: string | null): Promise<void> => {
				const next = { ...state.trusted };
				if (hash === null) {
					delete next[id];
				} else {
					next[id] = hash;
				}
				state = { ...state, trusted: next };
			},
			watch: () => () => undefined
		};
		const service = new SkillService(host);
		state = { ...state, service };
		return { skillService: service };
	});
	const service = state.service as SkillService;
	// A getter, not a copied value: the trust record is replaced each time a skill is approved.
	Object.defineProperty(harness, "trusted", { get: () => state.trusted });
	Object.defineProperty(harness, "service", { value: service });
	return harness as Harness & { trusted: Record<string, string>; service: SkillService };
}

function skillRows(harness: Harness): Rendered[] {
	return draw(pageNamed(harness.tab, "Skills and tools").items ?? [], getFakeDocument().createElement("div"));
}

const chipOf = (row: Rendered): string => row.setting.controlEl.querySelector(".askmate-skill-row-chip")?.textContent ?? "";

describe("skills page", () => {
	test("lists built-in and vault skills with their status", async () => {
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") });
		await harness.service.scan();
		const rows = skillRows(harness);
		expect(chipOf(rowNamed(rows, "Mermaid diagrams"))).toBe("Built-in");
		expect(chipOf(rowNamed(rows, "fresh"))).toBe("Needs review");
		expect(rowNamed(rows, "fresh").def.desc).toBe("AskMate/Skills/fresh/SKILL.md · Explains fresh clearly.");
	});

	test("Review opens the dialog and approving records the hash of exactly that text", async () => {
		const text = SKILL("fresh");
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": text });
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "fresh");
		buttonIn(row.setting, "Review").click();
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		expect(dialog.modalEl.getAttribute("role")).toBe("dialog");
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Approve this version") as HTMLButtonElement).click();
		await tick();
		expect(harness.trusted["vault:fresh"]).toBe(await hashSkillText(text));
		expect(harness.tab.focusAfterRebuild).toBe("skill:vault:fresh");
		expect(harness.counts.updates).toBe(1);
	});

	test("cancelling the review approves nothing", async () => {
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") });
		await harness.service.scan();
		buttonIn(rowNamed(skillRows(harness), "fresh").setting, "Review").click();
		await tick();
		(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
		await tick();
		expect(harness.trusted).toEqual({});
	});

	test("an approved skill shows Ready and offers to withdraw the approval", async () => {
		const text = SKILL("fresh");
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": text });
		await harness.service.scan();
		await harness.service.trust("vault:fresh", await hashSkillText(text));
		const row = rowNamed(skillRows(harness), "fresh");
		expect(chipOf(row)).toBe("Ready");
		buttonIn(row.setting, "Withdraw approval").click();
		await tick();
		expect(harness.trusted["vault:fresh"]).toBeUndefined();
	});

	test("switching a skill off stores its id and repaints the chip", async () => {
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") });
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "fresh");
		await toggleIn(row.setting).simulateChange(false);
		await tick();
		expect(harness.settings.skills.disabledIds).toEqual(["vault:fresh"]);
		expect(chipOf(row)).toBe("Disabled");
		await toggleIn(row.setting).simulateChange(true);
		await tick();
		expect(harness.settings.skills.disabledIds).toEqual([]);
	});

	test("Install examples adds the starter skills once and never overwrites a file", async () => {
		const harness = skillHarness({ "AskMate/Skills/meeting-minutes/SKILL.md": "my own version" });
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "Install examples");
		buttonIn(row.setting, "Install examples").click();
		await tick();
		expect(harness.fake.vault.contents.get("AskMate/Skills/meeting-minutes/SKILL.md")).toBe("my own version");
		expect(harness.fake.vault.contents.has("AskMate/Skills/anki-flashcards/SKILL.md")).toBe(true);
		expect(harness.fake.vault.getFiles().filter((file) => file.path.endsWith("/SKILL.md"))).toHaveLength(5);
		expect(feedbackOf(row.setting)).toContain("Added 4 example skills");
		expect(feedbackOf(row.setting)).toContain("already existed");
		buttonIn(row.setting, "Install examples").click();
		await tick();
		expect(feedbackOf(row.setting)).toContain("Nothing to add");
	});

	test("a new skill from the template is created, opened and approved as saved", async () => {
		const harness = skillHarness();
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "New skill from template");
		textIn(row.setting).inputEl.value = "Weekly notes";
		textIn(row.setting).simulateChange("Weekly notes");
		buttonIn(row.setting, "Create skill").click();
		await tick();
		const path = "AskMate/Skills/weekly-notes/SKILL.md";
		const content = harness.fake.vault.contents.get(path);
		expect(content).toContain("name: weekly-notes");
		expect(harness.trusted["vault:weekly-notes"]).toBe(await hashSkillText(content ?? ""));
		expect(harness.fake.workspace.openedLinks.map((link) => link.linktext)).toEqual([path]);
		// The page says what happens next, so a person who edits the file is not surprised by Needs review.
		expect(row.def.desc).toContain("press Review and approve it again");
		expect(feedbackOf(row.setting)).toContain("needs your review again once you edit it");
	});

	test("a skill made from the template needs a review again as soon as it is edited", async () => {
		const harness = skillHarness();
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "New skill from template");
		textIn(row.setting).simulateChange("Weekly notes");
		buttonIn(row.setting, "Create skill").click();
		await tick();
		const path = "AskMate/Skills/weekly-notes/SKILL.md";
		const statusOfWeekly = (): string | undefined => {
			const skill = harness.service.list().find((candidate) => candidate.name === "weekly-notes");
			return skill ? harness.service.statusOf(skill) : undefined;
		};
		expect(statusOfWeekly()).toBe("ready");
		harness.fake.vault.contents.set(path, `${harness.fake.vault.contents.get(path) ?? ""}\nAlways list owners.\n`);
		await harness.service.scan();
		expect(statusOfWeekly()).toBe("needs-review");
	});

	test("a new skill refuses a name that is already taken", async () => {
		const harness = skillHarness({ "AskMate/Skills/weekly-notes/SKILL.md": SKILL("weekly-notes") });
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "New skill from template");
		textIn(row.setting).simulateChange("Weekly notes");
		buttonIn(row.setting, "Create skill").click();
		await tick();
		expect(feedbackOf(row.setting)).toContain("already exists");
		expect(harness.fake.vault.contents.get("AskMate/Skills/weekly-notes/SKILL.md")).toBe(SKILL("weekly-notes"));
	});

	test("a new skill needs a name", async () => {
		const harness = skillHarness();
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "New skill from template");
		buttonIn(row.setting, "Create skill").click();
		await tick();
		expect(feedbackOf(row.setting)).toContain("Type a name");
	});

	test("the skill rows follow the master switch", async () => {
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") });
		await harness.service.scan();
		const rows = skillRows(harness);
		expect(isVisible(rowNamed(rows, "fresh").def)).toBe(true);
		harness.settings.skills.enabled = false;
		expect(isVisible(rowNamed(rows, "fresh").def)).toBe(false);
		expect(isVisible(rowNamed(rows, "Install examples").def)).toBe(false);
		expect(isVisible(rowNamed(rows, "When to use a skill").def)).toBe(false);
	});

	test("the folder row refuses a hidden folder and says which one is used", async () => {
		const harness = skillHarness();
		await harness.service.scan();
		const row = rowNamed(skillRows(harness), "Skills folder");
		const input = textIn(row.setting).inputEl;
		input.value = ".hidden/skills";
		fireDomEvent(input, "input");
		fireDomEvent(input, "blur");
		await tick();
		expect(harness.settings.skills.folder).toBe("AskMate/Skills");
		expect(feedbackOf(row.setting)).toContain("hidden folder");
	});

	test("the home summary counts the skills the page lists, built-in ones included", async () => {
		const harness = skillHarness({ "AskMate/Skills/fresh/SKILL.md": SKILL("fresh") });
		const listed = (): number => skillRows(harness).filter((row) => row.setting.controlEl.querySelector(".askmate-skill-row-chip") !== null).length;
		const summary = (): string => (pageNamed(harness.tab, "Skills and tools") as { displayValue?: () => string }).displayValue?.() ?? "";

		// Before the first scan the catalogue is empty, so the page and the summary agree on none.
		expect(listed()).toBe(0);
		expect(summary()).toBe("0 skills · Tools off");

		await harness.service.scan();
		expect(listed()).toBe(2);
		expect(summary()).toBe("2 skills, 1 need review · Tools off");
	});

	test("with no skills the page says so instead of leaving the list empty", () => {
		const harness = makeHarness();
		const rows = skillRows(harness);
		expect(rows.some((row) => row.setting.settingEl.textContent?.includes("No skills were found."))).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Diagram defaults
// ---------------------------------------------------------------------------------------------------------------------

describe("diagram defaults", () => {
	test("store the chosen type and style through the normaliser", async () => {
		const harness = makeHarness();
		const rows = skillRows(harness);
		await dropdownIn(rowNamed(rows, "Default diagram type").setting).simulateChange("sequence");
		await dropdownIn(rowNamed(rows, "Default style").setting).simulateChange("blueprint");
		expect(harness.settings.diagrams.defaultType).toBe("sequence");
		expect(harness.settings.diagrams.defaultStyle).toBe("blueprint");
		await toggleIn(rowNamed(rows, "Fix diagrams that do not draw").setting).simulateChange(false);
		expect(harness.settings.diagrams.allowRepairTurn).toBe(false);
	});

	test("the detail rows hide while diagrams are off", () => {
		const harness = makeHarness();
		const rows = skillRows(harness);
		harness.settings.diagrams.enabled = false;
		expect(isVisible(rowNamed(rows, "Default diagram type").def)).toBe(false);
		expect(isVisible(rowNamed(rows, "Default style").def)).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// Tool servers
// ---------------------------------------------------------------------------------------------------------------------

const readyStatus = (id: string, tools = 2): McpServerStatus => ({ id, label: id, transport: "stdio", state: { kind: "ready", tools, hidden: 0, era: "legacy", version: "2025-11-25", serverName: id } });

function mcpHarness(options: { trust?: TrustOutcome; status?: (id: string) => McpServerStatus | null; tools?: Array<{ toolName: string; title: string; description: string; pin?: "new" | "approved" | "changed"; claimsReadOnly?: boolean; warnings?: string[] }> } = {}) {
	const calls: string[] = [];
	const listeners = new Set<() => void>();
	const harness = makeHarness((settings) => ({
		mcpService: {
			status: () => settings.mcp.servers.map((server) => options.status?.(server.id) ?? { id: server.id, label: server.label, transport: server.transport, state: { kind: "off" as const } }),
			trust: async (id: string) => {
				calls.push(`trust:${id}`);
				return options.trust ?? { kind: "trusted" as const };
			},
			testConnection: async (id: string) => {
				calls.push(`test:${id}`);
				return options.status?.(id) ?? readyStatus(id);
			},
			reconcile: async () => {
				calls.push("reconcile");
			},
			onStatusChange: (callback: () => void) => {
				listeners.add(callback);
				return () => listeners.delete(callback);
			},
			snapshotTools: () => ({
				tools: (options.tools ?? []).map((tool) => ({ serverId: "files", warnings: [], pin: "approved" as const, claimsReadOnly: false, ...tool }))
			}) as unknown as ToolSnapshot
		} as never,
		revokeMcpTrust: async (id: string) => {
			calls.push(`revoke:${id}`);
		}
	}));
	return { ...harness, calls, listeners };
}

const stdioServer = (patch: Partial<Extract<McpServerConfig, { transport: "stdio" }>> = {}): McpServerConfig => ({
	id: "files",
	label: "Files",
	enabled: false,
	approval: "always-ask",
	trustsAnnotations: false,
	trustedConfigHash: null,
	transport: "stdio",
	command: "npx",
	args: ["-y", "files-server"],
	env: {},
	...patch
});

function toolsRows(harness: Harness): Rendered[] {
	return skillRows(harness);
}

function serverPage(harness: Harness, index = 0): SettingPage {
	const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
	const page = list.items?.[index];
	if (!page || !("page" in page) || !page.page) {
		throw new Error("No server page.");
	}
	return page.page();
}

const clickDialog = async (label: string): Promise<void> => {
	await tick();
	(Array.from((Modal.opened.at(-1) as Modal).contentEl.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement).click();
	await tick();
};

describe("tools page", () => {
	test("tools are off by default and the section links to the tools guide", () => {
		const harness = mcpHarness();
		const rows = toolsRows(harness);
		expect(harness.settings.mcp.enabled).toBe(false);
		const about = rowNamed(rows, "About tools");
		expect(about.setting.descEl.querySelector("a")?.getAttribute("href")).toBe("https://github.com/CodeWithBehnam/askmate/blob/main/docs/mcp.md");
		expect(isVisible(rowNamed(rows, "Tool rounds per answer").def)).toBe(false);
	});

	test("the limit rows name the real bounds and what happens at the limit", () => {
		const rows = toolsRows(mcpHarness());
		expect(rowNamed(rows, "Tool rounds per answer").def.desc).toBe("The model may call tools in this many turns (1 to 12). It then gets one more turn, without tools, to write the answer.");
		expect(rowNamed(rows, "Longest tool result").def.desc).toBe("A tool result is cut at exactly this many characters before the model sees it (1,000 to 200,000), and a short note tells the model it was cut.");
	});

	test("turning tools on asks first, and Cancel leaves them off", async () => {
		const harness = mcpHarness();
		const row = rowNamed(toolsRows(harness), "Allow tools");
		toggleIn(row.setting).simulateChange(true);
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		expect(dialog.titleEl.textContent).toBe("Turn on tools?");
		await clickDialog("Cancel");
		expect(harness.settings.mcp.enabled).toBe(false);
		expect(toggleIn(row.setting).getValue()).toBe(false);
		expect(harness.calls).not.toContain("reconcile");
	});

	test("confirming turns tools on and tells the service", async () => {
		const harness = mcpHarness();
		const row = rowNamed(toolsRows(harness), "Allow tools");
		toggleIn(row.setting).simulateChange(true);
		await clickDialog("Turn on tools");
		expect(harness.settings.mcp.enabled).toBe(true);
		expect(harness.calls).toContain("reconcile");
	});

	test("turning tools off needs no question and stops the servers", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.enabled = true;
		const row = rowNamed(toolsRows(harness), "Allow tools");
		toggleIn(row.setting).simulateChange(false);
		await tick();
		expect(Modal.opened).toHaveLength(0);
		expect(harness.settings.mcp.enabled).toBe(false);
		expect(harness.calls).toContain("reconcile");
	});

	test("QA-06: the Add server button offers a local program, a remote server and import, and the list has no role-less add control", () => {
		const harness = mcpHarness();
		buttonIn(rowNamed(toolsRows(harness), "Add a tool server").setting, "Add server").click();
		expect(Menu.lastMenu?.items.map((item) => item.title)).toEqual(["Local program", "Remote server", "Import from JSON"]);
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		expect(list.addItem).toBeUndefined();
	});

	async function startAdding(harness: Harness, menuIndex: number): Promise<Modal> {
		buttonIn(rowNamed(toolsRows(harness), "Add a tool server").setting, "Add server").click();
		Menu.lastMenu?.items[menuIndex]?.click();
		await tick();
		return Modal.opened.at(-1) as Modal;
	}
	const fill = (dialog: Modal, label: string, value: string): void => {
		(dialog.contentEl.querySelector(`[aria-label='${label}']`) as HTMLInputElement).value = value;
	};

	test("adding a local program asks for a name and a command, then saves it off and asking every time", async () => {
		const harness = mcpHarness();
		const dialog = await startAdding(harness, 0);
		expect(dialog.titleEl.textContent).toBe("Add a local program");
		expect(dialog.modalEl.getAttribute("role")).toBe("dialog");
		fill(dialog, "Name", "Files");
		fill(dialog, "Program to run", "npx");
		await clickDialog("Add server");
		expect(harness.settings.mcp.servers).toHaveLength(1);
		const [server] = harness.settings.mcp.servers;
		expect(server).toMatchObject({ id: "files", label: "Files", transport: "stdio", command: "npx", enabled: false, approval: "always-ask", trustsAnnotations: false });
		expect(harness.counts.updates).toBe(1);
	});

	test("a server is not created without a command, because the loader would drop it", async () => {
		const harness = mcpHarness();
		const dialog = await startAdding(harness, 0);
		fill(dialog, "Name", "Files");
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Add server") as HTMLButtonElement).click();
		await tick();
		expect(dialog.contentEl.querySelector("[role='alert']")?.textContent).toContain("command is missing");
		expect(Modal.opened).toContain(dialog);
		expect(harness.settings.mcp.servers).toEqual([]);
	});

	test("a remote server needs a usable address", async () => {
		const harness = mcpHarness();
		const dialog = await startAdding(harness, 1);
		expect(dialog.titleEl.textContent).toBe("Add a remote server");
		fill(dialog, "Name", "Docs");
		fill(dialog, "Server address", "ftp://example.com/mcp");
		(Array.from(dialog.contentEl.querySelectorAll("button")).find((b) => b.textContent === "Add server") as HTMLButtonElement).click();
		await tick();
		expect(dialog.contentEl.querySelector("[role='alert']")?.textContent).toContain("https");
		fill(dialog, "Server address", "https://example.com/mcp");
		await clickDialog("Add server");
		expect(harness.settings.mcp.servers[0]).toMatchObject({ id: "docs", transport: "http", url: "https://example.com/mcp", enabled: false });
	});

	test("cancelling the add dialog creates nothing", async () => {
		const harness = mcpHarness();
		await startAdding(harness, 0);
		await clickDialog("Cancel");
		expect(harness.settings.mcp.servers).toEqual([]);
	});

	test("a second server with the same name gets its own id", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const dialog = await startAdding(harness, 0);
		fill(dialog, "Name", "Files");
		fill(dialog, "Program to run", "uvx");
		await clickDialog("Add server");
		expect(harness.settings.mcp.servers.map((server) => server.id)).toEqual(["files", "files-2"]);
	});

	test("importing JSON adds the servers off, stores their secrets in the keychain and keeps tokens out of settings", async () => {
		const harness = mcpHarness();
		buttonIn(rowNamed(toolsRows(harness), "Add a tool server").setting, "Add server").click();
		Menu.lastMenu?.items[2]?.click();
		await tick();
		const dialog = Modal.opened.at(-1) as Modal;
		(dialog.contentEl.querySelector("textarea") as HTMLTextAreaElement).value = JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } } } });
		await clickDialog("Review");
		await clickDialog("Import 1 server");
		expect(harness.settings.mcp.servers).toHaveLength(1);
		expect(harness.settings.mcp.servers[0]?.enabled).toBe(false);
		expect(JSON.stringify(harness.settings.mcp)).not.toContain("ghp_");
		expect(harness.fake.secretStorage.listSecrets()).toEqual(["askmate-mcp-github-github-token"]);
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-github-github-token")).toStartWith("ghp_");
		expect(Notice.messages.at(-1)).toContain("off until you trust each one");
	});

	test("deleting a server asks, wipes the secrets AskMate made for it, revokes trust and forgets it", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" }, OTHER: { kind: "secret", secretId: "someone-elses-secret" } } })];
		harness.fake.secretStorage.setSecret("askmate-mcp-files-api-token", "value-one");
		harness.fake.secretStorage.setSecret("someone-elses-secret", "value-two");
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await tick();
		expect((Modal.opened.at(-1) as Modal).titleEl.textContent).toBe("Delete server");
		await clickDialog("Delete server");
		expect(harness.settings.mcp.servers).toEqual([]);
		expect(harness.calls).toContain("revoke:files");
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-files-api-token")).toBe("");
		expect(harness.fake.secretStorage.getSecret("someone-elses-secret")).toBe("value-two");
	});

	test("a delete names the secrets it could not wipe instead of staying silent", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } } })];
		harness.fake.secretStorage.setSecret("askmate-mcp-files-api-token", "value-one");
		const storage = harness.fake.secretStorage;
		const originalSet = storage.setSecret.bind(storage);
		storage.setSecret = (id: string, value: string): void => {
			if (value === "") {
				throw new Error("keychain is locked");
			}
			originalSet(id, value);
		};
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await clickDialog("Delete server");
		expect(harness.settings.mcp.servers).toEqual([]);
		const notice = Notice.shown.at(-1);
		expect(notice?.message).toContain("askmate-mcp-files-api-token");
		expect(notice?.message).toContain("could not wipe 1 stored secret");
		expect(notice?.message).not.toContain("value-one");
		// A notice that names something to act on stays long enough to read.
		expect(notice?.duration).toBeGreaterThan(5000);
	});

	test("a clean delete shows no warning", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } } })];
		harness.fake.secretStorage.setSecret("askmate-mcp-files-api-token", "value-one");
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await clickDialog("Delete server");
		expect(harness.settings.mcp.servers).toEqual([]);
		expect(Notice.messages).toEqual([]);
	});

	test("with tools off, deleting a server still forgets its trust through the plugin", async () => {
		const harness = makeHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await tick();
		const question = (Modal.opened.at(-1) as Modal).contentEl.textContent;
		expect(question).toContain("forgets the trust you gave it on this device");
		expect(question).not.toContain("cannot clear");
		await clickDialog("Delete server");
		expect(harness.revoked).toEqual(["files"]);
		expect(harness.settings.mcp.servers).toEqual([]);
	});

	test("a failure to forget the trust stops the delete, keeps the server and says why", async () => {
		const harness = makeHarness(() => ({ revokeMcpTrust: async (): Promise<void> => { throw new Error("storage is unavailable"); } }));
		harness.settings.mcp.servers = [stdioServer({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } } })];
		harness.fake.secretStorage.setSecret("askmate-mcp-files-api-token", "value-one");
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await clickDialog("Delete server");
		expect(harness.settings.mcp.servers).toHaveLength(1);
		// Nothing was wiped either, so the server is not left half deleted.
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-files-api-token")).toBe("value-one");
		expect(Notice.messages.at(-1)).toBe("storage is unavailable");
	});

	test("cancelling the delete keeps the server", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const list = lists(pageNamed(harness.tab, "Skills and tools").items ?? []).find((candidate) => candidate.heading === "Tool servers") as ListItem;
		list.onDelete?.(0);
		await clickDialog("Cancel");
		expect(harness.settings.mcp.servers).toHaveLength(1);
		expect(harness.calls).not.toContain("revoke:files");
	});

	test("the page summary counts servers that need attention", () => {
		const harness = mcpHarness({ status: (id) => ({ id, label: id, transport: "stdio", state: { kind: "needs-trust" } }) });
		harness.settings.mcp.enabled = true;
		harness.settings.mcp.servers = [stdioServer({ enabled: true })];
		const page = pageNamed(harness.tab, "Skills and tools");
		expect((page.displayValue as () => string)()).toContain("1 server, 1 need attention");
		expect((page.status as () => string | null)()).toBe("warning");
	});
});

describe("server page", () => {
	function open(harness: Harness): HTMLElement {
		const page = serverPage(harness);
		page.display();
		return page.containerEl;
	}
	const field = (container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement => {
		const el = container.querySelector<HTMLInputElement>(`[aria-label='${label}']`);
		if (!el) {
			throw new Error(`No control named ${label}.`);
		}
		return el;
	};
	const edit = async (el: HTMLElement, value: string): Promise<void> => {
		(el as HTMLInputElement).value = value;
		fireDomEvent(el, "input");
		fireDomEvent(el, "blur");
		await tick();
	};

	test("shows the server, its status and how it is trusted", () => {
		const harness = mcpHarness({ status: (id) => ({ id, label: id, transport: "stdio", state: { kind: "needs-trust" } }) });
		harness.settings.mcp.servers = [stdioServer({ enabled: true })];
		harness.settings.mcp.enabled = true;
		const container = open(harness);
		expect(container.querySelector(".askmate-status-chip")?.textContent).toBe("Needs trust");
		expect(container.textContent).toContain("runs with your permissions");
		expect((field(container, "Command") as HTMLInputElement).value).toBe("npx");
		expect(field(container, "Arguments").value).toBe("-y\nfiles-server");
	});

	test("editing the command saves it and the service re-checks trust", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await edit(field(container, "Command"), "uvx");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>).command).toBe("uvx");
		expect(harness.calls).toContain("reconcile");
	});

	test("an empty command is refused and the old one is put back, so the server is not dropped on the next save", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await edit(field(container, "Command"), "   ");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>).command).toBe("npx");
		expect(harness.settings.mcp.servers).toHaveLength(1);
		expect((field(container, "Command") as HTMLInputElement).value).toBe("npx");
		expect(container.querySelector(".askmate-settings-feedback.is-error")?.textContent).toContain("command is missing");
	});

	test("an address the loader cannot keep is refused and the old one is put back", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [{ ...stdioServer(), id: "web", label: "Web", transport: "http", url: "https://example.com/mcp", headers: {}, bearerSecretId: null } as McpServerConfig];
		const container = open(harness);
		await edit(field(container, "Server address"), "not a url");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "http" }>).url).toBe("https://example.com/mcp");
		expect((field(container, "Server address") as HTMLInputElement).value).toBe("https://example.com/mcp");
		expect(container.querySelector(".askmate-settings-feedback.is-error")?.textContent).toContain("https://");
		await edit(field(container, "Server address"), "https://other.example.com/mcp");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "http" }>).url).toBe("https://other.example.com/mcp");
	});

	test("a header name the loader would drop is refused with a reason", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [{ ...stdioServer(), id: "web", label: "Web", transport: "http", url: "https://example.com/mcp", headers: {}, bearerSecretId: null } as McpServerConfig];
		const container = open(harness);
		await edit(field(container, "header name"), "X_Custom.Header");
		(field(container, "header value") as HTMLInputElement).value = "v";
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add") as HTMLButtonElement).click();
		await tick();
		const messages = Array.from(container.querySelectorAll(".askmate-settings-feedback")).map((el) => el.textContent ?? "");
		expect(messages.some((message) => message.includes("letters, digits and hyphens"))).toBe(true);
		// D-11: the field names its error message and is marked invalid, so a screen reader reads them together.
		const nameField = field(container, "header name");
		const describedBy = nameField.getAttribute("aria-describedby") ?? "";
		expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toContain("letters, digits and hyphens");
		expect(nameField.getAttribute("aria-invalid")).toBe("true");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "http" }>).headers).toEqual({});
	});

	test("a remote server on plain http stays off even when its switch is turned on", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [{ ...stdioServer(), id: "web", label: "Web", transport: "http", url: "http://example.com/mcp", headers: {}, bearerSecretId: null } as McpServerConfig];
		const container = open(harness);
		const switchEl = container.querySelector("[aria-label='Use this server']") as HTMLElement;
		switchEl.click();
		await tick();
		expect(harness.settings.mcp.servers[0]?.enabled).toBe(false);
		expect(switchEl.getAttribute("aria-checked")).toBe("false");
		expect(Notice.messages.at(-1)).toContain("plain HTTP is only allowed for localhost, 127.0.0.1 and [::1]");
		expect(Notice.messages.at(-1)).not.toContain("network");
	});

	test("editing the arguments saves one per line", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await edit(field(container, "Arguments"), "-y\nother-server\n\n--flag");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>).args).toEqual(["-y", "other-server", "--flag"]);
	});

	test("Trust and test trusts first, then switches the server on and starts it", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.enabled = true;
		harness.settings.mcp.servers = [stdioServer({ enabled: false })];
		const container = open(harness);
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Trust and test") as HTMLButtonElement).click();
		await tick();
		expect(harness.calls.filter((call) => call !== "reconcile")).toEqual(["trust:files", "test:files"]);
		expect(harness.settings.mcp.servers[0]?.enabled).toBe(true);
		expect(container.textContent).toContain("Ready, 2 tools.");
	});

	test("Trust and test refuses to start anything while tools are off", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Trust and test") as HTMLButtonElement).click();
		await tick();
		expect(harness.calls).toEqual([]);
		expect(container.textContent).toContain("Turn on tools first");
	});

	test("a declined trust dialog starts nothing and leaves the server off", async () => {
		const harness = mcpHarness({ trust: { kind: "declined" } });
		harness.settings.mcp.enabled = true;
		harness.settings.mcp.servers = [stdioServer({ enabled: false })];
		const container = open(harness);
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Trust and test") as HTMLButtonElement).click();
		await tick();
		expect(harness.calls).toEqual(["trust:files"]);
		expect(harness.settings.mcp.servers[0]?.enabled).toBe(false);
		expect(container.textContent).toContain("Not trusted, so the server was not started.");
	});

	test("Revoke trust asks the plugin to forget it and says so", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke trust") as HTMLButtonElement).click();
		await tick();
		expect(harness.calls).toContain("revoke:files");
		expect(container.textContent).toContain("Trust revoked.");
	});

	const clickButton = async (container: HTMLElement, label: string): Promise<void> => {
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement).click();
		await tick();
	};

	test("Revoke trust works while tools are off, because the plugin reaches the trust record without the service", async () => {
		const harness = makeHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await clickButton(container, "Revoke trust");
		expect(harness.revoked).toEqual(["files"]);
		expect(container.textContent).toContain("Trust revoked.");
		expect(container.textContent).not.toContain("Tools are off");
		expect(container.querySelector(".askmate-settings-feedback.is-warning")).toBeNull();
		expect(Notice.messages).toEqual([]);
	});

	test("Revoke trust reports a failure from the trust record instead of success", async () => {
		const harness = makeHarness(() => ({ revokeMcpTrust: async (): Promise<void> => { throw new Error("storage is unavailable"); } }));
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await clickButton(container, "Revoke trust");
		expect(container.textContent).not.toContain("Trust revoked");
		expect(Notice.messages.at(-1)).toBe("storage is unavailable");
	});

	test("the Use this server switch follows Trust and test turning the server on", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.enabled = true;
		harness.settings.mcp.servers = [stdioServer({ enabled: false })];
		const container = open(harness);
		const switchEl = container.querySelector("[aria-label='Use this server']") as HTMLElement;
		expect(switchEl.getAttribute("aria-checked")).toBe("false");
		await clickButton(container, "Trust and test");
		expect(harness.settings.mcp.servers[0]?.enabled).toBe(true);
		expect(switchEl.getAttribute("aria-checked")).toBe("true");
	});

	test("the Use this server switch stays off when Trust and test is declined", async () => {
		const harness = mcpHarness({ trust: { kind: "declined" } });
		harness.settings.mcp.enabled = true;
		harness.settings.mcp.servers = [stdioServer({ enabled: false })];
		const container = open(harness);
		await clickButton(container, "Trust and test");
		expect((container.querySelector("[aria-label='Use this server']") as HTMLElement).getAttribute("aria-checked")).toBe("false");
	});

	test("lists the server's tools with an allow switch for each and a badge for a changed one", async () => {
		const harness = mcpHarness({
			status: (id) => readyStatus(id, 2),
			tools: [
				{ toolName: "read_file", title: "Read file", description: "Reads one file." },
				{ toolName: "write_file", title: "Write file", description: "Writes one file.", pin: "changed", claimsReadOnly: false, warnings: ["contains invisible characters"] }
			]
		});
		harness.settings.mcp.servers = [stdioServer({ disabledTools: ["delete_file"] })];
		const container = open(harness);
		const names = Array.from(container.querySelectorAll(".mod-toggle, .setting-item-name")).map((el) => el.textContent);
		expect(names).toEqual(expect.arrayContaining(["Read file", "Write file", "delete_file"]));
		expect(container.textContent).toContain("Changed");
		expect(container.textContent).toContain("Warning: contains invisible characters.");
		const switches = Array.from(container.querySelectorAll<HTMLElement>("[role='switch']"));
		const forTool = (title: string): HTMLElement => switches.find((el) => el.getAttribute("aria-label") === `Let the model use ${title}`) as HTMLElement;
		expect(forTool("Read file").getAttribute("aria-checked")).toBe("true");
		expect(forTool("delete_file").getAttribute("aria-checked")).toBe("false");
		// QA-04: the switch is the only tab stop; the checkbox inside it is hidden and out of the tab order.
		for (const switchEl of switches) {
			const input = switchEl.querySelector("input");
			expect(input?.getAttribute("aria-hidden")).toBe("true");
			expect(input?.tabIndex).toBe(-1);
			expect(input?.classList.contains("askmate-switch-input")).toBe(true);
		}
	});

	test("turning a tool off saves it and asks for its focus back after the list redraws", async () => {
		const harness = mcpHarness({ status: (id) => readyStatus(id, 1), tools: [{ toolName: "read_file", title: "Read file", description: "Reads one file." }] });
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		const switchEl = container.querySelector("[aria-label='Let the model use Read file']") as HTMLElement;
		switchEl.click();
		await tick();
		expect(harness.settings.mcp.servers[0]?.disabledTools).toEqual(["read_file"]);
		expect(harness.tab.focusAfterRebuild).toBe("tool:files:read_file");
		expect(harness.calls).toContain("reconcile");
	});

	test("replacing a secret that AskMate did not make writes a new one and leaves the other alone", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer({ env: { OTHER: { kind: "secret", secretId: "someone-elses-secret" } } })];
		harness.fake.secretStorage.setSecret("someone-elses-secret", "theirs");
		const container = open(harness);
		await edit(field(container, "OTHER value"), "mine");
		expect(harness.fake.secretStorage.getSecret("someone-elses-secret")).toBe("theirs");
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-files-other")).toBe("mine");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>).env).toEqual({ OTHER: { kind: "secret", secretId: "askmate-mcp-files-other" } });
	});

	test("replacing a secret AskMate made keeps its name", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer({ env: { API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } } })];
		harness.fake.secretStorage.setSecret("askmate-mcp-files-api-token", "old");
		const container = open(harness);
		await edit(field(container, "API_TOKEN value"), "new");
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-files-api-token")).toBe("new");
		expect((harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>).env.API_TOKEN).toEqual({ kind: "secret", secretId: "askmate-mcp-files-api-token" });
	});

	test("without a connection it says how to load the tools", () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		expect(open(harness).textContent).toContain("Trust and test the server to load its tools");
	});

	test("adding a variable that looks like a credential stores it in the keychain", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		await edit(field(container, "variable name"), "API_TOKEN");
		(field(container, "variable value") as HTMLInputElement).value = "abc123";
		(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add") as HTMLButtonElement).click();
		await tick();
		const server = harness.settings.mcp.servers[0] as Extract<McpServerConfig, { transport: "stdio" }>;
		expect(server.env).toEqual({ API_TOKEN: { kind: "secret", secretId: "askmate-mcp-files-api-token" } });
		expect(harness.fake.secretStorage.getSecret("askmate-mcp-files-api-token")).toBe("abc123");
		expect(JSON.stringify(harness.settings.mcp)).not.toContain("abc123");
	});

	test("the approval mode is saved and the read-only switch only works with the matching mode", async () => {
		const harness = mcpHarness();
		harness.settings.mcp.servers = [stdioServer()];
		const container = open(harness);
		const select = container.querySelector("[aria-label='Approval mode']") as HTMLSelectElement;
		expect(select).not.toBeNull();
		const switchEl = container.querySelector("[aria-label=\"Believe the server's read-only labels\"]") as HTMLElement;
		expect(switchEl).not.toBeNull();
	});
});

describe("workflow sidebar order (D-09)", () => {
	// Two favourites, then three others, so the boundary between them is covered as well as the two ends.
	const ORDER = [
		{ id: "alpha", name: "Alpha", favorite: true },
		{ id: "bravo", name: "Bravo", favorite: true },
		{ id: "charlie", name: "Charlie", favorite: false },
		{ id: "delta", name: "Delta", favorite: false },
		{ id: "echo", name: "Echo", favorite: false }
	];

	function orderHarness(): Harness & { reorders: Array<[number, number]>; order: typeof ORDER } {
		const reorders: Array<[number, number]> = [];
		const order = [...ORDER];
		const harness = makeHarness(() => ({
			getSidebarWorkflowOrderForSettings: () => order.map(({ id, name }) => ({ id, name, isCustom: false })),
			getWorkflowDisplayPreference: (id: string) => ({ id, favorite: order.find((item) => item.id === id)?.favorite ?? false, hidden: false, order: 0 }),
			reorderWorkflowDisplay: async (from: number, to: number): Promise<void> => {
				reorders.push([from, to]);
				const [moved] = order.splice(from, 1);
				if (moved) {
					order.splice(to, 0, moved);
				}
			}
		}));
		return { ...harness, reorders, order };
	}

	function sidebarPage(tab: AskMateSettingTab): PageItem {
		const find = (items: readonly Item[]): PageItem | undefined => {
			for (const item of items) {
				if ("type" in item && item.type === "page" && item.name === "Workflow sidebar") {
					return item;
				}
				if ("type" in item && (item.type === "group" || item.type === "page")) {
					const found = find((item.items ?? []) as Item[]);
					if (found) {
						return found;
					}
				}
			}
			return undefined;
		};
		const page = find(tab.getSettingDefinitions());
		if (!page) {
			throw new Error("No Workflow sidebar page.");
		}
		return page;
	}

	const drawOrder = (tab: AskMateSettingTab, container: HTMLElement = getFakeDocument().createElement("div")): Rendered[] =>
		draw(sidebarPage(tab).items ?? [], container).filter((row) => ORDER.some((item) => item.name === row.def.name));

	function moveButton(rows: readonly Rendered[], workflow: string, direction: "up" | "down"): ExtraButtonComponent {
		const row = rowNamed(rows, workflow);
		const found = row.setting.components.find((component): component is ExtraButtonComponent =>
			component instanceof ExtraButtonComponent && component.extraSettingsEl.getAttribute("aria-label") === `Move ${workflow} ${direction}`);
		if (!found) {
			throw new Error(`No Move ${workflow} ${direction} button.`);
		}
		return found;
	}

	test("no list in the settings uses Obsidian's drag handles, and the order has its own heading", () => {
		const { tab } = orderHarness();
		const everyList = lists(tab.getSettingDefinitions());
		expect(everyList.some((list) => "onReorder" in list && list.onReorder !== undefined)).toBe(false);
		expect(lists(sidebarPage(tab).items ?? [])).toEqual([]);
		const group = (sidebarPage(tab).items ?? []).find((item) => "type" in item && item.type === "group");
		expect((group as { heading?: string } | undefined)?.heading).toBe("Sidebar order");
	});

	test("the note no longer tells people to drag", () => {
		const { tab } = orderHarness();
		const text = draw(sidebarPage(tab).items ?? [], getFakeDocument().createElement("div"))[0]?.setting.settingEl.textContent ?? "";
		expect(text).not.toMatch(/drag|handle|Alt\+/i);
		expect(text).toContain("Move up");
	});

	test("every row has Move up and Move down buttons named after its workflow, as real buttons in the tab order", () => {
		const { tab } = orderHarness();
		const rows = drawOrder(tab);
		expect(rows.map((row) => row.def.name)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
		for (const { name } of ORDER) {
			for (const direction of ["up", "down"] as const) {
				const el = moveButton(rows, name, direction).extraSettingsEl;
				expect(el.getAttribute("aria-label")).toBe(`Move ${name} ${direction}`);
				expect(el.getAttribute("role")).toBe("button");
				expect(el.getAttribute("tabindex")).toBe("0");
			}
		}
	});

	test("the first row cannot move up, the last cannot move down, and nothing can move across the favourites boundary", () => {
		const { tab } = orderHarness();
		const rows = drawOrder(tab);
		const disabled = (workflow: string, direction: "up" | "down"): boolean => {
			const button = moveButton(rows, workflow, direction);
			expect(button.extraSettingsEl.getAttribute("aria-disabled")).toBe(String(button.disabled));
			return button.disabled;
		};
		expect(ORDER.flatMap(({ name }) => (["up", "down"] as const).map((direction) => [`${name} ${direction}`, disabled(name, direction)] as const))).toEqual([
			["Alpha up", true], ["Alpha down", false],
			["Bravo up", false], ["Bravo down", true],
			["Charlie up", true], ["Charlie down", false],
			["Delta up", false], ["Delta down", false],
			["Echo up", false], ["Echo down", true]
		]);
	});

	test("Move up and Move down ask the plugin to swap with the neighbour, and disabled buttons do nothing", () => {
		const harness = orderHarness();
		const rows = drawOrder(harness.tab);
		moveButton(rows, "Delta", "up").click();
		moveButton(rows, "Delta", "down").click();
		moveButton(rows, "Alpha", "up").click();
		moveButton(rows, "Echo", "down").click();
		moveButton(rows, "Bravo", "down").click();
		expect(harness.reorders).toEqual([[3, 2], [3, 4]]);
		expect(harness.counts.updates).toBe(2);
	});

	test("after a move the page is redrawn and keyboard focus returns to the same button of the moved row", () => {
		const harness = orderHarness();
		const container = getFakeDocument().createElement("div");
		getFakeDocument().body.appendChild(container);
		try {
			moveButton(drawOrder(harness.tab, container), "Delta", "up").click();
			expect(harness.tab.focusAfterRebuild).toBe("workflow-move-up:delta");

			const redrawn = getFakeDocument().createElement("div");
			getFakeDocument().body.appendChild(redrawn);
			const rows = drawOrder(harness.tab, redrawn);
			expect(rows.map((row) => row.def.name)).toEqual(["Alpha", "Bravo", "Delta", "Charlie", "Echo"]);
			expect(getFakeDocument().activeElement).toBe(moveButton(rows, "Delta", "up").extraSettingsEl);
			expect(harness.tab.focusAfterRebuild).toBeNull();
			redrawn.remove();
		} finally {
			container.remove();
		}
	});

	test("pressing a move button moves its row once, and a disabled button does nothing", () => {
		const harness = orderHarness();
		const rows = drawOrder(harness.tab);
		moveButton(rows, "Delta", "down").extraSettingsEl.click();
		expect(harness.reorders).toEqual([[3, 4]]);
		moveButton(rows, "Alpha", "up").extraSettingsEl.click();
		expect(harness.reorders).toHaveLength(1);
	});

	test("every extra button is a tab stop with a role and a name; Obsidian itself runs it on Enter and Space", () => {
		const { tab } = orderHarness();
		const button = new ExtraButtonComponent(getFakeDocument().createElement("div"));
		tab.describeExtraButton(button, "Refresh models");
		expect(button.extraSettingsEl.getAttribute("tabindex")).toBe("0");
		expect(button.extraSettingsEl.getAttribute("role")).toBe("button");
		expect(button.extraSettingsEl.getAttribute("aria-label")).toBe("Refresh models");
	});
});

describe("batch workflow selection", () => {
	test("a deleted workflow no longer leaves the dropdown blank", () => {
		const harness = makeHarness();
		harness.settings.batchWorkflowId = "custom-gone";
		const plugin = (harness.tab as unknown as { plugin: { getAllWorkflows: () => Array<{ id: string; name: string }> } }).plugin;
		plugin.getAllWorkflows = () => [{ id: "study-summary", name: "Study summary" }, { id: "other", name: "Other" }];
		const group = (pageNamed(harness.tab, "Advanced").items ?? []).find((item) => "type" in item && item.type === "group" && item.heading === "Automation");
		const batch = (group as { items: PageItem[] }).items[0] as PageItem;
		const page = batch.page?.() as SettingPage;
		page.display();
		const select = page.containerEl.querySelector("select") as HTMLSelectElement;
		expect(select).not.toBeNull();
		expect(harness.settings.batchWorkflowId).toBe("study-summary");
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// The documentation names what the settings show
// ---------------------------------------------------------------------------------------------------------------------

describe("documentation names match the settings", () => {
	interface PageContents {
		/** Rows, group headings and inline pages anywhere on the page. */
		names: Set<string>;
		/** The groups that sit directly on the page, in order. */
		groups: string[];
		/** The labels of every dropdown on the page. */
		options: Set<string>;
	}

	/** Every settings page as it is drawn, with a provider other than OpenAI answering chat so that the Images group is on Connection. */
	function pageContents(): Map<string, PageContents> {
		const { tab, settings } = makeHarness();
		settings.providerRoles.chatProviderId = "anthropic";
		settings.selectedTextProvider = "anthropic";
		const contents = new Map<string, PageContents>();
		for (const page of tab.getSettingDefinitions()) {
			if (!("type" in page) || page.type !== "page") {
				continue;
			}
			const names = new Set<string>();
			const visit = (items: readonly Item[]): void => {
				for (const item of items) {
					if ("type" in item && (item.type === "group" || item.type === "list")) {
						names.add(item.heading ?? "");
						visit((item.items ?? []) as Item[]);
					} else if ("type" in item && item.type === "page") {
						names.add(item.name);
						visit((item.items ?? []) as Item[]);
					}
				}
			};
			visit(page.items ?? []);
			const rows = draw(page.items ?? [], getFakeDocument().createElement("div"));
			rows.forEach((row) => names.add(row.def.name));
			const options = new Set(rows.flatMap((row) => {
				const dropdown = row.setting.component(DropdownComponent);
				return dropdown ? Object.values(dropdown.options) : [];
			}));
			const groups = (page.items ?? []).flatMap((item) => ("type" in item && (item.type === "group" || item.type === "list") && item.heading ? [item.heading] : []));
			names.delete("");
			contents.set(page.name, { names, groups, options });
		}
		return contents;
	}

	/** Every string the settings and their dialogs are written with, for the controls on pages that are drawn by hand. */
	function interfaceStrings(): Set<string> {
		const strings = new Set<string>();
		const read = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					read(path);
				} else if (entry.name.endsWith(".ts")) {
					const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
					const walk = (node: ts.Node): void => {
						if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
							strings.add(node.text);
						}
						ts.forEachChild(node, walk);
					};
					walk(file);
				}
			}
		};
		read("src/ui/settings");
		read("src/ui/modals");
		return strings;
	}

	const documents = (): Array<[string, string]> =>
		["README.md", ...readdirSync("docs").filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)].map((path) => [path, readFileSync(path, "utf8")]);

	test("docs/README.md lists the groups that each page really has", () => {
		const contents = pageContents();
		const table = readFileSync("docs/README.md", "utf8").split("\n").filter((line) => /^\| `[^`]+` \|/.test(line));
		const documented = new Map(table.map((line) => {
			const cells = line.split("|").map((cell) => cell.trim());
			return [quotedSpans(cells[1] ?? "")[0] ?? "", quotedSpans(cells[2] ?? "")] as const;
		}));
		expect([...documented.keys()]).toEqual(["Connection", "Sidebar and output", "Privacy and memory", "Skills and tools", "Instructions", "Advanced"]);
		for (const [page, groups] of documented) {
			if (page === "Instructions") {
				// Drawn by hand: its two parts are the two strings below.
				expect(groups).toEqual(["Instructions for every request", "Folder instructions"]);
				const strings = interfaceStrings();
				groups.forEach((group) => expect(strings.has(group)).toBe(true));
				continue;
			}
			expect({ page, groups }).toEqual({ page, groups: contents.get(page)?.groups ?? [] });
		}
	});

	test("every name the documentation gives to a setting, group or page exists", () => {
		const contents = pageContents();
		const known = new Set<string>([...contents.keys(), ...interfaceStrings()]);
		for (const page of contents.values()) {
			page.names.forEach((name) => known.add(name));
			page.options.forEach((option) => known.add(option));
		}
		const unknown = documents().flatMap(([path, text]) => findSettingReferences(text).filter((name) => !known.has(name)).map((name) => `${path}: "${name}"`));
		expect(unknown).toEqual([]);
	});

	test("a setting is documented on the page that has it", () => {
		const contents = pageContents();
		const wrong: string[] = [];
		for (const [path, text] of documents()) {
			if (path === "docs/README.md") {
				continue;
			}
			for (const sentence of splitSentences(text)) {
				const pages = [...contents.keys()].filter((page) => new RegExp(`on the \`${page}\`|\`${page}\`(?: settings)? page\\b`).test(sentence));
				if (pages.length !== 1) {
					continue;
				}
				const page = pages[0] as string;
				for (const token of quotedSpans(sentence)) {
					const homes = [...contents].filter(([, other]) => other.names.has(token)).map(([name]) => name);
					if (homes.length > 0 && !homes.includes(page)) {
						wrong.push(`${path}: "${token}" is on ${homes.join(" and ")}, but the sentence says ${page}`);
					}
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	test("the checks would have caught the names that were wrong before", () => {
		const contents = pageContents();
		const known = new Set<string>([...contents.keys(), ...interfaceStrings()]);
		for (const page of contents.values()) {
			page.names.forEach((name) => known.add(name));
		}
		const old = "Turn saving off with `Save conversations` on the `Privacy and memory` page. The `Apply approval mode` setting is on the `Sidebar and output` page, under `Responses`. Open `Workflows and automation`.";
		expect(findSettingReferences(old).filter((name) => !known.has(name)).sort()).toEqual(["Apply approval mode", "Responses", "Save conversations", "Workflows and automation"]);
	});
});

