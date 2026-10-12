/**
 * Pure helpers that make model output safe to pass to Obsidian's MarkdownRenderer, or to write into a note.
 *
 * Model output can be steered by prompt injection in note or attachment content, so it must not be able to make
 * the sidebar load remote resources (which would leak data through the URL), offer a click-through link to another
 * app, or run code-block processors from other plugins (for example `dataviewjs`, which runs arbitrary JS).
 *
 * The parser here is deliberately conservative: when it is unsure whether text is code, it treats it as rendered
 * Markdown and neutralises it. The cost of a wrong guess is a cosmetic change inside a code example; the reply's
 * original text stays available through "Show reply text". Where a fence starts and ends comes from the shared fence
 * scanner, and a fence is only copied through unread when that reading and the line-by-line one agree (see
 * processBlocks). Edits can change how the rest of the text is read, so passes repeat until one changes nothing.
 * Scanning has a total work budget, and what is left unchecked when the budget runs out is neutralised rather than
 * trusted.
 */

import { createFinding, findingKey, type Finding } from "./findings";
import { describeLinkDestination } from "./links";
import { findLenientFenceCloser, scanFences, type FenceSpan } from "./markdownFences";
import { mermaidGuardFailure, validateMermaidSource, type GuardResult } from "./mermaidGuard";
import { computeLineStarts, countOccurrences, countRun, createNextIndexOf, createScanBudget, indentWidth, isEscaped, lineNumberAt, type ScanBudget } from "./scan";

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

/** Raw HTML elements that load network resources, or style, submit or redirect the page, on render. */
const NETWORK_TAG_NAMES: ReadonlySet<string> = new Set([
	"img", "image", "iframe", "frame", "frameset", "video", "audio", "source", "embed", "object", "applet",
	"picture", "link", "style", "track", "svg", "base", "meta", "script", "portal", "bgsound", "form"
]);

/** Raw HTML code elements, which Dataview evaluates like Markdown code spans (`<code>$= ...</code>`). */
const CODE_TAG_NAMES: ReadonlySet<string> = new Set(["code", "pre"]);

/** Elements whose content matters as much as the tag (CSS in a style, script text, fallback markup, Dataview code). */
const PAIRED_TAG_NAMES: ReadonlySet<string> = new Set([
	"iframe", "frameset", "video", "audio", "object", "applet", "picture", "style", "svg", "script", "portal", "form", "code", "pre"
]);

