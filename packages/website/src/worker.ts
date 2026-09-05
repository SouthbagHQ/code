import { createRemoteJWKSet, jwtVerify } from "jose";

const MODEL = "z-ai/glm-5.3-flash";
const PUBLIC_MODEL = "southbag-agent";
const CLI_CLIENT_ID = "southbag-code-cli";
const WEEKLY_LIMIT = 0.5;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type User = { sub: string; email: string; name: string };
type TokenPayload = {
	kind: "access" | "refresh" | "session" | "code" | "request" | "oidc";
	exp: number;
	user?: User;
	flow?: "cli" | "web";
	redirectUri?: string;
	returnTo?: string;
	challenge?: string;
	state?: string;
	clientState?: string;
	nonce?: string;
	verifier?: string;
	clientId?: string;
};

type OidcClient = { clientId: string };
type OidcMetadata = {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint: string;
	jwksUri: string;
	userinfoEndpoint?: string;
};

interface Kv {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number; metadata?: Record<string, unknown> },
	): Promise<void>;
	list(options: { prefix: string; cursor?: string }): Promise<{
		keys: Array<{ name: string; metadata?: Record<string, unknown> }>;
		list_complete: boolean;
		cursor?: string;
	}>;
}

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	USAGE: Kv;
	ORIGIN?: string;
	IDENTITY_ORIGIN?: string;
	SESSION_SECRET?: string;
	OPENROUTER_KEY?: string;
	DEV_AUTH?: string;
}

interface WorkerContext {
	waitUntil(promise: Promise<unknown>): void;
}

