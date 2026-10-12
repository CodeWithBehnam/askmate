import { isReadyToSend, type SetupStage } from "./setupState";

/**
 * First-run rules. A fresh install is the one case where `loadData()` returns null, so that is the only signal used;
 * an existing `data.json`, even an empty object, belongs to a returning user and keeps its settings and layout.
 */

export function isFirstRun(raw: unknown): boolean {
	return raw === null || raw === undefined;
}

export const FIRST_RUN_NOTICE = {
	message: "AskMate is installed. Connect an AI provider to start.",
	actionLabel: "Set up"
} as const;

export interface FirstRunSettings {
	/** Set by the shell once the user has connected a provider or dismissed the notice. */
	firstRunCompletedAt?: string | null;
}

/** Shows the one-time notice only on a fresh install that is not yet connected and has not been dismissed before. */
export function shouldShowFirstRunNotice(input: {
	firstRun: boolean;
	settings: FirstRunSettings;
	stage: SetupStage;
}): boolean {
	return input.firstRun && !input.settings.firstRunCompletedAt && !isReadyToSend(input.stage);
}
