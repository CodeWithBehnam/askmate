import { classifyLinkDestination } from "../../../safety/links";
import { decideInternalLink, type InternalLinkDecision, type InternalLinkInput } from "../internalLink";

/**
 * What a click on any link inside the transcript does. Rendered Markdown links are click-through, and Obsidian opens
 * `obsidian://` links without asking, so the view listens in the capture phase, before Obsidian's own handlers, and
 * decides first: web links keep their normal behaviour, vault links open only a note that exists, and every other
 * kind of link is stopped.
 */

export const BLOCKED_LINK_MESSAGE = "AskMate does not open this kind of link from an answer.";

export interface LinkClickInput extends InternalLinkInput {
	/** True for an anchor Obsidian marked as a link to a note (`internal-link`), whose target is a note path and not a URL. */
	internalClass: boolean;
}

export type LinkClickDecision =
	| { kind: "ignore" }
	| { kind: "block"; message: string }
	| { kind: "internal"; decision: InternalLinkDecision };

export function decideLinkClick(input: LinkClickInput): LinkClickDecision {
	const raw = input.rawHref?.trim() ?? "";
	if (!raw) {
		return { kind: "ignore" };
	}
	if (input.internalClass) {
		return { kind: "internal", decision: decideInternalLink(input) };
	}
	const kind = classifyLinkDestination(raw);
	if (kind === "blocked") {
		return { kind: "block", message: BLOCKED_LINK_MESSAGE };
	}
	if (kind === "http") {
		return { kind: "ignore" };
	}
	return { kind: "internal", decision: decideInternalLink(input) };
}
