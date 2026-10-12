/**
 * Where a generated image's embed goes in a note. Every route (an open editor, a closed note, a selection) plans through
 * the same placement rules, so the embed never splits a sentence, lands above the frontmatter or inside a code fence,
 * and always uses the note's own line endings.
 */
import { planImageInsertion } from "../output";
import { resolveSelectionIdentity } from "../shared/core";
import type { SelectionIdentity } from "../shared/types";

export type EmbedAnchor =
	/** After the text the person selected when they asked. */
	| { kind: "selection"; identity: SelectionIdentity }
	/** At a cursor position. */
	| { kind: "offset"; offset: number }
	/** At the end of the note, for a note that is not open. */
	| { kind: "end" };

export type EmbedPlan =
	| { kind: "insert"; offset: number; text: string }
	/** The selected text is no longer where it was, so there is nothing to place the image after. */
	| { kind: "selection-changed" }
	/** The note ends inside a code fence that was never closed, so the embed would become code. */
	| { kind: "open-fence" };

export function planEmbedInsertion(note: string, embed: string, anchor: EmbedAnchor): EmbedPlan {
	let cursor: number;
	if (anchor.kind === "selection") {
		const end = resolveSelectionIdentity(note, anchor.identity).endOffset;
		if (end === null) {
			return { kind: "selection-changed" };
		}
		cursor = end;
	} else {
		cursor = anchor.kind === "offset" ? anchor.offset : note.length;
	}
	const plan = planImageInsertion(note, cursor, embed);
	return plan.insideOpenFence ? { kind: "open-fence" } : { kind: "insert", offset: plan.offset, text: plan.text };
}
