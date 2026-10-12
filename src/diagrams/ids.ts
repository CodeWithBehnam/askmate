// Mermaid needs a unique element id for every render. A counter is enough: ids only have to differ within one session.

export function createIdFactory(prefix = "askmate-mmd"): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		return `${prefix}-${counter}`;
	};
}

/** Shared by the pipeline and the preview card, so a card render can never collide with a validation render. */
export const nextRenderId: () => string = createIdFactory();
