import { describe, expect, test } from "bun:test";
import { prepareFrontmatterAwareApply } from "../src/output/applyFrontmatter";

const NOTE = "---\ntitle: Old\ntags: [a]\n---\n\nOld body.\n";
const PROPOSED_WITH_FRONTMATTER = "---\ntitle: New\n---\n\nNew body.\n";
const PROPOSED_BODY = "New body.\n";

describe("prepareFrontmatterAwareApply: preserve (the default)", () => {
	test("keeps the note's frontmatter and takes the proposed body", () => {
		const plan = prepareFrontmatterAwareApply(NOTE, PROPOSED_BODY, "preserve");
		expect(plan.text).toBe("---\ntitle: Old\ntags: [a]\n---\n\nNew body.\n");
		expect(plan.warning).toBe("AskMate preserved the original YAML frontmatter.");
		expect(plan.confirm).toBeUndefined();
	});

	test("drops frontmatter the model proposed and says so", () => {
		const plan = prepareFrontmatterAwareApply(NOTE, PROPOSED_WITH_FRONTMATTER, "preserve");
		expect(plan.text).toBe("---\ntitle: Old\ntags: [a]\n---\n\nNew body.\n");
		expect(plan.warning).toBe("AskMate preserved the original YAML frontmatter and removed AI-proposed frontmatter.");
	});

	test("a note with no frontmatter stays without it", () => {
		const plan = prepareFrontmatterAwareApply("Old body.\n", PROPOSED_WITH_FRONTMATTER, "preserve");
		expect(plan.text).toBe("New body.\n");
		expect(plan.warning).toBe("AskMate preserved the original no-frontmatter state and removed AI-proposed frontmatter.");
	});

	test("no frontmatter on either side applies the proposal as it is", () => {
		expect(prepareFrontmatterAwareApply("Old.\n", "New.\n", "preserve")).toEqual({ text: "New.\n", warning: "" });
	});

	test("a reply that opens with a thematic break keeps all of its content", () => {
		const reply = "---\n\n# New title\n\nIntro text\n\n---\n\n## Section\n\nMore\n";
		expect(prepareFrontmatterAwareApply("Old.\n", reply, "preserve")).toEqual({ text: reply, warning: "" });
		const withFrontmatter = prepareFrontmatterAwareApply(NOTE, reply, "preserve");
		expect(withFrontmatter.text).toBe(`---\ntitle: Old\ntags: [a]\n---\n\n${reply}`);
		expect(withFrontmatter.text).toContain("# New title");
		expect(withFrontmatter.text).toContain("Intro text");
	});

	test("an unclosed leading rule in the reply is body text", () => {
		const reply = "---\nA paragraph after a rule.\n";
		expect(prepareFrontmatterAwareApply("Old.\n", reply, "preserve")).toEqual({ text: reply, warning: "" });
	});
});

describe("prepareFrontmatterAwareApply: replace and confirm", () => {
	test("replace takes the proposal whole and warns when it carries frontmatter", () => {
		expect(prepareFrontmatterAwareApply(NOTE, PROPOSED_WITH_FRONTMATTER, "replace")).toEqual({
			text: PROPOSED_WITH_FRONTMATTER,
			warning: "AskMate will replace YAML frontmatter from the AI output."
		});
		expect(prepareFrontmatterAwareApply(NOTE, PROPOSED_BODY, "replace")).toEqual({ text: PROPOSED_BODY, warning: "" });
	});

	test("confirm asks before changing frontmatter and stays quiet when it is unchanged", () => {
		const changed = prepareFrontmatterAwareApply(NOTE, PROPOSED_WITH_FRONTMATTER, "confirm");
		expect(changed).toEqual({
			text: PROPOSED_WITH_FRONTMATTER,
			warning: "YAML frontmatter differs from the original note.",
			confirm: "AskMate output changes YAML frontmatter. Continue with the replacement?"
		});
		const same = "---\ntitle: Old\ntags: [a]\n---\n\nNew body.\n";
		expect(prepareFrontmatterAwareApply(NOTE, same, "confirm")).toEqual({ text: same, warning: "" });
	});

	test("confirm treats new frontmatter on a bare note as a change", () => {
		expect(prepareFrontmatterAwareApply("Old.\n", PROPOSED_WITH_FRONTMATTER, "confirm").confirm).toContain("changes YAML frontmatter");
	});
});

