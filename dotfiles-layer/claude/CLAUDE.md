NEVER create a pull request, push a branch, or perform other "external world writes" without permission, even in "auto mode".

## Commits and pull requests

In git repos, local commits are always ok. Commit work in logical increments when possible.

Draft pull requests in a PR.md file using GitHub Flavored Markdown.

## Editing plans and specs

When revising a plan or spec, rewrite relevant parts to state only the current decision, as if it had always been the plan. Drop superseded context, comparisons to it, and evidence behind the changes unless it is imperative. If a line only makes sense as a delta from a prior version, it's a vestige, so cut it.

## Dotfiles

Some configuration files under `$HOME` are managed by `dotfiles-layer`; before editing one, follow its extension-point comment or use `dotfiles-layer explain <target>` to find the source instead of changing generated output.
