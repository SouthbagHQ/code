/**
 * Palantir — Southbag's PostHog wiring for the CLI. Dependency-free: events are batched in
 * memory and posted with plain fetch, so it runs the same under Node, Bun and the compiled
 * binary. Mirrors `palantir.js` (browser) and `palantir.ts` (worker) in the other Southbag apps.
 *
 * Only names, counts, sizes and durations are ever sent — never prompt text, file contents,
 * tool arguments or results.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { detectInstallMethod, VERSION } from "../config.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { AuthStorage } from "./auth-storage.ts";

const PALANTIR_KEY = "phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo";
const PALANTIR_HOST = "https://palantir.southbag.cc";
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_AT = 20;
const REQUEST_TIMEOUT_MS = 4_000;

type Properties = Record<string, unknown>;

interface QueuedEvent {
	event: string;
	distinct_id: string;
	timestamp: string;
	properties: Properties;
}

export interface PalantirOptions {
	agentDir: string;
	authStorage: AuthStorage;
	appMode: string;
}

function southbagIdentity(authStorage: AuthStorage): { sub?: string; email?: string } | undefined {
	const credential = authStorage.get("southbag-agent") as { sub?: unknown; email?: unknown } | undefined;
	if (!credential) return undefined;
	return {
		sub: typeof credential.sub === "string" ? credential.sub : undefined,
		email: typeof credential.email === "string" ? credential.email : undefined,
	};
}

class Palantir {
	private enabled = false;
	private queue: QueuedEvent[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inflight: Promise<void> | undefined;
	private anonymousId = "";
	private distinctId = "";
	private identified = false;
	private base: Properties = {};
	private authStorage: AuthStorage | undefined;
	private toolStarts = new Map<string, number>();
	private lastModel: string | undefined;
	private startedAt = Date.now();

	/** Set up once main() knows the agent dir, auth storage and app mode. */
	configure(options: PalantirOptions): void {
		this.enabled = true;
		this.authStorage = options.authStorage;
		this.anonymousId = this.loadAnonymousId(options.agentDir);
		this.distinctId = this.anonymousId;
		this.base = {
			$lib: "palantir-cli",
			$lib_version: VERSION,
			southbag_app: "code",
			source: "cli",
			cli_version: VERSION,
			os: platform(),
			os_release: release(),
			arch: arch(),
			runtime: process.versions.bun ? "bun" : "node",
			runtime_version: process.versions.bun ?? process.versions.node,
			install_method: detectInstallMethod(),
			app_mode: options.appMode,
		};
		this.refreshIdentity();
	}

	/** Re-read the Southbag credential; identifies the person if they signed in since last time. */
	refreshIdentity(): void {
		if (!this.enabled || !this.authStorage) return;
		const identity = southbagIdentity(this.authStorage);
		const id = identity?.sub ?? identity?.email;
		if (!id) {
			if (this.identified) {
				this.identified = false;
				this.distinctId = this.anonymousId;
			}
			return;
		}
		if (this.identified && this.distinctId === id) return;
		this.distinctId = id;
		this.identified = true;
		this.enqueue("$identify", {
			$anon_distinct_id: this.anonymousId,
			$set: { email: identity?.email, southbag_code_cli: true },
		});
	}

	capture(event: string, properties: Properties = {}): void {
		if (!this.enabled) return;
		this.enqueue(event, properties);
	}

	/** Subscribe to an agent session and turn its lifecycle into events. */
	observe(session: AgentSession, details: Properties = {}): () => void {
		if (!this.enabled) return () => {};
		this.startedAt = Date.now();
		this.lastModel = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		this.capture("cli_session_start", {
			session_id: session.sessionId,
			model_id: session.model?.id,
			model_provider: session.model?.provider,
			thinking_level: session.thinkingLevel,
			active_tools: session.getActiveToolNames().length,
			...details,
		});
		return session.subscribe((event) => this.handleSessionEvent(session, event));
	}

	private handleSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "assistant") {
					const { model, provider } = event.message as { model?: string; provider?: string };
					const key = `${provider}/${model}`;
					if (model && key !== this.lastModel) {
						if (this.lastModel) {
							this.capture("cli_model_select", { model_id: model, model_provider: provider });
						}
						this.lastModel = key;
					}
					return;
				}
				if (event.message.role !== "user") return;
				const content = event.message.content;
				const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
				let characters = 0;
				let images = 0;
				for (const part of parts as Array<{ type: string; text?: string }>) {
					if (part.type === "text") characters += part.text?.length ?? 0;
					else if (part.type === "image") images += 1;
				}
				this.capture("cli_prompt", { characters, images, streaming: session.isStreaming });
				return;
			}
			case "tool_execution_start":
				this.toolStarts.set(event.toolCallId, Date.now());
				return;
			case "tool_execution_end": {
				const started = this.toolStarts.get(event.toolCallId);
				this.toolStarts.delete(event.toolCallId);
				this.capture("cli_tool_execution", {
					tool: event.toolName,
					duration_ms: started ? Date.now() - started : undefined,
					is_error: event.isError,
				});
				return;
			}
			case "turn_end": {
				const message = event.message as { stopReason?: string; usage?: Record<string, unknown> };
				this.capture("cli_turn_end", {
					stop_reason: message.stopReason,
					tool_results: event.toolResults.length,
					...usageProperties(message.usage),
				});
				return;
			}
			case "agent_end": {
				const stats = session.getSessionStats();
				this.capture("cli_agent_end", {
					will_retry: event.willRetry,
					messages: event.messages.length,
					user_messages: stats.userMessages,
					assistant_messages: stats.assistantMessages,
					tool_calls: stats.toolCalls,
					tokens_input: stats.tokens.input,
					tokens_output: stats.tokens.output,
					tokens_cache_read: stats.tokens.cacheRead,
					tokens_cache_write: stats.tokens.cacheWrite,
					tokens_total: stats.tokens.total,
					cost: stats.cost,
					context_tokens: stats.contextUsage?.tokens,
					context_percent: stats.contextUsage?.percent,
				});
				return;
			}
			case "thinking_level_changed":
				this.capture("cli_thinking_level_changed", { level: event.level });
				return;
			case "compaction_end":
				this.capture("cli_compaction", {
					reason: event.reason,
					aborted: event.aborted,
					will_retry: event.willRetry,
					error: event.errorMessage,
					tokens_before: event.result?.tokensBefore,
				});
				return;
			case "auto_retry_end":
				this.capture("cli_auto_retry", { attempt: event.attempt, success: event.success, error: event.finalError });
				if (!event.success && event.finalError)
					this.capture("cli_error", { source: "auto_retry", message: event.finalError });
				return;
			case "session_info_changed":
				this.capture("cli_session_renamed", { has_name: Boolean(event.name) });
				return;
			default:
				return;
		}
	}

	error(source: string, error: unknown, extra: Properties = {}): void {
		this.capture("cli_error", {
			source,
			message: error instanceof Error ? error.message : String(error),
			name: error instanceof Error ? error.name : undefined,
			...extra,
		});
	}

	/** Final event, then flush. Safe to call more than once. */
	async exit(reason: string, extra: Properties = {}): Promise<void> {
		if (!this.enabled) return;
		this.capture("cli_session_exit", { reason, duration_ms: Date.now() - this.startedAt, ...extra });
		await this.flush();
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.inflight) await this.inflight;
		if (this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		this.inflight = this.send(batch).finally(() => {
			this.inflight = undefined;
		});
		await this.inflight;
	}

	private enqueue(event: string, properties: Properties): void {
		this.queue.push({
			event,
			distinct_id: this.distinctId,
			timestamp: new Date().toISOString(),
			properties: { ...this.base, $process_person_profile: true, ...compact(properties) },
		});
		if (this.queue.length >= FLUSH_AT) {
			void this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, FLUSH_INTERVAL_MS);
			this.timer.unref?.();
		}
	}

	private async send(batch: QueuedEvent[]): Promise<void> {
		try {
			await fetch(`${PALANTIR_HOST}/batch/`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ api_key: PALANTIR_KEY, batch }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			// Telemetry must never surface as a failure; dropped events are fine.
		}
	}

	private loadAnonymousId(agentDir: string): string {
		const file = join(agentDir, "palantir-id");
		try {
			if (existsSync(file)) {
				const saved = readFileSync(file, "utf8").trim();
				if (saved) return saved;
			}
			const id = randomUUID();
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(file, `${id}\n`, "utf8");
			return id;
		} catch {
			return randomUUID();
		}
	}
}

function usageProperties(usage: Record<string, unknown> | undefined): Properties {
	if (!usage) return {};
	const number = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : undefined);
	const cost = usage.cost as Record<string, unknown> | undefined;
	return {
		tokens_input: number("input"),
		tokens_output: number("output"),
		tokens_cache_read: number("cacheRead"),
		tokens_cache_write: number("cacheWrite"),
		cost: cost && typeof cost.total === "number" ? cost.total : undefined,
	};
}

function compact(properties: Properties): Properties {
	const result: Properties = {};
	for (const [key, value] of Object.entries(properties)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

/** Process-wide singleton so any mode can record events without threading a handle around. */
export const palantir = new Palantir();