describe("prepareFrontmatterAwareApply: malformed frontmatter", () => {
	test("asks before replacing a note whose frontmatter does not close", () => {
		const plan = prepareFrontmatterAwareApply("---\ntitle: Old\nBody never closed\n", PROPOSED_BODY, "preserve");
		expect(plan).toEqual({
			text: PROPOSED_BODY,
			warning: "Existing YAML frontmatter looked malformed.",
			confirm: "The existing YAML frontmatter appears malformed. Continue with the AI replacement?"
		});
	});

	test("a note's own frontmatter is never mistaken for body, even when it is not valid YAML", () => {
		const odd = "---\nnot yaml at all\nstill not\n---\n\nBody.\n";
		const plan = prepareFrontmatterAwareApply(odd, PROPOSED_BODY, "preserve");
		expect(plan.text).toBe("---\nnot yaml at all\nstill not\n---\n\nNew body.\n");
	});
});

describe("prepareFrontmatterAwareApply: line endings", () => {
	const crlfNote = NOTE.replace(/\n/g, "\r\n");

	test("a CRLF note with no frontmatter stays CRLF", () => {
		const plan = prepareFrontmatterAwareApply("Old body.\r\nSecond line.\r\n", "New body.\nMore.\n", "preserve");
		expect(plan.text).toBe("New body.\r\nMore.\r\n");
	});

	test("preserve keeps the note's CRLF frontmatter and converts the body", () => {
		const plan = prepareFrontmatterAwareApply(crlfNote, "Line one.\nLine two.\n", "preserve");
		expect(plan.text).toBe("---\r\ntitle: Old\r\ntags: [a]\r\n---\r\n\r\nLine one.\r\nLine two.\r\n");
		expect(plan.text).not.toMatch(/(?<!\r)\n/);
	});

	test("replace and confirm return the proposal in the note's line endings", () => {
		const replace = prepareFrontmatterAwareApply(crlfNote, PROPOSED_WITH_FRONTMATTER, "replace");
		expect(replace.text).toBe(PROPOSED_WITH_FRONTMATTER.replace(/\n/g, "\r\n"));
		const confirm = prepareFrontmatterAwareApply(crlfNote, PROPOSED_WITH_FRONTMATTER, "confirm");
		expect(confirm.text).toBe(PROPOSED_WITH_FRONTMATTER.replace(/\n/g, "\r\n"));
		expect(confirm.confirm).toBeDefined();
	});

	test("an LF note stays LF when the proposal arrives with CRLF", () => {
		const plan = prepareFrontmatterAwareApply("Old.\n", "New.\r\nMore.\r\n", "preserve");
		expect(plan.text).toBe("New.\nMore.\n");
	});

	test("frontmatter that differs only in line endings does not trigger the confirm policy", () => {
		const lf = prepareFrontmatterAwareApply(crlfNote, "---\ntitle: Old\ntags: [a]\n---\n\nNew.\n", "confirm");
		expect(lf.confirm).toBeUndefined();
		expect(lf.text).toBe("---\r\ntitle: Old\r\ntags: [a]\r\n---\r\n\r\nNew.\r\n");
	});

	test("malformed frontmatter in a CRLF note returns the proposal in CRLF", () => {
		const plan = prepareFrontmatterAwareApply("---\r\ntitle: Old\r\nBody\r\n", "New.\n", "preserve");
		expect(plan.text).toBe("New.\r\n");
		expect(plan.confirm).toBeDefined();
	});
});
