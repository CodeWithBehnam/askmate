/**
 * What to do with the text of data.json, decided without touching the vault. A missing file is a fresh install, a file
 * that cannot be read as an object is corrupt (and must be backed up before defaults overwrite it), and a file that
 * changed because another device synced is merged with this device's threads, history and queue instead of replacing them.
 */
import type { AskMateSettings, NoteHistoryTurn, ReviewQueueItem } from "../shared/types";
import { normalizeThreadStore, type SavedThread } from "../threads/threadModel";

export type StoredData =
	/** Obsidian's loadData() returned null: there is no data.json yet. */
	| { kind: "fresh" }
	| { kind: "ok"; data: Partial<AskMateSettings> }
	| { kind: "corrupt"; reason: string };

/** Sorts what loadData() gave back. Anything that is not a plain object means the file could not be used. */
export function classifyStoredData(raw: unknown): StoredData {
	if (raw === null) {
		return { kind: "fresh" };
	}
	if (raw === undefined) {
		return { kind: "corrupt", reason: "the file could not be read" };
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { kind: "corrupt", reason: "the file does not hold an object" };
	}
	return { kind: "ok", data: raw };
}

/** data.json.corrupt-2026-10-12T09-11-00Z: UTC, and no colons, which Windows does not allow in a file name. */
export function corruptBackupName(now: Date): string {
	return `data.json.corrupt-${now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}`;
}

function newerOf<T extends { updatedAt: string }>(a: T, b: T): T {
	// ISO timestamps order the same as the instants they name. An unreadable one loses to a readable one.
	const left = Date.parse(a.updatedAt);
	const right = Date.parse(b.updatedAt);
	if (Number.isNaN(left)) {
		return Number.isNaN(right) ? a : b;
	}
	return Number.isNaN(right) || left >= right ? a : b;
}

function mergeById<T extends { id: string }>(local: readonly T[], incoming: readonly T[], pick: (a: T, b: T) => T): T[] {
	const merged = new Map<string, T>(incoming.map((item) => [item.id, item]));
	for (const item of local) {
		const other = merged.get(item.id);
		merged.set(item.id, other ? pick(item, other) : item);
	}
	return [...merged.values()];
}

function mergeThreads(local: AskMateSettings["threadStore"], incoming: AskMateSettings["threadStore"]): AskMateSettings["threadStore"] {
	const localStore = normalizeThreadStore(local);
	const incomingStore = normalizeThreadStore(incoming);
	const threads: SavedThread[] = mergeById(localStore.threads, incomingStore.threads, newerOf);
	const activeId = localStore.activeId !== null && threads.some((thread) => thread.id === localStore.activeId) ? localStore.activeId : incomingStore.activeId;
	return normalizeThreadStore({ ...incomingStore, activeId, threads });
}

function mergeHistory(local: AskMateSettings["noteHistoryStore"], incoming: AskMateSettings["noteHistoryStore"]): AskMateSettings["noteHistoryStore"] {
	const turns = mergeById<NoteHistoryTurn>(local.turns, incoming.turns, (a) => a);
	// Newest last, as the store keeps them.
	turns.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return { ...incoming, turns };
}

function mergeQueue(local: readonly ReviewQueueItem[], incoming: readonly ReviewQueueItem[]): ReviewQueueItem[] {
	return mergeById<ReviewQueueItem>(local, incoming, newerOf);
}

/**
 * The settings after another device's save arrived. The synced file decides every ordinary setting, because the person
 * changed those on the other device on purpose. The records that grow over time (threads, note history, review queue)
 * keep what only this device has, by id, and the newer copy wins when both have one. Merging twice gives the same
 * result, so two devices that both merge settle on the same file instead of passing it back and forth.
 */
export function mergeExternalSettings(local: AskMateSettings, incoming: AskMateSettings): AskMateSettings {
	return {
		...incoming,
		threadStore: mergeThreads(local.threadStore, incoming.threadStore),
		noteHistoryStore: mergeHistory(local.noteHistoryStore, incoming.noteHistoryStore),
		reviewQueue: mergeQueue(local.reviewQueue, incoming.reviewQueue)
	};
}
