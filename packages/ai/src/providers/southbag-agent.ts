import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadSouthbagOAuth } from "../utils/oauth/load.ts";
import { SOUTHBAG_AGENT_MODELS } from "./southbag-agent.models.ts";

export function southbagAgentProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "southbag-agent",
		name: "Southbag Agent",
		auth: {
			oauth: lazyOAuth({ name: "Southbag Code account", load: loadSouthbagOAuth }),
		},
		models: Object.values(SOUTHBAG_AGENT_MODELS).map((model) => ({
			...model,
			baseUrl: "https://code.southbag.cc/v1",
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			input: ["text", "image"] as const,
		})),
		api: {
			"openai-completions": openAICompletionsApi(),
		},
	});
}
