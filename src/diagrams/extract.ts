// Finds the diagram inside a model answer and names its family. Pure string work: nothing here can throw on garbage input.

import { fnv1a } from "./color";
import type { Kind } from "./types";

/** Exact first-line shapes. Anchored on the whole line so prose such as "Timeline of events" or "Pie charts are..." is never mistaken for a diagram. */
const KIND_START: ReadonlyArray<readonly [Kind, RegExp]> = [
	["flowchart", /^(?:flowchart(?:-elk|-v2)?|graph)(?:[ \t]+(?:TB|TD|BT|RL|LR))?[ \t]*;?$/],
	["sequence", /^sequenceDiagram[ \t]*;?$/],
	["class", /^classDiagram(?:-v2)?[ \t]*;?$/],
	["state", /^stateDiagram(?:-v2)?[ \t]*;?$/],
	["er", /^erDiagram[ \t]*;?$/],
	["gantt", /^gantt[ \t]*;?$/],
	["pie", /^pie(?:[ \t]+showData)?(?:[ \t]+title\b.*)?$/],
	["quadrant", /^quadrantChart[ \t]*$/],
	["mindmap", /^mindmap[ \t]*$/],
	["timeline", /^timeline[ \t]*$/],
	["gitGraph", /^gitGraph(?:[ \t]+(?:LR|TB|BT))?[ \t]*:?$/],
	["sankey", /^sankey(?:-beta)?[ \t]*$/],
	["xychart", /^xychart(?:-beta)?(?:[ \t]+horizontal)?[ \t]*$/],
	["block", /^block(?:-beta)?[ \t]*$/],
	["packet", /^packet(?:-beta)?[ \t]*$/],
	["kanban", /^kanban[ \t]*$/],
	["architecture", /^architecture(?:-beta)?[ \t]*$/],
	["radar", /^radar(?:-beta)?[ \t]*$/],
	["treemap", /^treemap(?:-beta)?[ \t]*$/],
	["journey", /^journey[ \t]*$/],
	["requirement", /^requirementDiagram[ \t]*$/],
	["c4", /^C4(?:Context|Container|Component|Dynamic|Deployment)[ \t]*$/],
	["venn", /^venn(?:-beta)?[ \t]*$/],
	["ishikawa", /^ishikawa(?:-beta)?[ \t]*$/]
];

