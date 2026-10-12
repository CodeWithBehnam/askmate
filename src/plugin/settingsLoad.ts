/**
 * What to do with the text of data.json, decided without touching the vault. A missing file is a fresh install, a file
 * that cannot be read as an object is corrupt (and must be backed up before defaults overwrite it), and a file that
 * changed because another device synced is merged with this device's threads, history and queue instead of replacing them.
 */
import { CURRENT_SETTINGS_VERSION } from "../settings/constants";
import { normalizeSettingsVersion } from "../settings/normalize";
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

function backupStamp(now: Date): string {
	return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/** data.json.corrupt-2026-10-12T09-11-00Z: UTC, and no colons, which Windows does not allow in a file name. */
export function corruptBackupName(now: Date): string {
	return `data.json.corrupt-${backupStamp(now)}`;
}

/** The copy of data.json kept when loading it cut saved conversations. */
export function trimBackupName(now: Date): string {
	return `data.json.before-trim-${backupStamp(now)}`;
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

export interface ExternalMergeOptions {
	/**
	 * The incoming file was saved before settings had a schema version (a 1.11.1 device). It cannot have chosen anything for
	 * the groups added since, so their absence is not a decision and this device keeps its own.
	 */
	incomingPredatesSchema?: boolean;
}

/** True when a stored file was written before settings were versioned, so it knows nothing of the groups added since. */
export function predatesSettingsSchema(stored: Partial<AskMateSettings>): boolean {
	return normalizeSettingsVersion(stored.settingsVersion) < CURRENT_SETTINGS_VERSION;
}

/**
 * The settings after another device's save arrived. The synced file decides every ordinary setting, because the person
 * changed those on the other device on purpose. The records that grow over time (threads, note history, review queue)
 * keep what only this device has, by id, and the newer copy wins when both have one. A deletion cannot be told apart from
 * a record the other device never had, so a record deleted on one device returns from a device that still holds it.
 */
export function mergeExternalSettings(local: AskMateSettings, incoming: AskMateSettings, options: ExternalMergeOptions = {}): AskMateSettings {
	const merged: AskMateSettings = {
		...incoming,
		threadStore: mergeThreads(local.threadStore, incoming.threadStore),
		noteHistoryStore: mergeHistory(local.noteHistoryStore, incoming.noteHistoryStore),
		reviewQueue: mergeQueue(local.reviewQueue, incoming.reviewQueue)
	};
	if (!options.incomingPredatesSchema) {
		return merged;
	}
	return {
		...merged,
		skills: local.skills,
		diagrams: local.diagrams,
		mcp: local.mcp,
		firstRunCompletedAt: local.firstRunCompletedAt,
		lastSeenVersion: local.lastSeenVersion
	};
}

function withoutActiveThread(settings: AskMateSettings): AskMateSettings {
	return { ...settings, threadStore: { ...settings.threadStore, activeId: null } };
}

/**
 * True when the merge holds something the incoming file lacks, so writing it back gives the other device the union.
 * Which conversation is open is per device, so a difference there alone is not news: counting it would make two devices
 * with different open conversations rewrite the file for each other for as long as both run.
 */
export function mergeAddsToIncoming(merged: AskMateSettings, incoming: AskMateSettings): boolean {
	return JSON.stringify(withoutActiveThread(merged)) !== JSON.stringify(withoutActiveThread(incoming));
}
