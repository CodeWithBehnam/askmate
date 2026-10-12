import { describe, expect, test } from "bun:test";
import { assembleDiagram, buildConfig, buildHeader, CLASSDEF_KINDS, frontmatter, KIND_KEYWORDS, typeExtras } from "../src/diagrams/header";
import { classDefLines, makePalette } from "../src/diagrams/palette";
import { DIAGRAM_KINDS, type Design, type Kind } from "../src/diagrams/types";

// Golden strings for the header the plugin prepends, one entry per diagram family. If a colour or variable changes on purpose,
// regenerate the table from buildConfig and review the diff: it is the visible design of every diagram AskMate draws.

const DESIGN: Design = { hue: 200, mood: "pastel", accentOffset: 150, look: "classic", seed: 1 };

type Json = Readonly<Record<string, unknown>>;

/** themeVariables every family shares, for DESIGN. */
const BASE_THEME_VARIABLES: Json = {
	primaryColor: "#e4f4fc",
	primaryTextColor: "#143343",
	primaryBorderColor: "#2483b2",
	secondaryColor: "#fce4e8",
	secondaryTextColor: "#43141c",
	secondaryBorderColor: "#b2243c",
	tertiaryColor: "#f4f9fb",
	tertiaryTextColor: "#143343",
	tertiaryBorderColor: "#2483b2",
	lineColor: "#21698d",
	textColor: "#143343",
	edgeLabelBackground: "#ffffff"
};

const GOLDEN_CLASSDEFS = [
	"classDef primary fill:#e4f4fc,stroke:#2483b2,color:#143343,stroke-width:2px",
	"classDef accent fill:#fce4e8,stroke:#b2243c,color:#43141c,stroke-width:2px",
	"classDef success fill:#e4fcee,stroke:#1f9952,color:#144327,stroke-width:2px",
	"classDef warn fill:#fcf3e4,stroke:#b27e24,color:#433214,stroke-width:2px",
	"classDef danger fill:#fce5e4,stroke:#b22e24,color:#431714,stroke-width:2px",
	"classDef muted fill:#f1f3f3,stroke:#7b888e,color:#464f53,stroke-dasharray:4 3",
	"classDef ink fill:#152228,stroke:#152228,color:#f8fafc,stroke-width:2px"
].join("\n");

