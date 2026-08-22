#!/usr/bin/env bash

set -e
shopt -s nullglob dotglob

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES_PATH="$SCRIPT_DIR/files"
FORCE_LINKS=false
LAYER_APPLY_MODE=""

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--force|--force-links) FORCE_LINKS=true ;;
        --adopt-layer) LAYER_APPLY_MODE="--adopt" ;;
        --force-layer) LAYER_APPLY_MODE="--force" ;;
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

    if [ "$FORCE_LINKS" != true ] || [ ! -f "$dest" ] || [ -L "$dest" ]; then return 0; fi

    tmp="$(mktemp "${TMPDIR:-/tmp}/dotfiles-gitconfig-adopt.XXXXXX")"
    cp "$dest" "$tmp"
    if ! git config --file "$tmp" --get-all include.path 2>/dev/null | grep -Fqx -e "$loader" -e "$loader_tilde"; then
        # Keep the generated loader last so its conditional identity can
        # override the public default for matching repositories.
        if ! printf '\n[include]\n\tpath = %s\n' "$loader_tilde" >> "$tmp"; then
            rm -f "$tmp"
            return 1
        fi
    fi
    mv "$tmp" "$source"
    echo "Adopted live Git config -> $source"
}

COMPOSITOR="$FILES_PATH/bin__dotfiles-layer"
# The compositor package and the personal layer are separate directories:
# the package is tooling, the layer is data consumed through it.
PACKAGE_DIR="$SCRIPT_DIR/dotfiles-layer"
LAYER_ROOT="$SCRIPT_DIR/layer"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Error: Node.js 22+ and npm are required; no dotfiles were installed." >&2
    exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Error: Node.js 22+ is required (found $(node --version)); no dotfiles were installed." >&2
    exit 1
fi

"$PACKAGE_DIR/bootstrap.sh"
git -C "$SCRIPT_DIR" submodule update --init --recursive

files=("$FILES_PATH"/*)

# `ln -sfn SOURCE REAL_DIRECTORY` creates a nested link instead of replacing
# the directory. Never guess that recursive deletion is safe, even with force.
directory_errors=0
for file in "${files[@]}"; do
    [ -f "$file" ] || [ -d "$file" ] || continue
    dest="$(dest_path "$file")"
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
        echo "Error: $dest is a real directory; move or remove it before linking $(basename "$file")" >&2
        directory_errors=$((directory_errors + 1))
    fi
done
if [ "$directory_errors" -gt 0 ]; then
    echo "Aborting: $directory_errors directory conflict(s) found" >&2
    exit 1
fi

# Preflight: check all destinations before creating any links
if [ "$FORCE_LINKS" = false ]; then
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

# Adopt the live Git config only once conflicts are ruled out, so a failed
# install never mutates the tracked source.
adopt_git_config

# Content displaced by --force-links is preserved under the compositor's
# state root; the compositor prunes backups older than 30 days on apply.
BACKUP_ROOT=""
backup_dest() {
    local dest="$1" state_home backup
    if [ -z "$BACKUP_ROOT" ]; then
        state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
        case "$state_home" in /*) ;; *) state_home="$HOME/.local/state" ;; esac
        BACKUP_ROOT="$state_home/dotfiles-layer/backups/$(date +%Y-%m-%dT%H-%M-%S)-$$"
    fi
    backup="$BACKUP_ROOT/${dest#/}"
    mkdir -p "$(dirname "$backup")"
    cp -pP "$dest" "$backup"
    echo "Backed up $dest -> $backup"
}

# Create the links
for file in "${files[@]}"; do
    [ -f "$file" ] || [ -d "$file" ] || continue
    dest="$(dest_path "$file")"
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$file" ]; then
        echo "Already linked $(basename "$file") -> $dest"
        continue
    fi
    # Only --force-links reaches this point with an existing destination;
    # preflight aborts otherwise. Preserve whatever is being replaced.
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        backup_dest "$dest"
    fi
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$file" "$dest"
    echo "Linked $(basename "$file") -> $dest"
done

# Static-link replacement and compositor ownership are separate decisions.
# Routine installs never bypass compositor drift/adoption checks.
"$COMPOSITOR" register personal "$LAYER_ROOT"
apply_args=()
if [ -n "$LAYER_APPLY_MODE" ]; then apply_args+=("$LAYER_APPLY_MODE"); fi
"$COMPOSITOR" apply "${apply_args[@]}"

echo "Done!"
