import { describe, expect, test } from "bun:test";
import { ThreadService, THREAD_SAVE_DEBOUNCE_MS, THREAD_SAVE_WARNING_INTERVAL_MS } from "../src/threads/ThreadService";
import {
	DELETED_NOTE_REPLY_PLACEHOLDER,
	MAX_SAVED_MESSAGE_CHARACTERS,
	MAX_SAVED_THREADS,
	MAX_SAVED_TOOL_CALLS,
	MAX_SAVED_TOOL_SUMMARY_CHARACTERS,
	MAX_THREAD_MESSAGES,
	MAX_THREAD_SKILL_IDS,
	MAX_THREAD_STORE_BYTES,
	MAX_THREAD_TITLE_CHARACTERS,
	SAVED_MESSAGE_TRUNCATED_MARKER,
	createEmptyThreadStore,
	applyPathChangeToLiveMessages,
	applyPathChangeToStore,
	applyPathChangeToThread,
	createThread,
	deleteThreadFromStore,
	deriveThreadTitle,
	formatRelativeTime,
	fromSavedMessages,
	listThreadsByRecency,
	normalizeSavedMessage,
	normalizeSavedThread,
	normalizeThreadStore,
	pruneThreads,
	purgeThreadPaths,
	remapThreadPaths,
	renameThreadInStore,
	setActiveThread,
	settleThreadMessages,
	toSavedMessages,
	upsertThread,
	withThreadMessages,
	withThreadSkillIds,
	type ChatMessageLike,
	type SavedMessage,
	type SavedThread,
	type ThreadPathChange
} from "../src/threads/threadModel";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, ChatMessage } from "../src/shared/types";

const T0 = "2026-10-11T10:00:00.000Z";

function message(role: "user" | "assistant", text: string, extra: Partial<SavedMessage> = {}): SavedMessage {
	return { role, text, createdAt: T0, ...extra };
}

function thread(id: string, updatedAt: string, texts: string[] = ["Hello"]): SavedThread {
	return {
		id,
		title: deriveThreadTitle(texts[0] ?? ""),
		autoTitle: true,
		createdAt: T0,
		updatedAt,
		messages: texts.map((text, index) => message(index % 2 === 0 ? "user" : "assistant", text))
	};
}

describe("deriveThreadTitle", () => {
	test("uses the first non-empty line and strips Markdown noise", () => {
		expect(deriveThreadTitle("\n\n## What is [[Roadmap|the plan]]?\nmore")).toBe("What is the plan?");
	});

	test("caps long titles at 60 characters with an ellipsis", () => {
		const title = deriveThreadTitle("x".repeat(200));
		expect(Array.from(title).length).toBe(MAX_THREAD_TITLE_CHARACTERS);
		expect(title.endsWith("…")).toBe(true);
	});

	test("falls back for empty text and never splits an emoji", () => {
		expect(deriveThreadTitle("   ")).toBe("New conversation");
		expect(Array.from(deriveThreadTitle("😀".repeat(100))).length).toBe(MAX_THREAD_TITLE_CHARACTERS);
	});
});

