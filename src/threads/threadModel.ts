import type { ChatMessage } from "../shared/types";

/**
 * Pure model for saved conversations. Everything stored here is plain data: no DOM, no base64 images.
 * The service and the view only call these functions, so each rule is unit tested.
 */

export const MAX_SAVED_THREADS = 50;
export const MAX_THREAD_MESSAGES = 200;
export const MAX_THREAD_TITLE_CHARACTERS = 60;
/** Per-message cap for the saved copy. A longer reply is cut and ends with SAVED_MESSAGE_TRUNCATED_MARKER. */
export const MAX_SAVED_MESSAGE_CHARACTERS = 50_000;
/** About 2 MB of serialised thread data in total, because the whole store is rewritten with every settings save. */
export const MAX_THREAD_STORE_BYTES = 2 * 1024 * 1024;
export const MAX_SAVED_TOOL_CALLS = 24;
export const MAX_SAVED_TOOL_SUMMARY_CHARACTERS = 300;
/** Own budget for the tool summaries of one message, so a tool-heavy reply cannot crowd out the conversation. */
export const MAX_SAVED_TOOLS_BYTES = 4_000;
export const MAX_THREAD_SKILL_IDS = 8;
export const DEFAULT_THREAD_TITLE = "New conversation";
export const SAVED_MESSAGE_TRUNCATED_MARKER = "\n\n[Saved copy shortened: the rest of this reply was not kept.]";
/** Shown in place of a reply that was based on a note that has since been deleted. */
export const DELETED_NOTE_REPLY_PLACEHOLDER = "[Removed: the note this reply was based on was deleted.]";

const MAX_FIELD_CHARACTERS = 500;
const MAX_TOOL_FIELD_CHARACTERS = 120;
const MAX_SKILL_ID_CHARACTERS = 64;
/** Rough JSON overhead per message and per thread, used only to skip the exact size measurement for small stores. */
const MESSAGE_OVERHEAD_BYTES = 400;
const THREAD_OVERHEAD_BYTES = 400;

export type SavedToolStatus = "completed" | "failed" | "denied";

/** What the sidebar shows about one tool call after the run. Arguments and raw results are never stored. */
export interface SavedToolCall {
	server: string;
	tool: string;
	status: SavedToolStatus;
	summary?: string;
}

export type SavedDiagramStatus = "rendered" | "fallback";

/** What survives of a diagram reply: the Mermaid source lives in the message text, so only the outcome is kept here. */
export interface SavedDiagramSummary {
	/** Mermaid diagram type, for example "flowchart". */
	type: string;
	status: SavedDiagramStatus;
	/** Name of the style recipe that was used. */
	recipe?: string;
	/** True when a repair turn was needed. */
	repaired?: boolean;
}

export interface SavedMessage {
	role: "user" | "assistant";
	text: string;
	createdAt: string;
	model?: string;
	/** Vault path of the note that was captured when the turn was asked. */
	sourcePath?: string;
	incomplete?: boolean;
	/** True for a generated-image turn; imagePath is set only when the image was saved to the vault. */
	image?: boolean;
	imagePath?: string;
	/** Tool calls the assistant made while answering, summarised. */
	tools?: SavedToolCall[];
	/** Outcome of a Mermaid diagram reply. */
	diagram?: SavedDiagramSummary;
}

export interface SavedThread {
	id: string;
	title: string;
	/** While true the title follows the first question; a rename switches it off. */
	autoTitle: boolean;
	createdAt: string;
	updatedAt: string;
	messages: SavedMessage[];
	/** Skills kept active for this conversation (sticky skills). */
	skillIds?: string[];
	/** True when older messages were dropped to respect the message or size caps. */
	truncated?: true;
}

export interface ThreadStore {
	activeId: string | null;
	threads: SavedThread[];
}

/** A transcript line as the sidebar holds it: the plain chat fields plus the optional summaries saved threads keep. */
export type ChatMessageLike = ChatMessage & Partial<Pick<SavedMessage, "tools" | "diagram">>;

