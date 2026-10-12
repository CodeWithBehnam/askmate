import { FrontmatterError, parseFrontmatterYaml, splitFrontmatter, type YamlParser } from "./frontmatter";
import {
	MAX_ARGUMENT_HINT,
	MAX_DESCRIPTION,
	MAX_REQUIRED_SERVERS,
	MAX_SKILL_FILE_BYTES,
	MAX_SKILL_NAME,
	MAX_SKILL_TITLE,
	MAX_TRIGGERS,
	MAX_TRIGGER_LENGTH,
	MAX_VAULT_BODY,
	MAX_WHEN_TO_USE,
	SKILL_VERSION_PATTERN
} from "./limits";
import { lintSkillText } from "./lint";
import { stripComments, stripInvisible } from "./sanitise";
import { COMBINING_MARKS, tokenise } from "./tokens";
import { normaliseForHash } from "./trust";
import type { Diagnostic, DiagnosticCode, DiagnosticLevel, Skill, SkillManifest, SkillSource } from "./types";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_DECLARED_NAME = 200;
const MAX_ICON = 40;
const MAX_OUTPUT_KIND = 40;

const diagnostic = (level: DiagnosticLevel, code: DiagnosticCode, message: string): Diagnostic => ({ level, code, message });

/** Lower-case ASCII with single hyphens: the form the Agent Skills format asks for. */
export function slugifySkillName(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(COMBINING_MARKS, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SKILL_NAME)
		.replace(/-+$/g, "");
}

export function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Text from a scalar YAML value with invisible characters removed and whitespace collapsed. */
function scalarText(value: unknown): string {
	const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
	return stripInvisible(text).text.replace(/\s+/g, " ").trim();
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) {
			return record[key];
		}
	}
	return undefined;
}

function flag(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		if (["true", "yes", "on"].includes(text)) {
			return true;
		}
		if (["false", "no", "off"].includes(text)) {
			return false;
		}
	}
	return fallback;
}

function listOf(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(scalarText).filter(Boolean);
	}
	if (typeof value === "string") {
		return value.split(",").map(scalarText).filter(Boolean);
	}
	return [];
}

function capped(value: unknown, max: number, label: string, diagnostics: Diagnostic[]): string {
	const text = scalarText(value);
	if (text.length > max) {
		diagnostics.push(diagnostic("warn", "field-truncated", `${label} is longer than ${max} characters and was shortened.`));
		return text.slice(0, max).trim();
	}
	return text;
}

export interface ManifestResult {
	manifest: SkillManifest | null;
	diagnostics: Diagnostic[];
}

