import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyJsonPatch } from "../src/rfc.js";
import { compileStatusPromotions, selectPromotedStatus } from "../pi/lib/statusline-promotions.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, "../../files/bin__dotfiles-layer");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotfiles layer test-"));
  const home = path.join(root, "home");
  const config = path.join(root, "xdg-config");
  const state = path.join(root, "xdg-state");
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const run = (...args) => spawnSync(CLI, args, { env, encoding: "utf8" });
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  const layer = (name, manifest, files = {}) => {
    const dir = path.join(root, name);
    write(path.join(dir, "layer.json"), JSON.stringify({ version: 1, name, ...manifest }, null, 2));
    for (const [name, content] of Object.entries(files)) write(path.join(dir, name), content);
    return dir;
  };
  return { root, home, config, state, run, write, layer };
}

function ok(result, message = "command should pass") {
  assert.equal(result.status, 0, `${message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}
function notOk(result, pattern) {
  assert.notEqual(result.status, 0, `command unexpectedly passed: ${result.stdout}`);
  if (pattern) assert.match(result.stderr, pattern);
  return result;
}

function targetPaths(home) {
  return {
    symlink: path.join(home, "out/link"), copy: path.join(home, "out/copy"), concat: path.join(home, "out/concat"),
    merge: path.join(home, "out/merge.json"), patch: path.join(home, "out/patch.json"), preserve: path.join(home, "out/preserve.json")
  };
}

test("composes every strategy, orders layers, implements RFC patches, native loaders, check/diff, and no-op apply", () => {
  const f = fixture();
  const p = targetPaths(f.home);
  const low = f.layer("low", {
    priority: 10,
    targets: {
      link: { strategy: "symlink", path: p.symlink },
      copy: { strategy: "copy", path: p.copy, mode: "0640" },
      concat: { strategy: "concat", path: p.concat },
      merge: { strategy: "json-merge-patch", path: p.merge, base: "empty" },
      patch: { strategy: "json-patch", path: p.patch, base: "empty" },
      preserve: { strategy: "json-patch", path: p.preserve, base: "empty", preserve: ["/last", "/nested/keep", "/numbered/0/value"] },
      zsh: { strategy: "native-include", app: "zsh" },
      git: { strategy: "native-include", app: "git" },
      tmux: { strategy: "native-include", app: "tmux" }
    },
    contributions: [
      { target: "link", path: "low-link" }, { target: "copy", path: "low-copy" }, { target: "concat", path: "low.txt" },
      { target: "merge", path: "merge1.json" }, { target: "patch", path: "patch.json" }, { target: "preserve", path: "preserve.patch.json" },
      { target: "zsh", name: "environment", path: "env.zsh" }, { target: "git", name: "identity", path: "identity.gitconfig" },
      { target: "tmux", name: "base", path: "base.conf" }
    ]
  }, {
    "low-link": "low link\n", "low-copy": "low copy\n", "low.txt": "low\n\n",
    "merge1.json": JSON.stringify({ title: "old", nested: { keep: true, remove: 1 }, array: [1, 2] }),
    "patch.json": JSON.stringify([
      { op: "replace", path: "", value: { "a/b": { "~key": [1, 2] }, arr: ["a", "b"], obj: { x: 1 } } },
      { op: "test", path: "/a~1b/~0key/0", value: 1 },
      { op: "add", path: "/a~1b/~0key/-", value: 3 },
      { op: "replace", path: "/obj/x", value: 2 },
      { op: "copy", from: "/obj/x", path: "/copied" },
      { op: "move", from: "/arr/0", path: "/arr/1" },
      { op: "remove", path: "/a~1b/~0key/1" },
      { op: "test", path: "/arr", value: ["b", "a"] },
      { op: "remove", path: "" },
      { op: "add", path: "", value: { root: true } }
    ]),
    "preserve.patch.json": JSON.stringify([{ op: "add", path: "/managed", value: true }]),
    "env.zsh": "export LOW=1\n", "identity.gitconfig": "[user]\n\tname = Low\n", "base.conf": "set -g mouse on\n"
  });
  const high = f.layer("high", {
    priority: 20,
    contributions: [
      { target: "link", path: "high-link" }, { target: "copy", path: "high-copy" }, { target: "concat", path: "high.txt" },
      { target: "merge", path: "merge2.json" }, { target: "zsh", name: "aliases", path: "aliases.zsh" },
      { target: "git", name: "work", path: "work.gitconfig" }, { target: "tmux", name: "work", path: "work.conf" }
    ]
  }, {
    "high-link": "high link\n", "high-copy": "high copy\n", "high.txt": "high",
    "merge2.json": JSON.stringify({ title: "new", nested: { remove: null, add: 2 }, array: "replacement", absent: null }),
    "aliases.zsh": "alias h=high\n", "work.gitconfig": "[user]\n\temail = high@example\n", "work.conf": "set -g status on\n"
  });

  f.write(p.preserve, JSON.stringify({ last: "0.84", nested: { keep: { hostOwned: true }, discard: true }, numbered: { "0": { value: "object-key" } }, unmanaged: true }));
  ok(f.run("register", "high", high));
  ok(f.run("register", "low", low));
  const listed = ok(f.run("layers")).stdout.trim().split("\n");
  assert.match(listed[0], /^low\tpriority=10/);
  assert.match(listed[1], /^high\tpriority=20/);
  const explanation = ok(f.run("explain", "concat")).stdout;
  assert.match(explanation, /low \(priority 10\).*source=.*low\.txt/);
  assert.match(explanation, /high \(priority 20\).*source=.*high\.txt/);
  assert.doesNotMatch(explanation, /low\n\nhigh/);

  notOk(f.run("check"));
  assert.match(notOk(f.run("diff", "copy")).stdout, /\+high copy/);
  ok(f.run("apply", "--force"));
  assert.equal(fs.realpathSync(p.symlink), fs.realpathSync(path.join(high, "high-link")));
  assert.equal(fs.readFileSync(p.copy, "utf8"), "high copy\n");
  assert.equal(fs.statSync(p.copy).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(p.concat, "utf8"), "low\nhigh\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(p.merge)), { title: "new", nested: { keep: true, add: 2 }, array: "replacement" });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.patch)), { root: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.preserve)), { managed: true, last: "0.84", nested: { keep: { hostOwned: true } }, numbered: { "0": { value: "object-key" } } });

  const native = path.join(f.state, "dotfiles-layer/native");
  const zshNames = fs.readdirSync(path.join(native, "zsh/fragments"));
  assert.deepEqual(zshNames, ["000-low-environment.zsh", "001-high-aliases.zsh"]);
  assert.equal(fs.realpathSync(path.join(native, "zsh/fragments", zshNames[1])), fs.realpathSync(path.join(high, "aliases.zsh")));
  const gitLoaderPath = path.join(native, "git/loader.gitconfig");
  const gitLoader = fs.readFileSync(gitLoaderPath, "utf8");
  assert.match(gitLoader, /000-low-identity\.gitconfig/);
  assert.match(gitLoader, /001-high-work\.gitconfig/);
  const gitEmail = spawnSync("git", ["config", "--file", gitLoaderPath, "--includes", "--get", "user.email"], { encoding: "utf8" });
  ok(gitEmail, "Git should parse native include paths containing spaces");
  assert.equal(gitEmail.stdout.trim(), "high@example");
  const tmuxLoader = fs.readFileSync(path.join(native, "tmux/loader.conf"), "utf8");
  assert.match(tmuxLoader, /000-low-base\.conf/);
  assert.match(tmuxLoader, /001-high-work\.conf/);
  ok(f.run("check"));

  const copyMtime = fs.statSync(p.copy).mtimeMs;
  const nativeMtime = fs.statSync(path.join(native, "git")).mtimeMs;
  const stateFile = path.join(f.state, "dotfiles-layer/managed.json");
  const stateMtime = fs.statSync(stateFile).mtimeMs;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.match(ok(f.run("apply")).stdout, /0 changed/);
  assert.equal(fs.statSync(p.copy).mtimeMs, copyMtime);
  assert.equal(fs.statSync(path.join(native, "git")).mtimeMs, nativeMtime);
  assert.equal(fs.statSync(stateFile).mtimeMs, stateMtime);

  ok(f.run("unregister", "high"));
  assert.doesNotMatch(ok(f.run("layers")).stdout, /high/);
});

const externalOverlayLayer = process.env.DOTFILES_OVERLAY_LAYER;
test("real personal and external overlay manifests preserve live Claude and Pi application state", { skip: !externalOverlayLayer }, () => {
  const f = fixture();
  const personal = path.resolve(TEST_DIR, "..");
  const overlay = path.resolve(externalOverlayLayer);
  const overlayManifest = JSON.parse(fs.readFileSync(path.join(overlay, "layer.json"), "utf8"));
  const personalPatch = JSON.parse(fs.readFileSync(path.join(personal, "pi/settings.patch.json"), "utf8"));
  const overlayPatchContribution = overlayManifest.contributions.find((item) => item.target === "pi-settings");
  const overlayPatch = JSON.parse(fs.readFileSync(path.join(overlay, overlayPatchContribution.path), "utf8"));
  const expectedPiSettings = applyJsonPatch(applyJsonPatch({}, personalPatch), overlayPatch);
  const patchValue = (pointer) => overlayPatch.find((operation) => operation.path === pointer)?.value;
  const overlayAgentsContribution = overlayManifest.contributions.find((item) => item.target === "pi-agents");
  const overlayAgents = fs.readFileSync(path.join(overlay, overlayAgentsContribution.path), "utf8").trim();
  const overlayMcpContribution = overlayManifest.contributions.find((item) => item.target === "pi-mcp");
  const overlayMcpPatch = JSON.parse(fs.readFileSync(path.join(overlay, overlayMcpContribution.path), "utf8"));
  const expectedMcpServers = overlayMcpPatch.find((operation) => operation.path === "/mcpServers")?.value;
  const personalStatuslinePatch = JSON.parse(fs.readFileSync(path.join(personal, "pi/statusline.patch.json"), "utf8"));
  const overlayStatuslineContribution = overlayManifest.contributions.find((item) => item.target === "pi-statusline-config");
  const overlayStatuslinePatch = JSON.parse(fs.readFileSync(path.join(overlay, overlayStatuslineContribution.path), "utf8"));
  const expectedStatusline = applyJsonPatch(applyJsonPatch({}, personalStatuslinePatch), overlayStatuslinePatch);
  const zshContributionCount = overlayManifest.contributions.filter((item) => item.target === "zsh-fragments").length;
  const piSettings = path.join(f.home, ".pi/agent/settings.json");
  const claudeSettings = path.join(f.home, ".claude/settings.json");
  f.write(piSettings, JSON.stringify({ lastChangelogVersion: "9.9.9", stale: "removed" }));
  f.write(claudeSettings, JSON.stringify({ apiKeyHelper: "host-helper", env: { HOST_RUNTIME: "kept" }, theme: "old" }));
  ok(f.run("register", overlayManifest.name, overlay));
  ok(f.run("register", "personal", personal));
  ok(f.run("apply", "--force"));
  const pi = JSON.parse(fs.readFileSync(piSettings));
  assert.equal(pi.lastChangelogVersion, "9.9.9");
  assert.equal(pi.stale, undefined);
  assert.equal(pi.packages[0], patchValue("/packages/0"));
  assert.deepEqual(pi.packages, expectedPiSettings.packages);
  assert.equal(pi.defaultProvider, patchValue("/defaultProvider"));
  assert.equal(pi.defaultModel, patchValue("/defaultModel"));
  const mcp = JSON.parse(fs.readFileSync(path.join(f.home, ".pi/agent/mcp.json")));
  assert.deepEqual(mcp.mcpServers, expectedMcpServers);
  const promotions = compileStatusPromotions(expectedStatusline.promotions);
  const configured = expectedStatusline.promotions[0];
  const promotedText = Object.keys(configured.roles)[0];
  const promoted = selectPromotedStatus(new Map([[configured.statusKey, `badge │ ${promotedText} details`]]), promotions);
  assert.deepEqual(promoted, {
    segment: { text: promotedText, role: configured.roles[promotedText] },
    consumedKey: configured.statusKey,
  });
  const claude = JSON.parse(fs.readFileSync(claudeSettings));
  assert.equal(claude.apiKeyHelper, "host-helper");
  assert.deepEqual(claude.env, { HOST_RUNTIME: "kept" });
  assert.equal(claude.theme, "auto");
  assert.equal(claude.effortLevel, "xhigh");
  assert.ok(fs.readFileSync(path.join(f.home, ".pi/agent/AGENTS.md"), "utf8").includes(overlayAgents));
  assert.equal(fs.readdirSync(path.join(f.state, "dotfiles-layer/native/zsh-fragments/fragments")).length, zshContributionCount);
});

test("treats __proto__ as an ordinary RFC JSON object member", () => {
  const f = fixture();
  const mergePath = path.join(f.home, "merge.json");
  const patchPath = path.join(f.home, "patch.json");
  const copyPath = path.join(f.home, "copy.json");
  const layer = f.layer("proto", {
    priority: 1,
    targets: {
      merge: { strategy: "json-merge-patch", path: mergePath },
      patch: { strategy: "json-patch", path: patchPath },
      copy: { strategy: "json-patch", path: copyPath, base: "live" }
    },
    contributions: [
      { target: "merge", path: "merge.json" },
      { target: "patch", path: "patch.json" },
      { target: "copy", path: "copy.json" }
    ]
  }, {
    "merge.json": '{"__proto__":{"source":"merge"}}',
    "patch.json": '[{"op":"add","path":"/__proto__","value":{"source":"patch"}},{"op":"add","path":"/nested","value":{"__proto__":{"deep":true}}}]',
    "copy.json": '[{"op":"copy","from":"/source","path":"/copied"}]'
  });
  f.write(copyPath, '{"source":{"__proto__":{"copied":true}}}');
  ok(f.run("register", "proto", layer));
  ok(f.run("apply", "--force"));
  const merged = JSON.parse(fs.readFileSync(mergePath, "utf8"));
  const patched = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "__proto__"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(patched, "__proto__"), true);
  assert.deepEqual(merged.__proto__, { source: "merge" });
  assert.deepEqual(patched.__proto__, { source: "patch" });
  assert.equal(Object.prototype.hasOwnProperty.call(patched.nested, "__proto__"), true);
  assert.deepEqual(patched.nested.__proto__, { deep: true });
  const copied = JSON.parse(fs.readFileSync(copyPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(copied.copied, "__proto__"), true);
  assert.deepEqual(copied.copied.__proto__, { copied: true });
});

test("accepts declared live-base and preserved-field changes during a later source update", () => {
  const f = fixture();
  const target = path.join(f.home, "settings.json");
  const layer = f.layer("stateful", {
    priority: 1,
    targets: { settings: { strategy: "json-patch", path: target, preserve: ["/runtime"] } },
    contributions: [{ target: "settings", path: "settings.patch.json" }]
  }, { "settings.patch.json": '[{"op":"add","path":"/managed","value":1}]' });
  ok(f.run("register", "stateful", layer));
  f.write(target, '{"runtime":"first"}');
  ok(f.run("apply", "--force"));
  f.write(target, '{"managed":1,"runtime":"second"}');
  f.write(path.join(layer, "settings.patch.json"), '[{"op":"add","path":"/managed","value":2}]');
  ok(f.run("apply"));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { managed: 2, runtime: "second" });
});

test("ignores relative XDG roots instead of scattering state under the working directory", () => {
  const f = fixture();
  const target = path.join(f.home, "value");
  const layer = f.layer("xdg", {
    priority: 1,
    targets: { value: { strategy: "copy", path: target } },
    contributions: [{ target: "value", path: "source" }]
  }, { source: "value\n" });
  const env = { ...process.env, HOME: f.home, XDG_CONFIG_HOME: "relative-config", XDG_STATE_HOME: "relative-state" };
  const run = (...args) => spawnSync(CLI, args, { env, cwd: f.root, encoding: "utf8" });
  ok(run("register", "xdg", layer));
  ok(run("apply", "--force"));
  assert.equal(fs.existsSync(path.join(f.home, ".config/dotfiles-layer/layers.d/xdg")), true);
  assert.equal(fs.existsSync(path.join(f.home, ".local/state/dotfiles-layer/managed.json")), true);
  assert.equal(fs.existsSync(path.join(f.root, "relative-config")), false);
  assert.equal(fs.existsSync(path.join(f.root, "relative-state")), false);
});

test("protects unmanaged files and supports matching adoption and explicit force", () => {
  const f = fixture();
  const desired = path.join(f.home, "desired");
  const layer = f.layer("only", { priority: 1, targets: { copy: { strategy: "copy", path: desired } }, contributions: [{ target: "copy", path: "source" }] }, { source: "same\n" });
  ok(f.run("register", "only", layer));
  f.write(desired, "same\n");
  notOk(f.run("apply"), /unmanaged.*--adopt/);
  ok(f.run("apply", "--adopt"));
  f.write(desired, "local edit\n");
  notOk(f.run("apply"), /modified outside/);
  ok(f.run("apply", "--force"));
  assert.equal(fs.readFileSync(desired, "utf8"), "same\n");

  fs.unlinkSync(desired);
  fs.symlinkSync(path.join(layer, "source"), desired);
  notOk(f.run("apply"), /modified outside/);
  ok(f.run("apply", "--force"));
  assert.equal(fs.lstatSync(desired).isFile(), true);
});

test("rejects malformed registries, traversal, unknown targets, duplicate definitions/names, unsupported strategies, and ambiguous winners", () => {
  const cases = [
    {
      name: "traversal", pattern: /escapes layer root/,
      build(f) { f.write(path.join(f.root, "secret"), "x"); return f.layer("bad", { priority: 1, targets: { x: { strategy: "copy", path: path.join(f.home, "x") } }, contributions: [{ target: "x", path: "../secret" }] }); }
    },
    {
      name: "unsupported", pattern: /allowed values|unsupported strategy/,
      build(f) { return f.layer("bad", { priority: 1, targets: { x: { strategy: "template", path: path.join(f.home, "x") } } }); }
    },
    {
      name: "malformed", pattern: /malformed JSON/,
      build(f) { const dir = path.join(f.root, "bad"); f.write(path.join(dir, "layer.json"), "{"); return dir; }
    }
  ];
  for (const item of cases) {
    const f = fixture();
    notOk(f.run("register", "bad", item.build(f)), item.pattern);
  }

  {
    const f = fixture();
    const bad = f.layer("bad", { priority: 1, contributions: [{ target: "missing", path: "x" }] }, { x: "x" });
    ok(f.run("register", "bad", bad));
    notOk(f.run("check"), /unknown target/);
  }
  {
    const f = fixture();
    const path1 = path.join(f.home, "x");
    const one = f.layer("one", { priority: 1, targets: { x: { strategy: "copy", path: path1 } }, contributions: [{ target: "x", path: "x" }] }, { x: "x" });
    const two = f.layer("two", { priority: 2, targets: { x: { strategy: "copy", path: path1 } }, contributions: [{ target: "x", path: "x" }] }, { x: "x" });
    ok(f.run("register", "one", one)); ok(f.run("register", "two", two));
    notOk(f.run("check"), /duplicate target definition/);
  }
  {
    const f = fixture();
    const collisionPath = path.join(f.home, "same");
    const layer = f.layer("one", { priority: 1, targets: {
      a: { strategy: "copy", path: collisionPath }, b: { strategy: "copy", path: collisionPath }
    } });
    ok(f.run("register", "one", layer));
    notOk(f.run("check"), /target path collision/);
  }
  {
    const f = fixture();
    const one = f.layer("one", { priority: 1, targets: { z: { strategy: "native-include", app: "zsh" } }, contributions: [{ target: "z", name: "same", path: "a" }] }, { a: "a" });
    const two = f.layer("two", { priority: 2, contributions: [{ target: "z", name: "same", path: "b" }] }, { b: "b" });
    ok(f.run("register", "one", one)); ok(f.run("register", "two", two));
    notOk(f.run("check"), /duplicate native-include name/);
  }
  {
    const f = fixture();
    const layer = f.layer("one", { priority: 1, targets: { x: { strategy: "copy", path: path.join(f.home, "x") } }, contributions: [{ target: "x", path: "a" }, { target: "x", path: "b" }] }, { a: "a", b: "b" });
    ok(f.run("register", "one", layer));
    notOk(f.run("check"), /ambiguous winning contributions/);
  }
});

test("JSON Patch rejects invalid pointers, failed tests, array bounds, and moves into children", () => {
  const operations = [
    [{ op: "add", path: "/bad~2escape", value: 1 }],
    [{ op: "test", path: "", value: { no: true } }],
    [{ op: "add", path: "", value: [] }, { op: "add", path: "/1", value: 1 }],
    [{ op: "add", path: "/a", value: { b: 1 } }, { op: "move", from: "/a", path: "/a/b/c" }]
  ];
  for (const [index, patch] of operations.entries()) {
    const f = fixture();
    const layer = f.layer("bad", { priority: 1, targets: { p: { strategy: "json-patch", path: path.join(f.home, "p.json") } }, contributions: [{ target: "p", path: "patch.json" }] }, { "patch.json": JSON.stringify(patch) });
    ok(f.run("register", "bad", layer));
    notOk(f.run("check"), /JSON (pointer|Patch)|array index|move/);
  }
});

test("register revalidates true no-ops and atomically retargets changed canonical roots", () => {
  const f = fixture();
  const first = f.layer("same", { priority: 1 });
  ok(f.run("register", "same", first));
  const entry = path.join(f.config, "dotfiles-layer/layers.d/same");
  const firstMtime = fs.lstatSync(entry).mtimeMs;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  ok(f.run("register", "same", first));
  assert.equal(fs.lstatSync(entry).mtimeMs, firstMtime);

  f.write(path.join(first, "layer.json"), "{");
  notOk(f.run("register", "same", first), /malformed JSON/);
  assert.equal(fs.lstatSync(entry).mtimeMs, firstMtime);

  const second = path.join(f.root, "second");
  f.write(path.join(second, "layer.json"), JSON.stringify({ version: 1, name: "same", priority: 2 }));
  ok(f.run("register", "same", second));
  assert.equal(fs.realpathSync(entry), fs.realpathSync(second));

  fs.unlinkSync(entry);
  fs.symlinkSync(path.join(f.root, "missing"), entry);
  ok(f.run("register", "same", second));
  assert.equal(fs.realpathSync(entry), fs.realpathSync(second));
});

test("bootstrap skips npm when the package lock hash is unchanged", () => {
  const packageRoot = path.resolve(TEST_DIR, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotfiles bootstrap test-"));
  for (const name of ["bootstrap.sh", "package-lock.json"]) fs.copyFileSync(path.join(packageRoot, name), path.join(root, name));
  const lock = fs.readFileSync(path.join(root, "package-lock.json"));
  const hash = crypto.createHash("sha256").update(lock).digest("hex");
  const stamp = path.join(root, "node_modules/.dotfiles-layer-lock.sha256");
  fs.mkdirSync(path.dirname(stamp));
  fs.writeFileSync(stamp, `${hash}\n`);
  const before = fs.statSync(stamp).mtimeMs;
  const result = spawnSync(path.join(root, "bootstrap.sh"), [], { encoding: "utf8" });
  ok(result);
  assert.match(result.stdout, /dependencies are current/);
  assert.equal(fs.statSync(stamp).mtimeMs, before);
});

test("deleting managed.json forgets ownership and requires explicit re-adoption", () => {
  const f = fixture();
  const target = path.join(f.home, "owned");
  const layer = f.layer("owner", {
    priority: 1,
    targets: { owned: { strategy: "copy", path: target } },
    contributions: [{ target: "owned", path: "source" }]
  }, { source: "managed\n" });
  ok(f.run("register", "owner", layer));
  ok(f.run("apply"));
  const ledger = path.join(f.state, "dotfiles-layer/managed.json");
  fs.unlinkSync(ledger);
  notOk(f.run("apply"), /unmanaged.*--adopt/);
  ok(f.run("apply", "--adopt"));
  assert.equal(fs.existsSync(ledger), true);
});
