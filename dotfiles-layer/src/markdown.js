import fs from "node:fs";
import { fail } from "./util.js";

// A markdown-sections target composes ATX-heading sections from ordered
// contributions: a section whose heading text already appeared replaces the
// earlier one in place, otherwise it is appended. Text before the first
// section heading is the preamble and behaves like a section that always
// sorts first. Fenced code blocks never start a section.
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
export const PREAMBLE = Symbol("preamble");

export function splitSections(text, level, description) {
  const groups = [{ key: PREAMBLE, lines: [] }];
  let fence = null;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.slice(fenceMatch[0].length).trim() === "") fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else {
      const heading = line.match(HEADING);
      if (heading && heading[1].length <= level) {
        const key = (heading[2] || "").replace(/(^|[ \t])#+$/u, "").trim();
        if (!key) fail(`${description}: section heading without text: ${line.trim()}`);
        if (groups.some((group) => group.key === key)) fail(`${description}: duplicate section heading: ${key}`);
        groups.push({ key, lines: [] });
      }
    }
    groups.at(-1).lines.push(line);
  }
  return groups
    .map((group) => ({ key: group.key, text: group.lines.join("\n").replace(/^\n+|\n+$/gu, "") }))
    .filter((section) => section.key !== PREAMBLE || section.text !== "");
}

// Returns the composed content plus, per contribution, which of its sections
// survived and which layer replaced the others.
export function composeMarkdownSections(target) {
  const level = target.level ?? 2;
  const parsed = target.contributions.map((contribution) => ({
    contribution,
    sections: splitSections(fs.readFileSync(contribution.path, "utf8"), level, `contribution ${contribution.path}`),
  }));
  // Insertion order fixes each section's position at its first appearance.
  const winners = new Map();
  for (const entry of parsed) for (const section of entry.sections) winners.set(section.key, { text: section.text, entry });
  const ordered = [...winners.entries()].sort((a, b) => (a[0] === PREAMBLE ? -1 : 0) - (b[0] === PREAMBLE ? -1 : 0));
  const content = Buffer.from(`${ordered.map(([, winner]) => winner.text).join("\n\n")}\n`);
  const report = parsed.map((entry) => ({
    contribution: entry.contribution,
    sections: entry.sections.map((section) => {
      const winner = winners.get(section.key).entry;
      return {
        name: section.key === PREAMBLE ? "(preamble)" : section.key,
        replacedBy: winner === entry ? null : winner.contribution.layer,
      };
    }),
  }));
  return { content, report };
}
