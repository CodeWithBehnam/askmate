import { Editor, TFile } from "obsidian";
import type {
	ApiEndpoint,
	AskMateResult,
	AskMateSettings,
	AskRequest,
	BuildRequestOptions,
	ContextAttachment,
	ImageAskMateResult,
	ImagePromptPlan,
	NoteContext,
	OpenAIImageGenerationBody,
	OpenAIResponseBody,
	OpenAITokenUsage,
	OperationKind,
	OperationStatus,
	ProviderModelRef,
	ProviderTextResult,
	ReasoningEffort,
	RequestIntentKind,
	RequestPrivacyOptions,
	TextProviderId
} from "../shared/core";
import {
	ASKMATE_PROMPT_VERSION,
	GPT_IMAGE_2_MODEL_ID,
	IMAGE_MIME_TYPE,
	getModelCapability,
	getProviderLabel,
	isAbortError,
	normalizeContextBudgetMode,
	normalizeOutputMode,
	normalizeRequestPrivacyOptions,
	normalizeTextProviderId
} from "../shared/core";
import {
	completeProviderTextRequest,
	extractOpenAIRefusal,
	extractOpenAIText,
	formatProviderHttpError,
	getProviderTextEndpoint,
	requestOpenAIImageGeneration,
	requestOpenAIResponses
} from "../providers";
import type { ProviderRuntime } from "../providers";
import {
	buildEvidenceSources,
	buildImagePrompt,
	buildImagePromptPlanningInput,
	buildImagePromptPlanningInstructions,
	buildPrompt,
	buildPromptContextContent,
	buildTextInstructions,
	extractPlannedImagePrompt,
	formatEvidenceSources
} from "./requestBuilders";
import { truncateAtCodePoint } from "./promptSafety";

export type RequestRunnerHost = {
	getSettings: () => AskMateSettings;
	getProviderRuntime: () => ProviderRuntime;
	getOpenAiApiKey: () => Promise<string>;
	getSelectedProviderModelRef: () => ProviderModelRef;
	getSelectedReasoningEffort: () => ReasoningEffort;
	getImagePlanningProviderRef: () => ProviderModelRef;
	getImagePlanningModel: () => string;
	shouldGenerateImageFromQuestion: (question: string) => boolean;
	recordOperationUsage: (params: {
		request: AskRequest;
		providerId?: TextProviderId;
		providerName?: string;
		operationKind: OperationKind;
		endpoint: ApiEndpoint;
		status: OperationStatus;
		model: string;
		instructions: string;
		input: string;
		responseText: string;
		usage: OpenAITokenUsage | null;
		startedAt: Date;
		errorMessage?: string;
	}) => Promise<void>;
	getErrorMessage: (error: unknown) => string;
	expandWorkflowPrompt: (workflow: NonNullable<BuildRequestOptions["workflow"]>, context: NoteContext, selectedTextReference: string, privacy: RequestPrivacyOptions) => string;
	getNoteContext: (editor?: Editor, file?: TFile | null) => Promise<NoteContext>;
	getFileNoteContext: (file: TFile) => Promise<NoteContext>;
	/** The whole note, ignoring any selection; the open editor's text when the note is open. */
	getFullNoteContext: (file: TFile) => Promise<NoteContext>;
	buildContextAttachments: (
		context: NoteContext,
		options: BuildRequestOptions,
		privacy: AskRequest["metadata"]["privacy"]
	) => Promise<ContextAttachment[]>;
	throwIfAborted: (abortSignal?: AbortSignal) => void;
	/** No longer called: the runner checks base64 shape cheaply and the plugin decodes once when saving. */
	decodeBase64Image?: (base64: string) => ArrayBuffer;
};

// No angle brackets: buildPrompt escapes delimiter tags inside user_request.
export const WORKFLOW_SELECTED_TEXT_REFERENCE = "[the selected text, provided in the note context above]";

export class RequestRunner {
	constructor(private readonly host: RequestRunnerHost) {}

