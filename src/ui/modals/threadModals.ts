import { FuzzySuggestModal, type App } from "obsidian";
import { formatRelativeTime, type SavedThread } from "../../threads/threadModel";

/** Picks one saved conversation. The same picker serves switching and deleting; the caller owns any confirmation. */
export class AskMateThreadPickerModal extends FuzzySuggestModal<SavedThread> {
	constructor(
		app: App,
		private readonly threads: readonly SavedThread[],
		private readonly activeId: string | null,
		purpose: "switch" | "delete",
		private readonly onChoose: (thread: SavedThread) => void
	) {
		super(app);
		this.setPlaceholder(purpose === "delete" ? "Choose a conversation to delete" : "Switch to a saved conversation");
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: purpose === "delete" ? "delete" : "open" },
			{ command: "esc", purpose: "close" }
		]);
	}

	getItems(): SavedThread[] {
		return [...this.threads];
	}

	getItemText(thread: SavedThread): string {
		const marker = thread.id === this.activeId ? " (current)" : "";
		const turns = thread.messages.filter((message) => message.role === "user").length;
		return `${thread.title}${marker} · ${formatRelativeTime(thread.updatedAt, Date.now())} · ${turns} ${turns === 1 ? "question" : "questions"}`;
	}

	onChooseItem(thread: SavedThread): void {
		this.onChoose(thread);
	}
}
