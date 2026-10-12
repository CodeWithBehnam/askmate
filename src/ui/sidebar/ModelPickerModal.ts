import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type { ModelChoice } from "./modelSwitch";

export class ModelPickerModal extends FuzzySuggestModal<ModelChoice> {
	constructor(
		app: App,
		private readonly choices: readonly ModelChoice[],
		private readonly current: { providerId: string; model: string },
		private readonly onChoose: (choice: ModelChoice) => void
	) {
		super(app);
		this.setPlaceholder("Switch provider and model");
		this.emptyStateText = "No model matches. For an ID that is not listed, close this and type /model <id>! in the composer.";
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to switch" },
			{ command: "esc", purpose: "to dismiss" }
		]);
	}

	getItems(): ModelChoice[] {
		return [...this.choices];
	}

	// The searchable text stays free of the "(current)" marker, so typing "current" does not match every row.
	getItemText(choice: ModelChoice): string {
		return `${choice.providerName}: ${choice.model}`;
	}

	renderSuggestion(match: FuzzyMatch<ModelChoice>, el: HTMLElement): void {
		// The default draws the fuzzy-match highlighting; the marker is added after it.
		super.renderSuggestion(match, el);
		const choice = match.item;
		if (choice.providerId === this.current.providerId && choice.model === this.current.model) {
			el.appendText(" (current)");
		}
	}

	onChooseItem(choice: ModelChoice): void {
		this.onChoose(choice);
	}
}
