/**
 * Assembles the reviewer's evidence for one ask from the serving session's
 * entries, the forwarded subagent's transcript (when the ask was forwarded),
 * instruction files, and a git status before destructive commands.
 *
 * All I/O is injected, so forwarded-ask handling is testable without Pi.
 */

import type { ReviewerConfig } from "./config.ts";
import {
	extractToolCalls,
	extractUserMessages,
	findLaunchCall,
	findSessionFile,
	type FsLike,
	isDestructiveCommand,
	readChildContext,
	renderToolCall,
	selectToolCalls,
	selectUserMessages,
	type SessionEntryLike,
	summarizeGitStatus,
	type ToolCallRecord,
	truncateMiddle,
} from "./context.ts";
import { type AskDetails, askCommand, buildPlannedAction, type ReviewEvidence } from "./prompt.ts";

export interface EvidenceIo {
	fs: FsLike;
	/** Whole-file read; `undefined` when the file does not exist. */
	readFile(path: string): string | undefined;
	/** `git status --porcelain` output for `dir`, or `undefined` when `dir` is not in a git work tree. */
	gitStatus(dir: string): string | undefined;
	/** Extra run ids pi-subagents recorded for a run id (e.g. its parent workflow run). */
	relatedRunIds(runId: string): string[];
}

export interface EvidenceInput {
	details: AskDetails;
	/** The serving session's active branch. */
	entries: readonly SessionEntryLike[];
	servingCwd: string;
	servingSessionFile: string | undefined;
	servingSessionDir: string | undefined;
	globalInstructionsPath: string | undefined;
	config: ReviewerConfig;
	io: EvidenceIo;
}

/** Facts about the evidence, for the decision log. Never contains transcript text. */
export interface EvidenceStats {
	forwarded: boolean;
	childContext: "found" | "not_found" | "not_forwarded";
	childSessionFile?: string;
	launchCall: "run-id" | "pending" | "not_found" | "not_forwarded";
	gitStatus: "included" | "not_repo" | "not_destructive";
	/** Whether the pending tool call's own arguments were found in the requester's transcript. */
	pendingCall: "found" | "not_found";
	userMessagesIncluded: number;
	userMessagesOmitted: number;
	toolCallsIncluded: number;
	toolCallsOmitted: number;
}

/** A small per-session cache of located child session files. */
export type ChildFileCache = Map<string, string>;

