# Put rustup's shims on PATH. rustup writes ~/.cargo/env for exactly this and
# asks the shell to source it; nothing did, so cargo was installed and
# unreachable, and every caller worked around it with an inline PATH. Machines
# without rustup no-op.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
