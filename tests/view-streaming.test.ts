import { describe, expect, test } from "bun:test";
import {
	DIAGRAM_STREAM_RENDER_MS,
	isRenderCurrent,
	planStreamRender,
	STREAM_RENDER_MS
} from "../src/ui/sidebar/components/streamingDiagram";

const FENCE = "```";

describe("planStreamRender", () => {
	test("a reply with no diagram renders as it is, at the normal rate", () => {
		const plan = planStreamRender("Some **text** and a list:\n- one\n- two");
		expect(plan).toEqual({ settled: "Some **text** and a list:\n- one\n- two", drawing: false, hasDiagram: false });
	});

	test("an open diagram fence stops at the fence and says a diagram is being drawn", () => {
		const text = `Here is the flow.\n\n${FENCE}mermaid\nflowchart TD\n  A --> B`;
		const plan = planStreamRender(text);
		expect(plan.drawing).toBe(true);
		expect(plan.settled).toBe("Here is the flow.\n");
		expect(plan.hasDiagram).toBe(false);
	});

	test("every partial state of an open fence settles to the same text, so the diagram is not redrawn", () => {
		const head = "Here is the flow.\n\n";
		const lines = ["flowchart TD", "  A --> B", "  B --> C"];
		const settled = new Set<string>();
		for (let count = 0; count <= lines.length; count += 1) {
			const plan = planStreamRender(`${head}${FENCE}mermaid\n${lines.slice(0, count).join("\n")}`);
			expect(plan.drawing).toBe(true);
			settled.add(plan.settled);
		}
		expect(settled.size).toBe(1);
	});

	test("once the fence closes the diagram is part of the settled text, and redraws are slowed down", () => {
		const text = `Intro\n\n${FENCE}mermaid\nflowchart TD\n  A --> B\n${FENCE}\n\nAfter the diagram.`;
		const plan = planStreamRender(text);
		expect(plan.drawing).toBe(false);
		expect(plan.hasDiagram).toBe(true);
		expect(plan.settled).toBe(text);
	});

	test("a code block that is not a diagram is left alone", () => {
		const plan = planStreamRender(`${FENCE}js\nconst a = 1;`);
		expect(plan.drawing).toBe(false);
	});

	test("the word mermaid in prose is not a diagram", () => {
		expect(planStreamRender("A mermaid sat on a rock.")).toMatchObject({ drawing: false, hasDiagram: false });
	});
});

describe("redraw rules", () => {
	test("nothing is redrawn when the settled text has not changed", () => {
		const plan = planStreamRender("Same text");
		expect(isRenderCurrent(plan, "Same text")).toBe(true);
		expect(isRenderCurrent(plan, "Other")).toBe(false);
		expect(isRenderCurrent(plan, undefined)).toBe(false);
	});

	test("a finished diagram makes redraws less frequent", () => {
		const open = planStreamRender("Plain text");
		const closed = planStreamRender(`${FENCE}mermaid\nflowchart TD\n  A --> B\n${FENCE}\nTail`);
		expect(STREAM_RENDER_MS).toBeLessThan(DIAGRAM_STREAM_RENDER_MS);
		expect(open.hasDiagram).toBe(false);
		expect(closed.hasDiagram).toBe(true);
	});
});
