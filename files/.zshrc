## oh-my-zsh

# Path to your oh-my-zsh configuration
ZSH=$HOME/.oh-my-zsh

# Set name of the theme to load
ZSH_THEME="robbyrussell"

# Plugins to load
plugins=(git vagrant ssh-agent compleat npm)

# Load ssh-agent
zstyle :omz:plugins:ssh-agent agent-forwarding on
zstyle :omz:plugins:ssh-agent id_rsa

source $ZSH/oh-my-zsh.sh

export PATH="$HOME/bin:/usr/local/bin:$PATH"
export EDITOR=vim

# Predictable SSH authentication socket location.
# See http://qq.is/tutorial/2011/11/17/ssh-keys-through-screen.html
SOCK="/tmp/ssh-agent-$USER"
if test $SSH_AUTH_SOCK && [ $SSH_AUTH_SOCK != $SOCK ]
then
	rm -f /tmp/ssh-agent-$USER
	ln -sf $SSH_AUTH_SOCK $SOCK
	export SSH_AUTH_SOCK=$SOCK
fi

# Language
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8
export LANGUAGE=en_US.UTF-8

# Mocha
mocha () {
	"$(git root)/node_modules/.bin/mocha" $@
}

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

v() {
	local command=$1
	shift
	# shift
	case "$1" in
		"s") command=status ;;
		"u") command=up ;;
		"p") command=provision ;;
	esac
	vagrant $command $@
}
