import { beforeEach, describe, expect, test } from "bun:test";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, NoteContext } from "../src/shared/types";

import { FakeEditor, createFakeApp, leafFor, openFakeMarkdownView, type FakeMetadataCache, type FakeVault, type FakeWorkspace } from "./support/fake-app";
import { MarkdownView, TFile, TFolder } from "./support/obsidian-fakes";

const {
	ContextService,
	FolderNotFoundError,
	cleanFolderPath,
	createNoNoteContext,
	describeSkippedContext,
	extractExcalidrawTexts,
	isExcalidrawNote,
	isNoNoteContext,
	parseExcalidrawTextElements,
	remapRenamedPath,
	truncateAtBoundary
} = await import("../src/context/ContextService");

type Harness = {
	service: InstanceType<typeof ContextService>;
	workspace: FakeWorkspace;
	vault: FakeVault;
	metadataCache: FakeMetadataCache;
	settings: AskMateSettings;
};

function createHarness(overrides: Partial<AskMateSettings> = {}): Harness {
	const { app, workspace, vault, metadataCache } = createFakeApp();
	const settings = { ...structuredClone(normalizeAskMateSettings({}, "load")), ...overrides };
	const service = new ContextService({
		app,
		getSettings: () => settings,
		getNoteHistoryForPath: () => []
	});
	return { service, workspace, vault, metadataCache, settings };
}

function openInView(harness: Harness, file: TFile, content: string): MarkdownView<FakeEditor> {
	return openFakeMarkdownView(harness.workspace, file, content);
}