export function createEmptyThreadStore(): ThreadStore {
	return { activeId: null, threads: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.slice(0, MAX_FIELD_CHARACTERS) : undefined;
}

function boundedText(value: unknown, maxCharacters: number): string {
	return typeof value === "string" ? Array.from(value.replace(/\s+/g, " ").trim()).slice(0, maxCharacters).join("") : "";
}

/** Cuts text to the saved-message cap. The result is never longer than the cap, so cutting twice changes nothing. */
function capMessageText(text: string): string {
	if (text.length <= MAX_SAVED_MESSAGE_CHARACTERS) {
		return text;
	}
	let head = text.slice(0, MAX_SAVED_MESSAGE_CHARACTERS - SAVED_MESSAGE_TRUNCATED_MARKER.length);
	const last = head.charCodeAt(head.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		// Never leave half a surrogate pair at the cut.
		head = head.slice(0, -1);
	}
	return `${head.trimEnd()}${SAVED_MESSAGE_TRUNCATED_MARKER}`;
}

function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function jsonBytes(value: unknown): number {
	return utf8ByteLength(JSON.stringify(value) ?? "");
}

function normalizeSavedToolCalls(raw: unknown): SavedToolCall[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const calls: SavedToolCall[] = [];
	let bytes = 2;
	for (const entry of raw) {
		if (calls.length >= MAX_SAVED_TOOL_CALLS) {
			break;
		}
		if (!isRecord(entry) || (entry.status !== "completed" && entry.status !== "failed" && entry.status !== "denied")) {
			continue;
		}
		const server = boundedText(entry.server, MAX_TOOL_FIELD_CHARACTERS);
		const tool = boundedText(entry.tool, MAX_TOOL_FIELD_CHARACTERS);
		if (!server || !tool) {
			continue;
		}
		const summary = boundedText(entry.summary, MAX_SAVED_TOOL_SUMMARY_CHARACTERS);
		const call: SavedToolCall = { server, tool, status: entry.status, ...(summary ? { summary } : {}) };
		bytes += jsonBytes(call) + 1;
		if (bytes > MAX_SAVED_TOOLS_BYTES) {
			break;
		}
		calls.push(call);
	}
	return calls.length > 0 ? calls : undefined;
}

function normalizeSavedDiagram(raw: unknown): SavedDiagramSummary | undefined {
	if (!isRecord(raw) || (raw.status !== "rendered" && raw.status !== "fallback")) {
		return undefined;
	}
	const type = boundedText(raw.type, 60);
	if (!type) {
		return undefined;
	}
	const recipe = boundedText(raw.recipe, 60);
	return { type, status: raw.status, ...(recipe ? { recipe } : {}), ...(raw.repaired === true ? { repaired: true } : {}) };
}

/** Returns null for anything that is not a usable message, so one bad entry never breaks the whole thread. */
export function normalizeSavedMessage(raw: unknown, fallbackTimestamp: string): SavedMessage | null {
	if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant") || typeof raw.text !== "string" || !raw.text.trim()) {
		return null;
	}
	const message: SavedMessage = {
		role: raw.role,
		text: capMessageText(raw.text),
		createdAt: isIsoTimestamp(raw.createdAt) ? raw.createdAt : fallbackTimestamp
	};
	const model = optionalString(raw.model);
	const sourcePath = optionalString(raw.sourcePath);
	const imagePath = optionalString(raw.imagePath);
	if (model) {
		message.model = model;
	}
	if (sourcePath) {
		message.sourcePath = sourcePath;
	}
	if (raw.incomplete === true) {
		message.incomplete = true;
	}
	if (raw.image === true) {
		message.image = true;
	}
	if (imagePath) {
		message.imagePath = imagePath;
	}
	if (raw.role === "assistant") {
		const tools = normalizeSavedToolCalls(raw.tools);
		const diagram = normalizeSavedDiagram(raw.diagram);
		if (tools) {
			message.tools = tools;
		}
		if (diagram) {
			message.diagram = diagram;
		}
	}
	return message;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function normalizeSkillIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const ids = raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter((value) => value.length > 0 && value.length <= MAX_SKILL_ID_CHARACTERS && !hasControlCharacter(value));
	return [...new Set(ids)].slice(0, MAX_THREAD_SKILL_IDS);
}

