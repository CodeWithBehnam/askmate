import { beforeEach, describe, expect, test } from "bun:test";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, NoteContext } from "../src/shared/types";

import { MarkdownView, TAbstractFile, TFile, TFolder } from "./support/obsidian-fakes";

type Position = { line: number; ch: number };

class FakeEditor {
	selectionStart = 0;
	selectionEnd = 0;
	cursorLine = 0;
	getValueCalls = 0;

	constructor(public value: string) {}

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

	getSelection(): string {
		return this.value.slice(this.selectionStart, this.selectionEnd);
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

const {
	ContextService,
	cleanFolderPath,
	extractExcalidrawTexts,
	parseExcalidrawTextElements,
	remapRenamedPath,
	truncateAtBoundary
} = await import("../src/context/ContextService");

type Leaf = { view: unknown; getViewState: () => { type: string; state?: Record<string, unknown> } };

function leafFor(view: unknown, type: string, file: string | null): Leaf {
	return { view, getViewState: () => ({ type, state: file ? { file } : {} }) };
}

class FakeWorkspace {
	activeView: MarkdownView | null = null;
	activeFile: TFile | null = null;
	leaves: Leaf[] = [];

	getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null {
		return this.activeView instanceof type ? this.activeView : null;
	}

	getActiveFile(): TFile | null {
		return this.activeFile;
	}

	getLeavesOfType(type: string): Leaf[] {
		return this.leaves.filter((leaf) => leaf.getViewState().type === type);
	}

	iterateAllLeaves(callback: (leaf: Leaf) => void): void {
		this.leaves.forEach(callback);
	}
}

class FakeVault {
	configDir = ".obsidian";
	files = new Map<string, TFile>();
	contents = new Map<string, string>();
	reads: string[] = [];
	folders = new Set<string>();

	add(path: string, content: string): TFile {
		const file = new TFile(path);
		this.files.set(path, file);
		this.contents.set(path, content);
		const parts = path.split("/");
		parts.slice(0, -1).forEach((_, index) => this.folders.add(parts.slice(0, index + 1).join("/")));
		return file;
	}

	remove(path: string): void {
		this.files.delete(path);
		this.contents.delete(path);
	}

	rename(file: TFile, newPath: string): void {
		const content = this.contents.get(file.path) ?? "";
		this.remove(file.path);
		file.path = newPath;
		this.files.set(newPath, file);
		this.contents.set(newPath, content);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(path) ?? null;
	}

	async cachedRead(file: TFile): Promise<string> {
		this.reads.push(file.path);
		const content = this.contents.get(file.path);
		if (content === undefined) {
			throw new Error(`ENOENT: ${file.path}`);
		}
		return content;
	}

	adapter = {
		list: async (folder: string): Promise<{ files: string[]; folders: string[] }> => {
			const prefix = `${folder}/`;
			const direct = (path: string): boolean => path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
			return {
				files: Array.from(this.files.keys()).filter(direct),
				folders: Array.from(this.folders).filter(direct)
			};
		}
	};
}

class FakeMetadataCache {
	constructor(private readonly vault: FakeVault) {}

	getFirstLinkpathDest(link: string): TFile | null {
		const direct = this.vault.files.get(link) ?? this.vault.files.get(`${link}.md`);
		if (direct) {
			return direct;
		}
		return Array.from(this.vault.files.values()).find((file) => file.path.split("/").pop() === link) ?? null;
	}
}

type Harness = {
	service: InstanceType<typeof ContextService>;
	workspace: FakeWorkspace;
	vault: FakeVault;
	settings: AskMateSettings;
};

function createHarness(overrides: Partial<AskMateSettings> = {}): Harness {
	const workspace = new FakeWorkspace();
	const vault = new FakeVault();
	const metadataCache = new FakeMetadataCache(vault);
	const settings = { ...structuredClone(normalizeAskMateSettings({}, "load")), ...overrides };
	const service = new ContextService({
		app: { workspace, vault, metadataCache },
		getSettings: () => settings,
		getNoteHistoryForPath: () => []
	});
	return { service, workspace, vault, settings };
}

function openInView(harness: Harness, file: TFile, content: string): MarkdownView {
	const view = new MarkdownView(new FakeEditor(content), file);
	harness.workspace.leaves.push(leafFor(view, "markdown", file.path));
	return view;
}

function focus(harness: Harness, view: MarkdownView | null, file: TFile | null = view?.file ?? null): void {
	harness.workspace.activeView = view;
	harness.workspace.activeFile = file;
	harness.service.rememberActiveMarkdownContext();
}

function focusSidebar(harness: Harness): void {
	harness.workspace.activeView = null;
	harness.workspace.activeFile = null;
	harness.service.rememberActiveMarkdownContext();
}

function closeLeavesFor(harness: Harness, path: string): void {
	harness.workspace.leaves = harness.workspace.leaves.filter((leaf) => leaf.getViewState().state?.file !== path);
}

describe("rename and delete (C8)", () => {
	let harness: Harness;
	let note: TFile;
	let view: MarkdownView;

	beforeEach(() => {
		harness = createHarness();
		note = harness.vault.add("Projects/Plan.md", "# Plan\nAlpha beta gamma");
		view = openInView(harness, note, "# Plan\nAlpha beta gamma");
		view.editor.select("beta");
		focus(harness, view);
		harness.service.rememberEditorContext(view.editor, note);
	});

	test("remapRenamedPath handles files, folders and unrelated paths", () => {
		expect(remapRenamedPath("a/b.md", "a/b.md", "c.md")).toBe("c.md");
		expect(remapRenamedPath("a/b.md", "a", "z")).toBe("z/b.md");
		expect(remapRenamedPath("ab/c.md", "a", "z")).toBeNull();
	});

	test("renaming the remembered note refreshes the file and the selection snapshot", async () => {
		const oldPath = note.path;
		harness.vault.rename(note, "Projects/Roadmap.md");
		harness.service.handleFileRenamed(note, oldPath);
		focusSidebar(harness);
		closeLeavesFor(harness, oldPath);
		harness.workspace.leaves.push(leafFor(view, "markdown", note.path));

		expect(harness.service.getLastMarkdownFile()?.path).toBe("Projects/Roadmap.md");
		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Selected text");
		expect(context.selectionIdentity?.sourcePath).toBe("Projects/Roadmap.md");
	});

	test("renaming a parent folder refreshes remembered paths inside it", () => {
		const folder = new TFolder("Archive");
		harness.vault.rename(note, "Archive/Plan.md");
		harness.service.handleFileRenamed(folder, "Projects");
		expect(harness.service.getLastMarkdownFile()?.path).toBe("Archive/Plan.md");
	});

	test("renaming the note to a non-Markdown extension forgets it", () => {
		const oldPath = note.path;
		harness.vault.rename(note, "Projects/Plan.txt");
		harness.service.handleFileRenamed(note, oldPath);
		expect(harness.service.getLastMarkdownFile()).toBeNull();
	});

	test("deleting the remembered note forgets it and gives the friendly error, not a read error", async () => {
		harness.vault.remove(note.path);
		closeLeavesFor(harness, note.path);
		harness.service.handleFileDeleted(note);
		focusSidebar(harness);

		expect(harness.service.getLastMarkdownFile()).toBeNull();
		await expect(harness.service.getNoteContext()).rejects.toThrow("Open a Markdown note or select text before using AskMate.");
		expect(harness.vault.reads).toEqual([]);
	});

	test("deleting a parent folder forgets remembered files inside it", () => {
		harness.service.handleFileDeleted(new TFolder("Projects"));
		expect(harness.service.getLastMarkdownFile()).toBeNull();
	});

	test("deleting an unrelated file keeps the remembered note", () => {
		harness.service.handleFileDeleted(new TFile("Projects/Other.md"));
		expect(harness.service.getLastMarkdownFile()?.path).toBe("Projects/Plan.md");
	});
});


describe("sidebar context rule", () => {
	test("prefers the active view's selected text", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "# A\nOne two three");
		const view = openInView(harness, note, "# A\nOne two three");
		view.editor.select("two");
		focus(harness, view);

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Selected text");
		expect(context.content).toBe("two");
		expect(context.file?.path).toBe("A.md");
		expect(context.activeHeadingPath).toBe("A");
	});

	test("uses the full current note when nothing is selected", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "# A\nOne two three");
		focus(harness, openInView(harness, note, "# A\nOne two three"));

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Current note");
		expect(context.content).toBe("# A\nOne two three");
	});

	test("uses the last remembered view when the sidebar has focus", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved");
		const view = openInView(harness, note, "live editor text");
		focus(harness, view);
		focusSidebar(harness);
		view.editor.select("editor");

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Selected text");
		expect(context.content).toBe("editor");
		expect(harness.vault.reads).toEqual([]);
	});

	test("remembers a selection from editor-change without an active view", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		const editor = new FakeEditor("typed text").select("typed");
		harness.workspace.leaves.push(leafFor({}, "markdown", note.path));
		harness.service.rememberMarkdownFile(note);
		harness.service.rememberEditorContext(editor, note);
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Selected text");
		expect(context.content).toBe("typed");
		expect(context.selectionIdentity?.sourcePath).toBe("A.md");
	});

	test("reads the file when the remembered view closed but the note is still open in a deferred tab", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		focus(harness, openInView(harness, note, "live text"));
		harness.workspace.leaves = [leafFor({}, "markdown", note.path)];
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.content).toBe("saved text");
		expect(harness.vault.reads).toEqual(["A.md"]);
	});

	test("reads the last remembered file with cachedRead when no view is available", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		harness.workspace.leaves.push(leafFor({}, "markdown", note.path));
		harness.service.rememberMarkdownFile(note);
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.content).toBe("saved text");
		expect(harness.vault.reads).toEqual(["A.md"]);
	});
});