function focus(harness: Harness, view: MarkdownView<unknown> | null, file: TFile | null = view?.file ?? null): void {
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
	let view: MarkdownView<FakeEditor>;

	beforeEach(() => {
		harness = createHarness();
		note = harness.vault.add("Projects/Plan.md", "# Plan\nAlpha beta gamma");
		view = openInView(harness, note, "# Plan\nAlpha beta gamma");
		view.editor.select("beta");
		focus(harness, view);
		harness.service.rememberEditorContext(view.editor.asEditor(), note);
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

	test("a selection cleared without an event is not resurrected from the snapshot", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "alpha beta gamma");
		const view = openInView(harness, note, "alpha beta gamma");
		view.editor.select("beta");
		focus(harness, view);
		harness.service.rememberEditorContext(view.editor.asEditor(), note);
		view.editor.selectionEnd = view.editor.selectionStart;
		focusSidebar(harness);

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Current note");
		expect(context.content).toBe("alpha beta gamma");
	});

	test("remembers a selection from editor-change without an active view", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		const editor = new FakeEditor("typed text").select("typed");
		harness.workspace.leaves.push(leafFor({}, "markdown", note.path));
		harness.service.rememberMarkdownFile(note);
		harness.service.rememberEditorContext(editor.asEditor(), note);
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
		harness.service.rememberEditorContext(editor.asEditor(), note);
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
		harness.service.rememberEditorContext(view.editor.asEditor(), note);
		expect(view.editor.getValueCalls).toBe(0);
	});

	test("a selection snapshot reads the note once and parses headings only when asked", async () => {
		const harness = createHarness();
		const text = "# Top\n## Inner\nchosen words";
		const note = harness.vault.add("A.md", text);
		const view = openInView(harness, note, text);
		view.editor.select("chosen");
		harness.workspace.activeView = view;
		harness.service.rememberEditorContext(view.editor.asEditor(), note);
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
		expect(() => cleanFolderPath("AskMate/\u009bImages")).toThrow("control character");
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

describe("vault mentions", () => {
	function vaultHarness(): { harness: Harness; current: TFile } {
		const harness = createHarness();
		const current = harness.vault.add("Current.md", "current body");
		harness.vault.add("Out1.md", "first outgoing");
		harness.vault.add("Out2.md", "second outgoing");
		harness.vault.add("Back.md", "links to current");
		harness.vault.add("Tagged.md", "frontmatter tag");
		harness.vault.add("Nested.md", "inline nested tag");
		harness.vault.files.get("Back.md")!.stat.mtime = 5;
		harness.vault.files.get("Tagged.md")!.stat.mtime = 9;
		harness.vault.files.get("Nested.md")!.stat.mtime = 7;
		harness.metadataCache.resolvedLinks = {
			"Current.md": { "Out1.md": 1, "Out2.md": 1 },
			"Back.md": { "Current.md": 1 },
			"Out1.md": {},
			"Out2.md": {},
			"Tagged.md": {},
			"Nested.md": {}
		};
		harness.metadataCache.caches.set("Current.md", { links: [{ link: "Out2#Heading" }, { link: "Out1|alias" }, { link: "Missing" }] });
		harness.metadataCache.caches.set("Tagged.md", { frontmatter: { tags: ["Project"] } });
		harness.metadataCache.caches.set("Nested.md", { tags: [{ tag: "#project/alpha" }] });
		return { harness, current };
	}

	test("labels linked notes with their relation, in order of appearance, and excludes the current note", async () => {
		const { harness, current } = vaultHarness();
		const attachments = await harness.service.buildVaultMentionAttachments([{ kind: "links" }], current, 10000);
		expect(attachments.map((attachment) => attachment.sourcePath)).toEqual(["Out2.md", "Out1.md"]);
		expect(attachments[0]?.kind).toBe("vault_note");
		expect(attachments[0]?.title).toBe("Vault note (linked from current note): Out2.md");
	});

	test("backlinks come from resolvedLinks", async () => {
		const { harness, current } = vaultHarness();
		const attachments = await harness.service.buildVaultMentionAttachments([{ kind: "backlinks" }], current, 10000);
		expect(attachments.map((attachment) => attachment.sourcePath)).toEqual(["Back.md"]);
	});

	test("tags match frontmatter and nested inline tags, newest first", async () => {
		const { harness, current } = vaultHarness();
		const attachments = await harness.service.buildVaultMentionAttachments([{ kind: "tag", tag: "project" }], current, 10000);
		expect(attachments.map((attachment) => attachment.sourcePath)).toEqual(["Tagged.md", "Nested.md"]);
		expect(attachments[1]?.title).toContain("tag #project");
	});

	test("the shared character limit truncates and then leaves later notes unread, and the preview says so", async () => {
		const { harness, current } = vaultHarness();
		const attachments = await harness.service.buildVaultMentionAttachments([{ kind: "recent", count: 5 }], current, 10);
		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.truncated).toBe(true);
		const preview = harness.service.describeLastVaultMentions().join("\n");
		expect(preview).toContain("@recent:5");
		expect(preview).toContain("character limit reached");
	});

	test("a mention that matches nothing fails with a clear message", async () => {
		const { harness, current } = vaultHarness();
		await expect(harness.service.buildVaultMentionAttachments([{ kind: "tag", tag: "nope" }], current, 1000)).rejects.toThrow("#nope");
		await expect(harness.service.buildVaultMentionAttachments([{ kind: "links" }], null, 1000)).rejects.toThrow("needs a note");
	});

	test("without vault mentions nothing is added", async () => {
		const { harness, current } = vaultHarness();
		expect(await harness.service.buildVaultMentionAttachments(undefined, current, 1000)).toEqual([]);
		expect(harness.service.describeLastVaultMentions()).toEqual([]);
	});
});

const PRIVACY = { includeNoteContext: true, includeImageReferences: true };
const NO_OPTIONS = {} as Parameters<InstanceType<typeof ContextService>["buildContextAttachments"]>[1];

function contextFor(file: TFile | null, content = "body"): NoteContext {
	return { content, file, source: "Current note" };
}

function sourcePaths(attachments: { kind: string; sourcePath: string }[]): string[] {
	return attachments.map((attachment) => `${attachment.kind}:${attachment.sourcePath}`);
}

describe("one note is attached once (CTX-01)", () => {
	function dedupeHarness() {
		const harness = createHarness({ folderContextEnabled: false });
		const current = harness.vault.add("Work/Current.md", "current body");
		harness.vault.add("Work/Vendors.md", "vendor notes");
		harness.vault.add("Work/A.md", "note a");
		harness.vault.add("Work/B.md", "note b");
		harness.metadataCache.resolvedLinks = { "Work/Current.md": { "Work/Vendors.md": 1 }, "Work/Vendors.md": {}, "Work/A.md": {}, "Work/B.md": {} };
		harness.metadataCache.caches.set("Work/Current.md", { links: [{ link: "Vendors" }] });
		return { harness, current };
	}

	test("a note named as an additional note, an @links target and a folder file is read once", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			additionalContextPaths: ["Vendors"],
			vaultMentions: [{ kind: "links" }],
			folderContext: { enabled: true, path: "Work", maxFiles: 10, maxCharacters: 10000 }
		}, PRIVACY);
		const paths = sourcePaths(detailed.attachments);
		expect(paths.filter((path) => path.endsWith("Work/Vendors.md"))).toEqual(["additional_note:Work/Vendors.md"]);
		expect(paths).toEqual(["additional_note:Work/Vendors.md", "folder_note:Work/A.md", "folder_note:Work/B.md"]);
		expect(harness.vault.reads.filter((path) => path === "Work/Vendors.md")).toHaveLength(1);
	});

	test("skipped duplicates are reported with the source that already had them", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			additionalContextPaths: ["Vendors"],
			vaultMentions: [{ kind: "links" }],
			folderContext: { enabled: true, path: "Work", maxFiles: 10, maxCharacters: 10000 }
		}, PRIVACY);
		expect(detailed.skipped).toEqual([
			{ source: "folder_note", path: "Work/Vendors.md", reason: "duplicate", detail: "already attached as an additional note" }
		]);
		expect(detailed.resolutions).toHaveLength(1);
		expect(detailed.resolutions[0]?.included).toEqual([]);
		expect(detailed.resolutions[0]?.duplicates).toEqual(["Work/Vendors.md"]);
		expect(describeSkippedContext(detailed.skipped)).toEqual(["skipped   Work/Vendors.md: already attached as an additional note"]);
	});

	test("the current note is never attached again by folder context", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			folderContext: { enabled: true, path: "Work", maxFiles: 10, maxCharacters: 10000 }
		}, PRIVACY);
		expect(sourcePaths(detailed.attachments)).not.toContain("folder_note:Work/Current.md");
	});

	test("duplicates are filtered out of the folder listing before the file limit is applied", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			additionalContextPaths: ["Vendors"],
			folderContext: { enabled: true, path: "Work", maxFiles: 2, maxCharacters: 10000 }
		}, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Work/Vendors.md", "folder_note:Work/A.md", "folder_note:Work/B.md"]);
	});

	test("the same note named twice as an additional note is one attachment", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), { additionalContextPaths: ["Vendors", "Work/Vendors.md"] }, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Work/Vendors.md"]);
		expect(detailed.skipped.map((entry) => entry.reason)).toEqual(["duplicate"]);
	});

	test("@links does not re-attach a note an additional note already carries", async () => {
		const { harness, current } = dedupeHarness();
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			additionalContextPaths: ["Vendors"],
			vaultMentions: [{ kind: "links" }]
		}, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Work/Vendors.md"]);
		expect(detailed.resolutions[0]?.duplicates).toEqual(["Work/Vendors.md"]);
	});

	test("a style guide that is also an additional note is attached once, as the style guide", async () => {
		const { harness, current } = dedupeHarness();
		harness.settings.includeStyleGuideContext = true;
		harness.settings.styleGuideContextPath = "Work/A.md";
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), { additionalContextPaths: ["Work/A.md", "Work/B.md"] }, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Work/B.md", "style_guide:Work/A.md"]);
		expect(detailed.skipped).toEqual([{ source: "additional_note", path: "Work/A.md", reason: "duplicate", detail: "already attached as the style guide" }]);
	});

	test("additional notes that cannot be attached are reported with a reason", async () => {
		const { harness, current } = dedupeHarness();
		harness.vault.add("Pics/cat.png", "");
		const detailed = await harness.service.buildContextAttachmentsDetailed(contextFor(current), {
			additionalContextPaths: ["Pics/cat.png", "Nowhere", "Work/Current.md", "Work/A.md"]
		}, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Work/A.md"]);
		expect(detailed.skipped.map((entry) => [entry.path, entry.reason])).toEqual([
			["Pics/cat.png", "not-markdown"],
			["Nowhere", "not-found"],
			["Work/Current.md", "current-note"]
		]);
	});

	test("buildContextAttachments still returns just the attachments, deduplicated", async () => {
		const { harness, current } = dedupeHarness();
		const attachments = await harness.service.buildContextAttachments(contextFor(current), {
			additionalContextPaths: ["Vendors"],
			vaultMentions: [{ kind: "links" }]
		}, PRIVACY);
		expect(sourcePaths(attachments)).toEqual(["additional_note:Work/Vendors.md"]);
	});
});

