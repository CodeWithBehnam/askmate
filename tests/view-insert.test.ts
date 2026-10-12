import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Editor, MarkdownView } from "obsidian";
import { assembleDiagram, designFromRecipe, STYLE_RECIPES } from "../src/diagrams";
import { Modal, Notice } from "./support/obsidian-fakes";
import { copyAnswerText, insertAnswerAtRememberedCursor, insertAnswerIntoEditor, insertAnswerWithChoice } from "../src/ui/sidebar/answerShell";
import { describeInserted, planAnswerInsert } from "../src/ui/sidebar/components/insertPlan";
import { askInsertRiskChoice } from "../src/ui/sidebar/components/InsertRiskModal";

interface Cursor {
	line: number;
	ch: number;
}

/** Just enough of an editor: a selection, a cursor, and what was written. */
class FakeEditor {
	writes: string[] = [];
	selection = false;
	cursorTo: Cursor = { line: 4, ch: 12 };
	collapsedTo: Cursor | null = null;

	somethingSelected(): boolean {
		return this.selection;
	}
	getCursor(which?: string): Cursor {
		return which === "to" ? this.cursorTo : { line: 0, ch: 0 };
	}
	setCursor(position: Cursor): void {
		this.collapsedTo = position;
		this.selection = false;
	}
	replaceSelection(text: string): void {
		this.writes.push(text);
	}
}

const asEditor = (editor: FakeEditor): Editor => editor as unknown as Editor;
const answer = (text: string, incompleteReason: string | null = null) => ({ text, incompleteReason });

beforeEach(() => Notice.clear());
afterEach(() => Notice.clear());

describe("planAnswerInsert", () => {
	test("plain Markdown goes in as it is, with blank lines trimmed", () => {
		expect(planAnswerInsert(answer("\n\n# Title\n\nText\n\n"))).toEqual({ kind: "plain", text: "# Title\n\nText" });
	});

	test("nothing to insert for an empty reply or none", () => {
		expect(planAnswerInsert(null)).toEqual({ kind: "none" });
		expect(planAnswerInsert(answer("  \n "))).toEqual({ kind: "none" });
	});

	test("a reply with a remote image or a plugin block is risky, with a safe version and one line per kind", () => {
		const plan = planAnswerInsert(answer("Look\n\n![x](https://evil.example/a.png?d=1)\n\n![y](https://evil.example/b.png)\n"));
		expect(plan.kind).toBe("risky");
		if (plan.kind !== "risky") {
			return;
		}
		expect(plan.original).toContain("https://evil.example/a.png");
		expect(plan.safe).not.toContain("![x](https://evil.example/a.png");
		expect(plan.findings).toHaveLength(1);
		expect(plan.findings[0]).toContain("remote image");
	});

	test("a Templater tag is risky too, because it runs when the note is opened", () => {
		expect(planAnswerInsert(answer("Today is <% tp.date.now() %>")).kind).toBe("risky");
	});

	describe("a reply with a diagram", () => {
		const source = assembleDiagram("flowchart TD\n  A[Start] --> B[End]", "flowchart", designFromRecipe(STYLE_RECIPES[0]!, 7));
		const text = `Here is the flow.\n\n\`\`\`mermaid\n${source}\n\`\`\``;

		test("without the marker the plugin header counts as hidden frontmatter and the fence becomes text", () => {
			const plan = planAnswerInsert(answer(text));
			expect(plan.kind).toBe("risky");
			if (plan.kind === "risky") {
				expect(plan.safe).toContain("```text");
			}
		});

		test("a diagram that drew goes in unchanged, with no questions asked", () => {
			expect(planAnswerInsert({ ...answer(text), diagram: "drawn" })).toEqual({ kind: "plain", text });
		});

		test("a diagram that did not draw is held to the strict rules, so it is downgraded", () => {
			const plan = planAnswerInsert({ ...answer(text), diagram: "fallback" });
			expect(plan.kind).toBe("risky");
			if (plan.kind === "risky") {
				expect(plan.safe).not.toContain("```mermaid");
			}
		});

		test("the marker trusts the plugin header only: other active content in the same reply is still caught", () => {
			const plan = planAnswerInsert({ ...answer(`${text}\n\n![x](https://evil.example/a.png)`), diagram: "drawn" });
			expect(plan.kind).toBe("risky");
			if (plan.kind === "risky") {
				expect(plan.findings.join(" ")).toContain("remote image");
				expect(plan.safe).toContain("```mermaid");
			}
		});

		test("the marker does not let a model-written diagram with its own directives through", () => {
			const hostile = "```mermaid\n%%{init: {\"securityLevel\": \"loose\"}}%%\nflowchart TD\n  A --> B\n```";
			expect(planAnswerInsert({ ...answer(hostile), diagram: "drawn" }).kind).toBe("risky");
		});

		test("the palette command inserts a drawn diagram as it is", () => {
			const editor = new FakeEditor();
			insertAnswerIntoEditor(asEditor(editor), { ...answer(text), diagram: "drawn" });
			expect(editor.writes).toEqual([text]);
		});
	});

	test("the success notice names the note and carries the incomplete warning", () => {
		expect(describeInserted("Notes/A.md", answer("x"))).toBe("Inserted at the cursor in Notes/A.md.");
		expect(describeInserted("", answer("x"), { safeVersion: true })).toBe("Inserted a safe version at the cursor.");
		expect(describeInserted("Notes/A.md", answer("x", "max_output_tokens"))).toContain("may be incomplete");
	});
});

