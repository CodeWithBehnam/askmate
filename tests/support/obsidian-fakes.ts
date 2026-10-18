/**
 * Fakes for the parts of the Obsidian API that code under test imports at runtime.
 *
 * bun's mock.module() replaces "obsidian" for the whole test run, so every test file must share one set of fakes:
 * per-file mocks with different exports break depending on which file the runner loads first.
 * tests/support/obsidian-preload.ts registers every export of this file as the "obsidian" module before any test file
 * runs; tests import the same classes from here so `instanceof` checks inside the code under test match the objects the
 * tests create.
 *
 * This file holds the classes that stand alone. The in-memory vault, workspace and metadata cache live in
 * ./fake-app.ts and the DOM in ./fake-dom.ts. Additions here must be backwards compatible: other test files rely on
 * the existing exports behaving as they do.
 */
import type { Vault } from "obsidian";
import { createFakeEl, createFakeMouseEvent, getFakeDocument } from "./fake-dom";

export class TAbstractFile {
	vault!: Vault;
	parent: TFolder | null = null;

	constructor(public path = "") {}

	get name(): string {
		return this.path.split("/").pop() ?? "";
	}
}

export class TFile extends TAbstractFile {
	stat = { size: 10, ctime: 0, mtime: 0 };

	get extension(): string {
		return this.name.includes(".") ? this.name.split(".").pop() ?? "" : "";
	}

	get basename(): string {
		return this.name.includes(".") ? this.name.slice(0, this.name.lastIndexOf(".")) : this.name;
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === "" || this.path === "/";
	}
}

export class Editor {}

export class MarkdownView<TEditor = unknown> {
	mode: "source" | "preview" = "source";

	constructor(public editor: TEditor, public file: TFile | null) {}

	getMode(): "source" | "preview" {
		return this.mode;
	}
}

type FakeCachedMetadata = { tags?: { tag: string }[]; frontmatter?: Record<string, unknown> };

/** Mirrors the real helper: inline tags plus frontmatter `tags`/`tag`, each with a leading "#". */
export function getAllTags(cache: FakeCachedMetadata): string[] | null {
	const inline = (cache.tags ?? []).map((entry) => entry.tag);
	const raw = [cache.frontmatter?.tags, cache.frontmatter?.tag].flatMap((value) =>
		Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/) : []
	);
	const all = [...inline, ...raw.filter(Boolean).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))];
	return all.length > 0 ? all : null;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || "/";
}

// ---------------------------------------------------------------------------------------------------------------------
// Events and components
// ---------------------------------------------------------------------------------------------------------------------

type Listener = (...args: never[]) => unknown;

export interface EventRef {
	e: Events;
	name: string;
	fn: Listener;
}

export class Events {
	private readonly listeners = new Map<string, Set<Listener>>();

	on(name: string, callback: Listener): EventRef {
		const set = this.listeners.get(name) ?? new Set<Listener>();
		set.add(callback);
		this.listeners.set(name, set);
		return { e: this, name, fn: callback };
	}

	off(name: string, callback: Listener): void {
		this.listeners.get(name)?.delete(callback);
	}

	offref(ref: EventRef): void {
		this.off(ref.name, ref.fn);
	}

	trigger(name: string, ...args: unknown[]): void {
		for (const listener of Array.from(this.listeners.get(name) ?? [])) {
			(listener as (...values: unknown[]) => unknown)(...args);
		}
	}

	/** How many listeners are attached, for asserting that a component cleaned up. */
	listenerCount(name?: string): number {
		return name === undefined
			? Array.from(this.listeners.values()).reduce((total, set) => total + set.size, 0)
			: this.listeners.get(name)?.size ?? 0;
	}
}

export class Component {
	loaded = false;
	private readonly children = new Set<Component>();
	private readonly disposers: Array<() => void> = [];

	load(): void {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		this.onload();
		this.children.forEach((child) => child.load());
	}

	onload(): void {}

