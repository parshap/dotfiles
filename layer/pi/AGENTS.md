## Local by default

NEVER create a pull request, push a branch, or perform other "external world writes" without permission, even in "auto mode".

## Commits and pull requests

In git repos, local commits are always ok. Commit work in logical increments when possible.

Draft pull requests in a PR.md file using GitHub Flavored Markdown (soft line wraps are preserved). PR.md's first line is the title; the body begins after it.

## Revising past decisions

When making revisions, rewrite relevant parts to state only the current decision, as if it had always been the plan. Drop superseded context, comparisons to it, and evidence behind the changes unless it is imperative. If a line only makes sense as a delta from a prior version, it's a vestige, so cut it.

## Prefer fresh-context subagents

For implementation, review, testing, validation, and long-running work, use fresh-context subagents with a compact, self-contained contract: the problem, intent, settled decisions, relevant paths, and expected handoff. Fork only when the conversation itself is the review target or contains essential uncaptured context that cannot be summarized safely.

## Multi-model reviews

Use fresh-context subagents with diverse models and review angles. Derive angles from the request; add further angles grounded in what changed. Set each reviewer's model explicitly; otherwise they inherit yours. Synthesize findings yourself.

## Minimize tool output

Ask for the smallest slice that could answer the question, then widen only when it doesn't. If a tool returns everything or nothing, get what you need from a cheaper search first, or skip the call. When the output will be large no matter what, write it to a file and read targeted sections, or hand the whole job to a fresh-context subagent — don't page it through this conversation.

## Dotfiles

Some configuration files under `$HOME` are managed by `dotfiles-layer`; before editing one, follow its extension-point comment or use `dotfiles-layer explain <target>` to find the source instead of changing generated output.
