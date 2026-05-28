#!/usr/bin/env bash

set -e
shopt -s nullglob dotglob

# Make sure git submodules are updated
git submodule update --init --recursive

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
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$file" "$dest"
    echo "Linked $(basename "$file") -> $dest"
done

echo "Done!"
