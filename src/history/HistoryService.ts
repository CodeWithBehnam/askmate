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
		const selectionIdentity = normalizedScope === "selected-block" ? request.context.selectionIdentity ?? null : null;
		if (normalizedScope === "selected-block" && (!selectionIdentity || selectionIdentity.sourcePath !== file.path)) {
			throw new Error("Review queue requires the original selected-text identity. Select the text again, then queue the reply.");
		}
		if (normalizedScope === "heading-section") {
			throw new Error("Heading-section review queueing is not safe yet. Apply to the heading directly instead.");
		}
		const currentContent = normalizedScope === "selected-block" ? "" : await this.host.readFileText(file.path);
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
		settings.reviewQueue = normalizeReviewQueueItems([...settings.reviewQueue, item], settings.reviewQueueMaxItems);
		await this.host.saveSettings();
		return item;
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
