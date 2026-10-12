import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { getLanguage as importedGetLanguage, Notice as ImportedNotice, Platform as ImportedPlatform } from "obsidian";
import { createFakeApp, FakeEditor, openFakeMarkdownView } from "./fake-app";
import { createFakeEl, createFakeMouseEvent, fireDomEvent, installDomGlobals } from "./fake-dom";
import {
	ButtonComponent,
	Component,
	DropdownComponent,
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	Setting,
	SettingGroup,
	TextComponent,
	ToggleComponent,
	WorkspaceLeaf,
	getLanguage,
	requestUrl,
	requestUrlCalls,
	resetFakePlatform,
	setFakeLanguage,
	setFakePlatform,
	setRequestUrlHandler,
	TFile,
	TFolder
} from "./obsidian-fakes";

/** These tests guard the shared fakes themselves, so a change to them cannot quietly break the wave 2 behavioural tests. */

const restoreGlobals = installDomGlobals();
afterAll(restoreGlobals);
afterEach(() => {
	Notice.clear();
	Modal.closeAll();
	MarkdownRenderer.reset();
	resetFakePlatform();
	setFakeLanguage("en");
	setRequestUrlHandler(null);
});

describe("the obsidian module is the shared fakes", () => {
	test("imports resolve to the same classes the tests use", () => {
		expect(ImportedNotice as unknown).toBe(Notice);
		expect(ImportedPlatform as unknown).toBe(Platform);
		expect(importedGetLanguage()).toBe("en");
	});
});

describe("DOM helpers", () => {
	test("createDiv, createSpan, addClass, setText and empty behave like Obsidian's", () => {
		const root = createFakeEl("div");
		const child = root.createDiv({ cls: "a b", text: "hello", attr: { "data-x": "1" } });
		const span = child.createSpan("note");
		child.addClass("c");
		child.toggleClass("d", true);
		child.toggleClass(["e"], false);
		expect(child.className).toBe("a b c d");
		expect(child.getAttribute("data-x")).toBe("1");
		expect(span.className).toBe("note");
		expect(child.hasClass("c")).toBe(true);
		child.setText("replaced");
		expect(child.textContent).toBe("replaced");
		root.empty();
		expect(root.childNodes.length).toBe(0);
	});

	test("setCssProps sets custom properties and findAll queries descendants", () => {
		const root = createFakeEl("div");
		root.createDiv({ cls: "row" });
		root.createDiv({ cls: "row" });
		root.setCssProps({ "--askmate-status-bar-clearance": "12px" });
		expect(root.style.getPropertyValue("--askmate-status-bar-clearance")).toBe("12px");
		expect(root.findAll(".row")).toHaveLength(2);
	});

	test("events carry targetNode and instanceOf works", () => {
		const root = createFakeEl("div");
		const link = root.createEl("a", { cls: "internal-link", attr: { "data-href": "Note" } });
		const seen: string[] = [];
		root.addEventListener("click", (event) => {
			const target = event.targetNode;
			seen.push(target && target.instanceOf(Element) ? (target as Element).getAttribute("data-href") ?? "" : "");
		});
		fireDomEvent(link, "click");
		expect(seen).toEqual(["Note"]);
	});

	test("activeDocument and activeWindow resolve once installed", () => {
		expect(activeDocument.createElement("div")).toBeDefined();
		expect(activeWindow.document).toBe(activeDocument);
	});
});

describe("Notice, platform and language", () => {
	test("notices are recorded and can be cleared", () => {
		new Notice("one");
		new Notice("two", 1000);
		expect(Notice.messages).toEqual(["one", "two"]);
		Notice.clear();
		expect(Notice.messages).toEqual([]);
	});

	test("platform flags can be switched for a test and restored", () => {
		expect(Platform.isDesktopApp).toBe(true);
		setFakePlatform({ isDesktopApp: false, isMobile: true });
		expect(Platform.isDesktopApp).toBe(false);
		resetFakePlatform();
		expect(Platform.isDesktopApp).toBe(true);
	});

	test("language can be set", () => {
		setFakeLanguage("fa");
		expect(getLanguage()).toBe("fa");
	});
});

