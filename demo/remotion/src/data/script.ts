export const demoNote = {
	title: "Product sync notes",
	path: "Vault/Meetings/Product sync.md",
	lines: [
		"# Product sync notes",
		"",
		"- Launch page positioning is still fuzzy.",
		"- Support asked for safer AI-generated edits.",
		"- Research team wants evidence-backed summaries.",
		"- The meeting produced action items, but they are scattered.",
		"- We need provider flexibility for different teams.",
		"",
		"Rough draft:",
		"AskMate helps with notes and AI stuff. It can answer things and change text.",
	],
};

export const promptText = "Summarize this note into decisions and action items.";

export const summaryBullets = [
	"Clarify launch messaging around note-aware AI.",
	"Use diff preview before applying generated edits.",
	"Ship reusable workflows for research and meetings.",
];

export const workflows = [
	"Summary",
	"Action plan",
	"Critique",
	"Pros and cons",
	"Translation",
	"Decision brief",
];

export const diffRows = [
	{
		kind: "removed",
		text: "AskMate helps with notes and AI stuff. It can answer things and change text.",
	},
	{
		kind: "added",
		text: "AskMate brings note-aware AI Q&A, summaries, workflows, and reviewed edits directly into Obsidian.",
	},
];

export const providers = [
	"OpenAI",
	"Azure OpenAI",
	"OpenRouter",
	"Anthropic",
	"Gemini",
	"Local endpoint",
];

export const privacyPoints = [
	"No telemetry",
	"Only request context is sent",
	"API keys use SecretStorage",
	"Prompt inspector stays local",
];
