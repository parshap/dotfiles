#!/usr/bin/env bash

set -e
shopt -s nullglob dotglob

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES_PATH="$SCRIPT_DIR/files"
FORCE=false

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--force) FORCE=true ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

# Check if files directory exists
if [ ! -d "$FILES_PATH" ]; then
    echo "Error: $FILES_PATH directory not found"
    exit 1
fi

# Decode __ in filenames to / in destination paths (e.g. bin__foo -> bin/foo)
dest_path() {
    local name
    name="$(basename "$1")"
    echo "$HOME/${name//__//}"
}

# Returns 0 if it's safe to create/overwrite the symlink at dest
can_link() {
    local dest="$1" source="$2"
    # Nothing exists at the destination (including broken symlinks)
    if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then return 0; fi
    # A symlink exists but already points to the correct source
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$source" ]; then return 0; fi
    return 1
}

# During the one-time return to a public-owned Git root, preserve the current
# regular ~/.gitconfig as the tracked source before replacing it with a symlink.
# Subsequent host-tool edits already flow through that symlink into the repo.
adopt_git_config() {
    local source="$FILES_PATH/.gitconfig"
    local dest="$HOME/.gitconfig"
    local loader="$HOME/.local/state/dotfiles-layer/native/git-fragments/loader.gitconfig"
    local loader_tilde="~/.local/state/dotfiles-layer/native/git-fragments/loader.gitconfig"
    local tmp

    if [ "$FORCE" != true ] || [ ! -f "$dest" ] || [ -L "$dest" ]; then return 0; fi

    tmp="$(mktemp "$FILES_PATH/.gitconfig.adopt.XXXXXX")"
    cp "$dest" "$tmp"
    if ! git config --file "$tmp" --get-all include.path 2>/dev/null | grep -Fqx -e "$loader" -e "$loader_tilde"; then
        if ! git config --file "$tmp" --add include.path "$loader"; then
            rm -f "$tmp"
            return 1
        fi
    fi
    mv "$tmp" "$source"
    echo "Adopted live Git config -> $source"
}

COMPOSITOR="$FILES_PATH/bin__dotfiles-layer"
LAYER_ROOT="$SCRIPT_DIR/dotfiles-layer"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Error: Node.js 22+ and npm are required; no dotfiles were installed." >&2
    exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Error: Node.js 22+ is required (found $(node --version)); no dotfiles were installed." >&2
    exit 1
fi

"$LAYER_ROOT/bootstrap.sh"
git -C "$SCRIPT_DIR" submodule update --init --recursive

adopt_git_config
files=("$FILES_PATH"/*)

# Preflight: check all destinations before creating any links
if [ "$FORCE" = false ]; then
    errors=0
    for file in "${files[@]}"; do
        [ -f "$file" ] || [ -d "$file" ] || continue
        dest="$(dest_path "$file")"
        if ! can_link "$dest" "$file"; then
            echo "Error: $dest already exists and is not a managed symlink"
            errors=$((errors + 1))
        fi
    done

    if [ "$errors" -gt 0 ]; then
        echo "Aborting: $errors conflict(s) found"
        exit 1
    fi
fi

# Create the links
for file in "${files[@]}"; do
    [ -f "$file" ] || [ -d "$file" ] || continue
    dest="$(dest_path "$file")"
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$file" ]; then
        echo "Already linked $(basename "$file") -> $dest"
        continue
    fi
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$file" "$dest"
    echo "Linked $(basename "$file") -> $dest"
done

# Register the personal layer without disturbing any other active layers, then
# compose every active target. Existing unmanaged layered targets require the
# installer's explicit --force option on first adoption.
"$COMPOSITOR" register personal "$LAYER_ROOT"
apply_args=()
if [ "$FORCE" = true ]; then apply_args+=(--force); fi
"$COMPOSITOR" apply "${apply_args[@]}"

# Git and tmux loaders cannot portably express an XDG_STATE_HOME fallback.
# Keep their public hooks generic by projecting compatibility links at the
# default paths when a custom absolute state home is configured.
dotfiles_state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
case "$dotfiles_state_home" in
    /*) ;;
    *) dotfiles_state_home="$HOME/.local/state" ;;
esac
for native_target in git-fragments tmux-fragments; do
    actual_native="$dotfiles_state_home/dotfiles-layer/native/$native_target"
    default_native="$HOME/.local/state/dotfiles-layer/native/$native_target"
    if [ "$actual_native" = "$default_native" ]; then continue; fi

    mkdir -p "$(dirname "$default_native")"
    if [ -e "$default_native" ] || [ -L "$default_native" ]; then
        if [ ! -L "$default_native" ] || [ "$(readlink "$default_native")" != "$actual_native" ]; then
            echo "Error: cannot create XDG compatibility link at $default_native" >&2
            exit 1
        fi
    else
        ln -s "$actual_native" "$default_native"
    fi
done
unset actual_native default_native dotfiles_state_home native_target

echo "Done!"