describe("Plugin", () => {
	class TestPlugin extends Plugin {
		loadedWith: unknown;

		async onload(): Promise<void> {
			this.loadedWith = await this.loadData();
			this.addCommand({ id: "open", name: "Open", callback: () => undefined });
			this.addRibbonIcon("bot", "Open AskMate", () => undefined);
			this.addStatusBarItem().setText("status");
		}
	}

	test("a fresh install loads null, and saved data round-trips as a copy", async () => {
		const { app } = createFakeApp();
		const plugin = new TestPlugin(app, { id: "askmate", name: "AskMate", version: "1.0.0" });
		await plugin.onload();
		expect(plugin.loadedWith).toBeNull();
		const data = { model: "gpt-5.5" };
		await plugin.saveData(data);
		data.model = "changed";
		expect(await plugin.loadData()).toEqual({ model: "gpt-5.5" });
		expect(plugin.saveCount).toBe(1);
	});

	test("commands, ribbon icons and status items are registered", async () => {
		const { app } = createFakeApp();
		const plugin = new TestPlugin(app, { id: "askmate", name: "AskMate", version: "1.0.0" });
		await plugin.onload();
		expect(Array.from(plugin.commands.keys())).toEqual(["open"]);
		expect(plugin.ribbonIcons[0]?.title).toBe("Open AskMate");
		expect(plugin.statusBarItems[0]?.textContent).toBe("status");
		plugin.removeCommand("open");
		expect(plugin.commands.size).toBe(0);
	});

	test("registered events are removed when the plugin unloads", () => {
		const { app, workspace } = createFakeApp();
		const plugin = new TestPlugin(app, { id: "askmate", name: "AskMate", version: "1.0.0" });
		plugin.load();
		plugin.registerEvent(workspace.on("active-leaf-change", () => undefined));
		expect(workspace.listenerCount("active-leaf-change")).toBe(1);
		plugin.unload();
		expect(workspace.listenerCount("active-leaf-change")).toBe(0);
	});
});

describe("ItemView", () => {
	class TestView extends ItemView {
		opened = 0;
		closed = 0;

		getViewType(): string {
			return "test-view";
		}

		getDisplayText(): string {
			return "Test";
		}

		async onOpen(): Promise<void> {
			this.opened += 1;
			this.contentEl.createDiv({ cls: "body", text: "ready" });
		}

		async onClose(): Promise<void> {
			this.closed += 1;
		}
	}

	test("opens into contentEl and closes cleanly", async () => {
		const view = new TestView(new WorkspaceLeaf({}));
		await view.openForTest();
		expect(view.contentEl.querySelector(".body")?.textContent).toBe("ready");
		expect(view.leaf.view).toBe(view);
		await view.closeForTest();
		expect([view.opened, view.closed]).toEqual([1, 1]);
	});

	test("addAction creates a clickable header action", async () => {
		const view = new TestView(new WorkspaceLeaf({}));
		const clicks: string[] = [];
		const el = view.addAction("plus", "New", () => void clicks.push("new"));
		fireDomEvent(el, "click");
		expect(clicks).toEqual(["new"]);
		expect(view.actions[0]?.title).toBe("New");
	});
});

describe("Modal and Menu", () => {
	class TestModal extends Modal {
		onOpen(): void {
			this.titleEl.setText("Title");
			this.contentEl.createEl("button", { text: "OK" });
		}
	}

	test("open builds the content and close removes it", () => {
		const modal = new TestModal({});
		modal.open();
		expect(Modal.opened).toEqual([modal]);
		expect(modal.titleEl.textContent).toBe("Title");
		expect(modal.contentEl.querySelector("button")?.textContent).toBe("OK");
		modal.close();
		expect(Modal.opened).toEqual([]);
		expect(modal.isOpen).toBe(false);
	});

	test("a menu records its items and runs a click", () => {
		const menu = new Menu();
		const clicked: string[] = [];
		menu.addItem((item) => item.setTitle("Copy").setIcon("copy").onClick(() => void clicked.push("copy")));
		menu.addItem((item) => item.setTitle("Delete").setDisabled(true).onClick(() => void clicked.push("delete")));
		menu.addSeparator();
		menu.showAtMouseEvent(createFakeMouseEvent("contextmenu"));
		menu.items[0]?.click();
		menu.items[1]?.click();
		expect(clicked).toEqual(["copy"]);
		expect(menu.items.map((item) => item.title)).toEqual(["Copy", "Delete"]);
		expect(Menu.lastMenu).toBe(menu);
	});
});

