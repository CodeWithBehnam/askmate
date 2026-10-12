export type SkillSource = "built-in" | "vault";

/**
 * What a skill list row shows. `disabled` comes from user settings, `needs-review` from the trust record,
 * and `invalid` from parsing.
 */
export type SkillStatus = "built-in" | "ready" | "needs-review" | "invalid" | "disabled";

/** How a skill came to be part of a request. */
export type SkillActivation = "explicit" | "workflow" | "sticky" | "auto";

/**
 * `off` never matches. `suggest` never starts a skill on its own: the best match, built-in or trusted vault, is offered
 * as one chip. `builtin-auto` lets built-in skills start on their own and only suggests trusted vault skills.
 * `all-auto` also lets trusted vault skills start on their own.
 */
export type SkillMatchMode = "off" | "suggest" | "builtin-auto" | "all-auto";

export type DiagnosticLevel = "error" | "warn" | "info";

export type DiagnosticCode =
	| "bad-yaml"
	| "yaml-retried"
	| "no-frontmatter"
	| "unclosed-frontmatter"
	| "missing-description"
	| "bad-description"
	| "empty-body"
	| "body-too-long"
	| "file-too-large"
	| "name-missing"
	| "name-normalised"
	| "name-folder-mismatch"
	| "description-truncated"
	| "triggers-truncated"
	| "trigger-truncated"
	| "trigger-filler"
	| "field-truncated"
	| "bad-accent"
	| "bad-version"
	| "ignored-feature"
	| "shadows-built-in"
	| "duplicate-name"
	| "too-many-files"
	| "read-failed"
	| "bad-folder";

export interface Diagnostic {
	level: DiagnosticLevel;
	code: DiagnosticCode;
	message: string;
}

export type LintId =
	| "ignore-instructions"
	| "hide-from-user"
	| "secrets"
	| "url"
	| "encoded-blob"
	| "run-commands"
	| "edit-other-notes";

/** An advisory finding shown in the review screen. A finding never blocks a skill by itself. */
export interface LintFinding {
	id: LintId;
	label: string;
	/** The matching text, shortened, so the reader can find it. */
	excerpt: string;
	/** True when the match sits in text that is hidden in reading view or made of invisible characters. */
	hidden: boolean;
}

export interface SanitisedText {
	text: string;
	/** Invisible characters removed (tag characters, bidi controls, zero-width characters, byte order marks). */
	invisibleRemoved: number;
	/** HTML and `%%` comments removed. */
	commentsRemoved: number;
	/** Text recovered from Unicode tag characters, which is how instructions are smuggled past a reader. */
	hiddenText: string;
}

export interface SkillManifest {
	name: string;
	/** Display name. Falls back to the name. */
	title: string;
	description: string;
	whenToUse: string;
	triggers: readonly string[];
	/** False when the skill sets `disable-model-invocation`: it then only runs when chosen explicitly. */
	autoSuggest: boolean;
	/** False hides the skill from pickers and slash menus. */
	userInvocable: boolean;
	argumentHint: string;
	outputKind: string;
	icon: string;
	/** `#rrggbb` or an empty string. */
	accent: string;
	requiresMcp: readonly string[];
	/** Matches `SKILL_VERSION_PATTERN`, or is empty when the file set none or set one that was not plain. */
	version: string;
}

export interface Skill {
	/** `built-in:<name>` or `vault:<name>`. Invalid vault files use `invalid:<path>`. */
	id: string;
	name: string;
	source: SkillSource;
	/** Vault path, or an empty string for a built-in skill. */
	path: string;
	manifest: SkillManifest;
	/** The manifest version, else the first 8 characters of the hash. Always matches `SKILL_VERSION_PATTERN` or is empty, so it is safe in a tag attribute. */
	version: string;
	/** SHA-256 of the file text with line endings normalised. The trust record stores this value. */
	hash: string;
	/** The file text as read, with line endings normalised. Shown in the review screen. */
	raw: string;
	/** Sanitised instructions, which is what a request receives. */
	body: string;
	characters: number;
	/** False for a file that could not be turned into a skill; it is listed so the user can fix it. */
	valid: boolean;
	diagnostics: readonly Diagnostic[];
	lint: readonly LintFinding[];
	sanitised: Pick<SanitisedText, "invisibleRemoved" | "commentsRemoved" | "hiddenText">;
	/** Features of the Agent Skills format that this version ignores, such as scripts or `allowed-tools`. */
	ignored: readonly string[];
}

/** What a request carries into the prompt for one skill. */
export interface ResolvedSkill {
	id: string;
	name: string;
	source: SkillSource;
	/** Same rule as `Skill.version`. The name and id are safe slugs too, but the body is free text and must be escaped. */
	version: string;
	hash: string;
	body: string;
	activation: SkillActivation;
	characters: number;
}

export type SkillNoticeKind =
	| "missing"
	| "disabled"
	| "needs-review"
	| "invalid"
	| "over-limit"
	| "over-budget"
	| "not-invocable";

/** A message for the person using the sidebar about a skill that was asked for but not used. */
export interface SkillNotice {
	kind: SkillNoticeKind;
	/** The id or name the request used. */
	ref: string;
	activation: SkillActivation;
	message: string;
}

/** A skill that matched the request but was not started, offered as a chip. */
export interface SkillSuggestion {
	id: string;
	name: string;
	score: number;
	reason: string;
}

export interface SkillResolution {
	/** Sorted by id so the instructions stay identical between requests and caches keep working. */
	skills: readonly ResolvedSkill[];
	notices: readonly SkillNotice[];
	suggestion: SkillSuggestion | null;
	totalCharacters: number;
}

export interface ResolveInput {
	/** The user's question. Only its first characters are matched. */
	request: string;
	/** Skill ids or names chosen with a slash command, an @skill mention or a chip. */
	explicit?: readonly string[];
	/** Skill ids a workflow lists. */
	workflow?: readonly string[];
	/** Skill ids pinned to the current thread. */
	sticky?: readonly string[];
	/** Set by "run again without skill": nothing starts on its own and nothing is suggested. */
	suppressAuto?: boolean;
	/** The catalogue. SkillService fills this in. */
	skills?: readonly Skill[];
	/** Skill id to the content hash the user approved. SkillService fills this in. */
	trusted?: Readonly<Record<string, string>>;
	disabledIds?: readonly string[];
	matchMode?: SkillMatchMode;
	/** Master switch. When false the result is empty. */
	enabled?: boolean;
}
