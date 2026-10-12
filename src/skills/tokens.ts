/**
 * Word handling shared by the manifest checks and the matcher: lower case, accents removed, a small English
 * stop list, light stemming and British/American spelling folded together.
 */

const STOPWORDS = new Set((
	"a an and are as at be by for from has have how i in into is it its me my of on or our so that the their them then there these this to " +
	"up use used using want was we what when where which who why will with would you your can could should please also just make made get give " +
	"need needs note notes page text one some any all not no do does did if than too very about after before over per via"
).split(" "));

/** Latin combining accents, written as an escape string so the source holds no invisible characters. */
export const COMBINING_MARKS = new RegExp("[\\u0300-\\u036F]", "g");

const SPELLING_VARIANTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(.{3,})is(e|ed|es|ing|ation)$/, "$1iz$2"],
	[/^(col|fav|behavi|hon|neighb|flav|hum|lab)our/, "$1or"]
];

function foldSpelling(token: string): string {
	return SPELLING_VARIANTS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), token);
}

/** Drops a final silent e from a longer word, so "translate", "translated" and "translating" share one stem. */
const dropSilentE = (word: string): string => (word.length > 4 && word.endsWith("e") ? word.slice(0, -1) : word);

function stem(token: string): string {
	const folded = foldSpelling(token);
	if (folded.length <= 4) {
		return folded;
	}
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (folded.endsWith(suffix) && folded.length - suffix.length >= 4) {
			return dropSilentE(folded.slice(0, -suffix.length));
		}
	}
	return dropSilentE(folded);
}

/**
 * Splits text into comparable terms. `keepStopwords` is for phrase matching, so "what did I do this week" cannot
 * collapse to the single word "week".
 */
export function tokenise(text: string, keepStopwords = false): string[] {
	const words = text.toLowerCase().normalize("NFKD").replace(COMBINING_MARKS, "").match(/[\p{L}\p{N}]+/gu) ?? [];
	return words
		.filter((word) => keepStopwords || (word.length > 1 && !STOPWORDS.has(word)))
		.map(stem);
}
