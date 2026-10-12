/**
 * Structural guard for Mermaid source that came from a model.
 *
 * Mermaid can load remote resources and inject CSS through several routes (init directives and frontmatter
 * `themeCSS` and `fontFamily`, `@{ img: ... }` shapes, HTML labels, `url()` in `style` and `classDef`, entity and
 * escape spellings of all of those). A denylist of URL spellings cannot keep up, so this guard is an allowlist
 * that fails closed: the source must open with a known diagram header and may only use constructs that cannot load
 * anything. Whatever it cannot classify is rejected, with a reason the interface can show.
 *
 * Headers the plugin builds itself (frontmatter with a theme, a look, a layout and hex-only theme variables) are
 * validated separately against an even stricter grammar, and only when the caller asks for it.
 */

export type MermaidGuardReasonCode =
	| "empty"
	| "too-long"
	| "control-character"
	| "bidi-control"
	| "unknown-header"
	| "frontmatter"
	| "plugin-header"
	| "directive"
	| "interaction"
	| "backslash"
	| "remote-reference"
	| "css-function"
	| "html"
	| "entity"
	| "markdown-string"
	| "shape-data"
	| "style-statement"
	| "unterminated";

export interface MermaidGuardReason {
	code: MermaidGuardReasonCode;
	/** Sentence for the interface, naming the 1-based line in the source when there is one. */
	message: string;
	/** 1-based line in the source, or 0 when the reason concerns the source as a whole. */
	line: number;
}

export interface GuardResult {
	ok: boolean;
	reasons: readonly MermaidGuardReason[];
	/** The header token of the diagram, for example `flowchart` or `stateDiagram-v2`. Null when there is none. */
	diagramType: string | null;
}

export interface MermaidGuardOptions {
	/** Accept the strict frontmatter header that AskMate builds for its own diagrams. Model output never needs it. */
	allowPluginHeader?: boolean;
}

const MAX_SOURCE_CHARACTERS = 100_000;
const MAX_REASONS = 8;

type DiagramFamily = "flowchart" | "sequence" | "class" | "state" | "er" | "requirement" | "block" | "quadrant" | "gantt" | "other";

interface HeaderRule {
	pattern: RegExp;
	family: DiagramFamily;
}

// Anchored, case sensitive and followed by a boundary, because Mermaid's own detectors are prefix tests.
// flowchart-elk and zenuml are deliberately absent: they are not available in Obsidian.
const HEADER_RULES: readonly HeaderRule[] = [
	{ pattern: /^(flowchart|graph)(?![\w-])/, family: "flowchart" },
	{ pattern: /^(sequenceDiagram)(?![\w-])/, family: "sequence" },
	{ pattern: /^(classDiagram(?:-v2)?)(?![\w-])/, family: "class" },
	{ pattern: /^(stateDiagram(?:-v2)?)(?![\w-])/, family: "state" },
	{ pattern: /^(erDiagram)(?![\w-])/, family: "er" },
	{ pattern: /^(requirementDiagram)(?![\w-])/, family: "requirement" },
	{ pattern: /^(block(?:-beta)?)(?![\w-])/, family: "block" },
	{ pattern: /^(quadrantChart)(?![\w-])/, family: "quadrant" },
	{ pattern: /^(gantt)(?![\w-])/, family: "gantt" },
	{ pattern: /^(journey|mindmap|timeline|pie|kanban|gitGraph)(?![\w-])/, family: "other" },
	{ pattern: /^((?:sankey|xychart|architecture|radar|treemap|packet|ishikawa|venn)(?:-beta)?)(?![\w-])/, family: "other" },
	{ pattern: /^(C4(?:Context|Container|Component|Dynamic|Deployment))(?![\w-])/, family: "other" }
];

/** Statements whose arguments are CSS, by the diagram families that give them that meaning. Keys are lower case because Mermaid's lexers ignore case. */
const STYLE_KEYWORD_FAMILIES: Readonly<Record<string, ReadonlySet<DiagramFamily>>> = {
	style: new Set<DiagramFamily>(["flowchart", "class", "er", "requirement", "block", "state"]),
	classdef: new Set<DiagramFamily>(["flowchart", "class", "er", "requirement", "block", "state", "quadrant"]),
	linkstyle: new Set<DiagramFamily>(["flowchart"]),
	todaymarker: new Set<DiagramFamily>(["gantt"])
};