describe("normalizeThreadStore", () => {
	test("returns an empty store for garbage", () => {
		expect(normalizeThreadStore(null)).toEqual(createEmptyThreadStore());
		expect(normalizeThreadStore({ threads: "x" })).toEqual(createEmptyThreadStore());
	});

	test("drops malformed threads, messages and duplicate ids", () => {
		const store = normalizeThreadStore({
			activeId: "a",
			threads: [
				{ id: "a", createdAt: T0, updatedAt: T0, title: "ignored", messages: [message("user", "Hi"), { role: "system", text: "no" }, { role: "user", text: "  " }, 7] },
				{ id: "a", createdAt: T0, messages: [message("user", "dupe")] },
				{ id: "", createdAt: T0, messages: [message("user", "no id")] },
				{ id: "b", createdAt: "not a date", messages: [message("user", "bad date")] },
				{ id: "c", createdAt: T0, messages: [] },
				"nope"
			]
		});
		expect(store.threads.map((item) => item.id)).toEqual(["a"]);
		expect(store.threads[0].messages).toHaveLength(1);
		expect(store.threads[0].title).toBe("Hi");
		expect(store.activeId).toBe("a");
	});

	test("clears an active id that no longer exists", () => {
		expect(normalizeThreadStore({ activeId: "gone", threads: [thread("a", T0)] }).activeId).toBeNull();
	});

	test("keeps only plain message fields", () => {
		const store = normalizeThreadStore({
			threads: [{ id: "a", createdAt: T0, messages: [{ ...message("assistant", "Pic", { image: true, imagePath: "AskMate/p.png", model: "m", sourcePath: "N.md", incomplete: true }), base64: "AAAA", dom: {} }] }]
		});
		expect(store.threads[0].messages[0]).toEqual(message("assistant", "Pic", { image: true, imagePath: "AskMate/p.png", model: "m", sourcePath: "N.md", incomplete: true }));
	});

	test("caps messages per thread to the newest", () => {
		const texts = Array.from({ length: MAX_THREAD_MESSAGES + 25 }, (_, index) => `m${index}`);
		const store = normalizeThreadStore({ threads: [{ id: "a", createdAt: T0, messages: texts.map((text) => message("user", text)) }] });
		expect(store.threads[0].messages).toHaveLength(MAX_THREAD_MESSAGES);
		expect(store.threads[0].messages.at(-1)?.text).toBe(`m${MAX_THREAD_MESSAGES + 24}`);
	});

	test("caps threads, dropping the least recently updated", () => {
		const threads = Array.from({ length: MAX_SAVED_THREADS + 5 }, (_, index) =>
			thread(`t${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString())
		);
		const store = normalizeThreadStore({ threads });
		expect(store.threads).toHaveLength(MAX_SAVED_THREADS);
		expect(store.threads.some((item) => item.id === "t0")).toBe(false);
		expect(store.threads.some((item) => item.id === `t${MAX_SAVED_THREADS + 4}`)).toBe(true);
	});

	test("settings normalisation includes the store and defaults saving on", () => {
		const settings = normalizeAskMateSettings({ threadStore: { threads: [thread("a", T0)] }, saveConversations: "yes" } as unknown as Partial<AskMateSettings>, "load");
		expect(settings.saveConversations).toBe(true);
		expect(settings.threadStore.threads).toHaveLength(1);
		expect(normalizeAskMateSettings({}, "load").threadStore).toEqual(createEmptyThreadStore());
	});
});

describe("thread list operations", () => {
	test("upsert adds, replaces and marks active", () => {
		let store = upsertThread(createEmptyThreadStore(), thread("a", T0));
		store = upsertThread(store, thread("b", "2026-10-11T11:00:00.000Z"));
		store = upsertThread(store, { ...thread("a", "2026-10-11T12:00:00.000Z"), messages: [message("user", "Updated")] });
		expect(store.threads.map((item) => item.id).sort()).toEqual(["a", "b"]);
		expect(store.activeId).toBe("a");
		expect(store.threads.find((item) => item.id === "a")?.messages[0].text).toBe("Updated");
	});

	test("upserting an empty thread removes it instead of saving it", () => {
		let store = upsertThread(createEmptyThreadStore(), thread("a", T0));
		store = upsertThread(store, { ...thread("a", T0), messages: [] });
		expect(store.threads).toHaveLength(0);
		expect(store.activeId).toBeNull();
	});

	test("switch only accepts known ids", () => {
		const store = upsertThread(createEmptyThreadStore(), thread("a", T0));
		expect(setActiveThread(store, "a").activeId).toBe("a");
		expect(setActiveThread(store, "zzz").activeId).toBeNull();
		expect(setActiveThread(store, null).activeId).toBeNull();
	});

	test("rename sets a custom title that survives new messages", () => {
		const store = renameThreadInStore(upsertThread(createEmptyThreadStore(), thread("a", T0)), "a", "  Board\nprep ");
		const renamed = store.threads[0];
		expect(renamed.title).toBe("Board prep");
		expect(renamed.autoTitle).toBe(false);
		expect(withThreadMessages(renamed, [message("user", "Something else")], new Date(T0)).title).toBe("Board prep");
		expect(renameThreadInStore(store, "a", "   ").threads[0].title).toBe("Board prep");
	});

	test("auto titles follow the first question", () => {
		const updated = withThreadMessages(createThread("a", new Date(T0)), [message("user", "Plan the launch"), message("assistant", "Sure")], new Date("2026-10-11T10:05:00.000Z"));
		expect(updated.title).toBe("Plan the launch");
		expect(updated.updatedAt).toBe("2026-10-11T10:05:00.000Z");
	});

	test("delete clears the active id when it removes the active thread", () => {
		let store = upsertThread(createEmptyThreadStore(), thread("a", T0));
		store = upsertThread(store, thread("b", T0));
		expect(deleteThreadFromStore(store, "b")).toEqual({ activeId: null, threads: [thread("a", T0)] });
		expect(deleteThreadFromStore(store, "a").activeId).toBe("b");
	});

	test("prune keeps the newest and the original order", () => {
		const threads = [thread("old", "2026-01-01T00:00:00.000Z"), thread("new", "2026-03-01T00:00:00.000Z"), thread("mid", "2026-02-01T00:00:00.000Z")];
		expect(pruneThreads(threads, 2).map((item) => item.id)).toEqual(["new", "mid"]);
	});

	test("list is most recent first", () => {
		const store = { activeId: null, threads: [thread("a", "2026-01-01T00:00:00.000Z"), thread("b", "2026-02-01T00:00:00.000Z")] };
		expect(listThreadsByRecency(store).map((item) => item.id)).toEqual(["b", "a"]);
	});
});

describe("toSavedMessages", () => {
	test("keeps user and assistant turns with text and drops everything else", () => {
		const saved = toSavedMessages(
			[
				{ role: "system", text: "Chat cleared." },
				{ role: "user", text: "Q", sourcePath: "N.md" },
				{ role: "assistant", text: "   " },
				{ role: "assistant", text: "A", model: "m" }
			],
			T0
		);
		expect(saved).toEqual([message("user", "Q", { sourcePath: "N.md" }), message("assistant", "A", { model: "m" })]);
	});
});

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-10-11T12:00:00.000Z");
	test("formats buckets", () => {
		expect(formatRelativeTime("2026-10-11T11:59:40.000Z", now)).toBe("just now");
		expect(formatRelativeTime("2026-10-11T11:30:00.000Z", now)).toBe("30 min ago");
		expect(formatRelativeTime("2026-10-11T09:00:00.000Z", now)).toBe("3 h ago");
		expect(formatRelativeTime("2026-10-10T11:00:00.000Z", now)).toBe("yesterday");
		expect(formatRelativeTime("2026-10-08T12:00:00.000Z", now)).toBe("3 days ago");
		expect(formatRelativeTime("2026-09-01T12:00:00.000Z", now)).toBe("2026-09-01");
		expect(formatRelativeTime("garbage", now)).toBe("");
	});
});

describe("ThreadService", () => {
	function setup(overrides: Partial<AskMateSettings> = {}) {
		const settings = { ...structuredClone(normalizeAskMateSettings({}, "load")), ...overrides };
		const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
		let saves = 0;
		let failSave = false;
		const service = new ThreadService({
			getSettings: () => settings,
			saveSettings: async () => {
				if (failSave) {
					throw new Error("disk full");
				}
				saves += 1;
			},
			setTimer: (callback, delay) => {
				const entry = { callback, delay, cleared: false };
				timers.push(entry);
				return entry;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
			warn: () => undefined
		});
		return { settings, service, timers, saves: () => saves, failNextSaves: () => { failSave = true; } };
	}

	test("debounces rapid saves into one write", async () => {
		const { service, timers, saves, settings } = setup();
		service.scheduleSave(thread("a", T0));
		service.scheduleSave(thread("a", T0, ["Hello", "Hi there"]));
		expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1);
		expect(timers[0].delay).toBe(THREAD_SAVE_DEBOUNCE_MS);
		expect(saves()).toBe(0);
		timers.filter((timer) => !timer.cleared)[0].callback();
		await service.flush();
		expect(saves()).toBe(1);
		expect(settings.threadStore.threads[0].messages).toHaveLength(2);
		expect(service.getActiveThread()?.id).toBe("a");
	});

	test("does nothing while saving conversations is off", async () => {
		const { service, timers, saves, settings } = setup({ saveConversations: false });
		service.scheduleSave(thread("a", T0));
		await service.flush();
		expect(timers).toHaveLength(0);
		expect(saves()).toBe(0);
		expect(settings.threadStore.threads).toHaveLength(0);
		expect(service.getActiveThread()).toBeNull();
	});

	test("restores the last active thread, and rename, remove and clearAll work", async () => {
		const { service } = setup();
		service.scheduleSave(thread("a", T0));
		await service.flush();
		service.scheduleSave(thread("b", "2026-10-11T11:00:00.000Z", ["Second"]));
		await service.flush();
		expect(service.getActiveThread()?.id).toBe("b");
		await service.markActive(null);
		expect(service.getActiveThread()).toBeNull();
		await service.rename("a", "Renamed");
		expect(service.getThread("a")?.title).toBe("Renamed");
		await service.remove("a");
		expect(service.listThreads().map((item) => item.id)).toEqual(["b"]);
		await service.clearAll();
		expect(service.listThreads()).toEqual([]);
	});

	test("clearAll still works after saving was turned off", async () => {
		const { service, settings } = setup();
		service.scheduleSave(thread("a", T0));
		await service.flush();
		settings.saveConversations = false;
		await service.clearAll();
		expect(settings.threadStore.threads).toHaveLength(0);
	});

	test("rolls back the in-memory store when the write fails", async () => {
		const { service, settings, failNextSaves } = setup();
		service.scheduleSave(thread("a", T0));
		await service.flush();
		failNextSaves();
		service.scheduleSave(thread("b", T0, ["Other"]));
		await service.flush();
		expect(settings.threadStore.threads.map((item) => item.id)).toEqual(["a"]);
	});
});

const T1 = "2026-10-11T11:00:00.000Z";

function ids(store: { threads: readonly SavedThread[] }): string[] {
	return store.threads.map((item) => item.id);
}

function serialisedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("unchanged threads are not activity (STO-02)", () => {
	test("withThreadMessages returns the same thread when messages and title are unchanged", () => {
		const base = thread("a", T0, ["Hello", "Hi there"]);
		const again = withThreadMessages(base, base.messages.map((item) => ({ ...item })), new Date("2026-10-12T09:00:00.000Z"));
		expect(again).toBe(base);
		expect(again.updatedAt).toBe(T0);
	});

	test("withThreadMessages still refreshes updatedAt when a message is added", () => {
		const base = thread("a", T0, ["Hello"]);
		const next = withThreadMessages(base, [...base.messages, message("assistant", "Hi")], new Date("2026-10-12T09:00:00.000Z"));
		expect(next.updatedAt).toBe("2026-10-12T09:00:00.000Z");
		expect(next.messages).toHaveLength(2);
	});

	test("upserting identical content keeps the stored copy, its updatedAt and its place", () => {
		const store = { activeId: null, threads: [thread("a", T0), thread("b", T1)] };
		const next = upsertThread(store, { ...thread("a", "2026-10-12T09:00:00.000Z") });
		expect(next.threads).toBe(store.threads);
		expect(next.activeId).toBe("a");
		expect(ids(next)).toEqual(["a", "b"]);
		expect(next.threads[0].updatedAt).toBe(T0);
	});

	test("upserting changed content replaces the thread and takes the new updatedAt", () => {
		const store = { activeId: null, threads: [thread("a", T0)] };
		const next = upsertThread(store, { ...thread("a", "2026-10-12T09:00:00.000Z", ["Hello", "More"]) });
		expect(next.threads[0].messages).toHaveLength(2);
		expect(next.threads[0].updatedAt).toBe("2026-10-12T09:00:00.000Z");
	});
});

describe("size budget (STO-04)", () => {
	test("a long message is cut to the cap and ends with a visible marker", () => {
		const saved = normalizeSavedMessage(message("assistant", "x".repeat(MAX_SAVED_MESSAGE_CHARACTERS + 500)), T0);
		expect(saved?.text.length).toBe(MAX_SAVED_MESSAGE_CHARACTERS);
		expect(saved?.text.endsWith(SAVED_MESSAGE_TRUNCATED_MARKER)).toBe(true);
	});

	test("cutting twice changes nothing and a message at the cap is left alone", () => {
		const once = normalizeSavedMessage(message("assistant", "y".repeat(MAX_SAVED_MESSAGE_CHARACTERS * 2)), T0);
		expect(normalizeSavedMessage(once, T0)?.text).toBe(once?.text);
		const exact = "z".repeat(MAX_SAVED_MESSAGE_CHARACTERS);
		expect(normalizeSavedMessage(message("user", exact), T0)?.text).toBe(exact);
	});

	test("the cut never leaves half of an emoji", () => {
		const saved = normalizeSavedMessage(message("assistant", "😀".repeat(MAX_SAVED_MESSAGE_CHARACTERS)), T0);
		const head = saved?.text.slice(0, saved.text.length - SAVED_MESSAGE_TRUNCATED_MARKER.length) ?? "";
		expect(head.length % 2).toBe(0);
		expect(JSON.parse(JSON.stringify(head))).toBe(head);
	});

	test("drops the oldest threads first when the store is over budget", () => {
		const threads = ["old", "mid", "new"].map((id, index) => thread(id, new Date(Date.UTC(2026, 0, 1 + index)).toISOString(), ["x".repeat(1000)]));
		const store = normalizeThreadStore({ activeId: null, threads }, MAX_SAVED_THREADS, 3000);
		expect(ids(store)).toEqual(["mid", "new"]);
		expect(serialisedBytes(store)).toBeLessThanOrEqual(3000);
	});

	test("keeps the active thread even when it is the oldest", () => {
		const threads = ["old", "mid", "new"].map((id, index) => thread(id, new Date(Date.UTC(2026, 0, 1 + index)).toISOString(), ["x".repeat(1000)]));
		const store = normalizeThreadStore({ activeId: "old", threads }, MAX_SAVED_THREADS, 1500);
		expect(ids(store)).toEqual(["old"]);
		expect(store.activeId).toBe("old");
	});

	test("a single oversized thread loses its oldest messages, keeps its title and is marked truncated", () => {
		const texts = Array.from({ length: 10 }, (_, index) => `Question ${index} ${"q".repeat(1000)}`);
		const store = normalizeThreadStore({ activeId: "a", threads: [thread("a", T0, texts)] }, MAX_SAVED_THREADS, 4000);
		const [kept] = store.threads;
		expect(kept.messages.length).toBeGreaterThan(0);
		expect(kept.messages.length).toBeLessThan(10);
		expect(kept.messages.at(-1)?.text).toBe(texts[9]);
		expect(kept.truncated).toBe(true);
		expect(kept.autoTitle).toBe(false);
		expect(kept.title.startsWith("Question 0 qqqq")).toBe(true);
		expect(serialisedBytes(store)).toBeLessThanOrEqual(4000);
		// A second pass is a no-op, so the stored form is stable.
		expect(normalizeThreadStore(store, MAX_SAVED_THREADS, 4000)).toEqual(store);
	});

	test("the real budget bounds a store of large threads and keeps the newest", () => {
		const bigThreads = Array.from({ length: 30 }, (_, index) =>
			thread(`t${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), Array.from({ length: 8 }, () => "y".repeat(30_000)))
		);
		const store = normalizeThreadStore({ activeId: "t29", threads: bigThreads });
		expect(serialisedBytes(store)).toBeLessThanOrEqual(MAX_THREAD_STORE_BYTES);
		expect(store.threads.some((item) => item.id === "t29")).toBe(true);
		expect(store.threads.some((item) => item.id === "t0")).toBe(false);
		expect(store.threads.length).toBeGreaterThan(3);
	});

	test("a store under the budget is returned whole", () => {
		const raw = { activeId: "b", threads: [thread("a", T0), thread("b", T1)] };
		expect(normalizeThreadStore(raw)).toEqual(raw);
	});

	test("the title stays when the message cap drops the first question", () => {
		const texts = Array.from({ length: MAX_THREAD_MESSAGES + 25 }, (_, index) => (index === 0 ? "Plan the launch" : `m${index}`));
		const saved = normalizeSavedThread({ id: "a", createdAt: T0, messages: texts.map((text) => message("user", text)) });
		expect(saved?.title).toBe("Plan the launch");
		expect(saved?.autoTitle).toBe(false);
		expect(saved?.truncated).toBe(true);
		const next = withThreadMessages(thread("a", T0), texts.map((text) => message("user", text)), new Date(T1));
		expect(next.title).toBe("Plan the launch");
		expect(next.autoTitle).toBe(false);
		expect(next.messages).toHaveLength(MAX_THREAD_MESSAGES);
	});

	test("the same holds for a transcript that comes straight from the sidebar", () => {
		const transcript: ChatMessage[] = Array.from({ length: MAX_THREAD_MESSAGES + 10 }, (_, index) => ({ role: "user", text: index === 0 ? "Plan the launch" : `m${index}` }));
		const next = withThreadMessages({ ...createThread("a", new Date(T0)), messages: [] }, settleThreadMessages(transcript, null, T0), new Date(T1));
		expect(next.title).toBe("Plan the launch");
		expect(next.messages).toHaveLength(MAX_THREAD_MESSAGES);
		expect(next.messages.at(-1)?.text).toBe(`m${MAX_THREAD_MESSAGES + 9}`);
		expect(next.truncated).toBe(true);
	});
});

