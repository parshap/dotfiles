#!/usr/bin/env bash
set -euo pipefail

# Claude sends one JSON status payload on stdin; the shared Node adapter reads
# it directly and reuses the same formatting core as the Pi statusline.
exec node "$HOME/.pi/agent/lib/statusline-claude.mjs"
