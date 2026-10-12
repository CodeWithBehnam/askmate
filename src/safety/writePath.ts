/**
 * Write-path defusing. Model output that is written into a note (Insert, Apply, a result note, an export) stops being
 * a reply and becomes vault content that other plugins will read and run, long after the sidebar is closed. This
 * module applies the sanitiser to that text, and adds what only matters in a file: Templater tags, which are
 * executed from the raw file text, and invisible or bidirectional control characters.
 *
 * A write that replaces existing text must not rewrite what the user already had. Constructs that the source text
 * held are counted, and the same number of them are left alone in the output, so a faithful rewrite of a note that
 * holds a dataviewjs block or a Mermaid directive keeps it, while a new one added by the model is neutralised.
 */

import { createFinding, findingKey, type Finding, type FindingKind } from "./findings";
import { sanitizeModelMarkdownDetailed } from "./sanitize";
import { computeLineStarts, createNextIndexOf, lineNumberAt } from "./scan";

export interface WritePathOptions {
	/** The text this output replaces or sits beside. Constructs it already holds are left alone in the output. */
	sourceText?: string;
	/** Let the strict diagram header that AskMate builds through, for output that holds plugin-assembled diagrams. */
	allowPluginMermaidHeader?: boolean;
}

export interface PreparedOutput {
	/** The text to write. The very same string as the input when nothing needed to change. */
	text: string;
	changed: boolean;
	findings: Finding[];
}

export interface RiskAssessment {
	/** True when the text held any construct that is active once written: loads, runs, links out or hides. */
	risky: boolean;
	safeText: string;
	findings: Finding[];
}

type Exemption = (finding: Finding) => boolean;

interface Stage {
	text: string;
	findings: Finding[];
}

const CONTROL_CHARACTERS = /[\u200B\u2060-\u2064\u180E\uFEFF]|[\u{E0000}-\u{E007F}]|[\u202A-\u202E\u2066-\u2069]/gu;
const BIDI_CHARACTERS = /[\u202A-\u202E\u2066-\u2069]/;
const TEMPLATE_TAG = /<%/g;
const ZERO_WIDTH_SPACE = "\u200B";
/** A template tag longer than this is never treated as one the source held. */
const MAX_TEMPLATE_IDENTITY = 20_000;

function normaliseLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * Counts findings by construct, and answers true once for each counted construct. A construct is identified by its
 * whole text, not by the clipped excerpt shown in the interface, so a model cannot keep the start of a block the user
 * had and change the rest. A finding with no identity (one that could not be read in full) is never exempt.
 */
function createExemption(sourceFindings: readonly Finding[]): Exemption {
	const remaining = new Map<string, number>();
	for (const finding of sourceFindings) {
		const key = findingKey(finding);
		if (key !== null) {
			remaining.set(key, (remaining.get(key) ?? 0) + 1);
		}
	}
	return (finding) => {
		const key = findingKey(finding);
		if (key === null) {
			return false;
		}
		const count = remaining.get(key) ?? 0;
		if (count <= 0) {
			return false;
		}
		remaining.set(key, count - 1);
		return true;
	};
}