	unload(): void {
		if (!this.loaded) {
			return;
		}
		this.loaded = false;
		Array.from(this.children).forEach((child) => child.unload());
		this.children.clear();
		while (this.disposers.length > 0) {
			this.disposers.pop()?.();
		}
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(component: T): T {
		this.children.add(component);
		if (this.loaded) {
			component.load();
		}
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		this.children.delete(component);
		component.unload();
		return component;
	}

	register(cb: () => unknown): void {
		this.disposers.push(() => void cb());
	}

	registerEvent(ref: EventRef): void {
		this.disposers.push(() => ref.e.offref(ref));
	}

	registerDomEvent(el: EventTarget, type: string, callback: EventListener, options?: boolean | AddEventListenerOptions): void {
		el.addEventListener(type, callback, options);
		this.disposers.push(() => el.removeEventListener(type, callback, options));
	}

	registerInterval(id: number): number {
		this.disposers.push(() => clearInterval(id));
		return id;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Notices, platform and small helpers
// ---------------------------------------------------------------------------------------------------------------------

export class Notice {
	/** Every notice created since the last `Notice.clear()`. */
	static readonly shown: Notice[] = [];
	readonly containerEl: HTMLElement = createFakeEl("div");
	readonly messageEl: HTMLElement = this.containerEl.createDiv({ cls: "notice-message" });
	/** Same element as `containerEl`; older code reads it under this name. */
	readonly noticeEl: HTMLElement = this.containerEl;
	hidden = false;

	constructor(public message: string | DocumentFragment, public duration?: number) {
		Notice.shown.push(this);
		this.messageEl.setText(message);
	}

	static get messages(): string[] {
		return Notice.shown.map((notice) => typeof notice.message === "string" ? notice.message : notice.message.textContent ?? "");
	}

	static clear(): void {
		Notice.shown.length = 0;
	}

	setMessage(message: string | DocumentFragment): this {
		this.message = message;
		this.messageEl.setText(message);
		return this;
	}

	hide(): void {
		this.hidden = true;
	}
}

const PLATFORM_DEFAULTS = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isSafari: false,
	canDisplayRibbon: true,
	canExportPdf: true
};

export const Platform: Record<keyof typeof PLATFORM_DEFAULTS, boolean> = { ...PLATFORM_DEFAULTS };

/** Overrides platform flags for one test. Pair it with `resetFakePlatform()` in `afterEach`. */
export function setFakePlatform(overrides: Partial<Record<keyof typeof PLATFORM_DEFAULTS, boolean>>): void {
	Object.assign(Platform, overrides);
}

export function resetFakePlatform(): void {
	Object.assign(Platform, PLATFORM_DEFAULTS);
}

let language = "en";

export function getLanguage(): string {
	return language;
}

export function setFakeLanguage(next: string): void {
	language = next;
}

export const registeredIcons = new Map<string, string>();

export function addIcon(id: string, svg: string): void {
	registeredIcons.set(id, svg);
}

export function setIcon(el: HTMLElement, iconId: string): void {
	el.setAttribute("data-icon", iconId);
}

export const Keymap = {
	isModEvent(event?: { ctrlKey?: boolean; metaKey?: boolean; button?: number } | null): boolean | "tab" {
		return event && (event.ctrlKey || event.metaKey || event.button === 1) ? "tab" : false;
	}
};

export function debounce<T extends unknown[]>(
	callback: (...args: T) => unknown,
	wait = 0,
	resetTimer = false
): ((...args: T) => void) & { cancel: () => void; run: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: T | null = null;
	const run = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (pending) {
			const args = pending;
			pending = null;
			void callback(...args);
		}
	};
	const debounced = (...args: T): void => {
		pending = args;
		if (timer !== null && resetTimer) {
			clearTimeout(timer);
			timer = null;
		}
		timer ??= setTimeout(run, wait);
	};
	return Object.assign(debounced, {
		cancel: (): void => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			timer = null;
			pending = null;
		},
		run
	});
}

