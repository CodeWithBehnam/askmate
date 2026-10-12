// What the plugin prepends to the model's diagram body: YAML frontmatter with a base theme and hex-only themeVariables, plus classDef lines.
// Only theme "base" is used. Obsidian's bundled Mermaid has no other themes that honour themeVariables, and dagre is the only layout it registers.

import { hslToHex } from "./color";
import { balancedMarks, baseThemeVariables, classDefLines, makePalette, marks, softMarks } from "./palette";
import type { Design, Kind, Palette } from "./types";

/** First line the model writes for each family. The -beta forms are the ones every Mermaid 11 build accepts. */
export const KIND_KEYWORDS: Readonly<Record<Kind, string>> = {
	flowchart: "flowchart",
	sequence: "sequenceDiagram",
	class: "classDiagram",
	state: "stateDiagram-v2",
	er: "erDiagram",
	gantt: "gantt",
	pie: "pie",
	quadrant: "quadrantChart",
	mindmap: "mindmap",
	timeline: "timeline",
	gitGraph: "gitGraph",
	sankey: "sankey-beta",
	xychart: "xychart-beta",
	block: "block-beta",
	packet: "packet-beta",
	kanban: "kanban",
	architecture: "architecture-beta",
	radar: "radar-beta",
	treemap: "treemap-beta",
	journey: "journey",
	requirement: "requirementDiagram",
	c4: "C4Context",
	venn: "venn-beta",
	ishikawa: "ishikawa-beta"
};

/** Families where `classDef` plus a role tag works, so the plugin appends the classDef lines. Verified by parse against Mermaid 11.13.0. */
export const CLASSDEF_KINDS: ReadonlySet<Kind> = new Set<Kind>(["flowchart", "state", "class", "er", "block", "treemap"]);

interface Extras {
	readonly themeVariables?: Readonly<Record<string, unknown>>;
	readonly config?: Readonly<Record<string, unknown>>;
}

const indexed = (prefix: string, values: readonly string[]): Record<string, string> =>
	Object.fromEntries(values.map((value, i) => [`${prefix}${i}`, value]));