function codePointLabel(char: string): string {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The zero-width spaces the sanitiser itself inserts to defuse Dataview prefixes, Templater tags and MathJax commands stay. */
function isDefusalPlacement(text: string, index: number, char: string): boolean {
	return char === ZERO_WIDTH_SPACE && (
		(text[index - 1] === "<" && text[index + 1] === "%")
		|| /^\$?=/.test(text.slice(index + 1, index + 3))
		|| (text[index - 1] === "\\" && /^(?:href|url|style|class|cssId)(?![A-Za-z])/.test(text.slice(index + 1, index + 9)))
	);
}

/**
 * Removes zero-width, tag and bidirectional control characters. Joiners and direction marks that real text in
 * Persian, Arabic, Hebrew and emoji sequences needs (U+200C to U+200F) are kept.
 */
function removeControlCharacters(text: string, isExempt: Exemption | undefined): Stage {
	const findings: Finding[] = [];
	const lineStarts = computeLineStarts(text);
	let result = "";
	let cursor = 0;
	for (const match of text.matchAll(CONTROL_CHARACTERS)) {
		const char = match[0];
		const index = match.index ?? 0;
		if (isDefusalPlacement(text, index, char)) {
			continue;
		}
		const kind: FindingKind = BIDI_CHARACTERS.test(char) ? "bidi-character" : "invisible-character";
		const finding = createFinding(kind, lineNumberAt(lineStarts, index), codePointLabel(char));
		if (isExempt?.(finding)) {
			continue;
		}
		findings.push(finding);
		result += text.slice(cursor, index);
		cursor = index + char.length;
	}
	return { text: result + text.slice(cursor), findings };
}

/** Templater runs `<% ... %>` from the raw file, code blocks included, so the tag is broken wherever it appears. */
function defuseTemplateTags(text: string, isExempt: Exemption | undefined): Stage {
	const findings: Finding[] = [];
	const lineStarts = computeLineStarts(text);
	const nextTagEnd = createNextIndexOf(text, "%>");
	const nextNewline = createNextIndexOf(text, "\n");
	let result = "";
	let cursor = 0;
	for (const match of text.matchAll(TEMPLATE_TAG)) {
		const index = match.index ?? 0;
		const lineEnd = nextNewline(index);
		const excerpt = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
		// The tag runs to its closing "%>", possibly over several lines, and all of it executes.
		const end = nextTagEnd(index + 2);
		const identity = end !== -1 && end + 2 - index <= MAX_TEMPLATE_IDENTITY ? text.slice(index, end + 2) : null;
		const finding = createFinding("template-tag", lineNumberAt(lineStarts, index), excerpt, { identity });
		if (isExempt?.(finding)) {
			continue;
		}
		findings.push(finding);
		result += `${text.slice(cursor, index + 1)}${ZERO_WIDTH_SPACE}`;
		cursor = index + 1;
	}
	return { text: result + text.slice(cursor), findings };
}

/** The whole pipeline on LF text. Control characters go first, because the sanitiser adds zero-width guards of its own. */
function runPipeline(normalized: string, options: WritePathOptions, isExempt: Exemption | undefined): Stage {
	const stripped = removeControlCharacters(normalized, isExempt);
	const sanitized = sanitizeModelMarkdownDetailed(stripped.text, { allowPluginMermaidHeader: options.allowPluginMermaidHeader, isExempt });
	const templated = defuseTemplateTags(sanitized.text, isExempt);
	const findings = [...stripped.findings, ...sanitized.findings, ...templated.findings].sort((left, right) => left.line - right.line);
	return { text: templated.text, findings };
}

/**
 * Makes model output safe to write into a note. Remote images become links, plugin code blocks and unsafe diagrams
 * become plain text, Dataview and Templater constructs are defused, links that could trigger another app are made
 * inert, and invisible or bidirectional control characters are removed. Constructs that `sourceText` already held are
 * left alone, one for one. The text keeps its line endings.
 */
export function prepareModelOutputForWrite(text: string, options: WritePathOptions = {}): PreparedOutput {
	const normalized = normaliseLineEndings(text);
	const isExempt = options.sourceText === undefined ? undefined : createExemption(runPipeline(normaliseLineEndings(options.sourceText), options, undefined).findings);
	const result = runPipeline(normalized, options, isExempt);
	if (result.text === normalized) {
		return { text, changed: false, findings: result.findings };
	}
	return { text: text.includes("\r\n") ? result.text.replace(/\n/g, "\r\n") : result.text, changed: true, findings: result.findings };
}

/** Prepares model output for writing and says whether it held anything that would have been active. */
export function assessModelMarkdownRisk(text: string, options: WritePathOptions = {}): RiskAssessment {
	const prepared = prepareModelOutputForWrite(text, options);
	return { risky: prepared.findings.length > 0, safeText: prepared.text, findings: prepared.findings };
}

/** The active constructs in model-added text: remote images, plugin fences, network HTML, template tags, hidden characters. */
export function detectActiveContent(added: string): Finding[] {
	return prepareModelOutputForWrite(added).findings;
}
