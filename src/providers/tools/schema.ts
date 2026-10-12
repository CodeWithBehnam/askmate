/** JSON Schema clean-up for tool parameters. Pure. */
import type { Json, JsonObject } from "./neutral";

type SchemaVisitor = (schema: JsonObject) => JsonObject;

const NAME_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);

/**
 * Applies `visit` to every schema object while leaving property NAMES alone. A tool with a property called "title"
 * or "default" must keep it, so the keys of `properties`, `$defs` and `definitions` are never treated as keywords.
 */
function mapSchema(node: Json, visit: SchemaVisitor): Json {
	if (Array.isArray(node)) {
		return node.map((child) => mapSchema(child, visit));
	}

	if (node === null || typeof node !== "object") {
		return node;
	}

	const children: JsonObject = {};

	for (const [key, value] of Object.entries(node)) {
		children[key] = NAME_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, mapSchema(child, visit)]))
			: mapSchema(value, visit);
	}

	return visit(children);
}

/**
 * Every provider wants an object schema at the root, and several answer HTTP 400 "object schema missing properties" for
 * a bare {"type":"object"}. A tool with no parameters therefore gets an empty `properties`. The root `$schema` marker is
 * dropped because declarations are not stand-alone documents.
 */
export function normaliseToolSchema(schema: JsonObject): JsonObject {
	const { $schema: _marker, ...rest } = schema;

	// A root that is not an object is the tool author's mistake; it is passed on as given so the provider says so.
	if (rest.type !== undefined && rest.type !== "object") {
		return rest;
	}

	const composed = rest.oneOf !== undefined || rest.anyOf !== undefined || rest.allOf !== undefined;
	return { ...rest, type: "object", ...(rest.properties === undefined && !composed ? { properties: {} } : {}) };
}

/**
 * Light clean-up for Gemini parametersJsonSchema, which accepts full JSON Schema. Removes $schema and drops
 * `required` entries that name no declared property, which Gemini rejects.
 */
export function prepareGeminiJsonSchema(schema: JsonObject): JsonObject {
	return mapSchema(normaliseToolSchema(schema), (node) => {
		const { $schema: _dropped, ...rest } = node;
		const properties = rest.properties;

		if (Array.isArray(rest.required) && properties && typeof properties === "object" && !Array.isArray(properties)) {
			return { ...rest, required: rest.required.filter((name) => typeof name === "string" && name in properties) };
		}

		return rest;
	}) as JsonObject;
}

const OPENAPI_DROP_KEYS = new Set(["$schema", "$id", "$defs", "definitions", "additionalProperties", "examples", "default", "exclusiveMinimum", "exclusiveMaximum", "patternProperties", "title"]);

/**
 * Fallback for the legacy `parameters` field, an OpenAPI 3.0 subset. Drops keywords outside that subset, turns
 * ["string","null"] into type "string" with nullable true, and turns const into a one-value enum.
 * Use only if Gemini answers 400 "Unknown name" for parametersJsonSchema.
 */
export function toGeminiOpenApiSchema(schema: JsonObject): JsonObject {
	return mapSchema(normaliseToolSchema(schema), (node) => {
		const out: JsonObject = {};

		for (const [key, value] of Object.entries(node)) {
			if (key === "const") {
				out.enum = [value];
			} else if (!OPENAPI_DROP_KEYS.has(key)) {
				out[key] = value;
			}
		}

		if (Array.isArray(out.type)) {
			const original = out.type;
			const concrete = original.filter((type) => type !== "null");
			out.type = typeof concrete[0] === "string" ? concrete[0] : "string";
			if (concrete.length !== original.length) {
				out.nullable = true;
			}
		}

		return out;
	}) as JsonObject;
}
