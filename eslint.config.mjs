import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the Obsidian community review checks so violations fail locally and in CI instead of in review.
export default defineConfig([
	...obsidianmd.configs.recommendedWithLocalesEn,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// Product, provider and language names are proper nouns, not sentence-case violations.
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: ["AskMate", "Obsidian", "OpenAI", "Azure", "OpenRouter", "Anthropic", "Claude", "Gemini", "Google", "Ollama", "LM Studio", "Mermaid", "Markdown", "British", "English"],
				acronyms: ["AI", "API", "MCP", "URL", "JSON", "HTTP", "HTTPS", "PNG", "SVG", "YAML"]
			}]
		}
	},
	{ ignores: [".claude/**", "node_modules/**", "main.js", "tests/**", "scripts/**", "eslint.config.mjs", "esbuild.config.mjs", ".design-options/**", "DigVis/**", "docs/**"] }
]);