describe("insertAnswerIntoEditor (command palette)", () => {
	test("inserts a clean reply and names the note it was given", () => {
		const editor = new FakeEditor();
		insertAnswerIntoEditor(asEditor(editor), answer("Hello"), { targetLabel: "Notes/A.md" });
		expect(editor.writes).toEqual(["Hello"]);
		expect(Notice.messages).toEqual(["Inserted at the cursor in Notes/A.md."]);
	});

	test("collapses a selection to its end instead of replacing it", () => {
		const editor = new FakeEditor();
		editor.selection = true;
		insertAnswerIntoEditor(asEditor(editor), answer("Hello"));
		expect(editor.collapsedTo).toEqual({ line: 4, ch: 12 });
		expect(editor.writes).toEqual(["Hello"]);
	});

	test("with no way to ask, a risky reply goes in as its safe version and the notice says so", () => {
		const editor = new FakeEditor();
		insertAnswerIntoEditor(asEditor(editor), answer("![x](https://evil.example/a.png)"));
		expect(editor.writes).toHaveLength(1);
		expect(editor.writes[0]).not.toContain("![x](https://evil.example");
		expect(Notice.messages[0]).toContain("safe version");
	});

	test("an empty reply writes nothing and says so", () => {
		const editor = new FakeEditor();
		insertAnswerIntoEditor(asEditor(editor), null);
		expect(editor.writes).toEqual([]);
		expect(Notice.messages).toEqual(["There is no AskMate answer to insert yet."]);
	});
});

describe("insertAnswerWithChoice (sidebar)", () => {
	const risky = answer("Chart: ![x](https://evil.example/a.png)");

	test("a clean reply is not questioned", async () => {
		const editor = new FakeEditor();
		let asked = 0;
		await insertAnswerWithChoice(asEditor(editor), answer("Fine"), () => {
			asked += 1;
			return Promise.resolve("cancel");
		});
		expect(asked).toBe(0);
		expect(editor.writes).toEqual(["Fine"]);
	});

	test("Insert safe version writes the defused text", async () => {
		const editor = new FakeEditor();
		await insertAnswerWithChoice(asEditor(editor), risky, () => Promise.resolve("safe"), { targetLabel: "Notes/A.md" });
		expect(editor.writes[0]).not.toContain("![x](https://evil.example");
		expect(Notice.messages[0]).toBe("Inserted a safe version at the cursor in Notes/A.md.");
	});

	test("Insert anyway writes the reply as it came", async () => {
		const editor = new FakeEditor();
		await insertAnswerWithChoice(asEditor(editor), risky, () => Promise.resolve("anyway"));
		expect(editor.writes).toEqual(["Chart: ![x](https://evil.example/a.png)"]);
	});

	test("Cancel writes nothing", async () => {
		const editor = new FakeEditor();
		await insertAnswerWithChoice(asEditor(editor), risky, () => Promise.resolve("cancel"));
		expect(editor.writes).toEqual([]);
		expect(Notice.messages).toEqual(["Nothing was inserted."]);
	});

	test("the dialog is given the findings", async () => {
		const editor = new FakeEditor();
		let seen: readonly string[] = [];
		await insertAnswerWithChoice(asEditor(editor), risky, (findings) => {
			seen = findings;
			return Promise.resolve("cancel");
		});
		expect(seen[0]).toContain("remote image");
	});
});

