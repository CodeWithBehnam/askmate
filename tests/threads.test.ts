import { describe, expect, test } from "bun:test";
import { ThreadService, THREAD_SAVE_DEBOUNCE_MS } from "../src/threads/ThreadService";
import {
	MAX_SAVED_THREADS,
	MAX_THREAD_MESSAGES,
	MAX_THREAD_TITLE_CHARACTERS,
	createEmptyThreadStore,
	createThread,
	deleteThreadFromStore,
	deriveThreadTitle,
	formatRelativeTime,
	listThreadsByRecency,
	normalizeThreadStore,
	pruneThreads,
	renameThreadInStore,
	setActiveThread,
	toSavedMessages,
	upsertThread,
	withThreadMessages,
	type SavedMessage,
	type SavedThread
} from "../src/threads/threadModel";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings } from "../src/shared/types";

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
