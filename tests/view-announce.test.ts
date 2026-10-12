import { describe, expect, test } from "bun:test";
import { describeAnnouncement } from "../src/ui/sidebar/announce";
import { createAnnouncer } from "../src/ui/sidebar/components/announcer";

describe("the announcer", () => {
	test("writes each message to the one status element", () => {
		const written: string[] = [];
		const announcer = createAnnouncer((text) => written.push(text));
		announcer.announce({ kind: "started" });
		announcer.announce({ kind: "completed", text: "A few words here" });
		expect(written).toEqual(["AskMate is working.", "AskMate finished a reply of 4 words."]);
	});

	test("the same sentence twice in a row still changes the text, so it is spoken again", () => {
		const written: string[] = [];
		const announcer = createAnnouncer((text) => written.push(text));
		announcer.say("AskMate finished.");
		announcer.say("AskMate finished.");
		announcer.say("AskMate finished.");
		expect(new Set(written).size).toBe(2);
		expect(written[0]).not.toBe(written[1]);
		expect(written.map((text) => text.trim())).toEqual(["AskMate finished.", "AskMate finished.", "AskMate finished."]);
		expect(written[2]).toBe(written[0]);
	});

	test("a different sentence after a repeat starts clean", () => {
		const written: string[] = [];
		const announcer = createAnnouncer((text) => written.push(text));
		announcer.say("One.");
		announcer.say("One.");
		announcer.say("Two.");
		expect(written.at(-1)).toBe("Two.");
	});

	test("clearing empties the region and forgets the last sentence", () => {
		const written: string[] = [];
		const announcer = createAnnouncer((text) => written.push(text));
		announcer.say("One.");
		announcer.clear();
		announcer.say("One.");
		expect(written).toEqual(["One.", "", "One."]);
	});
});

describe("what is announced", () => {
	test("a reply is announced by length, never read out", () => {
		expect(describeAnnouncement({ kind: "completed", text: "Short answer." })).toBe("AskMate finished a reply of 2 words.");
	});

	test("a tool that needs approval is named, with its server", () => {
		expect(describeAnnouncement({ kind: "approval", toolName: "search", serverName: "Notes" })).toBe("AskMate needs your approval to run search on Notes.");
	});

	test("a diagram and tool calls are mentioned", () => {
		expect(describeAnnouncement({ kind: "completed", diagram: true, toolCalls: 2 })).toBe("AskMate finished a reply with a diagram. 2 tool calls were used.");
	});

	test("a stop says whether anything was kept", () => {
		expect(describeAnnouncement({ kind: "stopped", partial: true })).toContain("not saved");
		expect(describeAnnouncement({ kind: "stopped", partial: false })).toBe("AskMate stopped.");
	});

	test("a notice is mirrored as one short line", () => {
		const long = `${"word ".repeat(100)}end`;
		expect(describeAnnouncement({ kind: "notice", message: long }).length).toBeLessThanOrEqual(203);
	});
});
