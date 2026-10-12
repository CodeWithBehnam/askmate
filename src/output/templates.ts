import { closeOpenFence } from "../safety/markdownFences";
import { createNextIndexOf } from "../safety/scan";

const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const PLACEHOLDER_AT = /{{\s*[a-zA-Z0-9_]+\s*}}/y;
const PLACEHOLDER_ONLY_LINE = /^\s*(?:{{\s*[a-zA-Z0-9_]+\s*}}\s*)+$/;
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

function lookupVariable(variables: Readonly<Record<string, string>>, key: string): string {
	return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
}

// Cleanup decisions are made on the template line, never on the substituted text, so user and model
// content (code blocks, Templater or Handlebars syntax, blank-line runs) is inserted verbatim.
export function renderTemplate(template: string, variables: Readonly<Record<string, string>>): string {
	return template
		.split("\n")
		.flatMap((line) => {
			const rendered = line.replace(PLACEHOLDER_PATTERN, (_match, key: string) => lookupVariable(variables, key));
			return PLACEHOLDER_ONLY_LINE.test(line) && rendered.trim() === "" ? [] : [rendered];
		})
		.join("\n");
}

export interface TemplateAnalysis {
	/** Placeholder names in order of first use. */
	placeholders: string[];
	/** Placeholders the template uses that are not known variables, so they would render as nothing. */
	unknown: string[];
	/** Required placeholders the template never uses. */
	missingRequired: string[];
	/** Brace text that is kept as written because it is not a placeholder, such as `{{date:YYYY-MM-DD}}` or an unclosed `{{`. */
	literal: string[];
}

const MAX_LITERAL_LENGTH = 40;

/**
 * Reads a template without rendering it, so the settings page can warn about a misspelt placeholder (which renders as
 * nothing, silently) or a missing required one. Names are case sensitive, as in {@link renderTemplate}.
 */
export function analyzeTemplate(template: string, known: Iterable<string>, required: Iterable<string> = []): TemplateAnalysis {
	const knownNames = new Set(known);
	const placeholders: string[] = [];
	for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
		if (!placeholders.includes(match[1])) {
			placeholders.push(match[1]);
		}
	}

	const literal: string[] = [];
	const nextLineEnd = createNextIndexOf(template, "\n");
	const nextClose = createNextIndexOf(template, "}}");
	for (let index = template.indexOf("{{"); index !== -1; index = template.indexOf("{{", index + 2)) {
		PLACEHOLDER_AT.lastIndex = index;
		if (PLACEHOLDER_AT.test(template)) {
			continue;
		}
		const lineEnd = nextLineEnd(index);
		const close = nextClose(index + 2);
		const end = close !== -1 && (lineEnd === -1 || close < lineEnd) ? close + 2 : lineEnd === -1 ? template.length : lineEnd;
		literal.push(template.slice(index, Math.min(end, index + MAX_LITERAL_LENGTH)));
	}

	return {
		placeholders,
		unknown: placeholders.filter((name) => !knownNames.has(name)),
		missingRequired: [...new Set(required)].filter((name) => !placeholders.includes(name)),
		literal
	};
}

/**
 * Closes a code fence left open in each named variable, so one truncated request or reply cannot turn the rest of the
 * rendered note into code. Variables that are not named, and the template itself, are left as they are.
 */
export function closeOpenFencesInVariables(variables: Readonly<Record<string, string>>, keys: readonly string[]): Record<string, string> {
	return {
		...variables,
		...Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(variables, key)).map((key) => [key, closeOpenFence(variables[key])]))
	};
}

export interface DateTemplateValues {
	date: string;
	dateTime: string;
}

/**
 * Both values come from the same shifted clock so the date part of dateTime always matches date, even near midnight.
 * The offset is a parameter (Date#getTimezoneOffset convention: minutes behind UTC) so callers and tests control it.
 */
export function buildDateTemplateValues(instant: Date, timezoneOffsetMinutes: number = instant.getTimezoneOffset()): DateTemplateValues {
	const shifted = new Date(instant.getTime() - timezoneOffsetMinutes * 60_000);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
	const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
	const offsetMinutes = Math.abs(timezoneOffsetMinutes);
	const sign = timezoneOffsetMinutes > 0 ? "-" : "+";
	const offset = `${sign}${pad(Math.floor(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
	return { date, dateTime: `${date}T${time}${offset}` };
}

// Unlike trim(), this keeps the indentation of the first content line, which matters for indented code blocks.
export function trimOuterBlankLines(text: string): string {
	return text.replace(LEADING_BLANK_LINES, "").trimEnd();
}

const CUSTOM_INSTRUCTIONS_PLACEHOLDER = /{{\s*customInstructions\s*}}/;

/**
 * Built-in workflow prompts never contain {{customInstructions}}, so the global preference is appended unless the
 * template already places it, keeping it after the stable workflow instructions and before the note context.
 */
export function appendWorkflowUserPreferences(renderedPrompt: string, template: string, customInstructions: string): string {
	const instructions = customInstructions.trim();
	if (!instructions || CUSTOM_INSTRUCTIONS_PLACEHOLDER.test(template)) {
		return renderedPrompt;
	}
	return `${renderedPrompt}\n\n# User preferences\nFollow these preferences from the AskMate settings unless they conflict with the goal or constraints above:\n${instructions}`;
}
