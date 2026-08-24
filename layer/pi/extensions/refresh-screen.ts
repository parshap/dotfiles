/**
 * Ctrl+L: repaint the screen and re-detect the terminal color scheme.
 *
 * Requires ~/.pi/agent/keybindings.json to move `app.model.select` off ctrl+l:
 * pi lists that action in RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS, so an
 * extension shortcut on a key it still owns is silently skipped.
 *
 * Also available as /refresh, which reports what detection found. /refresh
 * takes an argument: `light` or `dark` forces a scheme.
 *
 * The terminal is the only authority, because the terminal's own background is
 * what has to stay readable, and it can legitimately differ from the OS
 * appearance. Detection asks for DSR ?996 first, then falls back to the OSC 11
 * background color, the same query pi uses at startup. When neither answers,
 * nothing is guessed: the theme is left alone and the failure is reported.
 *
 * OSC 11 goes through queryBackgroundColor() rather than a single
 * TUI.queryTerminalBackgroundColor() call, to survive a pi-tui bug: on timeout
 * that method leaves the settled query in `pendingOsc11BackgroundQueries` and
 * never decrements `pendingOsc11BackgroundReplies`, and its response matcher is
 * anchored, so a reply arriving late or split across stdin chunks is never
 * consumed. The queue is then permanently one reply behind — each new query has
 * its response absorbed by the stale head entry and times out — which used to
 * kill Ctrl+L for the rest of a session's life. Concurrent queries defeat that:
 * with a lag of k, k+1 in flight means k responses drain stale entries and one
 * still resolves. Sequential retries can never win, since each attempt adds
 * exactly one entry and each response removes exactly one.
 *
 * Applying the theme is done here rather than left to pi's
 * InteractiveThemeController, which only reacts to color-scheme reports while
 * its auto-sync flag is on, and that flag is off for the rest of the session
 * after any setTheme() call, after picking a theme in /theme, and after TUI
 * teardown. To keep auto-sync working where it works, setTheme() is called only
 * when the detected scheme disagrees with the active theme, i.e. only when
 * auto-sync has already failed to do the job.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const QUERY_TIMEOUT_MS = 500;

type Scheme = "light" | "dark";
type Detection = { scheme: Scheme; source: string; detail?: string };

/** pi's getRgbColorLuminance + getThemeForRgbColor (WCAG relative luminance, 0.5 split). */
function schemeForRgb({ r, g, b }: { r: number; g: number; b: number }): Scheme {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance >= 0.5 ? "light" : "dark";
}

/** Project settings override global settings, matching SettingsManager. */
function readThemeSetting(cwd: string): string | undefined {
  const read = (file: string) => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf-8")).theme;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return (
    read(path.join(cwd, CONFIG_DIR_NAME, "settings.json")) ??
    read(path.join(getAgentDir(), "settings.json"))
  );
}

/** pi's parseAutoThemeSetting: exactly one slash, both sides non-empty ("light/dark"). */
function parseAutoTheme(setting: string | undefined): { light: string; dark: string } | undefined {
  if (!setting) return undefined;
  const slash = setting.indexOf("/");
  if (slash === -1 || setting.indexOf("/", slash + 1) !== -1) return undefined;
  const light = setting.slice(0, slash).trim();
  const dark = setting.slice(slash + 1).trim();
  return light && dark ? { light, dark } : undefined;
}

type ApplyResult =
  | { status: "applied"; theme: string }
  | { status: "unchanged"; theme: string }
  | { status: "not-auto" }
  | { status: "failed"; theme: string; error?: string };

/**
 * Resolve the configured auto theme pair for `scheme` and apply it.
 *
 * The Theme-instance overload of setTheme() is deliberate: the string overload
 * would rewrite settings.json and replace the auto pair with a fixed theme
 * name. Returning early on an already-correct theme is what keeps pi's
 * auto-sync alive in terminals that push color-scheme notifications: there, pi
 * has already applied the theme before this runs, so nothing is written.
 */
function applyScheme(ctx: ExtensionContext, scheme: Scheme): ApplyResult {
  const auto = parseAutoTheme(readThemeSetting(ctx.cwd));
  if (!auto) return { status: "not-auto" }; // fixed theme configured: nothing to re-resolve
  const target = scheme === "light" ? auto.light : auto.dark;
  if (ctx.ui.theme.name === target) return { status: "unchanged", theme: target };
  const instance = ctx.ui.getTheme(target);
  if (!instance) return { status: "failed", theme: target, error: "theme not found" };
  const result = ctx.ui.setTheme(instance);
  return result.success
    ? { status: "applied", theme: target }
    : { status: "failed", theme: target, error: result.error };
}