const STYLE_PROPERTIES: ReadonlySet<string> = new Set([
	"fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin",
	"stroke-opacity", "fill-opacity", "opacity", "color", "font-size", "font-weight", "font-style", "rx", "ry",
	"background", "background-color", "border", "border-color", "border-width", "border-style", "border-radius", "padding"
]);

const STYLE_VALUE_TOKEN = /^(?:#[0-9a-fA-F]{3,8}|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?|[A-Za-z][A-Za-z-]{0,30})$/;
const STYLE_TARGETS = /^[\p{L}\p{N}_.,-]+$/u;

// Keys for flowchart shapes, kanban tickets and sequence participants. img and icon are absent on purpose: they load files.
const SHAPE_DATA_KEYS: ReadonlySet<string> = new Set(["shape", "label", "w", "h", "pos", "constraint", "ticket", "assigned", "priority", "type", "alias"]);
const SHAPE_BARE_VALUE = /^[\p{L}\p{N}_.+ -]*$/u;

const ALLOWED_HASH_ENTITY_NUMBERS: ReadonlySet<number> = new Set([35, 59, 40, 41, 91, 93, 123, 124, 125]);
const ALLOWED_AMPERSAND_NUMBERS: ReadonlySet<number> = new Set([34, 35, 36, 37, 38, 39, 40, 41, 59, 60, 62, 91, 93, 123, 124, 125]);
const ALLOWED_AMPERSAND_NAMES: ReadonlySet<string> = new Set(["amp", "lt", "gt", "quot", "apos", "nbsp"]);

/** Elements that act on their own even without attributes, so a `<<name>>` stereotype may not spell them. */
const ACTIVE_ELEMENT_NAMES: ReadonlySet<string> = new Set([
	"script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "link", "meta",
	"base", "form", "img", "image", "video", "audio", "source", "track", "picture", "portal", "noscript", "textarea",
	"title", "plaintext", "xmp", "listing", "a", "area", "foreignobject", "bgsound"
]);

const PLUGIN_THEMES: ReadonlySet<string> = new Set(["base", "default", "dark", "forest", "neutral"]);
const PLUGIN_LOOKS: ReadonlySet<string> = new Set(["classic", "handDrawn", "neo"]);
const PLUGIN_LAYOUTS: ReadonlySet<string> = new Set(["dagre"]);

const REASON_TEXT: Readonly<Record<MermaidGuardReasonCode, string>> = {
	empty: "The diagram is empty",
	"too-long": "The diagram source is too long to check",
	"control-character": "The source contains a control character",
	"bidi-control": "The source contains a text direction control character",
	"unknown-header": "The source does not start with a supported diagram type",
	frontmatter: "The source contains YAML frontmatter, which diagrams from a model may not carry",
	"plugin-header": "The AskMate header uses a setting that is not allowed",
	directive: "The source contains a %%{ }%% directive, which can change how the diagram loads resources",
	interaction: "The source contains a click, link or callback statement",
	backslash: "The source contains a backslash, which can spell escaped characters",
	"remote-reference": "The source refers to an external address",
	"css-function": "The source contains a CSS function or rule that can load a resource",
	html: "The source contains HTML markup other than line breaks",
	entity: "The source contains an entity code that is not on the allow list",
	"markdown-string": "The source contains a Markdown string (backticks)",
	"shape-data": "The source contains shape data that is not allowed",
	"style-statement": "The source contains a style statement outside the supported colour and size properties",
	unterminated: "The source contains an unterminated @{ } block"
};

class ReasonList {
	private readonly seen = new Set<string>();
	readonly items: MermaidGuardReason[] = [];

	add(code: MermaidGuardReasonCode, line: number): void {
		const key = `${code}:${line}`;
		if (this.items.length >= MAX_REASONS || this.seen.has(key)) {
			return;
		}
		this.seen.add(key);
		this.items.push({ code, line, message: line > 0 ? `${REASON_TEXT[code]} on line ${line}.` : `${REASON_TEXT[code]}.` });
	}
}

function fail(code: MermaidGuardReasonCode): GuardResult {
	const reasons = new ReasonList();
	reasons.add(code, 0);
	return { ok: false, reasons: reasons.items, diagramType: null };
}

/** A rejection for a source that was not read, for callers that ran out of scan budget before validating it. */
export function mermaidGuardFailure(code: MermaidGuardReasonCode): GuardResult {
	return fail(code);
}

export function validateMermaidSource(source: string, options: MermaidGuardOptions = {}): GuardResult {
	if (source.length > MAX_SOURCE_CHARACTERS) {
		return fail("too-long");
	}
	const text = source.replace(/\r\n?/g, "\n");
	if (text.trim() === "") {
		return fail("empty");
	}

	const reasons = new ReasonList();
	const lines = text.split("\n");
	checkCharacters(lines, reasons);

	const frontmatter = locateFrontmatter(lines);
	let bodyStart = 0;
	if (frontmatter) {
		if (!options.allowPluginHeader) {
			reasons.add("frontmatter", frontmatter.start + 1);
			return { ok: false, reasons: reasons.items, diagramType: null };
		}
		if (frontmatter.end === -1) {
			reasons.add("unterminated", frontmatter.start + 1);
			return { ok: false, reasons: reasons.items, diagramType: null };
		}
		checkPluginHeader(lines, frontmatter.start + 1, frontmatter.end, reasons);
		bodyStart = frontmatter.end + 1;
	}

	const headerIndex = findHeaderLine(lines, bodyStart);
	const header = headerIndex === -1 ? null : matchHeader(lines[headerIndex].trim());
	if (headerIndex === -1) {
		reasons.add("empty", 0);
	} else if (!header && !lines[headerIndex].trim().startsWith("%%")) {
		reasons.add("unknown-header", headerIndex + 1);
	}
	const family = header?.family ?? "other";

	for (let index = bodyStart; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = lines[index];
		if (/^\s*-{3}\s*$/.test(line)) {
			reasons.add("frontmatter", lineNumber);
			continue;
		}
		checkLine(maskStyleStatements(line, family, lineNumber, reasons), lineNumber, family, reasons);
	}
	checkShapeData(lines, bodyStart, reasons);

	return { ok: reasons.items.length === 0, reasons: reasons.items, diagramType: header?.type ?? null };
}

function checkCharacters(lines: readonly string[], reasons: ReasonList): void {
	lines.forEach((line, index) => {
		if (/(?!\t)[\p{Cc}\u2028\u2029]/u.test(line)) {
			reasons.add("control-character", index + 1);
		}
		if (/[\u202A-\u202E\u2066-\u2069]/.test(line)) {
			reasons.add("bidi-control", index + 1);
		}
	});
}

function locateFrontmatter(lines: readonly string[]): { start: number; end: number } | null {
	const start = lines.findIndex((line) => line.trim() !== "");
	if (start === -1 || !lines[start].trim().startsWith("---")) {
		return null;
	}
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^-{3}\s*$/.test(lines[index])) {
			return { start, end: index };
		}
	}
	return { start, end: -1 };
}

