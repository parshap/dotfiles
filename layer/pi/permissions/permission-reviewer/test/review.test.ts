import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../config.ts";
import { REJECTION_INSTRUCTIONS, SYSTEM_PROMPT } from "../policy.ts";
import {
	type AssistantReply,
	callReviewer,
	type DenialState,
	denialReason,
	mapOutcome,
	type ModelLike,
	parseAssessment,
	type RegistryLike,
	resolveModel,
} from "../review.ts";

test("parseAssessment accepts strict JSON, fenced JSON, prose-wrapped JSON, and 'block'", () => {
	assert.equal(parseAssessment('{"outcome":"allow"}')?.outcome, "allow");
	const fenced = parseAssessment('```json\n{"outcome":"deny","rule":"External Write","risk_level":"high","user_authorization":"low","rationale":"push not requested"}\n```');
	assert.deepEqual(fenced, { outcome: "block", rule: "External Write", riskLevel: "high", intentLevel: "low", rationale: "push not requested" });
	assert.equal(parseAssessment('Verdict: {"outcome":"block"} done')?.outcome, "block");
	assert.equal(parseAssessment('{"outcome":"DENY"}')?.riskLevel, "high");
});

test("parseAssessment rejects output without a recognizable outcome", () => {
	for (const text of ["", "allow", "{}", '{"outcome":"maybe"}', '{"outcome":"allow"', "[1,2]", '{"verdict":"allow"}']) {
		assert.equal(parseAssessment(text), undefined, text);
	}
});

const limits = { maxConsecutive: 3, maxTotal: 20 };

test("three consecutive blocks deny, the fourth defers to the human, then denial resumes", () => {
	const state: DenialState = { consecutive: 0, total: 0 };
	assert.deepEqual(
		[1, 2, 3, 4, 5].map(() => mapOutcome(state, "block", limits).kind),
		["deny", "deny", "deny", "defer", "deny"],
	);
	assert.equal(state.consecutive, 1);
	assert.equal(state.total, 4);
});

test("an allow resets the consecutive count but not the total", () => {
	const state: DenialState = { consecutive: 0, total: 0 };
	mapOutcome(state, "block", limits);
	mapOutcome(state, "block", limits);
	assert.equal(mapOutcome(state, "allow", limits).kind, "allow");
	assert.deepEqual(state, { consecutive: 0, total: 2 });
	assert.equal(mapOutcome(state, "block", limits).kind, "deny");
});

test("the twentieth total denial is followed by a defer that resets both counters", () => {
	const state: DenialState = { consecutive: 0, total: 0 };
	for (let i = 0; i < 20; i++) {
		assert.equal(mapOutcome(state, "block", limits).kind, "deny");
		if (i % 2 === 0) mapOutcome(state, "allow", limits);
	}
	assert.equal(state.total, 20);
	assert.deepEqual(mapOutcome(state, "block", limits), { kind: "defer", fallback: "total" });
	assert.deepEqual(state, { consecutive: 0, total: 0 });
});

test("denialReason tells the agent the action did not run and not to work around it", () => {
	const reason = denialReason({ rule: "External Write", rationale: "The user did not ask to push." });
	assert.match(reason, /^Blocked by the permission reviewer \[External Write\]; the action did not run\. The user did not ask to push\./);
	assert.ok(reason.endsWith(REJECTION_INSTRUCTIONS));
	assert.match(denialReason({ rule: "", rationale: "" }), /matches a blocking rule/);
});

