/**
 * permission-reviewer
 *
 * A model-backed authorizer link for @gotgenes/pi-permission-system. When the
 * deterministic policy lands on `ask`, this link reviews the pending action
 * with a model, Claude Code auto mode style, and returns allow, deny (with a
 * reason the agent sees), or defer (the ask goes on to the human). See
 * README.md for the security model and policy provenance.
 *
 * Activation: name "permission-reviewer" in pi-permission-system's
 * `authorizerChain`. Registration alone grants nothing.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ReviewerConfig } from "./config.ts";
import type { SessionEntryLike } from "./context.ts";
import { type ChildFileCache, type EvidenceIo, gatherEvidence } from "./evidence.ts";
import { SYSTEM_PROMPT } from "./policy.ts";
import { type AskDetails, askSurface, askToolName, renderUserPrompt } from "./prompt.ts";
import { callReviewer, type DenialState, denialReason, mapOutcome, type RegistryLike } from "./review.ts";

const LINK_NAME = "permission-reviewer";
const LOG_EVENT = "permission_reviewer.decision";

type Verdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };
interface AuthorizerLog {
	review(event: string, details?: Record<string, unknown>): void;
}
type Authorize = (details: AskDetails, query: unknown, log: AuthorizerLog) => Promise<Verdict>;
interface PermissionsServiceLike {
	registerAuthorizer(name: string, authorize: Authorize): () => void;
}

/**
 * The permission system's documented locator, `getPermissionsService(sessionId)`,
 * reads this process-global map. This extension lives outside the npm tree and
 * cannot import the package, so it reads the same map directly.
 */
const SESSION_SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services");

function permissionsService(sessionId: string): PermissionsServiceLike | undefined {
	const services = (globalThis as Record<symbol, unknown>)[SESSION_SERVICES_KEY] as Map<string, PermissionsServiceLike> | undefined;
	return services?.get(sessionId);
}

/** Surfaces whose allow the chain owner caps to defer (bounded-delegation checkpoint). */
function allowIsCapped(surface: string): boolean {
	return surface === "path" || surface.startsWith("path_") || surface.startsWith("external_directory");
}

const realIo: EvidenceIo = {
	fs: {
		readdir: (path) => readdirSync(path, { withFileTypes: true }),
		readHead: (path) => {
			const fd = openSync(path, "r");
			try {
				const buffer = Buffer.alloc(4096);
				const n = readSync(fd, buffer, 0, buffer.length, 0);
				return buffer.subarray(0, n).toString("utf8");
			} finally {
				closeSync(fd);
			}
		},
	},
	readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	gitStatus: (dir) => {
		try {
			return execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"], {
				encoding: "utf8",
				timeout: 3_000,
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
				// Read-only: do not refresh the index as a side effect.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			});
		} catch {
			return undefined;
		}
	},
	relatedRunIds: (runId) => {
		// pi-subagents records a workflow child's parent workflow run in its async status file.
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (uid === undefined) return [];
		const path = join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs", runId, "status.json");
		try {
			if (!existsSync(path)) return [];
			const status = JSON.parse(readFileSync(path, "utf8")) as { parentWorkflowRunId?: unknown };
			return typeof status.parentWorkflowRunId === "string" ? [status.parentWorkflowRunId.toLowerCase()] : [];
		} catch {
			return [];
		}
	},
};

