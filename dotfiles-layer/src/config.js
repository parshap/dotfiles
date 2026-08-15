import os from "node:os";
import path from "node:path";

export const SUPPORTED = new Set(["symlink", "copy", "concat", "json-merge-patch", "json-patch", "native-include"]);
export const NATIVE_APPS = new Set(["zsh", "git", "tmux"]);
export const HOME = process.env.HOME || os.homedir();

const xdgRoot = (name, fallback) => {
  const configured = process.env[name];
  return configured && path.isAbsolute(configured) ? path.resolve(configured) : fallback;
};

export const CONFIG_ROOT = path.join(xdgRoot("XDG_CONFIG_HOME", path.join(HOME, ".config")), "dotfiles-layer");
export const STATE_ROOT = path.join(xdgRoot("XDG_STATE_HOME", path.join(HOME, ".local", "state")), "dotfiles-layer");
export const REGISTRY = path.join(CONFIG_ROOT, "layers.d");
export const STATE_FILE = path.join(STATE_ROOT, "managed.json");
export const LOCK_DIR = path.join(STATE_ROOT, "lock");
export const MANIFEST = "layer.json";
