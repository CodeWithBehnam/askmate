import type {
	ActiveRun,
	AskRequest,
	BuiltRetrySnapshot,
	DraftRetrySnapshot,
	MutationOutcome,
	RetryRequestSnapshot,
	RunPhase,
	RunRequestOptions,
	SelectionIdentity,
	SelectionResolution
} from "./types";
import { createAbortError, findExactOccurrences } from "../settings/normalize";

export const DEFAULT_TEXT_GENERATION_TIMEOUT_MS = 120000;
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 300000;

export function awaitWithAbortAndTimeout<T>(
	request: Promise<T>,
	options: {
		abortSignal?: AbortSignal;
		timeoutMs?: number;
		timeoutMessage?: string;
	} = {}
): Promise<T> {
	const { abortSignal, timeoutMs, timeoutMessage = "Request timed out." } = options;
	if (abortSignal?.aborted) {
		return Promise.reject(createAbortError());
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finish = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== null) {
				clearTimeout(timer);
			}
			abortSignal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(createAbortError()));

		abortSignal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
		}

		void request.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error))
		);
	});
}

export function isRunIdentityCurrent(activeRun: ActiveRun | null, run: ActiveRun): boolean {
	return activeRun?.id === run.id;
}

export function canRunContinue(activeRun: ActiveRun | null, run: ActiveRun, isClosed: boolean): boolean {
	return !isClosed && !run.abortController.signal.aborted && isRunIdentityCurrent(activeRun, run);
}

export function withRunPhase(run: ActiveRun, phase: RunPhase): ActiveRun {
	return { ...run, phase };
}

export function createDraftRetrySnapshot(
	question: string,
	title: string,
	options: RunRequestOptions,
	createdAt = new Date().toISOString()
): DraftRetrySnapshot {
	return { kind: "draft", question, title, options, createdAt };
}

export function createBuiltRetrySnapshot(
	request: AskRequest,
	createdAt = new Date().toISOString()
): BuiltRetrySnapshot {
	return { kind: "built", request, createdAt };
}

export function getRetryRequest(snapshot: RetryRequestSnapshot): AskRequest | null {
	return snapshot.kind === "built" ? snapshot.request : null;
}

export function createSelectionIdentity(
	rawSelection: string,
	startOffset: number,
	endOffset: number,
	sourcePath: string,
	fullText = ""
): SelectionIdentity | null {
	const leadingWhitespace = rawSelection.length - rawSelection.trimStart().length;
	const text = rawSelection.trim();
	if (!text) {
		return null;
	}
	const adjustedStart = Math.max(0, startOffset + leadingWhitespace);
	const adjustedEnd = Math.min(endOffset, adjustedStart + text.length);
	return {
		text,
		startOffset: adjustedStart,
		endOffset: adjustedEnd,
		prefix: fullText.slice(Math.max(0, adjustedStart - 96), adjustedStart),
		suffix: fullText.slice(adjustedEnd, adjustedEnd + 96),
		sourcePath
	};
}

function anchorsMatch(currentText: string, identity: SelectionIdentity, startOffset: number): boolean {
	const prefix = identity.prefix ?? "";
	const suffix = identity.suffix ?? "";
	const prefixStart = Math.max(0, startOffset - prefix.length);
	const suffixStart = startOffset + identity.text.length;
	return currentText.slice(prefixStart, startOffset) === prefix
		&& currentText.slice(suffixStart, suffixStart + suffix.length) === suffix;
}

export function resolveSelectionIdentity(currentText: string, identity: SelectionIdentity): SelectionResolution {
	if (
		identity.startOffset >= 0
		&& identity.endOffset === identity.startOffset + identity.text.length
		&& currentText.slice(identity.startOffset, identity.endOffset) === identity.text
		&& anchorsMatch(currentText, identity, identity.startOffset)
	) {
		return { status: "exact", startOffset: identity.startOffset, endOffset: identity.endOffset };
	}

	const occurrences = findExactOccurrences(currentText, identity.text);
	const anchored = occurrences.filter((startOffset) => anchorsMatch(currentText, identity, startOffset));
	const candidates = identity.prefix || identity.suffix ? anchored : occurrences;
	if (candidates.length === 1) {
		const startOffset = candidates[0];
		return { status: "relocated", startOffset, endOffset: startOffset + identity.text.length };
	}

	return {
		status: candidates.length === 0 ? "missing" : "ambiguous",
		startOffset: null,
		endOffset: null
	};
}

export function appliedMutation(message: string, targetPath?: string): MutationOutcome {
	return { status: "applied", message, targetPath };
}

export function cancelledMutation(message: string): MutationOutcome {
	return { status: "cancelled", message };
}
