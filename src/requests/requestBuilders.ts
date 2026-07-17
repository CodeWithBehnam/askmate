import {
	AskMateSettings,
	AskRequest,
	ContextBudgetMode,
	EvidenceSource,
	formatRequestIntent,
	formatTokenCount,
	getContextBudgetOption,
	isImageReferencePath,
	NoteContext,
	normalizePlannedPrompt,
	PromptContextResult,
	RequestPrivacyOptions,
	ImagePromptExtraction
} from "../shared/core";

export function buildTextInstructions(): string {
	return [
		"Role: You are AskMate, a concise AI assistant inside Obsidian for working with the user's notes.",
		"",
		"Goal: Complete the user's request using the provided note context, whether the task is Q&A, translation, summarization, analysis, rewriting, extraction, or another note workflow.",
		"",
		"Success criteria: Address the exact request, preserve important source details, make factual claims traceable to the note context, and produce clear Markdown that can be pasted into an Obsidian note.",
		"",
		"Constraints: Do not invent details. If the context is insufficient, say what is missing. Thread history and note history can clarify follow-up intent, but factual claims must still be grounded in the note context or explicit context attachments. Style guide and glossary attachments are guidance roles for tone, terminology, and formatting, not primary evidence. Image manifests are metadata only, not pixel-level vision. When evidence sources are provided, cite factual claims with source IDs like [S1] or [S2] when useful. For translation, preserve meaning, tone, structure, names, numbers, terminology, and formatting unless asked to adapt. For summaries, include quotes or timestamps only when present. For analysis, separate observations from recommendations when useful and label uncertainty.",
		"",
		"Output: Stay concise and direct. Use headings, bullets, or numbered lists only when they improve readability. Stop when the user's request is answered."
	].join("\n");
}

export function buildImagePromptPlanningInstructions(): string {
	return [
		"Role: You prepare high-quality prompts for an image generation model inside Obsidian.",
		"",
		"Goal: Analyze the user request and note context, then produce one concise image prompt suitable for gpt-image-2.",
		"",
		"Success criteria: Preserve source-backed details, infer a clear visual composition, specify style only when helpful, and avoid unsupported exact claims, logos, private details, dates, numbers, or identities.",
		"",
		"Constraints: Treat the note context and user request as source material. Do not answer the user in prose. Do not include Markdown. If the request is sparse, create a useful visual direction from the note context.",
		"",
		"Output: Return JSON only with this shape: {\"prompt\":\"...\"}. Stop after the JSON object."
	].join("\n");
}

export function buildPromptContextContent(
	context: NoteContext,
	privacy: RequestPrivacyOptions,
	contextBudgetMode: ContextBudgetMode
): PromptContextResult {
	if (!privacy.includeNoteContext) {
		const text = "[Note context omitted by AskMate privacy controls.]";
		return {
			text,
			originalCharacters: context.content.length,
			finalCharacters: text.length,
			truncated: false,
			limitCharacters: null
		};
	}

	const budget = getContextBudgetOption(contextBudgetMode);
	const attachmentText = (context.attachments ?? [])
		.filter((attachment) => attachment.content.trim())
		.map((attachment) => [
			"",
			`<context_attachment kind="${attachment.kind}" title="${attachment.title.replace(/"/g, "'")}" source="${attachment.sourcePath.replace(/"/g, "'")}">`,
			attachment.content,
			"</context_attachment>"
		].join("\n"))
		.join("\n");
	const assembledContent = [context.content, attachmentText].filter((part) => part.trim()).join("\n\n");
	const originalCharacters = assembledContent.length;
	let content = privacy.includeImageReferences
		? assembledContent
		: assembledContent
			.replace(/!?\[\[([^\]]+)\]\]/g, (match, reference: string) => {
				return isImageReferencePath(reference) ? "[Image reference omitted by AskMate privacy controls.]" : match;
			})
			.replace(/!?\[[^\]]*\]\(([^)]+)\)/g, (match, reference: string) => {
				return isImageReferencePath(reference) ? "[Image reference omitted by AskMate privacy controls.]" : match;
			});

	if (budget.maxCharacters !== null && content.length > budget.maxCharacters) {
		const marker = `\n\n[AskMate omitted ${formatTokenCount(content.length - budget.maxCharacters)} characters from the middle because the ${budget.label} context budget is selected. Switch to Expanded to include more.]\n\n`;
		const available = Math.max(0, budget.maxCharacters - marker.length);
		const headLength = Math.floor(available * 0.7);
		const tailLength = Math.max(0, available - headLength);
		content = `${content.slice(0, headLength).trimEnd()}${marker}${content.slice(content.length - tailLength).trimStart()}`;

		return {
			text: content,
			originalCharacters,
			finalCharacters: content.length,
			truncated: true,
			limitCharacters: budget.maxCharacters
		};
	}

	return {
		text: content,
		originalCharacters,
		finalCharacters: content.length,
		truncated: false,
		limitCharacters: budget.maxCharacters
	};
}