	classifyRequestIntent(
		question: string,
		options: Pick<BuildRequestOptions, "forceImage" | "workflow" | "intentKind" | "autoImage"> = {}
	): RequestIntentKind {
		if (options.intentKind) {
			return options.intentKind;
		}

		if (options.workflow) {
			return "workflow";
		}

		if (options.forceImage === true || this.host.getSelectedProviderModelRef().capability === "image") {
			return "explicit_image";
		}

		if (options.autoImage === true || this.host.shouldGenerateImageFromQuestion(question)) {
			return "auto_image";
		}

		return "freeform_text";
	}

	/** "selection" refuses to fall back to the whole note; "note" widens a selection to the whole note. */
	private async applyContextScope(context: NoteContext, scope: BuildRequestOptions["contextScope"]): Promise<NoteContext> {
		if (scope === "selection" && context.source !== "Selected text") {
			throw new Error("@selection needs selected text. Select text in the note, then send again.");
		}
		if (scope === "note" && context.source === "Selected text") {
			if (!(context.file instanceof TFile)) {
				throw new Error("@note needs a saved Markdown note. Save the note, then send again.");
			}
			return await this.host.getFullNoteContext(context.file);
		}
		return context;
	}

	async buildRequest(question: string, title: string, options: BuildRequestOptions = {}): Promise<AskRequest> {
		const settings = this.host.getSettings();
		const intentKind = this.classifyRequestIntent(question, options);
		const providerRef = this.host.getSelectedProviderModelRef();
		const selectedModel = providerRef.model;
		const forceImage = options.forceImage === true || intentKind === "explicit_image";
		const autoImage = options.autoImage === true || intentKind === "auto_image";
		const capturedContext = options.forceFileContext && options.file instanceof TFile && options.file.extension === "md"
			? await this.host.getFileNoteContext(options.file)
			: await this.host.getNoteContext(options.editor, options.file);
		const context = await this.applyContextScope(capturedContext, options.contextScope);
		const privacy = normalizeRequestPrivacyOptions({ ...settings.requestPrivacyDefaults, ...options.privacy });
		const contextBudgetMode = normalizeContextBudgetMode(options.contextBudgetMode ?? settings.contextBudgetMode);
		const attachments = await this.host.buildContextAttachments(context, options, privacy);
		const contextWithAttachments: NoteContext = {
			...context,
			attachments
		};
		const promptContext = buildPromptContextContent(contextWithAttachments, privacy, contextBudgetMode);
		// {{selectedText}} renders as a pointer to the selection in note_context. Inlining the text would give untrusted note
		// content the authority of user_request and send it twice.
		const workflowSelectionReference = privacy.includeNoteContext ? WORKFLOW_SELECTED_TEXT_REFERENCE : "";
		const workflowExtra = options.workflowExtra?.trim();
		const requestQuestion = options.workflow
			? `${this.host.expandWorkflowPrompt(options.workflow, contextWithAttachments, workflowSelectionReference, privacy)}${workflowExtra ? `\n\nExtra instructions for this run: ${workflowExtra}` : ""}`
			: question;
		const folderAttachments = attachments.filter((attachment) => attachment.kind === "folder_note");
		// Note-edit workflows (rewrite, translate) return text that replaces the note, so they must never be asked for [S1] citations.
		const evidenceSources = privacy.includeNoteContext && providerRef.capability === "text" && !forceImage && !autoImage && options.workflow?.outputKind !== "note-edit"
			? buildEvidenceSources(settings, contextWithAttachments)
			: [];

		const request: AskRequest = {
			context: contextWithAttachments,
			question: requestQuestion,
			title,
			evidenceSources,
			metadata: {
				intentKind,
				commandSource: options.commandSource ?? "sidebar",
				outputMode: normalizeOutputMode(options.outputMode ?? settings.outputMode),
				promptVersion: ASKMATE_PROMPT_VERSION,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				selectedModel,
				modelCapability: providerRef.capability,
				reasoningEffort: this.host.getSelectedReasoningEffort(),
				privacy,
				contextBudgetMode,
				contextBudgetLimitCharacters: promptContext.limitCharacters,
				contextTruncated: promptContext.truncated,
				primaryContextTruncated: promptContext.primaryTruncated ?? promptContext.truncated,
				contextCharacters: promptContext.originalCharacters,
				promptContextCharacters: promptContext.finalCharacters,
				contextAttachmentCount: attachments.length,
				contextAttachmentSources: attachments.map((attachment) => attachment.sourcePath || attachment.title).slice(0, 20),
				threadHistoryIncluded: attachments.some((attachment) => attachment.kind === "thread_history"),
				folderContextPath: folderAttachments.length > 0 ? (options.folderContext?.path ?? settings.folderContextPath) : null,
				folderContextFilesIncluded: folderAttachments.length,
				evidenceEnabled: evidenceSources.length > 0,
				evidenceSourceCount: evidenceSources.length,
				forceImage,
				autoImage,
				workflowId: options.workflow?.id ?? null,
				workflowName: options.workflow?.name ?? null,
				createdAt: new Date().toISOString()
			}
		};
		// Evidence excerpts share the context budget, so the reported size covers everything note-derived that is sent.
		request.metadata.promptContextCharacters += formatEvidenceSources(request, promptContext).length;
		return request;
	}

