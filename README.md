## Installation

```sh
$ ./install.sh
```

Creates a symlink in `$HOME` for each file in the `files` directory. Filenames containing `__` are decoded as path separators (e.g. `bin__claude` is symlinked to `~/bin/claude`).

Use `--force` or -`f` to overwrite existing files.
