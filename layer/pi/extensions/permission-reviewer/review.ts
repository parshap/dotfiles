/**
 * The model call, output parsing, and verdict mapping.
 *
 * Mapping (Claude Code auto mode): the model's `allow` becomes an allow; its
 * block (`deny`) becomes a deny the agent sees as a failed tool call, unless the
 * session has hit the denial limits, in which case the ask defers to the human
 * (Claude Code's 3-consecutive / 20-total fallback). Every failure — no model,
 * auth, timeout, provider error, unparseable output — defers, so a broken
 * reviewer means more prompting, never less.
 */

import { REJECTION_INSTRUCTIONS } from "./policy.ts";

export type ModelOutcome = "allow" | "block";

export interface ParsedAssessment {
	outcome: ModelOutcome;
	rule: string;
	riskLevel: string | undefined;
	intentLevel: string | undefined;
	rationale: string;
}

const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const INTENT_LEVELS = new Set(["unknown", "low", "medium", "high"]);

/**
 * Parse the reviewer's reply. Accepts the whole text as JSON, or one prose or
 * code-fence wrapper around it (first `{` to last `}`), as Codex's parser does.
 * Returns `undefined` for anything without a recognizable `outcome`.
 */
export function parseAssessment(text: string): ParsedAssessment | undefined {
	const trimmed = text.trim();
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			value = JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const raw = typeof v.outcome === "string" ? v.outcome.trim().toLowerCase() : "";
	let outcome: ModelOutcome;
	if (raw === "allow") outcome = "allow";
	else if (raw === "deny" || raw === "block") outcome = "block";
	else return undefined;
	const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
	const risk = str(v.risk_level, 20).toLowerCase();
	const intent = str(v.user_authorization, 20).toLowerCase();
	return {
		outcome,
		rule: str(v.rule, 80),
		riskLevel: RISK_LEVELS.has(risk) ? risk : outcome === "allow" ? "low" : "high",
		intentLevel: INTENT_LEVELS.has(intent) ? intent : "unknown",
		rationale: str(v.rationale, 600),
	};
}

// ── Denial counters and verdict mapping ───────────────────────────────────────

export interface DenialState {
	consecutive: number;
	total: number;
}

export interface DenialLimits {
	maxConsecutive: number;
	maxTotal: number;
}

export type MappedVerdict =
	| { kind: "allow" }
	| { kind: "deny" }
	| { kind: "defer"; fallback: "consecutive" | "total" };

/**
 * Map a model outcome to a chain verdict and update the session's counters.
 *
 * An allow resets the consecutive count. A block is denied until the session
 * has already denied `maxConsecutive` in a row or `maxTotal` overall; the next
 * block then defers to the human and resets the counter that fired (a total
 * fallback resets both), so autonomous review resumes after the human decides.
 */
export function mapOutcome(state: DenialState, outcome: ModelOutcome, limits: DenialLimits): MappedVerdict {
	if (outcome === "allow") {
		state.consecutive = 0;
		return { kind: "allow" };
	}
	if (state.total >= limits.maxTotal) {
		state.total = 0;
		state.consecutive = 0;
		return { kind: "defer", fallback: "total" };
	}
	if (state.consecutive >= limits.maxConsecutive) {
		state.consecutive = 0;
		return { kind: "defer", fallback: "consecutive" };
	}
	state.consecutive++;
	state.total++;
	return { kind: "deny" };
}

/** The reason the agent sees on a denial. */
export function denialReason(assessment: Pick<ParsedAssessment, "rule" | "rationale">): string {
	const label = assessment.rule ? ` [${assessment.rule}]` : "";
	const why = assessment.rationale || "The action matches a blocking rule in the permission review policy.";
	return `Blocked by the permission reviewer${label}; the action did not run. ${why} ${REJECTION_INSTRUCTIONS}`;
}

// ── Model call ────────────────────────────────────────────────────────────────

/** The subset of pi-ai's `Model` used here. */
export interface ModelLike {
	id: string;
	name?: string;
	provider: string;
	api?: string;
	[key: string]: unknown;
}

export interface RegistryLike {
	find(provider: string, modelId: string): ModelLike | undefined;
	getAvailable(): ModelLike[];
	streamSimple(model: ModelLike, context: unknown, options?: Record<string, unknown>): { result(): Promise<AssistantReply> };
}

export interface AssistantReply {
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number };
}

/**
 * Resolve `provider/model-id`. A model id the provider does not list — the
 * hidden `codex-auto-review` alias — is called with a listed model of the same
 * provider as its template (same API, base URL, and auth), as
 * @erichll/pi-auto-review's `resolveReviewerMeta` does.
 */
export function resolveModel(registry: Pick<RegistryLike, "find" | "getAvailable">, ref: string): ModelLike | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	const listed = registry.find(provider, id);
	if (listed) return listed;
	const template = registry.getAvailable().find((m) => m.provider === provider);
	return template ? { ...template, id, name: id } : undefined;
}

export type FailureKind = "no-model" | "timeout" | "provider-error" | "unparseable" | "action-too-large" | "internal";

export type CallResult =
	| { ok: true; assessment: ParsedAssessment; latencyMs: number; usage?: AssistantReply["usage"] }
	| { ok: false; failure: FailureKind; detail: string; latencyMs: number; rawSnippet?: string };

export interface CallOptions {
	registry: RegistryLike;
	modelRef: string;
	reasoning: string;
	maxOutputTokens: number;
	timeoutMs: number;
	systemPrompt: string;
	userPrompt: string;
	cacheSessionId?: string;
	signal?: AbortSignal;
}

function replyText(reply: AssistantReply): string {
	return (reply.content ?? [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("");
}

/** One bounded model call. Never throws. */
export async function callReviewer(options: CallOptions): Promise<CallResult> {
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	const model = resolveModel(options.registry, options.modelRef);
	if (!model) {
		return { ok: false, failure: "no-model", detail: `no available model for ${options.modelRef}`, latencyMs: elapsed() };
	}
	const controller = new AbortController();
	const onOuterAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onOuterAbort, { once: true });
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new Error("review timed out"));
		}, options.timeoutMs);
	});
	try {
		const context = {
			systemPrompt: options.systemPrompt,
			messages: [{ role: "user", content: options.userPrompt, timestamp: Date.now() }],
		};
		const stream = options.registry.streamSimple(model, context, {
			signal: controller.signal,
			reasoning: options.reasoning,
			maxTokens: options.maxOutputTokens,
			maxRetries: 0,
			// A review is an independent request: no websocket continuation of a prior review.
			transport: "sse",
			cacheRetention: "short",
			...(options.cacheSessionId ? { sessionId: options.cacheSessionId } : {}),
		});
		const reply = await Promise.race([stream.result(), deadline]);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return {
				ok: false,
				failure: timedOut ? "timeout" : "provider-error",
				detail: (reply.errorMessage ?? reply.stopReason).slice(0, 300),
				latencyMs: elapsed(),
			};
		}
		const text = replyText(reply);
		const assessment = parseAssessment(text);
		if (!assessment) {
			return { ok: false, failure: "unparseable", detail: "reply had no valid outcome", latencyMs: elapsed(), rawSnippet: text.slice(0, 200) };
		}
		return { ok: true, assessment, latencyMs: elapsed(), usage: reply.usage };
	} catch (error) {
		return {
			ok: false,
			failure: timedOut ? "timeout" : "provider-error",
			detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
			latencyMs: elapsed(),
		};
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onOuterAbort);
	}
}
