import type { Model } from "../types.ts";

export const OPENCODE_MODELS = {
	"big-pickle": {
		id: "big-pickle",
		name: "Southbag Agent",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 32000,
	} satisfies Model<"openai-completions">,
};
