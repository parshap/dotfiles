import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { HOME, MANIFEST, NATIVE_APPS, REGISTRY, STATE_ROOT, SUPPORTED } from "./config.js";
import { parsePointer } from "./rfc.js";
import { compareText, fail, isObject, readJson, safeName } from "./util.js";

const NAME = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const targetsSchema = {
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
};
const contributionsSchema = {
  type: "array",
  items: {
    type: "object", required: ["target", "path"], additionalProperties: false,
    properties: {
      target: { type: "string", pattern: NAME },
      path: { type: "string", minLength: 1 }, name: { type: "string", pattern: NAME }
    }
  }
};
const schema = {
  type: "object",
  required: ["version", "name", "priority"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    name: { type: "string", pattern: NAME },
    priority: { type: "integer" },
    targets: targetsSchema,
    contributions: contributionsSchema,
    // A feature is a named capability: the targets it owns plus its
    // contributions to any target. A higher-priority layer can disable it.
    features: {
      type: "object",
      propertyNames: { pattern: NAME },
      additionalProperties: {
        type: "object", additionalProperties: false,
        properties: { targets: targetsSchema, contributions: contributionsSchema }
      }
    },
    disable: { type: "array", uniqueItems: true, items: { type: "string", pattern: NAME } }
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
  const stat = fs.statSync(real);
  if (!stat.isFile() && !stat.isDirectory()) fail(`contribution is not a file or directory: ${raw}`);
  return { path: real, directory: stat.isDirectory() };
}

function parseTarget(id, definition, layerName, feature) {
  safeName(id, "target id");
  const target = { ...definition, id, layer: layerName, ...(feature ? { feature } : {}) };
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
  return target;
}

export function validateManifest(root, registryName) {
  const data = readJson(path.join(root, MANIFEST), `manifest for ${registryName}`);
  if (!validateSchema(data)) fail(`invalid manifest for ${registryName}: ${validateSchema.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  if (data.name !== registryName) fail(`registry name ${registryName} does not match manifest name ${data.name}`);
  if (!Number.isSafeInteger(data.priority)) fail(`layer ${data.name} priority must be a safe integer`);
  // The layer's base targets and contributions come first, then each
  // feature's in declaration order; features only group, they do not nest.
  const groups = [{ feature: undefined, ...data }, ...Object.entries(data.features ?? {}).map(([feature, body]) => ({ feature, ...body }))];
  const targets = new Map();
  const contributions = [];
  for (const group of groups) {
    for (const [id, definition] of Object.entries(group.targets || {})) {
      if (targets.has(id)) fail(`duplicate target definition ${id} in layer ${data.name}`);
      targets.set(id, parseTarget(id, definition, data.name, group.feature));
    }
    for (const item of group.contributions ?? []) {
      const source = sourcePath(root, item.path);
      contributions.push({
        ...item, index: contributions.length, layer: data.name, priority: data.priority,
        path: source.path, directory: source.directory, ...(group.feature ? { feature: group.feature } : {})
      });
    }
  }
  return {
    name: data.name, priority: data.priority, root, targets, contributions,
    features: Object.keys(data.features ?? {}), disable: data.disable ?? []
  };
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

// Feature names are global across layers. Only a strictly higher-priority
// layer may disable a feature, and naming an unknown feature fails so a
// rename in the owning layer cannot silently re-enable it.
export function resolveFeatures(layers) {
  const features = new Map();
  for (const layer of layers) for (const name of layer.features) {
    if (features.has(name)) fail(`duplicate feature ${name} in layers ${features.get(name).layer} and ${layer.name}`);
    features.set(name, { name, layer: layer.name, priority: layer.priority, disabledBy: null });
  }
  for (const layer of layers) for (const name of layer.disable) {
    const feature = features.get(name);
    if (!feature) fail(`layer ${layer.name} disables unknown feature ${name}`);
    if (feature.priority >= layer.priority) fail(`layer ${layer.name} cannot disable feature ${name} of layer ${feature.layer}; only a higher-priority layer may disable a feature`);
    feature.disabledBy ??= layer.name;
  }
  return features;
}

export function composeRegistry(layers) {
  const features = resolveFeatures(layers);
  const disabled = (item) => Boolean(item.feature && features.get(item.feature).disabledBy);
  const targets = new Map();
  const disabledTargets = new Map();
  const targetPaths = new Map();
  for (const layer of layers) for (const [id, target] of layer.targets) {
    if (targets.has(id) || disabledTargets.has(id)) fail(`duplicate target definition ${id} in layers ${(targets.get(id) ?? disabledTargets.get(id)).layer} and ${layer.name}`);
    if (disabled(target)) { disabledTargets.set(id, target); continue; }
    if (targetPaths.has(target.path)) fail(`target path collision between ${targetPaths.get(target.path)} and ${id}: ${target.path}`);
    targetPaths.set(target.path, id);
    targets.set(id, { ...target, contributions: [] });
  }
  // One target inside another (a file beneath a directory symlink) would be
  // written through the other's output.
  for (const [outer, outerId] of targetPaths) for (const [inner, innerId] of targetPaths) {
    if (inner.startsWith(`${outer}${path.sep}`)) fail(`target ${innerId} (${inner}) lies inside target ${outerId} (${outer})`);
  }
  for (const layer of layers) for (const contribution of layer.contributions) {
    if (disabled(contribution)) continue;
    const target = targets.get(contribution.target);
    if (!target) {
      const off = disabledTargets.get(contribution.target);
      if (off) fail(`layer ${layer.name} contributes to target ${off.id} of disabled feature ${off.feature}`);
      fail(`unknown target ${contribution.target} contributed by layer ${layer.name}`);
    }
    if (contribution.directory && target.strategy !== "symlink") fail(`target ${target.id} (${target.strategy}) requires file contributions; ${contribution.path} is a directory`);
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
