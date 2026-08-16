# Dotfiles

## Provisioning a new machine

```sh
# Prerequisite: Node.js 22+ and npm.
git clone https://github.com/parshap/dotfiles.git ~/dotfiles
~/dotfiles/install.sh
```

The installer validates and bootstraps the compositor package before changing anything, then symlinks the entries under `files/` into `$HOME` (`__` in a filename means a path separator), registers the public `personal` layer, and applies all active layers. Missing/old Node, missing npm, or bootstrap failure exits nonzero instead of reporting partial success. The bootstrap hashes `package-lock.json`, so unchanged routine installs do not contact npm.

On a populated home directory the installer refuses to replace anything it does not already own and reports every conflict before touching any file. Review the list, then either move the conflicting files away and rerun, or rerun with:

```sh
./install.sh --force-links    # replace reviewed static-file conflicts
./install.sh --adopt-layer    # adopt identical existing composed targets
./install.sh --force-layer    # replace reviewed composed-target drift
```

Every force path backs up whatever it displaces and prints the backup path; see "Force and backups" below. `--force` and `-f` remain aliases for `--force-links`; they never bypass compositor ownership or drift checks. Newly managed files whose destinations do not exist need no force option. Real directory conflicts are always refused rather than recursively deleted or accidentally nested.

The small `files/bin__dotfiles-layer` launcher resolves its real public checkout through the live symlink and executes the package CLI.

On the first `--force-links` migration, an existing regular `~/.gitconfig` is copied into `files/.gitconfig` before the live path is replaced by the public-repo symlink. This intentionally makes host-tool changes visible as public working-tree changes; review them carefully before committing or deliberately move stable private sections into the private layer.

## Daily updates

`dotfiles-update` (linked at `~/bin/dotfiles-update`) fetches upstream, replays uncommitted local edits on top via the stash, and reruns `./install.sh`. A zsh hook runs it in the background once per day; set `DOTFILES_AUTO_UPDATE=0` to disable the hook. Run `dotfiles-update` any time for a synchronous update.

Background runs stay silent when nothing changed and everything is clean. Reporting uses two files under `~/.cache/dotfiles-update/`:

- **Alerts** (`alert`): failures. An alert re-prints at *every* shell start until a run completes successfully and clears it — a persistent problem cannot be missed once and forgotten.
- **Notices** (`notice`): one-shot news — an update, uncommitted-file counts, composed-config problems, and any local config overrides in effect. Each notice prints once at the next shell start, then is deleted. Both point at per-day logs kept for a week.

Update semantics:

- Uncommitted changes (tracked and untracked) are stashed, replayed after the fast-forward, and restored exactly on any failure. If upstream conflicts with local edits, the update rolls back to the pre-update commit with the edits back in the working tree, and reports the conflict.
- A run interrupted mid-update leaves local edits in the stash; the next run recovers them before doing anything else, and refuses to proceed (with manual recovery instructions) if they no longer apply cleanly.
- Diverged history (unpushed local commits) is never rebased or reset; the run fails and says so.
- A successful fast-forward followed by an installer failure leaves HEAD advanced; the next run reconverges from there.

## Making and adopting changes

Entries under `files/` are symlinked, so editing a live file edits this repo's working tree: `git -C ~/dotfiles diff` shows the change and committing publishes it. Host tools writing through those symlinks (for example into `~/.gitconfig`) appear the same way, and the daily update notice reports the uncommitted-file count so those edits stay visible.

Composed targets (Pi/Claude settings, zsh/Git/tmux loaders) are generated output; editing them directly creates *local overrides*. JSON targets (`json-patch`/`json-merge-patch`) merge overrides the way `git pull` merges a dirty file: keys the layers did not change keep their local values, keys only the layers changed take the new value, and a key changed on both sides fails the apply with the conflicting pointer named. Local overrides are expected state — `check` reports them as `local overrides` without failing — while non-JSON targets (`copy`, `concat`, `symlink`, `native-include`) are fully layer-owned and still refuse any drift. To inspect and adopt a live change:

```sh
dotfiles-layer check          # which targets differ, and how
dotfiles-layer diff TARGET    # live vs composed content
dotfiles-layer explain TARGET # which layer sources contribute
```

Adopt the change by editing the listed contribution in the appropriate layer repo, running `dotfiles-layer apply TARGET`, and committing there. Discard it instead with `dotfiles-layer apply TARGET --force`. Note that `apply --adopt` only records ownership of output that is already identical; it never imports content.

## Force and backups