/** What each family adds on top of the shared header: its own themeVariables, and any non-theme config. */
const GOLDEN: Readonly<Record<Kind, { readonly vars: string; readonly config: string }>> = {
	flowchart: {
		vars: "{}",
		config: "{}"
	},
	sequence: {
		vars: "{\"actorBkg\":\"#e4f4fc\",\"actorBorder\":\"#2483b2\",\"actorTextColor\":\"#143343\",\"actorLineColor\":\"#21698d\",\"signalColor\":\"#21698d\",\"signalTextColor\":\"#143343\",\"labelBoxBkgColor\":\"#fce4e8\",\"labelBoxBorderColor\":\"#b2243c\",\"labelTextColor\":\"#43141c\",\"loopTextColor\":\"#143343\",\"noteBkgColor\":\"#fcf3e4\",\"noteBorderColor\":\"#b27e24\",\"noteTextColor\":\"#433214\",\"activationBkgColor\":\"#fce4e8\",\"activationBorderColor\":\"#b2243c\",\"sequenceNumberColor\":\"#ffffff\"}",
		config: "{}"
	},
	class: {
		vars: "{}",
		config: "{}"
	},
	state: {
		vars: "{}",
		config: "{}"
	},
	er: {
		vars: "{}",
		config: "{}"
	},
	gantt: {
		vars: "{\"taskBkgColor\":\"#e4f4fc\",\"taskBorderColor\":\"#2483b2\",\"taskTextColor\":\"#143343\",\"taskTextDarkColor\":\"#143343\",\"taskTextOutsideColor\":\"#143343\",\"activeTaskBkgColor\":\"#fce4e8\",\"activeTaskBorderColor\":\"#b2243c\",\"doneTaskBkgColor\":\"#f1f3f3\",\"doneTaskBorderColor\":\"#7b888e\",\"critBkgColor\":\"#fce5e4\",\"critBorderColor\":\"#b22e24\",\"gridColor\":\"#7b888e\",\"sectionBkgColor\":\"#f4f9fb\",\"altSectionBkgColor\":\"#ffffff\",\"sectionBkgColor2\":\"#f4f9fb\",\"todayLineColor\":\"#b22e24\",\"titleColor\":\"#143343\"}",
		config: "{}"
	},
	pie: {
		vars: "{\"pie1\":\"#277ba5\",\"pie2\":\"#be2d63\",\"pie3\":\"#27841f\",\"pie4\":\"#4b2dbe\",\"pie5\":\"#a56627\",\"pie6\":\"#1d7c68\",\"pie7\":\"#be2db2\",\"pie8\":\"#587c1d\",\"pie9\":\"#2d5dbe\",\"pie10\":\"#be2d32\",\"pie11\":\"#1f8438\",\"pie12\":\"#7c2dbe\",\"pieStrokeColor\":\"#ffffff\",\"pieStrokeWidth\":\"2px\",\"pieOuterStrokeWidth\":\"0px\",\"pieOpacity\":\"1\",\"pieSectionTextColor\":\"#ffffff\",\"pieLegendTextColor\":\"#143343\",\"pieTitleTextColor\":\"#143343\"}",
		config: "{}"
	},
	quadrant: {
		vars: "{\"quadrant1Fill\":\"#e4f4fc\",\"quadrant2Fill\":\"#fce4e8\",\"quadrant3Fill\":\"#f1f3f3\",\"quadrant4Fill\":\"#e4fcee\",\"quadrant1TextFill\":\"#143343\",\"quadrant2TextFill\":\"#43141c\",\"quadrant3TextFill\":\"#464f53\",\"quadrant4TextFill\":\"#144327\",\"quadrantPointFill\":\"#2483b2\",\"quadrantPointTextFill\":\"#143343\",\"quadrantXAxisTextFill\":\"#143343\",\"quadrantYAxisTextFill\":\"#143343\",\"quadrantTitleFill\":\"#143343\",\"quadrantInternalBorderStrokeFill\":\"#2483b2\",\"quadrantExternalBorderStrokeFill\":\"#2483b2\"}",
		config: "{}"
	},
	mindmap: {
		vars: "{\"cScale0\":\"#2584b3\",\"cScale1\":\"#d8427b\",\"cScale2\":\"#278f1d\",\"cScale3\":\"#8168e0\",\"cScale4\":\"#b26b24\",\"cScale5\":\"#1d8c74\",\"cScale6\":\"#d42dc6\",\"cScale7\":\"#5f871c\",\"cScale8\":\"#4878da\",\"cScale9\":\"#d9484e\",\"cScale10\":\"#1d8f3a\",\"cScale11\":\"#a159dd\",\"cScaleLabel0\":\"#1a1a1a\",\"cScaleLabel1\":\"#1a1a1a\",\"cScaleLabel2\":\"#1a1a1a\",\"cScaleLabel3\":\"#1a1a1a\",\"cScaleLabel4\":\"#1a1a1a\",\"cScaleLabel5\":\"#1a1a1a\",\"cScaleLabel6\":\"#1a1a1a\",\"cScaleLabel7\":\"#1a1a1a\",\"cScaleLabel8\":\"#1a1a1a\",\"cScaleLabel9\":\"#1a1a1a\",\"cScaleLabel10\":\"#1a1a1a\",\"cScaleLabel11\":\"#1a1a1a\",\"cScaleInv0\":\"#2584b3\",\"cScaleInv1\":\"#d8427b\",\"cScaleInv2\":\"#278f1d\",\"cScaleInv3\":\"#8168e0\",\"cScaleInv4\":\"#b26b24\",\"cScaleInv5\":\"#1d8c74\",\"cScaleInv6\":\"#d42dc6\",\"cScaleInv7\":\"#5f871c\",\"cScaleInv8\":\"#4878da\",\"cScaleInv9\":\"#d9484e\",\"cScaleInv10\":\"#1d8f3a\",\"cScaleInv11\":\"#a159dd\"}",
		config: "{}"
	},
	timeline: {
		vars: "{\"cScale0\":\"#277ba5\",\"cScale1\":\"#be2d63\",\"cScale2\":\"#27841f\",\"cScale3\":\"#4b2dbe\",\"cScale4\":\"#a56627\",\"cScale5\":\"#1d7c68\",\"cScale6\":\"#be2db2\",\"cScale7\":\"#587c1d\",\"cScale8\":\"#2d5dbe\",\"cScale9\":\"#be2d32\",\"cScale10\":\"#1f8438\",\"cScale11\":\"#7c2dbe\",\"cScaleLabel0\":\"#ffffff\",\"cScaleLabel1\":\"#ffffff\",\"cScaleLabel2\":\"#ffffff\",\"cScaleLabel3\":\"#ffffff\",\"cScaleLabel4\":\"#ffffff\",\"cScaleLabel5\":\"#ffffff\",\"cScaleLabel6\":\"#ffffff\",\"cScaleLabel7\":\"#ffffff\",\"cScaleLabel8\":\"#ffffff\",\"cScaleLabel9\":\"#ffffff\",\"cScaleLabel10\":\"#ffffff\",\"cScaleLabel11\":\"#ffffff\",\"cScaleInv0\":\"#277ba5\",\"cScaleInv1\":\"#be2d63\",\"cScaleInv2\":\"#27841f\",\"cScaleInv3\":\"#4b2dbe\",\"cScaleInv4\":\"#a56627\",\"cScaleInv5\":\"#1d7c68\",\"cScaleInv6\":\"#be2db2\",\"cScaleInv7\":\"#587c1d\",\"cScaleInv8\":\"#2d5dbe\",\"cScaleInv9\":\"#be2d32\",\"cScaleInv10\":\"#1f8438\",\"cScaleInv11\":\"#7c2dbe\"}",
		config: "{}"
	},
	gitGraph: {
		vars: "{\"git0\":\"#277ba5\",\"git1\":\"#be2d63\",\"git2\":\"#27841f\",\"git3\":\"#4b2dbe\",\"git4\":\"#a56627\",\"git5\":\"#1d7c68\",\"git6\":\"#be2db2\",\"git7\":\"#587c1d\",\"gitBranchLabel0\":\"#ffffff\",\"gitBranchLabel1\":\"#ffffff\",\"gitBranchLabel2\":\"#ffffff\",\"gitBranchLabel3\":\"#ffffff\",\"gitBranchLabel4\":\"#ffffff\",\"gitBranchLabel5\":\"#ffffff\",\"gitBranchLabel6\":\"#ffffff\",\"gitBranchLabel7\":\"#ffffff\",\"commitLabelColor\":\"#143343\",\"commitLabelBackground\":\"#f4f9fb\",\"tagLabelColor\":\"#143343\",\"tagLabelBackground\":\"#e4f4fc\",\"tagLabelBorder\":\"#2483b2\"}",
		config: "{}"
	},
	sankey: {
		vars: "{}",
		config: "{\"sankey\":{\"linkColor\":\"gradient\",\"nodeAlignment\":\"justify\",\"showValues\":true}}"
	},
	xychart: {
		vars: "{\"xyChart\":{\"plotColorPalette\":\"#277ba5,#be2d63,#27841f,#4b2dbe,#a56627,#1d7c68\",\"backgroundColor\":\"transparent\",\"titleColor\":\"#143343\",\"xAxisLabelColor\":\"#143343\",\"xAxisTitleColor\":\"#143343\",\"yAxisLabelColor\":\"#143343\",\"yAxisTitleColor\":\"#143343\",\"xAxisLineColor\":\"#2483b2\",\"yAxisLineColor\":\"#2483b2\",\"xAxisTickColor\":\"#2483b2\",\"yAxisTickColor\":\"#2483b2\"}}",
		config: "{}"
	},
	block: {
		vars: "{}",
		config: "{}"
	},
	packet: {
		vars: "{}",
		config: "{}"
	},
	kanban: {
		vars: "{\"primaryTextColor\":\"#152832\",\"textColor\":\"#152832\",\"cScale0\":\"#b1dcf1\",\"cScale1\":\"#f1b1c9\",\"cScale2\":\"#b6f1b1\",\"cScale3\":\"#beb1f1\",\"cScale4\":\"#f1d1b1\",\"cScale5\":\"#b1f1e4\",\"cScale6\":\"#f1b1ec\",\"cScale7\":\"#d9f1b1\",\"cScale8\":\"#b1c6f1\",\"cScale9\":\"#f1b1b4\",\"cScale10\":\"#b1f1c1\",\"cScale11\":\"#d4b1f1\",\"cScaleLabel0\":\"#152832\",\"cScaleLabel1\":\"#152832\",\"cScaleLabel2\":\"#152832\",\"cScaleLabel3\":\"#152832\",\"cScaleLabel4\":\"#152832\",\"cScaleLabel5\":\"#152832\",\"cScaleLabel6\":\"#152832\",\"cScaleLabel7\":\"#152832\",\"cScaleLabel8\":\"#152832\",\"cScaleLabel9\":\"#152832\",\"cScaleLabel10\":\"#152832\",\"cScaleLabel11\":\"#152832\",\"cScaleInv0\":\"#152832\",\"cScaleInv1\":\"#152832\",\"cScaleInv2\":\"#152832\",\"cScaleInv3\":\"#152832\",\"cScaleInv4\":\"#152832\",\"cScaleInv5\":\"#152832\",\"cScaleInv6\":\"#152832\",\"cScaleInv7\":\"#152832\",\"cScaleInv8\":\"#152832\",\"cScaleInv9\":\"#152832\",\"cScaleInv10\":\"#152832\",\"cScaleInv11\":\"#152832\"}",
		config: "{}"
	},
	architecture: {
		vars: "{\"archEdgeColor\":\"#21698d\",\"archEdgeArrowColor\":\"#21698d\",\"archGroupBorderColor\":\"#2483b2\"}",
		config: "{}"
	},
	radar: {
		vars: "{\"cScale0\":\"#277ba5\",\"cScale1\":\"#be2d63\",\"cScale2\":\"#27841f\",\"cScale3\":\"#4b2dbe\",\"cScale4\":\"#a56627\",\"cScale5\":\"#1d7c68\",\"cScale6\":\"#be2db2\",\"cScale7\":\"#587c1d\",\"cScale8\":\"#2d5dbe\",\"cScale9\":\"#be2d32\",\"cScale10\":\"#1f8438\",\"cScale11\":\"#7c2dbe\",\"cScaleLabel0\":\"#ffffff\",\"cScaleLabel1\":\"#ffffff\",\"cScaleLabel2\":\"#ffffff\",\"cScaleLabel3\":\"#ffffff\",\"cScaleLabel4\":\"#ffffff\",\"cScaleLabel5\":\"#ffffff\",\"cScaleLabel6\":\"#ffffff\",\"cScaleLabel7\":\"#ffffff\",\"cScaleLabel8\":\"#ffffff\",\"cScaleLabel9\":\"#ffffff\",\"cScaleLabel10\":\"#ffffff\",\"cScaleLabel11\":\"#ffffff\",\"cScaleInv0\":\"#277ba5\",\"cScaleInv1\":\"#be2d63\",\"cScaleInv2\":\"#27841f\",\"cScaleInv3\":\"#4b2dbe\",\"cScaleInv4\":\"#a56627\",\"cScaleInv5\":\"#1d7c68\",\"cScaleInv6\":\"#be2db2\",\"cScaleInv7\":\"#587c1d\",\"cScaleInv8\":\"#2d5dbe\",\"cScaleInv9\":\"#be2d32\",\"cScaleInv10\":\"#1f8438\",\"cScaleInv11\":\"#7c2dbe\"}",
		config: "{}"
	},
	treemap: {
		vars: "{\"cScale0\":\"#277ba5\",\"cScale1\":\"#be2d63\",\"cScale2\":\"#27841f\",\"cScale3\":\"#4b2dbe\",\"cScale4\":\"#a56627\",\"cScale5\":\"#1d7c68\",\"cScale6\":\"#be2db2\",\"cScale7\":\"#587c1d\",\"cScale8\":\"#2d5dbe\",\"cScale9\":\"#be2d32\",\"cScale10\":\"#1f8438\",\"cScale11\":\"#7c2dbe\",\"cScaleLabel0\":\"#ffffff\",\"cScaleLabel1\":\"#ffffff\",\"cScaleLabel2\":\"#ffffff\",\"cScaleLabel3\":\"#ffffff\",\"cScaleLabel4\":\"#ffffff\",\"cScaleLabel5\":\"#ffffff\",\"cScaleLabel6\":\"#ffffff\",\"cScaleLabel7\":\"#ffffff\",\"cScaleLabel8\":\"#ffffff\",\"cScaleLabel9\":\"#ffffff\",\"cScaleLabel10\":\"#ffffff\",\"cScaleLabel11\":\"#ffffff\",\"cScaleInv0\":\"#277ba5\",\"cScaleInv1\":\"#be2d63\",\"cScaleInv2\":\"#27841f\",\"cScaleInv3\":\"#4b2dbe\",\"cScaleInv4\":\"#a56627\",\"cScaleInv5\":\"#1d7c68\",\"cScaleInv6\":\"#be2db2\",\"cScaleInv7\":\"#587c1d\",\"cScaleInv8\":\"#2d5dbe\",\"cScaleInv9\":\"#be2d32\",\"cScaleInv10\":\"#1f8438\",\"cScaleInv11\":\"#7c2dbe\"}",
		config: "{}"
	},
	journey: {
		vars: "{\"textColor\":\"#152832\",\"fillType0\":\"#b1dcf1\",\"fillType1\":\"#f1b1c9\",\"fillType2\":\"#b6f1b1\",\"fillType3\":\"#beb1f1\",\"fillType4\":\"#f1d1b1\",\"fillType5\":\"#b1f1e4\",\"fillType6\":\"#f1b1ec\",\"fillType7\":\"#d9f1b1\"}",
		config: "{}"
	},
	requirement: {
		vars: "{}",
		config: "{}"
	},
	c4: {
		vars: "{}",
		config: "{}"
	},
	venn: {
		vars: "{}",
		config: "{}"
	},
	ishikawa: {
		vars: "{}",
		config: "{}"
	}
};