export function normalizeSavedThread(raw: unknown): SavedThread | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || !isIsoTimestamp(raw.createdAt)) {
		return null;
	}
	const updatedAt = isIsoTimestamp(raw.updatedAt) ? raw.updatedAt : raw.createdAt;
	const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
	const usable = rawMessages
		.map((message) => normalizeSavedMessage(message, updatedAt))
		.filter((message): message is SavedMessage => message !== null);
	const messages = usable.slice(-MAX_THREAD_MESSAGES);
	if (messages.length === 0) {
		return null;
	}
	const droppedOldest = usable.length > messages.length;
	const followsFirstQuestion = raw.autoTitle !== false;
	const storedTitle = typeof raw.title === "string" ? cleanThreadTitle(raw.title) : "";
	const skillIds = normalizeSkillIds(raw.skillIds);
	const truncated = raw.truncated === true || droppedOldest;
	return {
		id: raw.id.slice(0, 120),
		// Derived from the whole transcript, so cutting the oldest messages never changes the title.
		title: followsFirstQuestion ? autoTitleFor(usable) : storedTitle || autoTitleFor(messages),
		// Once the first question has fallen off the cap the title is frozen.
		autoTitle: followsFirstQuestion && !droppedOldest,
		createdAt: raw.createdAt,
		updatedAt,
		messages,
		...(skillIds.length > 0 ? { skillIds } : {}),
		...(truncated ? { truncated: true as const } : {})
	};
}

/**
 * Drops malformed entries and duplicates, applies the thread cap and then the total size budget.
 * Safe to run on every load and save.
 */
export function normalizeThreadStore(raw: unknown, maxThreads = MAX_SAVED_THREADS, maxBytes = MAX_THREAD_STORE_BYTES): ThreadStore {
	if (!isRecord(raw) || !Array.isArray(raw.threads)) {
		return createEmptyThreadStore();
	}
	const seen = new Set<string>();
	const threads = raw.threads
		.map(normalizeSavedThread)
		.filter((thread): thread is SavedThread => {
			if (!thread || seen.has(thread.id)) {
				return false;
			}
			seen.add(thread.id);
			return true;
		});
	const requestedActiveId = typeof raw.activeId === "string" ? raw.activeId : null;
	const counted = pruneThreads(threads, maxThreads);
	const kept = enforceThreadStoreBudget(counted, maxBytes, requestedActiveId);
	const activeId = requestedActiveId !== null && kept.some((thread) => thread.id === requestedActiveId) ? requestedActiveId : null;
	return { activeId, threads: kept };
}

/** Keeps the most recently updated threads and preserves the stored order of the survivors. */
export function pruneThreads(threads: readonly SavedThread[], maxThreads = MAX_SAVED_THREADS): SavedThread[] {
	if (threads.length <= maxThreads) {
		return [...threads];
	}
	const survivors = new Set(
		[...threads]
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.slice(0, maxThreads)
			.map((thread) => thread.id)
	);
	return threads.filter((thread) => survivors.has(thread.id));
}

/** A cheap upper bound, so stores that are clearly small never pay for an exact measurement. */
function boundsUnderBudget(threads: readonly SavedThread[], maxBytes: number): boolean {
	let bound = 0;
	for (const thread of threads) {
		bound += THREAD_OVERHEAD_BYTES;
		for (const message of thread.messages) {
			bound += message.text.length * 3 + MESSAGE_OVERHEAD_BYTES + (message.tools ? MAX_SAVED_TOOLS_BYTES : 0);
		}
		if (bound > maxBytes) {
			return false;
		}
	}
	return true;
}

/**
 * Keeps the serialised store under the byte budget. Whole threads go first, oldest update first; the active
 * thread, or failing that the newest one, is kept. If that single thread is still too large its oldest
 * messages go and it is flagged as truncated.
 */