describe("full note for @note", () => {
	test("uses the open editor's whole text and ignores the selection", async () => {
		const harness = createHarness();
		const note = harness.vault.add("Plan.md", "# Plan (saved copy)");
		const view = openInView(harness, note, "# Plan\n\nUnsaved edit.\n\nMore text.");
		view.editor.select("Unsaved edit.");
		const context = await harness.service.getFullNoteContext(note);
		expect(context.source).toBe("Current note");
		expect(context.content).toBe("# Plan\n\nUnsaved edit.\n\nMore text.");
	});

	test("reads the saved file when the note is not open", async () => {
		const harness = createHarness();
		const note = harness.vault.add("Closed.md", "Saved text.");
		const context = await harness.service.getFullNoteContext(note);
		expect(context.content).toBe("Saved text.");
	});
});

describe("recency and stale files (context#1, context#3)", () => {
	test("a newer .md file in a non-Markdown view beats an older open MarkdownView", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "note A");
		const drawing = harness.vault.add("Drawing.excalidraw.md", "drawing text");
		focus(harness, openInView(harness, note, "note A"));
		harness.workspace.leaves.push(leafFor({}, "excalidraw", drawing.path));
		harness.workspace.activeView = null;
		harness.workspace.activeFile = drawing;
		harness.service.rememberMarkdownFile(drawing);
		harness.service.rememberActiveMarkdownContext();
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.file?.path).toBe("Drawing.excalidraw.md");
		// Excalidraw files are summarised to their text labels rather than sent as raw drawing data.
		expect(context.content).toContain("[Excalidraw drawing");
	});

	test("returning to the Markdown tab makes its view the newest again", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "note A");
		const drawing = harness.vault.add("Drawing.excalidraw.md", "drawing text");
		const view = openInView(harness, note, "note A");
		focus(harness, view);
		harness.workspace.leaves.push(leafFor({}, "excalidraw", drawing.path));
		harness.service.rememberMarkdownFile(drawing);
		focus(harness, view);
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.file?.path).toBe("A.md");
	});

	test("a closed note is not sent from the sidebar", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "note A");
		focus(harness, openInView(harness, note, "note A"));
		closeLeavesFor(harness, note.path);
		harness.workspace.leaves.push(leafFor({}, "graph", null));
		focusSidebar(harness);

		await expect(harness.service.getNoteContext()).rejects.toThrow("Open a Markdown note");
		expect(harness.service.getLastMarkdownFile()).toBeNull();
	});

	test("a deleted note gives the friendly error even without a delete event", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "note A");
		harness.workspace.leaves.push(leafFor({}, "markdown", note.path));
		harness.service.rememberMarkdownFile(note);
		harness.vault.remove(note.path);
		focusSidebar(harness);

		await expect(harness.service.getNoteContext()).rejects.toThrow("Open a Markdown note");
		expect(harness.vault.reads).toEqual([]);
	});

	test("a selection snapshot from an editor whose file is closed is dropped", async () => {
		const harness = createHarness();
		const note = harness.vault.add("Embedded.md", "embedded words");
		const other = harness.vault.add("B.md", "note B");
		const editor = new FakeEditor("embedded words").select("words");
		harness.service.rememberEditorContext(editor, note);
		harness.workspace.leaves.push(leafFor({}, "markdown", other.path));
		harness.service.rememberMarkdownFile(other);
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Current note");
		expect(context.file?.path).toBe("B.md");
	});
});