	async runOpenAIRequest(
		request: AskRequest,
		options: {
			onTextDelta?: (delta: string) => void;
			abortSignal?: AbortSignal;
			forceImage?: boolean;
		} = {}
	): Promise<AskMateResult> {
		const model = request.metadata.selectedModel;
		const shouldGenerateImage = options.forceImage === true
			|| request.metadata.forceImage
			|| request.metadata.autoImage
			|| request.metadata.modelCapability === "image";

		if (shouldGenerateImage) {
			if (!(await this.host.getOpenAiApiKey())) {
				throw new Error("Add an OpenAI API key in AskMate settings before generating an image with gpt-image-2.");
			}
			const imagePromptPlan = await this.prepareImagePrompt(request, options.abortSignal);
			return await this.generateOpenAIImage(request, options.abortSignal, imagePromptPlan);
		}

		const onDelta = options.onTextDelta ?? (() => undefined);
		const providerId = normalizeTextProviderId(request.metadata.providerId);
		const result = providerId === "openai"
			? await this.completeOpenAIText(request, onDelta, options.abortSignal)
			: await this.completeProviderText(
				request,
				{
					providerId,
					providerName: getProviderLabel(providerId),
					model,
					capability: "text"
				},
				buildTextInstructions(),
				buildPrompt(request),
				"text_response",
				options.abortSignal,
				onDelta
			);
		const incompleteReason = result.incompleteReason ?? null;
		request.metadata.outputIncompleteReason = incompleteReason;
		return {
			kind: "text",
			model,
			text: result.text,
			incompleteReason
		};
	}

	/**
	 * Obsidian's requestUrl cannot stream a response body, so the answer arrives in one piece and onDelta fires once.
	 * The name is kept because the plugin exposes it.
	 */
	async streamOpenAI(
		request: AskRequest,
		onDelta: (delta: string) => void,
		abortSignal?: AbortSignal
	): Promise<string> {
		const result = await this.completeOpenAIText(request, onDelta, abortSignal);
		request.metadata.outputIncompleteReason = result.incompleteReason ?? null;
		return result.text;
	}

	private async completeOpenAIText(
		request: AskRequest,
		onDelta: (delta: string) => void,
		abortSignal?: AbortSignal
	): Promise<ProviderTextResult> {
		const model = request.metadata.selectedModel;

		if (getModelCapability(model) !== "text") {
			throw new Error("gpt-image-2 generates images and does not support AskMate text streaming.");
		}

		return await this.completeOpenAIResponsesText(
			request,
			{
				providerId: "openai",
				providerName: getProviderLabel("openai"),
				model,
				capability: "text"
			},
			buildTextInstructions(),
			buildPrompt(request),
			"text_response",
			abortSignal,
			onDelta
		);
	}

