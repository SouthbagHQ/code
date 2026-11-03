// Agent (MCP) endpoint for Southbag Code. Customers issue named, revocable agent tokens at
// https://identity.southbag.cc/agents; an agent presents one as a bearer token here. Identity
// resolves it fresh on every call, so revocation applies immediately.
//
// Protocol: MCP spec 2025-06-18, Streamable HTTP in its JSON-only form - POST of one JSON-RPC
// message, JSON response; no SSE, no sessions, no batching (batching was removed in 2025-06-18).
//
// Fees: every tools/call costs the MCP request fee below, taken from the token owner's Southbag
// Online Banking account through the BANKING service binding (Billing entrypoint, RPC, never
// public). initialize / tools/list are free so agents can quote fees before spending. The v1
// tool is read-only; chat completions are NOT exposed here yet (they spend at OpenRouter).
//
// Exactly-once: tools/call requires an Idempotency-Key header. The mcp_call journal row starts
// 'pending' BEFORE any fee moves and ends 'done' with the full result, so a retried key replays
// the stored answer without charging again. A row left 'pending' is an UNKNOWN outcome: it is
// NEVER re-run and never reclaimed - without a fencing mechanism shared by the fee executor and
// the action executor, no local observation proves the original call cannot still commit. It
// stays reconciliation-required; the response reports what can be verified.

// Ingo's ruling in the dev Slack thread (2026-11-03): "fee for everything", then "$1" per MCP
// request. One clearly-marked constant so a pricing change is a one-line PR.
export const MCP_REQUEST_FEE_CENTS = 100;
const MCP_REQUEST_FEE_DESCRIPTION = "MCP request fee";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);

const FROZEN_TEXT = "Your account is frozen pending review. Unfreeze at https://identity.southbag.cc/unfreeze";
const STATUS_UNKNOWN_TEXT = "Southbag Identity is unavailable, so your account status cannot be checked. Try again shortly.";

// Minimal D1 surface (worker.ts keeps its own structural types the same way).
interface D1Statement<T = unknown> {
	bind(...params: unknown[]): D1Statement<T>;
	first<R = T>(): Promise<R | null>;
	all<R = T>(): Promise<{ results: R[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
}
interface D1 {
	prepare(sql: string): D1Statement;
}
interface ChargeResult {
	balance: number | null;
	opened: boolean;
	duplicate?: boolean;
}
export interface McpEnv {
	DB?: D1;
	BANKING?: { charge(input: Record<string, unknown>): Promise<ChargeResult> };
	IDENTITY_ORIGIN?: string;
	IDENTITY_INTERNAL_SECRET?: string;
}

type Json = Record<string, unknown>;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const feeKey = (userId: string, key: string) => `mcp|code|request|${userId}|${key}`;

// Canonical JSON (keys sorted recursively) so {a:1,b:2} and {b:2,a:1} hash alike.
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v,
	);
const argsHash = async (name: string, args: unknown): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical({ name, arguments: args ?? {} })));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

interface AgentIdentity {
	user: { id: string; email: string | null; name: string };
	tokenId: string;
	tokenName: string;
}
type AgentAuth = AgentIdentity | { status: number; text: string };
const authFailed = (status: number, text: string): AgentAuth => ({ status, text });

