import type {
	ApplyScope,
	AskMateSettings,
	AskRequest,
	NoteHistoryTurn,
	ReviewQueueItem
} from "../shared/types";
import {
	MAX_NOTE_HISTORY_ANSWER_CHARACTERS,
	MAX_NOTE_HISTORY_QUESTION_CHARACTERS,
	MAX_NOTE_HISTORY_TURNS,
	MAX_REVIEW_QUEUE_TEXT_CHARACTERS,
	normalizeNoteHistoryStore,
	normalizeReviewQueueItems,
	resolveApplyScope
} from "../shared/core";
import { isSameNoteText } from "../output/sectionSplice";

export type HistoryServiceHost = {
	getSettings: () => AskMateSettings;
	saveSettings: () => Promise<void>;
	readFileText: (path: string) => Promise<string>;
};

export class HistoryService {
	constructor(private readonly host: HistoryServiceHost) {}

	async recordNoteHistoryTurn(request: AskRequest, answer: string, model: string): Promise<void> {
		const settings = this.host.getSettings();
		if (!settings.noteHistoryEnabled || !request.context.file?.path) {
			return;
		}
		const turn: NoteHistoryTurn = {
			id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			sourcePath: request.context.file.path,
			createdAt: new Date().toISOString(),
			title: request.title,
			question: request.question.slice(0, MAX_NOTE_HISTORY_QUESTION_CHARACTERS),
			answer: answer.slice(0, MAX_NOTE_HISTORY_ANSWER_CHARACTERS),
			providerName: request.metadata.providerName,
			model,
			outputMode: request.metadata.outputMode,
			intentKind: request.metadata.intentKind
		};
		const normalizedTurns = normalizeNoteHistoryStore(settings.noteHistoryStore).turns;
		const previousStore = settings.noteHistoryStore;
		const existing = normalizedTurns.filter((item) => item.sourcePath !== turn.sourcePath);
		const forNote = normalizedTurns.filter((item) => item.sourcePath === turn.sourcePath).concat(turn).slice(-settings.noteHistoryMaxTurnsPerNote);
		settings.noteHistoryStore = { turns: [...existing, ...forNote].slice(-MAX_NOTE_HISTORY_TURNS) };
		try {
			await this.host.saveSettings();
		} catch (error) {
			settings.noteHistoryStore = previousStore;
			console.warn("AskMate could not save note history.", error);
		}
	}

	getNoteHistoryForPath(sourcePath: string): NoteHistoryTurn[] {
		if (!sourcePath) {
			return [];
		}
		return normalizeNoteHistoryStore(this.host.getSettings().noteHistoryStore).turns.filter((turn) => turn.sourcePath === sourcePath);
	}

	async clearNoteHistoryForPath(sourcePath: string): Promise<void> {
		const settings = this.host.getSettings();
		settings.noteHistoryStore = {
			turns: normalizeNoteHistoryStore(settings.noteHistoryStore).turns.filter((turn) => turn.sourcePath !== sourcePath)
		};
		await this.host.saveSettings();
	}

	async queueReviewItemFromRequest(request: AskRequest, proposedText: string, model: string, scope: ApplyScope = "auto"): Promise<ReviewQueueItem> {
		const settings = this.host.getSettings();
		const file = request.context.file;
		if (!file || file.extension !== "md") {
			throw new Error("Review queue requires a source Markdown note.");
		}
		const normalizedScope = resolveApplyScope(scope, request.context.source);
		const primaryTruncated = request.metadata.primaryContextTruncated ?? request.metadata.contextTruncated;
		if (primaryTruncated && normalizedScope !== "append") {
			throw new Error("The note or selection was shortened by the context budget, so this reply may leave out text and was not queued as a replacement. Switch to a larger context budget and ask again, or queue it as an append.");
		}
		const incompleteReason = request.metadata.outputIncompleteReason;
		if (incompleteReason && normalizedScope !== "append") {
			throw new Error(`This reply is incomplete (${incompleteReason}), so AskMate will not queue it to replace note text. Ask again, or Apply it as an append.`);
		}
		const selectionIdentity = normalizedScope === "selected-block" ? request.context.selectionIdentity ?? null : null;
		if (normalizedScope === "selected-block" && (!selectionIdentity || selectionIdentity.sourcePath !== file.path)) {
			throw new Error("Review queue requires the original selected-text identity. Select the text again, then queue the reply.");
		}
		if (normalizedScope === "heading-section") {
			throw new Error("Heading-section review queueing is not safe yet. Apply to the heading directly instead.");
		}
		this.assertReviewQueueHasRoom(settings);
		const currentContent = normalizedScope === "selected-block" ? "" : await this.host.readFileText(file.path);
		// A full-note proposal was written against the note as it was when the request was built. If the user edited the note
		// while the model was answering, applying the proposal later would silently discard those edits.
		if (normalizedScope === "full-note" && request.context.source === "Current note" && !isSameNoteText(request.context.content, currentContent)) {
			throw new Error("The note changed while AskMate was answering, so this full-note suggestion was not queued. Ask again to get a suggestion for the current note.");
		}
		const beforeText = normalizedScope === "selected-block" ? "" : currentContent;
		if (proposedText.length > MAX_REVIEW_QUEUE_TEXT_CHARACTERS || beforeText.length > MAX_REVIEW_QUEUE_TEXT_CHARACTERS) {
			throw new Error("Review queue item is too large. Apply it directly or reduce the output size.");
		}
		const now = new Date().toISOString();
		const item: ReviewQueueItem = {
			id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			createdAt: now,
			updatedAt: now,
			status: "pending",
			sourcePath: file.path,
			title: request.title,
			question: request.question.slice(0, 2000),
			proposedText: proposedText.trim(),
			beforeText,
			scope: normalizedScope,
			headingPath: "",
			selectionIdentity,
			providerName: request.metadata.providerName,
			model,
			workflowId: request.metadata.workflowId,
			workflowName: request.metadata.workflowName
		};
		// Re-check after the file read: another queue action may have filled the queue meanwhile.
		this.assertReviewQueueHasRoom(settings);
		settings.reviewQueue = normalizeReviewQueueItems([...settings.reviewQueue, item], settings.reviewQueueMaxItems);
		await this.host.saveSettings();
		return item;
	}

