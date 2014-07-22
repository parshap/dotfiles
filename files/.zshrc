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

# PATH
export PATH=$HOME/bin:/usr/local/bin:$PATH

# Add Brew ruby bin path to PATH
brew_ruby_prefix=$(brew --prefix ruby 2>/dev/null)
if [ $brew_ruby_prefix ]
then
	export PATH=$brew_ruby_prefix/bin:$PATH
fi

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

# Attach to tmux session
if [ "$TMUX" = "" ]
then
	tmux attach
fi

# Aliases
alias n='npm'
alias v='vagrant'