function base64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string) {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function isLocal(url: URL) {
	return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
}

function isDevelopment(env: Env, url: URL) {
	return env.DEV_AUTH === "true" || isLocal(url);
}

function secret(env: Env, url: URL) {
	if (env.SESSION_SECRET) return env.SESSION_SECRET;
	if (isDevelopment(env, url)) return "southbag-code-local-development-session-secret";
	throw new Error("SESSION_SECRET is not configured");
}

async function signingKey(value: string) {
	return crypto.subtle.importKey("raw", encoder.encode(value), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

async function seal(payload: TokenPayload, key: string) {
	const body = base64Url(encoder.encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", await signingKey(key), encoder.encode(body));
	return `${body}.${base64Url(new Uint8Array(signature))}`;
}

async function unseal(value: string | undefined, key: string, kind: TokenPayload["kind"]) {
	if (!value) return null;
	const [body, signature] = value.split(".");
	if (!body || !signature) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await signingKey(key),
			fromBase64Url(signature),
			encoder.encode(body),
		);
		if (!valid) return null;
		const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as TokenPayload;
		return payload.kind === kind && payload.exp > Date.now() ? payload : null;
	} catch {
		return null;
	}
}

function cookie(request: Request, name: string) {
	for (const part of (request.headers.get("cookie") || "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
}

function setCookie(name: string, value: string, maxAge: number, secure: boolean) {
	return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function redirect(location: string, cookieValue?: string) {
	const headers = new Headers({ location, "cache-control": "no-store" });
	if (cookieValue) headers.set("set-cookie", cookieValue);
	return new Response(null, { status: 302, headers });
}

function errorResponse(message: string, status = 400) {
	return Response.json({ error: { message } }, { status, headers: { "cache-control": "no-store" } });
}

function oauthError(error: string, description: string, status = 400) {
	return Response.json(
		{ error, error_description: description },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

function safeReturnTo(value: string | null) {
	return value?.startsWith("/") && !value.startsWith("//") ? value : "/account";
}

function validRedirect(value: string) {
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/callback"
		);
	} catch {
		return false;
	}
}

function cliRequest(url: URL): TokenPayload | null {
	const redirectUri = url.searchParams.get("redirect_uri") || "";
	const challenge = url.searchParams.get("code_challenge") || "";
	const state = url.searchParams.get("state") || "";
	if (
		url.searchParams.get("client_id") !== CLI_CLIENT_ID ||
		url.searchParams.get("response_type") !== "code" ||
		url.searchParams.get("code_challenge_method") !== "S256" ||
		!validRedirect(redirectUri) ||
		!challenge ||
		!state
	) {
		return null;
	}
	return {
		kind: "request",
		exp: Date.now() + 10 * 60_000,
		flow: "cli",
		redirectUri,
		challenge,
		clientState: state,
	};
}

function loginPage(requestToken: string) {
	return new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Southbag Code sign in</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;color:#f2f2f2;background:#060606;font-family:Arial,sans-serif}form{width:min(420px,calc(100% - 32px));padding:32px;border:1px solid #444;border-radius:18px;background:#111}h1{margin:0 0 24px}label{display:block;margin:16px 0 6px;color:#aaa}input,button{width:100%;padding:12px;border:1px solid #555;border-radius:9px;color:#f2f2f2;background:#080808}button{margin-top:22px;color:#060606;background:#c7f36b;border:0;font-weight:700;cursor:pointer}</style><form method="post" action="/dev/authorize"><h1>Southbag Code</h1><input type="hidden" name="request" value="${requestToken}"><label>Email</label><input name="email" type="email" value="employee@southbag.cc" required><label>Password</label><input name="password" type="password" value="southbag" required><button>Sign in</button></form></html>`,
		{ headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);
}

async function oidcMetadata(env: Env) {
	const identity = env.IDENTITY_ORIGIN || "https://identity.southbag.cc";
	const response = await fetch(new URL("/.well-known/openid-configuration", identity));
	const value = (await response.json().catch(() => ({}))) as {
		issuer?: string;
		authorization_endpoint?: string;
		token_endpoint?: string;
		registration_endpoint?: string;
		jwks_uri?: string;
		userinfo_endpoint?: string;
	};
	for (const endpoint of [
		value.authorization_endpoint,
		value.token_endpoint,
		value.registration_endpoint,
		value.jwks_uri,
	]) {
		if (!endpoint || new URL(endpoint).origin !== new URL(identity).origin)
			throw new Error("Identity discovery failed");
	}
	if (!response.ok || value.issuer !== identity) throw new Error("Identity discovery failed");
	return {
		issuer: value.issuer,
		authorizationEndpoint: value.authorization_endpoint,
		tokenEndpoint: value.token_endpoint,
		registrationEndpoint: value.registration_endpoint,
		jwksUri: value.jwks_uri,
		userinfoEndpoint: value.userinfo_endpoint,
	} as OidcMetadata;
}

async function oidcClient(env: Env, origin: string, metadata: OidcMetadata, clientId?: string) {
	const saved = await env.USAGE.get(clientId ? `identity-client:${clientId}` : "identity-client:current");
	if (saved) return JSON.parse(saved) as OidcClient;
	if (clientId) throw new Error("Identity client is not registered");

	const registration = await fetch(metadata.registrationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/json", origin: new URL(metadata.registrationEndpoint).origin },
		body: JSON.stringify({
			client_name: "Southbag Code",
			client_uri: origin,
			redirect_uris: [`${origin}/auth/callback`],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
			scope: "openid profile email",
		}),
	});
	const value = (await registration.json().catch(() => ({}))) as { client_id?: string };
	if (!registration.ok || !value.client_id) throw new Error("Identity client registration failed");
	const client = { clientId: value.client_id };
	await Promise.all([
		env.USAGE.put(`identity-client:${client.clientId}`, JSON.stringify(client)),
		env.USAGE.put("identity-client:current", JSON.stringify(client)),
	]);
	return client;
}

async function startOidc(flow: TokenPayload, env: Env, url: URL) {
	const origin = env.ORIGIN || url.origin;
	const metadata = await oidcMetadata(env);
	const client = await oidcClient(env, origin, metadata);
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
	const state = crypto.randomUUID();
	const nonce = crypto.randomUUID();
	const transaction = await seal(
		{ ...flow, kind: "oidc", state, nonce, verifier, clientId: client.clientId, exp: Date.now() + 10 * 60_000 },
		secret(env, url),
	);
	const authorize = new URL(metadata.authorizationEndpoint);
	authorize.search = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: `${origin}/auth/callback`,
		response_type: "code",
		scope: "openid profile email",
		state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	return redirect(authorize.toString(), setCookie("southbag_code_oidc", transaction, 600, !isDevelopment(env, url)));
}

async function beginLogin(flow: TokenPayload, env: Env, url: URL) {
	if (isDevelopment(env, url)) return loginPage(await seal(flow, secret(env, url)));
	return await startOidc(flow, env, url);
}

async function finishLogin(user: User, flow: TokenPayload, env: Env, url: URL) {
	if (flow.flow === "cli" && flow.redirectUri && flow.challenge && flow.clientState) {
		const code = await seal(
			{
				kind: "code",
				exp: Date.now() + 5 * 60_000,
				user,
				redirectUri: flow.redirectUri,
				challenge: flow.challenge,
			},
			secret(env, url),
		);
		const callback = new URL(flow.redirectUri);
		callback.searchParams.set("code", code);
		callback.searchParams.set("state", flow.clientState);
		return redirect(callback.toString());
	}
	const session = await seal({ kind: "session", exp: Date.now() + 8 * 60 * 60_000, user }, secret(env, url));
	return redirect(
		flow.returnTo || "/account",
		setCookie("southbag_code_session", session, 8 * 60 * 60, !isDevelopment(env, url)),
	);
}

async function developmentLogin(request: Request, env: Env, url: URL) {
	if (!isDevelopment(env, url)) return new Response("Not found", { status: 404 });
	const form = await request.formData();
	const flow = await unseal(form.get("request")?.toString(), secret(env, url), "request");
	const email = form.get("email")?.toString().trim().toLowerCase();
	if (!flow || email !== "employee@southbag.cc" || form.get("password") !== "southbag") {
		return errorResponse("Sign-in failed", 401);
	}
	return finishLogin({ sub: `dev-${email}`, email, name: "Development Employee" }, flow, env, url);
}

async function oidcCallback(request: Request, env: Env, url: URL) {
	const key = secret(env, url);
	const flow = await unseal(cookie(request, "southbag_code_oidc"), key, "oidc");
	const code = url.searchParams.get("code");
	if (
		!flow ||
		!code ||
		url.searchParams.get("state") !== flow.state ||
		!flow.verifier ||
		!flow.nonce ||
		!flow.clientId
	) {
		return errorResponse("Identity response did not match", 400);
	}

	const origin = env.ORIGIN || url.origin;
	const metadata = await oidcMetadata(env);
	const client = await oidcClient(env, origin, metadata, flow.clientId);
	const tokenResponse = await fetch(metadata.tokenEndpoint, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: new URL(metadata.tokenEndpoint).origin,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: client.clientId,
			code,
			redirect_uri: `${origin}/auth/callback`,
			code_verifier: flow.verifier,
		}),
	});
	const tokens = (await tokenResponse.json().catch(() => ({}))) as {
		access_token?: string;
		token_type?: string;
		id_token?: string;
		error?: string;
	};
	if (!tokenResponse.ok || !tokens.access_token || !tokens.id_token) {
		return errorResponse(tokens.error || "Identity token exchange failed", 502);
	}

	let subject: string | undefined;
	try {
		const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(metadata.jwksUri)), {
			issuer: metadata.issuer,
			audience: client.clientId,
		});
		if (verified.payload.nonce !== flow.nonce) throw new Error("nonce mismatch");
		subject = verified.payload.sub;
	} catch {
		return errorResponse("Identity token was not valid", 401);
	}
	const profileResponse = await fetch(
		metadata.userinfoEndpoint || new URL("/api/auth/oauth2/userinfo", metadata.issuer),
		{
			headers: { authorization: `${tokens.token_type || "Bearer"} ${tokens.access_token}` },
		},
	);
	const profile = (await profileResponse.json().catch(() => ({}))) as Partial<User>;
	if (!profileResponse.ok || !profile.sub || profile.sub !== subject || !profile.email) {
		return errorResponse("Identity did not return an account", 502);
	}
	return finishLogin(
		{ sub: profile.sub, email: profile.email, name: profile.name || profile.email.split("@")[0] },
		flow,
		env,
		url,
	);
}

