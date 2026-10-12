import type { AskRequest, BuiltRetrySnapshot, DraftRetrySnapshot, ReasoningEffort, TextProviderId } from "../../../shared/types";
import type { RetryReason, RunController } from "../runController";

/**
 * What Retry needs to decide between sending the request it already built and building a new one. The ticket is made
 * when a request is first drafted and gains its built half once the request exists, so a failure at any stage can
 * be retried from the right place.
 */
export interface RetryTicket {
	draft: DraftRetrySnapshot;
	built: BuiltRetrySnapshot | null;
}

export interface SelectionSignatureParts {
	providerId: TextProviderId;
	model: string;
	effort: ReasoningEffort;
	/** Vault path of the note the request is about; empty when none. */
	notePath: string;
}

/** What a built request captured, as one comparable string. */
export function selectionSignature(parts: SelectionSignatureParts): string {
	return JSON.stringify([parts.providerId, parts.model, parts.effort, parts.notePath]);
}

export function requestSignature(request: AskRequest): string {
	return selectionSignature({
		providerId: request.metadata.providerId,
		model: request.metadata.selectedModel,
		effort: request.metadata.reasoningEffort,
		notePath: request.context.file?.path ?? ""
	});
}

export type RetryPlan =
	| { mode: "rebuild"; draft: DraftRetrySnapshot; reason: RetryReason }
	| { mode: "reuse"; request: AskRequest; draft: DraftRetrySnapshot };

/**
 * Reuses the built request only while the provider, model, effort and note it captured still hold and the snapshot is
 * recent. Otherwise the draft is built again, so a model change takes effect and a stale note is never resent.
 */
export function planRetry(ticket: RetryTicket, currentSignature: string, controller: Pick<RunController, "retryDecision">, now?: Date): RetryPlan {
	const built = ticket.built;
	const decision = controller.retryDecision({
		snapshotKind: built ? "built" : "draft",
		createdAt: built?.createdAt ?? ticket.draft.createdAt,
		capturedSignature: built ? requestSignature(built.request) : "",
		currentSignature,
		...(now ? { now } : {})
	});
	if (decision.mode === "reuse" && built) {
		return { mode: "reuse", request: built.request, draft: ticket.draft };
	}
	return { mode: "rebuild", draft: ticket.draft, reason: decision.reason };
}
