/**
 * An in-memory Obsidian app for tests: vault, workspace, metadata cache, secret storage and editor.
 *
 * The vault keeps a real folder tree (`TFolder.children`), because the code under test walks `getFolderByPath` and
 * `children` rather than the adapter. `add()` seeds files without raising events; `create()`, `modify()`, `delete()` and
 * `rename()` behave like the user's actions and trigger the matching vault events.
 */
import type { App, Editor as ObsidianEditor, MarkdownView as ObsidianMarkdownView, TFile as ObsidianTFile } from "obsidian";
import { Events, MarkdownView, TAbstractFile, TFile, TFolder } from "./obsidian-fakes";

export type Position = { line: number; ch: number };

export class FakeEditor {
	selectionStart = 0;
	selectionEnd = 0;
	cursorLine = 0;
	getValueCalls = 0;

	constructor(public value: string) {}

	/** The same editor typed as Obsidian's `Editor`, for passing to the code under test. */
	asEditor(): ObsidianEditor {
		return this as unknown as ObsidianEditor;
	}

	select(text: string): this {
		this.selectionStart = this.value.indexOf(text);
		this.selectionEnd = this.selectionStart + text.length;
		this.cursorLine = this.offsetToPos(this.selectionStart).line;
		return this;
	}

	getValue(): string {
		this.getValueCalls += 1;
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
	}

	getSelection(): string {
		return this.value.slice(this.selectionStart, this.selectionEnd);
	}

	replaceSelection(text: string): void {
		this.value = this.value.slice(0, this.selectionStart) + text + this.value.slice(this.selectionEnd);
		this.selectionEnd = this.selectionStart + text.length;
	}

	somethingSelected(): boolean {
		return this.selectionEnd > this.selectionStart;
	}

	getCursor(which?: "from" | "to"): Position {
		if (which === "from") {
			return this.offsetToPos(this.selectionStart);
		}
		if (which === "to") {
			return this.offsetToPos(this.selectionEnd);
		}
		return { line: this.cursorLine, ch: 0 };
	}

	posToOffset(position: Position): number {
		const lines = this.value.split("\n");
		return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.ch;
	}

	offsetToPos(offset: number): Position {
		const before = this.value.slice(0, offset).split("\n");
		return { line: before.length - 1, ch: (before[before.length - 1] ?? "").length };
	}
}

export type FakeLeaf = { view: unknown; getViewState: () => { type: string; state?: Record<string, unknown> } };

export function leafFor(view: unknown, type: string, file: string | null): FakeLeaf {
	return { view, getViewState: () => ({ type, state: file ? { file } : {} }) };
}

export class FakeWorkspace extends Events {
	activeView: MarkdownView<unknown> | null = null;
	activeFile: TFile | null = null;
	leaves: FakeLeaf[] = [];
	/** Link texts passed to `openLinkText`, in order. */
	openedLinks: Array<{ linktext: string; sourcePath: string; newLeaf: boolean | string | undefined }> = [];
	layoutReady = true;

	getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null {
		return this.activeView instanceof type ? this.activeView : null;
	}

	getActiveFile(): TFile | null {
		return this.activeFile;
	}

	getLeavesOfType(type: string): FakeLeaf[] {
		return this.leaves.filter((leaf) => leaf.getViewState().type === type);
	}

	iterateAllLeaves(callback: (leaf: FakeLeaf) => void): void {
		this.leaves.forEach(callback);
	}

	openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean | string): Promise<void> {
		this.openedLinks.push({ linktext, sourcePath, newLeaf });
		return Promise.resolve();
	}

	onLayoutReady(callback: () => void): void {
		if (this.layoutReady) {
			callback();
		} else {
			this.once("layout-ready", callback);
		}
	}

	private once(name: string, callback: () => void): void {
		const ref = this.on(name, () => {
			this.offref(ref);
			callback();
		});
	}

	/** Test helper: marks the layout ready and runs callbacks waiting for it. */
	markLayoutReady(): void {
		this.layoutReady = true;
		this.trigger("layout-ready");
	}
}

