import { Editor, MarkdownView, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import {
	AskMateSettings,
	BuildRequestOptions,
	ChatMessage,
	ContextAttachment,
	ContextAttachmentKind,
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
	RequestPrivacyOptions
} from "../shared/core";
import { parseMarkdownHeadingSections } from "../output";

export function cleanFolderPath(folder: string): string {
	return normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
}

export type ContextServiceHost = {
	app: App;
	getSettings: () => AskMateSettings;
	getNoteHistoryForPath: (path: string) => NoteHistoryTurn[];
};

export class ContextService {
	private lastMarkdownView: MarkdownView | null = null;
	private lastMarkdownFile: TFile | null = null;
	private lastNoteContext: NoteContext | null = null;

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

		this.lastMarkdownView = activeView;
		this.rememberEditorContext(activeView.editor, activeView.file ?? null);
	}

	async getNoteContext(editor?: Editor, file?: TFile | null): Promise<NoteContext> {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);

		if (editor) {
			const context = this.tryCreateNoteContext(editor, file ?? activeView?.file ?? null);

			if (context) {
				this.rememberEditorContext(editor, context.file);
				return context;
			}

			this.lastNoteContext = null;
		}

		if (activeView) {
			const context = this.tryCreateNoteContext(activeView.editor, activeView.file ?? null);
			this.lastMarkdownView = activeView;
			this.rememberMarkdownFile(activeView.file ?? null);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const lastOpenView = this.getLastOpenMarkdownView();

		if (
			this.lastNoteContext?.source === "Selected text" &&
			(!lastOpenView || this.lastNoteContext.file === lastOpenView.file)
		) {
			return this.lastNoteContext;
		}

		if (lastOpenView) {
			const context = this.tryCreateNoteContext(lastOpenView.editor, lastOpenView.file ?? null);
			this.lastNoteContext = context;

			if (context) {
				return context;
			}
		}

		const fileContext = await this.tryCreateFileContext(file ?? lastOpenView?.file ?? this.lastMarkdownFile);

		if (fileContext) {
			this.lastNoteContext = fileContext;
			return fileContext;
		}

		throw new Error("Open a Markdown note or select text before using AskMate.");
	}

	rememberEditorContext(editor: Editor, file: TFile | null): void {
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);

		if (activeView?.editor === editor) {
			this.lastMarkdownView = activeView;
		}

		this.rememberMarkdownFile(file);
		this.lastNoteContext = this.tryCreateNoteContext(editor, file);
	}

	rememberMarkdownFile(file: TFile | null): void {
		if (file?.extension === "md") {
			this.lastMarkdownFile = file;
		}
	}

	tryCreateNoteContext(editor: Editor | undefined, file: TFile | null): NoteContext | null {
		const selectedText = editor?.getSelection().trim() ?? "";

		if (selectedText.length > 0) {
			const fullValue = editor?.getValue() ?? "";
			const from = editor?.getCursor("from");
			const to = editor?.getCursor("to");
			return {
				content: selectedText,
				file,
				source: "Selected text",
				activeHeadingPath: editor ? this.getActiveHeadingPath(fullValue, editor.getCursor().line) : null,
				selectionStartLine: from ? from.line + 1 : null,
				selectionEndLine: to ? to.line + 1 : null
			};
		}

		if (!editor) {
			return null;
		}

		const fullNote = editor.getValue().trim();

		if (fullNote.length > 0 || file?.extension === "md") {
			return {
				content: fullNote,
				file,
				source: "Current note",
				activeHeadingPath: this.getActiveHeadingPath(editor.getValue(), editor.getCursor().line),
				selectionStartLine: null,
				selectionEndLine: null
			};
		}

		return null;
	}

	async tryCreateFileContext(file: TFile | null | undefined): Promise<NoteContext | null> {
		if (!file || file.extension !== "md") {
			return null;
		}

		return await this.getFileNoteContext(file);
	}

	async getFileNoteContext(file: TFile): Promise<NoteContext> {
		const content = (await this.host.app.vault.cachedRead(file)).trim();
		return {
			content,
			file,
			source: "Current note",
			selectionStartLine: null,
			selectionEndLine: null
		};
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

	async buildContextAttachments(
		context: NoteContext,
		options: BuildRequestOptions,
		privacy: RequestPrivacyOptions
	): Promise<ContextAttachment[]> {
		const settings = this.host.getSettings();
		const attachments: ContextAttachment[] = [];

		if (options.includeThreadHistory && options.threadMessages?.length) {
			const thread = this.buildThreadHistoryAttachment(options.threadMessages, settings.threadedChatMaxTurns);
			if (thread) {
				attachments.push(thread);
			}
		}

		const noteHistory = this.buildNoteHistoryAttachment(context.file?.path ?? "");
		if (noteHistory) {
			attachments.push(noteHistory);
		}

		const additionalPaths = options.additionalContextPaths ?? settings.additionalContextPaths;
		attachments.push(...await this.buildAdditionalNoteAttachments(
			additionalPaths,
			context.file?.path ?? "",
			settings.additionalContextMaxCharacters
		));

		const folderContext = options.folderContext ?? {
			enabled: settings.folderContextEnabled,
			path: settings.folderContextPath,
			maxFiles: settings.folderContextMaxFiles,
			maxCharacters: settings.folderContextMaxCharacters
		};
		attachments.push(...await this.buildFolderContextAttachments(folderContext, context.file?.path ?? ""));

		const styleGuide = settings.includeStyleGuideContext
			? await this.buildRoleContextAttachment("style_guide", settings.styleGuideContextPath, context.file?.path ?? "", settings.styleGuideMaxCharacters)
			: null;
		if (styleGuide) {
			attachments.push(styleGuide);
		}
		const glossary = settings.includeGlossaryContext
			? await this.buildRoleContextAttachment("glossary", settings.glossaryContextPath, context.file?.path ?? "", settings.glossaryMaxCharacters)
			: null;
		if (glossary) {
			attachments.push(glossary);
		}

		if (settings.includeExcalidrawSummaries) {
			attachments.push(...await this.buildExcalidrawSummaryAttachments(context));
		}

		if (privacy.includeImageReferences && settings.includeImageManifests) {
			attachments.push(...this.buildImageManifestAttachments(context));
		}

		return attachments;
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
		const content = [`${role} role context. ${guidance}`, "", raw.slice(0, limit)].join("\n");
		return this.createContextAttachment(kind, `${role}: ${file.path}`, file.path, content, raw.length);
	}

	createContextAttachment(
		kind: ContextAttachmentKind,
		title: string,
		sourcePath: string,
		content: string,
		originalCharacters = content.length
	): ContextAttachment {
		const normalized = content.trim();
		return {
			kind,
			title,
			sourcePath,
			content: normalized,
			originalCharacters,
			finalCharacters: normalized.length,
			truncated: normalized.length < originalCharacters
		};
	}

	async buildAdditionalNoteAttachments(paths: string[], sourcePath: string, maxCharacters: number): Promise<ContextAttachment[]> {
		const attachments: ContextAttachment[] = [];
		let remaining = maxCharacters;

		for (const path of normalizeContextPathList(paths)) {
			if (remaining <= 0) {
				break;
			}

			const file = this.resolveMarkdownPath(path, sourcePath);
			if (!file || file.path === sourcePath) {
				continue;
			}

			const raw = (await this.host.app.vault.cachedRead(file)).trim();
			const content = raw.slice(0, remaining);
			remaining -= content.length;
			attachments.push(this.createContextAttachment(
				"additional_note",
				`Additional note: ${file.path}`,
				file.path,
				content,
				raw.length
			));
		}

		return attachments;
	}

	async buildFolderContextAttachments(options: FolderContextOptions, excludePath: string): Promise<ContextAttachment[]> {
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
		const files = await this.listMarkdownFilesInFolder(folder, maxFiles, excludePath);

		for (const file of files) {
			if (attachments.length >= maxFiles || remaining <= 0) {
				break;
			}

			const raw = (await this.host.app.vault.cachedRead(file)).trim();
			const content = raw.slice(0, remaining);
			remaining -= content.length;
			attachments.push(this.createContextAttachment(
				"folder_note",
				`Folder note ${attachments.length + 1}: ${file.path}`,
				file.path,
				content,
				raw.length
			));
		}

		return attachments;
	}

	resolveMarkdownPath(path: string, sourcePath: string): TFile | null {
		const cleanPath = normalizeContextPathList([path])[0] ?? "";
		if (!cleanPath) {
			return null;
		}

		const direct = this.host.app.vault.getAbstractFileByPath(cleanPath);
		if (direct instanceof TFile && direct.extension === "md") {
			return direct;
		}

		const linked = this.host.app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
		return linked?.extension === "md" ? linked : null;
	}

	async buildExcalidrawSummaryAttachments(context: NoteContext): Promise<ContextAttachment[]> {
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
			const summary = this.extractExcalidrawSummary(raw, file.path);
			if (!summary.trim()) {
				continue;
			}
			attachments.push(this.createContextAttachment(
				"excalidraw_summary",
				`Excalidraw summary: ${file.path}`,
				file.path,
				summary,
				raw.length
			));
		}

		return attachments;
	}

	extractExcalidrawSummary(raw: string, sourcePath: string): string {
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

		try {
			const parsed = JSON.parse(raw) as { elements?: Array<{ type?: unknown; text?: unknown }> };
			for (const element of parsed.elements ?? []) {
				if (element?.type === "text") {
					addLine(element.text);
				}
			}
		} catch {
			for (const match of raw.matchAll(/"text"\s*:\s*"([^"]+)"/g)) {
				addLine(match[1].replace(/\\"/g, "\""));
			}
		}

		for (const match of raw.matchAll(/!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]/g)) {
			addLine(match[1] ?? match[2]);
		}

		const body = Array.from(lines).slice(0, 80).join("\n");
		const content = [
			`Excalidraw text extraction for ${sourcePath}.`,
			"This is not pixel-level visual analysis. It includes readable drawing text, labels, and embedded references when available.",
			"",
			body || "No readable text elements were found."
		].join("\n");
		return content.slice(0, this.host.getSettings().excalidrawSummaryMaxCharacters).trim();
	}

	isExcalidrawPath(path: string): boolean {
		const clean = path.toLowerCase();
		return clean.endsWith(".excalidraw.md") || clean.endsWith(".excalidraw") || clean.endsWith(".excalidraw.json");
	}

	buildImageManifestAttachments(context: NoteContext): ContextAttachment[] {
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

	async listMarkdownFilesInFolder(folderPath: string, maxFiles: number, excludePath = ""): Promise<TFile[]> {
		const folder = cleanFolderPath(folderPath);
		if (!folder) {
			return [];
		}

		const limit = normalizeBoundedInteger(maxFiles, DEFAULT_BATCH_WORKFLOW_MAX_FILES, 1, 100);
		const paths: string[] = [];

		const visit = async (currentFolder: string): Promise<void> => {
			if (paths.length >= limit) {
				return;
			}

			let listed: { files: string[]; folders: string[] };
			try {
				listed = await this.host.app.vault.adapter.list(currentFolder);
			} catch {
				return;
			}

			for (const path of listed.files.slice().sort((a, b) => a.localeCompare(b))) {
				const normalizedPath = normalizePath(path);
				if (paths.length >= limit) {
					return;
				}
				if (normalizedPath !== excludePath && this.isVisibleMarkdownPath(normalizedPath)) {
					paths.push(normalizedPath);
				}
			}

			for (const path of listed.folders.slice().sort((a, b) => a.localeCompare(b))) {
				await visit(normalizePath(path));
				if (paths.length >= limit) {
					return;
				}
			}
		};

		await visit(folder);
		return paths
			.map((path) => this.host.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile && file.extension === "md");
	}
}