export interface FakeRequestParams {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}

export interface FakeRequestResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

type RequestHandler = (params: FakeRequestParams) => Promise<Partial<FakeRequestResponse>> | Partial<FakeRequestResponse>;

let requestHandler: RequestHandler | null = null;
export const requestUrlCalls: FakeRequestParams[] = [];

/** Sets how `requestUrl` answers. Pass null to make unexpected requests fail loudly. */
export function setRequestUrlHandler(handler: RequestHandler | null): void {
	requestHandler = handler;
	requestUrlCalls.length = 0;
}

export async function requestUrl(params: FakeRequestParams | string): Promise<FakeRequestResponse> {
	const request = typeof params === "string" ? { url: params } : params;
	requestUrlCalls.push(request);
	if (!requestHandler) {
		throw new Error(`requestUrl was called without a test handler: ${request.url}`);
	}
	const partial = await requestHandler(request);
	const text = partial.text ?? (partial.json === undefined ? "" : JSON.stringify(partial.json));
	return {
		status: partial.status ?? 200,
		headers: partial.headers ?? {},
		text,
		json: partial.json ?? (text ? JSON.parse(text) as unknown : null),
		arrayBuffer: partial.arrayBuffer ?? new ArrayBuffer(0)
	};
}

export class MarkdownRenderer {
	/** Every render call, so a test can check what was rendered and where. */
	static readonly calls: Array<{ markdown: string; el: HTMLElement; sourcePath: string }> = [];

	static render(_app: unknown, markdown: string, el: HTMLElement, sourcePath: string, _component?: Component): Promise<void> {
		MarkdownRenderer.calls.push({ markdown, el, sourcePath });
		el.textContent = markdown;
		return Promise.resolve();
	}

	static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component?: Component): Promise<void> {
		return MarkdownRenderer.render(null, markdown, el, sourcePath, component);
	}

	static reset(): void {
		MarkdownRenderer.calls.length = 0;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// App, views and plugin
// ---------------------------------------------------------------------------------------------------------------------

export class App {}

export class Scope {
	readonly keys: Array<{ key: string | null; callback: (event: KeyboardEvent) => unknown }> = [];

	register(_modifiers: string[] | null, key: string | null, callback: (event: KeyboardEvent) => unknown): { key: string | null } {
		const entry = { key, callback };
		this.keys.push(entry);
		return entry;
	}
}

export class WorkspaceLeaf extends Component {
	view: unknown = null;
	viewState: { type: string; state?: Record<string, unknown> } = { type: "empty" };
	detached = false;

	constructor(public app?: unknown) {
		super();
	}

	getViewState(): { type: string; state?: Record<string, unknown> } {
		return this.viewState;
	}

	setViewState(state: { type: string; state?: Record<string, unknown> }): Promise<void> {
		this.viewState = state;
		return Promise.resolve();
	}

	detach(): void {
		this.detached = true;
	}
}

export abstract class ItemView extends Component {
	readonly app: unknown;
	readonly containerEl: HTMLElement;
	readonly contentEl: HTMLElement;
	readonly actions: Array<{ icon: string; title: string; callback: (event: MouseEvent) => unknown; el: HTMLElement }> = [];
	navigation = true;
	scope: Scope | null = null;

	constructor(public leaf: WorkspaceLeaf) {
		super();
		this.app = leaf.app;
		this.containerEl = createFakeEl("div");
		this.containerEl.createDiv({ cls: "view-header" });
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
		leaf.view = this;
	}

	abstract getViewType(): string;
	abstract getDisplayText(): string;

	getIcon(): string {
		return "document";
	}

	onOpen(): Promise<void> {
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		return Promise.resolve();
	}

	addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
		const el = this.containerEl.createDiv({ cls: "view-action", attr: { "aria-label": title, "data-icon": icon } });
		el.addEventListener("click", callback as EventListener);
		this.actions.push({ icon, title, callback, el });
		return el;
	}

	/** Test helper: runs the open sequence Obsidian performs. */
	async openForTest(): Promise<void> {
		this.load();
		await this.onOpen();
	}

	/** Test helper: runs the close sequence Obsidian performs. */
	async closeForTest(): Promise<void> {
		await this.onClose();
		this.unload();
	}
}