export class FakeVault extends Events {
	configDir = ".obsidian";
	files = new Map<string, TFile>();
	folders = new Map<string, TFolder>();
	contents = new Map<string, string>();
	/** Paths read through `cachedRead` or `read`, in order. */
	reads: string[] = [];
	private readonly root = new TFolder("");

	constructor() {
		super();
		this.root.vault = this as unknown as TFolder["vault"];
		this.folders.set("", this.root);
	}

	/** Seeds a file (and its folders) without raising events. */
	add(path: string, content: string): TFile {
		const file = new TFile(path);
		file.vault = this as unknown as TFile["vault"];
		this.files.set(path, file);
		this.contents.set(path, content);
		this.attach(file);
		return file;
	}

	/** Seeds an empty folder. */
	addFolder(path: string): TFolder {
		return this.ensureFolder(path);
	}

	private ensureFolder(path: string): TFolder {
		const clean = path === "/" ? "" : path;
		const existing = this.folders.get(clean);
		if (existing) {
			return existing;
		}
		const folder = new TFolder(clean);
		folder.vault = this as unknown as TFolder["vault"];
		this.folders.set(clean, folder);
		this.attach(folder);
		return folder;
	}

	private attach(entry: TAbstractFile): void {
		const slash = entry.path.lastIndexOf("/");
		const parent = this.ensureFolder(slash < 0 ? "" : entry.path.slice(0, slash));
		entry.parent = parent;
		if (!parent.children.includes(entry)) {
			parent.children.push(entry);
		}
	}

	private detach(entry: TAbstractFile): void {
		if (entry.parent) {
			entry.parent.children = entry.parent.children.filter((child) => child !== entry);
		}
	}

	remove(path: string): void {
		const file = this.files.get(path);
		if (file) {
			this.detach(file);
		}
		this.files.delete(path);
		this.contents.delete(path);
	}

	rename(file: TFile, newPath: string): void {
		const content = this.contents.get(file.path) ?? "";
		this.detach(file);
		this.remove(file.path);
		file.path = newPath;
		this.files.set(newPath, file);
		this.contents.set(newPath, content);
		this.attach(file);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(path) ?? this.folders.get(path) ?? null;
	}

	getFileByPath(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	getFolderByPath(path: string): TFolder | null {
		return this.folders.get(path === "/" ? "" : path) ?? null;
	}

	getRoot(): TFolder {
		return this.root;
	}

	getName(): string {
		return "Fake vault";
	}

	getFiles(): TFile[] {
		return Array.from(this.files.values());
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((file) => file.extension === "md");
	}

	async cachedRead(file: TFile): Promise<string> {
		return await this.read(file);
	}

	read(file: TFile): Promise<string> {
		this.reads.push(file.path);
		const content = this.contents.get(file.path);
		return content === undefined ? Promise.reject(new Error(`ENOENT: ${file.path}`)) : Promise.resolve(content);
	}

	create(path: string, content: string): Promise<TFile> {
		const file = this.add(path, content);
		this.trigger("create", file);
		return Promise.resolve(file);
	}

	createFolder(path: string): Promise<TFolder> {
		const folder = this.ensureFolder(path);
		this.trigger("create", folder);
		return Promise.resolve(folder);
	}

	modify(file: TFile, content: string): Promise<void> {
		this.contents.set(file.path, content);
		this.trigger("modify", file);
		return Promise.resolve();
	}

	process(file: TFile, update: (content: string) => string): Promise<string> {
		const next = update(this.contents.get(file.path) ?? "");
		this.contents.set(file.path, next);
		this.trigger("modify", file);
		return Promise.resolve(next);
	}

	delete(file: TAbstractFile): Promise<void> {
		this.remove(file.path);
		this.trigger("delete", file);
		return Promise.resolve();
	}

	renameFile(file: TFile, newPath: string): Promise<void> {
		const oldPath = file.path;
		this.rename(file, newPath);
		this.trigger("rename", file, oldPath);
		return Promise.resolve();
	}

	/** Compatibility for older tests that listed folders through the adapter. */
	adapter = {
		list: (folder: string): Promise<{ files: string[]; folders: string[] }> => {
			const prefix = `${folder}/`;
			const direct = (path: string): boolean => path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
			return Promise.resolve({
				files: Array.from(this.files.keys()).filter(direct),
				folders: Array.from(this.folders.keys()).filter((path) => path !== "" && direct(path))
			});
		}
	};
}

type FakeFileCache = {
	links?: { link: string }[];
	tags?: { tag: string }[];
	frontmatter?: Record<string, unknown>;
};

export class FakeMetadataCache extends Events {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	caches = new Map<string, FakeFileCache>();