describe("tool, diagram and skill summaries", () => {
	test("an assistant message keeps bounded, normalised tool and diagram summaries", () => {
		const saved = normalizeSavedMessage(
			{
				role: "assistant",
				text: "Done",
				createdAt: T0,
				tools: [
					{ server: " files ", tool: "read\nfile", status: "completed", summary: "s".repeat(MAX_SAVED_TOOL_SUMMARY_CHARACTERS + 200), arguments: { secret: "x" } },
					{ server: "", tool: "no server", status: "completed" },
					{ server: "web", tool: "fetch", status: "unknown" },
					"junk"
				],
				diagram: { type: "flowchart", status: "rendered", recipe: "Blueprint", repaired: true, source: "graph TD", extra: 1 }
			},
			T0
		);
		expect(saved?.tools).toEqual([{ server: "files", tool: "read file", status: "completed", summary: "s".repeat(MAX_SAVED_TOOL_SUMMARY_CHARACTERS) }]);
		expect(saved?.diagram).toEqual({ type: "flowchart", status: "rendered", recipe: "Blueprint", repaired: true });
	});

	test("rejects a diagram summary without a type or with an unknown status", () => {
		expect(normalizeSavedMessage({ role: "assistant", text: "x", diagram: { type: "", status: "rendered" } }, T0)?.diagram).toBeUndefined();
		expect(normalizeSavedMessage({ role: "assistant", text: "x", diagram: { type: "flowchart", status: "broken" } }, T0)?.diagram).toBeUndefined();
	});

	test("caps the number of tool calls and their total size", () => {
		const many = Array.from({ length: MAX_SAVED_TOOL_CALLS + 10 }, (_, index) => ({ server: "s", tool: `t${index}`, status: "completed" }));
		expect(normalizeSavedMessage({ role: "assistant", text: "x", tools: many }, T0)?.tools).toHaveLength(MAX_SAVED_TOOL_CALLS);
		const heavy = Array.from({ length: MAX_SAVED_TOOL_CALLS }, (_, index) => ({ server: "s".repeat(100), tool: `t${index}`.padEnd(100, "x"), status: "failed", summary: "m".repeat(MAX_SAVED_TOOL_SUMMARY_CHARACTERS) }));
		const kept = normalizeSavedMessage({ role: "assistant", text: "x", tools: heavy }, T0)?.tools ?? [];
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(heavy.length);
		expect(serialisedBytes(kept)).toBeLessThanOrEqual(4000);
	});

	test("user messages carry no tool or diagram summary", () => {
		const saved = normalizeSavedMessage({ role: "user", text: "q", tools: [{ server: "s", tool: "t", status: "completed" }], diagram: { type: "flowchart", status: "rendered" } }, T0);
		expect(saved?.tools).toBeUndefined();
		expect(saved?.diagram).toBeUndefined();
	});

	test("summaries survive the trip from a transcript to a saved thread and back", () => {
		const transcript = [
			{ role: "user", text: "Draw it" },
			{ role: "assistant", text: "```mermaid\ngraph TD\n```", diagram: { type: "flowchart", status: "fallback" }, tools: [{ server: "s", tool: "t", status: "denied" }] }
		] satisfies ChatMessageLike[];
		const saved = toSavedMessages(transcript, T0);
		expect(saved[1].diagram).toEqual({ type: "flowchart", status: "fallback" });
		const restored = fromSavedMessages(saved);
		expect(restored[1].diagram).toEqual({ type: "flowchart", status: "fallback" });
		expect(restored[1].tools).toEqual([{ server: "s", tool: "t", status: "denied" }]);
		expect(restored[1].tools).not.toBe(saved[1].tools);
	});

	test("a thread keeps its sticky skill ids, trimmed, unique and bounded", () => {
		const skillIds = [" mermaid-diagrams ", "mermaid-diagrams", "", "bad\u0000id", "x".repeat(65), ...Array.from({ length: 12 }, (_, index) => `skill-${index}`), 7];
		const saved = normalizeSavedThread({ id: "a", createdAt: T0, messages: [message("user", "Hi")], skillIds });
		expect(saved?.skillIds?.[0]).toBe("mermaid-diagrams");
		expect(saved?.skillIds).toHaveLength(MAX_THREAD_SKILL_IDS);
		expect(new Set(saved?.skillIds).size).toBe(MAX_THREAD_SKILL_IDS);
		expect(normalizeSavedThread({ id: "a", createdAt: T0, messages: [message("user", "Hi")], skillIds: [] })).not.toHaveProperty("skillIds");
	});

	test("withThreadSkillIds returns the same thread when nothing changes and clears the field when emptied", () => {
		const base = { ...thread("a", T0), skillIds: ["one"] };
		expect(withThreadSkillIds(base, ["one"])).toBe(base);
		expect(withThreadSkillIds(base, ["one", "two"]).skillIds).toEqual(["one", "two"]);
		expect(withThreadSkillIds(base, [])).not.toHaveProperty("skillIds");
	});

	test("skill ids make a thread differ, so a change to them is saved", () => {
		const store = { activeId: null, threads: [thread("a", T0)] };
		const next = upsertThread(store, { ...thread("a", T0), skillIds: ["one"] });
		expect(next.threads[0].skillIds).toEqual(["one"]);
	});
});

