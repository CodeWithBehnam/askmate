/**
 * Keeps track of the one palette or menu run that may be in flight. A second run is refused instead of starting a
 * second paid request, Stop aborts the first, and unloading the plugin aborts it too. Pure bookkeeping: the plugin owns
 * the notices and the requests.
 */

export interface CommandRun {
	readonly id: number;
	readonly label: string;
	readonly signal: AbortSignal;
	/** Releases the slot. Safe to call twice, and a no-op once another run has taken over. */
	finish(): void;
}

export class CommandRunRegistry {
	private active: { id: number; label: string; controller: AbortController } | null = null;
	private counter = 0;

	/** Starts a run, or returns null when one is already running. */
	begin(label: string): CommandRun | null {
		if (this.active) {
			return null;
		}
		this.counter += 1;
		const id = this.counter;
		const controller = new AbortController();
		this.active = { id, label, controller };
		return {
			id,
			label,
			signal: controller.signal,
			finish: () => {
				if (this.active?.id === id) {
					this.active = null;
				}
			}
		};
	}

	/** Name of the running command, or null when nothing runs. */
	current(): string | null {
		return this.active?.label ?? null;
	}

	/** Aborts the running command. True when there was one. */
	stop(): boolean {
		if (!this.active) {
			return false;
		}
		this.active.controller.abort();
		return true;
	}
}
