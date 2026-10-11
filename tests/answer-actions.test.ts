import { describe, expect, test } from "bun:test";
import { describeIncompleteReason, formatInsertNotice, isInsertable, lastAnswerFromMessages, prepareInsertText, SAVED_INCOMPLETE_REASON } from "../src/ui/sidebar/answerActions";

describe("answer actions", () => {
	test("insert text drops surrounding blank lines but keeps inner structure", () => {
		expect(prepareInsertText("\n\n  \n# Title\n\n- a\n  - b\n\n")).toBe("# Title\n\n- a\n  - b");
	});

	test("first-line indentation survives", () => {
		expect(prepareInsertText("    code")).toBe("    code");
	});

	test("empty replies are not insertable", () => {
		expect(isInsertable({ text: " \n ", incompleteReason: null })).toBe(false);
		expect(isInsertable(null)).toBe(false);
		expect(isInsertable({ text: "x", incompleteReason: null })).toBe(true);
	});

	test("incomplete replies add a warning to the notice", () => {
		expect(formatInsertNotice({ text: "x", incompleteReason: null })).toBe("Inserted at cursor.");
		expect(formatInsertNotice({ text: "x", incompleteReason: "max_output_tokens" })).toContain("output token limit");
		expect(describeIncompleteReason("content_filter")).toContain("refused or filtered");
		expect(describeIncompleteReason("odd")).toBe('the provider reported "odd"');
		expect(describeIncompleteReason("stream_interrupted")).toBe("the connection ended before the reply finished");
		expect(describeIncompleteReason(SAVED_INCOMPLETE_REASON)).toBe("it was marked incomplete when it was saved");
	});

	test("a restored conversation's newest text reply becomes the last answer", () => {
		expect(lastAnswerFromMessages([])).toBeNull();
		expect(lastAnswerFromMessages([{ role: "user", text: "Q" }])).toBeNull();
		expect(lastAnswerFromMessages([
			{ role: "user", text: "Q1" },
			{ role: "assistant", text: "First" },
			{ role: "user", text: "Q2" },
			{ role: "assistant", text: "Second", incomplete: true },
			{ role: "system", text: "Switched." }
		])).toEqual({ text: "Second", incompleteReason: SAVED_INCOMPLETE_REASON });
		expect(lastAnswerFromMessages([
			{ role: "assistant", text: "Words" },
			{ role: "assistant", text: "Picture", image: true }
		])).toEqual({ text: "Words", incompleteReason: null });
	});
});
