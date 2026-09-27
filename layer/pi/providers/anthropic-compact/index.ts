// Anthropic server-side compaction for pi (on-demand, beta compact-2026-09-04).
//
// - Auto-compaction (threshold/overflow) on anthropic-messages models uses the server.
// - /anthropic-compact [instructions] compacts now via the server; plain /compact stays pi's summary.
// - On failure nothing is compacted; the user is told and can retry or run /compact.
// - The signed block is stored in the compaction entry's details and swapped in for pi's text
//   summary on every later request to the same model. Other models see the text summary.
import { type Api, calculateCost, type Model, type Tool, type Usage } from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Compaction, type CompactionBlock, readCompaction, replaySummary, toCompactionRequest } from "./protocol.ts";

// Marks /anthropic-compact's own ctx.compact() call; carried in customInstructions so the
// intent travels with that invocation instead of shared state.
const COMMAND_MARKER = "\u0000anthropic-compact\u0000";
// Documented errors for a replayed block that Anthropic refuses.
const REJECTED = /compaction_(signature_invalid|content_mismatch|block_misplaced)/;

type Saved = { provider: string; modelId: string; block: CompactionBlock };
type Details = { anthropicServerCompaction: Saved };

const isAnthropic = (model: Model<Api> | undefined): model is Model<Api> => model?.api === "anthropic-messages";

/** The signed block of the active compaction, if it was ours and made by `model`. */
function activeBlock(entries: SessionEntry[], model: Model<Api> | undefined): CompactionBlock | undefined {
	const entry = entries.findLast((e) => e.type === "compaction");
	const saved = entry?.type === "compaction" ? (entry.details as Details | undefined)?.anthropicServerCompaction : undefined;
	return saved && model && saved.provider === model.provider && saved.modelId === model.id ? saved.block : undefined;
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
	return pi.getActiveTools().flatMap((name) => {
		const t = all.get(name);
		return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [];
	});
}

async function serverCompact(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	model: Model<Api>,
	instructions: string | undefined,
): Promise<CompactionResult<Details>> {
	const prep = event.preparation;
	// Older turns only; entries from firstKeptEntryId stay verbatim after the block.
	const messages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
	if (prep.previousSummary !== undefined) {
		messages.unshift({ role: "compactionSummary", summary: prep.previousSummary, tokensBefore: 0, timestamp: Date.now() } as any);
	}
	const prior = activeBlock(event.branchEntries, model);

	let tapped: Promise<Compaction> | undefined;
	const tapFetch: typeof fetch = async (input, init) => {
		const res = await fetch(input, init);
		if (!res.ok || !res.body) return res;
		const [mine, theirs] = res.body.tee();
		tapped = readCompaction(mine);
		return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
	};

	// Through the model registry so provider wrappers (pi-anthropic-auth OAuth shaping) apply.
	const level = pi.getThinkingLevel();
	const stream = ctx.modelRegistry.streamSimple(
		model,
		{ systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: activeTools(pi) },
		{
			signal: event.signal,
			sessionId: ctx.sessionManager.getSessionId(),
			reasoning: level === "off" ? undefined : level,
			fetch: tapFetch,
			onPayload: (payload) => toCompactionRequest(payload as any, instructions, prior),
		},
	);
	// pi-ai doesn't know stop_reason "compaction" and ends the stream with an error; the tap has the truth.
	const final = await stream.result();
	const { block, stopReason, complete, iterations } = (await tapped) ?? { complete: false, iterations: [] };
	if (!complete || stopReason !== "compaction" || !block) {
		throw new Error(stopReason ? `no summary (stop_reason ${stopReason})` : (final.errorMessage ?? "no response"));
	}
	const sum = (k: keyof (typeof iterations)[number]) => iterations.reduce((n, it) => n + (Number(it[k]) || 0), 0);
	const usage = { input: sum("input_tokens"), output: sum("output_tokens"), cacheRead: sum("cache_read_input_tokens"), cacheWrite: sum("cache_creation_input_tokens") } as Usage;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	calculateCost(model, usage);
	return {
		summary: block.content,
		firstKeptEntryId: prep.firstKeptEntryId,
		tokensBefore: prep.tokensBefore,
		usage,
		details: { anthropicServerCompaction: { provider: model.provider, modelId: model.id, block } },
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("anthropic-compact", {
		description: "Compact via Anthropic server-side compaction (optional: summary instructions)",
		handler: async (args, ctx) => {
			if (!isAnthropic(ctx.model)) {
				ctx.ui.notify("/anthropic-compact needs an Anthropic model", "error");
				return;
			}
			ctx.compact({ customInstructions: COMMAND_MARKER + args.trim() });
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const ours = event.customInstructions?.startsWith(COMMAND_MARKER);
		if (event.reason === "manual" && !ours) return undefined; // plain /compact: pi's summary
		if (!isAnthropic(ctx.model)) {
			if (!ours) return undefined;
			ctx.ui.notify("/anthropic-compact needs an Anthropic model", "error");
			return { cancel: true };
		}
		const instructions = ours ? event.customInstructions!.slice(COMMAND_MARKER.length) || undefined : undefined;
		try {
			return { compaction: await serverCompact(pi, event, ctx, ctx.model, instructions) };
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Server compaction failed, nothing was compacted: ${message}\nRetry with /anthropic-compact, or run /compact for pi's summary.`,
					"error",
				);
			}
			return { cancel: true };
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const block = activeBlock(ctx.sessionManager.getBranch(), ctx.model);
		if (!block) return undefined;
		if (!replaySummary(event.payload as any, block)) {
			ctx.ui.notify("Server compaction block not replayed: pi's summary wasn't at the start of the request.", "warning");
			return undefined;
		}
		return event.payload;
	});

	pi.on("message_end", (event, ctx) => {
		const m = event.message;
		if (m.role !== "assistant" || m.stopReason !== "error" || !REJECTED.test(m.errorMessage ?? "")) return;
		if (!activeBlock(ctx.sessionManager.getBranch(), ctx.model)) return;
		ctx.ui.notify(
			"Anthropic rejected the server compaction block. Run /compact to replace it with pi's summary, or switch models.",
			"error",
		);
	});
}