export function enforceThreadStoreBudget(threads: readonly SavedThread[], maxBytes = MAX_THREAD_STORE_BYTES, protectedId: string | null = null): SavedThread[] {
	if (threads.length === 0 || boundsUnderBudget(threads, maxBytes)) {
		return [...threads];
	}
	const sizes = new Map(threads.map((thread) => [thread.id, jsonBytes(thread) + 1]));
	let total = 2 + [...sizes.values()].reduce((sum, size) => sum + size, 0);
	if (total <= maxBytes) {
		return [...threads];
	}
	const newestFirst = [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	const keepId = threads.some((thread) => thread.id === protectedId) ? protectedId : newestFirst[0].id;
	const dropped = new Set<string>();
	for (const candidate of [...newestFirst].reverse()) {
		if (total <= maxBytes) {
			break;
		}
		if (candidate.id === keepId) {
			continue;
		}
		dropped.add(candidate.id);
		total -= sizes.get(candidate.id) ?? 0;
	}
	const remaining = threads.filter((thread) => !dropped.has(thread.id));
	if (total <= maxBytes) {
		return remaining;
	}
	return remaining.map((thread) => (thread.id === keepId ? trimThreadToBudget(thread, maxBytes) : thread));
}

function trimThreadToBudget(thread: SavedThread, maxBytes: number): SavedThread {
	const shell = jsonBytes({ ...thread, messages: [] }) + 2;
	let total = shell + thread.messages.reduce((sum, message) => sum + jsonBytes(message) + 1, 0);
	let start = 0;
	while (total > maxBytes && start < thread.messages.length - 1) {
		total -= jsonBytes(thread.messages[start]) + 1;
		start += 1;
	}
	// The title is frozen because the first question may be among the messages that went.
	return start === 0 ? thread : { ...thread, messages: thread.messages.slice(start), autoTitle: false, truncated: true };
}

function cleanThreadTitle(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	const characters = Array.from(collapsed);
	return characters.length > MAX_THREAD_TITLE_CHARACTERS
		? `${characters.slice(0, MAX_THREAD_TITLE_CHARACTERS - 1).join("").trimEnd()}…`
		: collapsed;
}

/** A user-chosen title: single line, trimmed, capped. Returns an empty string when nothing usable remains. */
export function sanitiseThreadTitle(value: string): string {
	return cleanThreadTitle(value);
}

/** Title from the first question: first non-empty line, Markdown and slash-command noise removed, capped. */
export function deriveThreadTitle(firstQuestion: string): string {
	const firstLine = firstQuestion.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
	const plain = firstLine.replace(/^[#>*\-\s]+/, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias ?? target);
	return cleanThreadTitle(plain) || DEFAULT_THREAD_TITLE;
}

function autoTitleFor(messages: readonly SavedMessage[]): string {
	const first = messages.find((message) => message.role === "user") ?? messages[0];
	return first ? deriveThreadTitle(first.text) : DEFAULT_THREAD_TITLE;
}

export function createThread(id: string, now: Date): SavedThread {
	const stamp = now.toISOString();
	return { id, title: DEFAULT_THREAD_TITLE, autoTitle: true, createdAt: stamp, updatedAt: stamp, messages: [] };
}

export function createThreadId(now: Date, random: number): string {
	return `thread-${now.getTime()}-${Math.floor(random * 36 ** 6).toString(36).padStart(6, "0")}`;
}

/**
 * Plain-data copy of the sidebar transcript. System lines and anything without text are not part of a conversation.
 * The message cap is applied by withThreadMessages and the store normaliser, which see the whole transcript and so
 * can keep the title stable when the oldest messages fall off.
 */
export function toSavedMessages(messages: readonly ChatMessageLike[], fallbackTimestamp: string): SavedMessage[] {
	return messages
		.map((message) => normalizeSavedMessage(message, fallbackTimestamp))
		.filter((message): message is SavedMessage => message !== null);
}

/**
 * The transcript to save while a request may still be running. The in-flight turn (the question the run was
 * started for) is removed by identity, so a status line or a later message never changes which turn is dropped,
 * and a repeated question with the same text stays.
 */
export function settleThreadMessages(
	messages: readonly ChatMessageLike[],
	pendingTurn: ChatMessageLike | readonly ChatMessageLike[] | null | undefined,
	fallbackTimestamp: string = new Date().toISOString()
): SavedMessage[] {
	const pending = toMessageList(pendingTurn);
	const settled = pending.length === 0 ? messages : messages.filter((message) => !pending.includes(message));
	return toSavedMessages(settled, fallbackTimestamp);
}

function isMessageList(value: ChatMessageLike | readonly ChatMessageLike[]): value is readonly ChatMessageLike[] {
	return Array.isArray(value);
}

function toMessageList(value: ChatMessageLike | readonly ChatMessageLike[] | null | undefined): readonly ChatMessageLike[] {
	if (value === null || value === undefined) {
		return [];
	}
	return isMessageList(value) ? value : [value];
}

export function fromSavedMessages(messages: readonly SavedMessage[]): ChatMessageLike[] {
	return messages.map((message) => ({
		...message,
		...(message.tools ? { tools: message.tools.map((call) => ({ ...call })) } : {}),
		...(message.diagram ? { diagram: { ...message.diagram } } : {})
	}));
}

function isDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => isDeepEqual(item, b[index]));
	}
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a).filter((key) => a[key] !== undefined);
		return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length && keys.every((key) => isDeepEqual(a[key], b[key]));
	}
	return false;
}