describe("note renames and deletes (STO-03)", () => {
	function noteThread(): SavedThread {
		return {
			...thread("a", T0, ["Q", "A"]),
			messages: [
				message("user", "Summarise this", { sourcePath: "Notes/Plan.md" }),
				message("assistant", "The plan says: ship in May.", { sourcePath: "Notes/Plan.md", model: "m" }),
				message("assistant", "Generated image with m.", { sourcePath: "Notes/Plan.md", image: true, imagePath: "Notes/Images/p.png" }),
				message("user", "Unrelated", { sourcePath: "Other/Plan.md" }),
				message("assistant", "Plain reply")
			]
		};
	}

	test("remap follows a renamed note, and a renamed folder with everything inside it", () => {
		const store = { activeId: "a", threads: [noteThread()] };
		const renamed = remapThreadPaths(store, "Notes/Plan.md", "Notes/Roadmap.md");
		expect(renamed.threads[0].messages.map((item) => item.sourcePath)).toEqual(["Notes/Roadmap.md", "Notes/Roadmap.md", "Notes/Roadmap.md", "Other/Plan.md", undefined]);
		const moved = remapThreadPaths(store, "Notes", "Archive");
		expect(moved.threads[0].messages[0].sourcePath).toBe("Archive/Plan.md");
		expect(moved.threads[0].messages[2].imagePath).toBe("Archive/Images/p.png");
		expect(moved.threads[0].messages[3].sourcePath).toBe("Other/Plan.md");
	});

	test("remap leaves updatedAt alone and does not touch a sibling that only shares a prefix", () => {
		const store = { activeId: "a", threads: [{ ...noteThread(), messages: [message("user", "Q", { sourcePath: "Notes 2/Plan.md" })] }] };
		expect(remapThreadPaths(store, "Notes", "Archive")).toBe(store);
		const renamed = remapThreadPaths({ activeId: "a", threads: [noteThread()] }, "Notes", "Archive");
		expect(renamed.threads[0].updatedAt).toBe(T0);
	});

	test("remap returns the same store when nothing refers to the old path", () => {
		const store = { activeId: "a", threads: [noteThread()] };
		expect(remapThreadPaths(store, "Missing.md", "Else.md")).toBe(store);
		expect(remapThreadPaths(store, "Notes", "Notes")).toBe(store);
	});

	test("purge clears the links and the quoting replies of a deleted note and keeps the conversation", () => {
		const store = { activeId: "a", threads: [noteThread()] };
		const purged = purgeThreadPaths(store, "Notes/Plan.md");
		const [first, second, third, fourth, fifth] = purged.threads[0].messages;
		expect(first).toEqual(message("user", "Summarise this"));
		expect(second.text).toBe(DELETED_NOTE_REPLY_PLACEHOLDER);
		expect(second.sourcePath).toBeUndefined();
		expect(second.model).toBe("m");
		expect(third.sourcePath).toBeUndefined();
		expect(third.text).toBe("Generated image with m.");
		expect(third.imagePath).toBe("Notes/Images/p.png");
		expect(fourth.sourcePath).toBe("Other/Plan.md");
		expect(fifth.text).toBe("Plain reply");
		expect(purged.threads[0].messages).toHaveLength(5);
		expect(purged.threads[0].updatedAt).toBe(T0);
		expect(purged.activeId).toBe("a");
	});

	test("purge clears the image link when the image is deleted and can keep reply text on request", () => {
		const store = { activeId: "a", threads: [noteThread()] };
		const imageGone = purgeThreadPaths(store, "Notes/Images");
		expect(imageGone.threads[0].messages[2].imagePath).toBeUndefined();
		expect(imageGone.threads[0].messages[2].sourcePath).toBe("Notes/Plan.md");
		expect(imageGone.threads[0].messages[1].text).toBe("The plan says: ship in May.");
		const kept = purgeThreadPaths(store, "Notes/Plan.md", { clearQuotedReplies: false });
		expect(kept.threads[0].messages[1].text).toBe("The plan says: ship in May.");
		expect(kept.threads[0].messages[1].sourcePath).toBeUndefined();
	});

	test("purge returns the same store when nothing refers to the path", () => {
		const store = { activeId: "a", threads: [noteThread()] };
		expect(purgeThreadPaths(store, "Missing.md")).toBe(store);
	});
});