const EXCALIDRAW_MD = [
	"---",
	"excalidraw-plugin: parsed",
	"---",
	"==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
	"",
	"# Excalidraw Data",
	"",
	"## Text Elements",
	"Login flow ^a1B2c3D4",
	"",
	"Retry with \"backoff\" ^e5F6g7H8",
	"",
	"E = mc^2",
	"second line ^i9J0k1L2",
	"",
	"## Embedded Files",
	"0f1e2d3c: [[Private/scan-passport.png]]",
	"",
	"%%",
	"## Drawing",
	"```compressed-json",
	"N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MQHNsYfpwBGAOlT0AtmIBeNCtlQbs6RmPry6uA",
	"```",
	"%%"
].join("\n");

describe("attachment truncation (context#5)", () => {
	test("never leaves a lone surrogate", () => {
		const cut = truncateAtBoundary("ab\u{1F600}cd", 3);
		expect(cut.text).toBe("ab");
		expect(cut.truncated).toBe(true);
	});

	test("prefers a nearby line break", () => {
		expect(truncateAtBoundary("0123456789\nabcdefghij", 12).text).toBe("0123456789");
	});

	test("additional notes carry a visible notice and stop at the budget", async () => {
		const harness = createHarness();
		harness.vault.add("One.md", "a".repeat(50));
		harness.vault.add("Two.md", "b".repeat(50));
		harness.vault.add("Three.md", "c".repeat(50));
		const attachments = await harness.service.buildAdditionalNoteAttachments(["One.md", "Two.md", "Three.md"], "Source.md", 80);

		expect(attachments.map((attachment) => attachment.sourcePath)).toEqual(["One.md", "Two.md"]);
		expect(attachments[0]?.truncated).toBe(false);
		expect(attachments[1]?.truncated).toBe(true);
		expect(attachments[1]?.content).toContain("b".repeat(30));
		expect(attachments[1]?.content).not.toContain("b".repeat(31));
		expect(attachments[1]?.content).toContain("[AskMate truncated this attachment: showing 30 of 50 characters.");
	});

	test("folder notes are truncated with the notice and respect the folder walk limit", async () => {
		const harness = createHarness();
		harness.vault.add("Folder/A.md", "x".repeat(900));
		harness.vault.add("Folder/B.md", "y".repeat(900));
		harness.vault.add("Folder/Sub/C.md", "z".repeat(10));
		harness.vault.add("Folder/Current.md", "skip me");
		const attachments = await harness.service.buildFolderContextAttachments(
			{ enabled: true, path: "Folder", maxFiles: 5, maxCharacters: 1000 },
			"Folder/Current.md"
		);

		expect(attachments.map((attachment) => attachment.sourcePath)).toEqual(["Folder/A.md", "Folder/B.md"]);
		expect(attachments[1]?.truncated).toBe(true);
		expect(attachments[1]?.content).toContain("showing 100 of 900 characters");

		const limited = await harness.service.listMarkdownFilesInFolder("Folder", 2);
		expect(limited.map((file) => file.path)).toEqual(["Folder/A.md", "Folder/B.md"]);
	});
});

