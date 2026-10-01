import { GPT_IMAGE_2_MODEL_ID } from "../settings/constants";
import type { ModelCapability, ReasoningEffort } from "./types";

export const GPT_5_5_MODEL_PATTERN = /^gpt-5\.5(?:$|-)/;
const IMAGE_MODEL_PATTERN = /^(?:gpt-image-|dall-e-)/;
const GPT_5_FAMILY_PATTERN = /^gpt-5(?:$|[.-])/;
const O_SERIES_PATTERN = /^o\d(?:$|-)/;
// The earliest o1 previews reject `reasoning.effort`.
const O_SERIES_WITHOUT_EFFORT_PATTERN = /^o1-(?:mini|preview)(?:$|-)/;
// Model families returned by /models that cannot answer a Responses text request.
const NON_TEXT_MODEL_PATTERN = /(?:^|-)(?:embedding|tts|whisper|transcribe|moderation|audio|realtime|search|instruct|davinci|babbage|computer-use)(?:$|-)|^(?:text-|omni-moderation|sora)/;

export function isGpt55Model(model: string): boolean {
	return GPT_5_5_MODEL_PATTERN.test(model.trim());
}

export function isGptImage2Model(model: string): boolean {
	return model.trim() === GPT_IMAGE_2_MODEL_ID;
}

export function isImageModel(model: string): boolean {
	return IMAGE_MODEL_PATTERN.test(model.trim());
}

export function getModelCapability(model: string): ModelCapability {
	return isImageModel(model) ? "image" : "text";
}

/** True for OpenAI model IDs that can answer a Responses API text request. */
export function isOpenAITextModel(model: string): boolean {
	const id = model.trim();
	return Boolean(id) && !isImageModel(id) && !NON_TEXT_MODEL_PATTERN.test(id);
}

/**
 * Returns the `reasoning.effort` value to send, or null when the model rejects the parameter.
 * The o-series accepts only low, medium and high, so the AskMate extremes are clamped to that range.
 */
export function getSupportedReasoningEffort(model: string, effort: ReasoningEffort): ReasoningEffort | null {
	const id = model.trim();

	if (O_SERIES_WITHOUT_EFFORT_PATTERN.test(id)) {
		return null;
	}

	if (O_SERIES_PATTERN.test(id)) {
		return effort === "none" ? "low" : effort === "xhigh" ? "high" : effort;
	}

	if (GPT_5_FAMILY_PATTERN.test(id) && !/-chat(?:$|-)/.test(id)) {
		return clampGpt5ReasoningEffort(id, effort);
	}

	return null;
}

// Effort levels differ inside the GPT-5 family. These limits follow OpenAI's model notes as of 2026; an unknown newer
// model is passed through unchanged.
const GPT_5_ORIGINAL_PATTERN = /^gpt-5(?:-(?:mini|nano|codex))?(?:-\d{4}-\d{2}-\d{2})?$/;
const GPT_5_ORIGINAL_PRO_PATTERN = /^gpt-5-pro(?:$|-)/;
const GPT_5_POINT_PRO_PATTERN = /^gpt-5\.\d+-pro(?:$|-)/;
const GPT_5_1_PATTERN = /^gpt-5\.1(?:$|-)/;

function clampGpt5ReasoningEffort(id: string, effort: ReasoningEffort): ReasoningEffort {
	if (GPT_5_ORIGINAL_PRO_PATTERN.test(id)) {
		// gpt-5-pro accepts only high.
		return "high";
	}
	if (GPT_5_POINT_PRO_PATTERN.test(id)) {
		// Later pro models start at medium.
		return effort === "none" || effort === "low" ? "medium" : effort;
	}
	if (GPT_5_ORIGINAL_PATTERN.test(id)) {
		// The original gpt-5 models have no "none" (their lowest is "minimal") and no "xhigh".
		return effort === "none" ? "low" : effort === "xhigh" ? "high" : effort;
	}
	if (GPT_5_1_PATTERN.test(id) && !/-codex-max(?:$|-)/.test(id)) {
		// gpt-5.1 added "none"; "xhigh" arrived later (gpt-5.1-codex-max, then gpt-5.2).
		return effort === "xhigh" ? "high" : effort;
	}
	return effort;
}