const COMMENT_LINE = /^\s*%%(?!\{)/;
/** A frontmatter fence only counts as a diagram start when a config or title key follows, so a Markdown rule in prose is ignored. */
const FRONTMATTER_KEY = /^\s*(?:config|title|displayMode)\s*:/;
const FRONTMATTER_BLOCK = /^\s*---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
const DIRECTIVE_BLOCK = /^(?:\s*%%\{[\s\S]*?\}%%[ \t]*(?:\n|$))+/;

function startsKind(line: string): Kind | null {
	const trimmed = line.trim();
	return KIND_START.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? null;
}

/** Splits a leading frontmatter block and %%{ }%% directives from the diagram proper. */
export function splitHeader(source: string): { readonly header: string; readonly rest: string } {
	const frontmatter = FRONTMATTER_BLOCK.exec(source)?.[0] ?? "";
	const afterFrontmatter = source.slice(frontmatter.length);
	const directives = DIRECTIVE_BLOCK.exec(afterFrontmatter)?.[0] ?? "";
	return { header: frontmatter + directives, rest: afterFrontmatter.slice(directives.length) };
}

/** Family of a diagram, from its first meaningful line. Headers, blank lines and %% comments before the keyword are skipped. */
export function detectKind(source: string): Kind | null {
	const first = splitHeader(source).rest.split("\n").find((line) => line.trim() !== "" && !COMMENT_LINE.test(line));
	return first === undefined ? null : startsKind(first);
}

function isDiagramStart(lines: readonly string[], index: number): boolean {
	const line = lines[index] ?? "";
	if (/^\s*%%\{/.test(line)) return true;
	if (/^\s*---\s*$/.test(line)) return FRONTMATTER_KEY.test(lines[index + 1] ?? "");
	return startsKind(line) !== null;
}

export interface MermaidFence {
	readonly source: string;
	/** False while the model is still streaming the block. */
	readonly closed: boolean;
	/** Offsets into the scanned text: start of the opening line, and end of the closing line (or of the text when unclosed). */
	readonly start: number;
	readonly end: number;
}

interface Fence {
	readonly info: string;
	readonly content: string;
	readonly closed: boolean;
	readonly start: number;
	readonly end: number;
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;
const MERMAID_INFO: ReadonlySet<string> = new Set(["mermaid", "mmd"]);

function closesFence(line: string, marker: string): boolean {
	const trimmed = line.trim();
	return trimmed.length >= marker.length && [...trimmed].every((char) => char === marker[0]);
}

interface OpenFence {
	readonly marker: string;
	readonly info: string;
	readonly start: number;
	readonly contentStart: number;
}

function scanFences(text: string): readonly Fence[] {
	const fences: Fence[] = [];
	let offset = 0;
	let open: OpenFence | null = null;
	for (const line of text.split("\n")) {
		const lineEnd = offset + line.length;
		if (open === null) {
			const match = FENCE_OPEN.exec(line);
			if (match) {
				open = { marker: match[1] ?? "```", info: (match[2] ?? "").toLowerCase(), start: offset, contentStart: lineEnd + 1 };
			}
		} else if (closesFence(line, open.marker)) {
			const contentEnd = Math.max(open.contentStart, offset - 1);
			fences.push({ info: open.info, content: text.slice(open.contentStart, contentEnd), closed: true, start: open.start, end: lineEnd });
			open = null;
		}
		offset = lineEnd + 1;
	}
	if (open !== null) {
		fences.push({ info: open.info, content: text.slice(open.contentStart), closed: false, start: open.start, end: text.length });
	}
	return fences;
}

function normaliseNewlines(raw: string): string {
	return raw.replace(/\r\n?/g, "\n");
}

/** Every mermaid fence in a Markdown answer, in order. Streaming code uses `closed` to show a placeholder until the block ends. */
export function findMermaidFences(markdown: string): readonly MermaidFence[] {
	return scanFences(normaliseNewlines(markdown))
		.filter((fence) => MERMAID_INFO.has(fence.info))
		.map((fence) => ({ source: fence.content.trim(), closed: fence.closed, start: fence.start, end: fence.end }));
}

export interface ExtractedDiagram {
	/** The diagram text without fences and without surrounding prose. Empty when the answer held nothing at all. */
	readonly body: string;
	/** Text the model wrote outside the diagram fence, trimmed. */
	readonly prose: string;
	readonly fenced: boolean;
	/** True when the answer holds a block tagged mermaid, even if its content is not a recognised diagram. */
	readonly taggedMermaid: boolean;
}

/** Strips the fence and any prose around the diagram. Prose before the first diagram line is dropped. */
export function extractDiagramParts(raw: string): ExtractedDiagram {
	const text = normaliseNewlines(raw);
	const fences = scanFences(text);
	const chosen =
		fences.find((fence) => MERMAID_INFO.has(fence.info)) ??
		fences.find((fence) => fence.info === "" && fence.content.split("\n").some((_, i, lines) => isDiagramStart(lines, i)));
	const content = chosen ? chosen.content : text;
	const prose = chosen
		? [text.slice(0, chosen.start), text.slice(chosen.end)]
				.map((part) => part.trim())
				.filter((part) => part !== "")
				.join("\n\n")
		: "";
	const lines = content.split("\n");
	const start = lines.findIndex((_, index) => isDiagramStart(lines, index));
	const body = (start > 0 ? lines.slice(start) : lines).join("\n").trim();
	return { body, prose, fenced: chosen !== undefined, taggedMermaid: fences.some((fence) => MERMAID_INFO.has(fence.info)) };
}

export function extractDiagram(raw: string): string {
	return extractDiagramParts(raw).body;
}

/** Stable cache key for a diagram source, so a re-render of the same text can reuse the validated SVG. */
export function sourceHash(source: string): string {
	return fnv1a(source).toString(16).padStart(8, "0");
}