	/**
	 * One Responses API call with exactly one usage record per operation. Image prompt planning is recorded by
	 * prepareImagePrompt instead, because only it knows whether the plan was usable or fell back.
	 */
	private async completeOpenAIResponsesText(
		request: AskRequest,
		providerRef: ProviderModelRef,
		instructions: string,
		input: string,
		operationKind: OperationKind,
		abortSignal: AbortSignal | undefined,
		onDelta: (delta: string) => void = () => undefined
	): Promise<ProviderTextResult> {
		const isPlanning = operationKind === "image_prompt_planning";
		const apiKey = await this.host.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error(isPlanning
				? "Add an OpenAI API key in AskMate settings before generating an image."
				: "Add an OpenAI API key in AskMate settings before asking a question.");
		}

		const endpoint: ApiEndpoint = "responses";
		const startedAt = new Date();
		let answer = "";
		let usage: OpenAITokenUsage | null = null;
		let usageRecorded = false;
		const record = async (status: OperationStatus, errorMessage?: string): Promise<void> => {
			usageRecorded = true;
			await this.host.recordOperationUsage({
				request,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				operationKind,
				endpoint,
				status,
				model: providerRef.model,
				instructions,
				input,
				responseText: answer,
				usage,
				startedAt,
				errorMessage
			});
		};

		try {
			const response = await requestOpenAIResponses(this.host.getProviderRuntime(), {
				apiKey,
				model: providerRef.model,
				instructions,
				input,
				reasoningEffort: request.metadata.reasoningEffort,
				abortSignal,
			});
			const body = response.body;
			usage = body?.usage ?? null;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await record("failed", message);
				throw new Error(message);
			}

