import fastJsonPatch from "fast-json-patch";
import jsonMergePatch from "json-merge-patch";
import { clone, fail, hasOwn, isObject, setOwn, UserError } from "./util.js";

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => deepEqual(value, b[i]));
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, i) => key === bKeys[i] && deepEqual(a[key], b[key]));
  }
  return false;
}

export function parsePointer(pointer) {
  if (typeof pointer !== "string") fail("JSON pointer must be a string");
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) fail(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((token) => {
    if (/~(?![01])/u.test(token)) fail(`invalid JSON pointer escape: ${pointer}`);
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

function arrayIndex(token, length, allowEnd = false, allowDash = false) {
  if (token === "-" && allowDash) return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) fail(`invalid array index: ${token}`);
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index < 0 || index > (allowEnd ? length : length - 1)) fail(`array index out of bounds: ${token}`);
  return index;
}

function locate(document, tokens, { parent = false } = {}) {
  const stop = parent ? tokens.length - 1 : tokens.length;
  let value = document;
  for (let i = 0; i < stop; i++) {
    const token = tokens[i];
    if (Array.isArray(value)) value = value[arrayIndex(token, value.length)];
    else if (isObject(value) && Object.prototype.hasOwnProperty.call(value, token)) value = value[token];
    else fail(`JSON pointer path does not exist at /${tokens.slice(0, i + 1).join("/")}`);
  }
  return value;
}

function getPointer(document, pointer) {
  const tokens = Array.isArray(pointer) ? pointer : parsePointer(pointer);
  return tokens.length ? locate(document, tokens) : document;
}

function hasPointer(document, pointer) {
  try { getPointer(document, pointer); return true; } catch { return false; }
}

function addPointer(document, tokens, value) {
  if (!tokens.length) return clone(value);
  const parent = locate(document, tokens, { parent: true });
  const token = tokens.at(-1);
  if (Array.isArray(parent)) parent.splice(arrayIndex(token, parent.length, true, true), 0, clone(value));
  else if (isObject(parent)) setOwn(parent, token, clone(value));
  else fail("JSON Patch add parent is not a container");
  return document;
}

function removePointer(document, tokens) {
  if (!tokens.length) return undefined;
  const parent = locate(document, tokens, { parent: true });
  const token = tokens.at(-1);
  if (Array.isArray(parent)) parent.splice(arrayIndex(token, parent.length), 1);
  else if (isObject(parent) && Object.prototype.hasOwnProperty.call(parent, token)) delete parent[token];
  else fail(`JSON Patch remove path does not exist: /${tokens.join("/")}`);
  return document;
}

function replacePointer(document, tokens, value) {
  if (!tokens.length) return clone(value);
  getPointer(document, tokens);
  const parent = locate(document, tokens, { parent: true });
  const token = tokens.at(-1);
  if (Array.isArray(parent)) parent[arrayIndex(token, parent.length)] = clone(value);
  else setOwn(parent, token, clone(value));
  return document;
}

function applyJsonPatchFallback(document, operations) {
  if (!Array.isArray(operations)) fail("JSON Patch contribution must be an array");
  let result = clone(document);
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!isObject(op) || typeof op.op !== "string" || typeof op.path !== "string") fail(`invalid JSON Patch operation ${i}`);
    const tokens = parsePointer(op.path);
    try {
      switch (op.op) {
        case "add":
          if (!("value" in op)) fail("add requires value");
          result = addPointer(result, tokens, op.value); break;
        case "remove": result = removePointer(result, tokens); break;
        case "replace":
          if (!("value" in op)) fail("replace requires value");
          result = replacePointer(result, tokens, op.value); break;
        case "move": {
          if (typeof op.from !== "string") fail("move requires from");
          const from = parsePointer(op.from);
          if (tokens.length > from.length && from.every((x, j) => x === tokens[j])) fail("cannot move a value into one of its children");
          const value = clone(getPointer(result, from));
          result = removePointer(result, from);
          result = addPointer(result, tokens, value);
          break;
        }
        case "copy": {
          if (typeof op.from !== "string") fail("copy requires from");
          result = addPointer(result, tokens, getPointer(result, parsePointer(op.from)));
          break;
        }
        case "test":
          if (!("value" in op) || !deepEqual(getPointer(result, tokens), op.value)) fail(`JSON Patch test failed at ${op.path}`);
          break;
        default: fail(`unsupported JSON Patch operation: ${op.op}`);
      }
    } catch (error) {
      if (error instanceof UserError && !error.message.startsWith("JSON Patch operation")) error.message = `JSON Patch operation ${i}: ${error.message}`;
      throw error;
    }
  }
  if (result === undefined) fail("JSON Patch removed the root without replacing it");
  return result;
}

