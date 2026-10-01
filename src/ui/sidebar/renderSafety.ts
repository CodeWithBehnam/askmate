/**
 * Pure helpers that make model output safe to pass to Obsidian's MarkdownRenderer.
 *
 * Model output can be steered by prompt injection in note or attachment content, so it must not be
 * able to make the sidebar load remote resources (which would leak data through the URL) or run
 * code-block processors from other plugins (for example `dataviewjs`, which runs arbitrary JS).
 *
 * The parser here is deliberately conservative: when it is unsure whether text is code, it treats it
 * as rendered Markdown and neutralises it. The cost of a wrong guess is a cosmetic change inside a
 * code example; the reply's original text stays available through "Show reply text".
 */

/** Fence languages that only get syntax highlighting, with no known code-block processor. */
export const PLAIN_CODE_LANGUAGES: ReadonlySet<string> = new Set([
	"text", "txt", "plain", "plaintext", "markdown", "md", "log", "console", "output",
	"javascript", "js", "jsx", "mjs", "cjs", "typescript", "ts", "tsx", "mts", "cts",
	"json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "scss", "sass", "less",
	"python", "py", "bash", "sh", "shell", "zsh", "fish", "powershell", "ps1", "bat", "batch", "cmd",
	"sql", "graphql", "gql", "java", "kotlin", "kt", "kts", "scala", "groovy", "gradle",
	"c", "h", "cpp", "c++", "cc", "cxx", "hpp", "csharp", "cs", "c#", "fsharp", "fs", "go", "golang",
	"rust", "rs", "ruby", "rb", "php", "perl", "pl", "lua", "r", "swift", "objectivec", "objc", "dart",
	"elixir", "ex", "exs", "erlang", "erl", "haskell", "hs", "clojure", "clj", "ocaml", "ml", "julia", "jl",
	"matlab", "vb", "vbnet", "nim", "zig", "solidity", "sol", "diff", "patch", "dockerfile", "docker",
	"makefile", "make", "cmake", "nginx", "apache", "properties", "env", "dotenv", "csv", "tsv",
	"latex", "tex", "bibtex", "regex", "vim", "proto", "protobuf", "hcl", "terraform", "tf", "nix", "http",
	"vue", "svelte", "handlebars", "hbs", "jinja", "jinja2", "liquid", "twig", "elm", "lisp", "scheme",
	"racket", "prolog", "fortran", "cobol", "pascal", "delphi", "ada", "asm", "nasm", "wasm", "glsl", "hlsl",
	"verilog", "vhdl", "crystal", "coffeescript", "coffee", "awk", "applescript", "arduino",
	// Rendered by Obsidian core rather than third-party plugins, and common in replies (diagrams, formulas).
	"mermaid", "math"
]);

/** Label given to fences whose language could trigger a code-block processor. */
export const NEUTRAL_CODE_LANGUAGE = "text";

/** Raw HTML elements that load network resources, or style or redirect the page, on render. */
const NETWORK_TAG_NAMES: ReadonlySet<string> = new Set([
	"img", "image", "iframe", "frame", "frameset", "video", "audio", "source", "embed", "object", "applet",
	"picture", "link", "style", "track", "svg", "base", "meta", "script", "portal", "bgsound"
]);

/** Raw HTML code elements, which Dataview evaluates like Markdown code spans (`<code>$= ...</code>`). */
const CODE_TAG_NAMES: ReadonlySet<string> = new Set(["code", "pre"]);

