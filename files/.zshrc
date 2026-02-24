## oh-my-zsh

# Path to your oh-my-zsh configuration
ZSH=$HOME/.oh-my-zsh

# Set name of the theme to load
ZSH_THEME="robbyrussell"

# Plugins to load
plugins=(git ssh-agent npm)

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

# Aliases
alias n='npm'