export function gatherEvidence(input: EvidenceInput, cache: ChildFileCache = new Map()): { evidence: ReviewEvidence; stats: EvidenceStats } {
	const { details, entries, config, io } = input;
	const requesterSessionId = details.forwarding?.requesterSessionId ?? null;
	const forwarded = Boolean(details.forwarding);

	const users = selectUserMessages(extractUserMessages(entries), config.userMessagesChars, config.userMessageChars);
	const tools = selectToolCalls(extractToolCalls(entries), {
		max: config.toolCallsMax,
		budgetChars: config.toolCallsChars,
		perCallChars: config.toolCallChars,
		excludeId: forwarded ? undefined : details.toolCallId,
	});

	const stats: EvidenceStats = {
		forwarded,
		childContext: forwarded ? "not_found" : "not_forwarded",
		launchCall: forwarded ? "not_found" : "not_forwarded",
		gitStatus: "not_destructive",
		pendingCall: "not_found",
		userMessagesIncluded: users.included,
		userMessagesOmitted: users.omitted,
		toolCallsIncluded: tools.included,
		toolCallsOmitted: tools.omitted,
	};

	let requesterCwd = forwarded ? undefined : input.servingCwd;
	// The pending call's own arguments: the executable payload an allow would run.
	const command = askCommand(details);
	let pendingArguments = forwarded ? undefined : findPendingCall(extractToolCalls(entries), details.toolCallId, command)?.arguments;
	let subagent: ReviewEvidence["subagent"];
	if (forwarded) {
		subagent = { agentName: details.forwarding?.requesterAgentName ?? null, sessionId: requesterSessionId, found: false };
		const childFile = requesterSessionId ? locateChildSession(input, requesterSessionId, cache) : undefined;
		const childText = childFile ? io.readFile(childFile) : undefined;
		let runIds: string[] = [];
		if (childFile && childText !== undefined) {
			const child = readChildContext(childFile, childText);
			stats.childContext = "found";
			stats.childSessionFile = childFile;
			requesterCwd = child.cwd;
			const pending = findPendingCall(child.toolCalls, details.toolCallId, command);
			pendingArguments = pending?.arguments;
			runIds = child.runIds.flatMap((id) => [id, ...io.relatedRunIds(id)]);
			const childTools = selectToolCalls(child.toolCalls, {
				max: config.subagentToolCallsMax,
				budgetChars: config.toolCallsChars,
				perCallChars: config.toolCallChars,
				excludeId: pending?.id,
			});
			subagent.found = true;
			subagent.task = child.task ? truncateMiddle(child.task, config.subagentTaskChars) : undefined;
			if (child.laterMessages.length) {
				subagent.laterMessages = selectUserMessages(child.laterMessages, config.userMessagesChars / 2, config.userMessageChars).text;
			}
			subagent.toolCalls = childTools.text;
		}
		const launch = findLaunchCall(entries, [...new Set(runIds)]);
		if (launch) {
			stats.launchCall = launch.method;
			subagent.launchCall = renderToolCall(launch.call, config.launchCallChars);
		}
	}

	if (pendingArguments !== undefined) stats.pendingCall = "found";

	const facts: string[] = [];
	facts.push(
		forwarded
			? `requester: subagent "${details.forwarding?.requesterAgentName ?? "unknown"}" (session ${requesterSessionId ?? "unknown"}), forwarded to the serving session`
			: `requester: the serving session's own agent${details.agentName ? ` ("${details.agentName}")` : ""}`,
	);
	facts.push(`serving session working directory (trusted): ${input.servingCwd}`);
	if (forwarded) {
		facts.push(requesterCwd ? `subagent working directory: ${requesterCwd}` : "subagent working directory: unknown");
		facts.push(stats.childContext === "found" ? "subagent transcript: found" : "subagent transcript: not found (task and tool calls unknown)");
		if (stats.launchCall === "not_found") facts.push("launching subagent tool call: not found in the serving session");
	}

	const statusDir = requesterCwd ?? input.servingCwd;
	const pendingCommand = (pendingArguments as { command?: unknown } | undefined)?.command;
	const fullCommand = typeof pendingCommand === "string" ? pendingCommand : command;
	if (fullCommand && isDestructiveCommand(fullCommand)) {
		const status = io.gitStatus(statusDir);
		if (status === undefined) {
			stats.gitStatus = "not_repo";
			facts.push(`git status before this destructive command: ${statusDir} is not inside a git work tree (nothing there is recoverable from git)`);
		} else {
			stats.gitStatus = "included";
			facts.push(
				`git status --porcelain --untracked-files=all in ${statusDir}, before this destructive command (?? = untracked, !! = ignored, M = modified):\n${summarizeGitStatus(status, config.gitStatusLines)}`,
			);
		}
	}

	const projectInstructions: ReviewEvidence["projectInstructions"] = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = `${statusDir}/${name}`;
		const text = safeRead(io, path);
		if (text?.trim()) projectInstructions.push({ path, text: truncateMiddle(text, config.instructionsChars) });
	}
	const globalText = input.globalInstructionsPath ? safeRead(io, input.globalInstructionsPath) : undefined;

	return {
		evidence: {
			globalInstructions:
				input.globalInstructionsPath && globalText?.trim()
					? { path: input.globalInstructionsPath, text: truncateMiddle(globalText, config.instructionsChars) }
					: undefined,
			projectInstructions,
			userMessages: users.text,
			toolCalls: tools.text,
			subagent,
			facts,
			action: buildPlannedAction(details, requesterCwd, pendingArguments),
		},
		stats,
	};
}

/**
 * The pending tool call in a transcript: by id when the ask carries one (a
 * local ask), else — a forwarded ask carries no call id — the newest call
 * whose shell command is the one under review.
 */
function findPendingCall(calls: readonly ToolCallRecord[], id: string | undefined, command: string | undefined): ToolCallRecord | undefined {
	if (id) return calls.find((c) => c.id === id);
	if (!command) return undefined;
	for (let i = calls.length - 1; i >= 0; i--) {
		const args = calls[i].arguments as { command?: unknown } | undefined;
		if (args?.command === command) return calls[i];
	}
	return undefined;
}

function safeRead(io: EvidenceIo, path: string): string | undefined {
	try {
		return io.readFile(path);
	} catch {
		return undefined;
	}
}

/**
 * Where pi-subagents keeps a child's session: under the serving session file's
 * stem directory. The serving session directory's top level is searched too,
 * for children stored beside their parent.
 */
function locateChildSession(input: EvidenceInput, sessionId: string, cache: ChildFileCache): string | undefined {
	const cached = cache.get(sessionId);
	if (cached) return cached;
	const roots: string[] = [];
	if (input.servingSessionFile?.endsWith(".jsonl")) roots.push(input.servingSessionFile.slice(0, -".jsonl".length));
	let found = roots.length ? findSessionFile(input.io.fs, roots, sessionId) : undefined;
	if (!found && input.servingSessionDir) {
		found = findSessionFile(input.io.fs, [input.servingSessionDir], sessionId, { maxDepth: 0, maxEntries: 2_000 });
	}
	if (found) cache.set(sessionId, found);
	return found;
}