describe("detailed builds share no state (CTX review)", () => {
	test("two builds in flight each get their own resolutions", async () => {
		const harness = createHarness({ folderContextEnabled: false });
		const current = harness.vault.add("Current.md", "current");
		harness.vault.add("Out.md", "outgoing");
		harness.vault.add("Back.md", "backlink");
		harness.metadataCache.resolvedLinks = { "Current.md": { "Out.md": 1 }, "Back.md": { "Current.md": 1 }, "Out.md": {} };
		harness.metadataCache.caches.set("Current.md", { links: [{ link: "Out" }] });

		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = harness.vault.read.bind(harness.vault);
		harness.vault.read = async (file) => {
			if (file.path === "Out.md") {
				await gate;
			}
			return await read(file);
		};

		const first = harness.service.buildContextAttachmentsDetailed(contextFor(current), { vaultMentions: [{ kind: "links" }] }, PRIVACY);
		const second = await harness.service.buildContextAttachmentsDetailed(contextFor(current), { vaultMentions: [{ kind: "backlinks" }] }, PRIVACY);
		release();
		const firstResult = await first;

		expect(firstResult.resolutions.map((entry) => entry.label)).toEqual(["@links"]);
		expect(firstResult.resolutions[0]?.included).toEqual(["Out.md"]);
		expect(second.resolutions.map((entry) => entry.label)).toEqual(["@backlinks"]);
		expect(second.resolutions[0]?.included).toEqual(["Back.md"]);
	});

	test("a build without mentions has no resolutions", async () => {
		const harness = createHarness({ folderContextEnabled: false });
		const current = harness.vault.add("Current.md", "current");
		const result = await harness.service.buildContextAttachmentsDetailed(contextFor(current), NO_OPTIONS, PRIVACY);
		expect(result).toEqual({ attachments: [], resolutions: [], skipped: [] });
	});
});

