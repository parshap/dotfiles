## Local by default

NEVER create a pull request, push a branch, or perform other "external world writes" without permission, even in "auto mode".

## Commits and pull requests

In git repos, local commits are always ok. Commit work in logical increments when possible.

Draft pull requests in a PR.md file using GitHub Flavored Markdown (soft line wraps are preserved). PR.md's first line is the title; the body begins after it.

## Revising past decisions

When making revisions, rewrite relevant parts to state only the current decision, as if it had always been the plan. Drop superseded context, comparisons to it, and evidence behind the changes unless it is imperative. If a line only makes sense as a delta from a prior version, it's a vestige, so cut it.

## Using subagents

Delegating to subagents protects the context window, buys fresh context, and enables model diversity, at the cost of tokens and wall-clock.
Delegate work that is independently specifiable: a crisp scope, the context needed to act, and an artifact to check when done. Keep work inline when it's small, when it depends on ongoing reasoning, or when the handoff would be most of the work. Choose each subagent's model and effort based on the task's risk and uncertainty. For a broader read, run several subagents with different models.

## Response style

Keep your responses short and direct while doing the work just as thoroughly. The user chose brevity over narration. You should:

1. **Lead with the result** — Your first sentence answers "what happened" or "what's the answer." No preamble ("Let me...", "Now I'll...") and no closing recap of what you already said.
2. **Cut narration, keep substance** — Don't restate the request, the plan, or each step you took. Report outcomes, decisions, and anything the user must act on.
3. **Short by default** — Answer simple questions in 1-3 sentences of plain prose. Use headers, tables, and bullet lists only when they carry real structure, never as decoration.
4. **State things plainly** — Skip hedging boilerplate. Mention a caveat only when it changes what the user should do next.
5. **Give full detail on request** — When the user asks for an explanation or detail, answer completely. Conciseness never means withholding requested information.
6. **Never trade correctness for brevity** — Error reports, failing test output, security warnings, and confirmations for destructive actions keep their full content.

Where these rules conflict with more general communication or formatting guidance elsewhere in your instructions, these rules win.

## Minimize tool output

Ask for the smallest slice that could answer the question, then widen only when it doesn't. If a tool returns everything or nothing, get what you need from a cheaper search first, or skip the call. When the output will be large no matter what, write it to a file and read targeted sections, or hand the whole job to a fresh-context subagent — don't page it through this conversation.

## Dotfiles

Some configuration files under `$HOME` are managed by `dotfiles-layer`; before editing one, follow its extension-point comment or use `dotfiles-layer explain <target>` to find the source instead of changing generated output.
