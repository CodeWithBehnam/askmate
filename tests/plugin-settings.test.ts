import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { classifyStoredData, corruptBackupName, mergeExternalSettings } from "../src/plugin/settingsLoad";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, ReviewQueueItem } from "../src/shared/types";
import type { SavedThread } from "../src/threads/threadModel";
import { createFakeApp, type FakeApp } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";
import { Notice } from "./support/obsidian-fakes";

let restoreDom: () => void;

beforeAll(() => {
	restoreDom = installDomGlobals();
});

afterAll(() => {
	restoreDom();
});

beforeEach(() => {
	Notice.clear();
});

function thread(id: string, updatedAt: string, text: string): SavedThread {
	return { id, title: text, autoTitle: true, createdAt: "2026-10-01T09:00:00.000Z", updatedAt, messages: [{ role: "user", text, createdAt: updatedAt }] };
}

function queueItem(id: string, updatedAt: string, status: ReviewQueueItem["status"] = "pending"): ReviewQueueItem {
	return {
		id, createdAt: "2026-10-01T09:00:00.000Z", updatedAt, status, sourcePath: "Notes/A.md", title: "T", question: "Q",
		proposedText: "P", beforeText: "B", scope: "append", headingPath: "", selectionIdentity: null, providerName: "OpenAI", model: "gpt-5.5",
		workflowId: null, workflowName: null
	};
}

function settingsWith(overrides: Partial<AskMateSettings>): AskMateSettings {
	return normalizeAskMateSettings({ ...DEFAULT_SETTINGS, ...overrides }, "load");
}

interface TestPlugin extends AskMatePlugin {
	storedData: unknown;
	saveCount: number;
}

interface Adapter {
	copies: Array<{ from: string; to: string }>;
	failCopy: boolean;
}

async function loadPlugin(stored: unknown, adapter?: Partial<Adapter>): Promise<{ plugin: TestPlugin; fake: FakeApp; adapter: Adapter }> {
	const fake = createFakeApp();
	const state: Adapter = { copies: [], failCopy: false, ...adapter };
	Object.assign(fake.vault, {
		adapter: {
			copy: (from: string, to: string) => {
				if (state.failCopy) {
					return Promise.reject(new Error("disk full"));
				}
				state.copies.push({ from, to });
				return Promise.resolve();
			}
		}
	});
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
	plugin.storedData = stored;
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake, adapter: state };
}

describe("classifyStoredData", () => {
	test("null is a fresh install, an object is data, anything else is corrupt", () => {
		expect(classifyStoredData(null)).toEqual({ kind: "fresh" });
		expect(classifyStoredData({ reasoningEffort: "low" })).toEqual({ kind: "ok", data: { reasoningEffort: "low" } });
		expect(classifyStoredData({})).toEqual({ kind: "ok", data: {} });
		expect(classifyStoredData(undefined).kind).toBe("corrupt");
		expect(classifyStoredData("text").kind).toBe("corrupt");
		expect(classifyStoredData([1]).kind).toBe("corrupt");
	});

	test("the backup name is UTC and safe on every file system", () => {
		expect(corruptBackupName(new Date("2026-10-12T09:11:05.123Z"))).toBe("data.json.corrupt-2026-10-12T09-11-05Z");
	});
});

describe("mergeExternalSettings", () => {
	test("the synced file decides ordinary settings", () => {
		const merged = mergeExternalSettings(settingsWith({ reasoningEffort: "low" }), settingsWith({ reasoningEffort: "high" }));
		expect(merged.reasoningEffort).toBe("high");
	});

	test("threads are merged by id and the newer copy wins", () => {
		const local = settingsWith({ threadStore: { activeId: "mine", threads: [thread("mine", "2026-10-02T10:00:00.000Z", "only here"), thread("both", "2026-10-02T12:00:00.000Z", "local edit")] } });
		const incoming = settingsWith({ threadStore: { activeId: "theirs", threads: [thread("theirs", "2026-10-02T11:00:00.000Z", "only there"), thread("both", "2026-10-02T08:00:00.000Z", "old edit")] } });

		const merged = mergeExternalSettings(local, incoming);

		expect(merged.threadStore.threads.map((item) => item.id).sort()).toEqual(["both", "mine", "theirs"]);
		expect(merged.threadStore.threads.find((item) => item.id === "both")?.messages[0]?.text).toBe("local edit");
		expect(merged.threadStore.activeId).toBe("mine");
	});

	test("queued suggestions merge by id and an applied item is not brought back to pending", () => {
		const local = settingsWith({ reviewQueue: [queueItem("a", "2026-10-02T10:00:00.000Z", "applied"), queueItem("local-only", "2026-10-02T10:00:00.000Z")] });
		const incoming = settingsWith({ reviewQueue: [queueItem("a", "2026-10-02T09:00:00.000Z", "pending"), queueItem("remote-only", "2026-10-02T09:30:00.000Z")] });

		const merged = mergeExternalSettings(local, incoming);

		expect(merged.reviewQueue.map((item) => item.id).sort()).toEqual(["a", "local-only", "remote-only"]);
		expect(merged.reviewQueue.find((item) => item.id === "a")?.status).toBe("applied");
	});

	test("merging twice gives the same result, so two devices settle on one file", () => {
		const local = settingsWith({ threadStore: { activeId: null, threads: [thread("mine", "2026-10-02T10:00:00.000Z", "x")] } });
		const incoming = settingsWith({ threadStore: { activeId: null, threads: [thread("theirs", "2026-10-02T11:00:00.000Z", "y")] } });

		const once = mergeExternalSettings(local, incoming);
		expect(mergeExternalSettings(once, once)).toEqual(once);
		expect(mergeExternalSettings(incoming, once).threadStore.threads.map((item) => item.id).sort()).toEqual(["mine", "theirs"]);
	});
});

