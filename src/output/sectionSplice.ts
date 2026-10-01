export interface SectionBodyRange {
	bodyStartLine: number;
	endLineExclusive: number;
}

export interface SectionBodySplice {
	/** The exact text being replaced, for the Apply preview. */
	before: string;
	next: string;
}

interface SectionBodyParts {
	lines: string[];
	eol: string;
	leading: string[];
	core: string[];
	trailing: string[];
}

function isBlankLine(line: string): boolean {
	return line.trim() === "";
}

function splitSectionBody(content: string, range: SectionBodyRange): SectionBodyParts {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	const body = lines.slice(range.bodyStartLine, range.endLineExclusive);
	const first = body.findIndex((line) => !isBlankLine(line));
	if (first === -1) {
		// An empty section gets a blank line after its heading and keeps (or gains) one before the next heading.
		const trailing = body.length > 0 ? body : range.endLineExclusive < lines.length ? [""] : [];
		return { lines, eol, leading: [""], core: [], trailing };
	}
	let last = body.length - 1;
	while (last > first && isBlankLine(body[last])) {
		last -= 1;
	}
	return { lines, eol, leading: body.slice(0, first), core: body.slice(first, last + 1), trailing: body.slice(last + 1) };
}

/** The section's text without its surrounding blank lines, in the note's own line endings. */
export function getHeadingSectionCore(content: string, range: SectionBodyRange): string {
	const parts = splitSectionBody(content, range);
	return parts.core.join(parts.eol);
}

/**
 * Replaces only the section's content lines, so the blank line before the next heading, the note's final newline and
 * its CRLF or LF line endings survive the Apply.
 */
export function spliceHeadingSectionBody(content: string, range: SectionBodyRange, output: string): SectionBodySplice {
	const { lines, eol, leading, core, trailing } = splitSectionBody(content, range);
	const next = [
		...lines.slice(0, range.bodyStartLine),
		...leading,
		...output.split(/\r?\n/),
		...trailing,
		...lines.slice(range.endLineExclusive)
	].join(eol);
	return { before: core.join(eol), next };
}

/** Compares note text across editor (LF) and file (possibly CRLF) reads, ignoring outer whitespace as context capture does. */
export function isSameNoteText(a: string, b: string): boolean {
	return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}
