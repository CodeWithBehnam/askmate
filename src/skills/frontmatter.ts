export interface FrontmatterSplit {
	/** The YAML between the delimiters, or null when the text has no frontmatter block. */
	yaml: string | null;
	body: string;
	/** True when an opening delimiter was found but never closed. */
	unclosed: boolean;
}

const DELIMITER = /^---[ \t]*$/;
const CLOSER = /^(?:---|\.\.\.)[ \t]*$/;

/** Splits `---` frontmatter from the Markdown body. Line endings must already be normalised to `\n`. */
export function splitFrontmatter(text: string): FrontmatterSplit {
	const lines = text.split("\n");
	let first = 0;
	while (first < lines.length && (lines[first] ?? "").trim() === "") {
		first += 1;
	}
	if (!DELIMITER.test(lines[first] ?? "")) {
		return { yaml: null, body: text, unclosed: false };
	}
	for (let index = first + 1; index < lines.length; index += 1) {
		if (CLOSER.test(lines[index] ?? "")) {
			return {
				yaml: lines.slice(first + 1, index).join("\n"),
				body: lines.slice(index + 1).join("\n"),
				unclosed: false
			};
		}
	}
	return { yaml: null, body: text, unclosed: true };
}

const MAX_QUOTED_LINE = 2000;
const KEY_VALUE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)(:[ \t]+)(\S.*?)[ \t]*$/;
const LIST_ITEM = /^(\s*)(-[ \t]+)(\S.*?)[ \t]*$/;
const BLOCK_SCALAR = /^[|>][+-]?\d?[ \t]*(?:#.*)?$/;
/** Values that already start a quoted string, a flow collection, an anchor or alias, a tag or a comment. */
const SELF_DELIMITED = /^["'[{&*!#]/;

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * The retry for hand-written frontmatter: YAML rejects `description: Use when: the user asks`, which people write
 * all the time. Plain values are wrapped in double quotes so the colon is read as text. Block scalars and values
 * that already carry their own delimiters are left alone.
 */
export function quotePlainYamlValues(yaml: string): string {
	let blockIndent: number | null = null;
	return yaml
		.split("\n")
		.map((line) => {
			// A line this long is not hand-written frontmatter; the patterns below would only slow down on it.
			if (line.length > MAX_QUOTED_LINE) {
				return line;
			}
			if (blockIndent !== null) {
				if (line.trim() === "" || indentOf(line) > blockIndent) {
					return line;
				}
				blockIndent = null;
			}
			const pair = line.match(KEY_VALUE);
			if (pair) {
				const [, indent = "", key = "", separator = "", value = ""] = pair;
				if (BLOCK_SCALAR.test(value)) {
					blockIndent = indent.length;
					return line;
				}
				return SELF_DELIMITED.test(value) ? line : `${indent}${key}${separator}${quote(value)}`;
			}
			const item = line.match(LIST_ITEM);
			if (item) {
				const [, indent = "", marker = "", value = ""] = item;
				return SELF_DELIMITED.test(value) ? line : `${indent}${marker}${quote(value)}`;
			}
			return line;
		})
		.join("\n");
}

export type YamlParser = (text: string) => unknown;

export interface FrontmatterParse {
	value: Record<string, unknown>;
	/** True when only the quoting retry made the YAML readable. */
	retried: boolean;
}

export class FrontmatterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrontmatterError";
	}
}

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 160) ?? "unknown error";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parses frontmatter with the injected YAML parser, retrying once with plain values quoted. Throws FrontmatterError. */
export function parseFrontmatterYaml(yaml: string, parseYaml: YamlParser): FrontmatterParse {
	let firstError: unknown;
	try {
		return { value: asRecord(parseYaml(yaml)) ?? {}, retried: false };
	} catch (error) {
		firstError = error;
	}
	try {
		return { value: asRecord(parseYaml(quotePlainYamlValues(yaml))) ?? {}, retried: true };
	} catch {
		throw new FrontmatterError(describeError(firstError));
	}
}
