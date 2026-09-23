# permission-reviewer

A model-backed reviewer for Pi permission asks. It is an authorizer link for
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system):
when the deterministic policy lands on `ask`, this link reviews the pending
action with a model and returns

- **allow** — the action runs without asking;
- **deny** — the tool call fails with a reason telling the agent the action did
  not run and not to work around it;
- **defer** — the ask goes on to the human (or, headless, is denied).

It follows Claude Code auto mode: a block-list classifier that blocks only when
a named rule applies, sees the user's own messages and the agent's executable
tool calls, and never sees tool results.

## Security model

- **Trusted working directory.** The session's working directory is trusted for
  routine development: edits, creating/deleting/moving files, builds, tests,
  installs from manifests, local git. Deleting tracked files is recoverable and
  routine; deleting untracked pre-existing work or discarding uncommitted
  changes needs the user to name it.
- **Blocks follow Claude Code's tiers.** Only data exfiltration is
  unconditional. Everything else risky (secret exposure, credential scanning,
  tampering with the permission system or this reviewer, persistence,
  download-and-execute, irreversible destruction outside the project, public or
  external writes) is a soft block: it clears when the user's own message names
  the operation and the specifics the rule asks for, as in Claude Code.
- **External writes.** Pushes to the session's repo follow Claude Code's
  default; the user's global instructions (`~/.pi/agent/AGENTS.md`) supply the
  "local by default" boundary.
- **Who can authorize.** Only real user messages in the serving session, plus
  the user's global `~/.pi/agent/AGENTS.md`. A subagent's task text is written by
  the parent agent: it explains intent but never authorizes. Project
  `AGENTS.md`/`CLAUDE.md` are context, not authorization. Tool results and
  file/web content are never sent to the reviewer.
- **Caps.** The chain owner downgrades this link's allow on `path` and
  `external_directory` asks to defer, so those always reach the human.
- **Fallback.** After 3 consecutive or 20 total denials in a session, the next
  block defers to the human instead of denying (Claude Code's fallback). Any
  failure — model, auth, timeout, unparseable reply, oversized action — defers.

## What the reviewer sees

For each ask, the user message holds:

1. `~/.pi/agent/AGENTS.md` (user-authored) and the project's `AGENTS.md` /
   `CLAUDE.md` (context), each capped.
2. The serving session's user messages: the first and newest are always kept,
   then newest-to-oldest under a budget.
3. The serving session's non-read-only tool calls (newest kept; `read`, `grep`,
   `find`, `ls` omitted), without results.
4. For an ask forwarded from a subagent: the subagent's task and later parent
   messages, its recent tool calls, and the parent's `subagent` call that
   launched it. pi-subagents stores a child's session under the parent session
   file's stem directory (`<parent>.jsonl` → `<parent>/<run-id>/run-N/session.jsonl`);
   the reviewer finds it by the session id in its header line. If it cannot be
   found, the review proceeds without it and says so.
5. Harness facts: requester, working directories, and — before `rm`, `mv`,
   `git clean/reset/checkout/restore`, `git stash drop`, `find -delete`,
   `rsync --delete` — a bounded `git status --porcelain --untracked-files=all`.
6. The exact planned action (never truncated; above `actionMaxChars` the review
   defers). The gate may ask about one part of a compound command (`curl …` in
   `curl … | sh`), but an allow runs the whole tool call, so `command` is the
   pending call's full command — read from the requester's transcript by call id,
   or, for a forwarded ask (which carries no call id), by matching the gate's
   "full command" evidence — with the gated part beside it.

## Where the policy comes from

`policy.ts` holds the system prompt and documents provenance in its header:

- **OpenAI Codex Guardian** (Apache-2.0, notice kept in `policy.ts`): the frame —
  role, evidence handling, user-authorization scoring, base risk taxonomy,
  outcome policy, JSON output contract, and the denial instruction.
- **Claude Code auto mode**: the security policy's structure (environment,
  HARD BLOCK, SOFT BLOCK with `[named+specifics — must name: …]` bars, ALLOW
  exceptions, user-intent rule, precedence) from its documentation, and rule texts
  from `claude auto-mode defaults` (2.1.280), which Anthropic prints for users to
  copy. Each rule is tagged `(Claude Code default)`, `adapted`, or `(local)`.

## Model

Default: `openai-codex/codex-auto-review` at `low` reasoning — the model Codex
itself uses for Auto-review, calibrated for exactly this task. The prompt keeps
what it is tuned on: Guardian's policy frame with the security policy in its
policy slot, labeled evidence sections, the exact action last, and Guardian's
JSON schema (`outcome: allow|deny`, plus `rule`). Pi does not list the hidden
model id, so the call borrows the transport and auth of a listed
`openai-codex` model (needs a ChatGPT/Codex login in Pi). To use another model,
set `model` (e.g. `openai-codex/gpt-5.6-luna` or `anthropic/claude-haiku-4.5`).

## Config

`~/.pi/agent/extensions/permission-reviewer/config.json` (managed by
dotfiles-layer from `layer/pi/extensions/permission-reviewer/config.json`). All
keys are optional; defaults are in `config.ts`:

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `openai-codex/codex-auto-review` | `provider/model-id` |
| `reasoning` | `low` | reasoning effort |
| `timeoutMs` | `60000` | per-review deadline; a timeout defers |
| `maxOutputTokens` | `4000` | reply cap (reasoning included) |
| `userMessagesChars` / `userMessageChars` | `16000` / `4000` | user-message budget |
| `toolCallsMax` / `toolCallsChars` / `toolCallChars` | `30` / `12000` / `1500` | tool-call budget |
| `subagentTaskChars` / `subagentToolCallsMax` / `launchCallChars` | `6000` / `20` / `4000` | forwarded-ask budget |
| `instructionsChars` | `6000` | per instruction file |
| `gitStatusLines` | `40` | git status lines before destructive commands |
| `actionMaxChars` | `40000` | larger planned actions defer |
| `maxConsecutiveDenials` / `maxTotalDenials` | `3` / `20` | fallback to the human |

Activation is in `layer/pi/extensions/pi-permission-system-config.json`:
`"authorizerChain": ["permission-reviewer"]`.

## Reading decisions

Each review writes one `permission_reviewer.decision` entry to
`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`,
keyed by `requestId` to the gate's own entries:

```sh
jq -c 'select(.event == "permission_reviewer.decision")
  | {timestamp, requestId, surface, verdict, modelOutcome, rule, rationale, latencyMs, childContext, failure}' \
  ~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl | tail
```

Fields: `verdict` (what the link returned), `modelOutcome` (`allow`/`block`),
`rule`, `riskLevel`, `intentLevel`, `rationale`, `latencyMs`, `model`, `failure`
and `detail` on a failed review, `fallback` when the denial limits turned a block
into a defer, `allowCappedByChain` for path asks, `forwarded`,
`requesterAgent`, `childContext` (`found`/`not_found`/`not_forwarded`),
`childSessionFile`, `launchCall` (`run-id`/`pending`/`not_found`),
`pendingCall`, `gitStatus`, token `usage`, and message/tool-call counts. Transcripts and prompts
are never logged. The permission system's own `permission_request.*` entries
show the final outcome (`decidedBy`).

## Tests

```sh
cd layer/pi/extensions/permission-reviewer && node --test test/
```

Pure modules (`config.ts`, `context.ts`, `evidence.ts`, `prompt.ts`,
`review.ts`, `policy.ts`) import nothing from Pi at runtime, so Node's type
stripping runs them directly.
