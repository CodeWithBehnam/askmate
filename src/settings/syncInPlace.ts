function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copy `source` into `target` while keeping the identity of every nested plain object in `target`.
 * Settings UI, services and in-flight requests hold references to nested settings objects across awaits,
 * so replacing the settings graph on save would detach those references and silently drop later edits.
 * Values that are not plain objects (arrays, primitives) are deep-cloned so the live settings never share
 * mutable state with defaults.
 * Keys the target has and the source lacks are removed, so the source must carry every key that should survive.
 * Normalisation does that for keys it does not know, which keeps a newer build's data alive.
 */
export function syncObjectInPlace<T extends object>(target: T, source: T): void {
	syncRecordInPlace(target as Record<string, unknown>, source as Record<string, unknown>);
}

function syncRecordInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(target)) {
		if (!(key in source)) {
			delete target[key];
		}
	}

	for (const [key, value] of Object.entries(source)) {
		// Assigning "__proto__" would swap the target's prototype instead of copying a value. Settings never use that name.
		if (key === "__proto__") {
			continue;
		}
		const current = target[key];
		if (isPlainObject(current) && isPlainObject(value)) {
			if (current !== value) {
				syncRecordInPlace(current, value);
			}
			continue;
		}
		target[key] = structuredClone(value);
	}
}
