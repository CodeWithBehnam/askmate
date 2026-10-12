/**
 * The three one-click starters shown once a provider is connected. They reach the headline features without the user
 * knowing a slash command. Each is disabled with a stated reason while no note is open, because every one of them
 * works on the note.
 */

export type StarterChipAction =
	/** Run a workflow by id; `fallbackPrompt` is sent as a plain question if the workflow no longer exists. */
	| { kind: "workflow"; workflowId: string; fallbackPrompt: string }
	/** Start the Mermaid diagram path (the same as typing /diagram). */
	| { kind: "diagram" }
	| { kind: "prompt"; prompt: string };

export interface StarterChip {
	id: "summarise" | "diagram" | "gaps";
	label: string;
	action: StarterChipAction;
	disabled: boolean;
	/** Shown as the tooltip while the chip is disabled; null when it is enabled. */
	disabledReason: string | null;
}

export const NO_NOTE_CHIP_REASON = "Open a note first.";

const STARTERS: ReadonlyArray<Omit<StarterChip, "disabled" | "disabledReason">> = [
	{
		id: "summarise",
		label: "Summarise this note",
		action: {
			kind: "workflow",
			workflowId: "study-summary",
			fallbackPrompt: "Summarise this note in a short list of key points."
		}
	},
	{
		id: "diagram",
		label: "Make a diagram",
		action: { kind: "diagram" }
	},
	{
		id: "gaps",
		label: "Find gaps",
		action: {
			kind: "prompt",
			prompt: "What is missing, unclear or unsupported in this note? List the gaps and suggest what to add."
		}
	}
];

export function starterChipsFor(hasOpenNote: boolean): StarterChip[] {
	return STARTERS.map((chip) => ({
		...chip,
		disabled: !hasOpenNote,
		disabledReason: hasOpenNote ? null : NO_NOTE_CHIP_REASON
	}));
}
