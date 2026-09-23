/**
 * Builds the reviewer's evidence from Pi session entries, following Claude Code
 * auto mode's input design: the user's own messages and the agent's executable
 * tool calls; no assistant prose, no tool results, no read-only lookups.
 *
 * Everything here is pure over plain data except the small filesystem helpers
 * at the bottom, which take their I/O as parameters.
 */

/** The subset of a Pi session entry this module reads. */
export interface SessionEntryLike {
	type: string;
	id?: string;
	parentId?: string | null;
	name?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		details?: unknown;
	};
}

export interface ToolCallRecord {
	id: string;
	name: string;
	arguments: unknown;
}

/** Tools whose calls are read-only lookups, omitted like Claude Code omits them. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

// ── Text helpers ──────────────────────────────────────────────────────────────

/** Keep the head and tail of `text` within `max` characters, marking the cut. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (n: number) => `\n[... truncated ${n} chars ...]\n`;
	const keep = Math.max(0, max - marker(text.length).length);
	const head = Math.ceil(keep * 0.6);
	const tail = keep - head;
	return text.slice(0, head) + marker(text.length - keep) + (tail > 0 ? text.slice(-tail) : "");
}

const SECTION_TAGS = [
	"user_global_instructions",
	"project_instructions",
	"user_messages",
	"user_message",
	"agent_tool_calls",
	"subagent_context",
	"subagent_launch_call",
	"subagent_task",
	"subagent_messages",
	"subagent_tool_calls",
	"harness_facts",
	"planned_action",
];
const SECTION_TAG_RE = new RegExp(`<(/?)(${SECTION_TAGS.join("|")})\\b`, "gi");

/** Neutralize look-alikes of the prompt's own section tags inside embedded content. */
export function neutralizeTags(text: string): string {
	return text.replace(SECTION_TAG_RE, "‹$1$2");
}

/** Plain text of a message's `content` (string, or text parts); images are noted, not inlined. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; text?: unknown };
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
		else if (p.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

// ── Extraction ────────────────────────────────────────────────────────────────

/** The user's own messages, in order. Compaction summaries and custom messages are not user-authored. */
export function extractUserMessages(entries: readonly SessionEntryLike[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message.content).trim();
		if (text) out.push(text);
	}
	return out;
}

/** All tool calls made by the assistant, in order. */
export function extractToolCalls(entries: readonly SessionEntryLike[]): ToolCallRecord[] {
	const out: ToolCallRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: string; id?: unknown; name?: unknown; arguments?: unknown };
			if (p.type !== "toolCall" || typeof p.name !== "string") continue;
			out.push({ id: typeof p.id === "string" ? p.id : "", name: p.name, arguments: p.arguments });
		}
	}
	return out;
}

/** Tool call ids that already have a result entry. */
export function resolvedToolCallIds(entries: readonly SessionEntryLike[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			ids.add(entry.message.toolCallId);
		}
	}
	return ids;
}

/**
 * Select user messages under a character budget: the first (the original task)
 * and the newest (the latest instruction or boundary) are kept first, then the
 * rest newest-to-oldest. Returns the rendered, numbered block.
 */
export function selectUserMessages(
	messages: readonly string[],
	budgetChars: number,
	perMessageChars: number,
): { text: string; included: number; omitted: number } {
	if (messages.length === 0) return { text: "(no user messages)", included: 0, omitted: 0 };
	const clipped = messages.map((m) => truncateMiddle(m, perMessageChars));
	const order: number[] = [0];
	if (messages.length > 1) order.push(messages.length - 1);
	for (let i = messages.length - 2; i >= 1; i--) order.push(i);
	const chosen = new Set<number>();
	let used = 0;
	for (const index of order) {
		const size = clipped[index].length + 40;
		// The first and newest messages are always kept (already clipped per message).
		if (chosen.size >= 2 && used + size > budgetChars) continue;
		chosen.add(index);
		used += size;
	}
	const lines: string[] = [];
	let gap = 0;
	for (let i = 0; i < messages.length; i++) {
		if (!chosen.has(i)) {
			gap++;
			continue;
		}
		if (gap > 0) lines.push(`[${gap} user message(s) omitted]`);
		gap = 0;
		lines.push(`<user_message index="${i + 1}">\n${neutralizeTags(clipped[i])}\n</user_message>`);
	}
	if (gap > 0) lines.push(`[${gap} user message(s) omitted]`);
	return { text: lines.join("\n"), included: chosen.size, omitted: messages.length - chosen.size };
}

