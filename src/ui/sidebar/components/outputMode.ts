import type { OutputMode } from "../../../shared/types";

/**
 * Output mode is a choice for the next request, not a standing preference. A note or apply mode that stayed on would
 * turn a later, unrelated question into a write to the vault, so a non-chat mode is spent by the request that
 * uses it. A command that names its own mode (for example /note followed by a question) never touches the setting.
 */

export interface OutputModeUse {
	/** Mode the request will use. */
	mode: OutputMode;
	/** True when the mode came from the saved setting rather than from the command the user typed. */
	fromSetting: boolean;
}

/** The mode to save once a request has been built with `use`. Null leaves the setting alone. */
export function modeAfterRun(use: OutputModeUse): OutputMode | null {
	return use.fromSetting && use.mode !== "chat" ? "chat" : null;
}

export interface OutputBadge {
	label: string;
	title: string;
	/** State class suffix for the badge colour. */
	tone: "note" | "apply";
}

const BADGES: Record<Exclude<OutputMode, "chat">, OutputBadge> = {
	note: { label: "Next answer: new note", title: "The next answer is saved as a new note, then AskMate goes back to chat.", tone: "note" },
	apply: { label: "Next answer: apply to note", title: "The next answer is applied to the note after you approve it, then AskMate goes back to chat.", tone: "apply" }
};

/** A badge whenever the mode is not chat, so it is never a surprise. */
export function describeOutputBadge(mode: OutputMode): OutputBadge | null {
	return mode === "chat" ? null : BADGES[mode];
}
