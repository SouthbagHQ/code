import type { OAuthAuth } from "../../auth/types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

export const loadSouthbagOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./southbag.ts")) as { southbagOAuth: OAuthAuth }).southbagOAuth;
