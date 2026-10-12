import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	hashSkillText,
	isSkillTrusted,
	isValidHash,
	normaliseForHash,
	parseSkillFile,
	sha256Hex,
	skillStatus,
	type Skill
} from "../src/skills";

const parseYaml = (text: string): unknown => Bun.YAML.parse(text);
const BASE = "---\nname: demo\ndescription: A demo skill. Use for demos.\n---\n# Goal\nDo the demo.\n";

async function vaultSkill(raw: string, path = "AskMate/Skills/demo/SKILL.md"): Promise<Skill> {
	return parseSkillFile({ path, raw, hash: await hashSkillText(raw), source: "vault", fallbackName: "demo", parseYaml });
}

describe("content hash", () => {
	test("matches the reference SHA-256 of the normalised text", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(await hashSkillText(BASE)).toBe(createHash("sha256").update(BASE).digest("hex"));
		expect(isValidHash(await hashSkillText(BASE))).toBe(true);
	});

	test("ignores a byte order mark and line-ending style, which sync tools change without anyone editing", async () => {
		const reference = await hashSkillText(BASE);
		expect(await hashSkillText(BASE.replace(/\n/g, "\r\n"))).toBe(reference);
		expect(await hashSkillText(BASE.replace(/\n/g, "\r"))).toBe(reference);
		expect(await hashSkillText(String.fromCodePoint(0xfeff) + BASE)).toBe(reference);
		expect(normaliseForHash(`${String.fromCodePoint(0xfeff)}a\r\nb\rc`)).toBe("a\nb\nc");
	});

	test.each([
		["one changed letter", (text: string) => text.replace("Do the demo", "Do the demp")],
		["an appended character", (text: string) => `${text}x`],
		["a trailing space", (text: string) => text.replace("demo.\n", "demo. \n")],
		["a missing final newline", (text: string) => text.replace(/\n$/, "")],
		["an extra blank line", (text: string) => text.replace("# Goal", "\n# Goal")],
		["a new HTML comment", (text: string) => `${text}<!-- hello -->\n`],
		["an edit inside a comment", (text: string) => `${text}%% a %%\n`.replace("%% a %%", "%% b %%")],
		["an invisible zero-width space", (text: string) => text.replace("Do the", `Do${String.fromCodePoint(0x200b)} the`)],
		["a Unicode tag character", (text: string) => `${text}${String.fromCodePoint(0xe0041)}`],
		["a frontmatter edit", (text: string) => text.replace("A demo skill", "A demo skill, changed")],
		["a changed name", (text: string) => text.replace("name: demo", "name: demo2")],
		["a swapped look-alike letter", (text: string) => text.replace("demo skill", "demо skill")]
	])("%s changes the hash", async (_label, change) => {
		const original = await hashSkillText(BASE);
		const changed = change(BASE);
		expect(changed).not.toBe(BASE);
		expect(await hashSkillText(changed)).not.toBe(original);
	});

	test("accepts an injected hash function so tests and hosts can replace Web Crypto", async () => {
		expect(await hashSkillText("x", async () => "f".repeat(64))).toBe("f".repeat(64));
	});
});

describe("trust and status", () => {
	test("a vault skill is trusted only for the exact approved hash", async () => {
		const skill = await vaultSkill(BASE);
		expect(isSkillTrusted(skill, {})).toBe(false);
		expect(isSkillTrusted(skill, { [skill.id]: skill.hash })).toBe(true);
		expect(isSkillTrusted(skill, { [skill.id]: "0".repeat(64) })).toBe(false);
		expect(isSkillTrusted(skill, { "vault:other": skill.hash })).toBe(false);
	});

	test("any edit after approval sends the skill back to review", async () => {
		const approved = await vaultSkill(BASE);
		const trusted = { [approved.id]: approved.hash };
		expect(skillStatus(approved, trusted)).toBe("ready");
		for (const edited of [`${BASE}\n`, BASE.replace("demos", "demons"), `${BASE}<!-- note -->`, BASE.replace("Do ", `Do${String.fromCodePoint(0x200b)}`)]) {
			const skill = await vaultSkill(edited);
			expect(skill.id).toBe(approved.id);
			expect(skillStatus(skill, trusted)).toBe("needs-review");
		}
	});

	test("a line-ending change alone keeps the approval", async () => {
		const approved = await vaultSkill(BASE);
		const converted = await vaultSkill(BASE.replace(/\n/g, "\r\n"));
		expect(skillStatus(converted, { [approved.id]: approved.hash })).toBe("ready");
	});

	test("built-in skills are always trusted and never need review", async () => {
		const raw = BASE;
		const builtIn = parseSkillFile({ path: "", raw, hash: await hashSkillText(raw), source: "built-in", fallbackName: "demo", parseYaml });
		expect(isSkillTrusted(builtIn, {})).toBe(true);
		expect(skillStatus(builtIn, {})).toBe("built-in");
	});

	test("an invalid skill is never trusted, even with a matching hash", async () => {
		const raw = "---\nname: demo\n---\nbody";
		const skill = await vaultSkill(raw);
		expect(skill.valid).toBe(false);
		expect(isSkillTrusted(skill, { [skill.id]: skill.hash })).toBe(false);
		expect(skillStatus(skill, { [skill.id]: skill.hash })).toBe("invalid");
	});

	test("disabled wins over ready", async () => {
		const skill = await vaultSkill(BASE);
		expect(skillStatus(skill, { [skill.id]: skill.hash }, [skill.id])).toBe("disabled");
	});

	test("a non-string approval is not an approval", async () => {
		const skill = await vaultSkill(BASE);
		const bogus = { [skill.id]: 1 } as unknown as Record<string, string>;
		expect(isSkillTrusted(skill, bogus)).toBe(false);
	});

	test("isValidHash accepts only 64 lower-case hex characters", () => {
		expect([isValidHash("a".repeat(64)), isValidHash("A".repeat(64)), isValidHash("a".repeat(63)), isValidHash("g".repeat(64)), isValidHash("")]).toEqual([true, false, false, false, false]);
	});
});