export function getPromptContextContent(request: AskRequest): string {
	return buildPromptContextContent(
		request.context,
		request.metadata.privacy,
		request.metadata.contextBudgetMode
	).text;
}

export function formatEvidenceSources(request: AskRequest): string {
	if (request.evidenceSources.length === 0) {
		return "";
	}
	return request.evidenceSources
		.map((source) => `[${source.id}] ${source.sourcePath}#L${source.lineStart}-L${source.lineEnd}: ${source.excerpt}`)
		.join("\n");
}

export function buildEvidenceSourcesFromMarkdown(
	kind: EvidenceSource["kind"],
	title: string,
	sourcePath: string,
	markdown: string,
	startLine: number,
	offset: number
): EvidenceSource[] {
	const sources: EvidenceSource[] = [];
	const lines = markdown.split(/\r?\n/);
	let blockStart = 0;
	let blockLines: string[] = [];
	const flush = (): void => {
		const excerpt = blockLines.join("\n").replace(/\s+/g, " ").trim().slice(0, 240);
		if (excerpt) {
			sources.push({
				id: `S${offset + sources.length + 1}`,
				kind,
				sourcePath,
				title,
				lineStart: startLine + blockStart,
				lineEnd: startLine + blockStart + Math.max(0, blockLines.length - 1),
				excerpt
			});
		}
		blockLines = [];
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim()) {
			flush();
			blockStart = index + 1;
			continue;
		}
		if (/^#{1,6}\s+/.test(line) && blockLines.length > 0) {
			flush();
			blockStart = index;
		}
		if (blockLines.length === 0) {
			blockStart = index;
		}
		blockLines.push(line);
	}
	flush();
	return sources;
}

export function buildEvidenceSources(settings: AskMateSettings, context: NoteContext): EvidenceSource[] {
	if (!settings.evidenceLinkedAnswersEnabled) {
		return [];
	}
	const sources: EvidenceSource[] = [];
	const addSources = (kind: EvidenceSource["kind"], title: string, sourcePath: string, markdown: string, startLine = 1): void => {
		for (const source of buildEvidenceSourcesFromMarkdown(kind, title, sourcePath, markdown, startLine, sources.length)) {
			sources.push(source);
			if (sources.length >= settings.evidenceMaxSources) {
				return;
			}
		}
	};
	addSources(
		"primary_note",
		context.source,
		context.file?.path ?? "Untitled or unsaved note",
		context.content,
		context.source === "Selected text" ? context.selectionStartLine ?? 1 : 1
	);
	for (const attachment of context.attachments ?? []) {
		if (!["additional_note", "folder_note", "excalidraw_summary"].includes(attachment.kind)) {
			continue;
		}
		addSources(attachment.kind, attachment.title, attachment.sourcePath, attachment.content, 1);
		if (sources.length >= settings.evidenceMaxSources) {
			break;
		}
	}
	return sources.slice(0, settings.evidenceMaxSources).map((source, index) => ({ ...source, id: `S${index + 1}` }));
}

