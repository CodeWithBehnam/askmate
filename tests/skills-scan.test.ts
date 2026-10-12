import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SKILLS_FOLDER,
	MAX_IGNORED_LISTED,
	MAX_SKILL_FILE_BYTES,
	MAX_SKILL_FILES,
	assembleCatalogue,
	hashSkillText,
	isInSkillsFolder,
	normaliseSkillsFolder,
	parseSkillFile,
	planSkillScan,
	type Skill,
	type SkillFileInfo
} from "../src/skills";

const parseYaml = (text: string): unknown => Bun.YAML.parse(text);
const file = (path: string, size = 100): SkillFileInfo => ({ path, size });
const FOLDER = "AskMate/Skills";

describe("normaliseSkillsFolder", () => {
	test.each([
		["AskMate/Skills", "AskMate/Skills"],
		["  AskMate/Skills/  ", "AskMate/Skills"],
		["/AskMate//Skills", "AskMate/Skills"],
		["./Skills", "Skills"],
		["AskMate\\Skills", "AskMate/Skills"],
		["Notes/My Skills", "Notes/My Skills"]
	])("%p is used as %p", (input, expected) => {
		expect(normaliseSkillsFolder(input)).toEqual({ folder: expected, diagnostic: null });
	});

	test.each([[""], ["   "], ["/"], [".skills"], ["AskMate/.hidden"], [".obsidian/skills"], ["../outside"], ["Notes/../../x"], ["."]])("%p falls back to the default folder with a warning", (input) => {
		const result = normaliseSkillsFolder(input);
		expect(result.folder).toBe(DEFAULT_SKILLS_FOLDER);
		expect(result.diagnostic).toMatchObject({ level: "warn", code: "bad-folder" });
	});

	test("a path is inside the folder only below it", () => {
		expect(isInSkillsFolder("AskMate/Skills/a/SKILL.md", FOLDER)).toBe(true);
		expect(isInSkillsFolder("AskMate/Skills", FOLDER)).toBe(true);
		expect(isInSkillsFolder("AskMate/SkillsOther/a.md", FOLDER)).toBe(false);
		expect(isInSkillsFolder("Elsewhere/a.md", FOLDER)).toBe(false);
	});
});