function findHeaderLine(lines: readonly string[], from: number): number {
	for (let index = from; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		if (trimmed !== "" && !/^%%(?!\{)/.test(trimmed)) {
			return index;
		}
	}
	return -1;
}

function matchHeader(trimmedLine: string): { type: string; family: DiagramFamily } | null {
	for (const rule of HEADER_RULES) {
		const match = rule.pattern.exec(trimmedLine);
		if (match) {
			return { type: match[1], family: rule.family };
		}
	}
	return null;
}

/** Splits a line at semicolons that sit outside double quotes. */
function splitStatements(line: string): string[] {
	const pieces: string[] = [];
	let quoted = false;
	let start = 0;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\"") {
			quoted = !quoted;
		} else if (char === ";" && !quoted) {
			pieces.push(line.slice(start, index));
			start = index + 1;
		}
	}
	pieces.push(line.slice(start));
	return pieces;
}

/**
 * Validates `style`, `classDef`, `linkStyle` and `todayMarker` statements against a strict property and value grammar
 * and blanks the valid ones, so the general checks do not trip over hex colours followed by a semicolon. Statements
 * that fail are reported and left in place, so the general checks also describe what is wrong with them.
 */
function maskStyleStatements(line: string, family: DiagramFamily, lineNumber: number, reasons: ReasonList): string {
	if (family === "other" || family === "sequence" || !/(?:^|;)\s*(?:style|classDef|linkStyle|todayMarker)\b/i.test(line)) {
		return line;
	}
	return splitStatements(line)
		.map((piece) => {
			const statement = piece.trim();
			const keyword = /^(style|classDef|linkStyle|todayMarker)(?=\s|$)/i.exec(statement)?.[1].toLowerCase();
			if (!keyword || !STYLE_KEYWORD_FAMILIES[keyword].has(family)) {
				return piece;
			}
			if (isValidStyleStatement(keyword, statement.slice(keyword.length).trim())) {
				return "";
			}
			reasons.add("style-statement", lineNumber);
			return piece;
		})
		.join(";");
}

