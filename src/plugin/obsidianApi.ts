import * as obsidian from "obsidian";

/**
 * The two Obsidian functions that are looked up by name when they are used: Mermaid and the YAML parser. Reading them
 * from the module at call time means a build that lacks one fails with a plain message at the point of use, and tests can
 * swap the whole object for fakes.
 */
export interface ObsidianApi {
	loadMermaid(): Promise<unknown>;
	parseYaml(text: string): unknown;
}

function readFunction(name: string): (...args: unknown[]) => unknown {
	const candidate: unknown = Reflect.get(obsidian, name);
	if (typeof candidate !== "function") {
		throw new Error(`This version of Obsidian does not provide ${name}.`);
	}
	return (...args) => {
		const result: unknown = Reflect.apply(candidate, obsidian, args);
		return result;
	};
}

export function createObsidianApi(): ObsidianApi {
	return {
		loadMermaid: async () => await readFunction("loadMermaid")(),
		parseYaml: (text) => readFunction("parseYaml")(text)
	};
}