describe("insertAnswerAtRememberedCursor", () => {
	const view = (mode: "source" | "preview", editor: FakeEditor, path = "Notes/A.md"): MarkdownView => ({ getMode: () => mode, editor, file: { path } }) as unknown as MarkdownView;
	const app = {} as never;

	test("uses the remembered note when the sidebar has focus and no note is active", async () => {
		const editor = new FakeEditor();
		await insertAnswerAtRememberedCursor(app, null, view("source", editor), answer("Remembered"));
		expect(editor.writes).toEqual(["Remembered"]);
		expect(Notice.messages[0]).toContain("Notes/A.md");
	});

	test("prefers the active note", async () => {
		const active = new FakeEditor();
		const remembered = new FakeEditor();
		await insertAnswerAtRememberedCursor(app, view("source", active, "Active.md"), view("source", remembered), answer("Here"));
		expect(active.writes).toEqual(["Here"]);
		expect(remembered.writes).toEqual([]);
	});

	test("asks the person to click into a note when there is none", async () => {
		await insertAnswerAtRememberedCursor(app, null, null, answer("x"));
		expect(Notice.messages).toEqual(["Click into the note where the answer should go, then try again."]);
	});

	test("does not write in reading view", async () => {
		const editor = new FakeEditor();
		await insertAnswerAtRememberedCursor(app, null, view("preview", editor), answer("x"));
		expect(editor.writes).toEqual([]);
		expect(Notice.messages[0]).toContain("editing mode");
	});
});

describe("copyAnswerText", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "activeWindow");
	afterEach(() => {
		if (original) {
			Object.defineProperty(globalThis, "activeWindow", original);
		} else {
			Reflect.deleteProperty(globalThis, "activeWindow");
		}
	});

	test("copies through the active window, so a popout window works", async () => {
		const copied: string[] = [];
		Object.defineProperty(globalThis, "activeWindow", {
			configurable: true,
			value: { navigator: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } } }
		});
		await copyAnswerText("hello");
		expect(copied).toEqual(["hello"]);
		expect(Notice.messages).toEqual(["Copied"]);
	});

	test("falls back to a notice when the clipboard refuses", async () => {
		Object.defineProperty(globalThis, "activeWindow", {
			configurable: true,
			value: { navigator: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } } }
		});
		await copyAnswerText("hello");
		expect(Notice.messages[0]).toContain("could not copy");
	});
});

describe("the risk dialog", () => {
	afterEach(() => Modal.closeAll());

	function buttons(): HTMLButtonElement[] {
		const modal = Modal.opened.at(-1);
		return Array.from(modal?.contentEl.querySelectorAll<HTMLButtonElement>(".askmate-modal-buttons button") ?? []);
	}

	test("offers the three choices, labelled by what they do", async () => {
		const pending = askInsertRiskChoice({} as never, ["A remote image was turned into a link."]);
		expect(buttons().map((button) => button.textContent)).toEqual(["Insert safe version", "Insert anyway", "Cancel"]);
		expect(Modal.opened.at(-1)?.modalEl.getAttribute("role")).toBe("dialog");
		expect(Modal.opened.at(-1)?.contentEl.textContent).toContain("A remote image was turned into a link.");
		buttons()[0]?.click();
		expect(await pending).toBe("safe");
	});

	test("Insert anyway is its own choice", async () => {
		const pending = askInsertRiskChoice({} as never, ["x"]);
		buttons()[1]?.click();
		expect(await pending).toBe("anyway");
	});

	test("closing the dialog any other way cancels", async () => {
		const pending = askInsertRiskChoice({} as never, ["x"]);
		Modal.closeAll();
		expect(await pending).toBe("cancel");
	});
});
