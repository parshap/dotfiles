import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LOCK_DIR, REGISTRY, STATE_FILE, STATE_ROOT } from "./config.js";
import { composeRegistry, loadLayers, validateManifest } from "./manifest.js";
import { applyJsonPatch, mergePatch, preservePointer } from "./rfc.js";
import { clone, compareText, exists, fail, hash, isObject, jsonText, readJson, safeName } from "./util.js";

function readLiveJson(targetPath) {
  if (!exists(targetPath)) return {};
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() && !stat.isSymbolicLink()) fail(`JSON target is not a file: ${targetPath}`);
  return readJson(targetPath, `live target ${targetPath}`);
}

function gitConfigQuote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}

function nativePlan(target) {
  const entries = target.contributions.map((contribution, order) => {
    const prefix = String(order).padStart(3, "0");
    const ext = target.app === "git" ? ".gitconfig" : target.app === "tmux" ? ".conf" : ".zsh";
    return { name: `${prefix}-${contribution.layer}-${contribution.name}${ext}`, source: contribution.path };
  });
  let loader = null;
  if (target.app === "git") loader = entries.map((entry) => `[include]\n\tpath = ${gitConfigQuote(path.join(target.path, "fragments", entry.name))}\n`).join("");
  if (target.app === "tmux") loader = entries.map((entry) => `source-file -q ${shellQuote(path.join(target.path, "fragments", entry.name))}\n`).join("");
  return { kind: "native", target, entries, loader, digest: hash(JSON.stringify(entries) + (loader || "")) };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function targetPlan(target) {
  if (target.strategy === "native-include") return nativePlan(target);
  if (!target.contributions.length) fail(`target ${target.id} has no contributions`);
  if (["symlink", "copy"].includes(target.strategy)) {
    const max = Math.max(...target.contributions.map((x) => x.priority));
    const winners = target.contributions.filter((x) => x.priority === max);
    const layers = new Set(winners.map((x) => x.layer));
    if (layers.size !== 1 || winners.length !== 1) fail(`ambiguous winning contributions for ${target.id}`);
    const source = winners[0].path;
    if (target.strategy === "symlink") return { kind: "symlink", target, source, digest: hash(`link:${source}`) };
    const content = fs.readFileSync(source);
    return { kind: "file", target, content, digest: hash(content) };
  }
  if (target.strategy === "concat") {
    const pieces = target.contributions.map((x) => fs.readFileSync(x.path, "utf8").replace(/\n+$/u, ""));
    const content = Buffer.from(`${pieces.join("\n")}\n`);
    return { kind: "file", target, content, digest: hash(content) };
  }
  const live = readLiveJson(target.path);
  let value = target.base === "live" ? clone(live) : {};
  for (const contribution of target.contributions) {
    const input = readJson(contribution.path, `contribution ${contribution.path}`);
    value = target.strategy === "json-patch" ? applyJsonPatch(value, input) : mergePatch(value, input);
  }
  for (const pointer of target.preserve || []) value = preservePointer(value, live, pointer);
  const content = Buffer.from(jsonText(value));
  return { kind: "file", target, content, digest: hash(content) };
}

function makePlans(targetId) {
  const layers = loadLayers();
  const targets = composeRegistry(layers);
  if (targetId && !targets.has(targetId)) fail(`unknown target: ${targetId}`);
  const selected = targetId ? [targets.get(targetId)] : [...targets.values()].sort((a, b) => compareText(a.id, b.id));
  return { layers, plans: selected.map(targetPlan) };
}

function readState() {
  if (!exists(STATE_FILE)) return { version: 1, targets: {} };
  const state = readJson(STATE_FILE, "managed state");
  if (!isObject(state) || state.version !== 1 || !isObject(state.targets)) fail("malformed managed state");
  return state;
}

function actualDigest(plan) {
  const p = plan.target.path;
  if (!exists(p)) return null;
  if (plan.kind === "symlink") {
    if (!fs.lstatSync(p).isSymbolicLink()) return "wrong-kind";
    return hash(`link:${path.resolve(path.dirname(p), fs.readlinkSync(p))}`);
  }
  if (plan.kind === "file") {
    if (!fs.lstatSync(p).isFile()) return "wrong-kind";
    return hash(fs.readFileSync(p));
  }
  if (!fs.lstatSync(p).isDirectory()) return "wrong-kind";
  const fragments = path.join(p, "fragments");
  if (!exists(fragments) || !fs.lstatSync(fragments).isDirectory()) return "wrong-kind";
  const entries = [];
  for (const name of fs.readdirSync(fragments).sort()) {
    const file = path.join(fragments, name);
    if (!fs.lstatSync(file).isSymbolicLink()) return "wrong-kind";
    entries.push({ name, source: path.resolve(path.dirname(file), fs.readlinkSync(file)) });
  }
  let loader = "";
  const loaderName = plan.target.app === "git" ? "loader.gitconfig" : plan.target.app === "tmux" ? "loader.conf" : null;
  if (loaderName) {
    const loaderPath = path.join(p, loaderName);
    if (!exists(loaderPath)) return "wrong-kind";
    loader = fs.readFileSync(loaderPath, "utf8");
  }
  return hash(JSON.stringify(entries) + loader);
}

function statusFor(plan, state) {
  const actual = actualDigest(plan);
  const record = state.targets[plan.target.id];
  const modeCurrent = plan.kind !== "file" || actual === null || actual === "wrong-kind" || (fs.lstatSync(plan.target.path).mode & 0o777) === modeFor(plan);
  return { actual, record, current: actual === plan.digest && modeCurrent, managed: Boolean(record && record.path === plan.target.path) };
}

function modeFor(plan) {
  if (plan.target.mode) return Number.parseInt(plan.target.mode, 8);
  return ["json-patch", "json-merge-patch"].includes(plan.target.strategy) ? 0o600 : 0o644;
}

function atomicFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally { if (exists(temp)) fs.rmSync(temp, { force: true, recursive: true }); }
}