export default function permissionReviewer(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let config: ReviewerConfig | undefined;
	let dispose: (() => void) | undefined;
	let denials: DenialState = { consecutive: 0, total: 0 };
	let childFiles: ChildFileCache = new Map();

	pi.on("session_start", (_event, context) => {
		ctx = context;
		const agentDir = getAgentDir();
		const loaded = loadConfig(join(agentDir, "extensions", LINK_NAME, "config.json"), realIo.readFile);
		config = loaded.config;
		for (const issue of loaded.issues) console.warn(`[${LINK_NAME}] config: ${issue}`);
	});

	pi.events.on("permissions:ready", (data) => {
		// The ready event may repeat; register once per session.
		if (dispose) return;
		const sessionId = (data as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof sessionId !== "string") return;
		const service = permissionsService(sessionId);
		if (!service) {
			console.warn(`[${LINK_NAME}] no pi-permission-system service for session ${sessionId}; link not registered`);
			return;
		}
		dispose = service.registerAuthorizer(LINK_NAME, authorize);
	});

	pi.on("session_shutdown", () => {
		dispose?.();
		dispose = undefined;
		ctx = undefined;
		config = undefined;
		denials = { consecutive: 0, total: 0 };
		childFiles = new Map();
	});

	async function authorize(details: AskDetails, _query: unknown, log: AuthorizerLog): Promise<Verdict> {
		const surface = askSurface(details);
		const base: Record<string, unknown> = {
			requestId: details.requestId,
			surface,
			toolName: askToolName(details) ?? null,
			forwarded: Boolean(details.forwarding),
			requesterAgent: details.forwarding?.requesterAgentName ?? details.agentName ?? null,
		};
		const context = ctx;
		const cfg = config;
		if (!context || !cfg) {
			log.review(LOG_EVENT, { ...base, verdict: "defer", failure: "internal", detail: "reviewer has no active session" });
			return { kind: "defer" };
		}
		base.model = cfg.model;

		let userPrompt: string;
		let stats: Record<string, unknown>;
		try {
			const sm = context.sessionManager;
			const { evidence, stats: s } = gatherEvidence(
				{
					details,
					entries: sm.getBranch() as unknown as SessionEntryLike[],
					servingCwd: context.cwd,
					servingSessionFile: sm.getSessionFile(),
					servingSessionDir: sm.getSessionDir(),
					globalInstructionsPath: join(getAgentDir(), "AGENTS.md"),
					config: cfg,
					io: realIo,
				},
				childFiles,
			);
			stats = { ...s };
			const actionChars = JSON.stringify(evidence.action).length;
			if (actionChars > cfg.actionMaxChars) {
				log.review(LOG_EVENT, { ...base, ...stats, verdict: "defer", failure: "action-too-large", actionChars });
				return { kind: "defer" };
			}
			userPrompt = renderUserPrompt(evidence);
		} catch (error) {
			log.review(LOG_EVENT, { ...base, verdict: "defer", failure: "internal", detail: String(error).slice(0, 300) });
			return { kind: "defer" };
		}

		const result = await callReviewer({
			registry: context.modelRegistry as unknown as RegistryLike,
			modelRef: cfg.model,
			reasoning: cfg.reasoning,
			maxOutputTokens: cfg.maxOutputTokens,
			timeoutMs: cfg.timeoutMs,
			systemPrompt: SYSTEM_PROMPT,
			userPrompt,
			cacheSessionId: `${LINK_NAME}-${context.sessionManager.getSessionId()}`.slice(0, 64),
		});
		const common = { ...base, ...stats, promptChars: userPrompt.length, latencyMs: result.latencyMs };
		if (!result.ok) {
			log.review(LOG_EVENT, {
				...common,
				verdict: "defer",
				failure: result.failure,
				detail: result.detail,
				...(result.rawSnippet ? { rawSnippet: result.rawSnippet } : {}),
			});
			return { kind: "defer" };
		}

		const { assessment } = result;
		const mapped = mapOutcome(denials, assessment.outcome, {
			maxConsecutive: cfg.maxConsecutiveDenials,
			maxTotal: cfg.maxTotalDenials,
		});
		const verdict: Verdict = mapped.kind === "deny" ? { kind: "deny", reason: denialReason(assessment) } : { kind: mapped.kind };
		log.review(LOG_EVENT, {
			...common,
			verdict: verdict.kind,
			modelOutcome: assessment.outcome,
			rule: assessment.rule || null,
			riskLevel: assessment.riskLevel,
			intentLevel: assessment.intentLevel,
			rationale: assessment.rationale || null,
			...(mapped.kind === "defer" ? { fallback: mapped.fallback } : {}),
			...(verdict.kind === "allow" && allowIsCapped(surface) ? { allowCappedByChain: true } : {}),
			denialsConsecutive: denials.consecutive,
			denialsTotal: denials.total,
			usage: result.usage
				? { input: result.usage.input, output: result.usage.output, reasoning: result.usage.reasoning, cacheRead: result.usage.cacheRead }
				: undefined,
		});
		return verdict;
	}
}
