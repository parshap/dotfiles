# dotfiles-layer

`dotfiles-layer` is an ESM package for conservatively composing ordered configuration layers. It requires Node.js 22 or newer and npm.

## Bootstrap and test

```sh
./bootstrap.sh
npm test
```

Dependencies are exact-versioned in `package-lock.json`. `bootstrap.sh` hashes that lockfile and runs `npm ci --ignore-scripts` only when `node_modules` is absent or the recorded lock hash changed, so routine installs do no npm network work.

The package uses Ajv for manifest structure validation. `fast-json-patch` handles validated RFC 6902 operations, including arrays and root replacement, and `json-merge-patch` handles RFC 7396. Both libraries intentionally protect prototype-sensitive names, so `src/rfc.js` uses a narrow compatibility path only when a document, pointer, or value contains literal `__proto__`, `constructor`, or `prototype` members. This preserves those JSON members without prototype mutation or silent loss.

## Layout

- `src/cli.js`: command parsing
- `src/manifest.js`: schema, path containment, registry loading, and target resolution
- `src/rfc.js`: JSON Pointer/Patch/Merge Patch boundary
- `src/compositor.js`: planning, native projections, atomic publication, locking, and ownership checks
- `layer.json` and adjacent resources: the personal layer

Use the installed `dotfiles-layer` launcher rather than invoking source modules directly. See the repository README for commands and state semantics.
