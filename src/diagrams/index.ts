export { buildDiagramBrief, type DiagramBrief, type DiagramBriefInput } from "./brief";
export { contrast, fnv1a, hslToHex, hueFromSeed, luminance } from "./color";
export { createScratchHost, mountSvg, scrubSvg, type ScratchParent } from "./dom";
export { detectKind, extractDiagram, extractDiagramParts, findMermaidFences, sourceHash, splitHeader, type ExtractedDiagram, type MermaidFence } from "./extract";
export { assembleDiagram, buildConfig, buildHeader, CLASSDEF_KINDS, frontmatter, KIND_KEYWORDS, typeExtras } from "./header";
export { createIdFactory, nextRenderId } from "./ids";
export { errorText, firstLines, lineOf, PROBE_SOURCES, supportedDiagrams, toMermaidApi } from "./mermaid";
export { balancedMarks, baseThemeVariables, classDefLines, makePalette, marks, ROLES, softMarks } from "./palette";
export { MAX_DIAGRAM_CHARS, runDiagramPipeline, type DiagramDeps } from "./pipeline";
export { buildRepairPrompt, DIAGRAM_PROMPT_TAGS, escapeDiagramPromptText, type RepairPromptInput } from "./prompts";
export { DENSITY_PADDING, designFromRecipe, findRecipe, lookSeed, noteSeed, recipeOrder, STYLE_RECIPES } from "./recipes";
export {
	applyDeterministicRepairs,
	closeSubgraphs,
	escapeSequenceText,
	fixPieValues,
	fixSingleArrows,
	normaliseText,
	quoteFlowchartLabels,
	renameReservedEnd,
	REPAIR_STEPS,
	type RepairResult
} from "./repair";
export { localSafetyCheck } from "./safety";
export { detectDiagramIntent, hasExplicitDiagramCommand } from "../shared/imageIntent";
export {
	DIAGRAM_KINDS,
	type Curve,
	type Density,
	type Design,
	type DiagramFallback,
	type DiagramOutcome,
	type DiagramStage,
	type DiagramValid,
	type FallbackStage,
	type FontSpec,
	type Kind,
	type Look,
	type MermaidApi,
	type Mood,
	type Palette,
	type RepairRequest,
	type Role,
	type RoleColours,
	type SafetyCheck,
	type SafetyOptions,
	type SafetyVerdict,
	type ScratchHandle,
	type ScratchHost,
	type StyleRecipe
} from "./types";
