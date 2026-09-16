/*
 * Palantir — server-side PostHog capture for Southbag. Dependency-free (plain fetch), so it
 * runs unchanged on Cloudflare Workers, Node and Bun. Mirrors `public/palantir.js` on the client.
 *
 * Events are tied to the browser session when the request carries PostHog's `.southbag.cc`
 * cookie: `palantirContext(request)` reads the distinct id and session id out of it, so a
 * server event lands in the same person and the same session replay as the click that caused it.
 */

const PALANTIR_KEY = "phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo";
const PALANTIR_HOST = "https://palantir.southbag.cc";
const APP = "code"; // matches data-app on the client

export interface PalantirContext {
	/** PostHog distinct id from the browser cookie (anonymous or identified). */
	distinctId?: string;
	/** Session replay id from the browser cookie, so server events join the replay. */
	sessionId?: string;
	windowId?: string;
	ip?: string;
	userAgent?: string;
	url?: string;
}

/** Pull PostHog's identity and session out of the request's cookies/headers. */
export function palantirContext(request: Request): PalantirContext {
	const context: PalantirContext = {
		ip: request.headers.get("cf-connecting-ip") ?? undefined,
		userAgent: request.headers.get("user-agent") ?? undefined,
		url: request.headers.get("referer") ?? request.url,
	};
	const raw = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`ph_${PALANTIR_KEY}_posthog=`));
	if (!raw) return context;
	try {
		const value = JSON.parse(decodeURIComponent(raw.slice(raw.indexOf("=") + 1))) as {
			distinct_id?: string;
			$sesid?: [number, string, number];
			$window_id?: string;
		};
		if (value.distinct_id) context.distinctId = String(value.distinct_id);
		if (Array.isArray(value.$sesid) && value.$sesid[1]) context.sessionId = value.$sesid[1];
		if (value.$window_id) context.windowId = value.$window_id;
	} catch {
		// Not our cookie shape — fine, the event is still captured, just not linked to a replay.
	}
	return context;
}

export interface CaptureOptions {
	/** Person properties to set (email, name, …). */
	set?: Record<string, unknown>;
	/** Request context from `palantirContext()` so the event joins the browser session. */
	context?: PalantirContext;
	/** Cloudflare's `ctx.waitUntil` — keeps the request from finishing before the event is sent. */
	waitUntil?: (promise: Promise<unknown>) => void;
	timestamp?: Date;
}

function send(payload: Record<string, unknown>, waitUntil?: CaptureOptions["waitUntil"]) {
	const promise = fetch(`${PALANTIR_HOST}/capture/`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	})
		.then((response) => {
			if (!response.ok) console.warn(`palantir: capture failed (${response.status})`);
		})
		.catch((error) => console.warn("palantir: capture failed", error));
	if (waitUntil) waitUntil(promise);
	return promise;
}

/**
 * Capture a server-side event. `distinctId` should be the signed-in user's Identity id when
 * there is one (the same id the browser identifies with), otherwise the cookie's distinct id
 * from `palantirContext(request)`.
 */
export function capture(
	event: string,
	distinctId: string | undefined,
	properties: Record<string, unknown> = {},
	options: CaptureOptions = {},
) {
	const context = options.context ?? {};
	const id = distinctId ?? context.distinctId;
	if (!id) return Promise.resolve();
	const payload = {
		api_key: PALANTIR_KEY,
		event,
		distinct_id: id,
		timestamp: (options.timestamp ?? new Date()).toISOString(),
		properties: {
			$lib: "palantir-server",
			$process_person_profile: true,
			southbag_app: APP,
			source: "server",
			...(context.sessionId ? { $session_id: context.sessionId } : {}),
			...(context.windowId ? { $window_id: context.windowId } : {}),
			...(context.ip ? { $ip: context.ip } : {}),
			...(context.userAgent ? { $raw_user_agent: context.userAgent } : {}),
			...(context.url ? { $current_url: context.url } : {}),
			...properties,
			...(options.set ? { $set: options.set } : {}),
		},
	};
	return send(payload, options.waitUntil);
}

/**
 * Identify a user server-side. Merges the anonymous cookie identity (from `context.distinctId`)
 * into the user's profile, exactly like `posthog.identify()` in the browser.
 */
export function identify(userId: string, set: Record<string, unknown>, options: Omit<CaptureOptions, "set"> = {}) {
	const anonymous = options.context?.distinctId;
	return capture("$identify", userId, anonymous && anonymous !== userId ? { $anon_distinct_id: anonymous } : {}, {
		...options,
		set,
	});
}
