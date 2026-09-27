import assert from "node:assert/strict";
import { test } from "node:test";
import { BETA, type CompactionBlock, readCompaction, replaySummary, SUMMARY_PREFIX as PREFIX, toCompactionRequest } from "../protocol.ts";
const block: CompactionBlock = { type: "compaction", content: "S", signature: "sig" };
const summaryPayload = () => ({
	betas: ["oauth-2025-04-20"],
	messages: [
		{ role: "user", content: [{ type: "text", text: `${PREFIX}S\n</summary>`, cache_control: { type: "ephemeral" } }] },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
	],
});

test("replaySummary swaps the summary for the block and adds the beta", () => {
	const p = summaryPayload();
	assert.equal(replaySummary(p, block), true);
	assert.deepEqual(p.messages[0].content[0], { ...block, cache_control: { type: "ephemeral" } });
	assert.deepEqual(p.betas, ["oauth-2025-04-20", BETA]);
	assert.equal(replaySummary(p, block), false); // already swapped: no summary text left
});

test("replaySummary leaves requests without a leading summary alone", () => {
	const p = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
	assert.equal(replaySummary(p, block), false);
	assert.equal("betas" in p, false);
});

test("toCompactionRequest adds compaction, instructions, and the prior block", () => {
	const p = toCompactionRequest(summaryPayload(), "focus", block);
	assert.deepEqual(p.compaction, { type: "summarize", instructions: "focus" });
	assert.equal(p.messages![0].content[0].type, "compaction");
	assert.throws(() => toCompactionRequest({ messages: [] }, undefined, block));
	assert.deepEqual(toCompactionRequest({ messages: [] }, undefined, undefined).compaction, { type: "summarize" });
});

test("readCompaction extracts the block and stop reason from SSE", async () => {
	const sse = [
		'event: message_start\ndata: {"type":"message_start","message":{}}',
		"event: ping\ndata: {\"type\":\"ping\"}",
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: block })}`,
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"compaction"},"usage":{"iterations":[{"type":"compaction","input_tokens":144,"output_tokens":276}]}}',
		'event: message_stop\ndata: {"type":"message_stop"}',
	].join("\n\n");
	const bytes = new TextEncoder().encode(sse);
	// split mid-line to exercise chunk joining
	const body = new ReadableStream({
		start(c) {
			c.enqueue(bytes.slice(0, 50));
			c.enqueue(bytes.slice(50));
			c.close();
		},
	});
	assert.deepEqual(await readCompaction(body), {
		block,
		stopReason: "compaction",
		complete: true,
		iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }],
	});
});

test("readCompaction marks a stream without message_stop incomplete", async () => {
	const sse = `data: ${JSON.stringify({ type: "content_block_start", content_block: block })}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"compaction"}}\n\n`;
	const r = await readCompaction(new Response(sse).body!);
	assert.equal(r.complete, false);
});
