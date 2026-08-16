import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LOCK_DIR, REGISTRY, STATE_FILE, STATE_ROOT } from "./config.js";
import { composeRegistry, loadLayers, validateManifest } from "./manifest.js";
import { applyJsonPatch, maskPointers, mergePatch, preservePointer } from "./rfc.js";
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
  const controlledDigest = (target.preserve || []).length > 0
    ? hash(jsonText(maskPointers(value, target.preserve)))
    : undefined;
  return { kind: "file", target, content, digest: hash(content), controlledDigest };
}

function makePlans(targetId) {
  const layers = loadLayers();
  const targets = composeRegistry(layers);
  if (targetId && !targets.has(targetId)) fail(`unknown target: ${targetId}`);
  const selected = targetId ? [targets.get(targetId)] : [...targets.values()].sort((a, b) => compareText(a.id, b.id));
  return { layers, targets, plans: selected.map(targetPlan) };
}

function readState() {
  if (!exists(STATE_FILE)) return { version: 1, targets: {} };
  const state = readJson(STATE_FILE, "managed state");
  if (!isObject(state) || state.version !== 1 || !isObject(state.targets)) fail("malformed managed state");
  return state;
}

function nativeDigestAt(targetPath, app) {
  if (!exists(targetPath) || !fs.lstatSync(targetPath).isDirectory()) return exists(targetPath) ? "wrong-kind" : null;
  const fragments = path.join(targetPath, "fragments");
  if (!exists(fragments) || !fs.lstatSync(fragments).isDirectory()) return "wrong-kind";
  const entries = [];
  for (const name of fs.readdirSync(fragments).sort()) {
    const file = path.join(fragments, name);
    if (!fs.lstatSync(file).isSymbolicLink()) return "wrong-kind";
    entries.push({ name, source: path.resolve(path.dirname(file), fs.readlinkSync(file)) });
  }
  let loader = "";
  const loaderName = app === "git" ? "loader.gitconfig" : app === "tmux" ? "loader.conf" : null;
  if (loaderName) {
    const loaderPath = path.join(targetPath, loaderName);
    if (!exists(loaderPath) || !fs.lstatSync(loaderPath).isFile()) return "wrong-kind";
    loader = fs.readFileSync(loaderPath, "utf8");
  }
  return hash(JSON.stringify(entries) + loader);
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
  return nativeDigestAt(p, plan.target.app);
}

function actualDigestForRecord(record) {
  if (!exists(record.path)) return null;
  if (record.strategy === "symlink") {
    if (!fs.lstatSync(record.path).isSymbolicLink()) return "wrong-kind";
    return hash(`link:${path.resolve(path.dirname(record.path), fs.readlinkSync(record.path))}`);
  }
  if (record.strategy === "native-include") {
    if (!record.app) return "unknown-metadata";
    return nativeDigestAt(record.path, record.app);
  }
  if (!fs.lstatSync(record.path).isFile()) return "wrong-kind";
  return hash(fs.readFileSync(record.path));
}

function removeRecordedTarget(record) {
  if (!exists(record.path)) return;
  if (record.strategy === "native-include") {
    if (!fs.lstatSync(record.path).isDirectory()) fail(`refusing to recursively remove non-directory stale target ${record.path}`);
    fs.rmSync(record.path, { recursive: true });
    return;
  }
  if (fs.lstatSync(record.path).isDirectory()) fail(`refusing to remove directory at stale target ${record.path}`);
  fs.rmSync(record.path);
}

function statusFor(plan, state) {
  const actual = actualDigest(plan);
  const record = state.targets[plan.target.id]
    ?? Object.values(state.targets).find((candidate) => candidate?.path === plan.target.path);
  let actualControlledDigest;
  if (plan.controlledDigest && actual !== null && actual !== "wrong-kind") {
    try {
      const actualValue = readJson(plan.target.path, `live target ${plan.target.path}`);
      actualControlledDigest = hash(jsonText(maskPointers(actualValue, plan.target.preserve || [])));
    } catch {
      actualControlledDigest = "invalid";
    }
  }
  const modeCurrent = plan.kind !== "file" || actual === null || actual === "wrong-kind" || (fs.lstatSync(plan.target.path).mode & 0o777) === modeFor(plan);
  return {
    actual,
    actualControlledDigest,
    record,
    current: actual === plan.digest && modeCurrent,
    managed: Boolean(record && record.path === plan.target.path),
  };
}

