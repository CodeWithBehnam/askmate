import { mapProviderErrorToSetupCopy, type ErrorCopyContext, type SetupAction } from "../../../setup";

/**
 * A failed request, said once in plain words with the button that fixes it. Provider and transport failures are mapped
 * (a rejected key, a server that is not running, a model that does not exist). Anything AskMate itself raised already
 * reads as a sentence, so it is shown as it is and only offered a retry.
 */

export interface ErrorPresentation {
	message: string;
	/** The original text, shortened, for a details disclosure; null when the message is the original. */
	detail: string | null;
	/** The button that fixes the cause. Null when only retrying makes sense. */
	fix: SetupAction | null;
	mapped: boolean;
}

/** Where the failure happened: only errors from the provider call are worth translating. */
export type ErrorStage = "build" | "provider";

export function presentRunError(error: unknown, plainMessage: string, stage: ErrorStage, context: ErrorCopyContext): ErrorPresentation {
	if (stage !== "provider") {
		return { message: plainMessage, detail: null, fix: null, mapped: false };
	}
	const copy = mapProviderErrorToSetupCopy(error, context);
	if (copy.category === "unknown") {
		return { message: plainMessage, detail: null, fix: null, mapped: false };
	}
	// "Try again" is what Retry already is, so it is not repeated as a second button.
	const fix = copy.action.kind === "retry" ? null : copy.action;
	return { message: copy.message, detail: copy.detail && copy.detail !== copy.message ? copy.detail : null, fix, mapped: true };
}