describe("Setting", () => {
	test("builds rows with a name, a description and controls whose handlers can be driven", async () => {
		const container = createFakeEl("div");
		const values: unknown[] = [];
		new Setting(container)
			.setName("Streaming")
			.setDesc("Show text as it arrives")
			.addToggle((toggle) => toggle.setValue(true).onChange((value) => void values.push(value)));
		const row = new Setting(container).setName("Model").addDropdown((dropdown) => dropdown.addOptions({ a: "A", b: "B" }).setValue("a").onChange((value) => void values.push(value)));
		const text = new Setting(container).setName("Key").addText((component) => component.setPlaceholder("sk-").onChange((value) => void values.push(value)));
		const button = new Setting(container).addButton((component) => component.setButtonText("Test").setCta().onClick(() => void values.push("clicked")));

		const rows = container.findAll(".setting-item");
		expect(rows).toHaveLength(4);
		const first = rows[0];
		expect(first?.querySelector(".setting-item-name")?.textContent).toBe("Streaming");

		const toggle = new Setting(createFakeEl("div")).addToggle((component) => component.setValue(false));
		expect(toggle.component(ToggleComponent)?.getValue()).toBe(false);
		row.component(DropdownComponent)?.simulateChange("b");
		await text.component(TextComponent)?.simulateChange("sk-123");
		button.component(ButtonComponent)?.click();
		expect(values).toEqual(["b", "sk-123", "clicked"]);
		expect(row.component(DropdownComponent)?.options).toEqual({ a: "A", b: "B" });
		expect(text.component(TextComponent)?.placeholder).toBe("sk-");
	});

	test("setDisabled reaches the controls and a disabled button does nothing", () => {
		const setting = new Setting(createFakeEl("div")).addButton((component) => component.onClick(() => {
			throw new Error("should not run");
		}));
		setting.setDisabled(true);
		expect(setting.component(ButtonComponent)?.click()).toBeUndefined();
	});

	test("SettingGroup collects its settings under a heading", () => {
		const group = new SettingGroup(createFakeEl("div")).setHeading("Connection");
		group.addSetting((setting) => setting.setName("Provider"));
		group.addSetting((setting) => setting.setName("Key"));
		expect(group.headingText).toBe("Connection");
		expect(group.settings.map((setting) => setting.name)).toEqual(["Provider", "Key"]);
	});
});

describe("MarkdownRenderer and requestUrl", () => {
	test("render records the call and writes the markdown as text", async () => {
		const el = createFakeEl("div");
		await MarkdownRenderer.render({}, "# Hi", el, "Note.md", new Component());
		expect(el.textContent).toBe("# Hi");
		expect(MarkdownRenderer.calls).toHaveLength(1);
		expect(MarkdownRenderer.calls[0]?.sourcePath).toBe("Note.md");
	});

	test("requestUrl fails loudly until a handler is set, then answers and records", async () => {
		await expect(requestUrl({ url: "https://example.com" })).rejects.toThrow("without a test handler");
		setRequestUrlHandler((params) => ({ status: 201, json: { echoed: params.url } }));
		const response = await requestUrl({ url: "https://example.com/x", method: "POST" });
		expect(response.status).toBe(201);
		expect(response.json).toEqual({ echoed: "https://example.com/x" });
		expect(requestUrlCalls.map((call) => call.method)).toEqual(["POST"]);
	});
});

