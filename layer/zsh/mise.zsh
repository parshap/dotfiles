# mise puts a project's pinned toolchains on PATH from its mise.toml, so a repo
# that needs one specific Zig or Node gets it by being cd'd into rather than by
# anyone remembering. Interactive shells get the chpwd hook, which switches
# versions as you move between projects; everything else — editors, agents,
# `zsh -c` — gets shims, which resolve the version per invocation and need no
# hook. Must come after brew.zsh, since mise is a Homebrew binary here.
if command -v mise >/dev/null 2>&1; then
	if [[ -o interactive ]]; then
		eval "$(mise activate zsh)"
	else
		eval "$(mise activate zsh --shims)"
	fi
fi
