import { Editor, MarkdownView, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import {
	AskMateSettings,
	BuildRequestOptions,
	ChatMessage,
	ContextAttachment,
	ContextAttachmentKind,
	createSelectionIdentity,
	DEFAULT_BATCH_WORKFLOW_MAX_FILES,
	DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS,
	DEFAULT_FOLDER_CONTEXT_MAX_FILES,
	DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS,
	FolderContextOptions,
	formatTokenCount,
	IMAGE_FILE_EXTENSIONS,
	ImageReferenceInfo,
	isImageReferencePath,
	MAX_CONTEXT_IMAGE_PREVIEWS,
	NoteContext,
	NoteHistoryTurn,
	normalizeBoundedInteger,
	normalizeContextPathList,
	noteLookupCandidates,
	RequestPrivacyOptions
} from "../shared/core";
import { parseMarkdownHeadingSections } from "../output";
import {
	describeVaultMentionResolutions,
	resolveVaultMentions,
	type VaultData,
	type VaultMention,
	type VaultMentionResolution
} from "./vaultMentions";

export function cleanFolderPath(folder: string): string {
	const clean = normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
	// Folder templates can include model output, so a "." or ".." segment could otherwise point outside the intended folder.
	if (/\p{Cc}/u.test(clean) || clean.split("/").some((segment) => segment.trim() === "." || segment.trim() === "..")) {
		throw new Error(`AskMate cannot use the folder path "${clean.replace(/\p{Cc}/gu, "?")}" because it contains a "." or ".." segment or a control character.`);
	}
	return clean;
}

export function isSameOrDescendantPath(path: string, parentPath: string): boolean {
	return Boolean(path) && Boolean(parentPath) && (path === parentPath || path.startsWith(`${parentPath}/`));
}

export type TruncatedText = { text: string; truncated: boolean };

/**
 * Cuts text to at most `limit` UTF-16 units. Never splits a surrogate pair, since some provider endpoints reject
 * malformed strings, and prefers a line break in the last fifth of the budget so the model does not see half a line.
 */
export function truncateAtBoundary(text: string, limit: number): TruncatedText {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	let end = Math.max(0, Math.floor(limit));
	const lastUnit = text.charCodeAt(end - 1);
	if (end > 0 && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
		end -= 1;
	}
	const lineBreak = text.lastIndexOf("\n", end - 1);
	if (lineBreak > end * 0.8) {
		end = lineBreak;
	}
	return { text: text.slice(0, end).trimEnd(), truncated: true };
}

/** Tells the model that an attachment is partial, so it does not conclude that the source lacks something. */
export function formatTruncationNotice(shownCharacters: number, totalCharacters: number): string {
	return `[AskMate truncated this attachment: showing ${shownCharacters} of ${totalCharacters} characters. Details beyond this point were not sent, so do not treat them as absent from the source.]`;
}

function withTruncationNotice(text: string, limit: number): TruncatedText & { shownCharacters: number } {
	const cut = truncateAtBoundary(text, limit);
	return {
		text: cut.truncated ? `${cut.text}\n\n${formatTruncationNotice(cut.text.length, text.length)}` : cut.text,
		truncated: cut.truncated,
		shownCharacters: cut.text.length
	};
}

const EXCALIDRAW_SECTION_END = /^(#{1,2}\s+(Excalidraw Data|Text Elements|Element Links|Embedded Files|Drawing)\s*|%%)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function decodeJsonString(value: string): string {
	try {
		const decoded: unknown = JSON.parse(`"${value}"`);
		return typeof decoded === "string" ? decoded : value;
	} catch {
		// A malformed escape sequence still leaves readable text, so keep the raw value.
		return value;
	}
}

function parseExcalidrawJsonTexts(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		const elements = isRecord(parsed) && Array.isArray(parsed.elements) ? parsed.elements : [];
		return elements.flatMap((element: unknown) => (
			isRecord(element) && element.type === "text" && typeof element.text === "string" ? [element.text] : []
		));
	} catch {
		// Partial or damaged JSON: scan for string values, honouring escaped quotes.
		return Array.from(json.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g), (match) => decodeJsonString(match[1] ?? ""));
	}
}

/** Labels from the "## Text Elements" section of an .excalidraw.md file, where each element ends with a " ^blockId" marker. */
export function parseExcalidrawTextElements(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => /^#{1,2}\s+Text Elements\s*$/.test(line));
	if (start < 0) {
		return [];
	}

	const texts: string[] = [];
	let pending: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (EXCALIDRAW_SECTION_END.test(line.trim())) {
			break;
		}
		const withoutComments = line.replace(/%%.*?%%/g, "");
		const marker = withoutComments.match(/^(.*?)(?:^|\s+)\^[A-Za-z0-9_-]+\s*$/);
		if (marker) {
			texts.push([...pending, marker[1] ?? ""].join(" "));
			pending = [];
		} else if (withoutComments.trim()) {
			pending.push(withoutComments);
		}
	}
	return pending.length > 0 ? [...texts, pending.join(" ")] : texts;
}

export function describeExcalidrawForContext(raw: string, path: string): string {
	const texts = extractExcalidrawTexts(raw, path);
	return texts.length > 0
		? ["[Excalidraw drawing: only its text labels are included, not the drawing itself.]", ...texts].join("\n")
		: "[Excalidraw drawing with no text labels. The drawing itself cannot be included.]";
}

/**
 * Readable text from an Excalidraw drawing. In .excalidraw.md files the labels live in the plain "## Text Elements"
 * section. The "## Drawing" block is LZ-String "compressed-json" by default, which cannot be decoded without adding a
 * dependency, so only an uncompressed ```json block is parsed. Plain .excalidraw and .excalidraw.json files are JSON.
 */
export function extractExcalidrawTexts(raw: string, path: string): string[] {
	if (!path.toLowerCase().endsWith(".md")) {
		return parseExcalidrawJsonTexts(raw);
	}
	const jsonBlock = raw.match(/```json\r?\n([\s\S]*?)\r?\n```/)?.[1];
	return [...parseExcalidrawTextElements(raw), ...(jsonBlock ? parseExcalidrawJsonTexts(jsonBlock) : [])];
}

