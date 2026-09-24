/**
 * Reviewer configuration: defaults plus an optional JSON file at
 * `<agentDir>/extensions/permission-reviewer/config.json`.
 *
 * Pure except for `loadConfig`, which takes the file reader as a parameter so
 * tests do not touch the filesystem.
 */

export interface ReviewerConfig {
	/** `provider/model-id`. An id the provider does not list is called by borrowing a listed model's transport. */
	model: string;
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Deadline for one review, model call included. */
	timeoutMs: number;
	maxOutputTokens: number;
	/** Budget for the serving session's user messages. The first and newest are kept first. */
	userMessagesChars: number;
	userMessageChars: number;
	/** Budget for non-read-only tool calls (newest kept). */
	toolCallsMax: number;
	toolCallsChars: number;
	toolCallChars: number;
	/** Budget for a forwarded ask's subagent context. */
	subagentTaskChars: number;
	subagentToolCallsMax: number;
	launchCallChars: number;
	/** Budget per instruction file (global AGENTS.md, project AGENTS.md/CLAUDE.md). */
	instructionsChars: number;
	gitStatusLines: number;
	/** The pending action is never truncated; above this size the review defers to the human. */
	actionMaxChars: number;
	/** Claude Code's fallback: after this many blocks, defer instead of deny. */
	maxConsecutiveDenials: number;
	maxTotalDenials: number;
}

export const DEFAULT_CONFIG: Readonly<ReviewerConfig> = Object.freeze({
	model: "openai-codex/codex-auto-review",
	reasoning: "low",
	timeoutMs: 60_000,
	maxOutputTokens: 4_000,
	userMessagesChars: 16_000,
	userMessageChars: 4_000,
	toolCallsMax: 30,
	toolCallsChars: 12_000,
	toolCallChars: 1_500,
	subagentTaskChars: 6_000,
	subagentToolCallsMax: 20,
	launchCallChars: 4_000,
	instructionsChars: 6_000,
	gitStatusLines: 40,
	actionMaxChars: 40_000,
	maxConsecutiveDenials: 3,
	maxTotalDenials: 20,
});

const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export interface LoadedConfig {
	config: ReviewerConfig;
	issues: string[];
}

/** Merge a parsed JSON value over the defaults, keeping only well-typed fields. */
export function mergeConfig(raw: unknown): LoadedConfig {
	const config: ReviewerConfig = { ...DEFAULT_CONFIG };
	const issues: string[] = [];
	if (raw === undefined) return { config, issues };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, issues: ["config is not a JSON object; using defaults"] };
	}
	const record = raw as Record<string, unknown>;
	const target = config as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("$") || key.startsWith("//")) continue;
		if (!(key in DEFAULT_CONFIG)) {
			issues.push(`unknown key "${key}" ignored`);
			continue;
		}
		const expected = typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
		if (key === "model") {
			if (typeof value === "string" && /^[^/\s]+\/\S+$/.test(value)) target[key] = value;
			else issues.push(`"model" must be "provider/model-id"`);
		} else if (key === "reasoning") {
			if (typeof value === "string" && REASONING_LEVELS.has(value)) target[key] = value;
			else issues.push(`"reasoning" must be one of ${[...REASONING_LEVELS].join(", ")}`);
		} else if (expected === "number") {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] = Math.floor(value);
			else issues.push(`"${key}" must be a positive number`);
		}
	}
	return { config, issues };
}

/** Read and merge the config file; a missing file yields the defaults. */
export function loadConfig(path: string, readFile: (path: string) => string | undefined): LoadedConfig {
	let text: string | undefined;
	try {
		text = readFile(path);
	} catch (error) {
		return { config: { ...DEFAULT_CONFIG }, issues: [`cannot read ${path}: ${String(error)}`] };
	}
	if (text === undefined) return mergeConfig(undefined);
	try {
		return mergeConfig(JSON.parse(text));
	} catch (error) {
		return { config: { ...DEFAULT_CONFIG }, issues: [`invalid JSON in ${path}: ${String(error)}`] };
	}
}
