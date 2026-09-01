import type { Api, Model, ProviderHeaders } from "@southbag/code-ai";
import type { SettingsManager } from "./settings-manager.ts";

const SOUTHBAG_HOST = "code.southbag.cc";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	void model;
	void settingsManager;
	return undefined;
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (model.provider !== "southbag-agent" && !matchesHost(model.baseUrl, SOUTHBAG_HOST)) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "southbag-code" };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
		...getDefaultAttributionHeaders(model, settingsManager),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
