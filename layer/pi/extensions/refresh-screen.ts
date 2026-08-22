/**
 * Ctrl+L: repaint the screen and re-detect the terminal color scheme.
 *
 * Requires ~/.pi/agent/keybindings.json to move `app.model.select` off ctrl+l:
 * pi lists that action in RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS, so an
 * extension shortcut on a key it still owns is silently skipped.
 *
 * Also available as /refresh, which reports what detection found.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const QUERY_TIMEOUT_MS = 250;

type Scheme = "light" | "dark";

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

export default function (pi: ExtensionAPI) {
  let tui: TUI | undefined;
  let warnedNoDetection = false;

  /**
   * Apply an auto theme pair ourselves. Used only for the OSC 11 path, since
   * pi's theme controller reacts to DSR ?996 reports but not to background
   * colors. The Theme-instance overload of setTheme() is deliberate: the string
   * overload would rewrite settings.json and replace the auto pair with a fixed
   * theme name.
   */
  function applyScheme(ctx: ExtensionContext, scheme: Scheme): string | undefined {
    const auto = parseAutoTheme(readThemeSetting(ctx.cwd));
    if (!auto) return undefined; // fixed theme configured: nothing to re-resolve
    const target = scheme === "light" ? auto.light : auto.dark;
    if (ctx.ui.theme.name === target) return target;
    const instance = ctx.ui.getTheme(target);
    if (!instance) return undefined;
    ctx.ui.setTheme(instance);
    return target;
  }

  async function refresh(ctx: ExtensionContext, options?: { report?: boolean }) {
    const t = tui;
    if (!t) return;

    // Regular mode keeps the transcript in terminal-owned scrollback, so clear
    // screen + scrollback explicitly. Fullscreen mode owns the viewport and the
    // forced render below emits its own \x1b[2J inside synchronized output.
    if (t.mode === "regular") t.terminal.write("\x1b[2J\x1b[H\x1b[3J");
    t.requestRender(true); // resetRenderState() -> full repaint

    // 1. DSR ?996. The CSI ?997 reply is broadcast to every color-scheme
    //    listener, including pi's theme controller, so an auto theme setting is
    //    re-resolved by pi itself with no side effects.
    const reported = await t.queryTerminalColorScheme({ timeoutMs: QUERY_TIMEOUT_MS });
    if (reported) {
      t.requestRender(true);
      if (options?.report) ctx.ui.notify(`Terminal reports ${reported} (DSR ?996).`, "info");
      return;
    }

    // 2. OSC 11 background color, same fallback pi uses at startup.
    const rgb = await t.queryTerminalBackgroundColor({ timeoutMs: QUERY_TIMEOUT_MS });
    if (rgb) {
      const scheme = schemeForRgb(rgb);
      const applied = applyScheme(ctx, scheme);
      t.requestRender(true);
      if (options?.report) {
        const detail = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b}) -> ${scheme}`;
        ctx.ui.notify(
          applied
            ? `Terminal background ${detail}; theme "${applied}" (OSC 11).`
            : `Terminal background ${detail}; theme setting is not an auto pair, left unchanged.`,
          "info",
        );
      }
      return;
    }

    // 3. COLORFGBG is static for the life of the process, so there is nothing
    //    left to re-detect.
    if (options?.report || !warnedNoDetection) {
      warnedNoDetection = true;
      ctx.ui.notify("Terminal answered neither DSR ?996 nor OSC 11; theme left unchanged.", "warning");
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
    description: "Repaint screen, re-detect terminal theme (reports detection source)",
    handler: async (_args, ctx) => {
      await refresh(ctx, { report: true });
    },
  });
}
