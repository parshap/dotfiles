import fastJsonPatch from "fast-json-patch";
import jsonMergePatch from "json-merge-patch";
import { clone, fail, hasOwn, isObject, setOwn } from "./util.js";

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

function removeMaskedPointer(document, tokens) {
  if (!tokens.length) return null;
  const stack = [];
  let cursor = document;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (Array.isArray(cursor)) {
      const position = arrayIndex(token, cursor.length);
      stack.push({ parent: cursor, key: position, array: true });
      cursor = cursor[position];
    } else if (isObject(cursor) && hasOwn(cursor, token)) {
      stack.push({ parent: cursor, key: token, array: false });
      cursor = cursor[token];
    } else return document;
  }

  const last = tokens.at(-1);
  if (Array.isArray(cursor)) cursor[arrayIndex(last, cursor.length)] = null;
  else if (isObject(cursor) && hasOwn(cursor, last)) delete cursor[last];
  else return document;

  // If a preserved value was the only reason an object path existed, remove
  // the now-empty ancestors so "absent" and "present only at this pointer"
  // normalize to the same controlled digest.
  for (let index = stack.length - 1; index >= 0; index--) {
    const { parent, key, array } = stack[index];
    const child = parent[key];
    if (!isObject(child) || Object.keys(child).length > 0) break;
    if (array) parent[key] = null;
    else delete parent[key];
  }
  return document;
}

export function maskPointers(value, pointers) {
  let result = clone(value);
  for (const pointer of pointers) result = removeMaskedPointer(result, parsePointer(pointer));
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
const assertSafeMembers = (value, description) => {
  if (hasDangerousMember(value)) fail(`${description} contains a prototype-sensitive member name (__proto__, constructor, or prototype), which is not supported`);
};

/**
 * Apply RFC 6902 via fast-json-patch, which handles validated operations,
 * including arrays and root replacement. Documents, pointers, and values
 * containing prototype-sensitive member names are rejected outright rather
 * than special-cased.
 */
export function applyJsonPatch(document, operations) {
  if (!Array.isArray(operations)) fail("JSON Patch contribution must be an array");
  assertSafeMembers(document, "JSON Patch document");
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (!isObject(operation) || typeof operation.op !== "string" || typeof operation.path !== "string") fail(`invalid JSON Patch operation ${index}`);
    if (!["add", "remove", "replace", "move", "copy", "test"].includes(operation.op)) fail(`unsupported JSON Patch operation: ${operation.op}`);
    if (pointerIsDangerous(operation.path)) fail(`JSON Patch operation ${index}: prototype-sensitive member name in path: ${operation.path}`);
    if (["add", "replace", "test"].includes(operation.op) && !hasOwn(operation, "value")) fail(`JSON Patch operation ${index}: ${operation.op} requires value`);
    if (hasDangerousMember(operation.value)) fail(`JSON Patch operation ${index}: value contains a prototype-sensitive member name (__proto__, constructor, or prototype)`);
    if (["move", "copy"].includes(operation.op)) {
      if (typeof operation.from !== "string") fail(`JSON Patch operation ${index}: ${operation.op} requires from`);
      if (pointerIsDangerous(operation.from)) fail(`JSON Patch operation ${index}: prototype-sensitive member name in from: ${operation.from}`);
      if (operation.op === "move") {
        const destination = parsePointer(operation.path);
        const from = parsePointer(operation.from);
        if (destination.length > from.length && from.every((token, part) => token === destination[part])) {
          fail(`JSON Patch operation ${index}: cannot move a value into one of its children`);
        }
      }
    }
  }

  try {
    return fastJsonPatch.applyPatch(clone(document), operations, true, false, true).newDocument;
  } catch (error) {
    const index = Number.isSafeInteger(error.index) ? ` operation ${error.index}` : "";
    fail(`JSON Patch${index}: ${error.message}`);
  }
}

/** Apply RFC 7396. Prototype-sensitive member names are rejected outright. */
export function mergePatch(target, patch) {
  assertSafeMembers(target, "JSON Merge Patch target");
  assertSafeMembers(patch, "JSON Merge Patch contribution");
  return jsonMergePatch.apply(clone(target), clone(patch));
}