function isValidStyleStatement(keyword: string, rest: string): boolean {
	if (keyword === "todaymarker") {
		return rest.toLowerCase() === "off" || isValidDeclarationList(rest);
	}
	if (keyword === "linkstyle" && /^(?:default|\d+(?:\s*,\s*\d+)*)\s+interpolate\s+[A-Za-z]+$/i.test(rest)) {
		return true;
	}
	const split = /^(\S+)\s+(.+)$/s.exec(rest);
	if (!split) {
		return false;
	}
	const targets = split[1];
	const targetsValid = keyword === "linkstyle" ? /^(?:default|\d+(?:,\d+)*)$/i.test(targets) : STYLE_TARGETS.test(targets);
	return targetsValid && isValidDeclarationList(split[2]);
}

function isValidDeclarationList(list: string): boolean {
	const declarations = list.trim().replace(/;\s*$/, "").split(",").map((entry) => entry.trim());
	// A trailing comma is common in generated styles and carries nothing.
	if (declarations[declarations.length - 1] === "") {
		declarations.pop();
	}
	return declarations.length > 0 && declarations.every((declaration) => {
		const parts = /^([A-Za-z-]+)\s*:\s*(.+)$/.exec(declaration);
		if (!parts || !STYLE_PROPERTIES.has(parts[1].toLowerCase())) {
			return false;
		}
		const tokens = parts[2].trim().split(/\s+/);
		return tokens.length <= 6 && tokens.every((token) => STYLE_VALUE_TOKEN.test(token));
	});
}