function modeFor(plan) {
  if (plan.target.mode) return Number.parseInt(plan.target.mode, 8);
  return ["json-patch", "json-merge-patch"].includes(plan.target.strategy) ? 0o600 : 0o644;
}

let backupDir = null;

function backupPathFor(targetPath) {
  if (!backupDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = path.join(STATE_ROOT, "backups", `${stamp}-${process.pid}`);
  }
  return path.join(backupDir, targetPath.replaceAll("/", "__"));
}

// Preserve content the ledger cannot reproduce (unmanaged or drifted) before a
// force path displaces it. The printed path is the recovery mechanism.
function backupExisting(targetPath) {
  const backup = backupPathFor(targetPath);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(targetPath), backup);
  else if (stat.isDirectory()) fs.cpSync(targetPath, backup, { recursive: true, verbatimSymlinks: true });
  else fs.copyFileSync(targetPath, backup);
  console.log(`Backed up ${targetPath} -> ${backup}`);
}

function pruneBackups() {
  const root = path.join(STATE_ROOT, "backups");
  if (!exists(root)) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(root)) {
    try {
      const entry = path.join(root, name);
      if (fs.statSync(entry).mtimeMs < cutoff) fs.rmSync(entry, { recursive: true, force: true });
    } catch { /* retention is best effort */ }
  }
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
  let movedExisting = false;
  try {
    const fragments = path.join(stage, "fragments");
    fs.mkdirSync(fragments, { recursive: true, mode: 0o700 });
    for (const entry of plan.entries) fs.symlinkSync(entry.source, path.join(fragments, entry.name));
    if (plan.target.app === "git") fs.writeFileSync(path.join(stage, "loader.gitconfig"), plan.loader, { mode: 0o600 });
    if (plan.target.app === "tmux") fs.writeFileSync(path.join(stage, "loader.conf"), plan.loader, { mode: 0o600 });
    if (exists(plan.target.path)) {
      fs.renameSync(plan.target.path, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(stage, plan.target.path);
    } catch (publishError) {
      if (movedExisting && !exists(plan.target.path)) {
        try { fs.renameSync(backup, plan.target.path); }
        catch (restoreError) {
          fail(`failed to publish ${plan.target.id} and restore its previous output; backup preserved at ${backup}: ${restoreError.message}`);
        }
      }
      if (exists(backup)) fail(`failed to publish ${plan.target.id}; previous output preserved at ${backup}: ${publishError.message}`);
      throw publishError;
    }
    if (movedExisting) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString("hex");
  const ownerPath = path.join(LOCK_DIR, "owner.json");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, jsonText({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 });
      } catch (error) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        throw error;
      }
      return () => {
        try {
          const owner = readJson(ownerPath, "lock owner");
          if (owner?.token === token) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          // Never remove a lock whose ownership can no longer be verified.
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    let owner;
    try { owner = readJson(ownerPath, "lock owner"); } catch { owner = undefined; }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        fail("another dotfiles-layer process holds the global lock");
      } catch (error) {
        if (error instanceof Error && error.message === "another dotfiles-layer process holds the global lock") throw error;
        if (error.code !== "ESRCH") fail("another dotfiles-layer process holds the global lock");
      }
    } else {
      let ageMs;
      try { ageMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; }
      catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (ageMs < 30_000) fail("another dotfiles-layer process is initializing the global lock");
    }

    const stalePath = `${LOCK_DIR}.stale-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
    try { fs.renameSync(LOCK_DIR, stalePath); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "EEXIST") fail("another dotfiles-layer process is reclaiming the global lock");
      throw error;
    }
    fs.rmSync(stalePath, { recursive: true, force: true });
  }

  fail("could not acquire the global dotfiles-layer lock");
}

function withLock(callback) {
  const release = acquireLock();
  try { return callback(); } finally { release(); }
}

export function apply(targetId, options) {
  return withLock(() => {
    // Build every selected result before publishing any of them.
    const { targets, plans } = makePlans(targetId);
    const state = readState();
    const originalState = jsonText(state);
    const desiredPaths = new Set([...targets.values()].map((target) => target.path));
    const stale = targetId
      ? []
      : Object.entries(state.targets).filter(([id]) => !targets.has(id));

    for (const plan of plans) {
      const status = statusFor(plan, state);
      if (status.current) {
        if (!status.managed && !options.adopt && !options.force) fail(`${plan.target.id}: desired target already exists but is unmanaged; record ownership with: dotfiles-layer apply ${plan.target.id} --adopt`);
        continue;
      }
      if (status.actual !== null && !status.managed && !options.force) fail(`${plan.target.id}: refusing to replace unmanaged target ${plan.target.path}; inspect with: dotfiles-layer diff ${plan.target.id}; then replace with: dotfiles-layer apply ${plan.target.id} --force (the existing content is backed up first)`);
      const acceptsLiveBase = ["json-patch", "json-merge-patch"].includes(plan.target.strategy)
        && plan.target.base === "live";
      const onlyPreservedFieldsChanged = Boolean(
        plan.controlledDigest
        && status.record?.controlledDigest
        && status.actualControlledDigest === status.record.controlledDigest
      );
      if (status.managed && status.record.digest !== status.actual && !options.force && !acceptsLiveBase && !onlyPreservedFieldsChanged) {
        fail(`${plan.target.id}: managed target was modified outside the compositor; inspect with: dotfiles-layer diff ${plan.target.id}; to keep the change, adopt it into the layer source (see: dotfiles-layer explain ${plan.target.id}); to discard it: dotfiles-layer apply ${plan.target.id} --force (the modified content is backed up first)`);
      }
    }

    const stalePlans = stale.map(([id, record]) => {
      const superseded = desiredPaths.has(record.path);
      const actual = superseded ? record.digest : actualDigestForRecord(record);
      if (!superseded && actual !== null && actual !== record.digest && !options.force) {
        fail(`${id}: stale managed target ${record.path} was modified outside the compositor; inspect the file, then prune with: dotfiles-layer apply --force (the modified content is backed up first)`);
      }
      return { id, record, actual, superseded };
    });

    let changed = 0;
    let pruned = 0;
    let persistedState = originalState;
    const persistState = () => {
      const nextState = jsonText(state);
      if (nextState !== persistedState) {
        atomicFile(STATE_FILE, Buffer.from(nextState), 0o600);
        persistedState = nextState;
      }
    };

    for (const plan of plans) {
      const status = statusFor(plan, state);
      if (!status.current) {
        // Managed content matching its recorded digest is reproducible from
        // the layers; anything else being displaced is preserved first.
        const reproducible = status.managed && status.record.digest === status.actual;
        if (status.actual !== null && !reproducible) backupExisting(plan.target.path);
        if (plan.kind === "file") atomicFile(plan.target.path, plan.content, modeFor(plan));
        else if (plan.kind === "symlink") atomicSymlink(plan.target.path, plan.source);
        else publishNative(plan);
        changed++;
      }
      state.targets[plan.target.id] = {
        path: plan.target.path,
        strategy: plan.target.strategy,
        digest: plan.digest,
        ...(plan.target.app ? { app: plan.target.app } : {}),
        ...(plan.controlledDigest ? { controlledDigest: plan.controlledDigest } : {}),
      };
      persistState();
    }

    for (const stalePlan of stalePlans) {
      if (!stalePlan.superseded && stalePlan.actual !== null) {
        if (stalePlan.actual !== stalePlan.record.digest) backupExisting(stalePlan.record.path);
        removeRecordedTarget(stalePlan.record);
      }
      delete state.targets[stalePlan.id];
      persistState();
      pruned++;
    }

    pruneBackups();
    console.log(`Applied ${plans.length} target(s); ${changed} changed; ${pruned} pruned.`);
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
  const { targets, plans } = makePlans(targetId);
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
  if (!targetId) {
    for (const [id, record] of Object.entries(state.targets)) {
      if (targets.has(id)) continue;
      const superseded = [...targets.values()].some((target) => target.path === record.path);
      console.log(`${id}: stale (managed)${superseded ? "; path superseded by another target" : ` -> ${record.path}`}`);
      different++;
    }
  }
  if (different) process.exitCode = 1;
}