describe("Excalidraw summaries (context#6, context#7)", () => {
	test("reads labels from the Text Elements section of .excalidraw.md", () => {
		expect(parseExcalidrawTextElements(EXCALIDRAW_MD)).toEqual([
			"Login flow",
			"Retry with \"backoff\"",
			"E = mc^2 second line"
		]);
	});

	test("reads uncompressed JSON drawings, including escaped quotes", () => {
		const json = JSON.stringify({ elements: [{ type: "text", text: "Say \"hi\"" }, { type: "rectangle" }] });
		expect(extractExcalidrawTexts(json, "Board.excalidraw")).toEqual(["Say \"hi\""]);
		expect(extractExcalidrawTexts(`{"elements":[{"type":"text","text":"Cut \\"here\\" ok"}`, "Broken.excalidraw.json")).toEqual(["Cut \"here\" ok"]);
		const markdown = `## Text Elements\nTitle ^abc123\n\n%%\n## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%`;
		expect(extractExcalidrawTexts(markdown, "Plain.excalidraw.md")).toEqual(["Title", "Say \"hi\""]);
	});

	test("omits image paths when image links are excluded, keeps them otherwise", async () => {
		const harness = createHarness({ includeExcalidrawSummaries: true });
		const drawing = harness.vault.add("Flow.excalidraw.md", EXCALIDRAW_MD);
		const context: NoteContext = { content: EXCALIDRAW_MD, file: drawing, source: "Current note" };

		const hidden = await harness.service.buildExcalidrawSummaryAttachments(context, { includeImageReferences: false });
		expect(hidden[0]?.content).toContain("Login flow");
		expect(hidden[0]?.content).not.toContain("scan-passport");

		const shown = await harness.service.buildExcalidrawSummaryAttachments(context, { includeImageReferences: true });
		expect(shown[0]?.content).toContain("Private/scan-passport.png");
	});

	test("a long summary is cut with a notice", () => {
		const harness = createHarness({ excalidrawSummaryMaxCharacters: 200 });
		const labels = Array.from({ length: 40 }, (_, index) => `Label number ${index} ^id${index}`).join("\n\n");
		const summary = harness.service.extractExcalidrawSummary(`## Text Elements\n${labels}`, "Big.excalidraw.md");
		expect(summary.truncated).toBe(true);
		expect(summary.text).toContain("[AskMate truncated this attachment:");
	});
});

