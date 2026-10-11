import type { ChatMessage } from "../shared/types";

/**
 * Pure model for saved conversations. Everything stored here is plain data: no DOM, no base64 images.
 * The service and the view only call these functions, so each rule is unit tested.
 */

export const MAX_SAVED_THREADS = 50;
export const MAX_THREAD_MESSAGES = 200;
export const MAX_THREAD_TITLE_CHARACTERS = 60;
export const MAX_SAVED_MESSAGE_CHARACTERS = 200_000;
export const DEFAULT_THREAD_TITLE = "New conversation";

const MAX_FIELD_CHARACTERS = 500;

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
}

export interface SavedThread {
	id: string;
	title: string;
	/** While true the title follows the first question; a rename switches it off. */
	autoTitle: boolean;
	createdAt: string;
	updatedAt: string;
	messages: SavedMessage[];
}

export interface ThreadStore {
	activeId: string | null;
	threads: SavedThread[];
}

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

/** Returns null for anything that is not a usable message, so one bad entry never breaks the whole thread. */
export function normalizeSavedMessage(raw: unknown, fallbackTimestamp: string): SavedMessage | null {
	if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant") || typeof raw.text !== "string" || !raw.text.trim()) {
		return null;
	}
	const message: SavedMessage = {
		role: raw.role,
		text: raw.text.slice(0, MAX_SAVED_MESSAGE_CHARACTERS),
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
	return message;
}

export function normalizeSavedThread(raw: unknown): SavedThread | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || !isIsoTimestamp(raw.createdAt)) {
		return null;
	}
	const updatedAt = isIsoTimestamp(raw.updatedAt) ? raw.updatedAt : raw.createdAt;
	const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
	const messages = rawMessages
		.map((message) => normalizeSavedMessage(message, updatedAt))
		.filter((message): message is SavedMessage => message !== null)
		.slice(-MAX_THREAD_MESSAGES);
	if (messages.length === 0) {
		return null;
	}
	const autoTitle = raw.autoTitle !== false;
	const storedTitle = typeof raw.title === "string" ? cleanThreadTitle(raw.title) : "";
	return {
		id: raw.id.slice(0, 120),
		title: autoTitle ? autoTitleFor(messages) : storedTitle || autoTitleFor(messages),
		autoTitle,
		createdAt: raw.createdAt,
		updatedAt,
		messages
	};
}

/** Drops malformed entries and duplicates, then applies the thread cap. Safe to run on every load and save. */
export function normalizeThreadStore(raw: unknown, maxThreads = MAX_SAVED_THREADS): ThreadStore {
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
	const kept = pruneThreads(threads, maxThreads);
	const activeId = typeof raw.activeId === "string" && kept.some((thread) => thread.id === raw.activeId) ? raw.activeId : null;
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

/** Plain-data copy of the sidebar transcript. System lines and anything without text are not part of a conversation. */
export function toSavedMessages(messages: readonly ChatMessage[], fallbackTimestamp: string): SavedMessage[] {
	return messages
		.map((message) => normalizeSavedMessage(message, fallbackTimestamp))
		.filter((message): message is SavedMessage => message !== null)
		.slice(-MAX_THREAD_MESSAGES);
}

export function fromSavedMessages(messages: readonly SavedMessage[]): ChatMessage[] {
	return messages.map((message) => ({ ...message }));
}

/** Applies a new transcript to a thread: refreshes the timestamp and, while the title is automatic, the title. */
export function withThreadMessages(thread: SavedThread, messages: SavedMessage[], now: Date): SavedThread {
	const next: SavedThread = { ...thread, messages: messages.slice(-MAX_THREAD_MESSAGES), updatedAt: now.toISOString() };
	if (next.autoTitle) {
		next.title = autoTitleFor(messages);
	}
	return next;
}

export function renameThreadValue(thread: SavedThread, title: string): SavedThread {
	const clean = sanitiseThreadTitle(title);
	return clean ? { ...thread, title: clean, autoTitle: false } : thread;
}

/** Stores the thread and marks it active. A thread with no messages is removed instead, so empty chats never pile up. */
export function upsertThread(store: ThreadStore, thread: SavedThread, maxThreads = MAX_SAVED_THREADS): ThreadStore {
	const others = store.threads.filter((candidate) => candidate.id !== thread.id);
	if (thread.messages.length === 0) {
		return { activeId: store.activeId === thread.id ? null : store.activeId, threads: others };
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