describe("the sidebar transcript follows note renames and deletes (STO-03)", () => {
	function liveTranscript(): ChatMessageLike[] {
		return [
			{ role: "user", text: "Summarise this", createdAt: T0, sourcePath: "Notes/x.md" },
			{
				role: "assistant",
				text: "The note says: ship in May.",
				createdAt: T0,
				sourcePath: "Notes/x.md",
				model: "m",
				tools: [{ server: "files", tool: "read", status: "completed" }],
				diagram: { type: "flowchart", status: "rendered" }
			},
			{ role: "assistant", text: "Generated image with m.", createdAt: T0, sourcePath: "Notes/x.md", image: true, imagePath: "Notes/x.png" },
			{ role: "system", text: "Context images displayed." },
			{ role: "user", text: "Unrelated", createdAt: T0, sourcePath: "Other/x.md" }
		];
	}

	test("a rename is applied in place, keeps every object and returns only the lines it changed", () => {
		const live = liveTranscript();
		const before = [...live];
		const changed = applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "Notes/x.md", newPath: "Notes/y.md" });
		expect(live.every((item, index) => item === before[index])).toBe(true);
		expect(changed).toEqual([live[0], live[1], live[2]]);
		expect(changed.every((item, index) => item === [live[0], live[1], live[2]][index])).toBe(true);
		expect(live.map((item) => item.sourcePath)).toEqual(["Notes/y.md", "Notes/y.md", "Notes/y.md", undefined, "Other/x.md"]);
		expect(live[2].imagePath).toBe("Notes/x.png");
		expect(live[1].text).toBe("The note says: ship in May.");
	});

	test("a renamed folder moves the note links and the image links inside it", () => {
		const live = liveTranscript();
		applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "Notes", newPath: "Archive" });
		expect(live[0].sourcePath).toBe("Archive/x.md");
		expect(live[2].imagePath).toBe("Archive/x.png");
		expect(live[4].sourcePath).toBe("Other/x.md");
	});

	test("a delete clears the links and the quoting replies in place and removes the keys it cleared", () => {
		const live = liveTranscript();
		const answer = live[1];
		const changed = applyPathChangeToLiveMessages(live, { kind: "deleted", path: "Notes/x.md" });
		expect(changed).toHaveLength(3);
		expect(live[1]).toBe(answer);
		expect(answer.text).toBe(DELETED_NOTE_REPLY_PLACEHOLDER);
		expect("sourcePath" in answer).toBe(false);
		expect("tools" in answer).toBe(false);
		expect("diagram" in answer).toBe(false);
		expect(answer.model).toBe("m");
		expect(live[0].text).toBe("Summarise this");
		expect("sourcePath" in live[0]).toBe(false);
		expect(live[2].text).toBe("Generated image with m.");
		expect(live[2].imagePath).toBe("Notes/x.png");
		expect(live[4].sourcePath).toBe("Other/x.md");
	});

	test("a deleted image clears only the image link", () => {
		const live = liveTranscript();
		const changed = applyPathChangeToLiveMessages(live, { kind: "deleted", path: "Notes/x.png" });
		expect(changed).toEqual([live[2]]);
		expect("imagePath" in live[2]).toBe(false);
		expect(live[2].sourcePath).toBe("Notes/x.md");
		expect(live[1].text).toBe("The note says: ship in May.");
	});

	test("a change nobody refers to touches nothing and an empty path is ignored", () => {
		const live = liveTranscript();
		const snapshot = structuredClone(live);
		expect(applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "Missing.md", newPath: "Else.md" })).toEqual([]);
		expect(applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "Notes", newPath: "Notes" })).toEqual([]);
		expect(applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "", newPath: "Else.md" })).toEqual([]);
		expect(applyPathChangeToLiveMessages(live, { kind: "deleted", path: "Missing.md" })).toEqual([]);
		expect(applyPathChangeToLiveMessages(live, { kind: "deleted", path: "" })).toEqual([]);
		expect(live).toEqual(snapshot);
	});

	test("the in-flight turn is still found by identity after the rename", () => {
		const live = liveTranscript();
		const inFlight = live[4];
		applyPathChangeToLiveMessages(live, { kind: "renamed", oldPath: "Other/x.md", newPath: "Other/z.md" });
		expect(inFlight.sourcePath).toBe("Other/z.md");
		const saved = settleThreadMessages(live, inFlight, T0);
		expect(saved.map((item) => item.text)).toEqual(["Summarise this", "The note says: ship in May.", "Generated image with m."]);
	});

	test("the stored and the live copy end up identical, whichever helper rewrote them", () => {
		const live = liveTranscript();
		const stored: SavedThread = { ...thread("a", T0), messages: toSavedMessages(live, T0) };
		for (const change of [
			{ kind: "renamed", oldPath: "Notes", newPath: "Archive" },
			{ kind: "deleted", path: "Archive/x.md" }
		] satisfies ThreadPathChange[]) {
			const rewritten = applyPathChangeToThread(stored, change);
			applyPathChangeToLiveMessages(live, change);
			expect(applyPathChangeToStore({ activeId: "a", threads: [stored] }, change).threads[0]).toEqual(rewritten);
			expect(toSavedMessages(live, T0)).toEqual(rewritten.messages);
			expect(rewritten.updatedAt).toBe(T0);
			Object.assign(stored, rewritten);
		}
	});
});