describe("keystroke cost and reading mode (context#8, context#9)", () => {
	test("editor-change without a selection does not read the note", () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "# A\nbody");
		const view = openInView(harness, note, "# A\nbody");
		harness.workspace.activeView = view;
		harness.service.rememberEditorContext(view.editor, note);
		expect(view.editor.getValueCalls).toBe(0);
	});

	test("a selection snapshot reads the note once and parses headings only when asked", async () => {
		const harness = createHarness();
		const text = "# Top\n## Inner\nchosen words";
		const note = harness.vault.add("A.md", text);
		const view = openInView(harness, note, text);
		view.editor.select("chosen");
		harness.workspace.activeView = view;
		harness.service.rememberEditorContext(view.editor, note);
		expect(view.editor.getValueCalls).toBe(1);

		focusSidebar(harness);
		const context = await harness.service.getNoteContext();
		expect(context.content).toBe("chosen");
		expect(context.activeHeadingPath).toBe("Top > Inner");
	});

	test("reading mode ignores a hidden editor selection", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "first second");
		const view = openInView(harness, note, "first second");
		view.editor.select("second");
		focus(harness, view);
		view.mode = "preview";

		const active = await harness.service.getNoteContext();
		expect(active.source).toBe("Current note");

		focusSidebar(harness);
		const fromSidebar = await harness.service.getNoteContext();
		expect(fromSidebar.source).toBe("Current note");
		expect(fromSidebar.content).toBe("first second");
	});
});

describe("folder path safety (security#7)", () => {
	test("keeps ordinary folder paths", () => {
		expect(cleanFolderPath(" /AskMate/Results/ ")).toBe("AskMate/Results");
		expect(cleanFolderPath("Notes/v1..2")).toBe("Notes/v1..2");
		expect(cleanFolderPath("")).toBe("");
	});

	test("rejects dot segments and control characters", () => {
		expect(() => cleanFolderPath("../outside")).toThrow("\"..\" segment");
		expect(() => cleanFolderPath("AskMate/../../outside")).toThrow("\"..\" segment");
		expect(() => cleanFolderPath("AskMate/./Images")).toThrow("\".\"");
		expect(() => cleanFolderPath("AskMate/\u0000Images")).toThrow("control character");
	});

	test("folder context with a dot segment fails before listing", async () => {
		const harness = createHarness();
		await expect(harness.service.buildFolderContextAttachments(
			{ enabled: true, path: "Folder/..", maxFiles: 5, maxCharacters: 1000 },
			""
		)).rejects.toThrow("\"..\" segment");
	});
});

describe("image references", () => {
	test("extracts wiki and Markdown image references with labels", () => {
		const harness = createHarness();
		const infos = harness.service.extractImageReferenceInfos("See ![[Pics/cat.png|Cat]] and ![Dog](<Pics/my%20dog.jpg>) and [[Note]]");
		expect(infos.map((info) => [info.target, info.label])).toEqual([["Pics/cat.png", "Cat"], ["Pics/my dog.jpg", "Dog"]]);
	});

	test("the image manifest lists local images with their size", () => {
		const harness = createHarness();
		harness.vault.add("Pics/cat.png", "");
		const [manifest] = harness.service.buildImageManifestAttachments({ content: "![[cat.png]]", file: null, source: "Current note" });
		expect(manifest?.content).toContain("- Local image: Pics/cat.png (png,");
	});
});
