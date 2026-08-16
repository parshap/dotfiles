import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

// End-to-end harness for files/bin__dotfiles-update. Every test builds a
// throwaway origin/clone pair with HOME and XDG roots redirected, and a stub
// install.sh in the repo under test that records its invocations.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPDATER = path.resolve(TEST_DIR, "../../files/bin__dotfiles-update");
const COMPOSITOR = path.resolve(TEST_DIR, "../../files/bin__dotfiles-layer");

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotfiles-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const config = path.join(root, "xdg-config");
  const state = path.join(root, "xdg-state");
  for (const dir of [home, cache, config, state]) fs.mkdirSync(dir, { recursive: true });

  // Upstream working clone, seeded with a stub installer and one config file.
  const upstream = path.join(root, "upstream");
  git(root, ["init", "-b", "master", upstream]);
  fs.writeFileSync(path.join(upstream, "install.sh"), "#!/bin/sh\necho install-ran >> \"$DOTFILES_TEST_MARKER\"\n");
  fs.chmodSync(path.join(upstream, "install.sh"), 0o755);
  fs.writeFileSync(path.join(upstream, "config.txt"), "upstream-v1\n");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-m", "initial"]);

  const origin = path.join(root, "origin.git");
  git(upstream, ["clone", "--bare", upstream, origin]);
  git(upstream, ["remote", "add", "origin", origin]);
  git(upstream, ["push", "-u", "origin", "master"]);

  const work = path.join(home, "dotfiles");
  git(home, ["clone", origin, work]);

  // Production invokes the updater through its ~/bin symlink; do the same so
  // script-relative resource resolution is exercised.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(UPDATER, path.join(bin, "dotfiles-update"));

  return {
    root, home, cache, config, state, upstream, origin, work,
    marker: path.join(root, "install-marker"),
    lockDir: path.join(cache, "dotfiles-update-install.lock"),
    notice: path.join(cache, "test-update", "notice"),
    alert: path.join(cache, "test-update", "alert"),
    stamp: path.join(cache, "test-update", "last-check"),
  };
}

function run(w, args = [], extraEnv = {}) {
  return spawnSync("bash", [path.join(w.home, "bin", "dotfiles-update"), ...args], {
    env: {
      ...process.env, ...GIT_ENV,
      HOME: w.home,
      XDG_CACHE_HOME: w.cache,
      XDG_CONFIG_HOME: w.config,
      XDG_STATE_HOME: w.state,
      DOTFILES_DIR: w.work,
      DOTFILES_LABEL: "test",
      DOTFILES_TEST_MARKER: w.marker,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function ok(result, message = "update should pass") {
  assert.equal(result.status, 0, `${message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}
function fails(result, pattern, message = "update should fail") {
  assert.notEqual(result.status, 0, `${message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout + result.stderr, pattern);
  return result;
}

function upstreamCommit(w, file, content, message = "upstream change") {
  fs.writeFileSync(path.join(w.upstream, file), content);
  git(w.upstream, ["add", file]);
  git(w.upstream, ["commit", "-m", message]);
  git(w.upstream, ["push", "origin", "master"]);
}

const head = (w) => git(w.work, ["rev-parse", "HEAD"]);
const upstreamHead = (w) => git(w.upstream, ["rev-parse", "HEAD"]);
const stashList = (w) => git(w.work, ["stash", "list"]);

test("clean fast-forward updates, runs the installer, and reports the outcome", (t) => {
  const w = world(t);
  const before = head(w);
  upstreamCommit(w, "config.txt", "upstream-v2\n");
  const result = ok(run(w));
  assert.match(result.stdout, /updated .* -> /);
  assert.equal(head(w), upstreamHead(w));
  assert.notEqual(head(w), before);
  assert.equal(fs.readFileSync(w.marker, "utf8").trim(), "install-ran");
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "upstream-v2\n");
});

test("local uncommitted edits survive a non-conflicting update", (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  upstreamCommit(w, "other.txt", "new upstream file\n");
  ok(run(w));
  assert.equal(head(w), upstreamHead(w));
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "local edit\n");
  assert.equal(fs.readFileSync(path.join(w.work, "other.txt"), "utf8"), "new upstream file\n");
  assert.equal(stashList(w), "");
});

test("conflicting local edits roll back to the original HEAD with edits intact", (t) => {
  const w = world(t);
  const before = head(w);
  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  upstreamCommit(w, "config.txt", "upstream-v2\n");
  fails(run(w), /upstream conflicts with local edits/);
  assert.equal(head(w), before);
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "local edit\n");
  assert.equal(stashList(w), "");
});

test("an upstream file colliding with an untracked local file rolls back safely", (t) => {
  const w = world(t);
  const before = head(w);
  fs.writeFileSync(path.join(w.work, "notes.txt"), "mine\n");
  upstreamCommit(w, "notes.txt", "theirs\n");
  fails(run(w), /upstream conflicts with local edits/);
  assert.equal(head(w), before);
  assert.equal(fs.readFileSync(path.join(w.work, "notes.txt"), "utf8"), "mine\n");
  assert.equal(stashList(w), "");
});

test("diverged history restores stashed edits and refuses to update", (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.work, "local-only.txt"), "unpushed\n");
  git(w.work, ["add", "local-only.txt"]);
  git(w.work, ["commit", "-m", "local commit"]);
  const localHead = head(w);
  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  upstreamCommit(w, "other.txt", "new upstream file\n");
  fails(run(w), /cannot fast-forward/);
  assert.equal(head(w), localHead);
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "local edit\n");
  assert.equal(stashList(w), "");
});

