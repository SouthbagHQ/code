import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { SimpleStreamOptions, StreamFunction } from "./types.ts";

const openAICompletionsStreams = openAICompletionsApi();

/** @deprecated Use `stream` from `@southbag/code-ai/api/openai-completions` or `openAICompletionsApi().stream`. */
export const streamOpenAICompletions = openAICompletionsStreams.stream as StreamFunction<
	"openai-completions",
	OpenAICompletionsOptions
>;
/** @deprecated Use `streamSimple` from `@southbag/code-ai/api/openai-completions` or `openAICompletionsApi().streamSimple`. */
export const streamSimpleOpenAICompletions = openAICompletionsStreams.streamSimple as StreamFunction<
	"openai-completions",
	SimpleStreamOptions
>;