function parseHeader(source: string): { readonly config: Json; readonly rest: string } {
	const match = /^---\nconfig: (.*)\n---\n([\s\S]*)$/.exec(source);
	if (!match) throw new Error(`no header in ${source.slice(0, 40)}`);
	// JSON is valid YAML flow style, so JSON.parse reads back exactly what Mermaid's YAML parser reads.
	return { config: JSON.parse(match[1] ?? "{}") as Json, rest: match[2] ?? "" };
}

function extrasOf(kind: Kind, design: Design): { readonly vars: Json; readonly config: Json } {
	const { themeVariables, theme: _theme, look: _look, layout: _layout, handDrawnSeed: _seed, flowchart: _flowchart, ...config } = buildConfig(kind, design) as Json & { themeVariables: Json };
	const vars = Object.fromEntries(Object.entries(themeVariables).filter(([key, value]) => BASE_THEME_VARIABLES[key] !== value));
	return { vars, config };
}

describe("header golden strings", () => {
	test("the shared themeVariables are stable", () => {
		const { themeVariables } = buildConfig("flowchart", DESIGN) as { themeVariables: Json };
		expect(themeVariables).toEqual(BASE_THEME_VARIABLES);
	});

	test("the classDef lines are stable", () => {
		expect(classDefLines(makePalette(200, "pastel", 150))).toBe(GOLDEN_CLASSDEFS);
		expect(buildHeader("flowchart", DESIGN).classDefs).toBe(GOLDEN_CLASSDEFS);
	});

	test("there is a golden entry for every family", () => {
		expect(Object.keys(GOLDEN).sort()).toEqual([...DIAGRAM_KINDS].sort());
		expect(DIAGRAM_KINDS).toHaveLength(24);
	});

	test.each(DIAGRAM_KINDS.map((kind) => [kind] as const))("%s adds exactly the golden variables and config", (kind) => {
		const { vars, config } = extrasOf(kind, DESIGN);
		expect(JSON.stringify(vars)).toBe(GOLDEN[kind].vars);
		expect(JSON.stringify(config)).toBe(GOLDEN[kind].config);
	});

	test.each(DIAGRAM_KINDS.map((kind) => [kind] as const))("%s assembles into the golden header, the body and the classDef lines", (kind) => {
		const body = `${KIND_KEYWORDS[kind]}\n  x`;
		const source = assembleDiagram(body, kind, DESIGN);
		const { config, rest } = parseHeader(source);
		const { vars, config: extraConfig } = extrasOf(kind, DESIGN);
		expect(config).toEqual({
			theme: "base",
			look: "classic",
			layout: "dagre",
			themeVariables: { ...BASE_THEME_VARIABLES, ...vars },
			...extraConfig
		});
		const defs = CLASSDEF_KINDS.has(kind) ? `\n${GOLDEN_CLASSDEFS.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
		expect(rest).toBe(`${body}${defs}`);
	});
});

describe("header rules", () => {
	const kinds = DIAGRAM_KINDS.map((kind) => [kind] as const);

	test.each(kinds)("%s uses theme base, dagre and never a named theme", (kind) => {
		const source = assembleDiagram(`${KIND_KEYWORDS[kind]}\n  x`, kind, { ...DESIGN, look: "handDrawn", seed: 9 });
		const { config } = parseHeader(source);
		expect(config.theme).toBe("base");
		expect(config.layout).toBe("dagre");
		for (const banned of ["dark", "forest", "neutral", "neo", "redux", "elk"]) {
			expect(source.toLowerCase()).not.toMatch(new RegExp(`theme"?:\\s*"?${banned}`));
			expect(JSON.stringify(config).toLowerCase()).not.toContain(`"${banned}"`);
		}
	});

	test.each(kinds)("%s only carries handDrawnSeed for the hand-drawn look", (kind) => {
		const classic = parseHeader(assembleDiagram("x", kind, DESIGN)).config;
		const drawn = parseHeader(assembleDiagram("x", kind, { ...DESIGN, look: "handDrawn", seed: 42 })).config;
		expect(classic.look).toBe("classic");
		expect("handDrawnSeed" in classic).toBe(false);
		expect(drawn.look).toBe("handDrawn");
		expect(drawn.handDrawnSeed).toBe(42);
	});

	test.each(kinds)("%s themeVariables are hex colours, plain lengths or a font", (kind) => {
		const { themeVariables } = parseHeader(assembleDiagram("x", kind, { ...DESIGN, font: { family: "Georgia, serif", size: "15px" } })).config as { themeVariables: Json };
		const bad: string[] = [];
		const walk = (value: unknown, path: string): void => {
			if (typeof value === "object" && value !== null) {
				Object.entries(value as Json).forEach(([key, inner]) => walk(inner, `${path}.${key}`));
			} else if (typeof value === "string") {
				const hex = /^#[0-9a-f]{6}$/.test(value) || /^#[0-9a-f]{6}(,#[0-9a-f]{6})*$/.test(value);
				const length = /^\d+(\.\d+)?px$/.test(value);
				const plain = value === "1" || value === "transparent" || path.endsWith(".fontFamily");
				if (!hex && !length && !plain) bad.push(`${path}=${value}`);
			} else {
				bad.push(`${path}=${String(value)}`);
			}
		};
		walk(themeVariables, "themeVariables");
		expect(bad).toEqual([]);
	});

	test("only flowcharts carry the connector curve and padding", () => {
		const design: Design = { ...DESIGN, curve: "step", padding: 14 };
		expect(parseHeader(assembleDiagram("x", "flowchart", design)).config.flowchart).toEqual({ curve: "step", padding: 14 });
		DIAGRAM_KINDS.filter((kind) => kind !== "flowchart").forEach((kind) => {
			expect("flowchart" in parseHeader(assembleDiagram("x", kind, design)).config).toBe(false);
		});
	});

	test("the font lands in themeVariables when the design has one", () => {
		const { themeVariables } = parseHeader(assembleDiagram("x", "flowchart", { ...DESIGN, font: { family: "Menlo, monospace", size: "13px" } })).config as { themeVariables: Json };
		expect(themeVariables.fontFamily).toBe("Menlo, monospace");
		expect(themeVariables.fontSize).toBe("13px");
	});

	test("the full header for a hand-drawn flowchart is exactly this string", () => {
		const source = assembleDiagram("flowchart TD\n  A --> B", "flowchart", { ...DESIGN, look: "handDrawn", seed: 7, curve: "step", padding: 14 });
		const expected = [
			"---",
			'config: {"theme":"base","look":"handDrawn","layout":"dagre","handDrawnSeed":7,"themeVariables":{"primaryColor":"#e4f4fc","primaryTextColor":"#143343","primaryBorderColor":"#2483b2","secondaryColor":"#fce4e8","secondaryTextColor":"#43141c","secondaryBorderColor":"#b2243c","tertiaryColor":"#f4f9fb","tertiaryTextColor":"#143343","tertiaryBorderColor":"#2483b2","lineColor":"#21698d","textColor":"#143343","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"step","padding":14}}',
			"---",
			"flowchart TD",
			"  A --> B",
			...GOLDEN_CLASSDEFS.split("\n").map((line) => `  ${line}`)
		].join("\n");
		expect(source).toBe(expected);
	});

	test("trailing whitespace on the body does not leak into the output", () => {
		expect(assembleDiagram("pie\n  \"A\" : 1\n\n\n", "pie", DESIGN).endsWith('"A" : 1')).toBe(true);
	});

	test("frontmatter is a single config line between fences", () => {
		const text = frontmatter({ a: 1, b: { c: "#fff" } });
		expect(text).toBe('---\nconfig: {"a":1,"b":{"c":"#fff"}}\n---\n');
	});

	test("typeExtras never reaches into another family's variables", () => {
		const palette = makePalette(200, "pastel", 150);
		expect(typeExtras("flowchart", palette, 200)).toEqual({});
		expect(Object.keys(typeExtras("pie", palette, 200).themeVariables ?? {})).toContain("pie12");
		expect(Object.keys(typeExtras("pie", palette, 200).themeVariables ?? {})).not.toContain("cScale0");
	});
});