describe("folder context uses the vault, not the disk (CTX-03)", () => {
	function folderHarness() {
		const harness = createHarness();
		harness.vault.adapter.list = () => Promise.reject(new Error("the adapter must not be used"));
		return harness;
	}

	test("a missing folder is a specific error that names the folder", async () => {
		const harness = folderHarness();
		const error = await harness.service.buildFolderContextAttachments({ enabled: true, path: "Typo/Folder", maxFiles: 5, maxCharacters: 1000 }, "").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(FolderNotFoundError);
		expect((error as Error).message).toContain("Typo/Folder");
		expect((error as InstanceType<typeof FolderNotFoundError>).folderPath).toBe("Typo/Folder");
		await expect(harness.service.listMarkdownFilesInFolder("Typo", 3)).rejects.toBeInstanceOf(FolderNotFoundError);
	});

	test("a path that is a note, not a folder, is also reported as missing", async () => {
		const harness = folderHarness();
		harness.vault.add("Note.md", "x");
		await expect(harness.service.listMarkdownFilesInFolder("Note.md", 3)).rejects.toBeInstanceOf(FolderNotFoundError);
	});

	test("a folder written with different capitals is still found, unless that is ambiguous", async () => {
		const harness = folderHarness();
		harness.vault.add("Projects/Q3/Plan.md", "plan");
		expect((await harness.service.listMarkdownFilesInFolder("projects/q3", 3)).map((file) => file.path)).toEqual(["Projects/Q3/Plan.md"]);
		harness.vault.addFolder("Notes");
		harness.vault.addFolder("notes");
		await expect(harness.service.listMarkdownFilesInFolder("NOTES", 3)).rejects.toBeInstanceOf(FolderNotFoundError);
		expect(await harness.service.listMarkdownFilesInFolder("Notes", 3)).toEqual([]);
	});

	test("an existing folder with no notes is empty, not an error", async () => {
		const harness = folderHarness();
		harness.vault.addFolder("Empty");
		expect(await harness.service.listMarkdownFilesInFolder("Empty", 3)).toEqual([]);
		expect(await harness.service.buildFolderContextAttachments({ enabled: true, path: "Empty", maxFiles: 3, maxCharacters: 1000 }, "")).toEqual([]);
	});

	test("a disabled or blank folder setting is ignored without looking anything up", async () => {
		const harness = folderHarness();
		expect(await harness.service.buildFolderContextAttachments({ enabled: false, path: "Typo", maxFiles: 3, maxCharacters: 1000 }, "")).toEqual([]);
		expect(await harness.service.buildFolderContextAttachments({ enabled: true, path: "  ", maxFiles: 3, maxCharacters: 1000 }, "")).toEqual([]);
	});

	test("walks sub-folders in path order, skips hidden folders and non-Markdown files", async () => {
		const harness = folderHarness();
		harness.vault.add("Docs/b.md", "b");
		harness.vault.add("Docs/a.md", "a");
		harness.vault.add("Docs/Sub/c.md", "c");
		harness.vault.add("Docs/.git/hidden.md", "h");
		harness.vault.add("Docs/.obsidian/x.md", "x");
		harness.vault.add("Docs/image.png", "");
		const files = await harness.service.listMarkdownFilesInFolder("Docs", 10);
		expect(files.map((file) => file.path)).toEqual(["Docs/a.md", "Docs/b.md", "Docs/Sub/c.md"]);
		expect((await harness.service.listMarkdownFilesInFolder("Docs", 2)).map((file) => file.path)).toEqual(["Docs/a.md", "Docs/b.md"]);
	});

	test("an unreadable file is an error that names it, not a silently shorter list", async () => {
		const harness = folderHarness();
		harness.vault.add("Docs/a.md", "a");
		harness.vault.contents.delete("Docs/a.md");
		await expect(harness.service.buildFolderContextAttachments({ enabled: true, path: "Docs", maxFiles: 3, maxCharacters: 1000 }, "")).rejects.toThrow("Docs/a.md");
	});
});