/** Defers the heading parse, which walks the whole note, until something reads `activeHeadingPath`. */
function withLazyHeadingPath(context: NoteContext, compute: () => string | null): NoteContext {
	let headingPath: string | null | undefined;
	return Object.defineProperty(context, "activeHeadingPath", {
		configurable: true,
		enumerable: true,
		get: (): string | null => {
			if (headingPath === undefined) {
				headingPath = compute();
			}
			return headingPath;
		},
		set: (value: string | null | undefined): void => {
			headingPath = value ?? null;
		}
	});
}

/** Returns the path after a rename of `oldPath` to `newPath`, or null when the rename does not affect `path`. */
export function remapRenamedPath(path: string, oldPath: string, newPath: string): string | null {
	if (!isSameOrDescendantPath(path, oldPath)) {
		return null;
	}
	return `${newPath}${path.slice(oldPath.length)}`;
}

/** A folder named in settings, a mention or a batch run that is not in the vault. */
export class FolderNotFoundError extends Error {
	constructor(readonly folderPath: string) {
		super(`AskMate cannot find the folder "${folderPath}" in this vault. Check the folder path, or clear it in AskMate settings.`);
		this.name = "FolderNotFoundError";
	}
}

/**
 * True for an Excalidraw drawing: by name (.excalidraw.md) or, when the metadata is known, by the `excalidraw-plugin`
 * frontmatter key the Excalidraw plugin writes. Such a note is mostly compressed drawing data, which is no use to a model.
 */
export function isExcalidrawNote(file: { path: string } | null | undefined, frontmatter?: Record<string, unknown> | null): boolean {
	if (!file) {
		return false;
	}
	const path = file.path.toLowerCase();
	return path.endsWith(".excalidraw.md") || (path.endsWith(".md") && Boolean(frontmatter) && "excalidraw-plugin" in (frontmatter ?? {}));
}

/** Source label of a request made with no note open. WP-09 widens `ContextSource`; until then it lives on this type. */
export const NO_NOTE_SOURCE = "No note";

export interface NoNoteContext extends Omit<NoteContext, "source" | "file" | "content"> {
	source: typeof NO_NOTE_SOURCE;
	file: null;
	content: "";
}

export function createNoNoteContext(): NoNoteContext {
	return { content: "", file: null, source: NO_NOTE_SOURCE, selectionStartLine: null, selectionEndLine: null, selectionIdentity: null };
}

export function isNoNoteContext(context: NoteContext | NoNoteContext): context is NoNoteContext {
	return context.source === NO_NOTE_SOURCE;
}

export type ContextSkipReason = "duplicate" | "current-note" | "not-markdown" | "not-found" | "over-budget";

/** A note that a context source asked for but that was not attached, with the reason, for /context and the request preview. */
export interface SkippedContext {
	source: "additional_note" | "vault_note" | "folder_note";
	path: string;
	reason: ContextSkipReason;
	detail: string;
}

export interface DetailedContextAttachments {
	attachments: ContextAttachment[];
	/** What each vault mention selected. Returned, not stored, so concurrent builds cannot mix them up. */
	resolutions: VaultMentionResolution[];
	skipped: SkippedContext[];
}

/** Plain-text lines for the /context preview. */
export function describeSkippedContext(skipped: readonly SkippedContext[]): string[] {
	return skipped.map((entry) => `skipped   ${entry.path}: ${entry.detail}`);
}

const SKIP_DETAILS: Record<Exclude<ContextSkipReason, "duplicate">, string> = {
	"current-note": "this is the current note, which is always sent",
	"not-markdown": "not a Markdown note",
	"not-found": "no note with that name",
	"over-budget": "the character limit was reached before it was read"
};

const CURRENT_NOTE_LABEL = "the current note";

/**
 * Which note each source has attached so far, for one build of the context. Seeded with the current note, which is
 * always sent, so no source attaches it again. A new ledger per build keeps concurrent builds apart.
 */
class AttachmentLedger {
	readonly attached = new Map<string, string>();
	readonly skipped: SkippedContext[] = [];

	constructor(currentPath: string) {
		if (currentPath) {
			this.attached.set(currentPath, CURRENT_NOTE_LABEL);
		}
	}

	claim(path: string, label: string): void {
		this.attached.set(path, label);
	}

	/** Records a duplicate and returns true when `path` was already attached; the current note is skipped silently. */
	skipIfAttached(source: SkippedContext["source"], path: string, reportCurrent: boolean): boolean {
		const label = this.attached.get(path);
		if (label === undefined) {
			return false;
		}
		if (label !== CURRENT_NOTE_LABEL) {
			this.skipped.push({ source, path, reason: "duplicate", detail: `already attached as ${label}` });
		} else if (reportCurrent) {
			this.skipped.push({ source, path, reason: "current-note", detail: SKIP_DETAILS["current-note"] });
		}
		return true;
	}

	skip(source: SkippedContext["source"], path: string, reason: Exclude<ContextSkipReason, "duplicate">): void {
		this.skipped.push({ source, path, reason, detail: SKIP_DETAILS[reason] });
	}
}

/** What a context build needs from the note: the file and its text. A No note context has neither. */
export type AttachmentContext = Pick<NoteContext, "content" | "file"> & { source: string };

export type ContextServiceHost = {
	app: App;
	getSettings: () => AskMateSettings;
	getNoteHistoryForPath: (path: string) => NoteHistoryTurn[];
};

export class ContextService {
	private lastMarkdownView: MarkdownView | null = null;
	private lastMarkdownFile: TFile | null = null;
	private lastNoteContext: NoteContext | null = null;
	// Kept for describeLastVaultMentions only. Builds return their own resolutions and never read this.
	private lastVaultMentionResolutions: VaultMentionResolution[] = [];
	// A .md file can open in a non-Markdown view (Excalidraw, Kanban), which updates only the remembered file.
	// These stamps record which of the view and the file was remembered last.
	private rememberSequence = 0;
	private viewRememberedAt = 0;
	private fileRememberedAt = 0;