export default function (pi: ExtensionAPI) {
  let tui: TUI | undefined;
  let oscEverAnswered = false;

  /** First resolving reply from `count` concurrent OSC 11 queries. */
  async function queryBackgroundColor(t: TUI, count: number) {
    const replies = await Promise.all(
      Array.from({ length: count }, () =>
        t.queryTerminalBackgroundColor({ timeoutMs: QUERY_TIMEOUT_MS }),
      ),
    );
    const rgb = replies.find((reply) => reply !== undefined);
    if (rgb) oscEverAnswered = true;
    return rgb;
  }

  async function detectFromTerminal(t: TUI): Promise<Detection | undefined> {
    // queryTerminalColorScheme() is listener-based and carries no pending-reply
    // bookkeeping, so it needs no workaround.
    const reported = await t.queryTerminalColorScheme({ timeoutMs: QUERY_TIMEOUT_MS });
    if (reported) return { scheme: reported, source: "DSR ?996" };

    // Two in flight covers the usual lag of one. Escalate only after the
    // terminal has proven it answers OSC 11 at all, so terminals without OSC 11
    // support are not handed extra queries to leak.
    const rgb =
      (await queryBackgroundColor(t, 2)) ??
      (oscEverAnswered ? await queryBackgroundColor(t, 4) : undefined);
    if (!rgb) return undefined;
    return {
      scheme: schemeForRgb(rgb),
      source: "OSC 11",
      detail: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    };
  }

  async function refresh(ctx: ExtensionContext, options?: { report?: boolean; arg?: string }) {
    const t = tui;
    if (!t) {
      // Widget registration is how the TUI handle is captured, so this means
      // session_start never ran for this session or extension UI was reset.
      ctx.ui.notify("Screen refresh unavailable: no TUI handle. Try /reload.", "warning");
      return;
    }

    const report = options?.report ?? false;
    const arg = options?.arg?.trim().toLowerCase();

    // Regular mode keeps the transcript in terminal-owned scrollback, so clear
    // screen + scrollback explicitly. Fullscreen mode owns the viewport and the
    // forced render below emits its own \x1b[2J inside synchronized output.
    if (t.mode === "regular") t.terminal.write("\x1b[2J\x1b[H\x1b[3J");
    t.requestRender(true); // resetRenderState() -> full repaint

    // COLORFGBG is static for the life of the process, so a terminal that
    // answers neither query leaves nothing to re-detect.
    const detection: Detection | undefined =
      arg === "light" || arg === "dark"
        ? { scheme: arg, source: "forced" }
        : await detectFromTerminal(t);

    if (!detection) {
      ctx.ui.notify(
        "Terminal answered neither DSR ?996 nor OSC 11; theme left unchanged.",
        "error",
      );
      return;
    }

    const applied = applyScheme(ctx, detection.scheme);
    t.requestRender(true);

    const where = detection.detail ? `${detection.source}, ${detection.detail}` : detection.source;

    switch (applied.status) {
      case "applied":
        if (report) ctx.ui.notify(`Theme "${applied.theme}" (${where}).`, "info");
        return;
      case "unchanged":
        if (report) ctx.ui.notify(`Already "${applied.theme}" (${where}).`, "info");
        return;
      case "not-auto":
        ctx.ui.notify(
          `Detected ${detection.scheme} (${where}), but the theme setting is not an auto pair; left unchanged.`,
          "warning",
        );
        return;
      case "failed":
        ctx.ui.notify(
          `Detected ${detection.scheme} (${where}), but theme "${applied.theme}" failed to load${applied.error ? `: ${applied.error}` : ""}.`,
          "error",
        );
        return;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Zero-height widget used only to capture the TUI instance. belowEditor adds
    // no spacer of its own, so rendering no lines is completely invisible.
    ctx.ui.setWidget(
      "refresh-screen-hook",
      (instance) => {
        tui = instance;
        return { render: () => [], invalidate: () => {} };
      },
      { placement: "belowEditor" },
    );
  });

  pi.registerShortcut("ctrl+l", {
    description: "Repaint screen, re-detect terminal theme",
    handler: (ctx) => refresh(ctx),
  });

  pi.registerCommand("refresh", {
    description: "Repaint screen, re-detect theme (args: light | dark)",
    handler: async (args, ctx) => {
      await refresh(ctx, { report: true, arg: args });
    },
  });
}
