import type { ComposerLayout } from "../../../shared/types";

/**
 * The tip card tells a new person what to try first, and it must be true in the layout they are looking at. Slash
 * commands and @mentions work in every layout; Compact and Expanded also have a sparkles button for the workflows.
 */
export function onboardingTipText(layout: ComposerLayout): string {
	const where = "use the buttons under the box to choose where an answer goes";
	return layout === "console"
		? `Ask about the note you have open, type / to run a workflow or /diagram to draw one, and ${where}.`
		: `Ask about the note you have open, type / or press the Quick workflows button (the sparkles icon) to run a workflow, type /diagram to draw one, and ${where}.`;
}