describe("planSkillScan", () => {
	test("reads <name>.md at depth 1 and <name>/SKILL.md at depth 2, in path order", () => {
		const plan = planSkillScan([
			file(`${FOLDER}/zeta/SKILL.md`),
			file(`${FOLDER}/alpha.md`),
			file(`${FOLDER}/beta/skill.md`),
			file(`${FOLDER}/README.md`),
			file(`${FOLDER}/notes.txt`),
			file(`${FOLDER}/image.png`)
		], FOLDER);
		expect(plan.candidates.map((candidate) => [candidate.path, candidate.fallbackName, candidate.kind])).toEqual([
			[`${FOLDER}/alpha.md`, "alpha", "file"],
			[`${FOLDER}/beta/skill.md`, "beta", "folder"],
			[`${FOLDER}/zeta/SKILL.md`, "zeta", "folder"]
		]);
		expect(plan.dropped).toBe(0);
		expect(plan.diagnostics).toEqual([]);
	});

	test("never reads files deeper than the scan depth, only lists them as ignored companions", () => {
		const plan = planSkillScan([
			file(`${FOLDER}/tool/SKILL.md`),
			file(`${FOLDER}/tool/scripts/run.py`),
			file(`${FOLDER}/tool/references/api.md`),
			file(`${FOLDER}/tool/notes.md`),
			file(`${FOLDER}/nested/deeper/SKILL.md`),
			file(`${FOLDER}/other/sub/dir/file.md`)
		], FOLDER);
		expect(plan.candidates.map((candidate) => candidate.path)).toEqual([`${FOLDER}/tool/SKILL.md`]);
		expect(plan.candidates[0]?.ignoredResources).toEqual(["notes.md", "references/api.md", "scripts/run.py"]);
	});

	test("lists at most 20 ignored companions per skill", () => {
		const extras = Array.from({ length: 30 }, (_, index) => file(`${FOLDER}/tool/assets/a${String(index).padStart(2, "0")}.png`));
		const plan = planSkillScan([file(`${FOLDER}/tool/SKILL.md`), ...extras], FOLDER);
		expect(plan.candidates[0]?.ignoredResources).toHaveLength(MAX_IGNORED_LISTED);
	});

	test("skips hidden files and folders anywhere in the path", () => {
		const plan = planSkillScan([
			file(`${FOLDER}/.trash/old/SKILL.md`),
			file(`${FOLDER}/.hidden.md`),
			file(`${FOLDER}/visible/.git/SKILL.md`),
			file(`${FOLDER}/visible/SKILL.md`)
		], FOLDER);
		expect(plan.candidates.map((candidate) => candidate.path)).toEqual([`${FOLDER}/visible/SKILL.md`]);
	});

	test("ignores files outside the folder, including a sibling folder with a shared prefix", () => {
		const plan = planSkillScan([file("Other/a.md"), file("AskMate/SkillsExtra/a.md"), file(`${FOLDER}/a.md`)], FOLDER);
		expect(plan.candidates.map((candidate) => candidate.path)).toEqual([`${FOLDER}/a.md`]);
	});

	test("flags files over 64 KB so they are listed but never read", () => {
		const plan = planSkillScan([file(`${FOLDER}/big.md`, MAX_SKILL_FILE_BYTES + 1), file(`${FOLDER}/edge.md`, MAX_SKILL_FILE_BYTES)], FOLDER);
		expect(plan.candidates.map((candidate) => [candidate.fallbackName, candidate.oversized])).toEqual([["big", true], ["edge", false]]);
	});

	test("reads at most 200 skill files and reports the rest", () => {
		const files = Array.from({ length: MAX_SKILL_FILES + 5 }, (_, index) => file(`${FOLDER}/s${String(index).padStart(3, "0")}.md`));
		const plan = planSkillScan(files, FOLDER);
		expect(plan.candidates).toHaveLength(MAX_SKILL_FILES);
		expect(plan.dropped).toBe(5);
		expect(plan.candidates[MAX_SKILL_FILES - 1]?.path).toBe(`${FOLDER}/s199.md`);
		expect(plan.diagnostics).toEqual([{ level: "warn", code: "too-many-files", message: expect.stringContaining("5") }]);
	});

	test("an empty folder gives an empty plan", () => {
		expect(planSkillScan([], FOLDER)).toEqual({ candidates: [], dropped: 0, diagnostics: [] });
	});
});

describe("assembleCatalogue", () => {
	async function skill(name: string, path: string, source: "built-in" | "vault" = "vault"): Promise<Skill> {
		const raw = `---\nname: ${name}\ndescription: ${name} skill.\n---\n# Goal\nDo ${name}.\n`;
		return parseSkillFile({ path, raw, hash: await hashSkillText(raw), source, fallbackName: name, parseYaml });
	}

	test("lists built-ins first, then vault skills in path order", async () => {
		const builtIn = await skill("core", "", "built-in");
		const [b, a] = await Promise.all([skill("bee", `${FOLDER}/b.md`), skill("ant", `${FOLDER}/a.md`)]);
		expect(assembleCatalogue([builtIn], [b, a]).map((item) => item.id)).toEqual(["built-in:core", "vault:ant", "vault:bee"]);
	});

	test("when two vault files claim one name the first path wins and the other is listed as invalid", async () => {
		const [first, second] = await Promise.all([skill("same", `${FOLDER}/a/SKILL.md`), skill("same", `${FOLDER}/b/SKILL.md`)]);
		const result = assembleCatalogue([], [second, first]);
		expect(result.map((item) => [item.id, item.valid])).toEqual([["vault:same", true], [`invalid:${FOLDER}/b/SKILL.md`, false]]);
		expect(result[0]?.path).toBe(`${FOLDER}/a/SKILL.md`);
		expect(result[1]?.diagnostics.at(-1)?.code).toBe("duplicate-name");
		expect(result[1]?.body).toBe("");
	});

	test("an invalid file keeps its own diagnostics and does not claim its name", async () => {
		const broken = parseSkillFile({ path: `${FOLDER}/same.md`, raw: "no frontmatter", hash: "a".repeat(64), source: "vault", fallbackName: "same", parseYaml });
		const good = await skill("same", `${FOLDER}/z.md`);
		const result = assembleCatalogue([], [broken, good]);
		expect(result.map((item) => item.valid)).toEqual([false, true]);
	});
});
