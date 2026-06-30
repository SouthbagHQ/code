import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_MODELS } from "./opencode.models.ts";

export function opencodeProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "opencode",
		name: "OpenCode",
		auth: {
			apiKey: {
				name: "OpenCode API key",
				resolve: async () => ({ auth: { apiKey: "public" }, source: "public" }),
			},
		},
		models: Object.values(OPENCODE_MODELS),
		api: {
			"openai-completions": openAICompletionsApi(),
		},
	});
}