function checkLine(line: string, lineNumber: number, family: DiagramFamily, reasons: ReasonList): void {
	if (line.includes("%%{") || line.includes("}%%")) {
		reasons.add("directive", lineNumber);
	}
	if (line.includes("\\")) {
		reasons.add("backslash", lineNumber);
	}
	if (line.includes("`")) {
		reasons.add("markdown-string", lineNumber);
	}
	if (hasDisallowedMarkup(line)) {
		reasons.add("html", lineNumber);
	}
	if (hasDisallowedEntity(line)) {
		reasons.add("entity", lineNumber);
	}
	// A scheme followed by a slash, a network scheme followed by anything but a space ("https:host/x" is read as a URL by
	// a browser), or a protocol-relative host after a quote or colon. "file: x" and "HTTP: GET" are ordinary labels.
	if (
		/[A-Za-z][A-Za-z0-9+.-]{0,31}:\//.test(line)
		|| /\b(?:https?|ftps?|wss?|file):(?=\S)/i.test(line)
		|| /["'(=:][ \t]*\/\/[A-Za-z0-9[.-]/.test(line)
	) {
		reasons.add("remote-reference", lineNumber);
	}
	if (
		/(?:^|[^A-Za-z0-9_])(?:url|image-set|cross-fade)\(/i.test(line)
		|| /@(?:import|font-face|namespace|charset|media|supports|keyframes|container|layer|property|page|document)\b/i.test(line)
	) {
		reasons.add("css-function", lineNumber);
	}
	if (/\$(?:link|sprite)\b/i.test(line) || splitStatements(line).some((statement) => isInteractionStatement(statement, family))) {
		reasons.add("interaction", lineNumber);
	}
}

/**
 * `click` is a statement in every family that has statements, so it is rejected whatever follows. `link`, `links` and
 * `callback` are also plain words (a class called Link), so they only count when a target follows.
 */
function isInteractionStatement(statement: string, family: DiagramFamily): boolean {
	const match = /^\s*(click|links?|callback|properties)\s+(.*)$/is.exec(statement);
	if (!match) {
		return false;
	}
	const keyword = match[1].toLowerCase();
	if (keyword === "click") {
		return family !== "other";
	}
	// A sequence diagram's `properties` statement sets an actor's icon, which Mermaid draws as an image from its URL.
	if (keyword === "properties") {
		return family === "sequence";
	}
	return /["'@]|\bhref\b/i.test(match[2]);
}

function hasDisallowedMarkup(line: string): boolean {
	for (let index = line.indexOf("<"); index !== -1; index = line.indexOf("<", index + 1)) {
		const next = line[index + 1] ?? "";
		if (next === "<") {
			const stereotype = /^<<([A-Za-z][A-Za-z0-9_-]{0,30})>>/.exec(line.slice(index, index + 36));
			if (stereotype) {
				if (ACTIVE_ELEMENT_NAMES.has(stereotype[1].toLowerCase())) {
					return true;
				}
				index += stereotype[0].length - 1;
			}
			continue;
		}
		if (/[A-Za-z/!?]/.test(next) && !/^<br\s{0,3}\/?>/i.test(line.slice(index, index + 10))) {
			return true;
		}
	}
	return false;
}

function hasDisallowedEntity(line: string): boolean {
	if (!line.includes("#") && !line.includes("&")) {
		return false;
	}
	for (const match of line.matchAll(/#([A-Za-z0-9]+);/g)) {
		const code = match[1];
		const allowed = code === "quot" || (/^\d+$/.test(code) && ALLOWED_HASH_ENTITY_NUMBERS.has(Number(code)));
		if (!allowed) {
			return true;
		}
	}
	for (const match of line.matchAll(/&(#[xX]?[0-9A-Fa-f]+;?|[A-Za-z][A-Za-z0-9]*;)/g)) {
		const code = match[1];
		if (code.startsWith("#")) {
			const decimal = /^#(\d+);$/.exec(code);
			if (!decimal || !ALLOWED_AMPERSAND_NUMBERS.has(Number(decimal[1]))) {
				return true;
			}
		} else if (!ALLOWED_AMPERSAND_NAMES.has(code.slice(0, -1))) {
			return true;
		}
	}
	return false;
}

/** Every `@{ ... }` block must hold only allowed `key: value` entries. A block that does not close is rejected. */
function checkShapeData(lines: readonly string[], bodyStart: number, reasons: ReasonList): void {
	for (let index = bodyStart; index < lines.length; index += 1) {
		if (!lines[index].includes("@{")) {
			continue;
		}
		// Blocks may span lines, so the scan restarts from this line over the rest of the source.
		const rest = lines.slice(index).join("\n");
		let from = 0;
		let lineNumber = index + 1;
		for (let at = rest.indexOf("@{", from); at !== -1; at = rest.indexOf("@{", from)) {
			lineNumber += countNewlines(rest, from, at);
			const block = readShapeBlock(rest, at + 2);
			if (!block) {
				reasons.add("unterminated", lineNumber);
				return;
			}
			if (!block.entries.every(isAllowedShapeEntry)) {
				reasons.add("shape-data", lineNumber);
			}
			lineNumber += countNewlines(rest, at, block.end);
			from = block.end;
		}
		return;
	}
}

function countNewlines(text: string, from: number, to: number): number {
	let count = 0;
	for (let index = text.indexOf("\n", from); index !== -1 && index < to; index = text.indexOf("\n", index + 1)) {
		count += 1;
	}
	return count;
}

/** Reads the entries up to the closing brace, honouring quotes. Entries are separated by commas or newlines. */
function readShapeBlock(text: string, start: number): { entries: string[]; end: number } | null {
	const entries: string[] = [];
	let quote: string | null = null;
	let entryStart = start;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (quote) {
			if (char === quote) {
				quote = null;
			}
		} else if (char === "\"" || char === "'") {
			quote = char;
		} else if (char === "," || char === "\n") {
			entries.push(text.slice(entryStart, index));
			entryStart = index + 1;
		} else if (char === "}") {
			entries.push(text.slice(entryStart, index));
			return { entries: entries.map((entry) => entry.trim()).filter((entry) => entry !== ""), end: index + 1 };
		}
	}
	return null;
}

function isAllowedShapeEntry(entry: string): boolean {
	// JSON-style quoted keys ("type") are used for sequence participants; the unquoted name is judged, so "img" is no way round the list.
	const match = /^(?:"([A-Za-z][A-Za-z0-9_-]*)"|'([A-Za-z][A-Za-z0-9_-]*)'|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*(.*)$/s.exec(entry);
	const key = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!match || key === undefined || !SHAPE_DATA_KEYS.has(key)) {
		return false;
	}
	const value = match[4].trim();
	return /^"[^"]*"$/.test(value) || /^'(?:[^']|'')*'$/.test(value) || SHAPE_BARE_VALUE.test(value);
}

/** A value in the plugin header: a scalar, or an object whose keys are plain names. Objects have no prototype. */
type HeaderValue = string | number | boolean | HeaderObject;

interface HeaderObject {
	[key: string]: HeaderValue;
}

const MAX_HEADER_LINE_CHARACTERS = 8000;
const MAX_HEADER_ENTRIES = 160;
const MAX_FLOW_DEPTH = 4;
const JSON_NUMBER_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const HEADER_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{3,8}$/;
const HEX_COLOUR_LIST = /^#[0-9a-fA-F]{3,8}(?:,#[0-9a-fA-F]{3,8}){0,15}$/;
const SIZE_OR_NUMBER = /^\d{1,3}(?:\.\d{1,2})?(?:px)?$/;
/** Letters, digits, spaces, commas and hyphens only: no quote, semicolon, parenthesis, backslash or brace to end the declaration. */
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ,-]{0,199}$/;
const PLUGIN_TITLE = /^(?:"[\p{L}\p{N} .,:;!?'()\-_/+*=%]{1,120}"|[\p{L}\p{N} .,!?'()\-_/+*=%]{1,120})$/u;
const PLUGIN_CURVES: ReadonlySet<string> = new Set([
	"basis", "bumpX", "bumpY", "cardinal", "catmullRom", "linear", "monotoneX", "monotoneY", "natural", "step", "stepAfter", "stepBefore"
]);
const SANKEY_LINK_COLOURS: ReadonlySet<string> = new Set(["source", "target", "gradient"]);
const SANKEY_ALIGNMENTS: ReadonlySet<string> = new Set(["left", "right", "center", "justify"]);

function createHeaderObject(): HeaderObject {
	return Object.create(null) as HeaderObject;
}

/**
 * The header between the `---` lines must be what AskMate builds: an optional title and one `config` tree. The tree
 * is written either as indented lines or as the single-line JSON object that `JSON.stringify` produces (valid YAML
 * flow style, which is what the diagram builder emits). Both are read into the same tree and checked against one closed
 * schema, so what a YAML parser makes of the header is exactly what was validated: no escapes, no duplicate keys, no
 * keys outside the schema, and values from fixed character sets.
 */
function checkPluginHeader(lines: readonly string[], first: number, end: number, reasons: ReasonList): void {
	let config: HeaderObject | null = null;
	let configLine = 0;
	const stack: Array<{ indent: number; object: HeaderObject; childIndent: number | null }> = [];
	let rootLevelDone = false;

	for (let index = first; index < end; index += 1) {
		const raw = lines[index];
		if (raw.trim() === "") {
			continue;
		}
		const lineNumber = index + 1;
		if (raw.length > MAX_HEADER_LINE_CHARACTERS) {
			reasons.add("plugin-header", lineNumber);
			return;
		}
		const match = /^( *)([A-Za-z][A-Za-z0-9]*):(?: +(.*?))? *$/.exec(raw);
		if (!match) {
			reasons.add("plugin-header", lineNumber);
			return;
		}
		const indent = match[1].length;
		const key = match[2];
		const value = match[3] ?? "";

		if (indent === 0) {
			rootLevelDone = false;
			stack.length = 0;
			if (key === "title") {
				if (!PLUGIN_TITLE.test(value)) {
					reasons.add("plugin-header", lineNumber);
					return;
				}
				continue;
			}
			if (key !== "config" || config !== null) {
				reasons.add("plugin-header", lineNumber);
				return;
			}
			config = createHeaderObject();
			configLine = lineNumber;
			if (value.startsWith("{")) {
				const flow = parseFlowObject(value);
				if (!flow) {
					reasons.add("plugin-header", lineNumber);
					return;
				}
				config = flow;
				rootLevelDone = true;
			} else if (value !== "") {
				reasons.add("plugin-header", lineNumber);
				return;
			} else {
				stack.push({ indent: 0, object: config, childIndent: null });
			}
			continue;
		}

		// An indented line belongs to the block form of `config`, never to a flow object.
		if (rootLevelDone || config === null) {
			reasons.add("plugin-header", lineNumber);
			return;
		}
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1];
		// Children of one object share one indentation, as a YAML parser requires.
		if (!parent || key in parent.object || !HEADER_KEY.test(key) || (parent.childIndent !== null && parent.childIndent !== indent)) {
			reasons.add("plugin-header", lineNumber);
			return;
		}
		parent.childIndent = indent;
		if (value === "") {
			const child = createHeaderObject();
			parent.object[key] = child;
			stack.push({ indent, object: child, childIndent: null });
			continue;
		}
		const scalar = parseBlockScalar(value);
		if (scalar === undefined) {
			reasons.add("plugin-header", lineNumber);
			return;
		}
		parent.object[key] = scalar;
	}

	if (config !== null && !isAllowedPluginConfig(config)) {
		reasons.add("plugin-header", configLine);
	}
}

/** A value after `key:` in the indented form: quoted without escapes, a number, a boolean, or a bare word that is not a comment. */
function parseBlockScalar(value: string): string | number | boolean | undefined {
	const quoted = /^"([^"\\\p{Cc}]*)"$|^'([^'\\\p{Cc}]*)'$/u.exec(value);
	if (quoted) {
		return quoted[1] ?? quoted[2];
	}
	if (value === "true" || value === "false") {
		return value === "true";
	}
	if (JSON_NUMBER_TEXT.test(value)) {
		return Number(value);
	}
	return /^[A-Za-z0-9][A-Za-z0-9 ,.-]{0,199}$/.test(value) ? value.trim() : undefined;
}

/** Reads a whole value as a JSON object with no escapes and no repeated keys. Returns null for anything else. */
function parseFlowObject(source: string): HeaderObject | null {
	const cursor = { at: 0 };
	const value = parseFlowValue(source, cursor, 0);
	skipFlowSpaces(source, cursor);
	return value !== undefined && typeof value === "object" && cursor.at === source.length ? value : null;
}

function skipFlowSpaces(source: string, cursor: { at: number }): void {
	while (source[cursor.at] === " " || source[cursor.at] === "\t") {
		cursor.at += 1;
	}
}

function parseFlowValue(source: string, cursor: { at: number }, depth: number): HeaderValue | undefined {
	skipFlowSpaces(source, cursor);
	const char = source[cursor.at];
	if (char === "{") {
		return depth < MAX_FLOW_DEPTH ? parseFlowMembers(source, cursor, depth) : undefined;
	}
	if (char === "\"") {
		const close = source.indexOf("\"", cursor.at + 1);
		const text = close === -1 ? "" : source.slice(cursor.at + 1, close);
		if (close === -1 || /[\\\p{Cc}]/u.test(text)) {
			return undefined;
		}
		cursor.at = close + 1;
		return text;
	}
	const scalar = /-?(?:0|[1-9]\d*)(?:\.\d+)?|true|false/y;
	scalar.lastIndex = cursor.at;
	const found = scalar.exec(source);
	if (!found) {
		return undefined;
	}
	cursor.at += found[0].length;
	return found[0] === "true" ? true : found[0] === "false" ? false : Number(found[0]);
}

function parseFlowMembers(source: string, cursor: { at: number }, depth: number): HeaderObject | undefined {
	const result = createHeaderObject();
	cursor.at += 1;
	skipFlowSpaces(source, cursor);
	if (source[cursor.at] === "}") {
		cursor.at += 1;
		return result;
	}
	for (let count = 0; count < MAX_HEADER_ENTRIES; count += 1) {
		const name = parseFlowValue(source, cursor, depth + 1);
		skipFlowSpaces(source, cursor);
		if (typeof name !== "string" || !HEADER_KEY.test(name) || name in result || source[cursor.at] !== ":") {
			return undefined;
		}
		cursor.at += 1;
		const member = parseFlowValue(source, cursor, depth + 1);
		if (member === undefined) {
			return undefined;
		}
		result[name] = member;
		skipFlowSpaces(source, cursor);
		const separator = source[cursor.at];
		cursor.at += 1;
		if (separator === "}") {
			return result;
		}
		if (separator !== ",") {
			return undefined;
		}
	}
	return undefined;
}

function isHeaderObject(value: HeaderValue | undefined): value is HeaderObject {
	return typeof value === "object";
}

/** The closed schema for `config`. Anything that is not named here is not allowed. */
function isAllowedPluginConfig(config: HeaderObject): boolean {
	const entries = Object.entries(config);
	if (entries.length === 0 || entries.length > MAX_HEADER_ENTRIES) {
		return false;
	}
	return entries.every(([key, value]) => {
		switch (key) {
			case "theme":
				return typeof value === "string" && PLUGIN_THEMES.has(value);
			case "look":
				return typeof value === "string" && PLUGIN_LOOKS.has(value);
			case "layout":
				return typeof value === "string" && PLUGIN_LAYOUTS.has(value);
			case "handDrawnSeed":
				return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
			case "themeVariables":
				return isHeaderObject(value) && isAllowedThemeVariables(value);
			case "flowchart":
				return isHeaderObject(value) && hasOnlyKeys(value, ["curve", "padding"])
					&& (value.curve === undefined || (typeof value.curve === "string" && PLUGIN_CURVES.has(value.curve)))
					&& (value.padding === undefined || (typeof value.padding === "number" && value.padding >= 0 && value.padding <= 100));
			case "sankey":
				return isHeaderObject(value) && hasOnlyKeys(value, ["linkColor", "nodeAlignment", "showValues"])
					&& (value.linkColor === undefined || (typeof value.linkColor === "string" && (SANKEY_LINK_COLOURS.has(value.linkColor) || HEX_COLOUR.test(value.linkColor))))
					&& (value.nodeAlignment === undefined || (typeof value.nodeAlignment === "string" && SANKEY_ALIGNMENTS.has(value.nodeAlignment)))
					&& (value.showValues === undefined || typeof value.showValues === "boolean");
			default:
				return false;
		}
	});
}

function hasOnlyKeys(value: HeaderObject, allowed: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => allowed.includes(key));
}

function isAllowedThemeVariables(variables: HeaderObject): boolean {
	const entries = Object.entries(variables);
	if (entries.length > MAX_HEADER_ENTRIES) {
		return false;
	}
	return entries.every(([key, value]) => {
		if (!HEADER_KEY.test(key) || key === "constructor") {
			return false;
		}
		if (typeof value === "boolean") {
			return true;
		}
		if (typeof value === "number") {
			return Number.isFinite(value) && Math.abs(value) <= 1000;
		}
		if (typeof value === "string") {
			return key === "fontFamily" ? FONT_FAMILY.test(value) : HEX_COLOUR.test(value) || value === "transparent" || SIZE_OR_NUMBER.test(value);
		}
		return key === "xyChart" && isAllowedChartColours(value);
	});
}

/** The `xyChart` theme variables: colour names mapped to a colour, `transparent` or a comma-separated colour list. */
function isAllowedChartColours(colours: HeaderObject): boolean {
	const entries = Object.entries(colours);
	return entries.length > 0 && entries.length <= MAX_HEADER_ENTRIES && entries.every(([key, value]) =>
		HEADER_KEY.test(key) && key !== "constructor" && typeof value === "string"
		&& (HEX_COLOUR.test(value) || value === "transparent" || HEX_COLOUR_LIST.test(value))
	);
}
