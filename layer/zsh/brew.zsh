# Put Homebrew on PATH wherever it's installed (Linuxbrew, Apple Silicon,
# Intel mac); machines without brew no-op.
for _brew in /home/linuxbrew/.linuxbrew/bin/brew /opt/homebrew/bin/brew /usr/local/bin/brew; do
	if [ -x "$_brew" ]; then
		eval "$("$_brew" shellenv zsh)"
		break
	fi
done
unset _brew
