import { FuzzySuggestModal, type App } from "obsidian";
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
	}

	getItems(): ModelChoice[] {
		return [...this.choices];
	}

	getItemText(choice: ModelChoice): string {
		const isCurrent = choice.providerId === this.current.providerId && choice.model === this.current.model;
		return `${choice.providerName}: ${choice.model}${isCurrent ? " (current)" : ""}`;
	}

	onChooseItem(choice: ModelChoice): void {
		this.onChoose(choice);
	}
}
