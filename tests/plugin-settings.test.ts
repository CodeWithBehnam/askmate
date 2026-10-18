import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { classifyStoredData, corruptBackupName, mergeAddsToIncoming, mergeExternalSettings, predatesSettingsSchema } from "../src/plugin/settingsLoad";
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

	test("a file saved before settings had a version cannot have chosen the newer groups, so this device keeps its own", () => {
		const server = { id: "git", label: "Git", transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: {} };
		const local = settingsWith({
			mcp: normalizeAskMateSettings({ mcp: { enabled: true, servers: [server] } } as never, "load").mcp,
			skills: { ...DEFAULT_SETTINGS.skills, enabled: false, trustedHashes: { "vault:x": "a".repeat(64) } },
			diagrams: { ...DEFAULT_SETTINGS.diagrams, defaultType: "sequence" },
			firstRunCompletedAt: "2026-10-01T09:00:00.000Z",
			lastSeenVersion: "1.12.0",
			reasoningEffort: "low"
		});
		const incoming = settingsWith({ reasoningEffort: "high" });

		const merged = mergeExternalSettings(local, incoming, { incomingPredatesSchema: true });

		expect(merged.reasoningEffort).toBe("high");
		expect(merged.mcp).toEqual(local.mcp);
		expect(merged.mcp.servers).toHaveLength(1);
		expect(merged.skills).toEqual(local.skills);
		expect(merged.diagrams).toEqual(local.diagrams);
		expect(merged.firstRunCompletedAt).toBe("2026-10-01T09:00:00.000Z");
		expect(merged.lastSeenVersion).toBe("1.12.0");
		expect(mergeExternalSettings(local, incoming).mcp.servers).toHaveLength(0);
	});

	test("only a file without a settings version predates the schema", () => {
		expect(predatesSettingsSchema({})).toBe(true);
		expect(predatesSettingsSchema({ settingsVersion: 0 })).toBe(true);
		expect(predatesSettingsSchema({ settingsVersion: 1 })).toBe(false);
		expect(predatesSettingsSchema({ settingsVersion: 99 })).toBe(false);
	});

	test("the open conversation alone does not count as something the file lacks", () => {
		const threads = [thread("a", "2026-10-02T10:00:00.000Z", "x"), thread("b", "2026-10-02T11:00:00.000Z", "y")];
		const incoming = settingsWith({ threadStore: { activeId: "a", threads } });
		expect(mergeAddsToIncoming(settingsWith({ threadStore: { activeId: "b", threads } }), incoming)).toBe(false);
		expect(mergeAddsToIncoming(settingsWith({ threadStore: { activeId: "b", threads }, reasoningEffort: "low" }), incoming)).toBe(true);
		expect(mergeAddsToIncoming(settingsWith({ threadStore: { activeId: "a", threads: [...threads, thread("c", "2026-10-02T12:00:00.000Z", "z")] } }), incoming)).toBe(true);
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

	test("conversations that no longer fit the size budget are reported, and the file is copied aside before the first save cuts it", async () => {
		const stamp = (index: number) => new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString();
		const threads = Array.from({ length: 50 }, (_, index) => ({
			id: `thread-${index}`,
			title: `Thread ${index}`,
			autoTitle: true,
			createdAt: stamp(index),
			updatedAt: stamp(index),
			messages: Array.from({ length: 40 }, (__, turn) => ({ role: turn % 2 === 0 ? "user" : "assistant", text: `${turn} ${"x".repeat(3000)}`, createdAt: stamp(index) }))
		}));

		const { plugin, adapter } = await loadPlugin({ threadStore: { activeId: null, threads } });

		const kept = plugin.settings.threadStore.threads.length;
		expect(kept).toBeLessThan(50);
		expect(adapter.copies).toHaveLength(1);
		expect(adapter.copies[0]?.from).toBe(".obsidian/plugins/askmate/data.json");
		expect(adapter.copies[0]?.to).toMatch(/^\.obsidian\/plugins\/askmate\/data\.json\.before-trim-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
		const notice = Notice.messages.find((message) => message.includes("keeps saved conversations within"));
		expect(notice).toContain(`${50 - kept} of the oldest conversations were removed`);
		expect(notice).toContain("data.json.before-trim-");
	});

	test("a store that fits is loaded without a notice or a copy", async () => {
		const { adapter } = await loadPlugin({ threadStore: { activeId: null, threads: [thread("a", "2026-10-02T10:00:00.000Z", "hello")] } });

		expect(adapter.copies).toEqual([]);
		expect(Notice.messages.join(" ")).not.toContain("keeps saved conversations");
	});

	test("a failed copy is still reported, without claiming one exists", async () => {
		const threads = Array.from({ length: 4 }, (_, index) => ({
			id: `t${index}`, title: "T", autoTitle: true, createdAt: "2026-10-01T09:00:00.000Z", updatedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
			messages: [{ role: "user", text: "x".repeat(49_000), createdAt: "2026-10-01T09:00:00.000Z" }, ...Array.from({ length: 150 }, () => ({ role: "assistant", text: "y".repeat(49_000), createdAt: "2026-10-01T09:00:00.000Z" }))]
		}));

		const { plugin } = await loadPlugin({ threadStore: { activeId: null, threads } }, { failCopy: true });

		const notice = Notice.messages.find((message) => message.includes("keeps saved conversations within"));
		expect(notice).toBeDefined();
		expect(notice).not.toContain("A copy of the file");
		expect(plugin.settings.threadStore.threads.length).toBeGreaterThan(0);
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

	test("QA-02: a synced change rebuilds the settings tab, so its Connection page follows the new chat provider", async () => {
		const { plugin } = await loadPlugin({});
		const tab = (plugin as unknown as { settingTab: { updateCount: number } }).settingTab;
		const before = tab.updateCount;
		plugin.storedData = { ...(plugin.storedData as object), selectedTextProvider: "openai-compatible", providerRoles: { chatProviderId: "openai-compatible" } };
		await plugin.onExternalSettingsChange();
		expect(plugin.getSelectedTextProviderId()).toBe("openai-compatible");
		expect(tab.updateCount).toBe(before + 1);
	});

	test("a change that holds nothing new is adopted without another write", async () => {
		const { plugin } = await loadPlugin({});
		await plugin.saveSettings();
		const savesBefore = plugin.saveCount;

		await plugin.onExternalSettingsChange();

		expect(plugin.saveCount).toBe(savesBefore);
	});

	test("a file with nothing new for this device leaves the conversation saves still waiting alone", async () => {
		const { plugin } = await loadPlugin({});
		await plugin.saveSettings();
		plugin.threads.scheduleSave(thread("waiting", "2026-10-02T10:00:00.000Z", "typed a moment ago"));

		await plugin.onExternalSettingsChange();
		await plugin.threads.flush();

		expect(plugin.settings.threadStore.threads.map((item) => item.id)).toEqual(["waiting"]);
	});

	test("an unreadable file after a change leaves the settings alone", async () => {
		const { plugin } = await loadPlugin({ reasoningEffort: "low" });
		Object.assign(plugin, { loadData: () => Promise.reject(new Error("locked")) });

		await plugin.onExternalSettingsChange();

		expect(plugin.settings.reasoningEffort).toBe("low");
	});
});

/** The file one device just saved arrives on another; returns whether that device wrote a file back in answer. */
async function deliver(from: TestPlugin, to: TestPlugin): Promise<boolean> {
	const savesBefore = to.saveCount;
	to.storedData = structuredClone(from.storedData);
	await to.onExternalSettingsChange();
	return to.saveCount > savesBefore;
}

describe("two devices that sync the same file", () => {
	const shared = { threadStore: { activeId: "t1", threads: [thread("t1", "2026-10-02T08:00:00.000Z", "shared")] } };

	test("devices with different open conversations settle instead of rewriting the file back and forth", async () => {
		const desktop = (await loadPlugin(shared)).plugin;
		const phone = (await loadPlugin(shared)).plugin;
		await desktop.threads.saveNow(thread("on-desktop", "2026-10-02T10:00:00.000Z", "asked on the desktop"));
		await phone.threads.saveNow(thread("on-phone", "2026-10-02T11:00:00.000Z", "asked on the phone"));
		expect(desktop.settings.threadStore.activeId).not.toBe(phone.settings.threadStore.activeId);

		const writes: boolean[] = [];
		for (let round = 0; round < 3; round += 1) {
			writes.push(await deliver(desktop, phone), await deliver(phone, desktop));
		}

		// Each device gains the other's conversation once. After that nothing new is left to write.
		expect(writes.slice(2)).toEqual([false, false, false, false]);
		const ids = (plugin: TestPlugin) => plugin.settings.threadStore.threads.map((item) => item.id).sort();
		expect(ids(desktop)).toEqual(["on-desktop", "on-phone", "t1"]);
		expect(ids(phone)).toEqual(ids(desktop));
	});

	test("devices that each added a conversation, a history turn and a queued suggestion converge on the same records", async () => {
		const turn = (id: string, createdAt: string) => ({ id, sourcePath: "Notes/A.md", createdAt, title: "T", question: "Q", answer: "A", providerName: "OpenAI", model: "gpt-5.5", outputMode: "chat" as const, intentKind: "freeform_text" as const });
		const desktop = (await loadPlugin(shared)).plugin;
		const phone = (await loadPlugin(shared)).plugin;
		await desktop.threads.saveNow(thread("on-desktop", "2026-10-02T10:00:00.000Z", "asked on the desktop"));
		await phone.threads.saveNow(thread("on-phone", "2026-10-02T11:00:00.000Z", "asked on the phone"));
		desktop.settings.noteHistoryStore.turns.push(turn("history-desktop", "2026-10-02T10:30:00.000Z"));
		desktop.settings.reviewQueue.push(queueItem("queue-desktop", "2026-10-02T10:40:00.000Z"));
		phone.settings.noteHistoryStore.turns.push(turn("history-phone", "2026-10-02T09:30:00.000Z"));
		phone.settings.reviewQueue.push(queueItem("queue-phone", "2026-10-02T11:40:00.000Z"));
		await desktop.saveSettings();
		await phone.saveSettings();

		const writes: boolean[] = [];
		for (let round = 0; round < 3; round += 1) {
			writes.push(await deliver(desktop, phone), await deliver(phone, desktop));
		}

		expect(writes.slice(2)).toEqual([false, false, false, false]);
		for (const plugin of [desktop, phone]) {
			expect(plugin.settings.threadStore.threads.map((item) => item.id).sort()).toEqual(["on-desktop", "on-phone", "t1"]);
			expect(plugin.settings.noteHistoryStore.turns.map((item) => item.id)).toEqual(["history-phone", "history-desktop"]);
			expect(plugin.settings.reviewQueue.map((item) => item.id).sort()).toEqual(["queue-desktop", "queue-phone"]);
		}
	});

	test("each device keeps its own open conversation when the other device's file arrives", async () => {
		const desktop = (await loadPlugin(shared)).plugin;
		const phone = (await loadPlugin(shared)).plugin;
		await desktop.threads.saveNow(thread("on-desktop", "2026-10-02T10:00:00.000Z", "asked on the desktop"));
		await phone.threads.saveNow(thread("on-phone", "2026-10-02T11:00:00.000Z", "asked on the phone"));

		await deliver(desktop, phone);
		await deliver(phone, desktop);

		expect(desktop.settings.threadStore.activeId).toBe("on-desktop");
		expect(phone.settings.threadStore.activeId).toBe("on-phone");
	});

	test("a save from a device still on 1.11.1 does not reset this device's MCP servers, skill trust or first-run state", async () => {
		const server = { id: "git", label: "Git", transport: "stdio", command: "uvx", args: ["mcp-server-git"], env: {} };
		const { plugin } = await loadPlugin({
			mcp: { enabled: true, servers: [server] },
			skills: { trustedHashes: { "vault:x": "a".repeat(64) } },
			diagrams: { defaultType: "sequence" },
			firstRunCompletedAt: "2026-10-01T09:00:00.000Z",
			lastSeenVersion: "1.12.0"
		});
		expect(plugin.settings.mcp.servers).toHaveLength(1);

		// What 1.11.1 writes: no version number and none of the groups added since.
		const { settingsVersion: _version, skills: _skills, diagrams: _diagrams, mcp: _mcp, firstRunCompletedAt: _first, lastSeenVersion: _seen, ...older } = structuredClone(plugin.storedData ?? plugin.settings) as Record<string, unknown>;
		plugin.storedData = { ...older, reasoningEffort: "high" };
		await plugin.onExternalSettingsChange();

		expect(plugin.settings.reasoningEffort).toBe("high");
		expect(plugin.settings.mcp.enabled).toBe(true);
		expect(plugin.settings.mcp.servers).toHaveLength(1);
		expect(plugin.settings.skills.trustedHashes).toEqual({ "vault:x": "a".repeat(64) });
		expect(plugin.settings.diagrams.defaultType).toBe("sequence");
		expect(plugin.settings.firstRunCompletedAt).toBe("2026-10-01T09:00:00.000Z");
		// The kept groups go back into the file, so the next 1.12.0 device receives them too.
		expect((plugin.storedData as { mcp: { servers: unknown[] } }).mcp.servers).toHaveLength(1);
	});

	test("a conversation deleted on one device comes back from a device that still holds it, until it is deleted there too", async () => {
		const desktop = (await loadPlugin(shared)).plugin;
		const phone = (await loadPlugin(shared)).plugin;

		await desktop.threads.remove("t1");
		await deliver(desktop, phone);
		await deliver(phone, desktop);
		expect(desktop.settings.threadStore.threads.map((item) => item.id)).toEqual(["t1"]);

		await desktop.threads.remove("t1");
		await phone.threads.remove("t1");
		await deliver(desktop, phone);
		await deliver(phone, desktop);
		expect(desktop.settings.threadStore.threads).toEqual([]);
		expect(phone.settings.threadStore.threads).toEqual([]);
	});

	test("a change to the open conversation alone never causes a write", async () => {
		const desktop = (await loadPlugin(shared)).plugin;
		const phone = (await loadPlugin(shared)).plugin;
		await desktop.threads.saveNow(thread("on-desktop", "2026-10-02T10:00:00.000Z", "asked on the desktop"));
		await deliver(desktop, phone);
		await deliver(phone, desktop);

		await phone.threads.markActive("t1");

		expect(await deliver(phone, desktop)).toBe(false);
	});
});