/** True when two stores hold the same data, whatever the key order. Used to skip writes that would change nothing. */
export function isSameThreadStore(a: unknown, b: unknown): boolean {
	return isDeepEqual(a, b);
}

/** True when two threads differ at most in updatedAt: same title, messages, skills and flags. */
export function hasSameThreadContent(a: SavedThread, b: SavedThread): boolean {
	return a.title === b.title
		&& a.autoTitle === b.autoTitle
		&& a.createdAt === b.createdAt
		&& isDeepEqual(a.skillIds ?? [], b.skillIds ?? [])
		&& (a.truncated ?? false) === (b.truncated ?? false)
		&& isDeepEqual(a.messages, b.messages);
}

/**
 * Applies a new transcript to a thread: refreshes the timestamp and, while the title is automatic, the title.
 * A transcript that matches the thread already returns the thread itself, so merely viewing a thread never
 * counts as activity.
 */
export function withThreadMessages(thread: SavedThread, messages: SavedMessage[], now: Date): SavedThread {
	const trimmed = messages.slice(-MAX_THREAD_MESSAGES);
	const droppedOldest = messages.length > trimmed.length;
	// The title is derived from the whole transcript and then frozen, so cutting the oldest messages keeps it.
	const title = thread.autoTitle ? autoTitleFor(messages) : thread.title;
	const autoTitle = thread.autoTitle && !droppedOldest;
	if (title === thread.title && autoTitle === thread.autoTitle && isDeepEqual(thread.messages, trimmed)) {
		return thread;
	}
	return {
		...thread,
		title,
		autoTitle,
		messages: trimmed,
		updatedAt: now.toISOString(),
		...(droppedOldest ? { truncated: true as const } : {})
	};
}

/** Sets the sticky skills of a thread. Returns the same thread when the normalised list is unchanged. */
export function withThreadSkillIds(thread: SavedThread, skillIds: readonly string[]): SavedThread {
	const next = normalizeSkillIds(skillIds);
	if (isDeepEqual(thread.skillIds ?? [], next)) {
		return thread;
	}
	const updated: SavedThread = { ...thread };
	if (next.length > 0) {
		updated.skillIds = next;
	} else {
		delete updated.skillIds;
	}
	return updated;
}

export function renameThreadValue(thread: SavedThread, title: string): SavedThread {
	const clean = sanitiseThreadTitle(title);
	return clean ? { ...thread, title: clean, autoTitle: false } : thread;
}

/**
 * Stores the thread and marks it active. A thread with no messages is removed instead, so empty chats never pile up.
 * A thread whose content matches the stored one keeps the stored copy (and its updatedAt and place), because
 * saving what is already saved is not activity.
 */
