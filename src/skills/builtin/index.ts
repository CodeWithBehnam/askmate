import { MAX_BUILT_IN_BODY } from "../limits";
import { parseSkillFile } from "../parse";
import { renderSkillMarkdown, type SkillDefinition } from "../render";
import { hashSkillText, type Sha256 } from "../trust";
import type { Skill } from "../types";
import type { YamlParser } from "../frontmatter";
import { MERMAID_DIAGRAMS_SKILL } from "./mermaidDiagrams";

/**
 * Skills that ship with AskMate. They are always trusted and a vault skill can never take their name.
 * Only skills that earn their place by fixing a hard problem belong here; examples live in the starter templates.
 */
export const BUILT_IN_SKILL_DEFINITIONS: readonly SkillDefinition[] = [MERMAID_DIAGRAMS_SKILL];

export const BUILT_IN_SKILL_NAMES: ReadonlySet<string> = new Set(BUILT_IN_SKILL_DEFINITIONS.map((definition) => definition.name));

export function builtInSkillId(name: string): string {
	return `built-in:${name}`;
}

/** The SKILL.md text of a built-in skill, for the viewer and for publishing the skill on its own. */
export function renderBuiltInSkill(definition: SkillDefinition): string {
	return renderSkillMarkdown(definition);
}

/** Builds the built-in catalogue through the same parser as vault files, so both obey one set of rules. */
export async function loadBuiltInSkills(parseYaml: YamlParser, sha256: Sha256): Promise<Skill[]> {
	return Promise.all(BUILT_IN_SKILL_DEFINITIONS.map(async (definition) => {
		const raw = renderBuiltInSkill(definition);
		return parseSkillFile({
			path: "",
			raw,
			hash: await hashSkillText(raw, sha256),
			source: "built-in",
			fallbackName: definition.name,
			parseYaml,
			maxBody: MAX_BUILT_IN_BODY
		});
	}));
}

export { MERMAID_DIAGRAMS_SKILL };