async function issueTokens(user: User, env: Env, url: URL) {
	return {
		access_token: await seal({ kind: "access", exp: Date.now() + 60 * 60_000, user }, secret(env, url)),
		refresh_token: await seal({ kind: "refresh", exp: Date.now() + 30 * 24 * 60 * 60_000, user }, secret(env, url)),
		token_type: "Bearer",
		expires_in: 3600,
		scope: "openid profile email",
		email: user.email,
	};
}

async function tokenEndpoint(request: Request, env: Env, url: URL) {
	if (Number(request.headers.get("content-length") || 0) > 16_384)
		return oauthError("invalid_request", "Request too large");
	const form = await request.formData();
	if (form.get("client_id") !== CLI_CLIENT_ID) return oauthError("invalid_client", "Unknown client", 401);
	const grant = form.get("grant_type");
	if (grant === "authorization_code") {
		const code = await unseal(form.get("code")?.toString(), secret(env, url), "code");
		const verifier = form.get("code_verifier")?.toString() || "";
		const redirectUri = form.get("redirect_uri")?.toString();
		const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
		if (!code?.user || code.redirectUri !== redirectUri || code.challenge !== challenge) {
			return oauthError("invalid_grant", "Authorization code was not valid");
		}
		return Response.json(await issueTokens(code.user, env, url), { headers: { "cache-control": "no-store" } });
	}
	if (grant === "refresh_token") {
		const refresh = await unseal(form.get("refresh_token")?.toString(), secret(env, url), "refresh");
		if (!refresh?.user) return oauthError("invalid_grant", "Refresh token was not valid");
		return Response.json(await issueTokens(refresh.user, env, url), { headers: { "cache-control": "no-store" } });
	}
	return oauthError("unsupported_grant_type", "Grant type is not supported");
}