	constructor(private readonly host: ContextServiceHost) {}

	getLastMarkdownFile(): TFile | null {
		return this.lastMarkdownFile;
	}

	rememberActiveMarkdownContext(): void {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		this.rememberMarkdownFile(this.host.app.workspace.getActiveFile());

		if (!activeView) {
			return;
		}

		this.rememberView(activeView);
		this.rememberEditorContext(activeView.editor, activeView.file ?? null);
	}

	private rememberView(view: MarkdownView): void {
		this.lastMarkdownView = view;
		this.rememberSequence += 1;
		this.viewRememberedAt = this.rememberSequence;
		if (view.file?.extension === "md") {
			this.lastMarkdownFile = view.file;
			this.fileRememberedAt = this.rememberSequence;
		}
	}

	async getNoteContext(editor?: Editor, file?: TFile | null): Promise<NoteContext>;
	/** With `allowNoNote`, an empty workspace gives a No note context instead of an error. */
	async getNoteContext(editor: Editor | undefined, file: TFile | null | undefined, options: { allowNoNote: true }): Promise<NoteContext | NoNoteContext>;
	async getNoteContext(editor?: Editor, file?: TFile | null, options: { allowNoNote?: boolean } = {}): Promise<NoteContext | NoNoteContext> {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);

		if (editor) {
			const context = this.tryCreateNoteContext(editor, file ?? activeView?.file ?? null, this.findViewForEditor(editor));

			if (context) {
				this.rememberEditorContext(editor, context.file);
				return context;
			}

			this.lastNoteContext = null;
		}

		if (activeView) {
			const context = this.tryCreateNoteContext(activeView.editor, activeView.file ?? null, activeView);
			this.rememberView(activeView);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const lastOpenView = this.getLastOpenMarkdownView();
		const rememberedFile = this.getRememberedOpenFile();
		const rememberedFileIsNewer = rememberedFile !== null
			&& this.fileRememberedAt > this.viewRememberedAt
			&& rememberedFile.path !== lastOpenView?.file?.path;
		const view = rememberedFileIsNewer ? null : lastOpenView;
		const targetFile = file ?? view?.file ?? rememberedFile;
		const snapshot = this.lastNoteContext;

		if (
			snapshot?.source === "Selected text"
			&& snapshot.file
			&& snapshot.file.path === targetFile?.path
			&& view?.getMode() !== "preview"
			// Clearing a selection fires no event, so the snapshot can outlive it; the attached editor is the live truth.
			&& (!view || view.editor.getSelection().trim() === snapshot.content)
		) {
			return snapshot;
		}

		if (snapshot?.file && !this.isFileOpen(snapshot.file)) {
			this.lastNoteContext = null;
		}

		if (view) {
			const context = this.tryCreateNoteContext(view.editor, view.file ?? null, view);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const fileContext = await this.tryCreateFileContext(targetFile);

		if (fileContext) {
			this.lastNoteContext = fileContext;
			return fileContext;
		}

		if (options.allowNoNote) {
			this.lastNoteContext = null;
			return createNoNoteContext();
		}

		throw new Error("Open a Markdown note or select text before using AskMate.");
	}

	rememberEditorContext(editor: Editor, file: TFile | null): void {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);

		if (activeView?.editor === editor) {
			this.rememberView(activeView);
		}

		this.rememberMarkdownFile(file);
		// This runs on every keystroke. Only a selection needs a snapshot; the full note is read live when a request is built.
		this.lastNoteContext = editor.somethingSelected()
			? this.tryCreateNoteContext(editor, file, this.findViewForEditor(editor))
			: null;
	}