// Bearer token -> Identity's internal resolution endpoint (shared INTERNAL_API_SECRETS service
// credential, same as the freeze API). 401 unknown/revoked token; 503 Identity down or this
// service unconfigured. No caching: a cached 'valid' answer is a revocation bypass window.
async function resolveAgent(env: McpEnv, token: string): Promise<AgentAuth> {
	if (!token) return authFailed(401, "Missing agent token. Tokens are issued at https://identity.southbag.cc/agents and presented as a bearer token.");
	const secret = env.IDENTITY_INTERNAL_SECRET;
	if (!secret) return authFailed(503, "Agent access is not configured on this service.");
	const origin = env.IDENTITY_ORIGIN || "https://identity.southbag.cc";
	let response: Response;
	try {
		response = await fetch(`${origin}/api/internal/agent-token`, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
	} catch (error) {
		console.error("identity agent-token resolution failed", error);
		return authFailed(503, "Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.");
	}
	if (response.status === 404) return authFailed(401, "Unknown or revoked agent token. Tokens are issued at https://identity.southbag.cc/agents");
	if (response.status === 401 || response.status === 403) {
		console.error(`identity agent-token REJECTED the configured secret (HTTP ${response.status}) - check IDENTITY_INTERNAL_SECRET`);
		return authFailed(503, "Agent access is misconfigured on this service.");
	}
	if (!response.ok) return authFailed(503, "Southbag Identity is unavailable, so your agent token cannot be checked. Try again shortly.");
	const row = (await response.json()) as { userId?: string; email?: string | null; name?: string | null; tokenId?: string; tokenName?: string };
	if (!row || typeof row.userId !== "string" || !row.userId) return authFailed(401, "Unknown or revoked agent token.");
	return { user: { id: row.userId, email: row.email ?? null, name: row.name ?? row.userId }, tokenId: String(row.tokenId ?? ""), tokenName: String(row.tokenName ?? "") };
}

// The central account freeze, fresh on every call, failing closed - same policy as worker.ts.
type CentralAnswer = "off" | "unknown" | { frozen: boolean };
async function centralStatus(env: McpEnv, userId: string): Promise<CentralAnswer> {
	const secret = env.IDENTITY_INTERNAL_SECRET;
	if (!secret) return "off";
	try {
		const origin = env.IDENTITY_ORIGIN || "https://identity.southbag.cc";
		const response = await fetch(`${origin}/api/internal/freeze?userId=${encodeURIComponent(userId)}`, {
			headers: { authorization: `Bearer ${secret}` },
		});
		if (response.status === 401 || response.status === 403) {
			console.error(`identity status REJECTED the configured secret (HTTP ${response.status}) - check IDENTITY_INTERNAL_SECRET`);
			return "unknown";
		}
		if (!response.ok) throw new Error(`identity status ${response.status}`);
		return { frozen: !!((await response.json()) as { frozen?: boolean }).frozen };
	} catch (error) {
		console.error("identity status failed", error);
		return "unknown";
	}
}

function toolList() {
	return [
		{
			name: "get_usage",
			title: "Get weekly usage",
			description: `The token owner's chat-completions usage for the current week (requests, tokens, cost). Costs the ${money(MCP_REQUEST_FEE_CENTS)} MCP request fee; no additional action fee.`,
			inputSchema: { type: "object", properties: {} },
		},
	];
}

function initializeResult() {
	return {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: "southbag-code", title: "Southbag Code", version: "1.0.0" },
		instructions: [
			`Fees: every tools/call costs a ${money(MCP_REQUEST_FEE_CENTS)} request fee, charged to the token owner's Southbag Online Banking account, plus any standard action fees quoted in each tool's description. Discovery (initialize, tools/list) is free.`,
			"Every tools/call MUST include an Idempotency-Key header (8-120 characters). A retried key replays the stored result without charging again. A key whose outcome is unknown is never re-run; the response says what can be verified.",
			"Every tools/call returns an itemised receipt.",
			"Agent tokens are issued and revoked at https://identity.southbag.cc/agents. Revocation applies immediately.",
		].join(" "),
	};
}

// A 'pending' journal row means a previous call with this key did not finish cleanly. It is NEVER
// re-run and never reclaimed: without a fencing mechanism shared by the fee executor and the
// action executor, no local observation proves the original call cannot still commit. The row
// stays reconciliation-required. The response reports what can be verified locally; the bank's
// own ledger (its charge idempotency key is derived from ours) holds ground truth for the fee.
function unknownOutcome() {
	return {
		content: [
			{
				type: "text",
				text: `A previous call with this Idempotency-Key did not complete. Its outcome is unknown and Southbag does not re-run unknown outcomes. If the ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged it is on your banking ledger. Kevin has been notified.`,
			},
		],
		isError: true,
		structuredContent: { unknownOutcome: true },
	};
}

