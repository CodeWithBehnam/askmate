import { describe, expect, test } from "bun:test";
import {
	appendMarkdownBlockToContent,
	createAbortError,
	isAbortError,
	normalizeApplyScope,
	resolveApplyScope
} from "../src/settings/normalize";

describe("createAbortError / isAbortError", () => {
	test("createAbortError sets name AbortError", () => {
		const error = createAbortError("Request was stopped.");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("Request was stopped.");
		expect(isAbortError(error)).toBe(true);
	});

	test("isAbortError matches plain Error with stop message (compat)", () => {
		const legacy = new Error("Request was stopped.");
		expect(isAbortError(legacy)).toBe(true);
	});

	test("isAbortError rejects ordinary failures", () => {
		expect(isAbortError(new Error("OpenAI request failed."))).toBe(false);
		expect(isAbortError("Request was stopped.")).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});

	test("isAbortError matches DOMException AbortError when available", () => {
		if (typeof DOMException === "undefined") {
			return;
		}
		const error = new DOMException("The operation was aborted.", "AbortError");
		expect(isAbortError(error)).toBe(true);
	});
});

describe("resolveApplyScope", () => {
	test("auto + Selected text → selected-block", () => {
		expect(resolveApplyScope("auto", "Selected text")).toBe("selected-block");
	});

	test("auto + Current note → append (not full-note)", () => {
		expect(resolveApplyScope("auto", "Current note")).toBe("append");
		expect(resolveApplyScope("auto", "Current note")).not.toBe("full-note");
	});

	test("explicit scopes pass through", () => {
		expect(resolveApplyScope("full-note", "Current note")).toBe("full-note");
		expect(resolveApplyScope("selected-block", "Selected text")).toBe("selected-block");
		expect(resolveApplyScope("heading-section", "Current note")).toBe("heading-section");
		expect(resolveApplyScope("append", "Current note")).toBe("append");
	});

	test("unknown scopes normalize to auto then resolve", () => {
		expect(normalizeApplyScope("nope")).toBe("auto");
		expect(resolveApplyScope("nope", "Current note")).toBe("append");
		expect(resolveApplyScope("nope", "Selected text")).toBe("selected-block");
	});
});

describe("appendMarkdownBlockToContent", () => {
	test("empty note becomes block plus newline", () => {
		expect(appendMarkdownBlockToContent("", "Hello")).toBe("Hello\n");
	});

	test("appends with blank line when note has no trailing break", () => {
		expect(appendMarkdownBlockToContent("Note body", "AI")).toBe("Note body\n\nAI\n");
	});

	test("keeps a blank line when note already ends with one newline", () => {
		// One trailing break → insert one more separator so the block is blank-line separated.
		expect(appendMarkdownBlockToContent("Note body\n", "AI")).toBe("Note body\n\nAI\n");
	});

	test("does not add extra separators when note already ends with a blank line", () => {
		expect(appendMarkdownBlockToContent("Note body\n\n", "AI")).toBe("Note body\n\nAI\n");
	});

	test("preserves CRLF style", () => {
		expect(appendMarkdownBlockToContent("Note body\r\n", "AI")).toBe("Note body\r\n\r\nAI\r\n");
	});

	test("recomputing append against concurrent edits preserves both changes", () => {
		const original = "Note body\n";
		const concurrent = "Note body\n\nUser edit\n";
		const block = "AI reply";
		// Preview was based on original; write path recomputes on latest.
		const next = appendMarkdownBlockToContent(concurrent, block);
		expect(next).toContain("User edit");
		expect(next).toContain("AI reply");
		expect(next).not.toBe(appendMarkdownBlockToContent(original, block));
	});
});
