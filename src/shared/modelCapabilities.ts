import { GPT_IMAGE_2_MODEL_ID } from "../settings/constants";
import type { ModelCapability } from "./types";

export const GPT_5_5_MODEL_PATTERN = /^gpt-5\.5(?:$|-)/;

export function isGpt55Model(model: string): boolean {
	return GPT_5_5_MODEL_PATTERN.test(model.trim());
}

export function isGptImage2Model(model: string): boolean {
	return model.trim() === GPT_IMAGE_2_MODEL_ID;
}

export function getModelCapability(model: string): ModelCapability {
	return isGptImage2Model(model) ? "image" : "text";
}