/** One tool call as a single line: bash shows its command, others their JSON arguments. */
export function renderToolCall(call: ToolCallRecord, maxChars: number): string {
	const args = call.arguments as Record<string, unknown> | undefined;
	let body: string;
	if (call.name === "bash" && args && typeof args.command === "string") {
		body = args.command;
	} else {
		try {
			body = JSON.stringify(args ?? {});
		} catch {
			body = String(args);
		}
	}
	return `${call.name}: ${neutralizeTags(truncateMiddle(body, maxChars))}`;
}

/**
 * Non-read-only tool calls, newest kept, rendered oldest first. `excludeId` is
 * the pending call, which is shown separately as the planned action.
 */
export function selectToolCalls(
	calls: readonly ToolCallRecord[],
	options: { max: number; budgetChars: number; perCallChars: number; excludeId?: string },
): { text: string; included: number; omitted: number } {
	const eligible = calls.filter((c) => !READ_ONLY_TOOLS.has(c.name) && (!options.excludeId || c.id !== options.excludeId));
	const picked: string[] = [];
	let used = 0;
	for (let i = eligible.length - 1; i >= 0 && picked.length < options.max; i--) {
		const line = renderToolCall(eligible[i], options.perCallChars);
		if (used + line.length > options.budgetChars && picked.length > 0) break;
		picked.push(line);
		used += line.length + 1;
	}
	picked.reverse();
	const omitted = eligible.length - picked.length;
	const lines = omitted > 0 ? [`[${omitted} earlier tool call(s) omitted]`, ...picked] : picked;
	return { text: lines.length ? lines.join("\n") : "(none)", included: picked.length, omitted };
}

// ── Destructive commands ──────────────────────────────────────────────────────