export interface FakeCommand {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (...args: unknown[]) => unknown;
	editorCheckCallback?: (...args: unknown[]) => boolean | void;
	hotkeys?: unknown[];
	icon?: string;
}

export class Plugin extends Component {
	readonly commands = new Map<string, FakeCommand>();
	readonly ribbonIcons: Array<{ icon: string; title: string; callback: (event: MouseEvent) => unknown; el: HTMLElement }> = [];
	readonly settingTabs: unknown[] = [];
	readonly statusBarItems: HTMLElement[] = [];
	readonly views = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();
	/** What `saveData` last wrote; `loadData` returns a copy of it. Null models a fresh install. */
	storedData: unknown = null;
	saveCount = 0;

	constructor(public app: unknown, public manifest: { id: string; name: string; version: string; minAppVersion?: string; [key: string]: unknown }) {
		super();
	}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.storedData === null ? null : structuredClone(this.storedData));
	}

	saveData(data: unknown): Promise<void> {
		this.storedData = structuredClone(data);
		this.saveCount += 1;
		return Promise.resolve();
	}

	addCommand(command: FakeCommand): FakeCommand {
		this.commands.set(command.id, command);
		return command;
	}

	removeCommand(id: string): void {
		this.commands.delete(id);
	}

	addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
		const el = createFakeEl("div");
		el.setAttribute("aria-label", title);
		el.setAttribute("data-icon", icon);
		el.addEventListener("click", callback as EventListener);
		this.ribbonIcons.push({ icon, title, callback, el });
		return el;
	}

	addStatusBarItem(): HTMLElement {
		const el = createFakeEl("div");
		this.statusBarItems.push(el);
		return el;
	}

	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}

	registerView(type: string, creator: (leaf: WorkspaceLeaf) => ItemView): void {
		this.views.set(type, creator);
	}

	registerEditorExtension(_extension: unknown): void {}

	registerMarkdownPostProcessor(_processor: unknown): void {}

	registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}

	onUserEnable(): void {}
}

// ---------------------------------------------------------------------------------------------------------------------
// Menus and modals
// ---------------------------------------------------------------------------------------------------------------------

export class MenuItem {
	title = "";
	icon = "";
	section = "";
	checked = false;
	disabled = false;
	clickHandler: ((event: MouseEvent | KeyboardEvent) => unknown) | null = null;

	setTitle(title: string | DocumentFragment): this {
		this.title = typeof title === "string" ? title : title.textContent ?? "";
		return this;
	}

	setIcon(icon: string | null): this {
		this.icon = icon ?? "";
		return this;
	}

	setSection(section: string): this {
		this.section = section;
		return this;
	}

	setChecked(checked: boolean | null): this {
		this.checked = Boolean(checked);
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	onClick(callback: (event: MouseEvent | KeyboardEvent) => unknown): this {
		this.clickHandler = callback;
		return this;
	}

	/** Test helper: activates the item unless it is disabled. */
	click(): unknown {
		return this.disabled ? undefined : this.clickHandler?.(createFakeMouseEvent("click"));
	}
}

export class Menu {
	static lastMenu: Menu | null = null;
	readonly items: MenuItem[] = [];
	separators = 0;
	shown = false;

	addItem(callback: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		callback(item);
		this.items.push(item);
		return this;
	}

	addSeparator(): this {
		this.separators += 1;
		return this;
	}

	showAtMouseEvent(_event: MouseEvent): this {
		this.shown = true;
		Menu.lastMenu = this;
		return this;
	}

	showAtPosition(_position: { x: number; y: number }): this {
		this.shown = true;
		Menu.lastMenu = this;
		return this;
	}