const template: ModelLike = { id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://x" };

function registry(reply: () => Promise<AssistantReply>, seen: Array<{ model: ModelLike; options?: Record<string, unknown> }> = []): RegistryLike {
	return {
		find: (provider, id) => (provider === template.provider && id === template.id ? template : undefined),
		getAvailable: () => [template],
		streamSimple(model, _context, options) {
			seen.push({ model, options });
			return { result: reply };
		},
	};
}

test("resolveModel borrows a listed model of the same provider for an unlisted id", () => {
	const r = registry(async () => ({}));
	assert.equal(resolveModel(r, "openai-codex/gpt-5.6-luna"), template);
	assert.deepEqual(resolveModel(r, "openai-codex/codex-auto-review"), { ...template, id: "codex-auto-review", name: "codex-auto-review" });
	assert.equal(resolveModel(r, "anthropic/claude"), undefined);
	assert.equal(resolveModel(r, "no-slash"), undefined);
});

const base = {
	modelRef: "openai-codex/codex-auto-review",
	reasoning: "low",
	maxOutputTokens: 1000,
	timeoutMs: 1000,
	systemPrompt: "sys",
	userPrompt: "usr",
};

test("callReviewer returns the parsed assessment and sends low reasoning to the borrowed model", async () => {
	const seen: Array<{ model: ModelLike; options?: Record<string, unknown> }> = [];
	const r = registry(async () => ({ content: [{ type: "text", text: '{"outcome":"allow"}' }], stopReason: "stop", usage: { input: 10, output: 2 } }), seen);
	const result = await callReviewer({ ...base, registry: r });
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.assessment.outcome, "allow");
	assert.equal(seen[0].model.id, "codex-auto-review");
	assert.equal(seen[0].options?.reasoning, "low");
	assert.equal(seen[0].options?.maxTokens, 1000);
});

test("callReviewer reports failures instead of throwing", async () => {
	const timeout = await callReviewer({ ...base, timeoutMs: 20, registry: registry(() => new Promise(() => {})) });
	assert.deepEqual([timeout.ok, !timeout.ok && timeout.failure], [false, "timeout"]);

	const err = await callReviewer({ ...base, registry: registry(async () => ({ stopReason: "error", errorMessage: "401 unauthorized" })) });
	assert.deepEqual([err.ok, !err.ok && err.failure, !err.ok && err.detail], [false, "provider-error", "401 unauthorized"]);

	const thrown = await callReviewer({ ...base, registry: registry(async () => Promise.reject(new Error("ECONNRESET"))) });
	assert.equal(!thrown.ok && thrown.failure, "provider-error");

	const junk = await callReviewer({ ...base, registry: registry(async () => ({ content: [{ type: "text", text: "I think it's fine" }], stopReason: "stop" })) });
	assert.equal(!junk.ok && junk.failure, "unparseable");

	const none = await callReviewer({ ...base, modelRef: "nobody/model", registry: registry(async () => ({})) });
	assert.equal(!none.ok && none.failure, "no-model");
});

test("config merges known well-typed keys and reports the rest", () => {
	const { config, issues } = mergeConfig({ model: "anthropic/claude-haiku-4.5", timeoutMs: 5000, reasoning: "bogus", extra: 1, maxTotalDenials: -1, $schema: "x" });
	assert.equal(config.model, "anthropic/claude-haiku-4.5");
	assert.equal(config.timeoutMs, 5000);
	assert.equal(config.reasoning, DEFAULT_CONFIG.reasoning);
	assert.equal(config.maxTotalDenials, DEFAULT_CONFIG.maxTotalDenials);
	assert.equal(issues.length, 3);
	assert.deepEqual(loadConfig("/x", () => undefined).config, { ...DEFAULT_CONFIG });
	assert.match(loadConfig("/x", () => "{nope").issues[0], /invalid JSON/);
});

test("the system prompt carries the block-list policy and the Codex output contract", () => {
	for (const label of ["Data Exfiltration", "Security Control Tampering", "Code from External", "Credential Materialization", "Git Push Destination", "Irreversible Local Destruction", "Local Development", "User Intent Rule"]) {
		assert.ok(SYSTEM_PROMPT.includes(label), label);
	}
	assert.ok(SYSTEM_PROMPT.includes('{"outcome":"allow"}'));
	assert.ok(!SYSTEM_PROMPT.includes("{{"));
});
