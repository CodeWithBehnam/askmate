import { describe, expect, test } from "bun:test";
import {
	applyDeterministicRepairs,
	closeSubgraphs,
	escapeSequenceText,
	fixPieValues,
	fixSingleArrows,
	normaliseText,
	quoteFlowchartLabels,
	renameReservedEnd
} from "../src/diagrams/repair";

const code = (...points: number[]): string => String.fromCharCode(...points);

describe("normaliseText", () => {
	test("maps typographic quotes and no-break spaces to ASCII", () => {
		expect(normaliseText(`A[${code(0x201c)}Hi${code(0x201d)}] ${code(0x2018)}x${code(0x2019)}${code(0xa0)}y`)).toBe(`A["Hi"] 'x' y`);
		expect(normaliseText(`${code(0x201e)}low${code(0x201d)}`)).toBe('"low"');
	});

	test("removes zero-width and bidi control characters", () => {
		expect(normaliseText(`A${code(0x200b)}B${code(0x202e)}C${code(0xfeff)}D${code(0x2060)}`)).toBe("ABCD");
	});

	test("leaves ordinary text alone", () => {
		expect(normaliseText("flowchart TD\n  A[Cafe] --> B")).toBe("flowchart TD\n  A[Cafe] --> B");
	});
});

describe("quoteFlowchartLabels", () => {
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["parentheses in a rectangle", "flowchart TD\n  A[Process (step 1)] --> B", 'flowchart TD\n  A["Process (step 1)"] --> B'],
		["parentheses in an edge label", "flowchart TD\n  A -->|Yes (maybe)| B", 'flowchart TD\n  A -->|"Yes (maybe)"| B'],
		["an inner double quote", 'flowchart TD\n  A["Say "hi" now"] --> B', 'flowchart TD\n  A["Say #quot;hi#quot; now"] --> B'],
		["cylinder and stadium shapes that need no quotes", "flowchart TD\n  A[(DB)] --> B([Plain])", "flowchart TD\n  A[(DB)] --> B([Plain])"],
		["a stadium and a subroutine with risky text", "flowchart TD\n  A([Start (now)]) --> B[[Sub @ task]]", 'flowchart TD\n  A(["Start (now)"]) --> B[["Sub @ task"]]'],
		["a rhombus with a colon and pipe", "flowchart TD\n  A{Pick: yes|no} --> B", 'flowchart TD\n  A{"Pick: yes|no"} --> B'],
		["a leading slash", "flowchart TD\n  A[/path] --> B", 'flowchart TD\n  A["/path"] --> B'],
		["a markdown list start", "flowchart TD\n  A[1. First] --> B", 'flowchart TD\n  A["1. First"] --> B'],
		["labels that are already quoted", 'flowchart TD\n  A["Fine (really)"] --> B', 'flowchart TD\n  A["Fine (really)"] --> B'],
		["a markdown string label", 'flowchart TD\n  A["`**bold** (x)`"] --> B', 'flowchart TD\n  A["`**bold** (x)`"] --> B'],
		["plain labels", "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C", "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C"],
		["a subgraph title", "flowchart TD\n  subgraph one [Phase (1)]\n    A --> B\n  end", 'flowchart TD\n  subgraph one ["Phase (1)"]\n    A --> B\n  end'],
		["classDef and style lines", "flowchart TD\n  classDef a fill:#fff,stroke:#000\n  style A fill:#fff", "flowchart TD\n  classDef a fill:#fff,stroke:#000\n  style A fill:#fff"],
		["a chained edge", "flowchart TD\n  A[x (1)] --> B[y (2)] --> C", 'flowchart TD\n  A["x (1)"] --> B["y (2)"] --> C'],
		["role tags after a label", "flowchart TD\n  A[Cost (est)]:::primary --> B", 'flowchart TD\n  A["Cost (est)"]:::primary --> B']
	];

	test.each(cases)("%s", (_name, input, expected) => {
		expect(quoteFlowchartLabels(input)).toBe(expected);
	});

	test("is idempotent", () => {
		cases.forEach(([, input]) => {
			const once = quoteFlowchartLabels(input);
			expect(quoteFlowchartLabels(once)).toBe(once);
		});
	});
});

describe("renameReservedEnd", () => {
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["a bare target", "flowchart TD\n  start --> end", 'flowchart TD\n  start --> End_["end"]'],
		["a labelled target keeps its label", "flowchart TD\n  A --> end[Finish]", "flowchart TD\n  A --> End_[Finish]"],
		["a target after an edge label", "flowchart TD\n  A -->|done| end", 'flowchart TD\n  A -->|done| End_["end"]'],
		["a dotted arrow", "flowchart TD\n  A -.-> end", 'flowchart TD\n  A -.-> End_["end"]'],
		["a source", "flowchart TD\n  end --> B", 'flowchart TD\n  End_["end"] --> B'],
		["a chained target", "flowchart TD\n  A --> end --> B", 'flowchart TD\n  A --> End_["end"] --> B'],
		["the real subgraph closer", "flowchart TD\n  subgraph one\n    A --> B\n  end", "flowchart TD\n  subgraph one\n    A --> B\n  end"],
		["a longer word that starts with end", "flowchart TD\n  A --> endpoint\n  A --> end_state", "flowchart TD\n  A --> endpoint\n  A --> end_state"],
		["the word end inside a label", 'flowchart TD\n  A["the end"] --> B[end of line]', 'flowchart TD\n  A["the end"] --> B[end of line]']
	];

	test.each(cases)("%s", (_name, input, expected) => {
		expect(renameReservedEnd(input)).toBe(expected);
	});
});