function atomicSymlink(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
  try { fs.symlinkSync(source, temp); fs.renameSync(temp, file); }
  finally { if (exists(temp)) fs.rmSync(temp, { force: true, recursive: true }); }
}

function publishNative(plan) {
  const parent = path.dirname(plan.target.path);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.${path.basename(plan.target.path)}.stage-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
  const backup = `${stage}.old`;
  try {
    const fragments = path.join(stage, "fragments");
    fs.mkdirSync(fragments, { recursive: true, mode: 0o700 });
    for (const entry of plan.entries) fs.symlinkSync(entry.source, path.join(fragments, entry.name));
    if (plan.target.app === "git") fs.writeFileSync(path.join(stage, "loader.gitconfig"), plan.loader, { mode: 0o600 });
    if (plan.target.app === "tmux") fs.writeFileSync(path.join(stage, "loader.conf"), plan.loader, { mode: 0o600 });
    if (exists(plan.target.path)) fs.renameSync(plan.target.path, backup);
    fs.renameSync(stage, plan.target.path);
    if (exists(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!exists(plan.target.path) && exists(backup)) fs.renameSync(backup, plan.target.path);
    throw error;
  } finally {
    if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true });
    if (exists(backup)) fs.rmSync(backup, { recursive: true, force: true });
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(LOCK_DIR, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const pid = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) stale = true;
      else { try { process.kill(pid, 0); } catch (killError) { if (killError.code === "ESRCH") stale = true; } }
    } catch { stale = true; }
    if (!stale) fail("another dotfiles-layer process holds the global lock");
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(LOCK_DIR, "pid"), `${process.pid}\n`, { mode: 0o600 });
  return () => fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function withLock(callback) {
  const release = acquireLock();
  try { return callback(); } finally { release(); }
}

export function apply(targetId, options) {
  return withLock(() => {
    // Build every selected result before publishing any of them.
    const { plans } = makePlans(targetId);
    const state = readState();
    const originalState = jsonText(state);
    for (const plan of plans) {
      const status = statusFor(plan, state);
      if (status.current) {
        if (!status.managed && !options.adopt && !options.force) fail(`${plan.target.id}: desired target already exists but is unmanaged; use --adopt`);
        continue;
      }
      if (status.actual !== null && !status.managed && !options.force) fail(`${plan.target.id}: refusing to replace unmanaged target ${plan.target.path}; use --force`);
      const acceptsLiveInput = ["json-patch", "json-merge-patch"].includes(plan.target.strategy)
        && (plan.target.base === "live" || (plan.target.preserve || []).length > 0);
      if (status.managed && status.record.digest !== status.actual && !options.force && !acceptsLiveInput) {
        fail(`${plan.target.id}: managed target was modified outside the compositor; use --force`);
      }
    }
    let changed = 0;
    let persistedState = originalState;
    for (const plan of plans) {
      const status = statusFor(plan, state);
      if (!status.current) {
        if (plan.kind === "file") atomicFile(plan.target.path, plan.content, modeFor(plan));
        else if (plan.kind === "symlink") atomicSymlink(plan.target.path, plan.source);
        else publishNative(plan);
        changed++;
      }
      state.targets[plan.target.id] = { path: plan.target.path, strategy: plan.target.strategy, digest: plan.digest };
      const nextState = jsonText(state);
      if (nextState !== persistedState) {
        atomicFile(STATE_FILE, Buffer.from(nextState), 0o600);
        persistedState = nextState;
      }
    }
    console.log(`Applied ${plans.length} target(s); ${changed} changed.`);
  });
}