function weekWindow(now = new Date()) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
	const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
	return { id: start.toISOString().slice(0, 10), end };
}

async function userKey(sub: string) {
	return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(sub))));
}

async function usage(env: Env, sub: string) {
	const week = weekWindow();
	const prefix = `usage:${week.id}:${await userKey(sub)}:`;
	let cursor: string | undefined;
	let spent = 0;
	do {
		const page = await env.USAGE.list({ prefix, cursor });
		for (const key of page.keys) {
			const cost = key.metadata?.cost;
			if (typeof cost === "number" && Number.isFinite(cost)) spent += cost;
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return { spent, prefix, resetsAt: week.end.toISOString() };
}

async function authenticatedUser(request: Request, env: Env, url: URL, allowCookie = true) {
	const authorization = request.headers.get("authorization");
	const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	const access = await unseal(bearer, secret(env, url), "access");
	if (access?.user) return access.user;
	if (!allowCookie) return null;
	const session = await unseal(cookie(request, "southbag_code_session"), secret(env, url), "session");
	return session?.user || null;
}

async function recordCost(env: Env, prefix: string, cost: number, generation: string) {
	if (!(cost > 0) || !Number.isFinite(cost)) return;
	await env.USAGE.put(`${prefix}${generation}`, "", { expirationTtl: 14 * 24 * 60 * 60, metadata: { cost } });
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (!value || typeof value !== "object") {
		return typeof value === "string"
			? value.replaceAll(MODEL, "Southbag Agent").replaceAll("GLM 5.3 Flash", "Southbag Agent")
			: value;
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "cost" || key === "cost_details") continue;
		result[key] = key === "model" ? PUBLIC_MODEL : sanitizeValue(entry);
	}
	return result;
}

function inspectUsage(line: string) {
	if (!line.startsWith("data: ") || line === "data: [DONE]") return 0;
	try {
		const value = JSON.parse(line.slice(6)) as { usage?: { cost?: number } };
		return typeof value.usage?.cost === "number" ? value.usage.cost : 0;
	} catch {
		return 0;
	}
}

function sanitizeLine(line: string) {
	if (line.trimStart().startsWith("{")) {
		try {
			return JSON.stringify(sanitizeValue(JSON.parse(line)));
		} catch {}
	}
	if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
	try {
		return `data: ${JSON.stringify(sanitizeValue(JSON.parse(line.slice(6))))}`;
	} catch {
		return line.replaceAll(MODEL, "Southbag Agent").replaceAll("GLM 5.3 Flash", "Southbag Agent");
	}
}

function sanitizedStream(body: ReadableStream<Uint8Array>) {
	let buffer = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					controller.enqueue(encoder.encode(`${sanitizeLine(buffer.slice(0, newline))}\n`));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			},
			flush(controller) {
				buffer += decoder.decode();
				if (buffer) controller.enqueue(encoder.encode(sanitizeLine(buffer)));
			},
		}),
	);
}

