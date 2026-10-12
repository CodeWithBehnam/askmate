/**
 * Link policy for model and tool output.
 *
 * Rendered Markdown links are click-through. Obsidian opens `obsidian://` links without asking, and its `new`
 * action can overwrite a note, so a reply must not be able to offer one. Only vault-relative and http(s)
 * destinations are allowed to stay links; everything else is judged "blocked" and shown as inert text.
 */

export type LinkKind = "internal" | "http" | "blocked";

/** Named character references that matter for spelling a URL. Anything else stays undecoded and fails closed. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
	colon: ":", sol: "/", bsol: "\\", Tab: "\t", NewLine: "\n", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
	lpar: "(", rpar: ")", period: ".", num: "#", percnt: "%", commat: "@", excl: "!", semi: ";", equals: "=", quest: "?",
	lbrack: "[", rbrack: "]", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}", lbrace: "{", rbrace: "}", verbar: "|", vert: "|",
	comma: ",", plus: "+", hyphen: "-", dash: "-", lowbar: "_", grave: "`", Hat: "^", dollar: "$", ast: "*", midast: "*",
	nbsp: "\u00A0", NonBreakingSpace: "\u00A0", ThinSpace: "\u2009", ZeroWidthSpace: "\u200B"
};

const CHARACTER_REFERENCE = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([A-Za-z][A-Za-z0-9]{1,31});)/g;
// Controls, format characters (zero width, bidi, soft hyphen, tag characters) and separators are ignored inside a URL by parsers.
const IGNORED_CHARACTERS = /[\p{Cc}\p{Cf}\p{Z}]/gu;
const ASCII_PUNCTUATION_ESCAPE = /\\([!-/:-@[-`{-~])/g;

function decodeReferencesOnce(text: string): string {
	return text.replace(CHARACTER_REFERENCE, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
		if (name !== undefined) {
			return NAMED_REFERENCES[name] ?? match;
		}
		const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex ?? "", 16);
		return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\uFFFD";
	});
}

/** Decodes the way a Markdown parser and an HTML parser would, twice, so a doubly encoded colon is still found. */
function decodeCharacterReferences(text: string): string {
	return decodeReferencesOnce(decodeReferencesOnce(text));
}

/**
 * Brings a destination to the form a URL parser would act on: angle brackets removed, character references and
 * backslash escapes decoded, and everything a parser ignores (spaces, controls, zero-width and bidi characters) dropped.
 */
export function normaliseLinkDestination(raw: string): string {
	let value = raw.trim();
	if (value.startsWith("<") && value.endsWith(">")) {
		value = value.slice(1, -1);
	}
	return decodeCharacterReferences(value).replace(ASCII_PUNCTUATION_ESCAPE, "$1").replace(IGNORED_CHARACTERS, "");
}

function decodePercentEscapes(value: string): string {
	return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(IGNORED_CHARACTERS, "");
}

/** The leading segment of a destination ends at the first `/`, `?`, `#` or `\`. */
function leadingSegmentEnd(value: string): number {
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === "/" || char === "?" || char === "#" || char === "\\") {
			return index;
		}
	}
	return value.length;
}

/** Index of the colon that ends the leading segment, or -1 when the segment holds none. */
function schemeColonIndex(value: string): number {
	return value.slice(0, leadingSegmentEnd(value)).indexOf(":");
}

export interface LinkVerdict {
	kind: LinkKind;
	/**
	 * True when the destination is blocked because of its scheme, or because a scheme could be hiding in it. False for
	 * `internal` and `http`, and for a destination that is blocked only because it has an authority but no scheme
	 * (`//host` and UNC paths), which the click-time handler stops and the sanitiser leaves as an ordinary link.
	 */
	schemeBlocked: boolean;
}

const INTERNAL: LinkVerdict = { kind: "internal", schemeBlocked: false };
const HTTP: LinkVerdict = { kind: "http", schemeBlocked: false };
const SCHEME_BLOCKED: LinkVerdict = { kind: "blocked", schemeBlocked: true };
const AUTHORITY_BLOCKED: LinkVerdict = { kind: "blocked", schemeBlocked: false };

/** Judges a destination and says why, for callers that treat a blocked scheme and a bare authority differently. */
export function describeLinkDestination(href: string): LinkVerdict {
	const value = normaliseLinkDestination(href);
	if (value === "") {
		return INTERNAL;
	}
	if (value.startsWith("\\") || value.startsWith("//")) {
		return AUTHORITY_BLOCKED;
	}

	const decoded = decodePercentEscapes(value);
	if (decoded.startsWith("\\") || decoded.startsWith("//")) {
		return AUTHORITY_BLOCKED;
	}
	const colon = schemeColonIndex(value);
	if (colon === -1) {
		// Percent escapes that spell a scheme separator, or a character reference this decoder does not know,
		// could still turn into one in the parser that acts on the link.
		const segment = value.slice(0, leadingSegmentEnd(value));
		return schemeColonIndex(decoded) !== -1 || /&[A-Za-z][A-Za-z0-9]*;/.test(segment) ? SCHEME_BLOCKED : INTERNAL;
	}

	const scheme = value.slice(0, colon).toLowerCase();
	const isHttp = (scheme === "http" || scheme === "https") && /^\/\/[^\s/?#\\]/.test(value.slice(colon + 1));
	return isHttp ? HTTP : SCHEME_BLOCKED;
}

/**
 * Judges where a link destination leads. `internal` covers vault-relative paths and in-page anchors, `http` covers
 * http and https, and everything else is `blocked`: other schemes (obsidian, file, mailto, tel, javascript, data,
 * vscode), protocol-relative and UNC forms, and anything whose scheme cannot be read with certainty.
 */
export function classifyLinkDestination(href: string): LinkKind {
	return describeLinkDestination(href).kind;
}
