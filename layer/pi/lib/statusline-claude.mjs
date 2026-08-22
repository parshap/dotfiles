#!/usr/bin/env node
/**
 * Claude Code statusline — adapter around statusline-core.mjs.
 *
 * Reads Claude Code's status JSON on stdin, paints segment roles with the
 * basic-16 ANSI palette (so colors inherit the terminal's own theme), and
 * prints one row:
 *
 *   where  ⎇ branch ……… Model · effort · ctx N% · 5h N% @t | 7d N% @t · $cost
 *
 * Stateless: one stdin read + one cheap `git branch`, no temp files.
 * Invoked via ~/.claude/statusline.sh.
 */

import { execFileSync } from "node:child_process";
import { buildStatus, collapsePath, gapFor, homeAbbrev, plain } from "./statusline-core.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}");

const cwd = input.workspace?.current_dir ?? ".";
const repo = input.workspace?.repo?.name ?? "";

let branch = "";
try {
	branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	/* not a git repo */
}

// Used tokens, matching Claude Code's own used_percentage definition:
// input-side only (fresh input + cache creation + cache read). current_usage
// is null before the first API call and right after /compact → omit tokens.
const usage = input.context_window?.current_usage;
const tokens = usage
	? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
	: null;

// Subscription usage windows (Pro/Max only, after the first API response);
// each window may be independently absent.
const limitWindow = (w) =>
	w?.used_percentage != null ? { pct: w.used_percentage, resetsAt: w.resets_at ?? null } : null;
const rl = input.rate_limits;

const { left, right } = buildStatus({
	where: repo || collapsePath(homeAbbrev(cwd)),
	branch: branch || null,
	pr: null, // no async gh lookup in a sync per-render script
	modelId: input.model?.id ?? "",
	modelDisplay: input.model?.display_name ?? "?",
	thinking: input.effort?.level ?? "",
	pct: input.context_window?.used_percentage ?? null,
	tokens,
	window: input.context_window?.context_window_size ?? null,
	cost: input.cost?.total_cost_usd ?? 0,
	limits: rl ? { fiveHour: limitWindow(rl.five_hour), sevenDay: limitWindow(rl.seven_day) } : null,
});

// Roles → explicit grays + basic-16 accent colors. Both gray levels are
// explicit 256-palette colors on purpose: Claude Code renders the statusline
// with its own muted base style, so unstyled text and SGR faint collapse to
// a single gray — the hierarchy only survives as explicit colors.
// Values match the pi theme: dim #666666 → 241 (#626262), muted #808080 → 244.
// Light backgrounds invert the emphasis (darker = stronger), per pi's light theme
// (dim #767676 → 244, muted #6c6c6c → 242). COLORFGBG is a best-effort light/dark
// hint set by some terminals; absent it, assume dark.
const bgParam = Number(process.env.COLORFGBG?.split(";").pop());
const lightBg = bgParam === 7 || bgParam === 15;
const GRAY_DIM = lightBg ? "\x1b[38;5;244m" : "\x1b[38;5;241m";
const GRAY_TEXT = lightBg ? "\x1b[38;5;242m" : "\x1b[38;5;244m";

const ANSI = {
	dim: [GRAY_DIM, "\x1b[0m"],
	text: [GRAY_TEXT, "\x1b[0m"],
	"ctx-ok": ["\x1b[32m", "\x1b[0m"],
	"ctx-warn": ["\x1b[33m", "\x1b[0m"],
	"ctx-danger": ["\x1b[31m", "\x1b[0m"],
};

const paint = (seg) => {
	const [on, off] = ANSI[seg.role] ?? ANSI.text;
	const text = on + seg.text + off;
	return seg.href ? `\x1b]8;;${seg.href}\x07${text}\x1b]8;;\x07` : text;
};

// Reserve columns rather than hugging the true edge. Claude Code pads the
// row by 2 columns on each side (observed), so anything longer than
// COLUMNS - 4 gets clipped with an ellipsis. It also injects chips at the
// row's right end ("/rc active", MCP errors, update notices, the verbose
// token counter) with no way to detect them from here — leave a standing
// allowance so the common "/rc active" chip fits without wrapping the row.
const PADDING = 4;
const CHIP_ALLOWANCE = 12;
const columns = Number(process.env.COLUMNS) || 0;
const gap = columns > 0 ? gapFor(columns, plain(left), plain(right), PADDING + CHIP_ALLOWANCE) : 6;

process.stdout.write(left.map(paint).join("") + " ".repeat(gap) + right.map(paint).join("") + "\n");