	private findViewForEditor(editor: Editor): MarkdownView | null {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.editor === editor) {
			return activeView;
		}
		return this.lastMarkdownView?.editor === editor ? this.lastMarkdownView : null;
	}

	rememberMarkdownFile(file: TFile | null): void {
		if (file?.extension === "md") {
			this.lastMarkdownFile = file;
			this.rememberSequence += 1;
			this.fileRememberedAt = this.rememberSequence;
		}
	}

	/** The remembered file, or null (and forgotten) once it is deleted, renamed away from .md, or closed in every tab. */
	private getRememberedOpenFile(): TFile | null {
		const remembered = this.lastMarkdownFile;
		if (!remembered) {
			return null;
		}

		const current = this.host.app.vault.getAbstractFileByPath(remembered.path);
		if (!(current instanceof TFile) || current.extension !== "md" || !this.isFileOpen(current)) {
			this.lastMarkdownFile = null;
			return null;
		}

		this.lastMarkdownFile = current;
		return current;
	}

	private isFileOpen(file: TFile): boolean {
		let open = false;
		// The view state also covers deferred (not yet loaded) tabs, whose view is not a MarkdownView yet.
		this.host.app.workspace.iterateAllLeaves((leaf) => {
			if (!open && (leaf.getViewState().state?.file === file.path || (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path))) {
				open = true;
			}
		});
		return open;
	}

	handleFileRenamed(file: TAbstractFile, oldPath: string): void {
		// Obsidian updates TFile paths in place before this event, so match on the old path, the new path and the object itself.
		const isAffected = (candidate: TFile | null | undefined): boolean => Boolean(candidate) && (
			candidate === file
			|| remapRenamedPath(candidate?.path ?? "", oldPath, file.path) !== null
			|| isSameOrDescendantPath(candidate?.path ?? "", file.path)
		);
		const refresh = (candidate: TFile): TFile | null => {
			const currentPath = remapRenamedPath(candidate.path, oldPath, file.path) ?? candidate.path;
			const resolved = this.host.app.vault.getAbstractFileByPath(currentPath);
			return resolved instanceof TFile && resolved.extension === "md" ? resolved : null;
		};

		if (this.lastMarkdownFile && isAffected(this.lastMarkdownFile)) {
			this.lastMarkdownFile = refresh(this.lastMarkdownFile);
		}

		const snapshot = this.lastNoteContext;
		const snapshotPath = snapshot?.selectionIdentity?.sourcePath ?? "";
		if (snapshot && (isAffected(snapshot.file) || remapRenamedPath(snapshotPath, oldPath, file.path) !== null)) {
			const refreshed = snapshot.file ? refresh(snapshot.file) : null;
			this.lastNoteContext = refreshed
				? {
					...snapshot,
					file: refreshed,
					selectionIdentity: snapshot.selectionIdentity
						? { ...snapshot.selectionIdentity, sourcePath: refreshed.path }
						: snapshot.selectionIdentity
				}
				: null;
		}
	}

	handleFileDeleted(file: TAbstractFile): void {
		const isAffected = (candidate: TFile | null | undefined): boolean => Boolean(candidate) && (
			candidate === file || isSameOrDescendantPath(candidate?.path ?? "", file.path)
		);

		if (isAffected(this.lastMarkdownFile)) {
			this.lastMarkdownFile = null;
		}

		const snapshot = this.lastNoteContext;
		if (snapshot && (isAffected(snapshot.file) || isSameOrDescendantPath(snapshot.selectionIdentity?.sourcePath ?? "", file.path))) {
			this.lastNoteContext = null;
		}

		if (isAffected(this.lastMarkdownView?.file)) {
			this.lastMarkdownView = null;
		}
	}

	tryCreateNoteContext(editor: Editor | undefined, file: TFile | null, view: MarkdownView | null = null, ignoreSelection = false): NoteContext | null {
		// In reading mode the user's highlight is a DOM selection the editor cannot see, while the editor may still hold
		// an old, invisible selection from editing mode. Use the full note instead.
		const rawSelection = ignoreSelection || view?.getMode() === "preview" ? "" : editor?.getSelection() ?? "";
		const selectedText = rawSelection.trim();

		if (selectedText.length > 0) {
			const fullValue = editor?.getValue() ?? "";
			const from = editor?.getCursor("from");
			const to = editor?.getCursor("to");
			const startOffset = from && editor ? editor.posToOffset(from) : 0;
			const endOffset = to && editor ? editor.posToOffset(to) : startOffset + rawSelection.length;
			const cursorLine = editor?.getCursor().line;
			return withLazyHeadingPath({
				content: selectedText,
				file,
				source: "Selected text",
				selectionStartLine: from ? from.line + 1 : null,
				selectionEndLine: to ? to.line + 1 : null,
				selectionIdentity: createSelectionIdentity(rawSelection, startOffset, endOffset, file?.path ?? "", fullValue)
			}, () => cursorLine === undefined ? null : this.getActiveHeadingPath(fullValue, cursorLine));
		}

		if (!editor) {
			return null;
		}

		const value = editor.getValue();
		const fullNote = value.trim();

		if (fullNote.length > 0 || file?.extension === "md") {
			const cursorLine = editor.getCursor().line;
			return withLazyHeadingPath({
				// A drawing opened as Markdown is mostly compressed data; send its text labels instead.
				content: file && this.isExcalidrawFile(file) ? describeExcalidrawForContext(fullNote, file.path) : fullNote,
				file,
				source: "Current note",
				selectionStartLine: null,
				selectionEndLine: null,
				selectionIdentity: null
			}, () => this.getActiveHeadingPath(value, cursorLine));
		}

		return null;
	}

	async tryCreateFileContext(file: TFile | null | undefined): Promise<NoteContext | null> {
		if (!file || file.extension !== "md") {
			return null;
		}

		return await this.getFileNoteContext(file);
	}

	/** The whole note, ignoring any selection. The open editor's text wins over the saved file, which can lag behind it. */
	async getFullNoteContext(file: TFile): Promise<NoteContext> {
		const view = this.getOpenMarkdownViewForFile(file);
		const context = view ? this.tryCreateNoteContext(view.editor, file, view, true) : null;
		return context ?? await this.getFileNoteContext(file);
	}

	async getFileNoteContext(file: TFile): Promise<NoteContext> {
		const raw = (await this.host.app.vault.cachedRead(file)).trim();
		// An Excalidraw file is mostly compressed drawing data; only its text labels are useful to the model.
		const content = this.isExcalidrawFile(file) ? describeExcalidrawForContext(raw, file.path) : raw;
		return {
			content,
			file,
			source: "Current note",
			selectionStartLine: null,
			selectionEndLine: null,
			selectionIdentity: null
		};
	}

	private isExcalidrawFile(file: TFile): boolean {
		return isExcalidrawNote(file, this.host.app.metadataCache.getFileCache(file)?.frontmatter);
	}

	getLastOpenMarkdownView(): MarkdownView | null {
		if (!this.lastMarkdownView) {
			return null;
		}

		const isStillOpen = this.host.app.workspace
			.getLeavesOfType("markdown")
			.some((leaf) => leaf.view === this.lastMarkdownView);

		if (!isStillOpen) {
			this.lastMarkdownView = null;
			this.lastNoteContext = null;
			return null;
		}

		return this.lastMarkdownView;
	}

	getOpenMarkdownViewForFile(file: TFile | null | undefined): MarkdownView | null {
		if (!file) {
			return null;
		}

		for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
				return leaf.view;
			}
		}

		return null;
	}

	getActiveHeadingPath(markdown: string, cursorLine: number): string | null {
		const sections = parseMarkdownHeadingSections(markdown);
		const active = sections
			.filter((section) => section.headingLine <= cursorLine)
			.sort((a, b) => b.headingLine - a.headingLine)[0];
		return active?.path ?? null;
	}

	/** The attachments only. The detailed variant also returns what was skipped and what each mention selected. */
	async buildContextAttachments(
		context: AttachmentContext,
		options: BuildRequestOptions,
		privacy: RequestPrivacyOptions
	): Promise<ContextAttachment[]> {
		const result = await this.buildContextAttachmentsDetailed(context, options, privacy);
		// One assignment of a finished array, so builds that overlap cannot leave a mixture; /context reads it for old callers.
		this.lastVaultMentionResolutions = result.resolutions;
		return result.attachments;
	}

	/**
	 * Builds every attachment for a request and reports what it left out. A note is attached once, under the first source
	 * that names it: style guide and glossary, then additional notes, vault mentions, folder context. The current note is
	 * never attached again. Nothing here is stored on the service, so concurrent builds are independent.
	 */
	async buildContextAttachmentsDetailed(
		context: AttachmentContext,
		options: BuildRequestOptions,
		privacy: RequestPrivacyOptions
	): Promise<DetailedContextAttachments> {
		const settings = this.host.getSettings();
		const sourcePath = context.file?.path ?? "";
		const ledger = new AttachmentLedger(sourcePath);
		const attachments: ContextAttachment[] = [];

		if (options.includeThreadHistory && options.threadMessages?.length) {
			const thread = this.buildThreadHistoryAttachment(options.threadMessages, settings.threadedChatMaxTurns);
			if (thread) {
				attachments.push(thread);
			}
		}

		const noteHistory = this.buildNoteHistoryAttachment(sourcePath);
		if (noteHistory) {
			attachments.push(noteHistory);
		}

		// A role file that is also named as an ordinary source is attached as the role, so reserve it before they look.
		const roleSources = [
			{ kind: "style_guide" as const, enabled: settings.includeStyleGuideContext, path: settings.styleGuideContextPath, maxCharacters: settings.styleGuideMaxCharacters, label: "the style guide" },
			{ kind: "glossary" as const, enabled: settings.includeGlossaryContext, path: settings.glossaryContextPath, maxCharacters: settings.glossaryMaxCharacters, label: "the glossary" }
		].filter((role) => role.enabled);
		for (const role of roleSources) {
			const file = this.resolveMarkdownPath(role.path, sourcePath);
			if (file && !ledger.attached.has(file.path)) {
				ledger.claim(file.path, role.label);
			}
		}

		const additionalPaths = options.additionalContextPaths ?? settings.additionalContextPaths;
		attachments.push(...await this.buildAdditionalNoteAttachments(
			additionalPaths,
			sourcePath,
			settings.additionalContextMaxCharacters,
			ledger
		));

		const mentions = await this.collectVaultMentions(
			options.vaultMentions,
			context.file,
			settings.additionalContextMaxCharacters,
			ledger
		);
		attachments.push(...mentions.attachments);

		const folderContext = options.folderContext ?? {
			enabled: settings.folderContextEnabled,
			path: settings.folderContextPath,
			maxFiles: settings.folderContextMaxFiles,
			maxCharacters: settings.folderContextMaxCharacters
		};
		attachments.push(...await this.buildFolderContextAttachments(folderContext, sourcePath, ledger));

		for (const role of roleSources) {
			const attachment = await this.buildRoleContextAttachment(role.kind, role.path, sourcePath, role.maxCharacters);
			if (attachment) {
				attachments.push(attachment);
			}
		}

		if (settings.includeExcalidrawSummaries) {
			attachments.push(...await this.buildExcalidrawSummaryAttachments(context, privacy));
		}

		if (privacy.includeImageReferences && settings.includeImageManifests) {
			attachments.push(...this.buildImageManifestAttachments(context));
		}

		return { attachments, resolutions: mentions.resolutions, skipped: ledger.skipped };
	}

	buildThreadHistoryAttachment(messages: ChatMessage[], maxTurns: number): ContextAttachment | null {
		const maxMessages = Math.max(2, maxTurns * 2);
		const history = messages
			.filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
			.slice(-maxMessages);

		if (history.length === 0) {
			return null;
		}

		const content = [
			"Chat history included by AskMate threaded mode.",
			"Use this only to clarify follow-up requests. Keep factual claims grounded in the note and attached context.",
			"",
			...history.map((message) => `${message.role === "user" ? "User" : "AskMate"}: ${message.text.trim()}`)
		].join("\n");
		return this.createContextAttachment("thread_history", "Threaded chat history", "AskMate chat", content, content.length);
	}

	buildNoteHistoryAttachment(sourcePath: string): ContextAttachment | null {
		const settings = this.host.getSettings();
		if (!settings.noteHistoryEnabled || !settings.noteHistoryIncludeInContext || !sourcePath) {
			return null;
		}
		const turns = this.host.getNoteHistoryForPath(sourcePath).slice(-settings.noteHistoryMaxTurnsPerNote);
		if (turns.length === 0) {
			return null;
		}
		const content = [
			"Prior AskMate history for this same note. Use it as conversation memory, not as primary factual evidence.",
			"",
			...turns.map((turn) => [`User: ${turn.question}`, `AskMate: ${turn.answer}`].join("\n"))
		].join("\n\n");
		return this.createContextAttachment("note_history", "AskMate note history", sourcePath, content, content.length);
	}

	async buildRoleContextAttachment(
		kind: "style_guide" | "glossary",
		path: string,
		sourcePath: string,
		maxCharacters: number
	): Promise<ContextAttachment | null> {
		const file = this.resolveMarkdownPath(path, sourcePath);
		if (!file) {
			return null;
		}
		const raw = (await this.host.app.vault.cachedRead(file)).trim();
		if (!raw) {
			return null;
		}
		const limit = normalizeBoundedInteger(maxCharacters, DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS, 1000, 100000);
		const role = kind === "style_guide" ? "Style guide" : "Glossary";
		const guidance = kind === "style_guide"
			? "Use this attachment for tone, formatting, naming, and writing conventions."
			: "Use this attachment for domain terms, aliases, acronyms, and definitions.";
		const body = withTruncationNotice(raw, limit);
		const content = [`${role} role context. ${guidance}`, "", body.text].join("\n");
		return this.createContextAttachment(kind, `${role}: ${file.path}`, file.path, content, raw.length, body.truncated);
	}

	createContextAttachment(
		kind: ContextAttachmentKind,
		title: string,
		sourcePath: string,
		content: string,
		originalCharacters = content.length,
		truncated?: boolean
	): ContextAttachment {
		const normalized = content.trim();
		return {
			kind,
			title,
			sourcePath,
			content: normalized,
			originalCharacters,
			finalCharacters: normalized.length,
			// Explicit when known, because a truncation notice or header can make the content longer than the source.
			truncated: truncated ?? normalized.length < originalCharacters
		};
	}

	async buildAdditionalNoteAttachments(
		paths: string[],
		sourcePath: string,
		maxCharacters: number,
		ledger: AttachmentLedger = new AttachmentLedger(sourcePath)
	): Promise<ContextAttachment[]> {
		const attachments: ContextAttachment[] = [];
		let remaining = maxCharacters;

		for (const path of normalizeContextPathList(paths)) {
			const target = this.classifyMarkdownPath(path, sourcePath);
			if (target.kind === "skip") {
				ledger.skip("additional_note", path, target.reason);
				continue;
			}
			const file = target.file;
			if (ledger.skipIfAttached("additional_note", file.path, true)) {
				continue;
			}
			if (remaining <= 0) {
				ledger.skip("additional_note", file.path, "over-budget");
				continue;
			}

			const raw = (await this.host.app.vault.cachedRead(file)).trim();
			const content = withTruncationNotice(raw, remaining);
			remaining = content.truncated ? 0 : remaining - content.shownCharacters;
			ledger.claim(file.path, "an additional note");
			attachments.push(this.createContextAttachment(
				"additional_note",
				`Additional note: ${file.path}`,
				file.path,
				content.text,
				raw.length,
				content.truncated
			));
		}

		return attachments;
	}

	/** Preview lines for the notes the last request pulled in through @links, @backlinks, @tag and @recent. */
	describeLastVaultMentions(): string[] {
		return describeVaultMentionResolutions(this.lastVaultMentionResolutions);
	}

	/** Reads the metadata cache into plain data. The current note is the captured source, not necessarily the active view. */
	collectVaultData(file: TFile | null, includeTags: boolean): VaultData {
		const { metadataCache, vault } = this.host.app;
		const cache = file ? metadataCache.getFileCache(file) : null;
		const orderedLinkTargets = !file ? [] : (cache?.links ?? []).flatMap((link) => {
			const linkpath = link.link.split(/[#|^]/)[0].trim();
			const target = linkpath ? metadataCache.getFirstLinkpathDest(linkpath, file.path) : null;
			return target ? [target.path] : [];
		});
		// The repository guard forbids vault-wide file enumeration. resolvedLinks has one key per indexed Markdown note, so the
		// keys give the candidate paths from metadata alone; only the few notes that are selected are ever read.
		const notes = Object.keys(metadataCache.resolvedLinks).flatMap((path) => {
			const note = vault.getAbstractFileByPath(path);
			if (!(note instanceof TFile) || note.extension !== "md") {
				return [];
			}
			const noteCache = includeTags ? metadataCache.getFileCache(note) : null;
			return [{ path, mtime: note.stat.mtime, tags: (noteCache && getAllTags(noteCache)) || [] }];
		});
		return { resolvedLinks: metadataCache.resolvedLinks, orderedLinkTargets, notes };
	}

	/**
	 * The attachments for vault mentions. Remembers the resolutions for describeLastVaultMentions; code that needs them
	 * per request should call buildContextAttachmentsDetailed, which returns them instead.
	 */
	async buildVaultMentionAttachments(
		mentions: VaultMention[] | undefined,
		file: TFile | null,
		maxCharacters: number
	): Promise<ContextAttachment[]> {
		const result = await this.collectVaultMentions(mentions, file, maxCharacters, new AttachmentLedger(file?.path ?? ""));
		this.lastVaultMentionResolutions = result.resolutions;
		return result.attachments;
	}

	private async collectVaultMentions(
		mentions: VaultMention[] | undefined,
		file: TFile | null,
		maxCharacters: number,
		ledger: AttachmentLedger
	): Promise<{ attachments: ContextAttachment[]; resolutions: VaultMentionResolution[] }> {
		if (!mentions?.length) {
			return { attachments: [], resolutions: [] };
		}

		const data = this.collectVaultData(file, mentions.some((mention) => mention.kind === "tag"));
		const selected = resolveVaultMentions(mentions, file?.path ?? null, data, undefined, new Set(ledger.attached.keys()));
		const attachments: ContextAttachment[] = [];
		const resolutions: VaultMentionResolution[] = [];
		let remaining = maxCharacters;

		for (const resolution of selected) {
			const unread: string[] = [];
			const read: string[] = [];
			for (const path of resolution.included) {
				const note = this.host.app.vault.getAbstractFileByPath(path);
				if (!(note instanceof TFile)) {
					continue;
				}
				if (remaining <= 0) {
					unread.push(path);
					continue;
				}
				const raw = (await this.host.app.vault.cachedRead(note)).trim();
				const content = withTruncationNotice(raw, remaining);
				remaining = content.truncated ? 0 : remaining - content.shownCharacters;
				read.push(path);
				ledger.claim(path, "a mentioned note");
				attachments.push(this.createContextAttachment(
					"vault_note",
					`Vault note (${resolution.relation}): ${path}`,
					path,
					content.text,
					raw.length,
					content.truncated
				));
			}
			resolutions.push({ ...resolution, included: read, overBudget: unread });
		}

		return { attachments, resolutions };
	}

	async buildFolderContextAttachments(
		options: FolderContextOptions,
		excludePath: string,
		ledger: AttachmentLedger = new AttachmentLedger(excludePath)
	): Promise<ContextAttachment[]> {
		if (!options.enabled || !options.path.trim()) {
			return [];
		}

		const folder = cleanFolderPath(options.path);
		if (!folder) {
			return [];
		}

		const maxFiles = normalizeBoundedInteger(options.maxFiles, DEFAULT_FOLDER_CONTEXT_MAX_FILES, 1, 100);
		let remaining = normalizeBoundedInteger(options.maxCharacters, DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS, 1000, 200000);
		const attachments: ContextAttachment[] = [];
		const files = await this.listMarkdownFilesInFolder(folder, maxFiles, excludePath, ledger.attached, (path, takenBy) => {
			ledger.skipped.push({ source: "folder_note", path, reason: "duplicate", detail: `already attached as ${takenBy}` });
		});

		for (const file of files) {
			if (attachments.length >= maxFiles || remaining <= 0) {
				break;
			}

			const raw = (await this.host.app.vault.cachedRead(file)).trim();
			const content = withTruncationNotice(raw, remaining);
			remaining = content.truncated ? 0 : remaining - content.shownCharacters;
			ledger.claim(file.path, "a folder note");
			attachments.push(this.createContextAttachment(
				"folder_note",
				`Folder note ${attachments.length + 1}: ${file.path}`,
				file.path,
				content.text,
				raw.length,
				content.truncated
			));
		}

		return attachments;
	}

	/** The Markdown note a path or link text names, or null. */
	resolveMarkdownPath(path: string, sourcePath: string): TFile | null {
		const target = this.classifyMarkdownPath(path, sourcePath);
		return target.kind === "file" ? target.file : null;
	}

	/** Like resolveMarkdownPath, but says why nothing matched: not a Markdown file, or no file at all. */
	private classifyMarkdownPath(path: string, sourcePath: string): { kind: "file"; file: TFile } | { kind: "skip"; reason: "not-markdown" | "not-found" } {
		const cleanPath = normalizeContextPathList([path])[0] ?? "";
		if (!cleanPath) {
			return { kind: "skip", reason: "not-found" };
		}

		// The path as stored comes first so a real file name such as "C# notes.md" wins; the version without a heading,
		// block or alias tail is the fallback for a typed "Other.md#^block". A Markdown match on any candidate beats a
		// non-Markdown one on an earlier candidate.
		let foundNonMarkdown = false;
		for (const candidate of noteLookupCandidates(cleanPath)) {
			const direct = this.host.app.vault.getAbstractFileByPath(candidate);
			if (direct instanceof TFile && direct.extension === "md") {
				return { kind: "file", file: direct };
			}

			const linked = this.host.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
			if (linked?.extension === "md") {
				return { kind: "file", file: linked };
			}
			foundNonMarkdown ||= direct instanceof TFile || Boolean(linked);
		}
		return { kind: "skip", reason: foundNonMarkdown ? "not-markdown" : "not-found" };
	}

	async buildExcalidrawSummaryAttachments(
		context: AttachmentContext,
		privacy: Pick<RequestPrivacyOptions, "includeImageReferences">
	): Promise<ContextAttachment[]> {
		const sourcePath = context.file?.path ?? "";
		const files = new Map<string, TFile>();

		if (context.file && this.isExcalidrawPath(context.file.path)) {
			files.set(context.file.path, context.file);
		}

		for (const reference of this.extractLinkedReferences(context.content)) {
			const file = this.host.app.metadataCache.getFirstLinkpathDest(reference, sourcePath);
			if (file instanceof TFile && this.isExcalidrawPath(file.path)) {
				files.set(file.path, file);
			}
		}

		const attachments: ContextAttachment[] = [];
		for (const file of files.values()) {
			const raw = await this.host.app.vault.cachedRead(file);
			const summary = this.extractExcalidrawSummary(raw, file.path, privacy.includeImageReferences);
			if (!summary.text.trim()) {
				continue;
			}
			attachments.push(this.createContextAttachment(
				"excalidraw_summary",
				`Excalidraw summary: ${file.path}`,
				file.path,
				summary.text,
				raw.length,
				summary.truncated
			));
		}

		return attachments;
	}

	extractExcalidrawSummary(raw: string, sourcePath: string, includeImageReferences = true): TruncatedText {
		const lines = new Set<string>();
		const addLine = (value: unknown): void => {
			if (typeof value !== "string") {
				return;
			}
			const clean = value.replace(/\s+/g, " ").trim();
			if (clean) {
				lines.add(clean);
			}
		};

		extractExcalidrawTexts(raw, sourcePath).forEach(addLine);

		for (const match of raw.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
			const target = match[1] ?? "";
			// Embedded image targets are written as bare paths here, which the bracket-based privacy redaction cannot see.
			if (includeImageReferences || !isImageReferencePath(this.cleanReferenceText(target))) {
				addLine(target);
			}
		}

		const body = Array.from(lines).slice(0, 80).join("\n");
		const content = [
			`Excalidraw text extraction for ${sourcePath}.`,
			"This is not pixel-level visual analysis. It includes readable drawing text, labels, and embedded references when available.",
			"",
			body || "No readable text elements were found."
		].join("\n");
		return withTruncationNotice(content.trim(), this.host.getSettings().excalidrawSummaryMaxCharacters);
	}

	isExcalidrawPath(path: string): boolean {
		const clean = path.toLowerCase();
		return clean.endsWith(".excalidraw.md") || clean.endsWith(".excalidraw") || clean.endsWith(".excalidraw.json");
	}

	buildImageManifestAttachments(context: AttachmentContext): ContextAttachment[] {
		const references = this.extractImageReferenceInfos(context.content);
		if (references.length === 0) {
			return [];
		}

		const sourcePath = context.file?.path ?? "";
		const lines = [
			"Image manifest only. AskMate did not send image pixels to the text provider.",
			"Use paths, labels, captions, and surrounding note text only. Do not claim visual details that are not present in metadata or note context.",
			""
		];

		for (const reference of references.slice(0, MAX_CONTEXT_IMAGE_PREVIEWS * 3)) {
			const clean = reference.target;
			const file = this.host.app.metadataCache.getFirstLinkpathDest(clean, sourcePath);
			if (file instanceof TFile && IMAGE_FILE_EXTENSIONS.has(file.extension.toLowerCase())) {
				lines.push(`- Local image: ${file.path} (${file.extension}, ${formatTokenCount(file.stat.size)} bytes)`);
			} else {
				lines.push(`- Image reference: ${clean}`);
			}
			if (reference.label) {
				lines.push(`  - Label or alt text: ${reference.label}`);
			}
			if (reference.line) {
				lines.push(`  - Reference line: ${reference.line}`);
			}
		}

		const content = lines.join("\n");
		return [this.createContextAttachment("image_manifest", "Image reference manifest", sourcePath, content, content.length)];
	}

	extractImageReferenceInfos(markdown: string): ImageReferenceInfo[] {
		const infos: ImageReferenceInfo[] = [];
		for (const line of markdown.split(/\r?\n/)) {
			for (const match of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
				const raw = match[1] ?? "";
				const [target, label = ""] = raw.split("|");
				const cleanTarget = this.cleanReferenceText(target ?? "");
				if (cleanTarget && isImageReferencePath(cleanTarget)) {
					infos.push({
						target: cleanTarget,
						label: label.trim(),
						line: line.trim().slice(0, 240)
					});
				}
			}

			for (const match of line.matchAll(/!\[([^\]]*)]\(([^)]+)\)/g)) {
				const cleanTarget = this.cleanReferenceText(match[2] ?? "");
				if (cleanTarget && isImageReferencePath(cleanTarget)) {
					infos.push({
						target: cleanTarget,
						label: (match[1] ?? "").trim(),
						line: line.trim().slice(0, 240)
					});
				}
			}
		}

		return infos;
	}

	extractLinkedReferences(markdown: string): string[] {
		const references: string[] = [];
		for (const match of markdown.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
			references.push(this.cleanReferenceText(match[1]));
		}
		for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
			references.push(this.cleanReferenceText(match[1]));
		}
		return references.filter(Boolean);
	}

	extractImageReferencesFromMarkdown(markdown: string): string[] {
		return this.extractImageReferenceInfos(markdown).map((reference) => reference.target);
	}

	cleanReferenceText(reference: string): string {
		let clean = reference.trim();
		clean = clean.replace(/^<(.+)>$/, "$1");
		clean = clean.replace(/^['"](.+)['"]$/, "$1");
		clean = clean.split("|")[0]?.split("#")[0]?.trim() ?? "";
		try {
			return decodeURI(clean);
		} catch {
			return clean;
		}
	}

	isVisibleMarkdownPath(path: string): boolean {
		return path.endsWith(".md")
			&& !path.startsWith(`${this.host.app.vault.configDir}/`)
			&& !path.startsWith(".trash/")
			&& !path.includes("/.");
	}

	isVisibleFolderPath(path: string): boolean {
		return path !== this.host.app.vault.configDir
			&& !path.split("/").some((segment) => segment.startsWith("."));
	}

	/**
	 * The folder at a path. An exact match wins; otherwise each segment is matched ignoring case, because the file system
	 * under the vault may not distinguish case (macOS, Windows) and settings written by hand often differ in case only.
	 * An ambiguous match is treated as missing.
	 */
	private findFolder(path: string): TFolder | null {
		const exact = this.host.app.vault.getFolderByPath(path);
		if (exact) {
			return exact;
		}
		let current: TFolder | null = this.host.app.vault.getRoot();
		for (const segment of path.split("/")) {
			const wanted = segment.toLowerCase();
			const matches: TFolder[] = current.children.filter((child): child is TFolder => child instanceof TFolder && child.name.toLowerCase() === wanted);
			current = matches.length === 1 ? matches[0] : null;
			if (!current) {
				return null;
			}
		}
		return current;
	}

	/** Visible Markdown notes below a folder, depth first, files before sub-folders, each level in path order. */
	private *iterateMarkdownFiles(folder: TFolder): Generator<TFile> {
		const byPath = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path);
		const children = folder.children.slice();
		for (const file of children.filter((child): child is TFile => child instanceof TFile).sort(byPath)) {
			if (this.isVisibleMarkdownPath(file.path)) {
				yield file;
			}
		}
		// Hidden folders (.git, the config folder, .trash) can hold thousands of files that are never context.
		for (const sub of children.filter((child): child is TFolder => child instanceof TFolder).sort(byPath)) {
			if (this.isVisibleFolderPath(sub.path)) {
				yield* this.iterateMarkdownFiles(sub);
			}
		}
	}

	/**
	 * Markdown notes in a folder, at most `maxFiles`. Notes in `taken` (already attached elsewhere) are left out before
	 * the limit is applied, so duplicates never use up the quota; each is passed to `onDuplicate`. Uses the vault's folder
	 * tree. Throws FolderNotFoundError when there is no such folder.
	 */
	async listMarkdownFilesInFolder(
		folderPath: string,
		maxFiles: number,
		excludePath = "",
		taken?: ReadonlyMap<string, string>,
		onDuplicate?: (path: string, takenBy: string) => void
	): Promise<TFile[]> {
		const folder = cleanFolderPath(folderPath);
		if (!folder) {
			return [];
		}

		const root = this.findFolder(folder);
		if (!root) {
			throw new FolderNotFoundError(folder);
		}

		const limit = normalizeBoundedInteger(maxFiles, DEFAULT_BATCH_WORKFLOW_MAX_FILES, 1, 100);
		const files: TFile[] = [];
		for (const file of this.iterateMarkdownFiles(root)) {
			if (files.length >= limit) {
				break;
			}
			const takenBy = taken?.get(file.path);
			if (file.path === excludePath || takenBy === CURRENT_NOTE_LABEL) {
				continue;
			}
			if (takenBy !== undefined) {
				onDuplicate?.(file.path, takenBy);
				continue;
			}
			files.push(file);
		}
		return files;
	}
}