describe("loading settings", () => {
	test("a file that cannot be read is copied aside before defaults take over, and the notice names the copy", async () => {
		const { plugin, adapter } = await loadPlugin(undefined);

		expect(adapter.copies).toHaveLength(1);
		expect(adapter.copies[0]?.from).toBe(".obsidian/plugins/askmate/data.json");
		expect(adapter.copies[0]?.to).toMatch(/^\.obsidian\/plugins\/askmate\/data\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
		const notice = Notice.messages.find((message) => message.includes("could not read its saved settings"));
		expect(notice).toContain("data.json.corrupt-");
		// A corrupt file belongs to an existing install, so it does not get the first-run layout.
		expect(plugin.settings.composerLayout).toBe("console");
	});

	test("a failed backup is reported and the plugin still starts", async () => {
		const { plugin } = await loadPlugin(undefined, { failCopy: true });

		expect(Notice.messages.join(" ")).toContain("could not back them up (disk full)");
		expect(plugin.settings.model).toBeDefined();
	});

	test("a read that throws is treated as corruption too", async () => {
		const fake = createFakeApp();
		Object.assign(fake.vault, { adapter: { copy: () => Promise.resolve() } });
		const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never);
		Object.assign(plugin, { loadData: () => Promise.reject(new Error("Unexpected token")) });
		plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
		await plugin.onload();

		expect(Notice.messages.join(" ")).toContain("could not read its saved settings");
	});

	test("a missing file is a first run and needs no backup", async () => {
		const { adapter } = await loadPlugin(null);
		expect(adapter.copies).toEqual([]);
		expect(Notice.messages.join(" ")).not.toContain("could not read");
	});

	test("keys from a newer build survive a load and a save", async () => {
		const { plugin } = await loadPlugin({ settingsVersion: 99, futureFeature: { enabled: true, items: [1, 2] }, composerLayout: "expanded" });

		await plugin.saveSettings();

		const saved = plugin.storedData as Record<string, unknown>;
		expect(saved.futureFeature).toEqual({ enabled: true, items: [1, 2] });
		expect(saved.settingsVersion).toBe(99);
		expect(saved.composerLayout).toBe("expanded");
	});

	test("an unknown key from an older or hand-edited file is kept, but a plain-text API key is dropped", async () => {
		const { plugin } = await loadPlugin({ notesFromTheUser: "keep me", openAiApiKey: "sk-should-not-stay" });
		await plugin.saveSettings();

		const saved = plugin.storedData as Record<string, unknown>;
		expect(saved.notesFromTheUser).toBe("keep me");
		expect(saved.openAiApiKey).toBeUndefined();
	});
});

describe("settings that change on another device", () => {
	test("the synced file is adopted, this device's own threads are kept, and the union is written back", async () => {
		const { plugin } = await loadPlugin({});
		plugin.settings.threadStore = { activeId: "mine", threads: [thread("mine", "2026-10-02T10:00:00.000Z", "only here")] };
		await plugin.saveSettings();
		const savesBefore = plugin.saveCount;

		// A sync replaced data.json with another device's version.
		plugin.storedData = { ...(plugin.storedData as object), reasoningEffort: "high", threadStore: { activeId: null, threads: [thread("theirs", "2026-10-02T11:00:00.000Z", "only there")] } };
		await plugin.onExternalSettingsChange();

		expect(plugin.settings.reasoningEffort).toBe("high");
		expect(plugin.settings.threadStore.threads.map((item) => item.id).sort()).toEqual(["mine", "theirs"]);
		expect(plugin.saveCount).toBeGreaterThan(savesBefore);
		const written = (plugin.storedData as { threadStore: { threads: SavedThread[] } }).threadStore.threads.map((item) => item.id).sort();
		expect(written).toEqual(["mine", "theirs"]);
	});

	test("a change that holds nothing new is adopted without another write", async () => {
		const { plugin } = await loadPlugin({});
		await plugin.saveSettings();
		const savesBefore = plugin.saveCount;

		await plugin.onExternalSettingsChange();

		expect(plugin.saveCount).toBe(savesBefore);
	});

	test("an unreadable file after a change leaves the settings alone", async () => {
		const { plugin } = await loadPlugin({ reasoningEffort: "low" });
		Object.assign(plugin, { loadData: () => Promise.reject(new Error("locked")) });

		await plugin.onExternalSettingsChange();

		expect(plugin.settings.reasoningEffort).toBe("low");
	});
});