/** Only variables verified to take effect on Mermaid 11.13.0. */
export function typeExtras(kind: Kind, palette: Palette, hue: number): Extras {
	const m = marks(hue, 12);
	const ink = hslToHex(hue, 40, 14);
	const text = palette.primary.text;
	const stroke = palette.primary.stroke;
	switch (kind) {
		case "pie":
			return {
				themeVariables: {
					...Object.fromEntries(m.map((value, i) => [`pie${i + 1}`, value])),
					pieStrokeColor: "#ffffff",
					pieStrokeWidth: "2px",
					pieOuterStrokeWidth: "0px",
					pieOpacity: "1",
					pieSectionTextColor: "#ffffff",
					pieLegendTextColor: text,
					pieTitleTextColor: text
				}
			};
		case "xychart":
			return {
				themeVariables: {
					xyChart: {
						plotColorPalette: m.slice(0, 6).join(","),
						backgroundColor: "transparent",
						titleColor: text,
						xAxisLabelColor: text,
						xAxisTitleColor: text,
						yAxisLabelColor: text,
						yAxisTitleColor: text,
						xAxisLineColor: stroke,
						yAxisLineColor: stroke,
						xAxisTickColor: stroke,
						yAxisTickColor: stroke
					}
				}
			};
		case "mindmap": {
			const mid = balancedMarks(hue);
			return { themeVariables: { ...indexed("cScale", mid), ...indexed("cScaleLabel", mid.map(() => "#1a1a1a")), ...indexed("cScaleInv", mid) } };
		}
		case "kanban": {
			const soft = softMarks(hue, 12);
			return {
				themeVariables: {
					...indexed("cScale", soft),
					...indexed("cScaleLabel", soft.map(() => ink)),
					...indexed("cScaleInv", soft.map(() => ink)),
					primaryTextColor: ink,
					textColor: ink
				}
			};
		}
		case "timeline":
		case "radar":
		case "treemap":
			return { themeVariables: { ...indexed("cScale", m), ...indexed("cScaleLabel", m.map(() => "#ffffff")), ...indexed("cScaleInv", m) } };
		case "journey":
			return { themeVariables: { ...indexed("fillType", softMarks(hue, 8)), textColor: ink } };
		case "gitGraph":
			return {
				themeVariables: {
					...indexed("git", m.slice(0, 8)),
					...indexed("gitBranchLabel", m.slice(0, 8).map(() => "#ffffff")),
					commitLabelColor: text,
					commitLabelBackground: palette.soft,
					tagLabelColor: text,
					tagLabelBackground: palette.primary.fill,
					tagLabelBorder: stroke
				}
			};
		case "quadrant":
			return {
				themeVariables: {
					quadrant1Fill: palette.primary.fill,
					quadrant2Fill: palette.accent.fill,
					quadrant3Fill: palette.muted.fill,
					quadrant4Fill: palette.success.fill,
					quadrant1TextFill: text,
					quadrant2TextFill: palette.accent.text,
					quadrant3TextFill: palette.muted.text,
					quadrant4TextFill: palette.success.text,
					quadrantPointFill: stroke,
					quadrantPointTextFill: text,
					quadrantXAxisTextFill: text,
					quadrantYAxisTextFill: text,
					quadrantTitleFill: text,
					quadrantInternalBorderStrokeFill: stroke,
					quadrantExternalBorderStrokeFill: stroke
				}
			};
		case "gantt":
			return {
				themeVariables: {
					taskBkgColor: palette.primary.fill,
					taskBorderColor: stroke,
					taskTextColor: text,
					taskTextDarkColor: text,
					taskTextOutsideColor: text,
					activeTaskBkgColor: palette.accent.fill,
					activeTaskBorderColor: palette.accent.stroke,
					doneTaskBkgColor: palette.muted.fill,
					doneTaskBorderColor: palette.muted.stroke,
					critBkgColor: palette.danger.fill,
					critBorderColor: palette.danger.stroke,
					gridColor: palette.muted.stroke,
					sectionBkgColor: palette.soft,
					altSectionBkgColor: "#ffffff",
					sectionBkgColor2: palette.soft,
					todayLineColor: palette.danger.stroke,
					titleColor: text
				}
			};
		case "sequence":
			return {
				themeVariables: {
					actorBkg: palette.primary.fill,
					actorBorder: stroke,
					actorTextColor: text,
					actorLineColor: palette.line,
					signalColor: palette.line,
					signalTextColor: text,
					labelBoxBkgColor: palette.accent.fill,
					labelBoxBorderColor: palette.accent.stroke,
					labelTextColor: palette.accent.text,
					loopTextColor: text,
					noteBkgColor: palette.warn.fill,
					noteBorderColor: palette.warn.stroke,
					noteTextColor: palette.warn.text,
					activationBkgColor: palette.accent.fill,
					activationBorderColor: palette.accent.stroke,
					sequenceNumberColor: "#ffffff"
				}
			};
		case "sankey":
			return { config: { sankey: { linkColor: "gradient", nodeAlignment: "justify", showValues: true } } };
		case "architecture":
			return { themeVariables: { archEdgeColor: palette.line, archEdgeArrowColor: palette.line, archGroupBorderColor: stroke } };
		default:
			return {};
	}
}

/** YAML frontmatter that Mermaid 11.13 accepts. JSON is valid YAML flow style, which sidesteps quoting bugs. */
export function frontmatter(config: Readonly<Record<string, unknown>>): string {
	return `---\nconfig: ${JSON.stringify(config)}\n---\n`;
}

export function buildConfig(kind: Kind, design: Design): Record<string, unknown> {
	const palette = makePalette(design.hue, design.mood, design.accentOffset);
	const extras = typeExtras(kind, palette, design.hue);
	return {
		theme: "base",
		look: design.look,
		layout: "dagre",
		...(design.look === "handDrawn" ? { handDrawnSeed: design.seed } : {}),
		themeVariables: { ...baseThemeVariables(palette, design.font), ...(extras.themeVariables ?? {}) },
		...(kind === "flowchart" && design.curve !== undefined ? { flowchart: { curve: design.curve, ...(design.padding !== undefined ? { padding: design.padding } : {}) } } : {}),
		...(extras.config ?? {})
	};
}

/** The model writes only the body. This builds the first lines (frontmatter) and the classDef lines. */
export function buildHeader(kind: Kind, design: Design): { readonly frontmatter: string; readonly classDefs: string } {
	const palette = makePalette(design.hue, design.mood, design.accentOffset);
	return { frontmatter: frontmatter(buildConfig(kind, design)), classDefs: classDefLines(palette) };
}

/** Plugin header, then the model's body, then the classDef lines for families that support role tags. */
export function assembleDiagram(body: string, kind: Kind, design: Design): string {
	const header = buildHeader(kind, design);
	const trimmed = body.replace(/\s+$/, "");
	const defs = CLASSDEF_KINDS.has(kind) ? `\n${header.classDefs.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
	return `${header.frontmatter}${trimmed}${defs}`;
}