	hide(): this {
		this.shown = false;
		return this;
	}
}

export class Modal {
	/** Modals that are currently open, newest last. */
	static readonly opened: Modal[] = [];
	readonly containerEl: HTMLElement;
	readonly modalEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly contentEl: HTMLElement;
	scope = new Scope();
	isOpen = false;

	constructor(public app: unknown) {
		this.containerEl = createFakeEl("div");
		this.containerEl.classList.add("modal-container");
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}

	static closeAll(): void {
		for (const modal of [...Modal.opened].reverse()) {
			modal.close();
		}
	}

	open(): void {
		this.isOpen = true;
		Modal.opened.push(this);
		getFakeDocument().body.appendChild(this.containerEl as unknown as Node);
		this.onOpen();
	}

	close(): void {
		if (!this.isOpen) {
			return;
		}
		this.isOpen = false;
		const index = Modal.opened.indexOf(this);
		if (index >= 0) {
			Modal.opened.splice(index, 1);
		}
		this.onClose();
		this.containerEl.remove();
	}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		this.contentEl.setText(content);
		return this;
	}

	onOpen(): void {}

	onClose(): void {}
}

export abstract class SuggestModal<T> extends Modal {
	placeholder = "";
	instructions: Array<{ command: string; purpose: string }> = [];
	emptyStateText = "No results found.";
	inputEl: HTMLInputElement;
	limit = 100;

	constructor(app: unknown) {
		super(app);
		this.inputEl = this.modalEl.createEl("input", { type: "text" }) as HTMLInputElement;
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		this.inputEl.setAttribute("placeholder", placeholder);
		return this;
	}

	setInstructions(instructions: Array<{ command: string; purpose: string }>): void {
		this.instructions = instructions;
	}

	/** Test helper: the suggestions the modal would list for a query. */
	suggestionsFor(query: string): Promise<T[]> {
		return Promise.resolve(this.getSuggestions(query));
	}

	/** Test helper: chooses an item as the user would. */
	choose(item: T): void {
		this.close();
		this.onChooseSuggestion(item, createFakeMouseEvent("click"));
	}
}

export interface FuzzyMatch<T> {
	item: T;
	match: { score: number; matches: Array<[number, number]> };
}

/** Like Obsidian's: the suggestions are `FuzzyMatch` wrappers around the items. */
export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

	getSuggestions(query: string): FuzzyMatch<T>[] {
		const needle = query.trim().toLowerCase();
		return this.getItems()
			.filter((item) => !needle || this.getItemText(item).toLowerCase().includes(needle))
			.map((item) => ({ item, match: { score: 0, matches: [] } }));
	}

	renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
		el.setText(this.getItemText(match.item));
	}

	onChooseSuggestion(match: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
		this.onChooseItem(match.item, evt);
	}
}

export abstract class AbstractInputSuggest<T> {
	private value = "";
	private choose: ((value: T) => unknown) | null = null;
	isOpen = false;

	constructor(public app: unknown, public textInputEl: HTMLInputElement | HTMLDivElement) {}

	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;

	setValue(value: string): void {
		this.value = value;
		if ("value" in this.textInputEl) {
			this.textInputEl.value = value;
		}
	}

	getValue(): string {
		return this.value;
	}

	onSelect(callback: (value: T) => unknown): this {
		this.choose = callback;
		return this;
	}

	open(): void {
		this.isOpen = true;
	}

	close(): void {
		this.isOpen = false;
	}

	/** Test helper: the suggestions for what the user typed. */
	suggestionsFor(query: string): Promise<T[]> {
		return Promise.resolve(this.getSuggestions(query));
	}