export function upsertThread(store: ThreadStore, thread: SavedThread, maxThreads = MAX_SAVED_THREADS): ThreadStore {
	const existing = store.threads.find((candidate) => candidate.id === thread.id);
	const others = store.threads.filter((candidate) => candidate.id !== thread.id);
	if (thread.messages.length === 0) {
		return { activeId: store.activeId === thread.id ? null : store.activeId, threads: others };
	}
	if (existing && hasSameThreadContent(existing, thread)) {
		return { activeId: thread.id, threads: store.threads };
	}
	const threads = pruneThreads([...others, thread], maxThreads);
	return { activeId: threads.some((candidate) => candidate.id === thread.id) ? thread.id : store.activeId, threads };
}

export function setActiveThread(store: ThreadStore, id: string | null): ThreadStore {
	return { ...store, activeId: id !== null && store.threads.some((thread) => thread.id === id) ? id : null };
}

export function renameThreadInStore(store: ThreadStore, id: string, title: string): ThreadStore {
	return { ...store, threads: store.threads.map((thread) => (thread.id === id ? renameThreadValue(thread, title) : thread)) };
}

export function deleteThreadFromStore(store: ThreadStore, id: string): ThreadStore {
	return { activeId: store.activeId === id ? null : store.activeId, threads: store.threads.filter((thread) => thread.id !== id) };
}

export function findThread(store: ThreadStore, id: string | null): SavedThread | null {
	return id === null ? null : store.threads.find((thread) => thread.id === id) ?? null;
}