export function register(name, rawPath) {
  safeName(name, "layer name");
  const root = fs.realpathSync(path.resolve(rawPath));
  validateManifest(root, name);
  withLock(() => {
    fs.mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
    const entry = path.join(REGISTRY, name);
    if (exists(entry)) {
      if (!fs.lstatSync(entry).isSymbolicLink()) fail(`registry entry ${entry} is not a symlink`);
      let currentRoot = null;
      try { currentRoot = fs.realpathSync(entry); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (currentRoot === root) return;
    }
    atomicSymlink(entry, root);
  });
  console.log(`Registered ${name}.`);
}

export function unregister(name) {
  safeName(name, "layer name");
  withLock(() => {
    const entry = path.join(REGISTRY, name);
    if (!exists(entry)) fail(`layer is not registered: ${name}`);
    if (!fs.lstatSync(entry).isSymbolicLink()) fail(`registry entry ${entry} is not a symlink`);
    fs.unlinkSync(entry);
  });
  console.log(`Unregistered ${name}.`);
}

export function printLayers() {
  for (const layer of loadLayers()) console.log(`${layer.name}\tpriority=${layer.priority}\t${layer.root}`);
}

export function explain(targetId) {
  const layers = loadLayers();
  const targets = composeRegistry(layers);
  const selected = targetId ? [targets.get(targetId)] : [...targets.values()].sort((a, b) => compareText(a.id, b.id));
  if (targetId && !selected[0]) fail(`unknown target: ${targetId}`);
  for (const target of selected) {
    console.log(`${target.id}: ${target.strategy} -> ${target.path}`);
    for (const contribution of target.contributions) {
      console.log(`  ${contribution.layer} (priority ${contribution.priority})${contribution.name ? ` name=${contribution.name}` : ""} source=${contribution.path}`);
    }
  }
}

function diffLines(before, after) {
  const a = before.replace(/\n$/u, "").split("\n");
  const b = after.replace(/\n$/u, "").split("\n");
  if (a.length * b.length > 1_000_000) return ["@@ diff too large; hashes reported instead @@"];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) { lines.push(`+${b[j++]}`); }
    else lines.push(`-${a[i++]}`);
  }
  return lines;
}

function printablePlan(plan, desired) {
  if (plan.kind === "file") {
    if (desired) return plan.content.toString("utf8");
    return exists(plan.target.path) && fs.lstatSync(plan.target.path).isFile() ? fs.readFileSync(plan.target.path, "utf8") : "";
  }
  if (plan.kind === "symlink") {
    if (desired) return `${plan.source}\n`;
    return exists(plan.target.path) && fs.lstatSync(plan.target.path).isSymbolicLink() ? `${path.resolve(path.dirname(plan.target.path), fs.readlinkSync(plan.target.path))}\n` : "";
  }
  if (desired) return `${plan.entries.map((entry) => `${entry.name} -> ${entry.source}`).join("\n")}\n${plan.loader || ""}`;
  if (!exists(plan.target.path) || !fs.lstatSync(plan.target.path).isDirectory()) return "";
  const fragments = path.join(plan.target.path, "fragments");
  const entries = exists(fragments) ? fs.readdirSync(fragments).sort().map((name) => {
    const item = path.join(fragments, name);
    return `${name} -> ${fs.lstatSync(item).isSymbolicLink() ? path.resolve(path.dirname(item), fs.readlinkSync(item)) : "<not-a-symlink>"}`;
  }) : [];
  const loaderName = plan.target.app === "git" ? "loader.gitconfig" : plan.target.app === "tmux" ? "loader.conf" : null;
  const loaderPath = loaderName && path.join(plan.target.path, loaderName);
  const loader = loaderPath && exists(loaderPath) ? fs.readFileSync(loaderPath, "utf8") : "";
  return `${entries.join("\n")}\n${loader}`;
}

export function check(targetId, showDiff = false) {
  const { plans } = makePlans(targetId);
  const state = readState();
  let different = 0;
  for (const plan of plans) {
    const status = statusFor(plan, state);
    const label = status.current ? "unchanged" : status.actual === null ? "missing" : "different";
    console.log(`${plan.target.id}: ${label}${status.managed ? " (managed)" : " (unmanaged)"}`);
    if (!status.current) {
      different++;
      if (showDiff) {
        console.log(`--- ${plan.target.path}\n+++ composed:${plan.target.id}`);
        const lines = diffLines(printablePlan(plan, false), printablePlan(plan, true));
        console.log(lines.join("\n"));
        if (lines.length === 1 && lines[0].includes("too large")) console.log(`@@ sha256 ${String(status.actual).slice(0, 12)} -> ${plan.digest.slice(0, 12)} @@`);
      }
    }
  }
  if (different) process.exitCode = 1;
}
