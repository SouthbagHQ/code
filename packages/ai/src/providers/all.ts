import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, KnownProvider, Model } from "../types.ts";
import { southbagAgentProvider } from "./southbag-agent.ts";

type BuiltinModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

/** Typed read of the generated built-in catalog. */
export function getBuiltinModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	if (provider === "southbag-agent") {
		return southbagAgentProvider()
			.getModels()
			.find((model) => model.id === modelId) as Model<BuiltinModelApi<TProvider, TModelId>>;
	}
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models?.[modelId as string] as Model<BuiltinModelApi<TProvider, TModelId>>;
}

export function getBuiltinProviders(): KnownProvider[] {
	return ["southbag-agent"];
}

export function getBuiltinModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	if (provider === "southbag-agent") {
		return southbagAgentProvider().getModels() as Model<
			BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>
		>[];
	}
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models
		? (Object.values(models) as Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[])
		: [];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [southbagAgentProvider()];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
