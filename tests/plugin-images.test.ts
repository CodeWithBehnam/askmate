import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import type { AskRequest, ImageAskMateResult, SelectionIdentity } from "../src/shared/types";
import { createFakeApp, FakeEditor, leafFor, type FakeApp, type Position } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";
import { MarkdownView, Modal, Notice, TFile } from "./support/obsidian-fakes";

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

class TestEditor extends FakeEditor {
	replaceRange(text: string, from: Position, to?: Position): void {
		const start = this.posToOffset(from);
		const end = to ? this.posToOffset(to) : start;
		this.value = this.value.slice(0, start) + text + this.value.slice(end);
	}
}

interface TestPlugin extends AskMatePlugin {
	storedData: unknown;
}

async function loadPlugin(): Promise<{ plugin: TestPlugin; fake: FakeApp }> {
	const fake = createFakeApp();
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
	plugin.storedData = {};
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake };
}

function answerDialogs(): { stop: () => void } {
	const timer = setInterval(() => {
		for (const modal of [...Modal.opened]) {
			modal.contentEl.querySelector<HTMLElement>("button.mod-cta")?.click();
		}
	}, 1);
	return { stop: () => clearInterval(timer) };
}

const RESULT: ImageAskMateResult = {
	kind: "image",
	model: "gpt-image-2",
	promptPlan: { prompt: "p", planningModel: "m", status: "completed", fallbackReason: null },
	image: { mimeType: "image/png", base64: "AAAA", prompt: "p", revisedPrompt: null, createdAt: "2026-10-01T00:00:00.000Z", savedImagePath: null }
};

function makeRequest(file: TFile, content: string, selection?: SelectionIdentity): AskRequest {
	return {
		context: { content, file, source: selection ? "Selected text" : "Current note", selectionIdentity: selection ?? null, attachments: [] },
		question: "Make an image",
		title: "Image",
		evidenceSources: [],
		metadata: { outputMode: "chat" }
	} as unknown as AskRequest;
}

function stubImageSave(plugin: TestPlugin, onSave: () => void = () => undefined): void {
	Object.assign(plugin, {
		saveGeneratedImage: () => {
			onSave();
			return Promise.resolve(new TFile("AskMate/Images/pic.png"));
		}
	});
}

function selectionIn(note: string, text: string, path: string): SelectionIdentity {
	const startOffset = note.indexOf(text);
	return { text, startOffset, endOffset: startOffset + text.length, prefix: note.slice(Math.max(0, startOffset - 20), startOffset), suffix: note.slice(startOffset + text.length, startOffset + text.length + 20), sourcePath: path };
}

