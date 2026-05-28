## oh-my-zsh

# Path to your oh-my-zsh configuration
ZSH=$HOME/.oh-my-zsh
ZSH_CUSTOM=$HOME/.oh-my-zsh-custom

# Set name of the theme to load
ZSH_THEME="robbyrussell"

# Plugins to load
plugins=(git ssh-agent npm you-should-use zsh-autosuggestions zsh-syntax-highlighting)

# Load ssh-agent
zstyle :omz:plugins:ssh-agent agent-forwarding on
zstyle :omz:plugins:ssh-agent id_rsa

source $ZSH/oh-my-zsh.sh

export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
export EDITOR=vim

# Use the following arguments for `less`
# - -F — quit immediately if content fits on one screen (just prints inline)
# - -R — pass through ANSI color codes (needed for colored git output, etc.)
# - -X — don't send terminal init/deinit sequences (prevents the alternate screen/clearing behavior)
# - -i case-insensitive search
export LESS="-FRXi"

# Predictable SSH authentication socket location for tmux.
# See http://qq.is/tutorial/2011/11/17/ssh-keys-through-screen.html
SOCK="$HOME/.ssh/ssh_auth_sock"
if [ -n "$SSH_AUTH_SOCK" ] && [ "$SSH_AUTH_SOCK" != "$SOCK" ]; then
	ln -sf "$SSH_AUTH_SOCK" "$SOCK"
	export SSH_AUTH_SOCK="$SOCK"
fi

# Language
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8
export LANGUAGE=en_US.UTF-8

# Expand in place
expand-in-place() {
	local OPTIND
	local t=2
	while getopts ":t:" opt
	do
		case $opt in
			t)
				t=$OPTARG
				;;
			\?)
				echo "Invalid option: -$OPTARG" >&2
				;;
		esac
	done
	shift $OPTIND-1

	for file in $@; do
		expand -t $t $file | sponge $file
	done
}

# Update date of current commit to help with chronological ordering
git-date() {
	local datecmd="date"
	command -v gdate &>/dev/null && datecmd="gdate"
	local date=$($datecmd -d "$1")
	GIT_COMMITTER_DATE="$date" git commit --amend --no-edit --date "$date"
}

# Reset terminal state before each prompt. When SSH disconnects abruptly
# (e.g., laptop sleep), the terminal can be left with stale modes enabled
# because the remote application never sent the escape sequences to disable
# them. This is a no-op when the modes are already off.
#
# Resets:
#   \e[?1l     - Normal cursor keys (vs application mode)
#   \e[?25h    - Show cursor (in case it was hidden)
#   \e[?1000l  - Disable normal mouse tracking
#   \e[?1002l  - Disable button-event mouse tracking
#   \e[?1003l  - Disable all-motion mouse tracking
#   \e[?1006l  - Disable SGR extended mouse mode
#   \e[?2004l  - Disable bracketed paste mode
_reset_terminal_modes() {
	printf '\e[?1l\e[?25h\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?2004l'
}
precmd_functions+=(_reset_terminal_modes)

# Aliases
alias n='newt exec'
alias ta='tmux attach'

# Auto-attach to tmux. Only when:
# - It's an SSH connection
# - Not already in tmux
# - It's an interactive shell
#
# This is deferred via precmd so it runs after the entire .zshrc has been
# sourced. This solves for homebrew adding PATH modifications to the end of
# .zshrc.
_tmux_auto_attach() {
	precmd_functions=(${precmd_functions:#_tmux_auto_attach})
	if [ -z "$TMUX" ] && [ -n "$SSH_CONNECTION" ] && [ -n "$PS1" ]; then
		tmux new-session -A -s main && exit || \
			echo "tmux exited with an error"
	fi
}
precmd_functions+=(_tmux_auto_attach)
