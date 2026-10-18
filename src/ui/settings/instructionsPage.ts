import { Setting, type App } from "obsidian";
import {
	MAX_FOLDER_INSTRUCTION_LENGTH,
	MAX_FOLDER_INSTRUCTION_RULES,
	MAX_GLOBAL_INSTRUCTIONS_LENGTH,
	normalizeFolderInstructions,
	normalizeGlobalInstructions
} from "../../settings/customInstructions";
import type { AskMateSettings, FolderInstruction } from "../../shared/types";
import { attachFolderSuggest } from "./pathSuggest";

/** The folder box of the rule at this position, found by the name the page gives it. */
function folderInput(containerEl: HTMLElement, index: number): HTMLElement | null {
	return containerEl.querySelector<HTMLElement>(`input[aria-label='Folder rule ${index + 1}: folder']`);
}

/**
 * Draws the "Instructions" page. Folder rules are edited as a draft owned by the caller, because the saved list drops
 * rules that are still empty and a half-typed rule must stay on screen, even across a redraw, until it is complete.
 */
export function renderInstructionsPage(
	app: App,
	settings: AskMateSettings,
	draft: FolderInstruction[],
	containerEl: HTMLElement,
	refresh: () => void,
	scheduleSave: () => void
): void {
	containerEl.createEl("p", {
		cls: "askmate-settings-note",
		text: "Tell AskMate how to answer you. These instructions are added to every text request: questions, workflows, and batch runs. They never override AskMate's safety, evidence, or apply output rules. Image generation ignores them."
	});

	new Setting(containerEl)
		.setName("Instructions for every request")
		.setDesc("For example: answer in British English, keep a formal tone, write for a first-year student, prefer bullet points.")
		.addTextArea((text) => {
			text.inputEl.rows = 5;
			text.inputEl.addClass("askmate-settings-prompt-input");
			text.inputEl.setAttribute("aria-label", "Instructions for every request");
			text.inputEl.dir = "auto";
			text.inputEl.maxLength = MAX_GLOBAL_INSTRUCTIONS_LENGTH;
			text.setValue(settings.globalInstructions).onChange((value) => {
				settings.globalInstructions = normalizeGlobalInstructions(value);
				scheduleSave();
			});
		});

	const persist = (): void => {
		settings.folderInstructions = normalizeFolderInstructions(draft);
		scheduleSave();
	};

	new Setting(containerEl)
		.setName("Folder instructions")
		.setHeading()
		.setDesc("Extra instructions for notes inside a folder, including its subfolders. They follow the instructions above, and a more specific folder comes last. Rules with an empty folder or empty text are not saved.");

	draft.forEach((rule, index) => {
		const label = `Folder rule ${index + 1}`;
		new Setting(containerEl)
			.setName(label)
			.addText((text) => {
				text.inputEl.setAttribute("aria-label", `${label}: folder`);
				text.setPlaceholder("Folder path, for example projects/client").setValue(rule.folder).onChange((value) => {
					rule.folder = value;
					persist();
				});
				attachFolderSuggest(app, text.inputEl, (path) => {
					text.setValue(path);
					rule.folder = path;
					persist();
				});
			})
			.addExtraButton((button) => {
				button.setIcon("trash").setTooltip(`Remove ${label.toLowerCase()}`).onClick(() => {
					draft.splice(index, 1);
					persist();
					refresh();
					// The page was redrawn, so focus goes to the rule that took this one's place, or to the add button when none is left.
					const next = draft.length > 0 ? folderInput(containerEl, Math.min(index, draft.length - 1)) : containerEl.querySelector<HTMLElement>("button[aria-label='Add folder rule']");
					next?.focus();
				});
				button.extraSettingsEl.setAttribute("role", "button");
				button.extraSettingsEl.setAttribute("tabindex", "0");
				button.extraSettingsEl.setAttribute("aria-label", `Remove ${label.toLowerCase()}`);
			});
		new Setting(containerEl)
			.setClass("askmate-folder-rule-text")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text.inputEl.addClass("askmate-settings-prompt-input");
				text.inputEl.setAttribute("aria-label", `${label}: instructions`);
				text.inputEl.dir = "auto";
				text.inputEl.maxLength = MAX_FOLDER_INSTRUCTION_LENGTH;
				text.setPlaceholder("Instructions for notes in this folder").setValue(rule.instructions).onChange((value) => {
					rule.instructions = value;
					persist();
				});
			});
	});

	new Setting(containerEl)
		.addButton((button) => {
			button.buttonEl.setAttribute("aria-label", "Add folder rule");
			button.setButtonText("Add folder rule").setDisabled(draft.length >= MAX_FOLDER_INSTRUCTION_RULES).onClick(() => {
				draft.push({ folder: "", instructions: "" });
				refresh();
				// The page was redrawn, so the new rule's folder box takes focus and typing can start at once.
				folderInput(containerEl, draft.length - 1)?.focus();
			});
		})
		.setDesc(draft.length >= MAX_FOLDER_INSTRUCTION_RULES ? `AskMate keeps up to ${MAX_FOLDER_INSTRUCTION_RULES} folder rules.` : "");
}