const NETWORK_ATTRIBUTE_PATTERN = /[\s"'/](?:src|srcset|lowsrc|dynsrc|background|poster|data|codebase|xlink:href|formaction)\s*=/i;
const CSS_RESOURCE_PATTERN = /url\s*\(|image-set\s*\(|@import/i;
const MERMAID_REMOTE_PATTERN = /\/\/|\\\/|\\x2f|\\u002f|&#|&sol;/i;
const ZERO_WIDTH_SPACE = "\u200B";
const MAX_IMAGE_SCAN_CHARACTERS = 4000;
const MAX_IMAGE_CLOSE_CANDIDATES = 64;

type BlockState =
	| { kind: "normal" }
	| { kind: "fence"; marker: "`" | "~"; length: number }
	| { kind: "html"; end: RegExp | null }
	| { kind: "comment" }
	| { kind: "math" }
	| { kind: "frontmatter" };

interface ProtectedRange {
	start: number;
	end: number;
	kind: "fence" | "span";
}

/** Lines inside a raw HTML block, which reach the browser's lenient HTML tokenizer unparsed. */
interface TextRange {
	start: number;
	end: number;
}

interface TextEdit {
	start: number;
	end: number;
	text: string;
}

interface FenceOpener {
	marker: "`" | "~";
	length: number;
	language: string;
}

/**
 * Rewrites model output so rendering it cannot fetch remote resources or run code-block processors.
 *
 * - Remote inline and reference-style images become ordinary links labelled "Remote image".
 * - Raw HTML tags that load resources are escaped so they render as text.
 * - Fenced code whose language is not a plain highlighting language is relabelled as `text`.
 * - Code that starts with Dataview's inline query prefixes (`=` and `$=`) is defused.
 * - Code spans, fenced code (other than the two points above) and vault embeds (`![[...]]`) are left alone.
 */
export function sanitizeModelMarkdown(markdown: string): string {
	const normalized = markdown.replace(/\r\n?/g, "\n");
	const { text, ranges, htmlRanges } = processBlocks(normalized);
	const definitions = collectReferenceDefinitions(text);
	const edits = collectInlineEdits(text, ranges, htmlRanges, definitions);
	return applyEdits(text, edits);
}

/** True for image targets that load nothing from the network: vault-relative paths and `data:image/` URIs. */
export function isSafeImageDestination(destination: string): boolean {
	const trimmed = destination.trim();
	if (/^<?data:image\//i.test(trimmed)) {
		return true;
	}

	// Any scheme, entity or escape could become a remote URL once decoded, so only plain relative paths pass.
	return !/[:\\&]/.test(trimmed) && !/^<?\/\//.test(trimmed);
}

function processBlocks(markdown: string): { text: string; ranges: ProtectedRange[]; htmlRanges: TextRange[] } {
	const lines = markdown.split("\n");
	const output: string[] = [];
	const ranges: ProtectedRange[] = [];
	const htmlRanges: TextRange[] = [];
	let state: BlockState = lines[0]?.trim() === "---" && lines.length > 1 ? { kind: "frontmatter" } : { kind: "normal" };
	let offset = 0;
	let spansTrusted = true;
	let guardNextContentLine = false;

	lines.forEach((line, index) => {
		let result = line;
		let lineProtected = false;
		const isBlank = line.trim() === "";
		const startState: BlockState = state;
		let lineIsHtml = startState.kind === "html";

		if (startState.kind === "fence") {
			lineProtected = true;
			if (isFenceCloser(line, startState.marker, startState.length)) {
				state = { kind: "normal" };
				guardNextContentLine = false;
			} else if (guardNextContentLine && !isBlank) {
				result = guardDataviewPrefix(line);
				guardNextContentLine = false;
			}
		} else if (startState.kind === "frontmatter" && index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) {
			state = { kind: "normal" };
			spansTrusted = false;
		} else {
			const { prefix, rest } = splitContainerPrefix(line);
			const opener = parseFenceOpener(rest);

			if (opener) {
				const neutralise = opener.language.toLowerCase() === "mermaid"
					&& fenceBodyHasRemoteReference(lines, index + 1, opener, startState.kind === "normal" && prefix === "");
				result = prefix + relabelFenceLine(rest, opener, neutralise);
				guardNextContentLine = true;
				if (startState.kind === "normal" && prefix === "") {
					state = { kind: "fence", marker: opener.marker, length: opener.length };
					lineProtected = true;
				}
			} else {
				if (guardNextContentLine && !isBlank) {
					result = prefix + guardDataviewPrefix(rest);
					guardNextContentLine = false;
				} else if (!isBlank && /^\s*(?:\$=|=(?!=))(?!\s*$)/.test(rest)) {
					// Indented code blocks are <pre><code> too, and Dataview reads their whole text.
					result = prefix + guardDataviewPrefix(rest);
				}

				state = advanceBlockState(startState, line, rest);
				lineIsHtml ||= state.kind === "html" || (startState.kind === "normal" && detectHtmlBlockStart(rest) !== undefined);
				if (startState.kind === "normal" && state.kind === "normal" && spansTrusted && !isBlank) {
					const scan = scanInlineCodeSpans(result);
					for (const [start, end] of scan.spans) {
						ranges.push({ start: offset + start, end: offset + end, kind: "span" });
					}
					if (scan.unclosed) {
						spansTrusted = false;
					}
				} else if (startState.kind !== "normal" || state.kind !== "normal") {
					spansTrusted = false;
				}
			}
		}

		if (lineProtected) {
			ranges.push({ start: offset, end: offset + result.length, kind: "fence" });
		}
		if (lineIsHtml && !isBlank) {
			htmlRanges.push({ start: offset, end: offset + result.length });
		}
		if (isBlank && state.kind === "normal") {
			spansTrusted = true;
		}

		output.push(result);
		offset += result.length + 1;
	});

	return { text: output.join("\n"), ranges: ranges.sort((left, right) => left.start - right.start), htmlRanges };
}

function advanceBlockState(state: BlockState, line: string, rest: string): BlockState {
	if (state.kind === "html") {
		if (state.end ? state.end.test(line) : line.trim() === "") {
			return { kind: "normal" };
		}
		return state;
	}
	if (state.kind === "frontmatter" || state.kind === "fence") {
		return state;
	}

	const commentMarkers = countOccurrences(line, "%%");
	const mathMarkers = countOccurrences(line, "$$");
	if (state.kind === "comment") {
		return commentMarkers % 2 === 1 ? { kind: "normal" } : state;
	}
	if (state.kind === "math") {
		return mathMarkers % 2 === 1 ? { kind: "normal" } : state;
	}

	const htmlEnd = detectHtmlBlockStart(rest);
	if (htmlEnd !== undefined) {
		if (htmlEnd && htmlEnd.test(line)) {
			return { kind: "normal" };
		}
		return { kind: "html", end: htmlEnd };
	}
	if (commentMarkers % 2 === 1) {
		return { kind: "comment" };
	}
	if (mathMarkers % 2 === 1) {
		return { kind: "math" };
	}
	return state;
}

/** Returns the end condition of an HTML block that starts on this line, null for "ends at a blank line", or undefined. */
function detectHtmlBlockStart(rest: string): RegExp | null | undefined {
	if (!/^<[A-Za-z/!?]/.test(rest)) {
		return undefined;
	}

	const raw = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
	if (raw) {
		return new RegExp(`</${raw[1]}>`, "i");
	}
	if (rest.startsWith("<!--")) {
		return /-->/;
	}
	if (rest.startsWith("<?")) {
		return /\?>/;
	}
	if (rest.startsWith("<![CDATA[")) {
		return /\]\]>/;
	}
	if (/^<![A-Za-z]/.test(rest)) {
		return />/;
	}
	// Any other tag may start an HTML block (quoted ">" and multi-line tags defeat exact matching), so treat it
	// as one: the following lines lose fence and code-span protection and are sanitised until a blank line.
	if (/^<\/?[A-Za-z]/.test(rest)) {
		return null;
	}
	return undefined;
}

function splitContainerPrefix(line: string): { prefix: string; rest: string } {
	const match = /^(?:[ \t]*>|[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*/.exec(line);
	const prefix = match?.[0] ?? "";
	return { prefix, rest: line.slice(prefix.length) };
}

function parseFenceOpener(rest: string): FenceOpener | null {
	const match = /^(`{3,}|~{3,})(.*)$/.exec(rest);
	if (!match) {
		return null;
	}

	const fence = match[1];
	const info = match[2];
	const marker = fence.startsWith("`") ? "`" : "~";
	if (marker === "`" && info.includes("`")) {
		return null;
	}

	return { marker, length: fence.length, language: info.trim().split(/\s+/)[0] ?? "" };
}

/**
 * Mermaid can load remote images (for example `A@{ img: "https://..." }`), so a diagram whose body holds a URL,
 * or an escaped or encoded slash that could become one, is shown as code. Only a top-level fence has a reliable
 * end; for any other fence the rest of the reply is checked.
 */
function fenceBodyHasRemoteReference(lines: string[], start: number, opener: FenceOpener, topLevel: boolean): boolean {
	for (let index = start; index < lines.length; index += 1) {
		if (topLevel && isFenceCloser(lines[index], opener.marker, opener.length)) {
			return false;
		}
		if (MERMAID_REMOTE_PATTERN.test(lines[index])) {
			return true;
		}
	}
	return false;
}

function relabelFenceLine(rest: string, opener: FenceOpener, force = false): string {
	if (!opener.language || (!force && PLAIN_CODE_LANGUAGES.has(opener.language.toLowerCase()))) {
		return rest;
	}

	const fenceText = rest.slice(0, opener.length);
	const info = rest.slice(opener.length);
	const languageIndex = info.indexOf(opener.language);
	return `${fenceText}${info.slice(0, languageIndex)}${NEUTRAL_CODE_LANGUAGE}${info.slice(languageIndex + opener.language.length)}`;
}

function isFenceCloser(line: string, marker: "`" | "~", length: number): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[1].startsWith(marker) && match[1].length >= length);
}

/** Dataview runs code whose trimmed text starts with `=` (DQL) or `$=` (JS); a zero-width space defuses it. */
function guardDataviewPrefix(text: string): string {
	return text.replace(/^(\s*)(?=\$?=)/, `$1${ZERO_WIDTH_SPACE}`);
}

interface InlineScan {
	spans: Array<[number, number]>;
	unclosed: boolean;
}

/**
 * Finds code spans on one line. Constructs that bind tighter than or alongside code spans (raw HTML tags,
 * autolinks, link destinations, comments and maths) are skipped, and an unclosed one stops the scan, so a
 * backtick that only looks like a code span delimiter never protects text from sanitising.
 */
function scanInlineCodeSpans(line: string): InlineScan {
	const spans: Array<[number, number]> = [];
	let index = 0;

	while (index < line.length) {
		const char = line[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "`") {
			const runLength = countRun(line, index, "`");
			const closeIndex = findBacktickRun(line, index + runLength, runLength);
			if (closeIndex === -1) {
				return { spans, unclosed: true };
			}
			spans.push([index, closeIndex + runLength]);
			index = closeIndex + runLength;
			continue;
		}

		const skipTo = findOpaqueInlineEnd(line, index);
		if (skipTo === -1) {
			return { spans, unclosed: true };
		}
		index = skipTo ?? index + 1;
	}

	return { spans, unclosed: false };
}

function findOpaqueInlineEnd(line: string, index: number): number | null {
	const char = line[index];
	const next = line[index + 1] ?? "";

	if (char === "<" && /[A-Za-z/!?]/.test(next)) {
		const tag = findTagEnd(line, index, line.length);
		return tag.ambiguous ? -1 : tag.end + 1;
	}
	if (char === "%" && next === "%") {
		const end = line.indexOf("%%", index + 2);
		return end === -1 ? -1 : end + 2;
	}
	if (char === "$") {
		const delimiter = next === "$" ? "$$" : "$";
		const end = findUnescaped(line, delimiter, index + delimiter.length);
		return end === -1 ? -1 : end + delimiter.length;
	}
	if (char === "]" && next === "(") {
		const naiveEnd = findClosingParen(line, index + 1, line.length);
		const end = findLinkDestinationEnd(line, index + 1, line.length);
		// `<...>` destinations and titles may contain ")"; when the two readings disagree, stop trusting spans.
		return naiveEnd === -1 || end !== naiveEnd ? -1 : end + 1;
	}
	return null;
}

interface TagEnd {
	end: number;
	/** True when unterminated, or when a quoted ">" makes parsers disagree about where the tag ends. */
	ambiguous: boolean;
}

function findTagEnd(text: string, index: number, limit: number): TagEnd {
	const naiveEnd = text.indexOf(">", index + 1);
	let quote: string | null = null;
	for (let cursor = index + 1; cursor < limit; cursor += 1) {
		const char = text[cursor];
		if (quote) {
			if (char === quote) {
				quote = null;
			}
		} else if (char === "\"" || char === "'") {
			quote = char;
		} else if (char === ">") {
			return { end: cursor, ambiguous: cursor !== naiveEnd };
		}
	}
	return { end: -1, ambiguous: true };
}

/** Index of the ")" closing a CommonMark inline link destination and optional title, or -1. */
function findLinkDestinationEnd(text: string, parenIndex: number, limit: number): number {
	let cursor = skipWhitespace(text, parenIndex + 1, limit);
	if (text[cursor] === "<") {
		cursor += 1;
		while (cursor < limit && text[cursor] !== ">") {
			if (text[cursor] === "<" || text[cursor] === "\n") {
				return -1;
			}
			cursor += text[cursor] === "\\" ? 2 : 1;
		}
		if (cursor >= limit) {
			return -1;
		}
		cursor += 1;
	} else {
		let depth = 0;
		while (cursor < limit && !/\s/.test(text[cursor])) {
			const char = text[cursor];
			if (char === "\\") {
				cursor += 2;
				continue;
			}
			if (char === "(") {
				depth += 1;
			} else if (char === ")") {
				if (depth === 0) {
					break;
				}
				depth -= 1;
			}
			cursor += 1;
		}
	}

	cursor = skipWhitespace(text, cursor, limit);
	const titleOpener = text[cursor];
	if (titleOpener === "\"" || titleOpener === "'" || titleOpener === "(") {
		const titleCloser = titleOpener === "(" ? ")" : titleOpener;
		cursor += 1;
		while (cursor < limit && text[cursor] !== titleCloser) {
			cursor += text[cursor] === "\\" ? 2 : 1;
		}
		if (cursor >= limit) {
			return -1;
		}
		cursor = skipWhitespace(text, cursor + 1, limit);
	}
	return text[cursor] === ")" && cursor < limit ? cursor : -1;
}

function skipWhitespace(text: string, from: number, limit: number): number {
	let cursor = from;
	while (cursor < limit && /\s/.test(text[cursor])) {
		cursor += 1;
	}
	return cursor;
}

function collectReferenceDefinitions(text: string): Map<string, boolean> {
	const unsafeByLabel = new Map<string, boolean>();
	const pattern = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+[ \t>]*)?\[((?:[^\]\\\n]|\\.)+)\]:[ \t]*\n?[ \t>]*(<[^>\n]*>|\S+)/gm;

	for (const match of text.matchAll(pattern)) {
		const label = normalizeReferenceLabel(match[1]);
		const unsafe = !isSafeImageDestination(match[2]);
		unsafeByLabel.set(label, (unsafeByLabel.get(label) ?? false) || unsafe);
	}

	return unsafeByLabel;
}

function normalizeReferenceLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectInlineEdits(
	text: string,
	ranges: ProtectedRange[],
	htmlRanges: TextRange[],
	definitions: Map<string, boolean>
): TextEdit[] {
	const edits: TextEdit[] = [];
	let rangeIndex = 0;
	let htmlIndex = 0;
	let index = 0;

	while (index < text.length) {
		while (rangeIndex < ranges.length && ranges[rangeIndex].end <= index) {
			rangeIndex += 1;
		}
		const range = ranges[rangeIndex];
		if (range && range.start <= index) {
			if (range.kind === "span" && index === range.start) {
				const guard = dataviewSpanGuard(text, range);
				if (guard) {
					edits.push(guard);
				}
			}
			index = range.end;
			continue;
		}

		const char = text[index];
		if (char === "`") {
			// Unprotected backticks may still form a code span in Obsidian's parser.
			const runEnd = index + countRun(text, index, "`");
			if (/^\s*\$?=/.test(text.slice(runEnd, runEnd + 16))) {
				edits.push({ start: runEnd, end: runEnd, text: ZERO_WIDTH_SPACE });
			}
			index = runEnd;
			continue;
		}
		if (char === "!" && text[index + 1] === "[" && !isVaultEmbed(text, index) && !isEscaped(text, index)) {
			edits.push(...remoteImageEdits(text, index, definitions));
			index += 2;
			continue;
		}
		if (char === "<" && !isEscaped(text, index)) {
			while (htmlIndex < htmlRanges.length && htmlRanges[htmlIndex].end <= index) {
				htmlIndex += 1;
			}
			const inHtmlBlock = htmlRanges[htmlIndex] !== undefined && htmlRanges[htmlIndex].start <= index;
			const edit = networkTagEdit(text, index, inHtmlBlock);
			if (edit) {
				edits.push(edit);
			}
		}
		if (char === "]" && text[index + 1] === ":" && !isEscaped(text, index) && hasRemoteDefinitionDestination(text, index + 2)) {
			// Label matching cannot follow every parser (multi-line labels, nested containers, Unicode case
			// folding), so break every remote reference definition instead. "\]" still renders as "]".
			edits.push({ start: index, end: index, text: "\\" });
		}
		index += 1;
	}

	return edits;
}

/** Reads the destination after a `]:` (on the same line or the next one) and reports whether it could load remotely. */
function hasRemoteDefinitionDestination(text: string, from: number): boolean {
	const match = /^[ \t]*(?:\n[ \t>]*)?(<[^>\n]*>|\S+)/.exec(text.slice(from, from + 2048));
	return Boolean(match && !isSafeImageDestination(match[1]));
}

/** `![[...]]` embeds resolve inside the vault. One followed by `(` or `[` may also parse as a Markdown image. */
function isVaultEmbed(text: string, bangIndex: number): boolean {
	if (text[bangIndex + 2] !== "[") {
		return false;
	}
	const lineEnd = text.indexOf("\n", bangIndex);
	const closeIndex = text.indexOf("]]", bangIndex + 3);
	if (closeIndex === -1 || (lineEnd !== -1 && closeIndex > lineEnd)) {
		return false;
	}
	const next = text[closeIndex + 2];
	return next !== "(" && next !== "[";
}

function dataviewSpanGuard(text: string, range: ProtectedRange): TextEdit | null {
	const runEnd = range.start + countRun(text, range.start, "`");
	if (!/^\s*\$?=/.test(text.slice(runEnd, range.end))) {
		return null;
	}
	return { start: runEnd, end: runEnd, text: ZERO_WIDTH_SPACE };
}

function remoteImageEdits(text: string, bangIndex: number, definitions: Map<string, boolean>): TextEdit[] {
	const openIndex = bangIndex + 1;
	const closeIndex = findUnsafeImageClose(text, openIndex, definitions);
	if (closeIndex === -1) {
		return [];
	}

	const edits: TextEdit[] = [];
	if (bangIndex > 0 && text[bangIndex - 1] === "!" && !isEscaped(text, bangIndex - 1)) {
		// Otherwise the preceding "!" would turn the new link back into an image.
		edits.push({ start: bangIndex - 1, end: bangIndex - 1, text: "\\" });
	}

	const alt = text.slice(openIndex + 1, closeIndex);
	if (alt.trim()) {
		edits.push({ start: bangIndex, end: openIndex + 1, text: "[Remote image: " });
	} else {
		edits.push({ start: bangIndex, end: closeIndex, text: "[Remote image" });
	}
	return edits;
}

/**
 * Returns the index of a closing bracket that would make `![` at openIndex load a remote image, or -1.
 * Every plausible closer is checked, not just the one a CommonMark parser would pick, so code spans,
 * HTML or nested brackets inside the alt text cannot hide the real destination.
 */
function findUnsafeImageClose(text: string, openIndex: number, definitions: Map<string, boolean>): number {
	const { limit, truncated } = findScanLimit(text, openIndex);
	let depth = 0;
	let candidates = 0;
	let uncertain = false;

	for (let index = openIndex + 1; index < limit; index += 1) {
		const char = text[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "`" || char === "<" || char === "$" || char === "%") {
			uncertain = true;
		}
		if (char === "[") {
			depth += 1;
			continue;
		}
		if (char !== "]") {
			continue;
		}

		candidates += 1;
		if (candidates > MAX_IMAGE_CLOSE_CANDIDATES) {
			return index;
		}

		const alt = text.slice(openIndex + 1, index);
		const verdict = classifyImageCandidate(text, index, limit, alt, definitions);
		if (verdict === "unsafe") {
			return index;
		}
		if (verdict === "complete" && depth === 0 && !uncertain) {
			return -1;
		}
		depth -= 1;
	}

	// The paragraph goes on past the scan window, so the real closer was never examined.
	return truncated ? limit : -1;
}

function classifyImageCandidate(
	text: string,
	closeIndex: number,
	limit: number,
	alt: string,
	definitions: Map<string, boolean>
): "unsafe" | "complete" | "incomplete" {
	const next = text[closeIndex + 1];

	if (next === "(") {
		const naiveClose = findClosingParen(text, closeIndex + 1, limit);
		const destinationClose = findLinkDestinationEnd(text, closeIndex + 1, limit);
		const contentEnd = Math.max(naiveClose, destinationClose);
		if (contentEnd === -1) {
			// An unterminated destination is not an image in CommonMark; treat it as unsafe in case a parser disagrees.
			return isSafeImageDestination(text.slice(closeIndex + 2, limit)) ? "incomplete" : "unsafe";
		}
		// Check the longer reading, so a ")" inside `<...>` or a title cannot hide a remote URL after it.
		if (!isSafeImageDestination(text.slice(closeIndex + 2, contentEnd))) {
			return "unsafe";
		}
		return naiveClose === destinationClose ? "complete" : "incomplete";
	}

	if (next === "[") {
		const labelEnd = text.indexOf("]", closeIndex + 2);
		if (labelEnd === -1 || labelEnd >= limit) {
			return "incomplete";
		}
		const label = text.slice(closeIndex + 2, labelEnd).trim() || alt;
		return classifyReference(label, definitions);
	}

	return classifyReference(alt, definitions);
}

function classifyReference(label: string, definitions: Map<string, boolean>): "unsafe" | "complete" | "incomplete" {
	const unsafe = definitions.get(normalizeReferenceLabel(label));
	if (unsafe === undefined) {
		return "incomplete";
	}
	return unsafe ? "unsafe" : "complete";
}

/**
 * Escapes the "<" of raw HTML that could load a resource or form a code element. Inside raw HTML blocks the
 * browser's lenient tokenizer reads the text (`<b$ style=...>` is a tag there), so every candidate is checked.
 */
function networkTagEdit(text: string, index: number, inHtmlBlock: boolean): TextEdit | null {
	const match = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(text.slice(index, index + 80));
	if (!match) {
		return null;
	}

	const name = match[1].toLowerCase();
	const localName = name.slice(name.lastIndexOf(":") + 1);
	if (NETWORK_TAG_NAMES.has(localName) || CODE_TAG_NAMES.has(localName)) {
		return { start: index, end: index + 1, text: "&lt;" };
	}

	const tagLimit = Math.min(text.length, index + 2000);
	const tag = findTagEnd(text, index, tagLimit);
	const tagText = text.slice(index, tag.end === -1 ? tagLimit : tag.end + 1);
	// In Markdown, other names only form a tag with whitespace, "/" or ">" after the name and no unquoted "<"
	// before its end. Skipping the rest keeps maths such as $a<b$ intact when a later tag carries src= or url(.
	const afterName = text[index + match[0].length];
	if (!inHtmlBlock && afterName !== undefined && !/[\s/>]/.test(afterName)) {
		return null;
	}
	if (!inHtmlBlock && /<[A-Za-z/!?]/.test(stripQuoted(tagText.slice(1)))) {
		return null;
	}
	if (!NETWORK_ATTRIBUTE_PATTERN.test(tagText) && !CSS_RESOURCE_PATTERN.test(tagText)) {
		return null;
	}

	return { start: index, end: index + 1, text: "&lt;" };
}

function stripQuoted(text: string): string {
	return text.replace(/"[^"]*"|'[^']*'/g, "");
}

function findScanLimit(text: string, from: number): { limit: number; truncated: boolean } {
	const blankLine = /\n[ \t]*\n/g;
	blankLine.lastIndex = from;
	const match = blankLine.exec(text);
	const paragraphEnd = match ? match.index : text.length;
	const windowEnd = from + MAX_IMAGE_SCAN_CHARACTERS;
	return { limit: Math.min(paragraphEnd, windowEnd), truncated: paragraphEnd > windowEnd };
}

function findClosingParen(text: string, openIndex: number, limit: number): number {
	let depth = 0;
	for (let index = openIndex; index < limit; index += 1) {
		const char = text[index];
		if (char === "\\") {
			index += 1;
		} else if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function findBacktickRun(line: string, from: number, length: number): number {
	let index = line.indexOf("`", from);
	while (index !== -1) {
		const runLength = countRun(line, index, "`");
		if (runLength === length) {
			return index;
		}
		index = line.indexOf("`", index + runLength);
	}
	return -1;
}

function findUnescaped(line: string, needle: string, from: number): number {
	let index = line.indexOf(needle, from);
	while (index !== -1 && isEscaped(line, index)) {
		index = line.indexOf(needle, index + 1);
	}
	return index;
}

function countRun(text: string, index: number, char: string): number {
	let end = index;
	while (text[end] === char) {
		end += 1;
	}
	return end - index;
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

function applyEdits(text: string, edits: TextEdit[]): string {
	const ordered = [...edits].sort((left, right) => left.start - right.start || (left.end - left.start) - (right.end - right.start));
	let cursor = 0;
	let result = "";
	for (const edit of ordered) {
		if (edit.start < cursor) {
			continue;
		}
		result += text.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return result + text.slice(cursor);
}

/** Where a context image preview would load from. Only "vault" and "data" sources are ever displayed. */
export type ImagePreviewSourceKind = "vault" | "data" | "remote";

/** Image embed targets (`![[...]]` and `![alt](...)`) in document order. Plain links are not images and are ignored. */
export function extractImageEmbedTargets(markdown: string): string[] {
	const pattern = /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]*)\)/g;
	const targets: string[] = [];

	for (const match of markdown.matchAll(pattern)) {
		if (match.index !== undefined && isEscaped(markdown, match.index)) {
			continue;
		}
		const target = match[1] !== undefined
			? cleanImageTarget(match[1])
			: cleanImageTarget(stripLinkTitle(match[2] ?? ""));
		if (target) {
			targets.push(target);
		}
	}

	return targets;
}

export function classifyImagePreviewSource(target: string): ImagePreviewSourceKind {
	if (/^data:image\//i.test(target)) {
		return "data";
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("\\\\")) {
		return "remote";
	}
	return "vault";
}

/** A short caption for a data URI, so a multi-megabyte payload never ends up in alt text or captions. */
export function describeDataImage(target: string): string {
	const subtype = /^data:image\/([a-z0-9.+-]+)/i.exec(target)?.[1]?.toLowerCase();
	return subtype ? `Inline image (${subtype.replace(/\+xml$/, "")})` : "Inline image";
}

function stripLinkTitle(destination: string): string {
	const trimmed = destination.trim();
	if (trimmed.startsWith("<")) {
		const end = trimmed.indexOf(">");
		return end === -1 ? trimmed : trimmed.slice(1, end);
	}
	return trimmed.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
}

function cleanImageTarget(reference: string): string {
	let clean = reference.trim().replace(/^<(.+)>$/, "$1").replace(/^['"](.+)['"]$/, "$1").trim();
	if (/^data:/i.test(clean)) {
		return clean;
	}

	clean = clean.split("|")[0]?.split("#")[0]?.trim() ?? "";
	try {
		return decodeURI(clean);
	} catch {
		return clean;
	}
}