const NETWORK_ATTRIBUTE_PATTERN = /[\s"'/](?:src|srcset|lowsrc|dynsrc|background|poster|data|codebase|xlink:href|formaction|ping)\s*=/i;
const CSS_RESOURCE_PATTERN = /url\s*\(|image-set\s*\(|@import/i;
const HREF_ATTRIBUTE_PATTERN = /[\s"'/]href\s*=\s*("[^"]*"|'[^']*'|[^\s"'<>`]+)/gi;
const ZERO_WIDTH_SPACE = "\u200B";
// MathJax's html extension turns these into links, element ids, classes and inline styles (and so into resource loads).
const MATH_ACTIVE_COMMAND = /\\(?=(?:href|url|style|class|cssId)(?![A-Za-z]))/y;
const MATH_ACTIVE_COMMANDS = /(?<!\\)((?:\\\\)*)\\(?=(?:href|url|style|class|cssId)(?![A-Za-z]))/g;
const MAX_IMAGE_SCAN_CHARACTERS = 4000;
const MAX_IMAGE_CLOSE_CANDIDATES = 64;
/** A tag longer than this is judged by the part that fits, then escaped when its end is still not in sight. */
const MAX_TAG_SCAN_CHARACTERS = 20000;
const MAX_LINK_BACKSCAN_CHARACTERS = 2000;
/** The longest construct (fence, tag, destination, template tag) that the write path compares in full. */
const MAX_IDENTITY_CHARACTERS = 20_000;
/** How far a construct that runs to the end of its paragraph (inline maths, an unprotected code span) is read. */
const MAX_BLOCK_TAIL_CHARACTERS = 2000;
const MAX_DEFINITION_CHARACTERS = 2048;
const MAX_UNPARSED_DESTINATION_CHARACTERS = 2048;
/** Passes before the strict one. Ordinary text settles after one or two. */
const MAX_SANITISE_PASSES = 4;
const MIN_SCAN_BUDGET = 150_000;
const SCAN_BUDGET_PER_CHARACTER = 12;

type BlockState =
	| { kind: "normal" }
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

export interface SanitizeOptions {
	/** Let the strict header AskMate builds for its own diagrams (theme, look, layout, hex-only variables) through. */
	allowPluginMermaidHeader?: boolean;
	/**
	 * Called once for every construct the sanitiser is about to neutralise. Returning true keeps the original text.
	 * The write path uses it to leave alone what the replaced source text already contained.
	 */
	isExempt?: (finding: Finding) => boolean;
	/**
	 * How many ordinary passes may run before the strict one, which reads every line as text. Defaults to four, which
	 * ordinary text never reaches. Tests lower it to reach the strict pass.
	 */
	maxPasses?: number;
}

export interface MermaidFenceReport {
	/** 0-based index of the opening fence line. */
	openLine: number;
	/** False while the fence is still open at the end of the text, as in a reply that is still streaming. */
	closed: boolean;
	/** The fence body, with any quote or list prefix removed. */
	source: string;
	verdict: GuardResult;
	/** True when the fence was relabelled as text because the guard rejected it. */
	downgraded: boolean;
}

export interface SanitizeResult {
	text: string;
	/** Constructs that were neutralised. Exempt constructs are not listed. */
	findings: Finding[];
	/** Every mermaid fence found, so the interface can say why one is shown as code. */
	mermaid: MermaidFenceReport[];
	/** True when the work budget ran out and the rest of the reply was neutralised without being read. */
	budgetExhausted: boolean;
}

interface SanitizeContext {
	allowPluginMermaidHeader: boolean;
	isExempt: ((finding: Finding) => boolean) | undefined;
	/** The last resort pass: nothing is copied through unread, and every line is sanitised as text. */
	strict: boolean;
	findings: Finding[];
	mermaid: MermaidFenceReport[];
	budget: ScanBudget;
	scanLimitReported: boolean;
	lineStarts: number[] | null;
	paragraph: { from: number; end: number } | null;
	nextNewline: ((from: number) => number) | null;
	nextWikiClose: ((from: number) => number) | null;
	/** Finders for the next closing tag of each element name, so a run of unclosed elements is read once. */
	closingTags: Map<string, (from: number) => number>;
}

/**
 * Rewrites model output so rendering it cannot fetch remote resources, open links to other apps or run code-block
 * processors.
 *
 * - Remote inline and reference-style images become ordinary links labelled "Remote image".
 * - Links to anything other than http(s) and the vault (obsidian:, file:, mailto:, javascript:, ...) become inert text.
 * - Raw HTML tags that load resources are escaped so they render as text.
 * - Fenced code whose language is not a plain highlighting language is relabelled as `text`.
 * - Mermaid fences that fail the structural guard are relabelled as `text`.
 * - Code that starts with Dataview's inline query prefixes (`=` and `$=`) is defused.
 * - Code spans, fenced code (other than the points above) and vault embeds (`![[...]]`) are left alone.
 */
export function sanitizeModelMarkdown(markdown: string, options: SanitizeOptions = {}): string {
	return sanitizeModelMarkdownDetailed(markdown, options).text;
}

/**
 * Like {@link sanitizeModelMarkdown}, and also reports what was neutralised and why.
 *
 * One pass reads the reply as it was written, and its edits can change how the rest of the text is read: escaping the
 * "<" that opened an HTML block turns that block into a paragraph, so a fence line after it that was inside the block
 * becomes a real fence (or the other way round). So the result is only trusted once a pass changes nothing, which means
 * the text was checked in the shape it will be rendered in. Passes repeat until that happens. If the text is still
 * changing after {@link MAX_SANITISE_PASSES} passes, one strict pass reads every line as text and its result is returned.
 */
export function sanitizeModelMarkdownDetailed(markdown: string, options: SanitizeOptions = {}): SanitizeResult {
	let text = markdown.replace(/\r\n?/g, "\n");
	const granted = new Map<string, number>();
	const findings: Finding[] = [];
	const mermaid: MermaidFenceReport[] = [];
	let budgetExhausted = false;

	const maxPasses = options.maxPasses ?? MAX_SANITISE_PASSES;
	for (let pass = 1; pass <= maxPasses + 1; pass += 1) {
		const strict = pass > maxPasses;
		const result = sanitizeOnce(text, options, createPassExemption(options.isExempt, granted), strict);
		findings.push(...result.findings);
		const known = new Set(mermaid.map((report) => report.openLine));
		mermaid.push(...result.mermaid.filter((report) => !known.has(report.openLine)));
		budgetExhausted ||= result.budgetExhausted;
		if (result.text === text) {
			break;
		}
		text = result.text;
	}
	return { text, findings: findings.sort((left, right) => left.line - right.line), mermaid, budgetExhausted };
}

/**
 * The caller's exemption, made safe to ask again on the next pass: constructs it exempted before stay exempt, and new
 * ones are put to it, so a repeated pass neither revokes an exemption nor grants one twice.
 */
function createPassExemption(isExempt: SanitizeOptions["isExempt"], granted: Map<string, number>): ((finding: Finding) => boolean) | undefined {
	if (!isExempt) {
		return undefined;
	}
	const available = new Map(granted);
	return (finding) => {
		const key = findingKey(finding);
		const left = key === null ? 0 : (available.get(key) ?? 0);
		if (key !== null && left > 0) {
			available.set(key, left - 1);
			return true;
		}
		if (!isExempt(finding)) {
			return false;
		}
		if (key !== null) {
			granted.set(key, (granted.get(key) ?? 0) + 1);
		}
		return true;
	};
}

function sanitizeOnce(normalized: string, options: SanitizeOptions, isExempt: SanitizeContext["isExempt"], strict: boolean): SanitizeResult {
	const ctx: SanitizeContext = {
		allowPluginMermaidHeader: options.allowPluginMermaidHeader === true,
		isExempt,
		strict,
		findings: [],
		mermaid: [],
		budget: createScanBudget(Math.max(MIN_SCAN_BUDGET, normalized.length * SCAN_BUDGET_PER_CHARACTER)),
		scanLimitReported: false,
		lineStarts: null,
		paragraph: null,
		nextNewline: null,
		nextWikiClose: null,
		closingTags: new Map()
	};
	const { text, ranges, htmlRanges } = processBlocks(normalized, ctx);
	ctx.nextNewline = createNextIndexOf(text, "\n");
	ctx.nextWikiClose = createNextIndexOf(text, "]]");
	const definitions = collectReferenceDefinitions(text);
	const edits = collectInlineEdits(text, ranges, htmlRanges, definitions, ctx);
	// Block-level findings are registered before inline ones, so put them in reading order.
	const findings = [...ctx.findings].sort((left, right) => left.line - right.line);
	return { text: applyEdits(text, edits), findings, mermaid: ctx.mermaid, budgetExhausted: ctx.budget.exhausted };
}

/**
 * Splits a streaming reply at a mermaid fence that has not closed yet. The text before it is settled and can be
 * rendered; the fence itself should show a placeholder such as "Drawing diagram" until its closing line arrives, so the
 * diagram is drawn once instead of flashing parse errors on every partial update.
 */
export function splitUnclosedMermaid(markdown: string): { settled: string; pendingSource: string | null } {
	const pending = sanitizeModelMarkdownDetailed(markdown).mermaid.find((report) => !report.closed);
	if (!pending) {
		return { settled: markdown, pendingSource: null };
	}
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	return { settled: lines.slice(0, pending.openLine).join("\n"), pendingSource: pending.source };
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

/** Registers a neutralisation. Returns false when the caller's exemption says the original text must stay. */
function accept(ctx: SanitizeContext, finding: Finding): boolean {
	if (ctx.isExempt?.(finding)) {
		return false;
	}
	ctx.findings.push(finding);
	return true;
}

function lineAt(ctx: SanitizeContext, text: string, offset: number): number {
	ctx.lineStarts ??= computeLineStarts(text);
	return lineNumberAt(ctx.lineStarts, offset);
}

/** Reports that the work budget ran out, once, and returns true so callers can fail closed in the same breath. */
function reportScanLimit(ctx: SanitizeContext, text: string, offset: number): void {
	if (!ctx.scanLimitReported) {
		ctx.scanLimitReported = true;
		ctx.findings.push(createFinding("scan-limit", lineAt(ctx, text, offset), "", { identity: null }));
	}
}

/** Lines of the reply, inclusive, that a construct on the current line belongs to. The write path compares this whole range. */
interface BlockExtent {
	from: number;
	to: number;
}

interface FenceIndex {
	/** Every fence the shared scanner found, by opening line. */
	all: Map<number, FenceSpan>;
	/** The opening lines of top-level fences that do not depend on how a leading `---` block is read. */
	topLevel: ReadonlySet<number>;
	/** True for every line that belongs to a fence the scanner found: its opener, body and closer. */
	covered: Uint8Array;
	/** True for every line that belongs to a fence inside a list item or quote. */
	nested: Uint8Array;
}

const FRONTMATTER_CLOSER = /^(?:---|\.\.\.)\s*$/;
/**
 * Lines that start a list item or a quote, and lines that start HTML. Parsers disagree about where these end when no
 * blank line follows them (lazy continuation, lenient list items, HTML blocks that swallow what comes next). A fence
 * flush with the left margin ends a list or a quote in every parser, but an indented one may belong to the item, and
 * one after HTML may be part of the HTML block, so those are not trusted when such a line is in the run before them.
 */
const CONTAINER_LINE = /^\s*(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const HTML_LINE = /^\s*</;
const LIST_ITEM_LINE = /^\s*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A line that starts a block of its own (heading, fence, quote, list item, rule, HTML), which no parser reads as a lazy continuation. */
const BLOCK_START_LINE = /^\s*(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|<)/;

/**
 * True when the line straight after a nested fence's closer is plain text that is not indented into the container. By
 * CommonMark the container has ended there, but a lenient parser lets such a line carry on the list item or quote, and
 * what follows is then read in a different place. The fence itself is fine; only the trust in later fences is not.
 */
function endsAmbiguously(lines: readonly string[], span: FenceSpan): boolean {
	const next = span.closeLine === null ? undefined : lines[span.closeLine + 1];
	if (next === undefined || next.trim() === "" || BLOCK_START_LINE.test(next)) {
		return false;
	}
	return span.quoteDepth > 0 ? !/^ {0,3}>/.test(next) : indentWidth(next) < span.containerColumn;
}

/**
 * A line of spaces only. CommonMark also calls a line with a tab (or another white-space character) blank, but some
 * parsers read it as text, so where a blank line means "the block ended" (HTML blocks, code span pairing, the run of
 * lines before a fence) only this strict reading counts, which keeps the block open in either reading.
 */
function isSpaceOnly(line: string): boolean {
	return /^ *$/.test(line);
}

/**
 * Looks up the fences with the shared scanner (the same one that places inserted blocks and exports). A leading
 * `---` block may or may not be read as frontmatter, depending on the renderer, and that decides whether a fence
 * character inside it counts. Only top-level fences that both readings agree on can be trusted; the others are still
 * relabelled and checked, but their content is not copied through unread.
 */
function indexFenceSpans(lines: string[], frontmatterOpen: boolean, strict: boolean): FenceIndex {
	const spans = scanFences(lines);
	const all = new Map(spans.map((span): [number, FenceSpan] => [span.openLine, span]));
	const covered = new Uint8Array(lines.length);
	const nested = new Uint8Array(lines.length);
	const candidates = spans.filter((span) => span.quoteDepth === 0 && span.containerColumn === 0 && span.fenceIndent <= 3);
	const candidateSet = new Set(candidates);
	for (const span of spans) {
		covered.fill(1, span.openLine, span.endLine + 1);
		if (!candidateSet.has(span)) {
			nested.fill(1, span.openLine, span.endLine + 1);
		}
	}
	const topLevel = new Set<number>();
	if (strict) {
		return { all, topLevel, covered, nested };
	}
	if (!frontmatterOpen) {
		candidates.forEach((span) => topLevel.add(span.openLine));
		return { all, topLevel, covered, nested };
	}
	const closer = lines.findIndex((line, index) => index > 0 && FRONTMATTER_CLOSER.test(line));
	if (closer === -1) {
		return { all, topLevel, covered, nested };
	}
	const withoutFrontmatter = new Map(scanFences(lines, { from: closer + 1 }).map((span): [number, FenceSpan] => [span.openLine, span]));
	for (const span of candidates) {
		const other = withoutFrontmatter.get(span.openLine);
		if (span.openLine > closer && other !== undefined && other.closeLine === span.closeLine && other.endLine === span.endLine) {
			topLevel.add(span.openLine);
		}
	}
	return { all, topLevel, covered, nested };
}

/**
 * Walks the reply line by line and returns the text with fence openers relabelled and the first line of code
 * defused, plus the ranges the inline pass must leave alone (fenced code and code spans).
 *
 * Where a fence starts and ends comes only from the shared scanner. A fence's lines are copied through unread
 * ("trusted") when all of these hold:
 *
 * - the scanner found it at the top level, and the line-by-line reading and a plain Markdown reading (which has no
 *   comments, maths or frontmatter) were both outside any HTML, comment, maths or frontmatter block at its opener;
 * - no HTML line and no fence inside a list item or quote sits in the run of lines just before it, and no list item or
 *   quote line either unless the fence is flush with the left margin;
 * - every fence before it was read without doubt: at the top level as above, or nested and closed by its own closer
 *   with no plain text hugging the closer from outside the container. A fence that fails any of that may have been
 *   invisible to the parser, which would turn a later closer into an opener and swap which lines are code, so nothing
 *   after it is trusted either.
 *
 * Whatever is not trusted is still relabelled and checked, and its content is sanitised like the text around it:
 * a region the parser really renders as text is the dangerous mistake, and sanitising real code only costs a
 * cosmetic change.
 */
function processBlocks(markdown: string, ctx: SanitizeContext): { text: string; ranges: ProtectedRange[]; htmlRanges: TextRange[] } {
	const lines = markdown.split("\n");
	const frontmatterOpen = lines[0]?.trim() === "---" && lines.length > 1;
	const fences = indexFenceSpans(lines, frontmatterOpen, ctx.strict);
	const output: string[] = [];
	const ranges: ProtectedRange[] = [];
	const htmlRanges: TextRange[] = [];
	let state: BlockState = frontmatterOpen ? { kind: "frontmatter" } : { kind: "normal" };
	let plainState: BlockState = { kind: "normal" };
	let offset = 0;
	let spansTrusted = !ctx.strict;
	let protectedFence: FenceSpan | null = null;
	let pendingGuard: BlockExtent | null = null;
	let chunkHasContainer = false;
	let chunkHasHtml = false;
	let chunkHasNested = false;
	// A list item can carry on across blank lines, so an indented fence may belong to one however far up it started,
	// until a line flush with the margin follows a blank line.
	let listMayContinue = false;
	let previousWasBreak = false;
	let trustIntact = true;
	let paragraphEnd = -1;
	const endOfParagraph = (from: number): number => {
		if (from > paragraphEnd) {
			paragraphEnd = from;
			while (paragraphEnd + 1 < lines.length && lines[paragraphEnd + 1].trim() !== "") {
				paragraphEnd += 1;
			}
		}
		return paragraphEnd;
	};

	lines.forEach((line, index) => {
		let result = line;
		let lineProtected = false;
		const isBlank = line.trim() === "";
		const isBreak = isSpaceOnly(line);
		const startState: BlockState = state;
		const plainStart: BlockState = plainState;
		const plainNext: BlockState = protectedFence ? plainStart : advanceBlockState(plainStart, line, splitContainerPrefix(line).rest, false);
		let lineIsHtml = startState.kind === "html" || plainStart.kind === "html" || plainNext.kind === "html";

		if (protectedFence) {
			lineProtected = true;
			if (index === protectedFence.closeLine) {
				pendingGuard = null;
			} else {
				if (pendingGuard && !isBlank) {
					const extent = pendingGuard;
					result = guardLine(ctx, line, index + 1, () => blockIdentity(ctx, lines, extent));
					pendingGuard = null;
				}
				if (protectedFence.language.toLowerCase() === "math" && result === line) {
					result = defuseMathCommands(ctx, lines, index, protectedFence.endLine);
				}
			}
			if (index >= protectedFence.endLine) {
				protectedFence = null;
				chunkHasContainer = false;
				chunkHasHtml = false;
				chunkHasNested = false;
				listMayContinue = false;
				previousWasBreak = false;
			}
		} else if (startState.kind === "frontmatter" && index > 0 && FRONTMATTER_CLOSER.test(line)) {
			state = { kind: "normal" };
			spansTrusted = false;
		} else {
			const span = fences.all.get(index);
			const located = locateFenceOpener(line, span);

			if (located) {
				const { prefix, rest, opener } = located;
				const normalHere = startState.kind === "normal" && plainStart.kind === "normal";
				const topLevel = span !== undefined && fences.topLevel.has(index);
				const qualifies = span !== undefined && normalHere && (topLevel ? !chunkHasHtml && !chunkHasNested && !((chunkHasContainer || listMayContinue) && span.fenceIndent > 0) : span.closeLine !== null && !endsAmbiguously(lines, span));
				const trusted = qualifies && topLevel && trustIntact;
				// A fence-looking line that the scanner did not take for an opener, and that no fence covers, is a disagreement too.
				if (!qualifies && (span !== undefined || fences.covered[index] === 0)) {
					trustIntact = false;
				}
				result = prefix + processFenceOpener(ctx, lines, index, rest, opener, span);
				pendingGuard = { from: index, to: span?.endLine ?? lines.length - 1 };
				if (trusted && span) {
					protectedFence = span;
					lineProtected = true;
				}
			} else {
				const { prefix, rest } = splitContainerPrefix(line);
				if (pendingGuard && !isBlank) {
					const extent = pendingGuard;
					result = prefix + guardLine(ctx, rest, index + 1, () => blockIdentity(ctx, lines, extent));
					pendingGuard = null;
				} else if (!isBlank && /^\s*(?:\$=|=(?!=))(?!\s*$)/.test(rest)) {
					// Indented code blocks are <pre><code> too, and Dataview reads their whole text.
					result = prefix + guardLine(ctx, rest, index + 1, () => blockIdentity(ctx, lines, { from: index, to: endOfParagraph(index) }, prefix.length));
				}

				state = advanceBlockState(startState, line, rest);
				lineIsHtml ||= state.kind === "html" || (startState.kind === "normal" && detectHtmlBlockStart(rest) !== undefined);
				// A line that opens (and may close) an HTML block is raw HTML, so its backticks are literal text.
				if (startState.kind === "normal" && state.kind === "normal" && !lineIsHtml && spansTrusted && !isBlank) {
					const scan = scanInlineCodeSpans(result, ctx.budget);
					for (const [start, end] of scan.spans) {
						ranges.push({ start: offset + start, end: offset + end, kind: "span" });
					}
					if (scan.unclosed) {
						spansTrusted = false;
					}
				} else if (startState.kind !== "normal" || state.kind !== "normal" || lineIsHtml) {
					spansTrusted = false;
				}
			}
		}

		plainState = plainNext;
		if (!protectedFence && !lineProtected) {
			chunkHasContainer = !isBreak && (chunkHasContainer || CONTAINER_LINE.test(line));
			chunkHasHtml = !isBreak && (chunkHasHtml || HTML_LINE.test(line));
			chunkHasNested = !isBreak && (chunkHasNested || fences.nested[index] === 1);
			if (!isBreak) {
				if (LIST_ITEM_LINE.test(line)) {
					listMayContinue = true;
				} else if (previousWasBreak && indentWidth(line) === 0) {
					listMayContinue = false;
				}
			}
			previousWasBreak = isBreak;
		}
		if (lineProtected) {
			ranges.push({ start: offset, end: offset + result.length, kind: "fence" });
		}
		if (lineIsHtml && !isBlank) {
			htmlRanges.push({ start: offset, end: offset + result.length });
		}
		if (isBreak && state.kind === "normal" && plainState.kind === "normal" && !lineProtected) {
			spansTrusted = !ctx.strict;
		}

		output.push(result);
		offset += result.length + 1;
	});

	return { text: output.join("\n"), ranges: ranges.sort((left, right) => left.start - right.start), htmlRanges };
}

/**
 * The fence opener on a line, with the quote and list markers in front of it. The scanner's verdict wins when the
 * line-by-line reading does not see an opener: the fence characters are then taken from the first run in the line.
 */
function locateFenceOpener(line: string, span: FenceSpan | undefined): { prefix: string; rest: string; opener: FenceOpener } | null {
	const { prefix, rest } = splitContainerPrefix(line);
	const opener = parseFenceOpener(rest);
	if (opener) {
		return { prefix, rest, opener };
	}
	if (!span) {
		return null;
	}
	const at = line.search(/`{3,}|~{3,}/);
	return at === -1 ? null : { prefix: line.slice(0, at), rest: line.slice(at), opener: { marker: span.marker, length: span.length, language: span.language } };
}

/** The text of `extent`, with the first `skip` characters of its first line left out, or null when it is too long to compare. */
function blockIdentity(ctx: SanitizeContext, lines: string[], extent: BlockExtent, skip = 0): string | null {
	const parts: string[] = [];
	let total = 0;
	for (let index = extent.from; index <= extent.to && index < lines.length; index += 1) {
		const part = index === extent.from ? lines[index].slice(skip) : lines[index];
		total += part.length + 1;
		if (total > MAX_IDENTITY_CHARACTERS || !ctx.budget.spend(part.length + 1)) {
			return null;
		}
		parts.push(part);
	}
	return parts.join("\n");
}

/**
 * Breaks MathJax commands that can load or link, inside a math code block, unless the exemption keeps the original.
 * A command's arguments may run over later lines, so the construct is compared up to the end of the block.
 */
function defuseMathCommands(ctx: SanitizeContext, lines: string[], index: number, lastLine: number): string {
	const line = lines[index];
	return line.replace(MATH_ACTIVE_COMMANDS, (match, backslashes: string, offset: number) => {
		const identity = blockIdentity(ctx, lines, { from: index, to: lastLine }, offset + backslashes.length);
		const finding = createFinding("math-command", index + 1, line.slice(offset, offset + 60).trim(), { identity });
		return accept(ctx, finding) ? `${backslashes}\\${ZERO_WIDTH_SPACE}` : match;
	});
}

/** Defuses a Dataview prefix at the start of a line, unless the exemption keeps the original. */
function guardLine(ctx: SanitizeContext, line: string, lineNumber: number, identity: () => string | null): string {
	const guarded = guardDataviewPrefix(line);
	if (guarded === line) {
		return line;
	}
	return accept(ctx, createFinding("dataview-inline", lineNumber, line.trim(), { identity: identity() })) ? guarded : line;
}

/** Relabels a fence opener when its language could trigger a code-block processor, or when a diagram fails the guard. */
function processFenceOpener(
	ctx: SanitizeContext,
	lines: string[],
	index: number,
	rest: string,
	opener: FenceOpener,
	span: FenceSpan | undefined
): string {
	const language = opener.language.toLowerCase();
	if (language === "mermaid") {
		const body = readFenceBody(lines, index + 1, span, ctx.budget);
		const source = body.lines.join("\n");
		// A body that cannot be read in full within the budget is rejected unread, which keeps stacked openers linear.
		const verdict = body.truncated || !ctx.budget.spend(source.length)
			? mermaidGuardFailure("too-long")
			: validateMermaidSource(source, { allowPluginHeader: ctx.allowPluginMermaidHeader });
		const reason = verdict.reasons[0]?.message ?? "";
		const identity = body.truncated || source.length > MAX_IDENTITY_CHARACTERS ? null : source;
		const downgraded = !verdict.ok && accept(ctx, createFinding("unsafe-diagram", index + 1, source, { message: reason, identity }));
		ctx.mermaid.push({ openLine: index, closed: body.closed, source, verdict, downgraded });
		return relabelFenceLine(rest, opener, downgraded);
	}
	if (opener.language && !PLAIN_CODE_LANGUAGES.has(language)) {
		const body = readFenceBody(lines, index + 1, span, ctx.budget);
		const excerpt = `${rest.trim()}\n${firstContentLine(lines, index + 1)}`;
		// The whole block is the construct: a code block runs everything in it, not just the line that names the language.
		const whole = `${rest.trim()}\n${body.lines.join("\n")}`;
		const identity = body.truncated || whole.length > MAX_IDENTITY_CHARACTERS ? null : whole;
		return accept(ctx, createFinding("plugin-fence", index + 1, excerpt, { identity })) ? relabelFenceLine(rest, opener, true) : rest;
	}
	return rest;
}

/**
 * A body line as the parser hands it to the fence: the quote markers and the indentation of the list item that hold the
 * fence are gone, and everything else is content, including a "- " that only looks like a list marker. Without a
 * scanner verdict nothing is known about the containers, so the line is kept whole: a diagram whose fence the
 * scanner does not see has to hold up as it stands, and one that only reads as valid after its markers are guessed
 * away is shown as code.
 */
function stripFenceContainer(line: string, span: FenceSpan | undefined): string {
	if (!span) {
		return line;
	}
	let rest = line;
	for (let depth = 0; depth < span.quoteDepth; depth += 1) {
		const marker = /^ {0,3}>[ ]?/.exec(rest);
		if (!marker) {
			break;
		}
		rest = rest.slice(marker[0].length);
	}
	let width = 0;
	let cut = 0;
	while (cut < rest.length && width < span.containerColumn && (rest[cut] === " " || rest[cut] === "\t")) {
		width += rest[cut] === "\t" ? 4 - (width % 4) : 1;
		cut += 1;
	}
	return rest.slice(cut);
}

function firstContentLine(lines: string[], from: number): string {
	for (let index = from; index < lines.length; index += 1) {
		const { rest } = splitContainerPrefix(lines[index]);
		if (rest.trim() !== "") {
			return rest.trim();
		}
	}
	return "";
}

interface FenceBody {
	lines: string[];
	closed: boolean;
	truncated: boolean;
}

/**
 * The body of a fence: the lines after its opener up to its own closing line. With no closer the body runs to the end
 * of the reply, so a half-written diagram is still judged in full.
 *
 * CommonMark ends a fence inside a quote or list item at its closing fence or where the quote or list item ends; a
 * lenient parser may let it run on to a later closing fence, and anything in between would then be drawn. So when the
 * container ends first, the checked part extends to the next line that could close the fence, or to the end of the
 * reply. A closing fence indented four or more columns past the fence is code, not a closer, so a hostile line cannot
 * end the checked part early. If the scanner does not see a fence here at all, the whole rest of the reply is checked, line by line as written.
 * Quote markers and list indentation are removed from the lines of a nested fence, and only from those.
 */
function readFenceBody(lines: string[], start: number, span: FenceSpan | undefined, budget: ScanBudget): FenceBody {
	let end = lines.length;
	let closed = false;
	if (span && span.closeLine !== null) {
		end = span.closeLine;
		closed = true;
	} else if (span && !span.open) {
		end = findLenientFenceCloser(lines, span.endLine + 1, span, budget);
		closed = end < lines.length;
	}
	const body: string[] = [];
	for (let index = start; index < end; index += 1) {
		if (!budget.spend(lines[index].length + 1)) {
			return { lines: body, closed: false, truncated: true };
		}
		body.push(stripFenceContainer(lines[index], span));
	}
	return { lines: body, closed, truncated: false };
}

/**
 * Moves the block reading past one line. With `obsidian` off the text is read as plain Markdown: no comments or maths
 * blocks, which only Obsidian knows, so what is left is HTML.
 */
function advanceBlockState(state: BlockState, line: string, rest: string, obsidian = true): BlockState {
	if (state.kind === "html") {
		if (state.end ? state.end.test(line) : isSpaceOnly(line)) {
			return { kind: "normal" };
		}
		if (!state.end) {
			// A block that ends at a blank line was assumed from any tag at the start of a line, which is more than a parser
			// takes for HTML. A comment, script or style that starts inside it can still run past that blank line.
			const nested = detectHtmlBlockStart(rest);
			if (nested && !nested.test(line)) {
				return { kind: "html", end: nested };
			}
		}
		return state;
	}
	if (state.kind === "frontmatter") {
		return state;
	}

	const commentMarkers = obsidian ? countOccurrences(line, "%%") : 0;
	const mathMarkers = obsidian ? countOccurrences(line, "$$") : 0;
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

function relabelFenceLine(rest: string, opener: FenceOpener, force = false): string {
	if (!opener.language || (!force && PLAIN_CODE_LANGUAGES.has(opener.language.toLowerCase()))) {
		return rest;
	}

	const fenceText = rest.slice(0, opener.length);
	const info = rest.slice(opener.length);
	const languageIndex = info.indexOf(opener.language);
	return `${fenceText}${info.slice(0, languageIndex)}${NEUTRAL_CODE_LANGUAGE}${info.slice(languageIndex + opener.language.length)}`;
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
function scanInlineCodeSpans(line: string, budget: ScanBudget): InlineScan {
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
			if (!budget.spend((closeIndex === -1 ? line.length : closeIndex) - index) || closeIndex === -1) {
				return { spans, unclosed: true };
			}
			spans.push([index, closeIndex + runLength]);
			index = closeIndex + runLength;
			continue;
		}

		const skipTo = findOpaqueInlineEnd(line, index, budget);
		if (skipTo === -1) {
			return { spans, unclosed: true };
		}
		index = skipTo ?? index + 1;
	}

	return { spans, unclosed: false };
}

function findOpaqueInlineEnd(line: string, index: number, budget: ScanBudget): number | null {
	const char = line[index];
	const next = line[index + 1] ?? "";

	if (char === "<" && /[A-Za-z/!?]/.test(next)) {
		const tag = findTagEnd(line, index, line.length);
		if (!budget.spend((tag.end === -1 ? line.length : tag.end) - index)) {
			return -1;
		}
		// A backtick inside the candidate means parsers disagree on whether it is a tag, and so on how backticks pair.
		return tag.ambiguous || line.slice(index, tag.end + 1).includes("`") ? -1 : tag.end + 1;
	}
	if (char === "%" && next === "%") {
		const end = line.indexOf("%%", index + 2);
		return end === -1 || !budget.spend(end - index) ? -1 : end + 2;
	}
	if (char === "$") {
		const delimiter = next === "$" ? "$$" : "$";
		const end = findUnescaped(line, delimiter, index + delimiter.length);
		return end === -1 || !budget.spend(end - index) ? -1 : end + delimiter.length;
	}
	if (char === "]" && next === "(") {
		const naiveEnd = findClosingParen(line, index + 1, line.length);
		const end = parseLinkDestination(line, index + 1, line.length)?.close ?? -1;
		if (!budget.spend((naiveEnd === -1 ? line.length : naiveEnd) - index)) {
			return -1;
		}
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

interface ParsedDestination {
	/** Start of the destination, including an opening `<`. */
	destStart: number;
	/** End of the destination, past a closing `>`. */
	destEnd: number;
	/** Index of the `)` that closes the link. */
	close: number;
}

/** Reads a CommonMark inline link destination and optional title after the "(" at `parenIndex`. */
function parseLinkDestination(text: string, parenIndex: number, limit: number): ParsedDestination | null {
	let cursor = skipWhitespace(text, parenIndex + 1, limit);
	const destStart = cursor;
	if (text[cursor] === "<") {
		cursor += 1;
		while (cursor < limit && text[cursor] !== ">") {
			if (text[cursor] === "<" || text[cursor] === "\n") {
				return null;
			}
			cursor += text[cursor] === "\\" ? 2 : 1;
		}
		if (cursor >= limit) {
			return null;
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
	const destEnd = Math.min(cursor, limit);

	cursor = skipWhitespace(text, cursor, limit);
	const titleOpener = text[cursor];
	if (titleOpener === "\"" || titleOpener === "'" || titleOpener === "(") {
		const titleCloser = titleOpener === "(" ? ")" : titleOpener;
		cursor += 1;
		while (cursor < limit && text[cursor] !== titleCloser) {
			cursor += text[cursor] === "\\" ? 2 : 1;
		}
		if (cursor >= limit) {
			return null;
		}
		cursor = skipWhitespace(text, cursor + 1, limit);
	}
	return text[cursor] === ")" && cursor < limit ? { destStart, destEnd, close: cursor } : null;
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
	definitions: Map<string, boolean>,
	ctx: SanitizeContext
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
				const guard = dataviewSpanGuard(ctx, text, range);
				if (guard) {
					edits.push(guard);
				}
			}
			index = range.end;
			continue;
		}

		const char = text[index];
		if (char === "\\") {
			MATH_ACTIVE_COMMAND.lastIndex = index;
			if (MATH_ACTIVE_COMMAND.test(text) && !isEscaped(text, index)) {
				const excerpt = text.slice(index, index + 60).split("\n")[0].trim();
				if (accept(ctx, createFinding("math-command", lineAt(ctx, text, index), excerpt, { identity: blockTail(ctx, text, index) }))) {
					edits.push({ start: index + 1, end: index + 1, text: ZERO_WIDTH_SPACE });
				}
			}
			index += 1;
			continue;
		}
		if (char === "`") {
			// Unprotected backticks may still form a code span in Obsidian's parser.
			const runEnd = index + countRun(text, index, "`");
			if (/^\s*\$?=/.test(text.slice(runEnd, runEnd + 16))) {
				const finding = createFinding("dataview-inline", lineAt(ctx, text, index), text.slice(index, index + 80), { identity: blockTail(ctx, text, index) });
				if (accept(ctx, finding)) {
					edits.push({ start: runEnd, end: runEnd, text: ZERO_WIDTH_SPACE });
				}
			}
			index = runEnd;
			continue;
		}
		if (char === "!" && text[index + 1] === "[" && !isEscaped(text, index) && !isVaultEmbed(ctx, text, index)) {
			edits.push(...remoteImageEdits(ctx, text, index, definitions));
			index += 2;
			continue;
		}
		while (htmlIndex < htmlRanges.length && htmlRanges[htmlIndex].end <= index) {
			htmlIndex += 1;
		}
		const inHtmlBlock = htmlRanges[htmlIndex] !== undefined && htmlRanges[htmlIndex].start <= index;
		// Backslash escapes do not exist inside raw HTML blocks, so "\<img" is still a tag there.
		if (char === "<" && (inHtmlBlock || !isEscaped(text, index))) {
			const edit = networkTagEdit(ctx, text, index, inHtmlBlock);
			if (edit) {
				edits.push(edit);
			}
		}
		if (char === "]" && text[index + 1] === ":" && !isEscaped(text, index)) {
			if (ctx.budget.exhausted) {
				reportScanLimit(ctx, text, index);
				edits.push({ start: index, end: index, text: "\\" });
			} else {
				const definition = readRemoteDefinition(ctx, text, index + 2);
				// Label matching cannot follow every parser (multi-line labels, nested containers, Unicode case
				// folding), so break every remote reference definition instead. "\]" still renders as "]".
				if (definition && accept(ctx, createFinding("remote-image", lineAt(ctx, text, index), definitionExcerpt(text, index), { identity: definition.identity }))) {
					edits.push({ start: index, end: index, text: "\\" });
				}
			}
		}
		if (char === "]" && text[index + 1] === "(" && !isEscaped(text, index)) {
			edits.push(...linkJunctionEdits(ctx, text, index));
		}
		index += 1;
	}

	return edits;
}

function definitionExcerpt(text: string, closeBracketIndex: number): string {
	const lineStart = text.lastIndexOf("\n", closeBracketIndex) + 1;
	return text.slice(lineStart, Math.min(text.length, closeBracketIndex + 200)).split("\n")[0];
}

/**
 * Reads the destination after a `]:` (on the same line or the next one). Returns null unless it could load remotely;
 * the identity is the whole destination, or null when it runs past what is read.
 */
function readRemoteDefinition(ctx: SanitizeContext, text: string, from: number): { identity: string | null } | null {
	ctx.budget.spend(64);
	const window = text.slice(from, from + MAX_DEFINITION_CHARACTERS);
	const match = /^[ \t]*(?:\n[ \t>]*)?(<[^>\n]*>|\S+)/.exec(window);
	if (!match || isSafeImageDestination(match[1])) {
		return null;
	}
	const complete = match[0].length < window.length || from + window.length >= text.length;
	return { identity: complete ? `]: ${match[1]}` : null };
}

/** The text from `from` to the end of its paragraph, or null when that is too far to compare in full. */
function blockTail(ctx: SanitizeContext, text: string, from: number): string | null {
	const { limit, truncated } = findScanLimit(ctx, text, from, MAX_BLOCK_TAIL_CHARACTERS);
	return truncated ? null : text.slice(from, limit);
}

/** `![[...]]` embeds resolve inside the vault. One followed by `(` or `[` may also parse as a Markdown image. */
function isVaultEmbed(ctx: SanitizeContext, text: string, bangIndex: number): boolean {
	if (text[bangIndex + 2] !== "[") {
		return false;
	}
	ctx.budget.spend(8);
	const lineEnd = ctx.nextNewline?.(bangIndex) ?? text.indexOf("\n", bangIndex);
	const closeIndex = ctx.nextWikiClose?.(bangIndex + 3) ?? text.indexOf("]]", bangIndex + 3);
	if (closeIndex === -1 || (lineEnd !== -1 && closeIndex > lineEnd)) {
		return false;
	}
	const next = text[closeIndex + 2];
	return next !== "(" && next !== "[";
}

function dataviewSpanGuard(ctx: SanitizeContext, text: string, range: ProtectedRange): TextEdit | null {
	const runEnd = range.start + countRun(text, range.start, "`");
	if (!/^\s*\$?=/.test(text.slice(runEnd, range.end))) {
		return null;
	}
	if (!accept(ctx, createFinding("dataview-inline", lineAt(ctx, text, range.start), text.slice(range.start, range.end)))) {
		return null;
	}
	return { start: runEnd, end: runEnd, text: ZERO_WIDTH_SPACE };
}

function remoteImageEdits(ctx: SanitizeContext, text: string, bangIndex: number, definitions: Map<string, boolean>): TextEdit[] {
	if (ctx.budget.exhausted) {
		reportScanLimit(ctx, text, bangIndex);
		return [{ start: bangIndex, end: bangIndex, text: "\\" }];
	}
	const openIndex = bangIndex + 1;
	const unsafe = findUnsafeImageClose(ctx, text, openIndex, definitions);
	if (!unsafe) {
		return [];
	}
	const closeIndex = unsafe.close;
	if (ctx.budget.exhausted) {
		// The budget ran out inside this image: its destination was not fully read, so it is neutralised unread.
		reportScanLimit(ctx, text, bangIndex);
	} else {
		const excerpt = text.slice(bangIndex, closeIndex + 120).split("\n")[0];
		if (!accept(ctx, createFinding("remote-image", lineAt(ctx, text, bangIndex), excerpt, { identity: unsafe.identity }))) {
			return [];
		}
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

interface UnsafeImage {
	/** Index of the bracket that closes the alt text. */
	close: number;
	/** The part that decides what loads (destination and title, or reference label). Null when it was not read in full. */
	identity: string | null;
}

/**
 * Finds the closing bracket that would make `![` at openIndex load a remote image, or null.
 * Every plausible closer is checked, not just the one a CommonMark parser would pick, so code spans,
 * HTML or nested brackets inside the alt text cannot hide the real destination.
 */
function findUnsafeImageClose(ctx: SanitizeContext, text: string, openIndex: number, definitions: Map<string, boolean>): UnsafeImage | null {
	const { limit, truncated } = findScanLimit(ctx, text, openIndex);
	let depth = 0;
	let candidates = 0;
	let uncertain = false;

	for (let index = openIndex + 1; index < limit; index += 1) {
		if (!ctx.budget.spend(1)) {
			return { close: index, identity: null };
		}
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
			return { close: index, identity: null };
		}

		const alt = text.slice(openIndex + 1, index);
		const verdict = classifyImageCandidate(ctx, text, index, limit, alt, definitions);
		if (verdict.kind === "unsafe") {
			return { close: index, identity: verdict.identity };
		}
		if (verdict.kind === "complete" && depth === 0 && !uncertain) {
			return null;
		}
		depth -= 1;
	}

	// The paragraph goes on past the scan window, so the real closer was never examined.
	return truncated ? { close: limit, identity: null } : null;
}

interface ImageVerdict {
	kind: "unsafe" | "complete" | "incomplete";
	/** For an unsafe image: the destination (with title) or reference label, which is what a rewrite must keep to keep the image. */
	identity: string | null;
}

const INCOMPLETE: ImageVerdict = { kind: "incomplete", identity: null };
const COMPLETE: ImageVerdict = { kind: "complete", identity: null };

function classifyImageCandidate(
	ctx: SanitizeContext,
	text: string,
	closeIndex: number,
	limit: number,
	alt: string,
	definitions: Map<string, boolean>
): ImageVerdict {
	const next = text[closeIndex + 1];

	if (next === "(") {
		const naiveClose = findClosingParen(text, closeIndex + 1, limit);
		const destinationClose = parseLinkDestination(text, closeIndex + 1, limit)?.close ?? -1;
		const contentEnd = Math.max(naiveClose, destinationClose);
		ctx.budget.spend(2 * ((contentEnd === -1 ? limit : contentEnd) - closeIndex));
		if (contentEnd === -1) {
			// An unterminated destination is not an image in CommonMark; treat it as unsafe in case a parser disagrees.
			return isSafeImageDestination(text.slice(closeIndex + 2, limit)) ? INCOMPLETE : { kind: "unsafe", identity: null };
		}
		// Check the longer reading, so a ")" inside `<...>` or a title cannot hide a remote URL after it.
		const content = text.slice(closeIndex + 2, contentEnd);
		if (!isSafeImageDestination(content)) {
			return { kind: "unsafe", identity: `](${content})` };
		}
		return naiveClose === destinationClose ? COMPLETE : INCOMPLETE;
	}

	if (next === "[") {
		const labelEnd = text.indexOf("]", closeIndex + 2);
		if (labelEnd === -1 || labelEnd >= limit) {
			return INCOMPLETE;
		}
		const label = text.slice(closeIndex + 2, labelEnd).trim() || alt;
		return classifyReference(label, definitions);
	}

	return classifyReference(alt, definitions);
}

function classifyReference(label: string, definitions: Map<string, boolean>): ImageVerdict {
	const normalised = normalizeReferenceLabel(label);
	const unsafe = definitions.get(normalised);
	if (unsafe === undefined) {
		return INCOMPLETE;
	}
	return unsafe ? { kind: "unsafe", identity: `][${normalised}]` } : COMPLETE;
}

/**
 * Makes a link whose destination is not http(s) or vault-relative inert: the opening parenthesis is escaped, so no
 * link forms and the label stays as written, and the destination is shown as a code span, so it cannot be turned
 * into a link or read as markup.
 */
function linkJunctionEdits(ctx: SanitizeContext, text: string, closeIndex: number): TextEdit[] {
	if (ctx.budget.exhausted) {
		reportScanLimit(ctx, text, closeIndex);
		return [{ start: closeIndex + 1, end: closeIndex + 1, text: "\\" }];
	}
	const { limit, truncated: windowCut } = findScanLimit(ctx, text, closeIndex);
	const parsed = parseLinkDestination(text, closeIndex + 1, limit);
	ctx.budget.spend((parsed ? parsed.close : limit) - closeIndex);

	// Without a well-formed link the destination is read up to the first space or closing parenthesis, in case a
	// parser is more forgiving than CommonMark.
	const destStart = parsed?.destStart ?? skipWhitespace(text, closeIndex + 2, limit);
	let destEnd = parsed?.destEnd ?? destStart;
	while (!parsed && destEnd < limit && destEnd - destStart < MAX_UNPARSED_DESTINATION_CHARACTERS && !/[\s)]/.test(text[destEnd])) {
		destEnd += 1;
	}
	const destination = text.slice(destStart, destEnd);
	if (destination === "" || !describeLinkDestination(destination).schemeBlocked) {
		return [];
	}
	// A destination that was cut short by the read limits is not known in full.
	const cutShort = !parsed && (destEnd - destStart >= MAX_UNPARSED_DESTINATION_CHARACTERS || (windowCut && destEnd >= limit));
	if (/^<?data:image\//i.test(destination.trim()) && isImageJunction(ctx, text, closeIndex)) {
		return [];
	}
	if (!accept(ctx, createFinding("blocked-link", lineAt(ctx, text, closeIndex), `](${destination}`, { identity: cutShort ? null : `](${destination}` }))) {
		return [];
	}

	const edits: TextEdit[] = [{ start: closeIndex + 1, end: closeIndex + 1, text: "\\" }];
	if (parsed) {
		const fence = "`".repeat(longestRun(destination, "`") + 1);
		const pad = destination.startsWith("`") || destination.endsWith("`") ? " " : "";
		edits.push({ start: destStart, end: destStart, text: fence + pad }, { start: destEnd, end: destEnd, text: pad + fence });
	}
	return edits;
}

/** True when the bracket pair that ends at `closeIndex` opens with an unescaped `![`. */
function isImageJunction(ctx: SanitizeContext, text: string, closeIndex: number): boolean {
	let depth = 1;
	const stop = Math.max(0, closeIndex - MAX_LINK_BACKSCAN_CHARACTERS);
	for (let index = closeIndex - 1; index >= stop; index -= 1) {
		if (!ctx.budget.spend(1)) {
			return true;
		}
		const char = text[index];
		if ((char !== "[" && char !== "]") || isEscaped(text, index)) {
			continue;
		}
		depth += char === "]" ? 1 : -1;
		if (depth === 0) {
			return text[index - 1] === "!" && !isEscaped(text, index - 1);
		}
	}
	return true;
}

function longestRun(text: string, char: string): number {
	let longest = 0;
	for (let index = text.indexOf(char); index !== -1; ) {
		const run = countRun(text, index, char);
		longest = Math.max(longest, run);
		index = text.indexOf(char, index + run);
	}
	return longest;
}

/**
 * Escapes the "<" of raw HTML that could load a resource, open a blocked link or form a code element, and of
 * autolinks to blocked destinations. Inside raw HTML blocks the browser's lenient tokenizer reads the text
 * (`<b$ style=...>` is a tag there), so every candidate is checked. A tag whose end cannot be found within
 * reach is escaped rather than trusted.
 */
function networkTagEdit(ctx: SanitizeContext, text: string, index: number, inHtmlBlock: boolean): TextEdit | null {
	const match = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(text.slice(index, index + 80));
	if (!match) {
		return null;
	}
	const escape: TextEdit = { start: index, end: index + 1, text: "&lt;" };

	if (ctx.budget.exhausted) {
		reportScanLimit(ctx, text, index);
		return escape;
	}
	// An autolink is Markdown, but a line that opens with "<" is also treated as an HTML block, so both readings are checked.
	const autolink = /^<([^\s<>]+)>/.exec(text.slice(index, index + 2050));
	if (autolink && /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:|[^\s@<>/]+@)/.test(autolink[1])) {
		const destination = autolink[1].includes(":") ? autolink[1] : `mailto:${autolink[1]}`;
		return describeLinkDestination(destination).schemeBlocked && accept(ctx, createFinding("blocked-link", lineAt(ctx, text, index), autolink[0])) ? escape : null;
	}

	const name = match[1].toLowerCase();
	const localName = name.slice(name.lastIndexOf(":") + 1);
	const listed = NETWORK_TAG_NAMES.has(localName) || CODE_TAG_NAMES.has(localName);

	// In Markdown, other names only form a tag with whitespace, "/" or ">" after the name and no unquoted "<"
	// before its end. Skipping the rest keeps maths such as $a<b$ intact when a later tag carries src= or url(.
	const afterName = text[index + match[0].length];
	if (!listed && !inHtmlBlock && afterName !== undefined && !/[\s/>]/.test(afterName)) {
		return null;
	}

	const { limit } = findScanLimit(ctx, text, index, MAX_TAG_SCAN_CHARACTERS);
	const tag = findTagEnd(text, index, limit);
	ctx.budget.spend((tag.end === -1 ? limit : tag.end) - index);
	const excerpt = (): string => text.slice(index, index + 120).split("\n")[0];
	if (listed) {
		const identity = ctx.budget.exhausted ? null : elementIdentity(ctx, text, index, tag, localName);
		return accept(ctx, createFinding("network-html", lineAt(ctx, text, index), excerpt(), { identity })) ? escape : null;
	}
	if (tag.end === -1) {
		// The end is out of reach: a long attribute list could be hiding src= or url() from the checks below.
		return accept(ctx, createFinding("network-html", lineAt(ctx, text, index), excerpt(), { identity: null })) ? escape : null;
	}
	const tagText = text.slice(index, tag.end + 1);
	// "&lt;" is how an earlier pass wrote a "<" it escaped, so it counts as one here and a second pass reads the same tag.
	if (!inHtmlBlock && /(?:<|&lt;)[A-Za-z/!?]/.test(stripQuoted(tagText.slice(1)))) {
		return null;
	}
	const loadsResource = NETWORK_ATTRIBUTE_PATTERN.test(tagText) || CSS_RESOURCE_PATTERN.test(tagText) || hasObfuscatedStyle(tagText);
	if (!loadsResource && !hasBlockedHref(tagText)) {
		return null;
	}

	const finding = createFinding(loadsResource ? "network-html" : "blocked-link", lineAt(ctx, text, index), excerpt(), { identity: tagText });
	return accept(ctx, finding) ? escape : null;
}

/**
 * The whole element for the write path to compare: the tag, and for an element whose content matters as much as the
 * tag (a style sheet, a script, fallback markup, Dataview code in a code element) everything up to its closing tag.
 * Null when the tag or the element is not in sight.
 */
function elementIdentity(ctx: SanitizeContext, text: string, index: number, tag: TagEnd, localName: string): string | null {
	if (tag.end === -1 || tag.end + 1 - index > MAX_IDENTITY_CHARACTERS) {
		return null;
	}
	const opening = text[index + 1] !== "/";
	if (!opening || !PAIRED_TAG_NAMES.has(localName) || text[tag.end - 1] === "/") {
		return text.slice(index, tag.end + 1);
	}
	let findClosing = ctx.closingTags.get(localName);
	if (!findClosing) {
		findClosing = createNextIndexOf(text, `</${localName}`);
		ctx.closingTags.set(localName, findClosing);
	}
	const closeAt = findClosing(tag.end + 1);
	if (closeAt === -1 || closeAt - index > MAX_IDENTITY_CHARACTERS) {
		return null;
	}
	const closeEnd = text.slice(closeAt, closeAt + 64).indexOf(">");
	return closeEnd === -1 ? null : text.slice(index, closeAt + closeEnd + 1);
}

/** An `href` that leads anywhere but the vault or an http(s) page. */
function hasBlockedHref(tagText: string): boolean {
	for (const match of tagText.matchAll(HREF_ATTRIBUTE_PATTERN)) {
		const value = match[1].replace(/^["']|["']$/g, "");
		if (describeLinkDestination(value).schemeBlocked) {
			return true;
		}
	}
	return false;
}

/** CSS escapes, HTML character references and comments can spell `url(` without the literal text, so any style using them is unsafe. */
function hasObfuscatedStyle(tagText: string): boolean {
	const style = /[\s"'/]style\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i.exec(tagText);
	return Boolean(style && /[\\&]|\/\*/.test(style[1]));
}

function stripQuoted(text: string): string {
	return text.replace(/"[^"]*"|'[^']*'/g, "");
}

/** End of the paragraph that holds `from` (the next blank line), bounded by a character window. */
function findScanLimit(ctx: SanitizeContext, text: string, from: number, window = MAX_IMAGE_SCAN_CHARACTERS): { limit: number; truncated: boolean } {
	let paragraphEnd: number;
	const cached = ctx.paragraph;
	if (cached && from >= cached.from && from <= cached.end) {
		paragraphEnd = cached.end;
	} else {
		const blankLine = /\n[ \t]*\n/g;
		blankLine.lastIndex = from;
		const match = blankLine.exec(text);
		paragraphEnd = match ? match.index : text.length;
		ctx.paragraph = { from, end: paragraphEnd };
		ctx.budget.spend(paragraphEnd - from);
	}
	const windowEnd = from + window;
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
