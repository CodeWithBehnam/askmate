import { describe, expect, test } from "bun:test";
import { countWords, describeAnnouncement } from "../src/ui/sidebar/announce";

describe("countWords", () => {
	test("counts words in English", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("   ")).toBe(0);
		expect(countWords("one two  three\nfour")).toBe(4);
	});

	test("does not count punctuation or Markdown symbols as words", () => {
		expect(countWords("- one, two!")).toBe(2);
	});

	test("does not collapse unspaced scripts into a single word", () => {
		expect(countWords("今日は天気がいいです")).toBeGreaterThan(1);
	});
});

describe("describeAnnouncement", () => {
	test("announces that work started", () => {
		expect(describeAnnouncement({ kind: "started" })).toBe("AskMate is working.");
	});

	test("a finished reply gives its length, never its content", () => {
		const text = Array.from({ length: 42 }, () => "word").join(" ");
		const announced = describeAnnouncement({ kind: "completed", text });
		expect(announced).toBe("AskMate finished a reply of 42 words.");
		expect(announced).not.toContain("word word");
	});

	test("long replies are rounded", () => {
		const text = Array.from({ length: 243 }, () => "w").join(" ");
		expect(describeAnnouncement({ kind: "completed", text })).toBe("AskMate finished a reply of about 240 words.");
	});

	test("singular and empty replies", () => {
		expect(describeAnnouncement({ kind: "completed", text: "Yes" })).toBe("AskMate finished a reply of 1 word.");
		expect(describeAnnouncement({ kind: "completed", text: "" })).toBe("AskMate finished.");
	});

	test("images and diagrams have their own wording", () => {
		expect(describeAnnouncement({ kind: "completed", image: true })).toBe("AskMate finished generating the image.");
		expect(describeAnnouncement({ kind: "completed", diagram: true, text: "ignored" })).toBe("AskMate finished a reply with a diagram.");
	});

	test("adds tool use, where the reply was saved, and an incomplete warning in that order", () => {
		const announced = describeAnnouncement({
			kind: "completed",
			text: "Two words",
			toolCalls: 2,
			saved: { kind: "note", label: "AskMate/Result.md" },
			incompleteReason: "max_output_tokens"
		});
		expect(announced).toBe(
			"AskMate finished a reply of 2 words. 2 tool calls were used. Saved to AskMate/Result.md. The reply may be incomplete because the provider stopped at its output token limit."
		);
		expect(describeAnnouncement({ kind: "completed", text: "x", toolCalls: 1 })).toContain("1 tool call was used.");
		expect(describeAnnouncement({ kind: "completed", text: "x", saved: { kind: "applied", label: "Applied to Note.md" } })).toContain("Applied to Note.md.");
	});

	test("failures, stops, approvals and notices", () => {
		expect(describeAnnouncement({ kind: "failed", message: "OpenAI rejected the API key." })).toBe("AskMate could not finish: OpenAI rejected the API key.");
		expect(describeAnnouncement({ kind: "stopped", partial: false })).toBe("AskMate stopped.");
		expect(describeAnnouncement({ kind: "stopped", partial: true })).toBe("AskMate stopped. The partial reply was not saved.");
		expect(describeAnnouncement({ kind: "approval", toolName: "search", serverName: "Docs" })).toBe("AskMate needs your approval to run search on Docs.");
		expect(describeAnnouncement({ kind: "approval", toolName: "search" })).toBe("AskMate needs your approval to run search.");
		expect(describeAnnouncement({ kind: "notice", message: "Copied" })).toBe("Copied");
	});

	test("long and multi-line messages are collapsed", () => {
		const announced = describeAnnouncement({ kind: "failed", message: `${"line\n".repeat(100)}` });
		expect(announced).not.toContain("\n");
		expect(announced.length).toBeLessThan(260);
	});
});
