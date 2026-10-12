import { DEFAULT_SKILLS_FOLDER, MAX_IGNORED_LISTED, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES } from "./limits";
import type { Diagnostic, Skill } from "./types";

export interface SkillFileInfo {
	/** Vault-relative path using forward slashes. */
	path: string;
	size: number;
}

export interface FolderResult {
	folder: string;
	/** Set when the configured folder was unusable and the default was substituted. */
	diagnostic: Diagnostic | null;
}

/**
 * A skills folder must be a visible vault folder: a dot-folder is hidden from the file explorer, which would
 * let skills exist where the user never sees them. Anything unusable falls back to the default.
 */
export function normaliseSkillsFolder(input: string): FolderResult {
	const cleaned = input
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^\/+|\/+$/g, "");
	const segments = cleaned.split("/");
	const unusable = cleaned === "" || segments.some((segment) => segment === ".." || segment === "." || segment.startsWith("."));
	if (unusable) {
		return {
			folder: DEFAULT_SKILLS_FOLDER,
			diagnostic: {
				level: "warn",
				code: "bad-folder",
				message: cleaned === ""
					? `No skills folder is set, so ${DEFAULT_SKILLS_FOLDER} is used.`
					: `The skills folder "${input.trim()}" is hidden or leaves the vault, so ${DEFAULT_SKILLS_FOLDER} is used.`
			}
		};
	}
	return { folder: cleaned, diagnostic: null };
}

export function isInSkillsFolder(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

export interface ScanCandidate {
	path: string;
	/** Folder name for `<name>/SKILL.md`, file name without extension for `<name>.md`. */
	fallbackName: string;
	kind: "folder" | "file";
	size: number;
	oversized: boolean;
	/** Companion files in the same skill folder. They are listed and ignored. */
	ignoredResources: string[];
}

export interface ScanPlan {
	candidates: ScanCandidate[];
	/** Skill files left out because of the file limit. */
	dropped: number;
	diagnostics: Diagnostic[];
}

const hasHiddenSegment = (segments: readonly string[]): boolean => segments.some((segment) => segment.startsWith("."));
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Decides which files in the skills folder are skills. Depth 1 is `<name>.md` and depth 2 is `<name>/SKILL.md`.
 * Deeper files, such as scripts or references, are never read: they are only listed as ignored.
 */
export function planSkillScan(files: readonly SkillFileInfo[], folder: string): ScanPlan {
	const resources = new Map<string, string[]>();
	const found: ScanCandidate[] = [];
	for (const file of files) {
		if (!file.path.startsWith(`${folder}/`)) {
			continue;
		}
		const segments = file.path.slice(folder.length + 1).split("/");
		if (hasHiddenSegment(segments)) {
			continue;
		}
		const [first = "", second = ""] = segments;
		const lowerFile = (segments[segments.length - 1] ?? "").toLowerCase();
		if (segments.length === 1) {
			if (lowerFile.endsWith(".md") && lowerFile !== "readme.md") {
				found.push({
					path: file.path,
					fallbackName: first.replace(/\.md$/i, ""),
					kind: "file",
					size: file.size,
					oversized: file.size > MAX_SKILL_FILE_BYTES,
					ignoredResources: []
				});
			}
			continue;
		}
		if (segments.length === 2 && second.toLowerCase() === "skill.md") {
			found.push({
				path: file.path,
				fallbackName: first,
				kind: "folder",
				size: file.size,
				oversized: file.size > MAX_SKILL_FILE_BYTES,
				ignoredResources: []
			});
			continue;
		}
		resources.set(first, [...(resources.get(first) ?? []), segments.slice(1).join("/")]);
	}
	found.sort((left, right) => compare(left.path, right.path));
	const diagnostics: Diagnostic[] = [];
	const kept = found.slice(0, MAX_SKILL_FILES);
	if (found.length > kept.length) {
		diagnostics.push({
			level: "warn",
			code: "too-many-files",
			message: `Only the first ${MAX_SKILL_FILES} skill files are read. ${found.length - kept.length} were left out.`
		});
	}
	return {
		candidates: kept.map((candidate) => ({
			...candidate,
			ignoredResources: candidate.kind === "folder"
				? (resources.get(candidate.fallbackName) ?? []).sort(compare).slice(0, MAX_IGNORED_LISTED)
				: []
		})),
		dropped: found.length - kept.length,
		diagnostics
	};
}

function asInvalid(skill: Skill, extra: Diagnostic): Skill {
	return {
		...skill,
		id: `invalid:${skill.path}`,
		valid: false,
		body: "",
		characters: 0,
		diagnostics: [...skill.diagnostics, extra]
	};
}

/**
 * Combines the built-in skills with the vault's. A built-in skill is never shadowed: a vault skill that reuses its
 * name is listed as invalid. When two vault files declare the same name the first path wins.
 */
export function assembleCatalogue(builtIns: readonly Skill[], vault: readonly Skill[]): Skill[] {
	const taken = new Set<string>();
	const ordered = [...vault].sort((left, right) => compare(left.path, right.path));
	const accepted = ordered.map((skill): Skill => {
		if (!skill.valid) {
			return skill;
		}
		if (builtIns.some((builtIn) => builtIn.name === skill.name)) {
			return asInvalid(skill, {
				level: "error",
				code: "shadows-built-in",
				message: `The name "${skill.name}" belongs to a built-in skill. Rename this skill to use it.`
			});
		}
		if (taken.has(skill.name)) {
			return asInvalid(skill, {
				level: "error",
				code: "duplicate-name",
				message: `Another skill file already uses the name "${skill.name}". Rename one of them.`
			});
		}
		taken.add(skill.name);
		return skill;
	});
	return [...builtIns, ...accepted];
}
