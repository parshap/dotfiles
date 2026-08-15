#!/usr/bin/env bash
# Claude Code status line:  where   ·········   session state
#
# One row above the built-in footer. The left group is "where am I" (repo +
# git branch); the right group, right-aligned to the terminal edge, is
# session state (model, context-window %, cost) -- the tmux / vim-airline
# "a b c … x y z" convention and Starship's left/$fill/right split.
#
# Colors use the basic 16-color ANSI palette on purpose: they inherit the
# terminal's own theme (selenized) rather than hard-coding hex. Only the
# context % carries a strong color (an early-warning gradient); structural
# bits are dimmed. Stateless: one jq pass + one cheap `git branch`, no temp
# files, no timers. Kept to bash 3.2 features (macOS system bash).

set -u

# Uppercase the first letter (portable; avoids bash-4 ${x^}).
title() { printf '%s%s' "$(printf %s "${1:0:1}" | tr 'a-z' 'A-Z')" "${1:1}"; }

input=$(cat)

# Fields joined with US (\u001f), not tab: tab is IFS-whitespace, so `read`
# would collapse an empty field (e.g. no repo) and shift every column after
# it. US is non-whitespace, so empty fields are preserved.
IFS=$'\037' read -r CWD REPO MODEL_ID MODEL PCT COST EFFORT < <(
    jq -r '[ .workspace.current_dir // ".",
             .workspace.repo.name // "",
             .model.id // "",
             .model.display_name // "?",
             (.context_window.used_percentage // 0 | floor),
             (.cost.total_cost_usd // 0),
             .effort.level // "" ] | map(tostring) | join("\u001f")' <<<"$input"
)
[[ "$PCT" =~ ^[0-9]+$ ]] || PCT=0

DIM=$'\033[2m'; RESET=$'\033[0m'

# --- where (left) --------------------------------------------------------

# Prefer the repo name: in an emdash worktree the cwd leaf just repeats the
# branch, so the repo is the more useful, non-redundant "where". Fall back to
# a home-relative, middle-collapsed cwd path when there's no git remote.
if [ -n "$REPO" ]; then
    WHERE="$REPO"
else
    WHERE="$CWD"
    [[ "$WHERE" == "$HOME"* ]] && WHERE="~${WHERE#"$HOME"}"
    if [ "${#WHERE}" -gt 32 ]; then
        base="${WHERE##*/}"; parent="${WHERE%/*}"; parent="${parent##*/}"
        WHERE="…/$parent/$base"
    fi
fi

BRANCH="$(git -C "$CWD" branch --show-current 2>/dev/null)"

if [ -n "$BRANCH" ]; then
    left_plain="$WHERE  ⎇ $BRANCH"
    left="${DIM}${WHERE}${RESET}  ${DIM}⎇${RESET} ${BRANCH}"
else
    left_plain="$WHERE"
    left="${DIM}${WHERE}${RESET}"
fi

# --- session state (right) ----------------------------------------------

# Friendly model label from the id, e.g. claude-opus-4-8[1m] -> "Opus 4.8 1M".
# family = first alphabetic segment; version = short numeric segments joined
# by "." (an 8-digit date suffix is dropped); "[1m]" marks the 1M variant.
# Built as a string, not an array -- empty arrays trip `set -u` on bash 3.2.
ctx_tag=""; [[ "$MODEL_ID" == *"[1m]"* ]] && ctx_tag=" 1M"
id="${MODEL_ID#claude-}"; id="${id%%\[*}"
family=""; ver=""
if [ -n "$id" ]; then
    IFS='-' read -ra segs <<<"$id"
    for seg in "${segs[@]}"; do
        if [[ "$seg" =~ ^[0-9]+$ ]]; then
            [ "${#seg}" -lt 5 ] && ver="${ver:+$ver.}$seg"
        elif [ -z "$family" ]; then
            family="$seg"
        fi
    done
fi
if [ -n "$family" ]; then
    MODEL_LABEL="$(title "$family")${ver:+ $ver}${ctx_tag}"
else
    MODEL_LABEL="$MODEL"                           # fall back to display_name
fi

# Context fills quietly, so grade it: green until 40%, yellow approaching,
# red from 60% on.
if   [ "$PCT" -ge 60 ]; then CTX=$'\033[31m'   # red
elif [ "$PCT" -ge 40 ]; then CTX=$'\033[33m'   # yellow
else                         CTX=$'\033[32m'   # green
fi
COST_FMT=$(printf '$%.2f' "$COST")

# Session-state segments joined by a dim "·" divider: model, effort, context
# %, cost. Effort is the reasoning level -- a property of "what I'm talking
# to", absent on models without the param (Ultracode reports as "xhigh").
# Structural bits (divider, "ctx" label) are dimmed; only the % carries color.
DOT="${DIM}·${RESET}"

right="$MODEL_LABEL"
right_plain="$MODEL_LABEL"
if [ -n "$EFFORT" ]; then
    right="$right $DOT ${DIM}${EFFORT}${RESET}"
    right_plain="$right_plain · $EFFORT"
fi
right="$right $DOT ${DIM}ctx${RESET} ${CTX}${PCT}%${RESET} $DOT ${COST_FMT}"
right_plain="$right_plain · ctx ${PCT}% · ${COST_FMT}"

# --- lay out: left  ……fill……  right -------------------------------------

# Right-align the state group, but reserve a few columns rather than hugging
# the true edge: Claude Code indents this row on the left and uses its right
# end for notifications / the verbose token counter, so rendering to COLUMNS
# gets clipped with an ellipsis. COLUMNS is set by Claude Code (v2.1.153+);
# widths use the plain forms so ANSI codes don't count.
EDGE_RESERVE=3
if [ "${COLUMNS:-0}" -gt 0 ]; then
    gap=$(( COLUMNS - ${#left_plain} - ${#right_plain} - EDGE_RESERVE ))
    [ "$gap" -lt 2 ] && gap=2
else
    gap=6
fi
printf '%s%*s%s\n' "$left" "$gap" "" "$right"
