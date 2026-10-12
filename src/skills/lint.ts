import { normaliseNewlines, stripComments, stripInvisible } from "./sanitise";
import type { LintFinding, LintId } from "./types";

interface TextHit {
	index: number;
	length: number;
}

interface LintRule {
	id: LintId;
	label: string;
	find: (text: string) => TextHit | null;
}

const fromPattern = (pattern: RegExp) => (text: string): TextHit | null => {
	const match = pattern.exec(text);
	return match ? { index: match.index, length: match[0].length } : null;
};

const ENCODED_RUN = /[A-Za-z0-9+/=]{80,}/g;

/** A long run that mixes upper case, lower case and digits looks like base64 or a key, unlike a rule of dashes or equals signs. */
function findEncodedBlob(text: string): TextHit | null {
	for (const match of text.matchAll(ENCODED_RUN)) {
		const run = match[0];
		if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) {
			return { index: match.index ?? 0, length: run.length };
		}
	}
	return null;
}

/**
 * Advisory patterns that appear in prompt-injection payloads or in skills that reach beyond their job. They help a
 * reviewer look in the right place. They are never the only defence: the trust prompt, sanitising and the fixed
 * precedence rules in the prompt are the controls.
 */
export const LINT_RULES: readonly LintRule[] = [
	{
		id: "ignore-instructions",
		label: "Tells the model to ignore earlier instructions",
		find: fromPattern(/\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system|developer|all)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?)\b/i)
	},
	{
		id: "hide-from-user",
		label: "Asks the model to hide something from the user",
		find: fromPattern(/\b(?:do not|don't|never)\b[^.\n]{0,30}\b(?:tell|inform|mention|reveal|show|disclose)\b[^.\n]{0,30}\b(?:user|owner|reader)\b/i)
	},
	{
		id: "secrets",
		label: "Mentions secrets or credentials",
		find: fromPattern(/\b(?:api[ _-]?keys?|secrets?|passwords?|passphrases?|tokens?|credentials?)\b/i)
	},
	{
		id: "url",
		label: "Contains a URL",
		find: fromPattern(/\b(?:https?|ftp|wss?):\/\/\S+/i)
	},
	{
		id: "encoded-blob",
		label: "Contains a long encoded blob",
		find: findEncodedBlob
	},
	{
		id: "run-commands",
		label: "Asks to run commands or code",
		find: fromPattern(/\b(?:run|execute|eval)\b[^.\n]{0,25}\b(?:commands?|shell|scripts?|code|bash|powershell|terminal)\b/i)
	},
	{
		id: "edit-other-notes",
		label: "Asks to change settings or other notes",
		find: fromPattern(/\b(?:modify|edit|overwrite|delete|write to|rewrite)\b[^.\n]{0,30}\b(?:settings|AGENTS\.md|CLAUDE\.md|other notes?|every note|all notes|the vault|my vault)\b/i)
	}
];

const MAX_EXCERPT = 80;

function excerptOf(text: string, hit: TextHit): string {
	const start = Math.max(0, hit.index - 10);
	const flat = text.slice(start, hit.index + Math.min(hit.length, MAX_EXCERPT)).replace(/\s+/g, " ").trim();
	return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT - 3)}...` : flat;
}

/**
 * Scans the raw text, including parts that reading view hides, and any text recovered from invisible tag characters.
 * A finding is marked `hidden` when it only appears in text a reader would not see.
 */
export function lintSkillText(raw: string): LintFinding[] {
	const invisible = stripInvisible(normaliseNewlines(raw));
	const visible = stripComments(invisible.text).text;
	const everything = invisible.hiddenText ? `${invisible.text}\n${invisible.hiddenText}` : invisible.text;
	const findings: LintFinding[] = [];
	for (const rule of LINT_RULES) {
		const hit = rule.find(everything);
		if (!hit) {
			continue;
		}
		findings.push({
			id: rule.id,
			label: rule.label,
			excerpt: excerptOf(everything, hit),
			hidden: rule.find(visible) === null
		});
	}
	return findings;
}