Anything a force path displaces — a static file replaced by `--force-links`, an unmanaged or drifted composed target replaced by `--force`, a drifted stale target pruned by `--force` — is first copied to `${XDG_STATE_HOME:-~/.local/state}/dotfiles-layer/backups/<timestamp>-<pid>/`, with the backup path printed. Backups are retained for 30 days. Content the compositor already tracks (managed output matching its recorded digest) is reproducible from the layers and is not backed up.

## Layered configuration

Active layer roots are registry symlinks under `${XDG_CONFIG_HOME:-~/.config}/dotfiles-layer/layers.d`. Only absolute XDG paths are honored; relative values fall back under `$HOME`. Generated projections, the ownership ledger, and the global lock live under `${XDG_STATE_HOME:-~/.local/state}/dotfiles-layer`.

A `layer.json` declares a name, integer priority, target definitions, and ordered contributions. Layers sort by priority then name; order within a layer is preserved. Source files must resolve inside their layer root. Duplicate/unknown targets, target collisions, path traversal, ambiguous winners, and duplicate native fragment names are rejected.

Strategies:

- `symlink` and `copy`: one contribution from the highest-priority layer
- `concat`: deterministic newline-normalized concatenation
- `json-merge-patch`: RFC 7396
- `json-patch`: RFC 6902 and RFC 6901 pointers, including arrays and root operations
- `native-include`: named zsh, Git, or tmux fragments projected into native loaders

Templates and custom commands are intentionally unsupported. Package/library details are in [`dotfiles-layer/README.md`](dotfiles-layer/README.md).

### CLI

```sh
dotfiles-layer register NAME PATH
dotfiles-layer unregister NAME
dotfiles-layer layers
dotfiles-layer explain [TARGET]
dotfiles-layer diff [TARGET]
dotfiles-layer check [TARGET]
dotfiles-layer apply [TARGET] [--adopt] [--force]
```

Register always revalidates the manifest. Registering a name already resolving to the same canonical root is a true filesystem no-op; the same name at a different root is atomically retargeted. `check` and `diff` exit nonzero on differences. `--adopt` records an identical unmanaged target; `--force` replaces an unmanaged or unexpectedly modified target, backing up the displaced content first (see "Force and backups"). Writes and native directory publication are staged/atomic, permission controlled, and protected by one state-root lock. No-op apply preserves target and ledger mtimes.

### `managed.json` ownership semantics

`managed.json` is only the compositor's ownership and drift ledger. For each applied target it stores the canonical output path, strategy, and last desired digest; for JSON targets it also stores the last-applied desired content, which serves as the merge base for three-way merges. It is not a restore source: content that a force path displaces is preserved under `backups/` in the state root. Ledger records written before base content existed treat all current drift as local-only on their next apply. The compositor compares that record with the current projection before overwriting it. A full `check` reports ledger targets no longer declared by active manifests; a full `apply` removes those stale outputs only when they still match the recorded digest, and refuses drift unless `--force` is explicit. Target-specific apply does not prune unrelated state.

Deleting `managed.json` intentionally forgets all ownership. Missing targets may then be created normally, identical existing targets require `apply --adopt`, and differing existing targets require `apply --force`. Re-adoption creates a fresh ledger. Deleting individual generated outputs while retaining the ledger causes the next apply to recreate them. There is no observe or snapshot command.

## Application hooks

- Pi settings, keybindings, MCP client visibility, tool-manager preferences, global instructions, refresh/statusline/skill-projection extension code, and shared statusline libraries are managed by the personal layer. Generated JSON entry points such as `settings.json`, `mcp.json`, and `statusline.json` start with a `$comment` naming the target and `dotfiles-layer explain` command that locates extension sources. Single-owner files such as `keybindings.json` are symlinked directly to their repository source. The public statusline reads optional composed promotion rules from `~/.pi/agent/statusline.json`; the public base is empty, while private layers can promote their own extension statuses without forking the statusline. A private layer may add provider/MCP server preferences, skill-projection data, and autocomplete packages/config. Credentials, trust decisions, sessions, generated model catalogs, package caches, marketplace state, sandbox runtime/security decisions, and histories remain intentionally app/machine-owned.
- zsh sources ordered fragments from the generated zsh projection.
- `files/.gitconfig` is the public, tracked root Git config and ends with a generic include of the generated Git loader. Host tooling changes therefore visibly dirty this checkout. Private identity remains a native fragment.
- tmux sources the generated tmux loader.
- Git and tmux hooks reference the default state paths; a custom `XDG_STATE_HOME` is not supported for native loaders.

## Tests

```sh
cd dotfiles-layer
npm test
# Optional integration with any external layer:
DOTFILES_OVERLAY_LAYER=/path/to/layer npm test
```

Tests always use temporary HOME/XDG roots.