async function accountUsage(body: ReadableStream<Uint8Array>, env: Env, prefix: string, generation: string) {
	const reader = body.getReader();
	let buffer = "";
	let cost = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			cost = Math.max(cost, inspectUsage(buffer.slice(0, newline)));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim().startsWith("{")) {
		try {
			const value = JSON.parse(buffer) as { usage?: { cost?: number } };
			if (typeof value.usage?.cost === "number") cost = Math.max(cost, value.usage.cost);
		} catch {}
	}
	await recordCost(env, prefix, cost, generation);
}

async function proxy(request: Request, env: Env, url: URL, context: WorkerContext) {
	const user = await authenticatedUser(request, env, url, false);
	if (!user) return errorResponse("Sign in required", 401);
	if (!env.OPENROUTER_KEY) return errorResponse("Southbag Agent is not configured", 503);
	const current = await usage(env, user.sub);
	if (current.spent >= WEEKLY_LIMIT) return errorResponse("Weekly usage limit reached", 429);

	const text = await request.text();
	if (text.length > 4_000_000) return errorResponse("Request too large", 413);
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return errorResponse("Request body must be JSON");
	}
	const remaining = WEEKLY_LIMIT - current.spent - (text.length / 4) * 0.0000001;
	if (remaining <= 0) return errorResponse("Weekly usage limit reached", 429);
	const affordableTokens = Math.max(1, Math.floor(remaining / 0.0000006));
	const requestedTokens = typeof body.max_tokens === "number" ? body.max_tokens : 128_000;
	body.model = MODEL;
	body.user = await userKey(user.sub);
	body.max_tokens = Math.min(requestedTokens, affordableTokens, 128_000);

	const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.OPENROUTER_KEY}`,
			"content-type": "application/json",
			"http-referer": env.ORIGIN || url.origin,
			"x-title": "Southbag Code",
		},
		body: JSON.stringify(body),
	});
	if (!upstream.body) return new Response(null, { status: upstream.status });
	const [clientBody, accountingBody] = upstream.body.tee();
	const generation = upstream.headers.get("x-generation-id") || crypto.randomUUID();
	context.waitUntil(accountUsage(accountingBody, env, current.prefix, generation));
	const headers = new Headers({ "content-type": upstream.headers.get("content-type") || "application/json" });
	for (const name of ["retry-after", "x-request-id"]) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(sanitizedStream(clientBody), { status: upstream.status, headers });
}

export default {
	async fetch(request: Request, env: Env, context: WorkerContext) {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/oauth/authorize") {
				const flow = cliRequest(url);
				return flow
					? await beginLogin(flow, env, url)
					: oauthError("invalid_request", "Authorization request was not valid");
			}
			if (request.method === "POST" && url.pathname === "/oauth/token")
				return await tokenEndpoint(request, env, url);
			if (request.method === "POST" && url.pathname === "/dev/authorize")
				return await developmentLogin(request, env, url);
			if (request.method === "GET" && url.pathname === "/auth/login") {
				return await beginLogin(
					{
						kind: "request",
						exp: Date.now() + 10 * 60_000,
						flow: "web",
						returnTo: safeReturnTo(url.searchParams.get("return_to")),
					},
					env,
					url,
				);
			}
			if (request.method === "GET" && url.pathname === "/auth/callback")
				return await oidcCallback(request, env, url);
			if (request.method === "GET" && url.pathname === "/auth/logout") {
				return redirect("/", setCookie("southbag_code_session", "", 0, !isDevelopment(env, url)));
			}
			if (request.method === "GET" && url.pathname === "/api/usage") {
				const user = await authenticatedUser(request, env, url);
				if (!user) return errorResponse("Sign in required", 401);
				const current = await usage(env, user.sub);
				return Response.json(
					{ percent: Math.min(100, (current.spent / WEEKLY_LIMIT) * 100), resetsAt: current.resetsAt },
					{ headers: { "cache-control": "no-store" } },
				);
			}
			if (request.method === "POST" && url.pathname === "/v1/chat/completions")
				return await proxy(request, env, url, context);
			if (request.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/")) {
				if (!(await authenticatedUser(request, env, url))) return redirect("/auth/login?return_to=/account");
			}
			return env.ASSETS.fetch(request);
		} catch (error) {
			return errorResponse(error instanceof Error ? error.message : "Request failed", 500);
		}
	},
};
