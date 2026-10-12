import { MAX_SKILLS_PER_REQUEST, MAX_TOTAL_SKILL_CHARACTERS } from "./limits";
import { matchSkill } from "./match";
import { slugifySkillName } from "./parse";
import { isSkillTrusted } from "./trust";
import type {
	ResolveInput,
	ResolvedSkill,
	Skill,
	SkillActivation,
	SkillMatchMode,
	SkillNotice,
	SkillNoticeKind,
	SkillResolution,
	SkillSource,
	SkillSuggestion
} from "./types";

const PREFIXES: ReadonlyArray<readonly [string, SkillSource]> = [
	["built-in:", "built-in"],
	["vault:", "vault"]
];

interface Lookup {
	skill: Skill | null;
	/** A file with that name exists but could not be read as a skill. */
	invalid: boolean;
}

/** Finds a skill by id (`built-in:name`) or by plain name. A source prefix restricts the search to that source. */
export function findSkill(skills: readonly Skill[], ref: string): Lookup {
	const text = ref.trim();
	if (text === "") {
		return { skill: null, invalid: false };
	}
	const prefix = PREFIXES.find(([marker]) => text.toLowerCase().startsWith(marker));
	const source = prefix?.[1];
	const name = slugifySkillName(prefix ? text.slice(prefix[0].length) : text);
	const inScope = skills.filter((skill) => source === undefined || skill.source === source);
	const valid = inScope.find((skill) => skill.valid && (skill.id === text || skill.name === name));
	if (valid) {
		return { skill: valid, invalid: false };
	}
	return { skill: null, invalid: inScope.some((skill) => !skill.valid && skill.name === name) };
}

const quote = (name: string): string => `"${name}"`;

function notice(kind: SkillNoticeKind, ref: string, activation: SkillActivation, message: string): SkillNotice {
	return { kind, ref, activation, message };
}

interface Picked {
	skill: Skill;
	activation: SkillActivation;
}

/** Whether a matched skill is applied without the person choosing it. Otherwise it is offered as a chip. */
function startsOnItsOwn(mode: SkillMatchMode, source: SkillSource): boolean {
	switch (mode) {
		case "off":
		case "suggest":
			return false;
		case "builtin-auto":
			return source === "built-in";
		case "all-auto":
			return true;
	}
}

const compareIds =(left: ResolvedSkill, right: ResolvedSkill): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Chooses the skills for one request. Channels, in priority order: explicit (slash, @skill, chip), workflow,
 * sticky (pinned to the thread) and auto (the matcher). Rules:
 * - a vault skill is inert unless the user approved its exact content hash;
 * - disabled, invalid and unknown skills become notices, never errors, so a deleted sticky skill degrades gracefully;
 * - auto never runs when the user or a workflow already chose skills, and never runs for "run without skill";
 * - `suggest` never starts a skill on its own: a matching built-in or trusted vault skill becomes the suggestion;
 * - built-ins start on their own in `builtin-auto` mode; a trusted vault skill is only suggested unless `all-auto`;
 * - at most 3 skills and 16,000 body characters in total, higher priority channels first;
 * - the result is sorted by id so the instructions are identical between requests.
 */
export function resolveSkills(input: ResolveInput): SkillResolution {
	const empty: SkillResolution = { skills: [], notices: [], suggestion: null, totalCharacters: 0 };
	if (input.enabled === false) {
		return empty;
	}
	const catalogue = input.skills ?? [];
	const trusted = input.trusted ?? {};
	const disabled = new Set(input.disabledIds ?? []);
	const matchMode = input.matchMode ?? "builtin-auto";
	const notices: SkillNotice[] = [];
	const picked = new Map<string, Picked>();
	const seenRefs = new Set<string>();

	const channels: ReadonlyArray<readonly [SkillActivation, readonly string[]]> = [
		["explicit", input.explicit ?? []],
		["workflow", input.workflow ?? []],
		["sticky", input.sticky ?? []]
	];
	for (const [activation, refs] of channels) {
		for (const ref of refs) {
			const key = `${activation}:${ref}`;
			if (seenRefs.has(key)) {
				continue;
			}
			seenRefs.add(key);
			const { skill, invalid } = findSkill(catalogue, ref);
			if (!skill) {
				notices.push(invalid
					? notice("invalid", ref, activation, `Skill ${quote(ref)} has errors and was skipped.`)
					: notice("missing", ref, activation, `Skill ${quote(ref)} is not available and was skipped.`));
			} else if (disabled.has(skill.id)) {
				notices.push(notice("disabled", ref, activation, `Skill ${quote(skill.name)} is turned off in settings and was skipped.`));
			} else if (!isSkillTrusted(skill, trusted)) {
				notices.push(notice("needs-review", ref, activation, `Skill ${quote(skill.name)} needs review before it can be used.`));
			} else if (activation === "explicit" && !skill.manifest.userInvocable) {
				notices.push(notice("not-invocable", ref, activation, `Skill ${quote(skill.name)} cannot be chosen directly.`));
			} else if (!picked.has(skill.id)) {
				picked.set(skill.id, { skill, activation });
			}
		}
	}

	let suggestion: SkillSuggestion | null = null;
	// A person or workflow that names skills has taken control, even when one of them was skipped, so nothing else starts on its own.
	const chosenByPerson = (input.explicit?.length ?? 0) + (input.workflow?.length ?? 0) > 0;
	if (matchMode !== "off" && !input.suppressAuto && !chosenByPerson) {
		const eligible = catalogue.filter((skill) =>
			skill.valid && skill.manifest.autoSuggest && !disabled.has(skill.id) && !picked.has(skill.id) && isSkillTrusted(skill, trusted));
		const decision = matchSkill(input.request, eligible.map((skill) => ({ id: skill.id, manifest: skill.manifest })));
		const match = decision.kind === "match" ? eligible.find((skill) => skill.id === decision.id) : undefined;
		if (decision.kind === "match" && match) {
			if (startsOnItsOwn(matchMode, match.source)) {
				picked.set(match.id, { skill: match, activation: "auto" });
			} else {
				suggestion = { id: match.id, name: match.name, score: decision.score, reason: decision.reason };
			}
		}
	}

	const kept: ResolvedSkill[] = [];
	let total = 0;
	for (const { skill, activation } of picked.values()) {
		if (kept.length >= MAX_SKILLS_PER_REQUEST) {
			if (activation !== "auto") {
				notices.push(notice("over-limit", skill.id, activation, `At most ${MAX_SKILLS_PER_REQUEST} skills run at once, so ${quote(skill.name)} was skipped.`));
			}
			continue;
		}
		if (total + skill.characters > MAX_TOTAL_SKILL_CHARACTERS) {
			if (activation !== "auto") {
				notices.push(notice("over-budget", skill.id, activation, `${quote(skill.name)} was skipped because the chosen skills would be longer than ${MAX_TOTAL_SKILL_CHARACTERS.toLocaleString("en-GB")} characters.`));
			}
			continue;
		}
		total += skill.characters;
		kept.push({
			id: skill.id,
			name: skill.name,
			source: skill.source,
			version: skill.version,
			hash: skill.hash,
			body: skill.body,
			activation,
			characters: skill.characters
		});
	}
	return { skills: kept.sort(compareIds), notices, suggestion, totalCharacters: total };
}
