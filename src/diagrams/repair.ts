// Deterministic repairs for the highest-volume LLM mistakes. Each step is a pure string function that never throws.
// The pipeline only applies them after a failed parse or render, and always re-validates the result.

import type { Kind } from "./types";

/** Lines longer than this are left alone: no diagram line needs a repair there, and it bounds the cost of the scanners below. */
const MAX_REPAIR_LINE = 2000;

function mapLines(source: string, fn: (line: string) => string): string {
	return source
		.split("\n")
		.map((line) => (line.length > MAX_REPAIR_LINE ? line : fn(line)))
		.join("\n");
}

// Built from code points so the source stays readable: invisible characters in a regex literal are easy to lose in review.
const chars = (...codes: number[]): string => String.fromCharCode(...codes);
const span = (from: number, to: number): string => `${chars(from)}-${chars(to)}`;
const INVISIBLE = new RegExp(`[${span(0x200b, 0x200f)}${span(0x202a, 0x202e)}${span(0x2060, 0x2064)}${chars(0xfeff)}]`, "g");
const CURLY_DOUBLE = new RegExp(`[${chars(0x201c, 0x201d, 0x201e)}]`, "g");
const CURLY_SINGLE = new RegExp(`[${chars(0x2018, 0x2019)}]`, "g");
const NO_BREAK_SPACE = new RegExp(chars(0xa0), "g");

/** Typographic quotes break label parsing, and zero-width or bidi characters hide inside otherwise valid text. */
export function normaliseText(text: string): string {
	return text.replace(INVISIBLE, "").replace(CURLY_DOUBLE, '"').replace(CURLY_SINGLE, "'").replace(NO_BREAK_SPACE, " ");
}

// ---------------------------------------------------------------------------
// Flowchart labels
// ---------------------------------------------------------------------------

