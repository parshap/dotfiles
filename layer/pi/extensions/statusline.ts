/**
 * statusline — custom pi footer, Claude Code-style layout.
 *
 *   parshap-ops  ⎇ main (#123) ……… Kimi-K3 · high · ctx 23% 45.0k/200k · $0.04
 *
 * "Where" on the left (repo + branch + PR hyperlink), session state pinned
 * right (model, thinking level, context % with gradient + token counts,
 * cost). Formatting lives in the shared core (~/.pi/agent/lib/statusline-core.mjs),
 * also used by the Claude Code statusline; this file is only the pi adapter:
 * data sourcing, theme painting, and the async `gh` PR lookup.
 *
 * Extension statuses (MCP failures, runner state, …) go on line 2.
 */

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep as pathSep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
// @ts-ignore — plain-JS shared core, no type declarations
import { buildStatus, homeAbbrev } from "../lib/statusline-core.mjs";
// @ts-ignore — plain-JS promotion helpers, no type declarations
import { compileStatusPromotions, selectPromotedStatus, stripAnsi } from "../lib/statusline-promotions.mjs";

// ─── Extension-status filtering (line 2) ─────────────────────────────────────
// Fail-open design: we only ever hide (a) stable status keys we never want, or
// (b) exact known steady-state values. Anything unrecognized renders — upstream
// rewording makes noise reappear, never makes information vanish.

/**
 * Status keys never shown. Keys are API identifiers (constants in the
 * publisher's source), far more stable than display text; if a publisher
 * renames its key, the status simply reappears.
 */
const HIDE_STATUS_KEYS = new Set<string>();

/**
 * Known-boring steady states per key, matched against ANSI-stripped text.
 * Only an exact match is hidden; any deviation (failures, rewording) shows.
 */
const STEADY_STATE: Record<string, RegExp> = {
	mcp: /^MCP: \d+\/\d+$/, // "MCP: 4/4" healthy; "3/4, 1 failed" / "connecting…" still show
};

function loadStatusPromotions(): ReturnType<typeof compileStatusPromotions> {
	const configPath = join(getAgentDir(), "statusline.json");
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		return compileStatusPromotions(config.promotions);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[statusline] Ignoring invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return [];
	}
}

// ─── PR lookup (async, cached) ───────────────────────────────────────────────

interface PrInfo {
	number: number;
	url: string;
}

/** Cache the git toplevel per cwd so we don't shell out on every render. */
const repoRootCache = new Map<string, string | null>();

function getGitRepoRoot(cwd: string): string | null {
	if (repoRootCache.has(cwd)) return repoRootCache.get(cwd) ?? null;
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const root = out || null;
		repoRootCache.set(cwd, root);
		return root;
	} catch {
		repoRootCache.set(cwd, null);
		return null;
	}
}

/** How long a resolved PR lookup stays fresh before re-querying `gh` (ms). */
const PR_TTL_MS = 60_000;

const prInfoCache = new Map<string, { info: PrInfo | null; at: number }>();
const prInfoInFlight = new Set<string>();

