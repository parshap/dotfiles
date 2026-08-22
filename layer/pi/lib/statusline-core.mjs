/**
 * statusline-core — shared formatting core for the pi and Claude Code statuslines.
 *
 * Pure functions, zero dependencies. Each adapter (pi extension, Claude Code
 * CLI wrapper) builds a StatusData record from its own data sources, calls
 * buildStatus() to get styled segments, then paints segment roles with its
 * own color backend (pi theme colors vs. raw basic-16 ANSI).
 *
 * Layout convention (both statuslines): "where" on the left, session state
 * right-aligned — the tmux / vim-airline "a b c … x y z" split.
 *
 * Segment roles:
 *   "dim"                                structural text (path, dividers, labels)
 *   "text"                               content (branch, model, cost) — adapters paint
 *                                        this as their muted baseline, one step above dim
 *   "ctx-ok" | "ctx-warn" | "ctx-danger" context-% gradient (<40 / 40–59 / 60+)
 * A segment may carry `href` for a terminal hyperlink (OSC 8).
 *
 * @typedef {{ text: string, role: string, href?: string }} Segment
 * @typedef {{
 *   where: string, branch?: string|null, pr?: { number: number, url: string }|null,
 *   modelId: string, modelDisplay?: string, thinking?: string,
 *   status?: Segment,  // optional extra chip, placed after thinking, before ctx
 *   pct?: number|null, tokens?: number|null, window?: number|null, cost?: number,
 * }} StatusData
 */

/** Context-% gradient level: green until 40%, yellow approaching, red from 60%. */
export function ctxLevel(pct) {
	if (pct >= 60) return "ctx-danger";
	if (pct >= 40) return "ctx-warn";
	return "ctx-ok";
}

/** Format token count: 12345 → "12.3k", 200000 → "200k", 1500000 → "1.5M" */
export function fmtTokens(n) {
	const strip = (s) => s.replace(/\.0+([kM])$/, "$1");
	if (n >= 1_000_000) return strip(`${(n / 1_000_000).toFixed(1)}M`);
	if (n >= 1_000) return strip(`${(n / 1_000).toFixed(1)}k`);
	return `${n}`;
}

/** Replace a leading $HOME with ~. */
export function homeAbbrev(p) {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

/** Middle-collapse a long path to …/parent/base when over maxLen. */
export function collapsePath(p, maxLen = 32) {
	if (p.length <= maxLen) return p;
	const parts = p.split("/");
	return `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Friendly model label from a model id.
 *   claude-opus-4-8[1m]            → "Opus 4.8 1M"
 *   baseten/moonshotai/Kimi-K3     → "Kimi-K3"
 * Family = first alphabetic segment; version = short numeric segments joined
 * by "." (an 8-digit date suffix is dropped); "[1m]" marks the 1M variant.
 * Non-claude ids use the last path segment (provider prefixes stripped).
 */
export function modelLabel(id, displayName) {
	let s = (id || "").split("/").pop() || "";
	const ctxTag = s.includes("[1m]") ? " 1M" : "";
	s = s.replace(/\[.*\]/, "");
	if (s.startsWith("claude-")) {
		const segs = s.slice("claude-".length).split("-");
		let family = "";
		let ver = "";
		for (const seg of segs) {
			if (/^\d+$/.test(seg)) {
				if (seg.length < 5) ver = ver ? `${ver}.${seg}` : seg;
			} else if (!family) {
				family = seg;
			}
		}
		if (family) {
			return `${family[0].toUpperCase()}${family.slice(1)}${ver ? ` ${ver}` : ""}${ctxTag}`;
		}
	}
	return s ? s + ctxTag : displayName || "?";
}

/**
 * Build the left ("where") and right ("session state") segment lists.
 * @param {StatusData} d
 * @returns {{ left: Segment[], right: Segment[] }}
 */
export function buildStatus(d) {
	// ── where (left) ────────────────────────────────────────────────────────
	const left = [];
	if (d.where) left.push({ text: d.where, role: "dim" });
	if (d.branch) {
		left.push({ text: "  ⎇ ", role: "dim" }, { text: d.branch, role: "text" });
		if (d.pr) {
			left.push(
				{ text: " (", role: "dim" },
				{ text: `#${d.pr.number}`, role: "text", href: d.pr.url },
				{ text: ")", role: "dim" },
			);
		}
	}

	// ── session state (right): model · thinking · ctx N% tok/win · $cost ────
	const right = [];
	const dot = () => right.push({ text: " · ", role: "dim" });
	right.push({ text: modelLabel(d.modelId, d.modelDisplay), role: "text" });
	if (d.thinking) {
		dot();
		right.push({ text: d.thinking, role: "dim" });
	}
	if (d.status) {
		dot();
		right.push(d.status);
	}
	dot();
	right.push({ text: "ctx ", role: "dim" });
	if (d.pct == null || Number.isNaN(d.pct)) {
		right.push({ text: "--%", role: "dim" });
	} else {
		right.push({ text: `${Math.round(d.pct)}%`, role: ctxLevel(d.pct) });
		if (d.tokens != null) {
			const win = d.window ? `/${fmtTokens(d.window)}` : "";
			right.push({ text: ` ${fmtTokens(d.tokens)}${win}`, role: "dim" });
		}
	}
	dot();
	right.push({ text: `$${(d.cost ?? 0).toFixed(2)}`, role: "text" });

	return { left, right };
}

/** Plain-text content of a segment list (for width math — no ANSI). */
export function plain(segs) {
	return segs.map((s) => s.text).join("");
}

/**
 * Gap columns between the left and right groups. `reserve` keeps the right
 * group off the true terminal edge (Claude Code uses its right end for
 * notifications and clips rows rendered to full COLUMNS).
 */
export function gapFor(width, leftPlain, rightPlain, reserve = 0) {
	return Math.max(1, width - leftPlain.length - rightPlain.length - reserve);
}
