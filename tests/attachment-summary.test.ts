import { describe, expect, test } from "bun:test";
import { formatAttachmentSummary } from "../src/requests/attachmentSummary";
import type { ContextAttachment } from "../src/shared/types";

function attachment(kind: ContextAttachment["kind"], content = "Body"): ContextAttachment {
	return { kind, title: kind, sourcePath: `${kind}.md`, content, originalCharacters: content.length, finalCharacters: content.length, truncated: false };
}

const history = (turns: number): ContextAttachment => attachment(
	"thread_history",
	["Chat history included by AskMate threaded mode.", "", ...Array.from({ length: turns }, (_, index) => `User: Question ${index + 1}\nAskMate: Answer ${index + 1}`)].join("\n")
);

describe("formatAttachmentSummary", () => {
	test("says there are no attachments when there is nothing", () => {
		expect(formatAttachmentSummary([])).toBe("no attachments");
	});

	test("calls the conversation history earlier turns, never an attachment", () => {
		expect(formatAttachmentSummary([history(1)])).toBe("1 earlier turn");
		expect(formatAttachmentSummary([history(3)])).toBe("3 earlier turns");
	});

	test("counts real attachments on their own", () => {
		expect(formatAttachmentSummary([attachment("vault_note")])).toBe("1 attachment");
		expect(formatAttachmentSummary([attachment("vault_note"), attachment("folder_note")])).toBe("2 attachments");
	});

	test("reports both when a follow-up also carries attachments", () => {
		expect(formatAttachmentSummary([attachment("vault_note"), history(2)])).toBe("1 attachment, 2 earlier turns");
	});

	test("reports at least one turn for history that has no user lines", () => {
		expect(formatAttachmentSummary([attachment("thread_history", "AskMate: only an answer")])).toBe("1 earlier turn");
	});
});