describe("fixSingleArrows", () => {
	test("turns -> into -->", () => {
		expect(fixSingleArrows("flowchart TD\n  A -> B")).toBe("flowchart TD\n  A --> B");
		expect(fixSingleArrows("flowchart TD\n  A -> B -> C")).toBe("flowchart TD\n  A --> B --> C");
	});

	test("leaves real arrows and arrows inside labels alone", () => {
		const untouched = ["flowchart TD\n  A --> B", 'flowchart TD\n  A["step 1 -> step 2"] --> B', "flowchart TD\n  A[go -> there] --> B", "flowchart TD\n  A -->|x -> y| B"];
		untouched.forEach((input) => expect(fixSingleArrows(input)).toBe(input));
	});
});

describe("closeSubgraphs", () => {
	test("adds the missing end lines", () => {
		expect(closeSubgraphs("flowchart TD\n  subgraph one\n    A --> B")).toBe("flowchart TD\n  subgraph one\n    A --> B\nend");
		expect(closeSubgraphs("flowchart TD\n  subgraph a\n  subgraph b\n    A --> B\n  end")).toBe("flowchart TD\n  subgraph a\n  subgraph b\n    A --> B\n  end\nend");
	});

	test("leaves balanced and over-closed diagrams alone", () => {
		const balanced = "flowchart TD\n  subgraph one\n    A\n  end";
		expect(closeSubgraphs(balanced)).toBe(balanced);
		expect(closeSubgraphs("flowchart TD\n  A\n  end")).toBe("flowchart TD\n  A\n  end");
	});
});

describe("escapeSequenceText", () => {
	test("escapes semicolons and hashes in messages and notes", () => {
		expect(escapeSequenceText("sequenceDiagram\n  A->>B: first; second #5\n  Note over A,B: a;b")).toBe(
			"sequenceDiagram\n  A->>B: first#59; second #35;5\n  Note over A,B: a#59;b"
		);
	});

	test("keeps existing entities", () => {
		expect(escapeSequenceText("sequenceDiagram\n  A->>B: done #35; already")).toBe("sequenceDiagram\n  A->>B: done #35; already");
		expect(escapeSequenceText("sequenceDiagram\n  A->>B: caf#233; ok")).toBe("sequenceDiagram\n  A->>B: caf#233; ok");
	});

	test("does not touch non-message lines", () => {
		const untouched = "sequenceDiagram\n  participant A as User; admin\n  autonumber";
		expect(escapeSequenceText(untouched)).toBe(untouched);
	});

	test("is idempotent", () => {
		const once = escapeSequenceText("sequenceDiagram\n  A->>B: x; y #1");
		expect(escapeSequenceText(once)).toBe(once);
	});
});

describe("fixPieValues", () => {
	test("strips percent signs and thousands separators", () => {
		expect(fixPieValues('pie\n  "A" : 50%\n  "B" : 1,200\n  "C" : 3.5 %')).toBe('pie\n  "A" : 50\n  "B" : 1200\n  "C" : 3.5');
	});

	test("leaves other lines alone", () => {
		const same = 'pie showData title Pets 50%\n  "Dogs" : 40';
		expect(fixPieValues(same)).toBe(same);
	});
});

describe("applyDeterministicRepairs", () => {
	test("runs the steps for the family and reports which ones changed the text", () => {
		const result = applyDeterministicRepairs(`flowchart TD\n  A[${code(0x201c)}Cost (est)${code(0x201d)}] -> B\n  B --> end`, "flowchart");
		expect(result.applied).toEqual(["normalise-text", "flowchart-arrows", "flowchart-reserved-end"]);
		expect(result.body).toBe('flowchart TD\n  A["Cost (est)"] --> B\n  B --> End_["end"]');
	});

	test("arrows are fixed before end is renamed, so `B -> end` is fully repaired", () => {
		expect(applyDeterministicRepairs("flowchart TD\n  B -> end", "flowchart").body).toBe('flowchart TD\n  B --> End_["end"]');
	});

	test("family steps never run on another family", () => {
		const sequence = "sequenceDiagram\n  A -> B: x (y)";
		expect(applyDeterministicRepairs(sequence, "sequence").applied).toEqual([]);
		expect(applyDeterministicRepairs("pie\n  \"A\" : 5%", "flowchart").applied).toEqual([]);
		expect(applyDeterministicRepairs("flowchart TD\n  A[x (1)] --> B", null).applied).toEqual([]);
	});

	test("text normalisation runs even when the family is unknown", () => {
		expect(applyDeterministicRepairs(`x ${code(0x201c)}y${code(0x201d)}`, null)).toEqual({ body: 'x "y"', applied: ["normalise-text"] });
	});

	test("is idempotent", () => {
		const once = applyDeterministicRepairs("flowchart TD\n  A[x (1)] -> end\n  subgraph s\n    B", "flowchart").body;
		expect(applyDeterministicRepairs(once, "flowchart").applied).toEqual([]);
	});

	test("hostile long lines finish quickly and are left alone", () => {
		const long = `flowchart TD\n  A[${"(x) ".repeat(20000)}] --> B\n  ${"a -> ".repeat(20000)}b`;
		const sequence = `sequenceDiagram\n  ${"A->>B ".repeat(20000)}`;
		const started = performance.now();
		const result = applyDeterministicRepairs(long, "flowchart");
		applyDeterministicRepairs(sequence, "sequence");
		expect(performance.now() - started).toBeLessThan(1500);
		expect(result.body).toBe(long);
	});
});
