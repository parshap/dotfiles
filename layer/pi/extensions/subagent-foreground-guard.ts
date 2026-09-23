/**
 * Block foreground pi-subagents launches.
 *
 * pi-subagents runs foreground children (`async: false`) as sessions inside
 * the parent process without loading installed extensions, so
 * pi-permission-system and permission-reviewer never see their tool calls.
 * Background children run in a separate runner that loads them and forwards
 * asks to the parent, so background delegation stays gated.
 *
 * A launch is foreground when it sets `async: false`, or omits `async` while
 * pi-subagents' `asyncByDefault` is false. Management calls (`action`) are not
 * launches and pass through. User-typed `/run` commands don't go through the
 * tool and are not affected.
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function asyncByDefault(): boolean {
	try {
		const file = path.join(getAgentDir(), "extensions", "subagent", "config.json");
		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		return config?.asyncByDefault !== false;
	} catch {
		return true;
	}
}

export function isForegroundLaunch(input: Record<string, unknown>, defaultAsync: boolean): boolean {
	if (typeof input.action === "string" && input.action.trim() !== "") return false;
	if (input.async === false) return true;
	if (input.async === undefined) return !defaultAsync;
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (!isForegroundLaunch(input, asyncByDefault())) return;
		return {
			block: true,
			reason:
				"Foreground subagents are disabled: they run without the permission system. Launch it in the background instead (omit `async` or set `async: true`).",
		};
	});
}
