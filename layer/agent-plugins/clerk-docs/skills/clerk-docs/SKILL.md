---
name: clerk-docs
description: >-
  Documentation system — don't use this unless explicitly instructed to use
  `clerk-docs`.
---

# clerk-docs

Read the project's own conventions first (`docs/README.md`, the doc map in
`CLAUDE.md`/`AGENTS.md`).

## Roles

Every doc plays exactly one of three roles:

- **Living**: current truth (spec, design, architecture, runbook, policy).
  Rewritten in place, never a changelog. The only docs cited as authority.
- **Working**: work with a status and an end (plan, issue, task queue).
  Revised freely while open; frozen or deleted when closed.
- **Record**: dated snapshot (research memo, decision, session log entry).
  Never edited, never cited as authority.

## Rules

- **Rewrite, don't append.** When truth changes, rewrite the living docs as if
  they had always been decided that way. A line that only makes sense as a delta
  from a prior version is a vestige: cut it. If dropping context feels
  wasteful, move it into a dated record. Records are the exception: never
  rewritten; when one is wrong or overtaken, add a new one and mark the old.
- **One fact, one place, mostly.** Give each fact one authoritative home and
  link to it; repeat it only where a reader would otherwise miss it, and keep
  the copy short. Rationale belongs with the decision, not in tasks; standing
  how-to belongs in a living doc, not in one that closes.
- **Every transient names its destination.** Plans say where they land;
  issues resolve into the spec or a plan and are then deleted (git keeps the
  trail); decisions are promoted out of log entries.
- **Link both ways.** A doc names what it came from and what consumed it:
  living docs cite the record behind a decision, records name what they
  informed, plans link their evidence and their destination. Discovery happens
  by following links, not by browsing directories.
- **Tests are the executable half of the spec.** Bind a new rule to a check
  when one exists, so a behavior change fails loudly.
- **The entry file is a map**: each doc with the question it answers, the
  workflow, and a pointer here. Persist context in the docs, not memory stores.

## Change flow

Match ceremony to stakes. Two independent questions:

- **Does the intent change?** Behavior, contract, look, or policy: update the
  living docs first, in the same change, then implement and verify. Refactors,
  bug fixes, and code explorations can jump straight into code and promote
  changes into the docs later.
- **Is it big enough to plan?** Multi-session, several docs, or real design
  choices: open a plan. Status line, intent, destination, a "You are here"
  block kept current for the next session, then only what is needed: why /
  what changes / impact, spec deltas (`ADDED` / `MODIFIED` / `REMOVED` against
  named sections, MODIFIED carrying full replacement text), design, tasks. On
  landing, apply the deltas, flip the status with a one-line outcome, and
  freeze or delete.

A spec is a behavior contract, not an implementation plan; if the code can
change without observable behavior changing, the detail belongs elsewhere.

## Capture

Before calling a change or session done:

1. Truth changed? Rewrite the living docs; check for vestiges.
2. Plan moved or landed? Update status and "You are here"; land the deltas.
3. Learned something that is not current truth? Dated research memo.
4. Decided something future-you would re-litigate? Decision record, or a
   sentence of rationale in the living doc if the project keeps none.
5. Found a problem you did not solve? File an issue: the problem and the
   evidence, not the fix.
6. A standing how-to appeared? Into procedures or the entry file now.
7. Session-log project? Append an entry, even if nothing was decided.
8. Anything new? Link it from what prompted it and from what it feeds.
9. Docs added or removed? Update the doc map.

Templates: `references/templates.md`. Setting up or auditing a project, and
the choices each project makes for itself: `references/adopting.md`.
