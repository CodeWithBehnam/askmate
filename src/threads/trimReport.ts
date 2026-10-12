import {
	MAX_SAVED_MESSAGE_CHARACTERS,
	MAX_THREAD_STORE_BYTES,
	normalizeSavedMessage,
	normalizeSavedThread,
	type ThreadStore
} from "./threadModel";

/** What loading cut from the saved conversations to keep them within the caps. All zero when nothing was cut. */
export interface ThreadStoreTrim {
	/** Whole conversations that no longer fit (the oldest go first). */
	threadsDropped: number;
	/** Conversations that lost their oldest messages. */
	threadsShortened: number;
	/** Single replies cut to the per-message cap. */
	messagesShortened: number;
}

const NO_TRIM: ThreadStoreTrim = { threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 };
const EPOCH = "1970-01-01T00:00:00.000Z";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text lengths of the messages in a stored thread that are usable at all, oldest first. */
function usableMessageLengths(rawThread: Record<string, unknown>): number[] {
	const messages: unknown[] = Array.isArray(rawThread.messages) ? rawThread.messages : [];
	return messages.flatMap((message) => normalizeSavedMessage(message, EPOCH) !== null && isRecord(message) && typeof message.text === "string" ? [message.text.length] : []);
}

/**
 * Compares the conversations as they were stored with what remained after normalisation, so a cap that removes someone's
 * text is reported instead of applied silently. Malformed entries and duplicates are not counted: they were never usable.
 */
export function measureThreadStoreTrim(stored: unknown, kept: ThreadStore): ThreadStoreTrim {
	if (!isRecord(stored) || !Array.isArray(stored.threads)) {
		return NO_TRIM;
	}
	const keptById = new Map(kept.threads.map((thread) => [thread.id, thread]));
	const seen = new Set<string>();
	let threadsDropped = 0;
	let threadsShortened = 0;
	let messagesShortened = 0;
	for (const entry of stored.threads as unknown[]) {
		const usable = normalizeSavedThread(entry);
		if (!usable || !isRecord(entry) || seen.has(usable.id)) {
			continue;
		}
		seen.add(usable.id);
		const survivor = keptById.get(usable.id);
		if (!survivor) {
			threadsDropped += 1;
			continue;
		}
		const lengths = usableMessageLengths(entry);
		if (survivor.messages.length < lengths.length) {
			threadsShortened += 1;
		}
		messagesShortened += lengths.slice(lengths.length - survivor.messages.length).filter((length) => length > MAX_SAVED_MESSAGE_CHARACTERS).length;
	}
	return { threadsDropped, threadsShortened, messagesShortened };
}

function count(value: number, singular: string, plural: string): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * The notice for a load that cut text, or null when it cut nothing. `backupName` is the copy of the file as it was, or null
 * when no copy could be made.
 */
export function describeThreadStoreTrim(trim: ThreadStoreTrim, backupName: string | null): string | null {
	const parts = [
		...(trim.threadsDropped > 0 ? [`${count(trim.threadsDropped, "of the oldest conversations was", "of the oldest conversations were")} removed`] : []),
		...(trim.threadsShortened > 0 ? [`${count(trim.threadsShortened, "conversation lost", "conversations lost")} its oldest messages`] : []),
		...(trim.messagesShortened > 0 ? [`${count(trim.messagesShortened, "long reply was", "long replies were")} shortened`] : [])
	];
	if (parts.length === 0) {
		return null;
	}
	const megabytes = MAX_THREAD_STORE_BYTES / (1024 * 1024);
	const copy = backupName ? ` A copy of the file as it was is saved as ${backupName} in the plugin folder.` : "";
	return `AskMate keeps saved conversations within ${megabytes} MB. ${parts.join(", ")}.${copy}`;
}
