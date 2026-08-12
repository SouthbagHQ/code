import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthAuth } from "../../auth/types.ts";
import type { Model } from "../../types.ts";
import { getProviderEnvValue } from "../provider-env.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const DEFAULT_ORIGIN = "https://code.southbag.cc";
const CLIENT_ID = "southbag-code-cli";

type SouthbagCredentials = OAuthCredentials & { origin?: string };
type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	email?: string;
	error?: string;
	error_description?: string;
};

function serviceOrigin(credentials?: SouthbagCredentials) {
	const value = credentials?.origin || getProviderEnvValue("SOUTHBAG_CODE_URL") || DEFAULT_ORIGIN;
	const url = new URL(value);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
		throw new Error("SOUTHBAG_CODE_URL must use HTTPS or local HTTP");
	}
	return url.origin;
}

async function tokenRequest(origin: string, body: URLSearchParams): Promise<SouthbagCredentials> {
	const response = await fetch(`${origin}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	const data = (await response.json().catch(() => ({}))) as TokenResponse;
	if (!response.ok || !data.access_token || !data.refresh_token || !data.expires_in) {
		throw new Error(data.error_description || data.error || `Token exchange failed (${response.status})`);
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - 60_000,
		origin,
		email: data.email,
	};
}

export async function loginSouthbag(callbacks: OAuthLoginCallbacks): Promise<SouthbagCredentials> {
	const origin = serviceOrigin();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();

	let settle: (value: { code: string; state: string }) => void;
	let reject: (error: Error) => void;
	const callback = new Promise<{ code: string; state: string }>((resolve, rejectCallback) => {
		settle = resolve;
		reject = rejectCallback;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		if (url.pathname !== "/callback") {
			response.writeHead(404).end();
			return;
		}
		const code = url.searchParams.get("code");
		const returnedState = url.searchParams.get("state");
		const error = url.searchParams.get("error");
		response.writeHead(error || !code || !returnedState ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			error || !code || !returnedState
				? oauthErrorHtml(error || "Missing authorization response.")
				: oauthSuccessHtml("You can return to the terminal."),
		);
		if (error || !code || !returnedState) reject(new Error(error || "Missing authorization response"));
		else settle({ code, state: returnedState });
	});

	await new Promise<void>((resolve, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const authorize = new URL("/oauth/authorize", origin);
	authorize.search = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: "openid profile email",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();

	const abort = () => reject(new Error("Login cancelled"));
	callbacks.signal?.addEventListener("abort", abort, { once: true });
	callbacks.onAuth({ url: authorize.toString(), instructions: "Complete sign-in in your browser." });

	try {
		const result = await callback;
		if (result.state !== state) throw new Error("OAuth state mismatch");
		callbacks.onProgress?.("Finishing sign-in...");
		return tokenRequest(
			origin,
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: result.code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}),
		);
	} finally {
		callbacks.signal?.removeEventListener("abort", abort);
		server.close();
	}
}

export function refreshSouthbagToken(credentials: SouthbagCredentials) {
	const origin = serviceOrigin(credentials);
	return tokenRequest(
		origin,
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
	);
}

const modifyModels = (models: Model<string>[], credentials: SouthbagCredentials) =>
	models.map((model) =>
		model.provider === "opencode" ? { ...model, baseUrl: `${serviceOrigin(credentials)}/v1` } : model,
	);

export const southbagOAuth: OAuthAuth = {
	name: "Southbag Code account",
	async login(callbacks) {
		return {
			...(await loginSouthbag({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onSelect: async (prompt) =>
					callbacks.prompt({ type: "select", message: prompt.message, options: prompt.options }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				signal: callbacks.signal,
			})),
			type: "oauth",
		};
	},
	async refresh(credential) {
		return { ...(await refreshSouthbagToken(credential)), type: "oauth" };
	},
	async toAuth(credential) {
		return { apiKey: credential.access, baseUrl: `${serviceOrigin(credential)}/v1` };
	},
};

export const southbagOAuthProvider: OAuthProviderInterface = {
	id: "opencode",
	name: "Southbag Code account",
	usesCallbackServer: true,
	login: loginSouthbag,
	refreshToken: refreshSouthbagToken,
	getApiKey: (credentials) => credentials.access,
	modifyModels,
};