/** Turns parsed frontmatter into a manifest. Lenient about names, strict about the description. */
export function normaliseManifest(frontmatter: unknown, fallbackName: string): ManifestResult {
	const diagnostics: Diagnostic[] = [];
	const record = typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)
		? (frontmatter as Record<string, unknown>)
		: {};
	const declared = scalarText(record.name).slice(0, MAX_DECLARED_NAME);
	const slug = slugifySkillName(declared || fallbackName);
	if (!slug) {
		return { manifest: null, diagnostics: [diagnostic("error", "name-missing", "The skill has no usable name. Set name in the frontmatter or rename the folder.")] };
	}
	if (!declared) {
		diagnostics.push(diagnostic("info", "name-missing", `No name is set, so the name "${slug}" was taken from the file or folder.`));
	} else {
		if (!NAME_PATTERN.test(declared) || declared.length > MAX_SKILL_NAME) {
			diagnostics.push(diagnostic("warn", "name-normalised", `The name "${declared}" was changed to "${slug}". Use lower-case letters, numbers and single hyphens.`));
		}
		if (slugifySkillName(fallbackName) !== slug) {
			diagnostics.push(diagnostic("warn", "name-folder-mismatch", `The name "${slug}" does not match its folder or file "${fallbackName}".`));
		}
	}

	const rawDescription = record.description;
	if (rawDescription === undefined || rawDescription === null || scalarText(rawDescription) === "") {
		const wrongType = rawDescription !== undefined && rawDescription !== null && typeof rawDescription === "object";
		return {
			manifest: null,
			diagnostics: [
				...diagnostics,
				wrongType
					? diagnostic("error", "bad-description", "The description must be plain text.")
					: diagnostic("error", "missing-description", "A description is required. It says what the skill does and when to use it.")
			]
		};
	}
	let description = scalarText(rawDescription);
	if (description.length > MAX_DESCRIPTION) {
		diagnostics.push(diagnostic("warn", "description-truncated", `The description is longer than ${MAX_DESCRIPTION} characters and was shortened.`));
		description = description.slice(0, MAX_DESCRIPTION).trim();
	}

	const rawTriggers = listOf(field(record, "triggers"));
	let truncatedTrigger = false;
	const allTriggers = Array.from(new Set(rawTriggers.map((item) => {
		if (item.length > MAX_TRIGGER_LENGTH) {
			truncatedTrigger = true;
		}
		return item.slice(0, MAX_TRIGGER_LENGTH).trim().toLowerCase();
	}).filter(Boolean)));
	if (truncatedTrigger) {
		diagnostics.push(diagnostic("warn", "trigger-truncated", `Triggers are limited to ${MAX_TRIGGER_LENGTH} characters; longer ones were shortened.`));
	}
	if (allTriggers.length > MAX_TRIGGERS) {
		diagnostics.push(diagnostic("warn", "triggers-truncated", `Only the first ${MAX_TRIGGERS} triggers are used; ${allTriggers.length - MAX_TRIGGERS} were ignored.`));
	}
	const triggers = allTriggers.slice(0, MAX_TRIGGERS);
	for (const trigger of triggers) {
		if (tokenise(trigger).length === 0) {
			diagnostics.push(diagnostic("warn", "trigger-filler", `The trigger "${trigger}" is only common words and is matched as an exact phrase. A more specific phrase works better.`));
		}
	}

	const accentText = scalarText(record.accent);
	if (accentText && !ACCENT_PATTERN.test(accentText)) {
		diagnostics.push(diagnostic("warn", "bad-accent", `The accent "${accentText}" is not a #rrggbb colour and was ignored.`));
	}
	const metadata = typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
		? (record.metadata as Record<string, unknown>)
		: {};
	const title = capped(record.title, MAX_SKILL_TITLE, "The title", diagnostics);
	// The version is written into a tag attribute in the instructions, so only a plain token is accepted.
	const versionText = scalarText(metadata.version ?? record.version);
	const version = SKILL_VERSION_PATTERN.test(versionText) ? versionText : "";
	if (versionText !== "" && version === "") {
		diagnostics.push(diagnostic("warn", "bad-version", "The version was ignored. Use up to 40 letters, numbers, dots, hyphens, underscores or plus signs, such as 1.2.0."));
	}
	return {
		manifest: {
			name: slug,
			title: title || slug,
			description,
			whenToUse: capped(field(record, "when_to_use", "when-to-use"), MAX_WHEN_TO_USE, "when_to_use", diagnostics),
			triggers,
			autoSuggest: !flag(field(record, "disable-model-invocation", "disable_model_invocation"), false),
			userInvocable: flag(field(record, "user-invocable", "user_invocable"), true),
			argumentHint: capped(field(record, "argument-hint", "argument_hint"), MAX_ARGUMENT_HINT, "argument-hint", diagnostics),
			outputKind: scalarText(field(record, "output-kind", "output_kind")).toLowerCase().slice(0, MAX_OUTPUT_KIND),
			icon: scalarText(record.icon).toLowerCase().slice(0, MAX_ICON),
			accent: ACCENT_PATTERN.test(accentText) ? accentText.toLowerCase() : "",
			requiresMcp: listOf(field(record, "requires-mcp", "requires_mcp")).slice(0, MAX_REQUIRED_SERVERS).map((item) => item.slice(0, MAX_TRIGGER_LENGTH)),
			version
		},
		diagnostics
	};
}

export interface ParseInput {
	/** Vault path, or an empty string for a built-in skill. */
	path: string;
	raw: string;
	/** SHA-256 of `normaliseForHash(raw)`, computed by the caller because hashing is asynchronous. */
	hash: string;
	source: SkillSource;
	/** The folder or file name the skill is stored under. The declared name is compared with it. */
	fallbackName: string;
	parseYaml: YamlParser;
	/** Defaults to the vault limit. Built-in skills pass their own larger limit. */
	maxBody?: number;
	ignoredResources?: readonly string[];
}

const EMPTY_MANIFEST: SkillManifest = {
	name: "",
	title: "",
	description: "",
	whenToUse: "",
	triggers: [],
	autoSuggest: false,
	userInvocable: false,
	argumentHint: "",
	outputKind: "",
	icon: "",
	accent: "",
	requiresMcp: [],
	version: ""
};

/** The hash prefix stands in for a version, but only if it is a plain token: the hash comes from the caller. */
const fallbackVersion = (hash: string): string => {
	const prefix = hash.slice(0, 8);
	return SKILL_VERSION_PATTERN.test(prefix) ? prefix : "";
};

