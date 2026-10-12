/**
 * Decisions for a batch run that need no Obsidian: when to give up after repeated failures, and what a result note is
 * called. A batch of a hundred notes with a wrong key would otherwise fail a hundred times, one paid retry at a time.
 */

export type BatchFailureKind = "auth" | "guardrail" | "other";

/** Consecutive authentication or guardrail failures that end a batch. Other failures are per note and never end it. */
export const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

const AUTH_PATTERN = /\b(?:401|403)\b|api key|authenticat|unauthori[sz]ed|forbidden|add an? [a-z ]+ key/i;
// The wording of UsageService.evaluateUsageGuardrails blockers ("Daily budget would exceed...", "Request estimate exceeds the
// hard limit of..."). A bare "budget" is not enough: the context budget of a long note is a per-note problem, not a guardrail.
const GUARDRAIL_PATTERN = /usage guardrail|\b(?:daily|monthly) budget\b|exceeds the hard limit of/i;

/** Sorts a failure by its message. Provider and guardrail errors are plain sentences, so the text is all there is to read. */
export function classifyBatchFailure(message: string): BatchFailureKind {
	if (GUARDRAIL_PATTERN.test(message)) {
		return "guardrail";
	}
	return AUTH_PATTERN.test(message) ? "auth" : "other";
}

export interface BatchRunState {
	/** Failures of the same stopping kind in a row. A success or a different failure starts the count again. */
	consecutive: number;
	kind: BatchFailureKind | null;
}

export const INITIAL_BATCH_STATE: BatchRunState = { consecutive: 0, kind: null };

export interface BatchDecision {
	state: BatchRunState;
	/** Sentence for the summary when the batch should stop now, otherwise null. */
	stopReason: string | null;
}

/** Folds one note's outcome into the run state and says whether to go on. `failure` is null for a success. */
export function nextBatchDecision(state: BatchRunState, failure: BatchFailureKind | null): BatchDecision {
	if (failure === null || failure === "other") {
		return { state: INITIAL_BATCH_STATE, stopReason: null };
	}
	const consecutive = state.kind === failure ? state.consecutive + 1 : 1;
	const next: BatchRunState = { consecutive, kind: failure };
	if (consecutive < MAX_CONSECUTIVE_BATCH_FAILURES) {
		return { state: next, stopReason: null };
	}
	const cause = failure === "auth"
		? "the provider rejected the request"
		: "the usage guardrails blocked it";
	return {
		state: next,
		stopReason: `${MAX_CONSECUTIVE_BATCH_FAILURES} notes in a row failed because ${cause}. Fix that, then run the batch again.`
	};
}

/** "Study summary - Meeting notes": every note of a batch gets its own name, so results never share a title. */
export function batchResultTitle(workflowName: string, sourceBasename: string): string {
	const workflow = workflowName.trim();
	const source = sourceBasename.trim();
	return workflow && source ? `${workflow} - ${source}` : workflow || source || "AskMate result";
}

/** Why a batch that found nothing says so, instead of reporting zero completed notes as if it had run. */
export function describeEmptyBatch(folderPath: string, folderExists: boolean): string {
	const folder = folderPath.trim() || "the vault root";
	return folderExists
		? `No Markdown notes were found in ${folder}.`
		: `The folder ${folder} does not exist in this vault.`;
}