	constructor(private readonly vault: FakeVault) {
		super();
	}

	getFileCache(file: TFile): FakeFileCache | null {
		return this.caches.get(file.path) ?? null;
	}

	/** Link resolution as Obsidian does it for the cases tests need: exact path, then `.md`, then unique basename. */
	getFirstLinkpathDest(link: string, _sourcePath?: string): TFile | null {
		const clean = link.split(/[#^|]/)[0]?.trim() ?? "";
		const direct = this.vault.files.get(clean) ?? this.vault.files.get(`${clean}.md`);
		if (direct) {
			return direct;
		}
		return Array.from(this.vault.files.values()).find((file) => file.name === clean || file.basename === clean) ?? null;
	}

	fileToLinktext(file: TFile): string {
		return file.extension === "md" ? file.path.replace(/\.md$/, "") : file.path;
	}
}

const SECRET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class FakeSecretStorage extends Events {
	private readonly secrets = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		if (!SECRET_ID.test(id)) {
			throw new Error(`Invalid secret ID: ${id}`);
		}
		this.secrets.set(id, secret);
		this.trigger("change", id);
	}

	getSecret(id: string): string | null {
		return this.secrets.get(id) ?? null;
	}

	listSecrets(): string[] {
		return Array.from(this.secrets.keys());
	}
}

export interface FakeApp {
	/** Typed as Obsidian's `App`, for constructing the code under test. */
	app: App;
	vault: FakeVault;
	workspace: FakeWorkspace;
	metadataCache: FakeMetadataCache;
	secretStorage: FakeSecretStorage;
	/** Everything `app.setting.open*` was asked to show. */
	settingCalls: string[];
	localStorage: Map<string, unknown>;
}

export function createFakeApp(): FakeApp {
	const vault = new FakeVault();
	const workspace = new FakeWorkspace();
	const metadataCache = new FakeMetadataCache(vault);
	const secretStorage = new FakeSecretStorage();
	const settingCalls: string[] = [];
	const localStorage = new Map<string, unknown>();
	const app = {
		vault,
		workspace,
		metadataCache,
		secretStorage,
		setting: {
			open: (): void => void settingCalls.push("open"),
			openTabById: (id: string): void => void settingCalls.push(`tab:${id}`)
		},
		loadLocalStorage: (key: string): unknown => localStorage.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown): void => {
			if (value === null) {
				localStorage.delete(key);
			} else {
				localStorage.set(key, value);
			}
		}
	} as unknown as App;
	return { app, vault, workspace, metadataCache, secretStorage, settingCalls, localStorage };
}

/** Opens a note in a fake Markdown view and registers its leaf with the workspace. */
export function openFakeMarkdownView(workspace: FakeWorkspace, file: TFile, content: string): MarkdownView<FakeEditor> {
	const view = new MarkdownView(new FakeEditor(content), file);
	workspace.leaves.push(leafFor(view, "markdown", file.path));
	return view;
}

/** The note typed as Obsidian's `TFile`. */
export function asObsidianFile(file: TFile): ObsidianTFile {
	return file as unknown as ObsidianTFile;
}

export function asObsidianView(view: MarkdownView<unknown>): ObsidianMarkdownView {
	return view as unknown as ObsidianMarkdownView;
}
