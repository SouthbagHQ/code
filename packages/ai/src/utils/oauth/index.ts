export { loginSouthbag, refreshSouthbagToken, southbagOAuthProvider } from "./southbag.ts";

export * from "./types.ts";

// ============================================================================
// Provider Registry
// ============================================================================

import { southbagOAuthProvider } from "./southbag.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [southbagOAuthProvider];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Unregister an OAuth provider.
 *
 * If the provider is built-in, restores the built-in implementation.
 * Custom providers are removed completely.
 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

/**
 * Refresh token for any OAuth provider.
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