const DESTRUCTIVE_RE =
	/(?:^|[\s;&|(`$!{])(?:sudo\s+)?(?:rm|rmdir|unlink|shred|truncate|mv)\s|\bgit\b[^;&|]*\s(?:clean|reset|checkout|restore|rm|stash\s+(?:drop|clear))\b|\bfind\b[^;&|]*\s-delete\b|\brsync\b[^;&|]*\s--delete/;

/** Whether a shell command may discard files or uncommitted work (Claude Code runs git status before these). */
export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_RE.test(command);
}

// ── Forwarded asks: locating and reading the subagent transcript ─────────────

/** Parse JSONL text into entries, skipping malformed lines. */
export function parseJsonl(text: string): SessionEntryLike[] {
	const out: SessionEntryLike[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") out.push(value as SessionEntryLike);
		} catch {
			// A partially written trailing line is expected while the child runs.
		}
	}
	return out;
}

/** The active branch of a session file: walk parent links from the last entry. */
export function activeBranch(entries: readonly SessionEntryLike[]): SessionEntryLike[] {
	const byId = new Map<string, SessionEntryLike>();
	let leaf: SessionEntryLike | undefined;
	for (const entry of entries) {
		if (entry.type === "session" || !entry.id) continue;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const branch: SessionEntryLike[] = [];
	const seen = new Set<string>();
	for (let cur = leaf; cur?.id && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
		seen.add(cur.id);
		branch.push(cur);
	}
	return branch.reverse();
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** UUIDs in `text` (run ids appear in pi-subagents session names and paths). */
export function uuidsIn(text: string): string[] {
	return [...new Set(text.match(UUID_RE) ?? [])].map((u) => u.toLowerCase());
}

export interface LaunchCallMatch {
	call: ToolCallRecord;
	method: "run-id" | "pending";
}

/**
 * Find the parent `subagent` tool call that launched a child.
 *
 * Tool results are used only to link a run id to its call id; their content
 * never reaches the reviewer. A launch call has no `action` (status/steer/list
 * calls do). When no result mentions the run — a foreground run whose call is
 * still in flight — fall back to the newest launch call without a result.
 */
export function findLaunchCall(entries: readonly SessionEntryLike[], runIds: readonly string[]): LaunchCallMatch | undefined {
	const calls = extractToolCalls(entries).filter((c) => c.name === "subagent");
	const isLaunch = (c: ToolCallRecord) => {
		const a = c.arguments as Record<string, unknown> | undefined;
		return !a || a.action === undefined || a.action === "run";
	};
	const byId = new Map(calls.map((c) => [c.id, c]));
	if (runIds.length > 0) {
		for (const entry of entries) {
			const m = entry.message;
			if (entry.type !== "message" || m?.role !== "toolResult" || m.toolName !== "subagent" || !m.toolCallId) continue;
			const call = byId.get(m.toolCallId);
			if (!call || !isLaunch(call)) continue;
			let haystack = messageText(m.content);
			try {
				haystack += JSON.stringify(m.details ?? null).slice(0, 50_000);
			} catch {
				// Unserializable details carry no run id we can read.
			}
			const lower = haystack.toLowerCase();
			if (runIds.some((id) => lower.includes(id))) return { call, method: "run-id" };
		}
	}
	const resolved = resolvedToolCallIds(entries);
	const pending = calls.filter((c) => isLaunch(c) && !resolved.has(c.id));
	const last = pending.at(-1);
	return last ? { call: last, method: "pending" } : undefined;
}

export interface ChildContext {
	sessionFile: string;
	cwd: string | undefined;
	/** The first user-role message: the task the parent agent wrote. */
	task: string | undefined;
	/** Later user-role messages (steering from the parent agent). */
	laterMessages: string[];
	toolCalls: ToolCallRecord[];
	runIds: string[];
}

/** Extract a subagent's context from its session file text. */
export function readChildContext(sessionFile: string, text: string): ChildContext {
	const entries = parseJsonl(text);
	const header = entries.find((e) => e.type === "session") as (SessionEntryLike & { cwd?: unknown }) | undefined;
	const branch = activeBranch(entries);
	const users = extractUserMessages(branch);
	const names = branch.filter((e) => e.type === "session_info" && typeof e.name === "string").map((e) => e.name as string);
	return {
		sessionFile,
		cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
		task: users[0],
		laterMessages: users.slice(1),
		toolCalls: extractToolCalls(branch),
		runIds: uuidsIn([sessionFile, ...names].join(" ")),
	};
}

export interface DirEntryLike {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

export interface FsLike {
	readdir(path: string): DirEntryLike[];
	/** First bytes of a file, enough for the header line. */
	readHead(path: string): string;
}

/**
 * Find the session file whose header id is `sessionId`, searching the given
 * roots breadth-first with bounded depth and entry count. pi-subagents stores a
 * child's session under the parent session's directory
 * (`<parent-session-file-stem>/<run-id>/run-N/session.jsonl`, with extra levels
 * for parallel and nested runs).
 */
export function findSessionFile(
	fs: FsLike,
	roots: readonly string[],
	sessionId: string,
	limits: { maxDepth: number; maxEntries: number } = { maxDepth: 6, maxEntries: 2_000 },
): string | undefined {
	const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
	let visited = 0;
	const idPattern = `"id":"${sessionId}"`;
	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		let children: DirEntryLike[];
		try {
			children = fs.readdir(dir);
		} catch {
			continue;
		}
		for (const child of children) {
			if (++visited > limits.maxEntries) return undefined;
			const path = `${dir}/${child.name}`;
			if (child.isFile() && child.name.endsWith(".jsonl")) {
				try {
					const head = fs.readHead(path);
					const firstLine = head.split("\n", 1)[0] ?? "";
					if (firstLine.includes('"type":"session"') && firstLine.includes(idPattern)) return path;
				} catch {
					// Unreadable file: keep searching.
				}
			} else if (child.isDirectory() && depth < limits.maxDepth) {
				queue.push({ dir: path, depth: depth + 1 });
			}
		}
	}
	return undefined;
}

/** Summarize `git status --porcelain` output for the reviewer, bounded to `maxLines`. */
export function summarizeGitStatus(output: string, maxLines: number): string {
	const lines = output.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return "clean (no staged, modified, or untracked files)";
	const shown = lines.slice(0, maxLines).map(neutralizeTags);
	const more = lines.length - shown.length;
	return shown.join("\n") + (more > 0 ? `\n[${more} more line(s) omitted]` : "");
}
