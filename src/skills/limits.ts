/** Folder that holds vault skills unless the user chooses another visible folder. */
export const DEFAULT_SKILLS_FOLDER = "AskMate/Skills";

export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_TITLE = 80;
export const MAX_DESCRIPTION = 1024;
export const MAX_WHEN_TO_USE = 512;
export const MAX_ARGUMENT_HINT = 80;
export const MAX_TRIGGERS = 24;
export const MAX_TRIGGER_LENGTH = 60;
export const MAX_REQUIRED_SERVERS = 8;
export const MAX_SKILL_VERSION = 40;
/**
 * The only form a skill version may take: up to 40 letters, digits, dots, underscores, plus signs and hyphens, starting
 * with a letter or digit. A version ends up in an attribute of the skill tag in the instructions, so quotes, angle
 * brackets and spaces must never get through. Anything else is dropped and the content hash prefix is used instead.
 */
export const SKILL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;

/** Characters allowed in the body of a skill the user wrote. */
export const MAX_VAULT_BODY = 10_000;
/** Characters allowed in the body of a skill that ships with AskMate. */
export const MAX_BUILT_IN_BODY = 14_000;

/** A scan reads at most this many skill files, in path order. */
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
/** Folder depth below the skills folder: `<name>.md` is depth 1 and `<name>/SKILL.md` is depth 2. */
export const MAX_SCAN_DEPTH = 2;
/** Ignored companion files listed per skill folder in the review screen. */
export const MAX_IGNORED_LISTED = 20;

export const MAX_SKILLS_PER_REQUEST = 3;
export const MAX_AUTO_SKILLS = 1;
/** Sum of the injected bodies of every skill in one request. */
export const MAX_TOTAL_SKILL_CHARACTERS = 16_000;

/** Quiet period after a vault event before the skills folder is scanned again. */
export const SKILL_RESCAN_DEBOUNCE_MS = 600;
