import { stripImageReferences } from "../requests/promptSafety";
import { planBlockInsertion, type BlockInsertionPlan } from "../safety/markdownFences";
import type { RequestPrivacyOptions } from "../shared/types";

/**
 * Returns why a reply must not replace note text, or null when replacing is allowed. Replacing text the model never
 * saw (omitted by the privacy controls) would overwrite real content with a blind answer.
 */
export function getReplaceBlockReason(privacy: RequestPrivacyOptions, targetText: string): string | null {
	if (!privacy.includeNoteContext) {
		return "The model did not see this text, so AskMate will not replace it. Use append instead.";
	}
	if (!privacy.includeImageReferences && stripImageReferences(targetText) !== targetText) {
		return "Image references were hidden from the model, so it could not keep them. AskMate will not replace text that contains images. Use append instead, or allow image references in the privacy settings and ask again.";
	}
	return null;
}

/**
 * Obsidian mutates a TFile in place on rename, so the path recorded in a selection identity can be older than
 * the file's current path. The same file object is still the original note.
 */
export function isOriginalSelectionNote(identitySourcePath: string, targetFile: object | null, requestFile: object | null): boolean {
	if (targetFile === null) {
		return false;
	}
	if (requestFile !== null && targetFile === requestFile) {
		return true;
	}
	return (targetFile as { path?: string }).path === identitySourcePath;
}

export type ImageInsertionPlan = BlockInsertionPlan;

export { planBlockInsertion };

/**
 * Plans where an image embed can go for a cursor position without splitting a sentence, entering frontmatter or
 * landing inside a code fence. The embed goes after the paragraph or block the cursor is in, separated by blank lines,
 * in the note's own line endings. Callers that insert at a selection end or at the end of a note should plan through
 * this too, so the embed cannot split a sentence or land in a trailing unclosed fence unnoticed.
 */
export function planImageInsertion(text: string, cursorOffset: number, embed: string): ImageInsertionPlan {
	return planBlockInsertion(text, cursorOffset, embed);
}

/** Result folder for smart placement: reuses the parent when it already is the AskMate folder, so it never nests. */
export function chooseSmartResultFolder(parentPath: string, folderName = "AskMate"): string {
	const parent = parentPath === "/" ? "" : parentPath;
	const lastSegment = parent.split("/").pop() ?? "";
	if (lastSegment.toLowerCase() === folderName.toLowerCase()) {
		return parent;
	}
	return parent ? `${parent}/${folderName}` : folderName;
}