export function skillIdFor(source: SkillSource, name: string): string {
	return `${source}:${name}`;
}

const IGNORED_FRONTMATTER: ReadonlyArray<readonly [string, string]> = [
	["allowed-tools", "allowed-tools"],
	["allowed_tools", "allowed-tools"]
];

/**
 * Reads one skill file. Never throws: a file that cannot become a skill comes back with `valid: false` and
 * diagnostics, so it can be listed and fixed instead of vanishing. Rules, in order: oversized files, missing or
 * unclosed frontmatter, bad YAML (after one retry with plain values quoted), a missing description and an empty or
 * oversized body all skip the file. A name that is not normalised or does not match its folder only warns.
 */
export function parseSkillFile(input: ParseInput): Skill {
	const text = normaliseForHash(input.raw);
	const diagnostics: Diagnostic[] = [];
	const ignored: string[] = [...(input.ignoredResources ?? [])];
	const oversized = utf8Length(text) > MAX_SKILL_FILE_BYTES;
	// A file over the limit is not scanned or shown: reading it is exactly what the limit avoids.
	const invisible = oversized ? { text: "", removed: 0, hiddenText: "" } : stripInvisible(text.replace(/\0/g, ""));
	const lint = oversized ? [] : lintSkillText(text);
	const sanitised = { invisibleRemoved: invisible.removed, commentsRemoved: 0, hiddenText: invisible.hiddenText };

	const reject = (...reasons: Diagnostic[]): Skill => ({
		id: `invalid:${input.path || input.fallbackName}`,
		name: slugifySkillName(input.fallbackName) || input.fallbackName,
		source: input.source,
		path: input.path,
		manifest: { ...EMPTY_MANIFEST, name: slugifySkillName(input.fallbackName) },
		version: "",
		hash: input.hash,
		raw: oversized ? "" : text,
		body: "",
		characters: 0,
		valid: false,
		diagnostics: [...diagnostics, ...reasons],
		lint,
		sanitised,
		ignored
	});

	if (oversized) {
		return reject(diagnostic("error", "file-too-large", `The file is larger than ${MAX_SKILL_FILE_BYTES / 1024} KB, which is the limit for a skill.`));
	}
	const split = splitFrontmatter(invisible.text);
	if (split.unclosed) {
		return reject(diagnostic("error", "unclosed-frontmatter", "The frontmatter starts with --- but never ends. Add a closing --- line."));
	}
	if (split.yaml === null) {
		return reject(diagnostic("error", "no-frontmatter", "The file has no frontmatter. Start it with --- and set name and description."));
	}
	let frontmatter: Record<string, unknown>;
	try {
		const parsed = parseFrontmatterYaml(split.yaml, input.parseYaml);
		frontmatter = parsed.value;
		if (parsed.retried) {
			diagnostics.push(diagnostic("info", "yaml-retried", "The frontmatter has values with colons. They were read as plain text; wrap them in quotes to be safe."));
		}
	} catch (error) {
		const detail = error instanceof FrontmatterError ? error.message : "unknown error";
		return reject(diagnostic("error", "bad-yaml", `The frontmatter is not valid YAML (${detail}).`));
	}

	const result = normaliseManifest(frontmatter, input.fallbackName);
	diagnostics.push(...result.diagnostics);
	if (!result.manifest) {
		return reject();
	}
	const { manifest } = result;

	for (const [key, label] of IGNORED_FRONTMATTER) {
		const value = frontmatter[key];
		if (value !== undefined && value !== null && value !== "" && !ignored.includes(label)) {
			ignored.push(label);
			diagnostics.push(diagnostic("info", "ignored-feature", `${label} is ignored. Skills in AskMate only add instructions.`));
		}
	}

	const comments = stripComments(split.body);
	const body = comments.text.trim();
	sanitised.commentsRemoved = comments.removed;
	if (body === "") {
		return reject(diagnostic("error", "empty-body", "The skill has no instructions below the frontmatter."));
	}
	const maxBody = input.maxBody ?? MAX_VAULT_BODY;
	if (body.length > maxBody) {
		return reject(diagnostic("error", "body-too-long", `The instructions are ${body.length.toLocaleString("en-GB")} characters. The limit is ${maxBody.toLocaleString("en-GB")}.`));
	}

	return {
		id: skillIdFor(input.source, manifest.name),
		name: manifest.name,
		source: input.source,
		path: input.path,
		manifest,
		version: manifest.version || fallbackVersion(input.hash),
		hash: input.hash,
		raw: text,
		body,
		characters: body.length,
		valid: true,
		diagnostics,
		lint,
		sanitised,
		ignored
	};
}