const RISKY_LABEL = /[()[\]{}|@"<>&;#\\]|^\s*[/*-]|^\d+\.\s/;
const quote = (inner: string): string => `"${inner.replace(/"/g, "#quot;")}"`;
/** Longest openers first, so `(((` is never read as `(`. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
	["(((", ")))"], ["((", "))"], ["([", "])"], ["[(", ")]"], ["[[", "]]"], ["{{", "}}"], ["(", ")"], ["{", "}"], ["[", "]"]
];
const AFTER_CLOSE = /^(?:\s|$|-|=|\.|~|&|:::|;)/;
const SKIP_LINE = /^\s*(%%|classDef\b|class\s|style\s|linkStyle\b|click\s|subgraph\b|direction\s|flowchart\b|graph\b|---|accTitle|accDescr)/;
const SUBGRAPH_TITLE = /^(\s*subgraph\s+[A-Za-z_][\w-]*\s*)\[(.*)\]\s*$/;

function quoteNodeLabels(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const id = /^[A-Za-z_]\w*/.exec(line.slice(i))?.[0];
		const previous = i === 0 ? " " : (line[i - 1] ?? " ");
		if (id === undefined || /\w/.test(previous)) {
			out += line[i] ?? "";
			i += 1;
			continue;
		}
		const rest = line.slice(i + id.length);
		const pair = SHAPES.find(([open]) => rest.startsWith(open));
		if (pair) {
			const [open, close] = pair;
			let at = open.length;
			let found = -1;
			while ((at = rest.indexOf(close, at)) !== -1) {
				if (AFTER_CLOSE.test(rest.slice(at + close.length))) {
					found = at;
					break;
				}
				at += 1;
			}
			if (found !== -1) {
				const trimmed = rest.slice(open.length, found).trim();
				const wrapped = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
				const label = wrapped
					? quote(trimmed.slice(1, -1).replace(/#quot;/g, '"'))
					: trimmed.startsWith("`") || !RISKY_LABEL.test(trimmed)
						? rest.slice(open.length, found)
						: quote(trimmed);
				out += id + open + label + close;
				i += id.length + found + close.length;
				continue;
			}
		}
		out += id;
		i += id.length;
	}
	return out;
}

/** Quotes flowchart node, edge and subgraph labels that Mermaid 11.13 rejects (parentheses, braces, pipes, @, quotes, a leading slash). */
export function quoteFlowchartLabels(source: string): string {
	return mapLines(source, (line) => {
		const subgraph = SUBGRAPH_TITLE.exec(line);
		if (subgraph) {
			const title = (subgraph[2] ?? "").trim();
			return title.startsWith('"') || !RISKY_LABEL.test(title) ? line : `${subgraph[1] ?? ""}[${quote(title)}]`;
		}
		if (SKIP_LINE.test(line)) return line;
		return quoteNodeLabels(line).replace(/\|([^|"\n]+)\|/g, (match, text: string) => (RISKY_LABEL.test(text) ? `|${quote(text.trim())}|` : match));
	});
}

// ---------------------------------------------------------------------------
// Flowchart structure
// ---------------------------------------------------------------------------

/** For each UTF-16 unit of a line: true when it sits outside every quote, bracket pair and |edge label|. */
function outsideLabels(line: string): readonly boolean[] {
	const mask: boolean[] = [];
	let depth = 0;
	let quoted = false;
	let piped = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line.charAt(i);
		if (quoted) {
			quoted = char !== '"';
			mask.push(false);
		} else if (piped) {
			piped = char !== "|";
			mask.push(false);
		} else if (char === '"') {
			quoted = true;
			mask.push(false);
		} else if (char === "|" && depth === 0) {
			piped = true;
			mask.push(false);
		} else if ("([{".includes(char)) {
			depth += 1;
			mask.push(false);
		} else if (")]}".includes(char)) {
			depth = Math.max(0, depth - 1);
			mask.push(false);
		} else {
			mask.push(depth === 0);
		}
	}
	return mask;
}

const ARROW = "(?:-->|---|-\\.->|-\\.-|==>|===|--[ox]|<-->|~~~)";
const END_AFTER_ARROW = new RegExp(`(${ARROW})([ \\t]*(?:\\|[^|\\n]*\\|)?[ \\t]*)end(?![\\w-])`, "g");
const END_AS_SOURCE = new RegExp(`^(\\s*)end(?=[ \\t]*(?:${ARROW}|&|:::|\\[|\\(|\\{))`);
const SHAPE_OPENER = /^[ \t]*[[({]/;

/**
 * `end` as a node id closes a subgraph in Mermaid's lexer. A bare `end` line is the real closer and is left alone.
 * The node keeps its text: `A --> end` becomes `A --> End_["end"]`.
 */
export function renameReservedEnd(source: string): string {
	return mapLines(source, (line) => {
		if (/^\s*end\s*;?\s*$/.test(line) || SKIP_LINE.test(line)) return line;
		const mask = outsideLabels(line);
		const asTarget = line.replace(END_AFTER_ARROW, (match: string, arrow: string, gap: string, offset: number, whole: string) => {
			if (mask[offset + arrow.length + gap.length] === false) return match;
			return `${arrow}${gap}End_${SHAPE_OPENER.test(whole.slice(offset + match.length)) ? "" : '["end"]'}`;
		});
		return asTarget.replace(END_AS_SOURCE, (match: string, indent: string, offset: number, whole: string) =>
			`${indent}End_${SHAPE_OPENER.test(whole.slice(offset + match.length)) ? "" : '["end"]'}`
		);
	});
}

/** `A -> B` is not a Mermaid flowchart edge. Arrows inside labels are left alone. */
export function fixSingleArrows(source: string): string {
	return mapLines(source, (line) => {
		if (SKIP_LINE.test(line)) return line;
		const mask = outsideLabels(line);
		return line.replace(/([\w\])}"'])[ \t]+->[ \t]+(?=[\w"'([{])/g, (match: string, left: string, offset: number) =>
			mask[offset + left.length] === false ? match : `${left} --> `
		);
	});
}

/** Appends the `end` lines a model forgot, so every `subgraph` is closed. Extra `end` lines are left for the parser to report. */
export function closeSubgraphs(source: string): string {
	const lines = source.split("\n");
	const opens = lines.filter((line) => /^\s*subgraph\b/.test(line)).length;
	const closes = lines.filter((line) => /^\s*end\s*;?\s*$/.test(line)).length;
	return opens > closes ? `${source}${"\nend".repeat(opens - closes)}` : source;
}

// ---------------------------------------------------------------------------
// Sequence and pie
// ---------------------------------------------------------------------------

const SEQUENCE_LINE = /^(\s*(?:Note\s+(?:over|left of|right of)\s+[^:]+|[^\s:][^:]*?(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)[+-]?[^:]*?))(:)(.*)$/;

/** In sequence text `;` ends a statement and `#` starts an entity. Existing entities are kept. */
export function escapeSequenceText(source: string): string {
	return mapLines(source, (line) => {
		if (!line.includes(":")) return line;
		const match = SEQUENCE_LINE.exec(line);
		if (!match) return line;
		const text = (match[3] ?? "").replace(/(#\w+;)|[#;]/g, (all: string, entity?: string) => entity ?? (all === "#" ? "#35;" : "#59;"));
		return `${match[1] ?? ""}${match[2] ?? ""}${text}`;
	});
}

/** Pie values must be plain positive numbers: `50%` and `1,200` fail to parse. */
export function fixPieValues(source: string): string {
	return mapLines(source, (line) =>
		line.replace(/^(\s*"[^"\n]*"\s*:\s*)(\d[\d.,]*)[ \t]*%?[ \t]*$/, (_match: string, head: string, value: string) => `${head}${value.replace(/,/g, "")}`)
	);
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

interface RepairStep {
	readonly name: string;
	readonly kinds: readonly Kind[] | "all";
	readonly run: (source: string) => string;
}

export const REPAIR_STEPS: readonly RepairStep[] = [
	{ name: "normalise-text", kinds: "all", run: normaliseText },
	{ name: "flowchart-arrows", kinds: ["flowchart"], run: fixSingleArrows },
	{ name: "flowchart-labels", kinds: ["flowchart"], run: quoteFlowchartLabels },
	{ name: "flowchart-reserved-end", kinds: ["flowchart"], run: renameReservedEnd },
	{ name: "flowchart-subgraph-end", kinds: ["flowchart"], run: closeSubgraphs },
	{ name: "sequence-escapes", kinds: ["sequence"], run: escapeSequenceText },
	{ name: "pie-values", kinds: ["pie"], run: fixPieValues }
];

export interface RepairResult {
	readonly body: string;
	/** Names of the steps that changed the text, in the order they ran. */
	readonly applied: readonly string[];
}

export function applyDeterministicRepairs(body: string, kind: Kind | null): RepairResult {
	return REPAIR_STEPS.reduce<RepairResult>(
		(state, step) => {
			if (step.kinds !== "all" && (kind === null || !step.kinds.includes(kind))) return state;
			const next = step.run(state.body);
			return next === state.body ? state : { body: next, applied: [...state.applied, step.name] };
		},
		{ body, applied: [] }
	);
}
