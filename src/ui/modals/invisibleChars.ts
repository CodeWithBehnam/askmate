/**
 * Makes characters that a reader cannot see visible, so a diff or a skill review never hides what is really in the text.
 * Pure: it only rewrites a string.
 */

export interface MarkedText {
	/** The text with every hidden character replaced by a visible marker such as `[U+200B]`. */
	text: string;
	/** True when at least one character was replaced. */
	flagged: boolean;
	/** How many hidden characters were found. A run of tag characters counts once per character. */
	count: number;
}

// Tag characters spell ASCII text that no renderer shows; a run of them is the usual way to smuggle instructions.
const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
// C0 and C1 controls (tab, line feed and carriage return are ordinary text), the soft hyphen, the Mongolian vowel separator,
// zero-width and direction marks, the line and paragraph separators, bidi controls, invisible operators and the byte order mark.
const HIDDEN = new RegExp(
	[
		"\\u0000-\\u0008",
		"\\u000B\\u000C",
		"\\u000E-\\u001F",
		"\\u007F-\\u009F",
		"\\u00AD",
		"\\u180E",
		"\\u200B-\\u200F",
		"\\u2028\\u2029",
		"\\u202A-\\u202E",
		"\\u2060-\\u2064",
		"\\u2066-\\u2069",
		"\\uFEFF"
	].map((range) => `[${range}]`).join("|"),
	"g"
);

function codePointLabel(char: string): string {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The ASCII text a run of tag characters spells, with anything outside the printable range shown as a question mark. */
function decodeTagRun(run: string): string {
	return Array.from(run, (char) => {
		const offset = (char.codePointAt(0) ?? 0) - 0xe0000;
		return offset >= 0x20 && offset <= 0x7e ? String.fromCharCode(offset) : "?";
	}).join("");
}

export function markInvisibleCharacters(text: string): MarkedText {
	let count = 0;
	const withTags = text.replace(TAG_RUN, (run) => {
		count += Array.from(run).length;
		return `[tag characters spelling "${decodeTagRun(run)}"]`;
	});
	const marked = withTags.replace(HIDDEN, (char) => {
		count += 1;
		return `[${codePointLabel(char)}]`;
	});
	return { text: marked, flagged: count > 0, count };
}

/** True when the text holds any character that {@link markInvisibleCharacters} would replace. */
export function hasInvisibleCharacters(text: string): boolean {
	return markInvisibleCharacters(text).flagged;
}
