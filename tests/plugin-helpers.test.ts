import { describe, expect, test } from "bun:test";
import { applyTextInsertion, planResultBacklinkInsertion } from "../src/output/resultBacklink";
import { getHeadingSectionCore, isSameNoteText, spliceHeadingSectionBody } from "../src/output/sectionSplice";
import { appendWorkflowUserPreferences } from "../src/output/templates";
import { parseMarkdownHeadingSections } from "../src/output/applyMath";

const BULLET = "- [[AskMate/Result 2026-10-01 1200.md|Result 2026-10-01 1200]] created 2026-10-01";

function insertBacklink(content: string, bullet = BULLET): string {
	const insertion = planResultBacklinkInsertion(content, bullet);
	return insertion ? applyTextInsertion(content, insertion) : content;
}

describe("planResultBacklinkInsertion", () => {
	test("adds the heading and bullet to a note without one, keeping existing text", () => {
		expect(insertBacklink("Body text  ")).toBe(`Body text  \n\n## AskMate results\n\n${BULLET}\n`);
		expect(insertBacklink("Body\n")).toBe(`Body\n\n## AskMate results\n\n${BULLET}\n`);
		expect(insertBacklink("")).toBe(`## AskMate results\n\n${BULLET}\n`);
	});

	test("puts the newest bullet first in an existing list", () => {
		expect(insertBacklink("## AskMate results\n\n- [[old]]\n")).toBe(`## AskMate results\n\n${BULLET}\n- [[old]]\n`);
	});

	test("matches the heading as a whole line outside code fences", () => {
		const note = "### AskMate results\n\n## AskMate results archive\n\n```md\n## AskMate results\n```\n";
		expect(insertBacklink(note)).toBe(`${note}\n## AskMate results\n\n${BULLET}\n`);
	});

	test("inserts $ patterns literally", () => {
		const bullet = "- [[AskMate/Q3 $' plan.md|Q3 $' plan]] created 2026-10-01";
		expect(insertBacklink("## AskMate results\n\nTail", bullet)).toBe(`## AskMate results\n\n${bullet}\n\nTail`);
	});

	test("skips a bullet that is already present as a whole line only", () => {
		expect(planResultBacklinkInsertion(`## AskMate results\n\n${BULLET}\n`, BULLET)).toBeNull();
		expect(planResultBacklinkInsertion(`Quoted: ${BULLET}\n`, BULLET)).not.toBeNull();
	});

	test("keeps CRLF line endings", () => {
		expect(insertBacklink("Body\r\n")).toBe(`Body\r\n\r\n## AskMate results\r\n\r\n${BULLET}\r\n`);
	});
});

describe("spliceHeadingSectionBody", () => {
	const findSection = (content: string, title: string) => {
		const section = parseMarkdownHeadingSections(content).find((item) => item.title === title);
		if (!section) {
			throw new Error(`Missing section ${title}`);
		}
		return section;
	};

	test("keeps the blank line before the next heading and the final newline", () => {
		const note = "# A\n\nold text\n\n# B\n\nlast\n";
		const result = spliceHeadingSectionBody(note, findSection(note, "A"), "new text");
		expect(result.before).toBe("old text");
		expect(result.next).toBe("# A\n\nnew text\n\n# B\n\nlast\n");
		const last = spliceHeadingSectionBody(note, findSection(note, "B"), "new last");
		expect(last.next).toBe("# A\n\nold text\n\n# B\n\nnew last\n");
	});

	test("keeps CRLF line endings", () => {
		const note = "# A\r\n\r\nold\r\n\r\n# B\r\n";
		expect(spliceHeadingSectionBody(note, findSection(note, "A"), "one\ntwo").next).toBe("# A\r\n\r\none\r\ntwo\r\n\r\n# B\r\n");
	});

	test("separates output in an empty section from the headings around it", () => {
		const note = "# A\n# B\n";
		expect(spliceHeadingSectionBody(note, findSection(note, "A"), "filled").next).toBe("# A\n\nfilled\n\n# B\n");
	});

	test("returns the section text without surrounding blank lines", () => {
		const note = "# A\n\none\n\ntwo\n\n# B\n";
		expect(getHeadingSectionCore(note, findSection(note, "A"))).toBe("one\n\ntwo");
	});
});

describe("isSameNoteText", () => {
	test("ignores line-ending style and outer whitespace only", () => {
		expect(isSameNoteText("a\r\nb\r\n", "a\nb")).toBe(true);
		expect(isSameNoteText("a\nb", "a\nc")).toBe(false);
	});
});

describe("appendWorkflowUserPreferences", () => {
	test("appends the global preferences to prompts that do not place them", () => {
		const result = appendWorkflowUserPreferences("Summarise the note.", "Summarise the note.", "Answer in Persian.");
		expect(result).toContain("# User preferences");
		expect(result.endsWith("Answer in Persian.")).toBe(true);
	});

	test("does not duplicate preferences already placed by {{customInstructions}}", () => {
		const rendered = "Do it.\nAnswer in Persian.";
		expect(appendWorkflowUserPreferences(rendered, "Do it.\n{{ customInstructions }}", "Answer in Persian.")).toBe(rendered);
	});

	test("leaves the prompt alone when there are no preferences", () => {
		expect(appendWorkflowUserPreferences("Do it.", "Do it.", "   ")).toBe("Do it.");
	});
});
