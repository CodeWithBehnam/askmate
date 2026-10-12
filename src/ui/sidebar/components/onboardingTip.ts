import type { ComposerLayout } from "../../../shared/types";

/**
 * The tip card tells a new person what to try first, and it must be true in the layout they are looking at. Only the
 * Console reads a leading slash as a workflow command; Compact and Expanded run workflows from the sparkles button
 * (/diagram and /image work in every layout).
 */
export function onboardingTipText(layout: ComposerLayout): string {
	const where = "use the buttons under the box to choose where an answer goes";
	return layout === "console"
		? `Ask about the note you have open, type / to run a workflow or /diagram to draw one, and ${where}.`
		: `Ask about the note you have open, press the sparkles button to run a workflow or type /diagram to draw one, and ${where}.`;
}
