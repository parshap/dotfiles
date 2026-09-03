import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { HOME, MANIFEST, NATIVE_APPS, REGISTRY, STATE_ROOT, SUPPORTED } from "./config.js";
import { parsePointer } from "./rfc.js";
import { compareText, fail, isObject, readJson, safeName } from "./util.js";

const schema = {
  type: "object",
  required: ["version", "name", "priority"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    priority: { type: "integer" },
    targets: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["strategy"],
        additionalProperties: false,
        properties: {
          strategy: { enum: [...SUPPORTED] }, path: { type: "string", minLength: 1 },
          app: { enum: [...NATIVE_APPS] }, base: { enum: ["empty", "live"] },
          preserve: { type: "array", items: { type: "string" } }, mode: { type: "string", pattern: "^[0-7]{3,4}$" },
          level: { type: "integer", minimum: 1, maximum: 6 }
        }
      }
    },
    contributions: {
      type: "array",
      items: {
        type: "object", required: ["target", "path"], additionalProperties: false,
        properties: {
          target: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          path: { type: "string", minLength: 1 }, name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }
        }
      }
    }
  }
};
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

function expandTarget(raw) {
  if (raw === "~") return HOME;
  if (raw.startsWith("~/")) return path.resolve(HOME, raw.slice(2));
  if (raw.includes("${XDG_STATE_HOME}")) raw = raw.replaceAll("${XDG_STATE_HOME}", path.dirname(STATE_ROOT));
  if (raw.includes("${XDG_CONFIG_HOME}")) raw = raw.replaceAll("${XDG_CONFIG_HOME}", path.dirname(path.dirname(REGISTRY)));
  if (!path.isAbsolute(raw)) fail(`target path must be absolute or start with ~/: ${raw}`);
  const resolved = path.resolve(raw);
  // The state root holds the ledger, lock, and backups; only native-include
  // projections (assigned directly, not via this function) may live there.
  if (resolved === STATE_ROOT || resolved.startsWith(`${STATE_ROOT}${path.sep}`)) {
    fail(`target path must not be inside the compositor state root: ${raw}`);
  }
  return resolved;
}

function sourcePath(root, raw) {
  if (path.isAbsolute(raw)) fail(`contribution path must be relative: ${raw}`);
  const candidate = path.resolve(root, raw);
  const escapes = (candidatePath) => {
    const relative = path.relative(root, candidatePath);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (escapes(candidate)) fail(`contribution path escapes layer root: ${raw}`);
  let real;
  try { real = fs.realpathSync(candidate); }
  catch (error) { fail(`cannot resolve contribution ${raw}: ${error.message}`); }
  if (escapes(real)) fail(`contribution resolves outside layer root: ${raw}`);
  if (!fs.statSync(real).isFile()) fail(`contribution is not a file: ${raw}`);
  return real;
}

export function validateManifest(root, registryName) {
  const data = readJson(path.join(root, MANIFEST), `manifest for ${registryName}`);
  if (!validateSchema(data)) fail(`invalid manifest for ${registryName}: ${validateSchema.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  if (data.name !== registryName) fail(`registry name ${registryName} does not match manifest name ${data.name}`);
  if (!Number.isSafeInteger(data.priority)) fail(`layer ${data.name} priority must be a safe integer`);
  const targets = new Map();
  for (const [id, definition] of Object.entries(data.targets || {})) {
    safeName(id, "target id");
    const target = { ...definition, id, layer: data.name };
    if (target.strategy === "native-include") {
      if (!target.app) fail(`native-include target ${id} must specify app zsh, git, or tmux`);
      if (target.path !== undefined) fail(`native-include target ${id} must not specify path`);
      target.path = path.join(STATE_ROOT, "native", id);
    } else {
      if (!target.path) fail(`target ${id} requires path`);
      if (target.app !== undefined) fail(`target ${id} app is only valid for native-include`);
      target.path = expandTarget(target.path);
    }
    if (["json-merge-patch", "json-patch"].includes(target.strategy)) {
      target.base ||= "empty";
      for (const pointer of target.preserve || []) parsePointer(pointer);
    } else if (target.base !== undefined || target.preserve !== undefined) fail(`target ${id} base/preserve require a JSON strategy`);
    if (target.level !== undefined && target.strategy !== "markdown-sections") fail(`target ${id} level requires the markdown-sections strategy`);
    targets.set(id, target);
  }
  const contributions = (data.contributions ?? []).map((item, index) => ({
    ...item, index, layer: data.name, priority: data.priority, path: sourcePath(root, item.path)
  }));
  return { name: data.name, priority: data.priority, root, targets, contributions };
}

export function loadLayers() {
  fs.mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
  const layers = [];
  for (const name of fs.readdirSync(REGISTRY).sort()) {
    safeName(name, "registered layer name");
    const entry = path.join(REGISTRY, name);
    let root;
    try { root = fs.realpathSync(entry); }
    catch (error) { fail(`broken registry entry ${name}: ${error.message}`); }
    if (!fs.statSync(root).isDirectory()) fail(`registered layer ${name} is not a directory`);
    layers.push(validateManifest(root, name));
  }
  layers.sort((a, b) => a.priority - b.priority || compareText(a.name, b.name));
  return layers;
}

export function composeRegistry(layers) {
  const targets = new Map();
  const targetPaths = new Map();
  for (const layer of layers) for (const [id, target] of layer.targets) {
    if (targets.has(id)) fail(`duplicate target definition ${id} in layers ${targets.get(id).layer} and ${layer.name}`);
    if (targetPaths.has(target.path)) fail(`target path collision between ${targetPaths.get(target.path)} and ${id}: ${target.path}`);
    targetPaths.set(target.path, id);
    targets.set(id, { ...target, contributions: [] });
  }
  for (const layer of layers) for (const contribution of layer.contributions) {
    const target = targets.get(contribution.target);
    if (!target) fail(`unknown target ${contribution.target} contributed by layer ${layer.name}`);
    target.contributions.push(contribution);
  }
  for (const target of targets.values()) if (target.strategy === "native-include") {
    const names = new Map();
    for (const contribution of target.contributions) {
      if (!contribution.name) fail(`native-include contribution to ${target.id} requires a name`);
      if (names.has(contribution.name)) fail(`duplicate native-include name ${contribution.name} for ${target.id}`);
      names.set(contribution.name, contribution.layer);
    }
  }
  return targets;
}