describe("Excalidraw notes in a Markdown view (CTX-04)", () => {
	test("the raw compressed drawing is replaced by its text labels", async () => {
		const harness = createHarness();
		const drawing = harness.vault.add("Flow.excalidraw.md", EXCALIDRAW_MD);
		focus(harness, openInView(harness, drawing, EXCALIDRAW_MD));

		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Current note");
		expect(context.content).toContain("[Excalidraw drawing: only its text labels are included");
		expect(context.content).toContain("Login flow");
		expect(context.content).not.toContain("compressed-json");
		expect(context.content).not.toContain("N4IgLgng");
	});

	test("@note on an open drawing does the same", async () => {
		const harness = createHarness();
		const drawing = harness.vault.add("Flow.excalidraw.md", EXCALIDRAW_MD);
		openInView(harness, drawing, EXCALIDRAW_MD);
		const context = await harness.service.getFullNoteContext(drawing);
		expect(context.content).not.toContain("compressed-json");
		expect(context.content).toContain("Login flow");
	});

	test("the sidebar-focus fallback summarises the drawing too", async () => {
		const harness = createHarness();
		const drawing = harness.vault.add("Flow.excalidraw.md", EXCALIDRAW_MD);
		focus(harness, openInView(harness, drawing, EXCALIDRAW_MD));
		focusSidebar(harness);
		const context = await harness.service.getNoteContext();
		expect(context.content).not.toContain("compressed-json");
	});

	test("a text selection inside a drawing is sent as chosen", async () => {
		const harness = createHarness();
		const drawing = harness.vault.add("Flow.excalidraw.md", EXCALIDRAW_MD);
		const view = openInView(harness, drawing, EXCALIDRAW_MD);
		view.editor.select("Login flow");
		focus(harness, view);
		const context = await harness.service.getNoteContext();
		expect(context.source).toBe("Selected text");
		expect(context.content).toBe("Login flow");
	});

	test("a drawing recognised by its frontmatter key counts even without the .excalidraw.md name", async () => {
		const harness = createHarness();
		const drawing = harness.vault.add("Board.md", EXCALIDRAW_MD);
		harness.metadataCache.caches.set("Board.md", { frontmatter: { "excalidraw-plugin": "parsed" } });
		focus(harness, openInView(harness, drawing, EXCALIDRAW_MD));
		const context = await harness.service.getNoteContext();
		expect(context.content).toContain("[Excalidraw drawing");
		expect(isExcalidrawNote(drawing, { "excalidraw-plugin": "parsed" })).toBe(true);
	});

	test("ordinary notes are untouched", () => {
		expect(isExcalidrawNote(new TFile("Plain.md"))).toBe(false);
		expect(isExcalidrawNote(new TFile("Folder/Drawing.EXCALIDRAW.md"))).toBe(true);
		expect(isExcalidrawNote(null)).toBe(false);
	});
});