describe("inserting a generated image", () => {
	test("an open note gets the embed after the paragraph at the cursor, never in the middle of a sentence", async () => {
		const { plugin, fake } = await loadPlugin();
		const note = "First sentence. Second sentence.\n\nNext paragraph.\n";
		const file = fake.vault.add("Notes/Open.md", note);
		const editor = new TestEditor(note);
		editor.selectionStart = 5;
		editor.selectionEnd = 5;
		fake.workspace.leaves.push(leafFor(new MarkdownView(editor, file), "markdown", file.path));
		stubImageSave(plugin);
		const dialogs = answerDialogs();

		const outcome = await plugin.applyImageToContext(makeRequest(file, note), RESULT);
		dialogs.stop();

		expect(outcome.status).toBe("applied");
		expect(editor.value).toBe("First sentence. Second sentence.\n\n![[AskMate/Images/pic.png]]\n\nNext paragraph.\n");
	});

	test("a note that is not open takes the embed after the selected text, through the vault", async () => {
		const { plugin, fake } = await loadPlugin();
		const note = "Intro.\n\nThe chosen words are here and more follow.\n\nOutro.\n";
		const file = fake.vault.add("Notes/Closed.md", note);
		stubImageSave(plugin);
		const dialogs = answerDialogs();

		const outcome = await plugin.applyImageToContext(makeRequest(file, "The chosen words", selectionIn(note, "The chosen words", file.path)), RESULT);
		dialogs.stop();

		expect(outcome.status).toBe("applied");
		expect(fake.vault.contents.get(file.path)).toBe("Intro.\n\nThe chosen words are here and more follow.\n\n![[AskMate/Images/pic.png]]\n\nOutro.\n");
	});

	test("a closed note with Windows line endings keeps them around the embed", async () => {
		const { plugin, fake } = await loadPlugin();
		const note = "One.\r\n\r\nTwo.\r\n";
		const file = fake.vault.add("Notes/Crlf.md", note);
		stubImageSave(plugin);
		const dialogs = answerDialogs();

		await plugin.applyImageToContext(makeRequest(file, "One. Two."), RESULT);
		dialogs.stop();

		const text = fake.vault.contents.get(file.path) ?? "";
		expect(text).toContain("![[AskMate/Images/pic.png]]");
		expect(text.replace(/\r\n/g, "")).not.toContain("\n");
	});

	test("if the note is closed while the image is saved, the embed still goes into that note and not into another", async () => {
		const { plugin, fake } = await loadPlugin();
		const noteA = "Alpha paragraph.\n";
		const noteB = "Beta paragraph.\n";
		const fileA = fake.vault.add("Notes/A.md", noteA);
		const fileB = fake.vault.add("Notes/B.md", noteB);
		const editorA = new TestEditor(noteA);
		const editorB = new TestEditor(noteB);
		const leafA = leafFor(new MarkdownView(editorA, fileA), "markdown", fileA.path);
		fake.workspace.leaves.push(leafA, leafFor(new MarkdownView(editorB, fileB), "markdown", fileB.path));
		// Saving takes time; meanwhile the person closes note A and keeps working in note B.
		stubImageSave(plugin, () => {
			fake.workspace.leaves.splice(fake.workspace.leaves.indexOf(leafA), 1);
		});
		const dialogs = answerDialogs();

		const outcome = await plugin.applyImageToContext(makeRequest(fileA, noteA), RESULT);
		dialogs.stop();

		expect(outcome.status).toBe("applied");
		expect(editorB.value).toBe(noteB);
		expect(fake.vault.contents.get(fileA.path)).toContain("![[AskMate/Images/pic.png]]");
		expect(fake.vault.contents.get(fileB.path)).toBe(noteB);
	});

	test("a note that ends inside an unclosed code block keeps its text, and the result says the image was not inserted", async () => {
		const { plugin, fake } = await loadPlugin();
		const note = "Intro\n\n```js\nunfinished\n";
		const file = fake.vault.add("Notes/Fence.md", note);
		stubImageSave(plugin);
		const dialogs = answerDialogs();

		const outcome = await plugin.applyImageToContext(makeRequest(file, "Intro"), RESULT);
		dialogs.stop();

		expect(outcome.status).toBe("partial");
		expect(outcome.message).toContain("never closed");
		expect(fake.vault.contents.get(file.path)).toBe(note);
	});

	test("a selection that moved before the insert is reported as partial and nothing is written", async () => {
		const { plugin, fake } = await loadPlugin();
		const note = "Intro. The chosen words are here.\n";
		const file = fake.vault.add("Notes/Moved.md", note);
		const identity = selectionIn(note, "The chosen words", file.path);
		stubImageSave(plugin, () => {
			fake.vault.contents.set(file.path, "Something else entirely.\n");
		});
		const dialogs = answerDialogs();

		const outcome = await plugin.applyImageToContext(makeRequest(file, "The chosen words", identity), RESULT);
		dialogs.stop();

		expect(outcome.status).toBe("partial");
		expect(outcome.artifactPaths).toEqual(["AskMate/Images/pic.png"]);
		expect(fake.vault.contents.get(file.path)).toBe("Something else entirely.\n");
	});
});