	/** Test helper: picks a suggestion as the user would. */
	pick(value: T): void {
		this.selectSuggestion(value, createFakeMouseEvent("click"));
		void this.choose?.(value);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------

export class BaseComponent {
	disabled = false;
	tooltip = "";

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}

	then(callback: (component: this) => unknown): this {
		callback(this);
		return this;
	}
}

export class ValueComponent<T> extends BaseComponent {
	protected value: T;
	protected changeHandler: ((value: T) => unknown) | null = null;

	constructor(initial: T) {
		super();
		this.value = initial;
	}

	getValue(): T {
		return this.value;
	}

	setValue(value: T): this {
		this.value = value;
		return this;
	}

	onChange(callback: (value: T) => unknown): this {
		this.changeHandler = callback;
		return this;
	}

	/** Test helper: changes the value as the user would and runs the handler. */
	simulateChange(value: T): unknown {
		this.value = value;
		return this.changeHandler?.(value);
	}
}

export class TextComponent extends ValueComponent<string> {
	readonly inputEl: HTMLInputElement;
	placeholder = "";

	constructor(containerEl: HTMLElement) {
		super("");
		this.inputEl = containerEl.createEl("input", { type: "text" }) as HTMLInputElement;
	}

	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		this.inputEl.setAttribute("placeholder", placeholder);
		return this;
	}

	override setValue(value: string): this {
		this.inputEl.value = value;
		return super.setValue(value);
	}
}

export class TextAreaComponent extends TextComponent {}

export class SearchComponent extends TextComponent {}

export class SecretComponent extends ValueComponent<string> {
	constructor(public app: unknown, public containerEl: HTMLElement) {
		super("");
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	readonly toggleEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super(false);
		this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
		// Obsidian nests a focusable checkbox in the container.
		this.toggleEl.createEl("input", { attr: { type: "checkbox", tabindex: "0" } });
	}
}

export class DropdownComponent extends ValueComponent<string> {
	readonly selectEl: HTMLSelectElement;
	options: Record<string, string> = {};

	constructor(containerEl: HTMLElement) {
		super("");
		this.selectEl = containerEl.createEl("select") as HTMLSelectElement;
	}

	addOption(value: string, display: string): this {
		this.options[value] = display;
		return this;
	}