describe("settleThreadMessages", () => {
	const question: ChatMessage = { role: "user", text: "Same question" };
	const answer: ChatMessage = { role: "assistant", text: "An answer" };
	const repeated: ChatMessage = { role: "user", text: "Same question" };

	test("removes the in-flight turn by identity, whatever its position", () => {
		const status: ChatMessage = { role: "system", text: "Context images displayed." };
		const saved = settleThreadMessages([question, answer, repeated, status], repeated, T0);
		expect(saved.map((item) => item.text)).toEqual(["Same question", "An answer"]);
	});

	test("keeps an earlier message that only looks the same as the in-flight turn", () => {
		const saved = settleThreadMessages([question, repeated], repeated, T0);
		expect(saved).toHaveLength(1);
		expect(saved[0].text).toBe("Same question");
	});

	test("keeps everything when nothing is in flight", () => {
		expect(settleThreadMessages([question, answer], null, T0)).toHaveLength(2);
		expect(settleThreadMessages([question, answer], undefined, T0)).toHaveLength(2);
	});

	test("accepts several in-flight messages and still drops system lines and empty text", () => {
		const saved = settleThreadMessages([question, answer, repeated, { role: "system", text: "x" }, { role: "assistant", text: "  " }], [repeated, answer], T0);
		expect(saved.map((item) => item.text)).toEqual(["Same question"]);
	});

	test("uses the given timestamp for messages without one", () => {
		expect(settleThreadMessages([question], null, T1)[0].createdAt).toBe(T1);
	});
});

