## Local by default

NEVER create a pull request, push a branch, or perform other "external world writes" without explicit permission.

## Commits and pull requests

Make logical commits as you go.

Draft pull requests in ./PR.md (untracked) using GitHub Flavored Markdown (soft line wraps are preserved). The first line is the title, the rest is the body.

## Revising past decisions

When making revisions, rewrite relevant parts to state only the current decision, as if it had always been the plan. Drop superseded context, comparisons to it, and evidence behind the changes unless it is imperative. If a line only makes sense as a delta from a prior version, it's a vestige, so cut it.

## Dotfiles

Some configuration files under `$HOME` are managed by `dotfiles-layer`; before editing one, follow its extension-point comment or use `dotfiles-layer explain <target>` to find the source instead of changing generated output.