/** Open PR for the current branch (or null). Refreshes async past the TTL, then calls `onResolved`. */
function getPrInfo(cwd: string, branch: string, onResolved: () => void): PrInfo | null {
	const root = getGitRepoRoot(cwd);
	if (!root || !branch) return null;
	const key = `${root}\n${branch}`;
	const cached = prInfoCache.get(key);
	const fresh = cached && Date.now() - cached.at < PR_TTL_MS;
	if (!fresh && !prInfoInFlight.has(key)) {
		prInfoInFlight.add(key);
		// `gh pr status` finds the current branch's PR even in a fork/triangular workflow.
		const jq = '.currentBranch | select(. != null) | "\\(.number)\\t\\(.url)"';
		execFile("gh", ["pr", "status", "--json", "number,url", "--jq", jq], { cwd: root }, (err, stdout) => {
			prInfoInFlight.delete(key);
			if (err) {
				// Keep any prior value; bump the timestamp so we retry after the TTL.
				prInfoCache.set(key, { info: cached?.info ?? null, at: Date.now() });
				return;
			}
			const [numStr, url] = stdout.trim().split("\t");
			const num = Number.parseInt(numStr ?? "", 10);
			const info = Number.isFinite(num) && url ? { number: num, url } : null;
			prInfoCache.set(key, { info, at: Date.now() });
			if ((cached?.info?.number ?? null) !== (info?.number ?? null)) onResolved();
		});
	}
	return cached?.info ?? null; // serve stale (or null) while a refresh is in flight
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Cache the main repo root per worktree/toplevel root. */
const mainRepoRootCache = new Map<string, string>();

/**
 * Main repo root for display naming. In a linked worktree, --show-toplevel
 * returns the worktree dir (whose name usually just repeats the branch —
 * e.g. emdash worktrees); --git-common-dir points at the main checkout's
 * .git even from a worktree, so its parent is the real repo root. In a
 * normal repo it's just <root>/.git, so the same logic works everywhere.
 */
function getMainRepoRoot(root: string): string {
	if (mainRepoRootCache.has(root)) return mainRepoRootCache.get(root)!;
	let main = root;
	try {
		const out = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const commonDir = resolve(root, out);
		if (basename(commonDir) === ".git") main = dirname(commonDir);
	} catch {
		// git failed: keep the toplevel
	}
	mainRepoRootCache.set(root, main);
	return main;
}

/**
 * Display path: inside a git repo, the main repo name plus relative subpath
 * within the worktree (e.g. `pi-agent/extras`); outside, ~-abbreviated path.
 */
function displayPath(absPath: string): string {
	const root = getGitRepoRoot(absPath);
	if (root) {
		const repoName = basename(getMainRepoRoot(root));
		const rel = relative(root, absPath);
		if (!rel || rel === ".") return repoName;
		return `${repoName}${pathSep}${rel}`;
	}
	return homeAbbrev(absPath);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | null = null;
	let statusPromotions: ReturnType<typeof compileStatusPromotions> = [];
	const triggerRender = () => requestRender?.();

	pi.on("session_start", async (_event, ctx) => {
		statusPromotions = loadStatusPromotions();
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(triggerRender);

			/** Paint a core segment with theme colors; wrap in an OSC 8 hyperlink if it has href. */
			const paint = (seg: { text: string; role: string; href?: string }): string => {
				let out: string;
				switch (seg.role) {
					case "dim":
						out = theme.fg("dim", seg.text);
						break;
					case "ctx-ok":
						out = theme.fg("success", seg.text);
						break;
					case "ctx-warn":
						out = theme.fg("warning", seg.text);
						break;
					case "ctx-danger":
						out = theme.fg("error", seg.text);
						break;
					case "accent":
						out = theme.fg("accent", seg.text);
						break;
					case "warning":
						out = theme.fg("warning", seg.text);
						break;
					default:
						// "text" role = content (branch, model, cost). Painted "muted" —
						// the theme's middle step between bright text and dim — so the
						// baseline matches Claude Code's muted statusline while keeping
						// the dim < muted < ctx-color hierarchy in both light and dark.
						out = theme.fg("muted", seg.text);
				}
				return seg.href ? hyperlink(out, seg.href) : out;
			};

			return {
				dispose() {
					unsubBranch();
					requestRender = null;
				},
				invalidate() {},

				render(width: number): string[] {
					// ── Session cost ──────────────────────────────────────────────
					let totalCost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							totalCost += (e.message as AssistantMessage).usage?.cost?.total ?? 0;
						}
					}

					// ── Context usage ─────────────────────────────────────────────
					const usage = ctx.getContextUsage();

					// ── Git branch (+ open PR) ────────────────────────────────────
					const cwd = ctx.sessionManager.getCwd();
					const branch = footerData.getGitBranch();
					const pr = branch ? getPrInfo(cwd, branch, triggerRender) : null;
					const extensionStatuses = footerData.getExtensionStatuses();
					const promotedStatus = selectPromotedStatus(extensionStatuses, statusPromotions);

					const { left, right } = buildStatus({
						where: displayPath(cwd),
						branch,
						pr,
						modelId: ctx.model?.id ?? "",
						modelDisplay: ctx.model?.id ?? "",
						thinking: pi.getThinkingLevel(),
						status: promotedStatus?.segment,
						// getContextUsage() is null before the first API call;
						// no usage yet means 0%, not "unknown".
						pct: usage?.percent ?? 0,
						tokens: usage?.tokens ?? null,
						window: usage?.contextWindow ?? null,
						cost: totalCost,
					});

					const leftStr = left.map(paint).join("");
					const rightStr = right.map(paint).join("");
					// Widths via pi-tui's visibleWidth (consistent with truncateToWidth),
					// minus a 1-column right reserve: ⎇ (U+2387) is one cell to wcwidth
					// but some terminals render it two cells wide, which overflows the
					// line and clips the final glyph; the reserve absorbs that.
					const gap = Math.max(1, width - visibleWidth(leftStr) - visibleWidth(rightStr) - 1);
					const line1 = truncateToWidth(leftStr + " ".repeat(gap) + rightStr, width);

					// ── Extension statuses (line 2, filtered fail-open) ───────────
					const statuses: string[] = [];
					for (const [key, val] of extensionStatuses) {
						if (!val || HIDE_STATUS_KEYS.has(key)) continue;
						if (key === promotedStatus?.consumedKey) continue;
						if (STEADY_STATE[key]?.test(stripAnsi(val).trim())) continue;
						statuses.push(val);
					}
					if (statuses.length > 0) {
						return [line1, truncateToWidth(statuses.join(theme.fg("dim", " · ")), width)];
					}
					return [line1];
				},
			};
		});
	});

	/** Model switch reclamps thinking; refresh labels without waiting for a turn. */
	pi.on("model_select", triggerRender);
	pi.on("turn_end", triggerRender);

	pi.on("session_shutdown", async () => {
		requestRender = null;
	});
}
