# Dotfiles

## Installation

```sh
./install.sh
# First migration when layered targets already exist:
./install.sh --force
```

The entries under `files/` are symlinked into `$HOME`; `__` in a filename means a path separator. Node.js 22+ and npm are hard prerequisites. The installer validates and bootstraps the package before changing home-directory dotfiles, then registers the public `personal` layer and applies all active layers. Missing/old Node, missing npm, or bootstrap failure exits nonzero instead of reporting partial success. The bootstrap hashes `package-lock.json`, so unchanged daily installs do not contact npm.

The small `files/bin__dotfiles-layer` launcher resolves its real public checkout through the live symlink and executes the package CLI.

On the first `--force` migration, an existing regular `~/.gitconfig` is copied into `files/.gitconfig` before the live path is replaced by the public-repo symlink. This intentionally makes host-tool changes visible as public working-tree changes; review them carefully before committing or deliberately move stable private sections into the private layer.

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

Register always revalidates the manifest. Registering a name already resolving to the same canonical root is a true filesystem no-op; the same name at a different root is atomically retargeted. `check` and `diff` exit nonzero on differences. `--adopt` records an identical unmanaged target; `--force` replaces an unmanaged or unexpectedly modified target. Writes and native directory publication are staged/atomic, permission controlled, and protected by one state-root lock. No-op apply preserves target and ledger mtimes.

### `managed.json` ownership semantics

`managed.json` is only the compositor's ownership and drift ledger. For each applied target it stores the canonical output path, strategy, and last desired digest; it is not a source snapshot and cannot restore content. The compositor compares that record with the current projection before overwriting it.

Deleting `managed.json` intentionally forgets all ownership. Missing targets may then be created normally, identical existing targets require `apply --adopt`, and differing existing targets require `apply --force`. Re-adoption creates a fresh ledger. Deleting individual generated outputs while retaining the ledger causes the next apply to recreate them. There is no observe or snapshot command.

## Application hooks

- Pi settings, keybindings, MCP client visibility, tool-manager preferences, global instructions, refresh/statusline/skill-projection extension code, and shared statusline libraries are managed by the personal layer. Generated JSON entry points such as `settings.json`, `mcp.json`, and `statusline.json` start with a `$comment` naming the target and `dotfiles-layer explain` command that locates extension sources. Single-owner files such as `keybindings.json` are symlinked directly to their repository source. The public statusline reads optional composed promotion rules from `~/.pi/agent/statusline.json`; the public base is empty, while private layers can promote their own extension statuses without forking the statusline. A private layer may add provider/MCP server preferences, skill-projection data, and autocomplete packages/config. Credentials, trust decisions, sessions, generated model catalogs, package caches, marketplace state, sandbox runtime/security decisions, and histories remain intentionally app/machine-owned.
- zsh sources ordered fragments from the generated zsh projection.
- `files/.gitconfig` is the public, tracked root Git config and ends with a generic include of the generated Git loader. Host tooling changes therefore visibly dirty this checkout. Private identity remains a native fragment.
- tmux sources the generated tmux loader.
- Git and tmux hooks use default state paths. With a custom absolute `XDG_STATE_HOME`, the installer creates compatibility symlinks from those default paths to the actual projections.

## Tests

```sh
cd dotfiles-layer
npm test
# Optional integration with any external layer:
DOTFILES_OVERLAY_LAYER=/path/to/layer npm test
```

Tests always use temporary HOME/XDG roots.