			this.host.throwIfAborted(abortSignal);
			const outcome = readOpenAIResponseText(body);
			answer = outcome.text;
			onDelta(answer);
			if (!isPlanning) {
				await record("completed");
				this.host.throwIfAborted(abortSignal);
			}
			return {
				text: answer,
				model: providerRef.model,
				endpoint,
				usage,
				incompleteReason: outcome.incompleteReason
			};
		} catch (error) {
			if (!usageRecorded) {
				await record(isAbortError(error) ? "aborted" : "failed", this.host.getErrorMessage(error));
			}

			throw error;
		}
	}

	async completeProviderText(
		request: AskRequest,
		providerRef: ProviderModelRef,
		instructions: string,
		input: string,
		operationKind: OperationKind,
		abortSignal: AbortSignal | undefined,
		onDelta: (delta: string) => void = () => undefined
	): Promise<ProviderTextResult> {
		const startedAt = new Date();
		let answer = "";
		let usage: OpenAITokenUsage | null = null;
		let endpoint: ApiEndpoint = getProviderTextEndpoint(providerRef.providerId);
		let usageRecorded = false;

		try {
			const result = await completeProviderTextRequest(this.host.getProviderRuntime(), providerRef, instructions, input, abortSignal);
			answer = result.text;
			usage = result.usage;
			endpoint = result.endpoint;
			const incompleteReason = result.incompleteReason ?? null;
			this.host.throwIfAborted(abortSignal);

			if (!answer.trim() && operationKind !== "image_prompt_planning") {
				throw new Error(incompleteReason
					? `${providerRef.providerName} returned no text. The response stopped with reason "${incompleteReason}".`
					: `${providerRef.providerName} returned a response, but no text output was found.`);
			}

			onDelta(answer);
			if (operationKind !== "image_prompt_planning") {
				await this.host.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind,
					endpoint,
					status: "completed",
					model: providerRef.model,
					instructions,
					input,
					responseText: answer,
					usage,
					startedAt
				});
				usageRecorded = true;
				this.host.throwIfAborted(abortSignal);
			}
			return { ...result, text: answer.trim(), incompleteReason };
		} catch (error) {
			if (!usageRecorded) {
				await this.host.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind,
					endpoint,
					status: isAbortError(error) ? "aborted" : "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: answer,
					usage,
					startedAt,
					errorMessage: this.host.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	async completeOpenAIPlanningText(
		request: AskRequest,
		providerRef: ProviderModelRef,
		instructions: string,
		input: string,
		abortSignal?: AbortSignal
	): Promise<ProviderTextResult> {
		return await this.completeOpenAIResponsesText(request, providerRef, instructions, input, "image_prompt_planning", abortSignal);
	}

	async generateOpenAIImage(
		request: AskRequest,
		abortSignal?: AbortSignal,
		imagePromptPlan?: ImagePromptPlan
	): Promise<ImageAskMateResult> {
		const apiKey = await this.host.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before generating an image.");
		}

		const model = GPT_IMAGE_2_MODEL_ID;
		const promptPlan = imagePromptPlan ?? {
			prompt: buildFallbackImagePrompt(request),
			planningModel: this.host.getImagePlanningModel(),
			status: "fallback" as const,
			fallbackReason: "Image prompt planning was not available."
		};
		const prompt = promptPlan.prompt.trim() || buildFallbackImagePrompt(request);
		const startedAt = new Date();
		let usage: OpenAITokenUsage | null = null;
		let responseText = "";
		let usageRecorded = false;
		const record = async (status: OperationStatus, errorMessage?: string): Promise<void> => {
			usageRecorded = true;
			await this.host.recordOperationUsage({
				request,
				providerId: "openai",
				providerName: getProviderLabel("openai"),
				operationKind: "image_generation",
				endpoint: "images_generations",
				status,
				model,
				instructions: "OpenAI Images API generation",
				input: prompt,
				responseText,
				usage,
				startedAt,
				errorMessage
			});
		};

		try {
			const response = await requestOpenAIImageGeneration(this.host.getProviderRuntime(), {
				apiKey,
				model,
				prompt,
				abortSignal
			});
			const body = response.body;
			usage = readImageGenerationUsage(body);

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await record("failed", message);
				throw new Error(message);
			}

			this.host.throwIfAborted(abortSignal);
			const image = body?.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.trim());
			const base64 = image?.b64_json?.trim() ?? "";

			if (!base64) {
				throw new Error("OpenAI returned an image response, but no base64 image data was found.");
			}

			// A cheap shape check here; the plugin decodes the data once, when it saves the image.
			if (!isWellFormedBase64(base64)) {
				throw new Error("OpenAI returned image data that is not valid base64.");
			}

			const revisedPrompt = image?.revised_prompt?.trim() || null;
			responseText = revisedPrompt ?? "";
			await record("completed");
			this.host.throwIfAborted(abortSignal);

			return {
				kind: "image",
				model,
				promptPlan,
				image: {
					mimeType: IMAGE_MIME_TYPE,
					base64,
					prompt,
					revisedPrompt,
					createdAt: new Date().toISOString(),
					savedImagePath: null
				}
			};
		} catch (error) {
			if (!usageRecorded) {
				await record(isAbortError(error) ? "aborted" : "failed", this.host.getErrorMessage(error));
			}

			throw error;
		}
	}

	async prepareImagePrompt(request: AskRequest, abortSignal?: AbortSignal): Promise<ImagePromptPlan> {
		const providerRef = this.host.getImagePlanningProviderRef();
		const instructions = buildImagePromptPlanningInstructions();
		const input = buildImagePromptPlanningInput(request);
		const startedAt = new Date();

		try {
			const planned = providerRef.providerId === "openai"
				? await this.completeOpenAIPlanningText(request, providerRef, instructions, input, abortSignal)
				: await this.completeProviderText(request, providerRef, instructions, input, "image_prompt_planning", abortSignal);
			const extraction = extractPlannedImagePrompt(planned.text);
			const status: ImagePromptPlan["status"] = extraction.prompt ? "completed" : "fallback";
			await this.host.recordOperationUsage({
				request,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				operationKind: "image_prompt_planning",
				endpoint: planned.endpoint,
				status,
				model: providerRef.model,
				instructions,
				input,
				responseText: planned.text,
				usage: planned.usage,
				startedAt,
				errorMessage: extraction.fallbackReason ?? ""
			});
			this.host.throwIfAborted(abortSignal);

			return {
				prompt: extraction.prompt || buildFallbackImagePrompt(request),
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status,
				fallbackReason: extraction.fallbackReason
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			console.warn("AskMate image prompt planning failed. Falling back to the direct image prompt.", error);
			return {
				prompt: buildFallbackImagePrompt(request),
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status: "fallback",
				fallbackReason: this.host.getErrorMessage(error)
			};
		}
	}
}

