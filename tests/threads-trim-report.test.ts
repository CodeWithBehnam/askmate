import { describe, expect, test } from "bun:test";
import { describeThreadStoreTrim, measureThreadStoreTrim } from "../src/threads/trimReport";
import { MAX_SAVED_MESSAGE_CHARACTERS, MAX_THREAD_MESSAGES, normalizeThreadStore } from "../src/threads/threadModel";

function storedThread(id: string, day: number, replies: number, replyLength = 100): Record<string, unknown> {
	const stamp = new Date(Date.UTC(2026, 0, day)).toISOString();
	return {
		id,
		title: id,
		autoTitle: true,
		createdAt: stamp,
		updatedAt: stamp,
		messages: Array.from({ length: replies }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", text: `${index} ${"x".repeat(replyLength)}`, createdAt: stamp }))
	};
}

function measure(stored: unknown, maxBytes?: number) {
	return measureThreadStoreTrim(stored, normalizeThreadStore(stored, undefined, maxBytes));
}

describe("measureThreadStoreTrim", () => {
	test("a store that fits loses nothing and gives no notice", () => {
		const trim = measure({ activeId: null, threads: [storedThread("a", 1, 4), storedThread("b", 2, 4)] });
		expect(trim).toEqual({ threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 });
		expect(describeThreadStoreTrim(trim, null)).toBeNull();
	});

	test("the oldest conversations that no longer fit the size budget are counted", () => {
		const stored = { activeId: null, threads: ["old", "mid", "new"].map((id, index) => storedThread(id, 1 + index, 1, 1000)) };
		expect(measure(stored, 3000)).toEqual({ threadsDropped: 1, threadsShortened: 0, messagesShortened: 0 });
	});

	test("a conversation that lost its oldest messages and a reply cut to the cap are counted once each", () => {
		const long = storedThread("long", 3, MAX_THREAD_MESSAGES + 5);
		const cut = storedThread("cut", 4, 2);
		(cut.messages as Array<{ text: string }>)[1]!.text = "y".repeat(MAX_SAVED_MESSAGE_CHARACTERS + 10);
		expect(measure({ activeId: null, threads: [long, cut] })).toEqual({ threadsDropped: 0, threadsShortened: 1, messagesShortened: 1 });
	});

	test("a long reply in a conversation that was dropped is not reported as shortened", () => {
		const doomed = storedThread("doomed", 1, 2);
		(doomed.messages as Array<{ text: string }>)[1]!.text = "y".repeat(MAX_SAVED_MESSAGE_CHARACTERS + 10);
		const stored = { activeId: null, threads: [doomed, storedThread("keep", 2, 1, 2000)] };
		expect(measure(stored, 3000).messagesShortened).toBe(0);
		expect(measure(stored, 3000).threadsDropped).toBe(1);
	});

	test("malformed and repeated entries were never usable, so they do not count as lost", () => {
		const stored = { activeId: null, threads: [storedThread("a", 1, 2), storedThread("a", 1, 2), { id: "broken" }, "text", null] };
		expect(measure(stored)).toEqual({ threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 });
		expect(measure(null)).toEqual({ threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 });
		expect(measure({ threads: "nope" })).toEqual({ threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 });
	});

	test("measuring the store a load already cut finds nothing more to report", () => {
		const stored = { activeId: null, threads: ["old", "mid", "new"].map((id, index) => storedThread(id, 1 + index, 1, 1000)) };
		const once = normalizeThreadStore(stored, undefined, 3000);
		expect(measureThreadStoreTrim(once, normalizeThreadStore(once, undefined, 3000))).toEqual({ threadsDropped: 0, threadsShortened: 0, messagesShortened: 0 });
	});
});

describe("describeThreadStoreTrim", () => {
	test("names what was cut, the limit and the copy", () => {
		const text = describeThreadStoreTrim({ threadsDropped: 18, threadsShortened: 1, messagesShortened: 2 }, "data.json.before-trim-2026-10-12T09-11-05Z");
		expect(text).toContain("within 2 MB");
		expect(text).toContain("18 of the oldest conversations were removed");
		expect(text).toContain("1 conversation lost its oldest messages");
		expect(text).toContain("2 long replies were shortened");
		expect(text).toContain("saved as data.json.before-trim-2026-10-12T09-11-05Z in the plugin folder");
		expect(text).not.toContain("—");
	});

	test("is honest when no copy could be made and uses singular wording", () => {
		const text = describeThreadStoreTrim({ threadsDropped: 1, threadsShortened: 0, messagesShortened: 1 }, null);
		expect(text).toContain("1 of the oldest conversations was removed");
		expect(text).toContain("1 long reply was shortened");
		expect(text).not.toContain("A copy");
	});
});

