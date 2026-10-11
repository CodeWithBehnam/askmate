import { stripImageReferences } from "../requests/promptSafety";
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

export type ImageInsertionPlan = { offset: number; text: string };

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

type Line = { start: number; end: number; text: string };

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		lines.push({ start, end, text: text.slice(start, end).replace(/\r$/, "") });
		if (newline === -1) {
			break;
		}
		start = newline + 1;
	}
	return lines;
}

/** Offset just after the frontmatter block, or 0 when the note has none. */
function frontmatterEnd(lines: Line[]): number {
	if (lines[0]?.text.trimEnd() !== "---") {
		return 0;
	}
	const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
	return close === -1 ? 0 : lines[close].end;
}

/**
 * Plans where an image embed can go for a cursor position without splitting a sentence, entering frontmatter or
 * landing inside a code fence. The embed goes after the paragraph or block the cursor is in, separated by blank lines.
 */
export function planImageInsertion(text: string, cursorOffset: number, embed: string): ImageInsertionPlan {
	const lines = splitLines(text);
	const clamped = Math.max(0, Math.min(text.length, cursorOffset));
	const frontmatterBoundary = frontmatterEnd(lines);
	let offset = Math.max(clamped, frontmatterBoundary);
	let lineIndex = lines.findIndex((line) => offset >= line.start && offset <= line.end);
	if (lineIndex === -1) {
		lineIndex = lines.length - 1;
	}

	const fenceBounds = findFenceContaining(lines, lineIndex, frontmatterBoundary);
	if (fenceBounds !== null) {
		lineIndex = fenceBounds.closeIndex;
		offset = lines[lineIndex].end;
	} else if (offset === frontmatterBoundary && frontmatterBoundary > 0 && clamped <= frontmatterBoundary) {
		// Frontmatter is its own block, so the embed follows it directly.
		offset = frontmatterBoundary;
	} else if (lines[lineIndex].text.trim() !== "") {
		let last = lineIndex;
		while (last + 1 < lines.length && lines[last + 1].text.trim() !== "" && !FENCE_PATTERN.test(lines[last + 1].text)) {
			last += 1;
		}
		offset = lines[last].end;
	} else {
		offset = lines[lineIndex].start;
	}

	const before = text.slice(0, offset);
	const rest = text.slice(offset);
	const prefix = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
	const suffix = rest.startsWith("\n\n") ? "" : "\n";
	return { offset, text: `${prefix}${embed}${suffix}` };
}

/** Finds the fenced block that contains `lineIndex` (including its fence lines). An unclosed fence runs to the end. */
function findFenceContaining(lines: Line[], lineIndex: number, frontmatterBoundary: number): { closeIndex: number } | null {
	let open: { marker: string; length: number; openIndex: number } | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (frontmatterBoundary > 0 && line.end <= frontmatterBoundary) {
			continue;
		}
		const match = FENCE_PATTERN.exec(line.text);
		if (open === null) {
			if (match) {
				open = { marker: match[1][0], length: match[1].length, openIndex: index };
			}
			continue;
		}
		const closes = match !== null && match[1][0] === open.marker && match[1].length >= open.length && line.text.trim() === match[1];
		if (closes) {
			if (lineIndex >= open.openIndex && lineIndex <= index) {
				return { closeIndex: index };
			}
			open = null;
		}
	}
	return open !== null && lineIndex >= open.openIndex ? { closeIndex: lines.length - 1 } : null;
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
