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
	OpenAITokenUsage,
	OperationKind,
	OperationStatus,
	ProviderModelRef,
	ReasoningEffort,
	RequestIntentKind,
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
	normalizeRequestPrivacyOptions,
	normalizeTextProviderId
} from "../shared/core";
import {
	completeProviderTextRequest,
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
	extractPlannedImagePrompt
} from "./requestBuilders";

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
	expandWorkflowPrompt: (workflow: NonNullable<BuildRequestOptions["workflow"]>, context: NoteContext, sanitized: string) => string;
	getNoteContext: (editor?: Editor, file?: TFile | null) => Promise<NoteContext>;
	getFileNoteContext: (file: TFile) => Promise<NoteContext>;
	buildContextAttachments: (
		context: NoteContext,
		options: BuildRequestOptions,
		privacy: AskRequest["metadata"]["privacy"]
	) => Promise<ContextAttachment[]>;
	throwIfAborted: (abortSignal?: AbortSignal) => void;
	decodeBase64Image: (base64: string) => ArrayBuffer;
};

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

	async buildRequest(question: string, title: string, options: BuildRequestOptions = {}): Promise<AskRequest> {
		const settings = this.host.getSettings();
		const intentKind = this.classifyRequestIntent(question, options);
		const providerRef = this.host.getSelectedProviderModelRef();
		const selectedModel = providerRef.model;
		const forceImage = options.forceImage === true || intentKind === "explicit_image";
		const autoImage = options.autoImage === true || intentKind === "auto_image";
		const context = options.forceFileContext && options.file instanceof TFile && options.file.extension === "md"
			? await this.host.getFileNoteContext(options.file)
			: await this.host.getNoteContext(options.editor, options.file);
		const privacy = normalizeRequestPrivacyOptions({ ...settings.requestPrivacyDefaults, ...options.privacy });
		const contextBudgetMode = normalizeContextBudgetMode(options.contextBudgetMode ?? settings.contextBudgetMode);
		const attachments = await this.host.buildContextAttachments(context, options, privacy);
		const contextWithAttachments: NoteContext = {
			...context,
			attachments
		};
		const promptContext = buildPromptContextContent(contextWithAttachments, privacy, contextBudgetMode);
		const primaryPromptContext = buildPromptContextContent({ ...context, attachments: [] }, privacy, contextBudgetMode);
		const workflowVariableContext = privacy.includeNoteContext ? primaryPromptContext.text : "";
		const requestQuestion = options.workflow ? this.host.expandWorkflowPrompt(options.workflow, contextWithAttachments, workflowVariableContext) : question;
		const folderAttachments = attachments.filter((attachment) => attachment.kind === "folder_note");
		const evidenceSources = privacy.includeNoteContext && providerRef.capability === "text" && !forceImage && !autoImage
			? buildEvidenceSources(settings, contextWithAttachments)
			: [];

		return {
			context: contextWithAttachments,
			question: requestQuestion,
			title,
			evidenceSources,
			metadata: {
				intentKind,
				commandSource: options.commandSource ?? "sidebar",
				outputMode: options.outputMode ?? settings.outputMode,
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
		const text = providerId === "openai"
			? await this.streamOpenAI(request, onDelta, options.abortSignal)
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
		return {
			kind: "text",
			model,
			text
		};
	}

	async streamOpenAI(
		request: AskRequest,
		onDelta: (delta: string) => void,
		abortSignal?: AbortSignal
	): Promise<string> {
		const apiKey = await this.host.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before asking a question.");
		}

		const model = request.metadata.selectedModel;

		if (getModelCapability(model) !== "text") {
			throw new Error("gpt-image-2 generates images and does not support AskMate text streaming.");
		}

		const reasoningEffort = request.metadata.reasoningEffort;
		const instructions = buildTextInstructions();
		const input = buildPrompt(request);
		const startedAt = new Date();
		let answer = "";
		let usageRecorded = false;

		try {
			const response = await requestOpenAIResponses(this.host.getProviderRuntime(), {
				apiKey,
				model,
				instructions,
				input,
				reasoningEffort,
				abortSignal,
			});
			const body = response.body;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.host.recordOperationUsage({
					request,
					operationKind: "text_response",
					endpoint: "responses",
					status: "failed",
					model,
					instructions,
					input,
					responseText: "",
					usage: body?.usage ?? null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			answer = extractOpenAIText(body);

			if (!answer) {
				throw new Error("OpenAI returned a response, but no text output was found.");
			}

			onDelta(answer);
			await this.host.recordOperationUsage({
				request,
				operationKind: "text_response",
				endpoint: "responses",
				status: "completed",
				model,
				instructions,
				input,
				responseText: answer,
				usage: body?.usage ?? null,
				startedAt
			});
			usageRecorded = true;
			return answer.trim();
		} catch (error) {
			if (!usageRecorded) {
				const status: OperationStatus = isAbortError(error) ? "aborted" : "failed";
				await this.host.recordOperationUsage({
					request,
					operationKind: "text_response",
					endpoint: "responses",
					status,
					model,
					instructions,
					input,
					responseText: answer,
					usage: null,
					startedAt,
					errorMessage: this.host.getErrorMessage(error)
				});
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
	): Promise<string> {
		const startedAt = new Date();
		let answer = "";
		let usage: OpenAITokenUsage | null = null;
		let endpoint: ApiEndpoint = "chat_completions";
		let usageRecorded = false;

		try {
			const result = await completeProviderTextRequest(this.host.getProviderRuntime(), providerRef, instructions, input, abortSignal);
			answer = result.text;
			usage = result.usage;
			endpoint = result.endpoint;

			if (!answer.trim() && operationKind !== "image_prompt_planning") {
				throw new Error(`${providerRef.providerName} returned a response, but no text output was found.`);
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
			}
			return answer.trim();
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
	): Promise<string> {
		const apiKey = await this.host.getOpenAiApiKey();

		if (!apiKey) {
			throw new Error("Add an OpenAI API key in AskMate settings before generating an image.");
		}

		const startedAt = new Date();
		let usageRecorded = false;

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

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.host.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind: "image_prompt_planning",
					endpoint: "responses",
					status: "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: "",
					usage: body?.usage ?? null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			return extractOpenAIText(body);
		} catch (error) {
			if (!usageRecorded) {
				await this.host.recordOperationUsage({
					request,
					providerId: providerRef.providerId,
					providerName: providerRef.providerName,
					operationKind: "image_prompt_planning",
					endpoint: "responses",
					status: isAbortError(error) ? "aborted" : "failed",
					model: providerRef.model,
					instructions,
					input,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: this.host.getErrorMessage(error)
				});
			}

			throw error;
		}
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
			prompt: buildImagePrompt(request),
			planningModel: this.host.getImagePlanningModel(),
			status: "fallback" as const,
			fallbackReason: "Image prompt planning was not available."
		};
		const prompt = promptPlan.prompt.trim() || buildImagePrompt(request);
		const startedAt = new Date();
		let usageRecorded = false;

		try {
			const response = await requestOpenAIImageGeneration(this.host.getProviderRuntime(), {
				apiKey,
				model,
				prompt,
				abortSignal
			});
			const body = response.body;

			if (!response.ok) {
				const message = formatProviderHttpError("OpenAI", response.status, body?.error?.message ?? "");
				await this.host.recordOperationUsage({
					request,
					providerId: "openai",
					providerName: getProviderLabel("openai"),
					operationKind: "image_generation",
					endpoint: "images_generations",
					status: "failed",
					model,
					instructions: "OpenAI Images API generation",
					input: prompt,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: message
				});
				usageRecorded = true;
				throw new Error(message);
			}

			const image = body?.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.trim());
			const base64 = image?.b64_json?.trim() ?? "";

			if (!base64) {
				throw new Error("OpenAI returned an image response, but no base64 image data was found.");
			}

			this.host.decodeBase64Image(base64);
			await this.host.recordOperationUsage({
				request,
				providerId: "openai",
				providerName: getProviderLabel("openai"),
				operationKind: "image_generation",
				endpoint: "images_generations",
				status: "completed",
				model,
				instructions: "OpenAI Images API generation",
				input: prompt,
				responseText: image?.revised_prompt?.trim() ?? "",
				usage: null,
				startedAt
			});
			usageRecorded = true;

			return {
				kind: "image",
				model,
				promptPlan,
				image: {
					mimeType: IMAGE_MIME_TYPE,
					base64,
					prompt,
					revisedPrompt: image?.revised_prompt?.trim() || null,
					createdAt: new Date().toISOString(),
					savedImagePath: null
				}
			};
		} catch (error) {
			if (!usageRecorded) {
				await this.host.recordOperationUsage({
					request,
					providerId: "openai",
					providerName: getProviderLabel("openai"),
					operationKind: "image_generation",
					endpoint: "images_generations",
					status: isAbortError(error) ? "aborted" : "failed",
					model,
					instructions: "OpenAI Images API generation",
					input: prompt,
					responseText: "",
					usage: null,
					startedAt,
					errorMessage: this.host.getErrorMessage(error)
				});
			}

			throw error;
		}
	}

	async prepareImagePrompt(request: AskRequest, abortSignal?: AbortSignal): Promise<ImagePromptPlan> {
		const providerRef = this.host.getImagePlanningProviderRef();
		const instructions = buildImagePromptPlanningInstructions();
		const input = buildImagePromptPlanningInput(request);
		const startedAt = new Date();
		const endpoint: ApiEndpoint = getProviderTextEndpoint(providerRef.providerId);

		try {
			const plannedText = providerRef.providerId === "openai"
				? await this.completeOpenAIPlanningText(request, providerRef, instructions, input, abortSignal)
				: await this.completeProviderText(request, providerRef, instructions, input, "image_prompt_planning", abortSignal);
			const extraction = extractPlannedImagePrompt(plannedText);
			const prompt = extraction.prompt || buildImagePrompt(request);
			const status: OperationStatus = extraction.prompt ? "completed" : "fallback";
			await this.host.recordOperationUsage({
				request,
				providerId: providerRef.providerId,
				providerName: providerRef.providerName,
				operationKind: "image_prompt_planning",
				endpoint,
				status,
				model: providerRef.model,
				instructions,
				input,
				responseText: plannedText,
				usage: null,
				startedAt,
				errorMessage: extraction.fallbackReason ?? ""
			});

			return {
				prompt,
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status: extraction.prompt ? "completed" : "fallback",
				fallbackReason: extraction.fallbackReason
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			console.warn("AskMate image prompt planning failed. Falling back to the direct image prompt.", error);
			return {
				prompt: buildImagePrompt(request),
				planningModel: `${providerRef.providerName}: ${providerRef.model}`,
				status: "fallback",
				fallbackReason: this.host.getErrorMessage(error)
			};
		}
	}
}