describe("in-memory app", () => {
	test("the vault keeps a real folder tree and raises events for user actions only", async () => {
		const { vault } = createFakeApp();
		const events: string[] = [];
		vault.on("create", (file: TFile) => void events.push(`create ${file.path}`));
		vault.on("rename", (file: TFile, oldPath: string) => void events.push(`rename ${oldPath} -> ${file.path}`));
		vault.on("delete", (file: TFile) => void events.push(`delete ${file.path}`));

		const seeded = vault.add("Projects/Plan/Notes.md", "x");
		expect(events).toEqual([]);
		expect(vault.getFolderByPath("Projects/Plan")?.children).toEqual([seeded]);
		expect(vault.getFolderByPath("Projects")?.children[0]).toBeInstanceOf(TFolder);
		expect(vault.getRoot().children.map((child) => child.path)).toEqual(["Projects"]);
		expect(seeded.parent?.path).toBe("Projects/Plan");
		expect(vault.getFolderByPath("Nowhere")).toBeNull();
		expect(vault.getFolderByPath("Projects/Plan/Notes.md")).toBeNull();

		const created = await vault.create("Projects/Plan/New.md", "y");
		await vault.renameFile(created, "Projects/Plan/Renamed.md");
		await vault.delete(created);
		expect(events).toEqual([
			"create Projects/Plan/New.md",
			"rename Projects/Plan/New.md -> Projects/Plan/Renamed.md",
			"delete Projects/Plan/Renamed.md"
		]);
		expect(vault.getFolderByPath("Projects/Plan")?.children).toEqual([seeded]);
	});

	test("cachedRead is logged and an unknown file fails like a missing one", async () => {
		const { vault } = createFakeApp();
		const note = vault.add("A.md", "alpha");
		expect(await vault.cachedRead(note)).toBe("alpha");
		expect(vault.reads).toEqual(["A.md"]);
		vault.contents.delete("A.md");
		await expect(vault.cachedRead(note)).rejects.toThrow("ENOENT");
	});

	test("secret storage accepts only valid IDs and lists what was stored", () => {
		const { secretStorage } = createFakeApp();
		secretStorage.setSecret("askmate-openai-key", "sk-test");
		expect(secretStorage.getSecret("askmate-openai-key")).toBe("sk-test");
		expect(secretStorage.getSecret("missing")).toBeNull();
		expect(secretStorage.listSecrets()).toEqual(["askmate-openai-key"]);
		expect(() => secretStorage.setSecret("Bad_ID", "x")).toThrow("Invalid secret ID");
	});

	test("the workspace records opened links and the editor tracks a selection", async () => {
		const { workspace, vault } = createFakeApp();
		await workspace.openLinkText("Vendors", "Daily/Today.md", true);
		expect(workspace.openedLinks).toEqual([{ linktext: "Vendors", sourcePath: "Daily/Today.md", newLeaf: true }]);
		const view = openFakeMarkdownView(workspace, vault.add("A.md", "one two three"), "one two three");
		view.editor.select("two");
		expect(view.editor.getSelection()).toBe("two");
		view.editor.replaceSelection("2");
		expect(view.editor.getValue()).toBe("one 2 three");
		expect(workspace.getLeavesOfType("markdown")).toHaveLength(1);
		expect(new FakeEditor("a\nb").offsetToPos(3)).toEqual({ line: 1, ch: 1 });
	});

	test("layout-ready callbacks run immediately, or when the layout becomes ready", () => {
		const { workspace } = createFakeApp();
		const calls: string[] = [];
		workspace.onLayoutReady(() => void calls.push("now"));
		workspace.layoutReady = false;
		workspace.onLayoutReady(() => void calls.push("later"));
		expect(calls).toEqual(["now"]);
		workspace.markLayoutReady();
		expect(calls).toEqual(["now", "later"]);
	});

	test("app.setting records where the plugin asked to go", () => {
		const { app, settingCalls } = createFakeApp();
		const setting = (app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting;
		setting.open();
		setting.openTabById("askmate");
		expect(settingCalls).toEqual(["open", "tab:askmate"]);
	});
});