test("a stash remnant from an interrupted run is recovered before updating", (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.work, "config.txt"), "interrupted edit\n");
  git(w.work, ["stash", "push", "--include-untracked", "-m", "dotfiles-auto-update"]);
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "upstream-v1\n");
  const result = ok(run(w));
  assert.match(result.stdout, /recovered local edits/);
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "interrupted edit\n");
  assert.equal(stashList(w), "");
});

test("a missing upstream is a loud failure, not a silent skip", (t) => {
  const w = world(t);
  git(w.work, ["branch", "--unset-upstream"]);
  fails(run(w), /no upstream configured/);
});

test("an install.sh failure is reported and leaves local edits intact", (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  fs.writeFileSync(path.join(w.upstream, "install.sh"), "#!/bin/sh\nexit 1\n");
  git(w.upstream, ["add", "install.sh"]);
  git(w.upstream, ["commit", "-m", "break installer"]);
  git(w.upstream, ["push", "origin", "master"]);
  fails(run(w), /install\.sh failed/);
  // The merge is not rolled back on install failure; local edits must survive.
  assert.equal(head(w), upstreamHead(w));
  assert.equal(fs.readFileSync(path.join(w.work, "config.txt"), "utf8"), "local edit\n");
  assert.equal(stashList(w), "");
});

test("up-to-date runs report uncommitted files and composed-config drift", (t) => {
  const w = world(t);
  let result = ok(run(w));
  assert.match(result.stdout, /already up to date/);
  assert.doesNotMatch(result.stdout, /uncommitted|needs attention/);

  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  result = ok(run(w));
  assert.match(result.stdout, /1 uncommitted file\(s\)/);

  // Drift a composed target and expect the health line to name it.
  const layer = path.join(w.root, "layer");
  fs.mkdirSync(layer);
  fs.writeFileSync(path.join(layer, "layer.json"), JSON.stringify({
    version: 1, name: "layer", priority: 1,
    targets: { cfg: { strategy: "copy", path: path.join(w.home, "out.txt") } },
    contributions: [{ target: "cfg", path: "src.txt" }],
  }));
  fs.writeFileSync(path.join(layer, "src.txt"), "managed\n");
  const env = {
    ...process.env, ...GIT_ENV,
    HOME: w.home, XDG_CACHE_HOME: w.cache, XDG_CONFIG_HOME: w.config, XDG_STATE_HOME: w.state,
  };
  assert.equal(spawnSync(COMPOSITOR, ["register", "layer", layer], { env, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(COMPOSITOR, ["apply"], { env, encoding: "utf8" }).status, 0);
  fs.writeFileSync(path.join(w.home, "out.txt"), "drifted\n");
  result = ok(run(w));
  assert.match(result.stdout, /composed config needs attention: cfg/);
});

// Signal-based liveness is unavailable in sandboxes that deny kill(2)
// (EPERM even for own processes); the updater fails closed there, so the
// liveness-dependent lock cases only run where signals work.
const signalsDenied = spawnSync("bash", ["-c", "sleep 30 </dev/null >/dev/null 2>&1 & kill -0 $!"], { encoding: "utf8" }).status !== 0;

test("failures persist as alerts until a run succeeds", (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.work, "config.txt"), "local edit\n");
  upstreamCommit(w, "config.txt", "upstream-v2\n");
  fails(run(w), /upstream conflicts with local edits/);
  assert.match(fs.readFileSync(w.alert, "utf8"), /upstream conflicts with local edits/);

  // The hook re-prints alerts at every shell start but consumes notices.
  fs.writeFileSync(w.notice, "[test] updated aaa -> bbb\n");
  fs.writeFileSync(w.stamp, new Date().toISOString().slice(0, 10) + "\n");
  let hook = ok(run(w, ["--shell-hook"]));
  assert.match(hook.stdout, /upstream conflicts/);
  assert.match(hook.stdout, /updated aaa -> bbb/);
  assert.equal(fs.existsSync(w.notice), false);
  hook = ok(run(w, ["--shell-hook"]));
  assert.match(hook.stdout, /upstream conflicts/);
  assert.doesNotMatch(hook.stdout, /updated aaa/);
  assert.equal(fs.existsSync(w.alert), true);

  // A successful run clears the alert.
  git(w.work, ["checkout", "--", "config.txt"]);
  ok(run(w));
  assert.equal(fs.existsSync(w.alert), false);
});

test("a dead owner's lock is reclaimed; a live owner's lock is respected", { skip: signalsDenied }, (t) => {
  const w = world(t);

  // Dead owner: reclaimed immediately.
  const dead = spawnSync("true", [], { env: process.env });
  fs.mkdirSync(w.lockDir, { recursive: true });
  fs.writeFileSync(path.join(w.lockDir, "pid"), String(dead.pid));
  ok(run(w));
  assert.equal(fs.existsSync(w.lockDir), false);

  // Live owner: the update times out and leaves the lock untouched.
  const holder = spawn("sleep", ["30"]);
  t.after(() => holder.kill());
  fs.mkdirSync(w.lockDir, { recursive: true });
  fs.writeFileSync(path.join(w.lockDir, "pid"), String(holder.pid));
  fails(run(w, [], { DOTFILES_UPDATE_LOCK_ATTEMPTS: "2" }), /timed out waiting/);
  assert.equal(fs.readFileSync(path.join(w.lockDir, "pid"), "utf8"), String(holder.pid));
  holder.kill();
});

test("a lock dir with no pid is reclaimed once it is old", (t) => {
  const w = world(t);
  fs.mkdirSync(w.lockDir, { recursive: true });
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(w.lockDir, old, old);
  ok(run(w));
  assert.equal(fs.existsSync(w.lockDir), false);
});