describe("note-less context (UX-16)", () => {
	test("is refused by default, as before", async () => {
		const harness = createHarness();
		focusSidebar(harness);
		await expect(harness.service.getNoteContext()).rejects.toThrow("Open a Markdown note");
	});

	test("allowNoNote returns an empty No note context when nothing is open", async () => {
		const harness = createHarness();
		focusSidebar(harness);
		const context = await harness.service.getNoteContext(undefined, undefined, { allowNoNote: true });
		expect(context).toEqual({
			content: "",
			file: null,
			source: "No note",
			selectionStartLine: null,
			selectionEndLine: null,
			selectionIdentity: null
		});
		expect(isNoNoteContext(context)).toBe(true);
		expect(isNoNoteContext(contextFor(null))).toBe(false);
	});

	test("allowNoNote still uses the remembered view when the sidebar has focus", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		focus(harness, openInView(harness, note, "live editor text"));
		focusSidebar(harness);
		const context = await harness.service.getNoteContext(undefined, undefined, { allowNoNote: true });
		expect(context.source).toBe("Current note");
		expect(context.content).toBe("live editor text");
		expect(harness.vault.reads).toEqual([]);
	});

	test("allowNoNote still reads the remembered file with cachedRead when no view is left", async () => {
		const harness = createHarness();
		const note = harness.vault.add("A.md", "saved text");
		harness.workspace.leaves.push(leafFor({}, "markdown", note.path));
		harness.service.rememberMarkdownFile(note);
		focusSidebar(harness);
		const context = await harness.service.getNoteContext(undefined, undefined, { allowNoNote: true });
		expect(context.source).toBe("Current note");
		expect(context.content).toBe("saved text");
		expect(harness.vault.reads).toEqual(["A.md"]);
	});

	test("attachments can be built around a No note context", async () => {
		const harness = createHarness({ folderContextEnabled: false });
		harness.vault.add("Extra.md", "extra");
		const detailed = await harness.service.buildContextAttachmentsDetailed(createNoNoteContext(), { additionalContextPaths: ["Extra.md"] }, PRIVACY);
		expect(sourcePaths(detailed.attachments)).toEqual(["additional_note:Extra.md"]);
	});

	test("@links with no note still says it needs one", async () => {
		const harness = createHarness({ folderContextEnabled: false });
		await expect(harness.service.buildContextAttachmentsDetailed(createNoNoteContext(), { vaultMentions: [{ kind: "links" }] }, PRIVACY)).rejects.toThrow("needs a note");
	});
});