function mergePatchFallback(target, patch) {
  if (!isObject(patch)) return clone(patch);
  let result = isObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else setOwn(result, key, mergePatchFallback(hasOwn(result, key) ? result[key] : undefined, value));
  }
  return result;
}

export function preservePointer(result, live, pointer) {
  const tokens = parsePointer(pointer);
  if (!hasPointer(live, tokens)) return result;
  const value = clone(getPointer(live, tokens));
  if (!tokens.length) return value;
  let cursor = result;
  let liveCursor = live;
  if (!isObject(cursor) && !Array.isArray(cursor)) fail(`cannot preserve ${pointer}: composed root is not a container`);
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const liveNext = Array.isArray(liveCursor)
      ? liveCursor[arrayIndex(token, liveCursor.length)]
      : liveCursor[token];
    const emptyContainer = () => Array.isArray(liveNext) ? [] : {};
    if (Array.isArray(cursor)) {
      const index = arrayIndex(token, cursor.length, true);
      if (index === cursor.length) cursor.push(emptyContainer());
      else if (!isObject(cursor[index]) && !Array.isArray(cursor[index])) cursor[index] = emptyContainer();
      cursor = cursor[index];
    } else {
      if (!hasOwn(cursor, token) || (!isObject(cursor[token]) && !Array.isArray(cursor[token]))) {
        setOwn(cursor, token, emptyContainer());
      }
      cursor = cursor[token];
    }
    liveCursor = liveNext;
  }
  const last = tokens.at(-1);
  if (Array.isArray(cursor)) {
    const index = arrayIndex(last, cursor.length, true);
    if (index === cursor.length) cursor.push(value); else cursor[index] = value;
  } else setOwn(cursor, last, value);
  return result;
}


const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);
const hasDangerousMember = (value) => Array.isArray(value)
  ? value.some(hasDangerousMember)
  : isObject(value) && Object.keys(value).some((key) => dangerousKeys.has(key) || hasDangerousMember(value[key]));
const pointerIsDangerous = (pointer) => parsePointer(pointer).some((token) => dangerousKeys.has(token));

/**
 * Apply RFC 6902. fast-json-patch handles validated ordinary operations,
 * including arrays and root replacement. Prototype-sensitive JSON members use
 * the strict compatibility path so they remain literal own properties.
 */
export function applyJsonPatch(document, operations) {
  if (!Array.isArray(operations)) fail("JSON Patch contribution must be an array");
  let requiresCompatibility = hasDangerousMember(document);
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (!isObject(operation) || typeof operation.op !== "string" || typeof operation.path !== "string") fail(`invalid JSON Patch operation ${index}`);
    if (!["add", "remove", "replace", "move", "copy", "test"].includes(operation.op)) fail(`unsupported JSON Patch operation: ${operation.op}`);
    parsePointer(operation.path);
    if (["add", "replace", "test"].includes(operation.op) && !hasOwn(operation, "value")) fail(`JSON Patch operation ${index}: ${operation.op} requires value`);
    if (["move", "copy"].includes(operation.op)) {
      if (typeof operation.from !== "string") fail(`JSON Patch operation ${index}: ${operation.op} requires from`);
      const from = parsePointer(operation.from);
      if (operation.op === "move") {
        const destination = parsePointer(operation.path);
        if (destination.length > from.length && from.every((token, part) => token === destination[part])) {
          fail(`JSON Patch operation ${index}: cannot move a value into one of its children`);
        }
      }
    }
    requiresCompatibility ||= pointerIsDangerous(operation.path) || hasDangerousMember(operation.value);
    if (typeof operation.from === "string") requiresCompatibility ||= pointerIsDangerous(operation.from);
  }
  if (requiresCompatibility) return applyJsonPatchFallback(document, operations);

  try {
    return fastJsonPatch.applyPatch(clone(document), operations, true, false, true).newDocument;
  } catch (error) {
    const index = Number.isSafeInteger(error.index) ? ` operation ${error.index}` : "";
    fail(`JSON Patch${index}: ${error.message}`);
  }
}

/** Apply RFC 7396, retaining literal prototype-sensitive JSON member names. */
export function mergePatch(target, patch) {
  if (hasDangerousMember(target) || hasDangerousMember(patch)) return mergePatchFallback(target, patch);
  return jsonMergePatch.apply(clone(target), clone(patch));
}