/**
 * Reads the answer from a Responses API body. A failed response, a refusal or an empty answer throws an error that
 * names the cause; an incomplete response with text is returned with its reason so callers can warn before Apply.
 */
export function readOpenAIResponseText(body: OpenAIResponseBody | null): { text: string; incompleteReason: string | null } {
	if (body?.status === "failed") {
		const detail = body.error?.message?.trim();
		throw new Error(detail
			? `OpenAI could not complete the response. Provider message: ${detail}`
			: "OpenAI could not complete the response and did not give a reason.");
	}

	const incompleteReason = body?.status === "incomplete" ? body.incomplete_details?.reason?.trim() || "unknown" : null;
	const text = extractOpenAIText(body);

	if (text) {
		return { text, incompleteReason };
	}

	const refusal = extractOpenAIRefusal(body);

	if (refusal) {
		throw new Error(`OpenAI refused the request. Provider message: ${refusal}`);
	}

	if (incompleteReason) {
		throw new Error(`OpenAI returned no text. The response stopped with reason "${incompleteReason}", which usually means the output token limit or a content filter.`);
	}

	throw new Error("OpenAI returned a response, but no text output was found.");
}

/** normalizePlannedPrompt caps planned prompts at this length, so the fallback never sends more note text than a plan would. */
export const MAX_FALLBACK_IMAGE_PROMPT_CHARACTERS = 12000;
const FALLBACK_CONTEXT_NOTICE = "[AskMate shortened the note context for this image prompt.]";

/**
 * The direct image prompt used when planning fails or returns no usable prompt. A long note is cut to an excerpt of
 * the primary note, without attachments, so the prompt stays within the planned-prompt cap.
 */
export function buildFallbackImagePrompt(request: AskRequest, maxCharacters = MAX_FALLBACK_IMAGE_PROMPT_CHARACTERS): string {
	const full = buildImagePrompt(request);

	if (full.length <= maxCharacters) {
		return full;
	}

	const withExcerpt = (excerpt: string): string => buildImagePrompt({
		...request,
		context: {
			...request.context,
			content: excerpt ? `${excerpt}\n\n${FALLBACK_CONTEXT_NOTICE}` : FALLBACK_CONTEXT_NOTICE,
			attachments: []
		}
	});
	const overhead = withExcerpt("").length;

	// Escaping and image-reference stripping can change the excerpt's length, so shrink until the prompt fits.
	for (let allowance = maxCharacters - overhead - 2; allowance > 0; allowance = Math.floor(allowance / 2)) {
		const prompt = withExcerpt(truncateAtCodePoint(request.context.content, allowance).trimEnd());
		if (prompt.length <= maxCharacters) {
			return prompt;
		}
	}

	return truncateAtCodePoint(withExcerpt(""), maxCharacters);
}

/** gpt-image responses report token usage, which OpenAIImageGenerationBody does not declare yet. */
export function readImageGenerationUsage(body: OpenAIImageGenerationBody | null): OpenAITokenUsage | null {
	const usage: unknown = body !== null && "usage" in body ? body.usage : null;

	if (typeof usage !== "object" || usage === null) {
		return null;
	}

	const input = "input_tokens" in usage && typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
	const output = "output_tokens" in usage && typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
	const total = "total_tokens" in usage && typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;

	if (input === undefined && output === undefined && total === undefined) {
		return null;
	}

	return { input_tokens: input, output_tokens: output, total_tokens: total };
}

/** Same acceptance rules as atob (optional data URI prefix, whitespace, optional padding) without decoding. */
export function isWellFormedBase64(value: string): boolean {
	const clean = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s/g, "");
	const lengthIsValid = clean.endsWith("=") ? clean.length % 4 === 0 : clean.length % 4 !== 1;
	return lengthIsValid && /^[A-Za-z0-9+/]+={0,2}$/.test(clean);
}