	private assertReviewQueueHasRoom(settings: AskMateSettings): void {
		const pending = normalizeReviewQueueItems(settings.reviewQueue, settings.reviewQueueMaxItems).filter((item) => item.status === "pending").length;
		if (pending >= settings.reviewQueueMaxItems) {
			throw new Error(`The review queue already has ${pending} pending items (limit ${settings.reviewQueueMaxItems}). Apply or dismiss items before queueing more.`);
		}
	}

	/** Moves note history and review items with the note, including notes inside a renamed folder. */
	async handleFileRenamed(oldPath: string, newPath: string): Promise<void> {
		const settings = this.host.getSettings();
		const movePath = (path: string): string => isSameOrInside(path, oldPath) ? `${newPath}${path.slice(oldPath.length)}` : path;
		const turns = normalizeNoteHistoryStore(settings.noteHistoryStore).turns;
		const queue = normalizeReviewQueueItems(settings.reviewQueue, settings.reviewQueueMaxItems);
		const affected = turns.some((turn) => isSameOrInside(turn.sourcePath, oldPath)) || queue.some((item) => isSameOrInside(item.sourcePath, oldPath));
		if (!affected) {
			return;
		}
		settings.noteHistoryStore = { turns: turns.map((turn) => ({ ...turn, sourcePath: movePath(turn.sourcePath) })) };
		settings.reviewQueue = queue.map((item) => ({
			...item,
			sourcePath: movePath(item.sourcePath),
			selectionIdentity: item.selectionIdentity ? { ...item.selectionIdentity, sourcePath: movePath(item.selectionIdentity.sourcePath) } : null
		}));
		await this.host.saveSettings();
	}

	/** A deleted note's history and queued proposals can no longer be used, and keeping its content would outlive the note. */
	async handleFileDeleted(path: string): Promise<{ removedPendingItems: number }> {
		const settings = this.host.getSettings();
		const turns = normalizeNoteHistoryStore(settings.noteHistoryStore).turns;
		const queue = normalizeReviewQueueItems(settings.reviewQueue, settings.reviewQueueMaxItems);
		const keptTurns = turns.filter((turn) => !isSameOrInside(turn.sourcePath, path));
		const keptQueue = queue.filter((item) => !isSameOrInside(item.sourcePath, path));
		const removedPendingItems = queue.filter((item) => item.status === "pending" && isSameOrInside(item.sourcePath, path)).length;
		if (keptTurns.length === turns.length && keptQueue.length === queue.length) {
			return { removedPendingItems: 0 };
		}
		settings.noteHistoryStore = { turns: keptTurns };
		settings.reviewQueue = keptQueue;
		await this.host.saveSettings();
		return { removedPendingItems };
	}

	getPendingReviewQueueItems(): ReviewQueueItem[] {
		const settings = this.host.getSettings();
		return normalizeReviewQueueItems(settings.reviewQueue, settings.reviewQueueMaxItems).filter((item) => item.status === "pending");
	}

	async dismissReviewQueueItem(id: string): Promise<void> {
		const settings = this.host.getSettings();
		settings.reviewQueue = normalizeReviewQueueItems(settings.reviewQueue, settings.reviewQueueMaxItems).map((item) =>
			item.id === id ? { ...item, status: "dismissed" as const, updatedAt: new Date().toISOString() } : item
		);
		await this.host.saveSettings();
	}
}

function isSameOrInside(path: string, target: string): boolean {
	return path === target || path.startsWith(`${target}/`);
}
