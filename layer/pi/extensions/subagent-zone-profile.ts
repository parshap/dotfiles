/**
 * subagent-zone-profile
 *
 * Give pi subagents real Agent Beach zone routing instead of the restrictive
 * `rpc` profile.
 *
 * Why this is needed
 * ------------------
 * The Netflix agent-beach plugin coerces every non-TUI pi session to the bundled
 * `rpc` profile unless AGENT_BEACH_PROFILE is set:
 *
 *   // @netflix-internal/pi-agent/src/agent-beach/index.ts
 *   if (ctx.mode !== "tui" && !runtime.environment.profileName) {
 *     const rpcProfile = runtime.availableProfiles.find((p) => p.name === "rpc");
 *     if (rpcProfile) runtime.activeProfile = rpcProfile;
 *   }
 *
 * `rpc` sets `zoneExecAllowlist: ["networkless"]`, so a child agent asking for
 * any other zone gets "target zone is not in profile zoneExecAllowlist" — a hard
 * denial from the profile, before Guardian ever sees the request. pi-subagents
 * spawns children with `--mode json -p`, so every child hits that branch. Note
 * that the persisted selection in ~/.pi/agent/agent-beach/profile.json does not
 * help: the coercion above ignores it.
 *
 * What this extension does
 * ------------------------
 * On `session_start` of an interactive (TUI) session, it sets
 * AGENT_BEACH_PROFILE in this process's environment. pi-subagents spawns
 * children with `env: { ...process.env, ... }`, so children inherit the value
 * and skip the coercion, while this session's own Agent Beach profile is
 * unaffected — agent-beach snapshots the variable in its extension factory,
 * which has already run by the time any `session_start` handler fires.
 *
 * Children still fail closed on anything Guardian will not auto-approve: JSON
 * mode has no manual approval channel. That is the intended boundary. Guardian
 * auto-approval itself runs normally in children, independent of pi's mode.
 *
 * Knobs
 * -----
 * - An AGENT_BEACH_PROFILE already present in the environment always wins, so an
 *   explicit operator selection (or a value inherited by a nested child) is
 *   never overwritten.
 * - PI_SUBAGENT_ZONE_PROFILE overrides which profile children receive.
 * - PI_SUBAGENT_ZONE_PROFILE=off disables the extension.
 *
 * Caveat: after `/reload`, agent-beach re-runs its factory and will observe the
 * value set by the previous load, so this session's profile then reads as
 * env-sourced `normal` rather than persisted `normal`. Same effective policy;
 * only the recorded provenance differs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROFILE_ENV = "AGENT_BEACH_PROFILE";
const OVERRIDE_ENV = "PI_SUBAGENT_ZONE_PROFILE";
const DEFAULT_CHILD_PROFILE = "normal";

function trimmed(value: string | undefined): string | undefined {
	const next = value?.trim();
	return next ? next : undefined;
}

export default function subagentZoneProfileExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Only an interactive parent should hand real zones to its children: a
		// headless pi is itself the case agent-beach pins to `rpc` on purpose.
		if (ctx.mode !== "tui") return;

		// Never override an explicit selection, and never re-set the value inside
		// a child that already inherited it.
		if (trimmed(process.env[PROFILE_ENV])) return;

		const requested = trimmed(process.env[OVERRIDE_ENV]) ?? DEFAULT_CHILD_PROFILE;
		if (requested === "off") return;

		process.env[PROFILE_ENV] = requested;
	});
}