export function buildPrompt(request: AskRequest): string {
	const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
	const promptContext = getPromptContextContent(request);
	const evidenceSourceText = request.metadata.privacy.includeNoteContext ? formatEvidenceSources(request) : "";

	return [
		"Goal: Complete the user request using the note context below.",
		"",
		"Success criteria:",
		"- Address the requested task directly.",
		"- Use the note context as the evidence source.",
		"- State what is missing if the note context is insufficient.",
		"- Keep the final output useful as Obsidian Markdown.",
		"",
		"Stop rules: Answer once the core request is satisfied. Do not add unrelated sections.",
		"",
		`Prompt version: ${request.metadata.promptVersion}`,
		`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
		`Workflow: ${request.metadata.workflowName ?? "None"}`,
		`Source: ${sourcePath}`,
		`Context type: ${request.context.source}`,
		"",
		"<note_context>",
		promptContext,
		"</note_context>",
		evidenceSourceText ? "" : "",
		evidenceSourceText ? "<evidence_sources>" : "",
		evidenceSourceText,
		evidenceSourceText ? "</evidence_sources>" : "",
		"",
		"<user_request>",
		request.question,
		"</user_request>"
	].join("\n");
}

export function buildImagePromptPlanningInput(request: AskRequest): string {
	const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
	const promptContext = getPromptContextContent(request);

	return [
		`Prompt version: ${request.metadata.promptVersion}`,
		`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
		`Workflow: ${request.metadata.workflowName ?? "None"}`,
		`Source: ${sourcePath}`,
		`Context type: ${request.context.source}`,
		"",
		"<note_context>",
		promptContext,
		"</note_context>",
		"",
		"<user_request>",
		request.question,
		"</user_request>"
	].join("\n");
}

export function buildImagePrompt(request: AskRequest): string {
	const sourcePath = request.context.file?.path ?? "Untitled or unsaved note";
	const promptContext = getPromptContextContent(request);

	return [
		"Goal: Generate one image that satisfies the user request, using the note context as source material and inspiration.",
		"",
		"Success criteria:",
		"- Match the user's visual request directly.",
		"- Preserve source-backed names, dates, numbers, terminology, and visual constraints when they appear in the note context.",
		"- Use generic visual placeholders when evidence is insufficient for exact real-world details.",
		"- Make the image useful for an Obsidian note.",
		"",
		"Constraints: Do not invent logos, exact portraits, private details, metrics, dates, or product claims that are not present in the note context or user request.",
		"",
		"Output: Return only the generated image.",
		"",
		`Prompt version: ${request.metadata.promptVersion}`,
		`Intent: ${formatRequestIntent(request.metadata.intentKind)}`,
		`Workflow: ${request.metadata.workflowName ?? "None"}`,
		`Source: ${sourcePath}`,
		`Context type: ${request.context.source}`,
		"",
		"<note_context>",
		promptContext,
		"</note_context>",
		"",
		"<image_request>",
		request.question,
		"</image_request>"
	].join("\n");
}

export function extractPlannedImagePrompt(text: string): ImagePromptExtraction {
	const value = text.trim();

	if (!value) {
		return {
			prompt: "",
			fallbackReason: "The planning response was empty."
		};
	}

	const jsonMatch = value.match(/^```json\s*([\s\S]*?)```$/i) ?? value.match(/^```\s*([\s\S]*?)```$/i);
	const candidate = jsonMatch?.[1]?.trim() ?? value;

	try {
		const parsed = JSON.parse(candidate) as { prompt?: unknown };
		const prompt = typeof parsed.prompt === "string" ? normalizePlannedPrompt(parsed.prompt) : "";

		if (!prompt) {
			return {
				prompt: "",
				fallbackReason: "The planning JSON did not include a non-empty prompt string."
			};
		}

		return {
			prompt,
			fallbackReason: null
		};
	} catch {
		return {
			prompt: "",
			fallbackReason: "The planning response was not valid JSON."
		};
	}
}
