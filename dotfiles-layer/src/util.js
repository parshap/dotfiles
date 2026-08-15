import crypto from "node:crypto";
import fs from "node:fs";

export class UserError extends Error {}
export const fail = (message) => { throw new UserError(message); };
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const setOwn = (object, key, value) => Object.defineProperty(object, key, {
  value,
  writable: true,
  enumerable: true,
  configurable: true,
});
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const exists = (file) => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

export function safeName(name, what = "name") {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail(`invalid ${what}: ${String(name)}`);
  return name;
}

export function readJson(file, description = file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { fail(`cannot read ${description}: ${error.message}`); }
  try { return JSON.parse(text); }
  catch (error) { fail(`malformed JSON in ${description}: ${error.message}`); }
}