describe("ThreadService persistence", () => {
	function createHarness(overrides: Partial<AskMateSettings> = {}) {
		const settings = { ...structuredClone(normalizeAskMateSettings({}, "load")), ...overrides };
		const disk: string[] = [];
		const outcomes: ("ok" | "fail")[] = [];
		const warnings: string[] = [];
		const notices: string[] = [];
		const timers: { callback: () => void; cleared: boolean }[] = [];
		let clock = 1_000_000;
		let gate: Promise<void> | null = null;
		const service = new ThreadService({
			getSettings: () => settings,
			saveSettings: async () => {
				const outcome = outcomes.shift() ?? "ok";
				if (gate) {
					await gate;
				}
				// Yielding lets overlapping writes interleave the way real disk writes do.
				await Promise.resolve();
				if (outcome === "fail") {
					throw new Error("disk full");
				}
				disk.push(JSON.stringify(settings.threadStore));
			},
			setTimer: (callback) => {
				const entry = { callback, cleared: false };
				timers.push(entry);
				return entry;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
			warn: (warning) => warnings.push(warning),
			notify: (notice) => notices.push(notice),
			now: () => clock
		});
		return {
			settings,
			service,
			disk,
			outcomes,
			warnings,
			notices,
			timers,
			advance: (ms: number) => { clock += ms; },
			hold: () => {
				let release: () => void = () => undefined;
				gate = new Promise<void>((resolve) => { release = resolve; });
				return () => { gate = null; release(); };
			},
			lastDisk: () => (JSON.parse(disk.at(-1) ?? "{\"threads\":[]}") as { threads: { id: string }[] })
		};
	}

	test("overlapping persists with a failing first write keep the second change in memory and on disk (STO-01)", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		await harness.service.flush();
		harness.outcomes.push("fail");
		const first = harness.service.markActive(null);
		harness.service.scheduleSave(thread("b", T1, ["Other"]));
		const second = harness.service.flush();
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect(ids(harness.settings.threadStore).sort()).toEqual(["a", "b"]);
		expect(harness.lastDisk().threads.map((item) => item.id).sort()).toEqual(["a", "b"]);
		expect(harness.service.getActiveThread()?.id).toBe("b");
	});

	test("a failed write reverts only its own step", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		await harness.service.flush();
		harness.outcomes.push("ok", "fail", "ok");
		const renamed = harness.service.rename("a", "Kept title");
		harness.service.scheduleSave(thread("b", T1, ["Failing"]));
		const failing = harness.service.flush();
		const removed = harness.service.remove("zzz");
		expect(await renamed).toBe(true);
		expect(await failing).toBe(false);
		await removed;
		expect(harness.service.getThread("a")?.title).toBe("Kept title");
		expect(harness.service.getThread("b")).toBeNull();
	});

	test("persist, remove and clearAll report success as booleans and leave the store alone on failure", async () => {
		const harness = createHarness();
		expect(await harness.service.saveNow(thread("a", T0))).toBe(true);
		harness.service.scheduleSave(thread("b", T1, ["Second"]));
		expect(await harness.service.flush()).toBe(true);
		harness.outcomes.push("fail");
		expect(await harness.service.remove("a")).toBe(false);
		expect(ids(harness.settings.threadStore).sort()).toEqual(["a", "b"]);
		harness.outcomes.push("fail");
		expect(await harness.service.clearAll()).toBe(false);
		expect(ids(harness.settings.threadStore).sort()).toEqual(["a", "b"]);
		expect(await harness.service.remove("a")).toBe(true);
		expect(await harness.service.clearAll()).toBe(true);
		expect(harness.settings.threadStore.threads).toEqual([]);
		harness.outcomes.push("fail");
		expect(await harness.service.rename("a", "x")).toBe(true);
		expect(await harness.service.markActive(null)).toBe(true);
	});

	test("a failed write is logged every time and shown to the user at most once per interval", async () => {
		const harness = createHarness();
		harness.outcomes.push("fail", "fail", "fail");
		await harness.service.saveNow(thread("a", T0));
		await harness.service.saveNow(thread("b", T1, ["Two"]));
		expect(harness.warnings).toHaveLength(2);
		expect(harness.notices).toHaveLength(1);
		harness.advance(THREAD_SAVE_WARNING_INTERVAL_MS);
		await harness.service.saveNow(thread("c", T1, ["Three"]));
		expect(harness.warnings).toHaveLength(3);
		expect(harness.notices).toHaveLength(2);
	});

	test("queued threads are kept per id, and the last one scheduled becomes active", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		harness.service.scheduleSave(thread("b", T1, ["Second"]));
		harness.service.scheduleSave(thread("a", T0, ["Hello", "Again"]));
		expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
		expect(await harness.service.flush()).toBe(true);
		expect(ids(harness.settings.threadStore).sort()).toEqual(["a", "b"]);
		expect(harness.service.getThread("a")?.messages).toHaveLength(2);
		expect(harness.service.getActiveThread()?.id).toBe("a");
		expect(harness.disk).toHaveLength(1);
	});

	test("removing a thread drops only its own queued save", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		harness.service.scheduleSave(thread("b", T1, ["Second"]));
		await harness.service.remove("a");
		expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
		await harness.service.flush();
		expect(ids(harness.settings.threadStore)).toEqual(["b"]);
	});

	test("saving a thread that did not change writes nothing and keeps updatedAt", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		await harness.service.flush();
		const writes = harness.disk.length;
		harness.service.scheduleSave(thread("a", "2026-10-12T09:00:00.000Z"));
		expect(await harness.service.flush()).toBe(true);
		expect(harness.disk).toHaveLength(writes);
		expect(harness.settings.threadStore.threads[0].updatedAt).toBe(T0);
		expect(await harness.service.markActive("a")).toBe(true);
		expect(harness.disk).toHaveLength(writes);
	});

	test("viewing an old thread makes it active without moving it up the recency list", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("old", "2026-03-01T10:00:00.000Z", ["Old question"]));
		await harness.service.flush();
		harness.service.scheduleSave(thread("new", T1, ["New question"]));
		await harness.service.flush();
		harness.service.scheduleSave(thread("old", "2026-10-12T09:00:00.000Z", ["Old question"]));
		await harness.service.flush();
		expect(harness.service.getActiveThread()?.id).toBe("old");
		expect(harness.service.listThreads().map((item) => item.id)).toEqual(["new", "old"]);
		expect(harness.service.getThread("old")?.updatedAt).toBe("2026-03-01T10:00:00.000Z");
	});

	test("saveNow resolves after the write has finished", async () => {
		const harness = createHarness();
		const release = harness.hold();
		let finished = false;
		const result = harness.service.saveNow(thread("a", T0)).then((ok) => {
			finished = true;
			return ok;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		expect(finished).toBe(false);
		expect(harness.disk).toHaveLength(0);
		release();
		expect(await result).toBe(true);
		expect(harness.disk).toHaveLength(1);
	});

	test("saveNow reports a failed write, and does nothing while saving is off", async () => {
		const harness = createHarness();
		harness.outcomes.push("fail");
		expect(await harness.service.saveNow(thread("a", T0))).toBe(false);
		expect(harness.settings.threadStore.threads).toEqual([]);
		harness.settings.saveConversations = false;
		expect(await harness.service.saveNow(thread("b", T1, ["Two"]))).toBe(true);
		expect(harness.settings.threadStore.threads).toEqual([]);
		expect(harness.timers).toHaveLength(0);
	});

	test("onDidClear notifies subscribers after a successful clearAll only", async () => {
		const harness = createHarness();
		await harness.service.saveNow(thread("a", T0));
		const calls: string[] = [];
		const stop = harness.service.onDidClear(() => calls.push("first"));
		harness.service.onDidClear(() => {
			throw new Error("listener failed");
		});
		harness.service.onDidClear(() => calls.push("third"));
		harness.outcomes.push("fail");
		expect(await harness.service.clearAll()).toBe(false);
		expect(calls).toEqual([]);
		expect(await harness.service.clearAll()).toBe(true);
		expect(calls).toEqual(["first", "third"]);
		stop();
		await harness.service.clearAll();
		expect(calls).toEqual(["first", "third", "third"]);
	});

	test("reload drops queued saves and adopts the new store", async () => {
		const harness = createHarness();
		harness.service.scheduleSave(thread("a", T0));
		harness.service.reload({ activeId: "z", threads: [thread("z", T1, ["Remote"])] });
		expect(harness.timers.every((timer) => timer.cleared)).toBe(true);
		expect(await harness.service.flush()).toBe(true);
		expect(harness.disk).toHaveLength(0);
		expect(ids(harness.settings.threadStore)).toEqual(["z"]);
		expect(harness.service.getActiveThread()?.id).toBe("z");
	});

	test("reload drops a write that was prepared against the old data", async () => {
		const harness = createHarness();
		const release = harness.hold();
		harness.service.scheduleSave(thread("a", T0));
		const underWay = harness.service.flush();
		harness.service.scheduleSave(thread("b", T1, ["Stale"]));
		const stale = harness.service.flush();
		harness.service.reload({ activeId: null, threads: [thread("z", T1, ["Remote"])] });
		release();
		await underWay;
		expect(await stale).toBe(false);
		expect(ids(harness.settings.threadStore)).toEqual(["z"]);
	});

	test("reload keeps the new store when a write that was already under way fails", async () => {
		const harness = createHarness();
		const release = harness.hold();
		harness.outcomes.push("fail");
		const underWay = harness.service.saveNow(thread("a", T0));
		harness.service.reload({ activeId: null, threads: [thread("z", T1, ["Remote"])] });
		release();
		expect(await underWay).toBe(false);
		expect(ids(harness.settings.threadStore)).toEqual(["z"]);
	});

	test("handleFileRenamed moves saved and queued threads and works while saving is off", async () => {
		const harness = createHarness();
		const saved = { ...thread("saved", T0), messages: [message("user", "Q", { sourcePath: "Notes/Plan.md" })] };
		await harness.service.saveNow(saved);
		harness.service.scheduleSave({ ...thread("queued", T1, ["Q"]), messages: [message("user", "Q", { sourcePath: "Notes/Plan.md" })] });
		const writes = harness.disk.length;
		await harness.service.handleFileRenamed("Notes", "Archive");
		expect(harness.service.getThread("saved")?.messages[0].sourcePath).toBe("Archive/Plan.md");
		expect(harness.service.getThread("saved")?.updatedAt).toBe(T0);
		expect(harness.disk).toHaveLength(writes + 1);
		await harness.service.flush();
		expect(harness.service.getThread("queued")?.messages[0].sourcePath).toBe("Archive/Plan.md");
		const afterFlush = harness.disk.length;
		await harness.service.handleFileRenamed("Unrelated.md", "Else.md");
		expect(harness.disk).toHaveLength(afterFlush);
		harness.settings.saveConversations = false;
		await harness.service.handleFileRenamed("Archive", "Vault");
		expect(harness.service.getThread("saved")?.messages[0].sourcePath).toBe("Vault/Plan.md");
	});

	test("handleFileDeleted clears the note's links and quoting replies and keeps the conversation", async () => {
		const harness = createHarness();
		await harness.service.saveNow({
			...thread("a", T0),
			messages: [message("user", "Summarise", { sourcePath: "Plan.md" }), message("assistant", "It says X.", { sourcePath: "Plan.md" })]
		});
		harness.service.scheduleSave({
			...thread("queued", T1, ["Q"]),
			messages: [message("user", "Q"), message("assistant", "Quote from the note", { sourcePath: "Plan.md" })]
		});
		await harness.service.handleFileDeleted("Plan.md");
		await harness.service.flush();
		const stored = harness.service.getThread("a");
		expect(stored?.messages.map((item) => item.text)).toEqual(["Summarise", DELETED_NOTE_REPLY_PLACEHOLDER]);
		expect(stored?.messages.every((item) => item.sourcePath === undefined)).toBe(true);
		expect(harness.service.getThread("queued")?.messages[1].text).toBe(DELETED_NOTE_REPLY_PLACEHOLDER);
		const writes = harness.disk.length;
		await harness.service.handleFileDeleted("Plan.md");
		expect(harness.disk).toHaveLength(writes);
	});

	/**
	 * Drives the service the way AskMateView does: it holds the transcript itself, keeps a thread without messages as
	 * metadata, and every save replaces the whole stored thread with a snapshot of that transcript.
	 */
	function createSidebar(service: ThreadService, subscribe: boolean) {
		const live: ChatMessageLike[] = [];
		let meta = createThread("t1", new Date(T0));
		if (subscribe) {
			service.onDidRewritePaths((change) => {
				applyPathChangeToLiveMessages(live, change);
			});
		}
		const snapshot = (now: string): SavedThread => {
			const next = withThreadMessages(meta, toSavedMessages(live, now), new Date(now));
			meta = { ...next, messages: [] };
			return next;
		};
		return { live, snapshot, save: (now: string = T1) => service.saveNow(snapshot(now)) };
	}

	function chat(role: "user" | "assistant", text: string, sourcePath?: string): ChatMessageLike {
		return { role, text, createdAt: T0, ...(sourcePath ? { sourcePath } : {}) };
	}

	test("onDidRewritePaths tells subscribers at once, skips changes that move nothing and works while saving is off (STO-03)", async () => {
		const harness = createHarness();
		const seen: ThreadPathChange[] = [];
		const stop = harness.service.onDidRewritePaths((change) => seen.push(change));
		harness.service.onDidRewritePaths(() => {
			throw new Error("listener failed");
		});
		harness.service.onDidRewritePaths((change) => seen.push(change));
		const renamed = harness.service.handleFileRenamed("a.md", "b.md");
		expect(seen).toEqual([{ kind: "renamed", oldPath: "a.md", newPath: "b.md" }, { kind: "renamed", oldPath: "a.md", newPath: "b.md" }]);
		expect(harness.warnings).toHaveLength(1);
		await renamed;
		seen.length = 0;
		await harness.service.handleFileRenamed("a.md", "a.md");
		await harness.service.handleFileRenamed("", "b.md");
		await harness.service.handleFileDeleted("");
		expect(seen).toEqual([]);
		harness.settings.saveConversations = false;
		await harness.service.handleFileDeleted("b.md");
		expect(seen).toEqual([{ kind: "deleted", path: "b.md" }, { kind: "deleted", path: "b.md" }]);
		stop();
		seen.length = 0;
		await harness.service.handleFileDeleted("c.md");
		expect(seen).toEqual([{ kind: "deleted", path: "c.md" }]);
	});

	test("the open conversation keeps a rename when the sidebar saves its own transcript next (STO-03)", async () => {
		const harness = createHarness();
		const sidebar = createSidebar(harness.service, true);
		sidebar.live.push(chat("user", "Summarise", "Notes/x.md"), chat("assistant", "It says X.", "Notes/x.md"));
		await sidebar.save(T0);
		await harness.service.handleFileRenamed("Notes/x.md", "Notes/y.md");
		expect(harness.service.getThread("t1")?.messages.map((item) => item.sourcePath)).toEqual(["Notes/y.md", "Notes/y.md"]);
		// The sidebar saving what it already shows is not activity.
		const writes = harness.disk.length;
		await sidebar.save();
		expect(harness.disk).toHaveLength(writes);
		expect(harness.service.getThread("t1")?.updatedAt).toBe(T0);
		sidebar.live.push(chat("user", "And now?", "Notes/y.md"));
		await sidebar.save();
		expect(harness.service.getThread("t1")?.messages.map((item) => item.sourcePath)).toEqual(["Notes/y.md", "Notes/y.md", "Notes/y.md"]);
	});

	test("the open conversation keeps a delete when the sidebar saves its own transcript next (STO-03)", async () => {
		const harness = createHarness();
		const sidebar = createSidebar(harness.service, true);
		sidebar.live.push(chat("user", "Summarise", "Plan.md"), chat("assistant", "It says X.", "Plan.md"));
		await sidebar.save(T0);
		await harness.service.handleFileDeleted("Plan.md");
		expect(sidebar.live.map((item) => item.text)).toEqual(["Summarise", DELETED_NOTE_REPLY_PLACEHOLDER]);
		sidebar.live.push(chat("user", "Something else"));
		await sidebar.save();
		const stored = harness.service.getThread("t1");
		expect(stored?.messages.map((item) => item.text)).toEqual(["Summarise", DELETED_NOTE_REPLY_PLACEHOLDER, "Something else"]);
		expect(stored?.messages.every((item) => item.sourcePath === undefined)).toBe(true);
	});

	test("a save that is still waiting for the debounce also ends up with the new paths (STO-03)", async () => {
		const harness = createHarness();
		const sidebar = createSidebar(harness.service, true);
		sidebar.live.push(chat("user", "Summarise", "Notes/x.md"));
		harness.service.scheduleSave(sidebar.snapshot(T0));
		const renamed = harness.service.handleFileRenamed("Notes/x.md", "Notes/y.md");
		sidebar.live.push(chat("assistant", "It says X.", "Notes/y.md"));
		harness.service.scheduleSave(sidebar.snapshot(T1));
		await renamed;
		await harness.service.flush();
		expect(harness.service.getThread("t1")?.messages.map((item) => item.sourcePath)).toEqual(["Notes/y.md", "Notes/y.md"]);
	});

	test("control: a sidebar that is not subscribed brings the old paths back with its next save", async () => {
		const harness = createHarness();
		const sidebar = createSidebar(harness.service, false);
		sidebar.live.push(chat("user", "Summarise", "Notes/x.md"), chat("assistant", "It says X.", "Notes/x.md"));
		await sidebar.save(T0);
		await harness.service.handleFileRenamed("Notes/x.md", "Notes/y.md");
		sidebar.live.push(chat("user", "And now?", "Notes/y.md"));
		await sidebar.save();
		expect(harness.service.getThread("t1")?.messages.map((item) => item.sourcePath)).toEqual(["Notes/x.md", "Notes/x.md", "Notes/y.md"]);
	});
});