async function handleToolsCall(
	request: Request,
	env: McpEnv,
	message: { id: unknown; params?: { name?: unknown; arguments?: unknown } },
	usageFor: (sub: string) => Promise<unknown>,
) {
	const auth = await resolveAgent(env, request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] || "");
	if ("status" in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
	const name = typeof message.params?.name === "string" ? message.params.name : "";
	if (!toolList().some((tool) => tool.name === name))
		return json(rpcError(message.id, -32602, `Unknown tool '${name}'. tools/list is free and quotes every fee.`));
	const key = request.headers.get("idempotency-key")?.trim() || "";
	if (key.length < 8 || key.length > 120)
		return json(rpcError(message.id, -32602, "tools/call requires an Idempotency-Key header (8-120 characters). A retried key replays its stored result without charging again."));
	if (!env.DB) return json(rpcError(message.id, -32603, "Agent access storage is not bound on this service."), 500);
	if (!env.BANKING) return json(rpcError(message.id, -32603, "Agent access billing is not bound on this service."), 500);

	const db = env.DB;
	const rowKey = `${auth.user.id}|${key}`;
	const hash = await argsHash(name, message.params?.arguments);
	const replay = (storedRow: { response: string }) => {
		const stored = JSON.parse(storedRow.response);
		if (stored.structuredContent?.receipt) stored.structuredContent.receipt.duplicate = true;
		return json(rpcResult(message.id, stored));
	};

	const existing = await db
		.prepare("SELECT tool, args_hash, status, response FROM mcp_call WHERE idempotency_key = ?")
		.bind(rowKey)
		.first<{ tool: string; args_hash: string; status: string; response: string | null }>();
	if (existing) {
		// An idempotency key names ONE call: this user, this tool, these arguments. A different tool
		// or different arguments under a used key is a caller bug, never a replay.
		if (existing.tool !== name)
			return json(rpcError(message.id, -32602, `This Idempotency-Key was already used for '${existing.tool}'. Keys are not shared across tools.`));
		if (existing.args_hash !== hash)
			return json(rpcError(message.id, -32602, "This Idempotency-Key was already used with different arguments. Keys name one exact call."));
		if (existing.status === "done") return replay(existing as { response: string });
		return json(rpcResult(message.id, unknownOutcome()));
	}

	// Central freeze check BEFORE any fee moves, fresh per call, fail closed. Frozen/unknown
	// answers are not journaled and not charged, so the same key works once the account is back.
	const central = await centralStatus(env, auth.user.id);
	if (central === "unknown") return json(rpcResult(message.id, { content: [{ type: "text", text: STATUS_UNKNOWN_TEXT }], isError: true }));
	if (central !== "off" && central.frozen) return json(rpcResult(message.id, { content: [{ type: "text", text: FROZEN_TEXT }], isError: true }));

	try {
		await db
			.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
			.bind(rowKey, auth.user.id, name, hash, Date.now(), Date.now())
			.run();
	} catch (error) {
		if (!String(error).includes("UNIQUE constraint failed")) throw error;
		// A concurrent call with the same key claimed it first.
		const raced = await db.prepare("SELECT status, response FROM mcp_call WHERE idempotency_key = ?").bind(rowKey).first<{ status: string; response: string | null }>();
		if (!raced) throw error;
		if (raced.status === "done") return replay(raced as { response: string });
		return json(rpcResult(message.id, unknownOutcome()));
	}

	// Claimed. Charge the request fee first: the journal row is already 'pending', and the bank's
	// own idempotency key (derived from ours) makes a retry of THIS charge a no-op instead of a
	// second debit. If the charge throws, the row stays 'pending' - unknown, never re-run.
	const chargeResult = await env.BANKING.charge({
		userId: auth.user.id,
		email: auth.user.email,
		name: auth.user.name,
		amount: MCP_REQUEST_FEE_CENTS,
		product: "Southbag Code",
		description: MCP_REQUEST_FEE_DESCRIPTION,
		idempotencyKey: feeKey(auth.user.id, key),
	});

	let result: Json;
	try {
		const data = (await usageFor(auth.user.id)) as Json;
		result = {
			content: [{ type: "text", text: `This week: ${JSON.stringify(data)}` }],
			isError: false,
			structuredContent: {
				usage: data,
				receipt: {
					requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
					balanceAfter: chargeResult.balance,
					duplicate: false,
				},
			},
		};
	} catch (error) {
		console.error(`mcp tools/call ${name} failed after charging`, error);
		// The request fee was charged; the action's own outcome is unknown. The result is terminal
		// (journaled 'done'): the call is never re-run.
		result = {
			content: [
				{
					type: "text",
					text: `The ${money(MCP_REQUEST_FEE_CENTS)} request fee was charged, then the action failed (${String((error as Error).message || error)}). Southbag does not re-run it. Kevin has been notified.`,
				},
			],
			isError: true,
			structuredContent: {
				receipt: {
					requestFee: { amount: MCP_REQUEST_FEE_CENTS, description: MCP_REQUEST_FEE_DESCRIPTION, duplicate: chargeResult.duplicate ?? false },
					actionFailed: true,
					duplicate: false,
				},
			},
		};
	}
	await db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = ?").bind(JSON.stringify(result), Date.now(), rowKey).run();
	return json(rpcResult(message.id, result));
}

export async function handleMcp(request: Request, env: McpEnv, usageFor: (sub: string) => Promise<unknown>): Promise<Response> {
	if (request.method === "GET" || request.method === "DELETE")
		return json({ error: "This endpoint speaks JSON only; no event stream." }, 405, { allow: "POST" });
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });

	const version = request.headers.get("mcp-protocol-version");
	if (version && !SUPPORTED_VERSIONS.has(version))
		return json(rpcError(null, -32600, `Unsupported MCP protocol version '${version}'. This server speaks ${[...SUPPORTED_VERSIONS].join(", ")}.`), 400);

	let message: { id?: unknown; jsonrpc?: string; method?: string; params?: { name?: unknown; arguments?: unknown } };
	try {
		message = await request.json();
	} catch {
		return json(rpcError(null, -32700, "Parse error"), 400);
	}
	if (Array.isArray(message) || !message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string")
		return json(rpcError((message as Json)?.id ?? null, -32600, "Invalid request: one JSON-RPC message per POST; batching is not supported."), 400);

	// Notifications have no id and get no response body.
	if (message.id === undefined || message.id === null) {
		if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
		return json(rpcError(null, -32600, "Requests must carry an id; notifications use the notifications/* methods."), 400);
	}

	switch (message.method) {
		case "initialize":
			return json(rpcResult(message.id, initializeResult()), 200, { "mcp-protocol-version": PROTOCOL_VERSION });
		case "ping":
			return json(rpcResult(message.id, {}));
		case "tools/list": {
			// Discovery is free but authenticated: the catalogue is for customers' agents.
			const auth = await resolveAgent(env, request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] || "");
			if ("status" in auth) return json(rpcError(message.id, -32001, auth.text), auth.status);
			return json(rpcResult(message.id, { tools: toolList() }));
		}
		case "tools/call":
			return await handleToolsCall(request, env, message as { id: unknown; params?: { name?: unknown; arguments?: unknown } }, usageFor);
		default:
			return json(rpcError(message.id, -32601, `Method not found: ${message.method}`));
	}
}