	addOptions(options: Record<string, string>): this {
		Object.assign(this.options, options);
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	limits = { min: 0, max: 100, step: 1 };

	constructor(public containerEl: HTMLElement) {
		super(0);
	}

	setLimits(min: number, max: number, step: number | "any"): this {
		this.limits = { min, max, step: step === "any" ? 1 : step };
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	readonly buttonEl: HTMLButtonElement;
	text = "";
	cta = false;
	warning = false;
	icon = "";
	private clickHandler: ((event: MouseEvent) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = containerEl.createEl("button") as HTMLButtonElement;
	}

	setButtonText(text: string): this {
		this.text = text;
		this.buttonEl.setText(text);
		return this;
	}

	setCta(): this {
		this.cta = true;
		this.buttonEl.classList.add("mod-cta");
		return this;
	}

	setClass(cls: string): this {
		this.buttonEl.classList.add(cls);
		return this;
	}

	setWarning(): this {
		this.warning = true;
		return this;
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	onClick(callback: (event: MouseEvent) => unknown): this {
		this.clickHandler = callback;
		return this;
	}

	/** Test helper: presses the button unless it is disabled. */
	click(): unknown {
		return this.disabled ? undefined : this.clickHandler?.(createFakeMouseEvent("click"));
	}
}

export class ExtraButtonComponent extends BaseComponent {
	readonly extraSettingsEl: HTMLElement;
	icon = "";
	private clickHandler: (() => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		super();
		this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button" });
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	onClick(callback: () => unknown): this {
		this.clickHandler = callback;
		// Like Obsidian's, the handler also answers a click on the element, so a key press that clicks it reaches the handler.
		this.extraSettingsEl.addEventListener("click", () => this.click());
		return this;
	}

	click(): unknown {
		return this.disabled ? undefined : this.clickHandler?.();
	}
}

export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	readonly components: BaseComponent[] = [];
	heading = false;
	disabled = false;

	constructor(public containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}

	get name(): string {
		return this.nameEl.getText();
	}

	get desc(): string {
		return this.descEl.getText();
	}

	setName(name: string | DocumentFragment): this {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		this.descEl.setText(desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.classList.add(cls);
		return this;
	}

	setTooltip(tooltip: string): this {
		this.settingEl.setAttribute("aria-label", tooltip);
		return this;
	}

	setHeading(): this {
		this.heading = true;
		this.settingEl.classList.add("setting-item-heading");
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		this.components.forEach((component) => component.setDisabled(disabled));
		return this;
	}

	then(callback: (setting: this) => unknown): this {
		callback(this);
		return this;
	}

	private track<T extends BaseComponent>(component: T, callback: (component: T) => unknown): this {
		this.components.push(component);
		callback(component);
		return this;
	}

	addText(callback: (component: TextComponent) => unknown): this {
		return this.track(new TextComponent(this.controlEl), callback);
	}

	addTextArea(callback: (component: TextAreaComponent) => unknown): this {
		return this.track(new TextAreaComponent(this.controlEl), callback);
	}

	addSearch(callback: (component: SearchComponent) => unknown): this {
		return this.track(new SearchComponent(this.controlEl), callback);
	}

	addToggle(callback: (component: ToggleComponent) => unknown): this {
		return this.track(new ToggleComponent(this.controlEl), callback);
	}

	addDropdown(callback: (component: DropdownComponent) => unknown): this {
		return this.track(new DropdownComponent(this.controlEl), callback);
	}

	addSlider(callback: (component: SliderComponent) => unknown): this {
		return this.track(new SliderComponent(this.controlEl), callback);
	}

	addButton(callback: (component: ButtonComponent) => unknown): this {
		return this.track(new ButtonComponent(this.controlEl), callback);
	}

	addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
		return this.track(new ExtraButtonComponent(this.controlEl), callback);
	}

	/** Test helper: the first component of a kind, such as the toggle of a row. */
	component<T extends BaseComponent>(kind: new (...args: never[]) => T): T | undefined {
		return this.components.find((component): component is T => component instanceof kind);
	}
}

export class SettingGroup {
	readonly listEl: HTMLElement;
	readonly settings: Setting[] = [];
	headingText = "";

	constructor(public containerEl: HTMLElement) {
		this.listEl = containerEl.createDiv({ cls: "setting-group" });
	}

	setHeading(text: string | DocumentFragment): this {
		this.headingText = typeof text === "string" ? text : text.textContent ?? "";
		return this;
	}

	addClass(...classes: string[]): this {
		this.listEl.classList.add(...classes);
		return this;
	}

	addSetting(callback: (setting: Setting) => void): this {
		const setting = new Setting(this.listEl);
		this.settings.push(setting);
		callback(setting);
		return this;
	}

	addSearch(callback: (component: SearchComponent) => unknown): this {
		callback(new SearchComponent(this.listEl));
		return this;
	}

	addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
		callback(new ExtraButtonComponent(this.listEl));
		return this;
	}
}

export abstract class SettingPage {
	readonly rootEl: HTMLElement = createFakeEl("div");
	readonly titlebarEl: HTMLElement = this.rootEl.createDiv({ cls: "setting-page-titlebar" });
	readonly containerEl: HTMLElement = this.rootEl.createDiv({ cls: "setting-page-content" });
	title = "";

	abstract display(): void;

	hide(): void {
		this.containerEl.empty();
	}
}

export abstract class PluginSettingTab {
	readonly containerEl: HTMLElement = createFakeEl("div");
	icon = "";

	constructor(public app: unknown, public plugin: unknown) {}

	/** How many times the definitions were rebuilt, as Obsidian 1.13 does on update(). */
	updateCount = 0;

	abstract display(): void;

	update(): void {
		this.updateCount += 1;
	}

	hide(): void {
		this.containerEl.empty();
	}
}
