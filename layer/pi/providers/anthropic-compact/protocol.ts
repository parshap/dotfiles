// Anthropic on-demand compaction wire protocol (beta compact-2026-09-04).
// https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
// No pi imports, so tests run under plain `node --test`.

export const BETA = "compact-2026-09-04";
// pi's COMPACTION_SUMMARY_PREFIX (core/messages.ts); not exported from the package.
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

export type CompactionBlock = { type: "compaction"; content: string; signature: string };

type Payload = { messages?: any[]; betas?: string[]; [key: string]: unknown };

function addBeta(payload: Payload): void {
	if (!payload.betas?.includes(BETA)) payload.betas = [...(payload.betas ?? []), BETA];
}

/**
 * Replace pi's text summary (first content block of the first message)
 * with the signed block, exactly as returned. Returns false if the summary isn't there.
 */
export function replaySummary(payload: Payload, block: CompactionBlock): boolean {
	const first = payload.messages?.[0];
	const head = Array.isArray(first?.content) ? first.content[0] : undefined;
	if (first?.role !== "user" || head?.type !== "text" || !head.text.startsWith(SUMMARY_PREFIX)) return false;
	first.content[0] = head.cache_control ? { ...block, cache_control: head.cache_control } : { ...block };
	addBeta(payload);
	return true;
}

/** Turn an ordinary Messages request into a summarize request. `prior` is the previous block, if any. */
export function toCompactionRequest(
	payload: Payload,
	instructions: string | undefined,
	prior: CompactionBlock | undefined,
): Payload {
	if (prior && !replaySummary(payload, prior)) {
		throw new Error("previous compaction block has no summary to replace in the request");
	}
	payload.compaction = instructions ? { type: "summarize", instructions } : { type: "summarize" };
	addBeta(payload);
	return payload;
}

/** Billed compaction usage; top-level usage is zero on a compaction response. */
export type Iteration = { type?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

export type Compaction = { block?: CompactionBlock; stopReason?: string; complete: boolean; iterations: Iteration[] };

/** Read a Messages SSE body; the compaction block arrives whole in one content_block_start. */
export async function readCompaction(body: ReadableStream<Uint8Array>): Promise<Compaction> {
	let text = "";
	const decoder = new TextDecoder();
	for await (const chunk of body as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
	let block: CompactionBlock | undefined;
	let stopReason: string | undefined;
	let complete = false;
	let iterations: Iteration[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const event = JSON.parse(line.slice(5));
		const usage = event.type === "message_start" ? event.message?.usage : event.usage;
		if (Array.isArray(usage?.iterations)) iterations = usage.iterations;
		if (event.type === "content_block_start" && event.content_block?.type === "compaction") block = event.content_block;
		if (event.type === "message_delta" && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
		if (event.type === "message_stop") complete = true;
	}
	return { block, stopReason, complete, iterations };
}