/** Most recently updated first, for the switcher. */
export function listThreadsByRecency(store: ThreadStore): SavedThread[] {
	return [...store.threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function isSameOrInsidePath(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}

function mapThreadMessages(thread: SavedThread, mapMessage: (message: SavedMessage) => SavedMessage): SavedThread {
	const messages = thread.messages.map(mapMessage);
	return messages.some((message, index) => message !== thread.messages[index]) ? { ...thread, messages } : thread;
}

export interface PurgeThreadPathsOptions {
	/**
	 * Replace the text of assistant replies that were based on the deleted note, since they quote it.
	 * The questions, the other replies and the thread itself stay. On by default.
	 */
	clearQuotedReplies?: boolean;
}

/**
 * A note or folder was renamed or deleted. The same value drives the stored threads, the queued saves and the
 * transcript the sidebar holds, so the three cannot disagree about what happened.
 */
export type ThreadPathChange =
	| { kind: "renamed"; oldPath: string; newPath: string }
	| { kind: "deleted"; path: string };

/**
 * Follows a renamed note or folder: sourcePath and imagePath that were the old path, or inside it, move to the
 * new one. Returns the message itself when nothing refers to the old path. Works on saved messages and on the
 * sidebar's transcript lines alike.
 */
export function remapMessagePaths<T extends ChatMessageLike>(message: T, oldPath: string, newPath: string): T {
	if (!oldPath || oldPath === newPath) {
		return message;
	}
	const move = (path: string): string => (isSameOrInsidePath(path, oldPath) ? `${newPath}${path.slice(oldPath.length)}` : path);
	const sourcePath = message.sourcePath === undefined ? undefined : move(message.sourcePath);
	const imagePath = message.imagePath === undefined ? undefined : move(message.imagePath);
	if (sourcePath === message.sourcePath && imagePath === message.imagePath) {
		return message;
	}
	const next: T = { ...message };
	if (sourcePath !== undefined) {
		next.sourcePath = sourcePath;
	}
	if (imagePath !== undefined) {
		next.imagePath = imagePath;
	}
	return next;
}

/**
 * A note was deleted: forget the links to it (sourcePath, imagePath) and, unless told otherwise, replace the text of
 * an assistant reply that was based on it, so its content does not outlive the note. Returns the message itself
 * when nothing refers to the path.
 */
export function purgeMessagePaths<T extends ChatMessageLike>(message: T, path: string, options: PurgeThreadPathsOptions = {}): T {
	if (!path) {
		return message;
	}
	const noteDeleted = message.sourcePath !== undefined && isSameOrInsidePath(message.sourcePath, path);
	const imageDeleted = message.imagePath !== undefined && isSameOrInsidePath(message.imagePath, path);
	if (!noteDeleted && !imageDeleted) {
		return message;
	}
	const next: T = { ...message };
	if (noteDeleted) {
		delete next.sourcePath;
	}
	if (imageDeleted) {
		delete next.imagePath;
	}
	if (noteDeleted && options.clearQuotedReplies !== false && message.role === "assistant" && !message.image) {
		next.text = DELETED_NOTE_REPLY_PLACEHOLDER;
		delete next.tools;
		delete next.diagram;
	}
	return next;
}

/** Applies one path change to one message. Exhaustive over ThreadPathChange. */
export function applyPathChangeToMessage<T extends ChatMessageLike>(message: T, change: ThreadPathChange): T {
	switch (change.kind) {
		case "renamed":
			return remapMessagePaths(message, change.oldPath, change.newPath);
		case "deleted":
			return purgeMessagePaths(message, change.path);
	}
}

/**
 * Follows a renamed note or folder: sourcePath and imagePath that were the old path, or inside it, move to the
 * new one. updatedAt is left alone because a rename is not conversation activity. Returns the thread itself
 * when nothing refers to the old path.
 */
export function remapThreadPathsInThread(thread: SavedThread, oldPath: string, newPath: string): SavedThread {
	return mapThreadMessages(thread, (message) => remapMessagePaths(message, oldPath, newPath));
}

export function remapThreadPaths(store: ThreadStore, oldPath: string, newPath: string): ThreadStore {
	const threads = store.threads.map((thread) => remapThreadPathsInThread(thread, oldPath, newPath));
	return threads.some((thread, index) => thread !== store.threads[index]) ? { ...store, threads } : store;
}

/**
 * A note was deleted: forget the links to it (sourcePath, imagePath) and, unless told otherwise, replace the text of
 * the assistant replies that were based on it, so its content does not outlive the note. The conversation stays.
 * Returns the thread itself when nothing refers to the path.
 */
export function purgeThreadPathsInThread(thread: SavedThread, path: string, options: PurgeThreadPathsOptions = {}): SavedThread {
	return mapThreadMessages(thread, (message) => purgeMessagePaths(message, path, options));
}

export function purgeThreadPaths(store: ThreadStore, path: string, options: PurgeThreadPathsOptions = {}): ThreadStore {
	const threads = store.threads.map((thread) => purgeThreadPathsInThread(thread, path, options));
	return threads.some((thread, index) => thread !== store.threads[index]) ? { ...store, threads } : store;
}

export function applyPathChangeToThread(thread: SavedThread, change: ThreadPathChange): SavedThread {
	return mapThreadMessages(thread, (message) => applyPathChangeToMessage(message, change));
}

export function applyPathChangeToStore(store: ThreadStore, change: ThreadPathChange): ThreadStore {
	switch (change.kind) {
		case "renamed":
			return remapThreadPaths(store, change.oldPath, change.newPath);
		case "deleted":
			return purgeThreadPaths(store, change.path);
	}
}

/**
 * Brings the transcript the sidebar holds in line with a path change, in place, and returns the lines that changed
 * (so the view can refresh just those). Stored threads are rewritten by ThreadService, but the sidebar's next save
 * replaces the whole stored thread from its own transcript, so a transcript that kept the old paths would bring
 * them back. In place on purpose: the view keys other state (generated images, the in-flight turn handed to
 * settleThreadMessages) on the identity of these objects.
 */
export function applyPathChangeToLiveMessages(messages: readonly ChatMessageLike[], change: ThreadPathChange): ChatMessageLike[] {
	const changed: ChatMessageLike[] = [];
	for (const message of messages) {
		const next = applyPathChangeToMessage(message, change);
		if (next === message) {
			continue;
		}
		for (const key of Object.keys(message)) {
			if (!(key in next)) {
				Reflect.deleteProperty(message, key);
			}
		}
		Object.assign(message, next);
		changed.push(message);
	}
	return changed;
}

export function formatRelativeTime(iso: string, nowMs: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
	if (seconds < 60) {
		return "just now";
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 7) {
		return days === 1 ? "yesterday" : `${days} days ago`;
	}
	return new Date(then).toISOString().slice(0, 10);
}
