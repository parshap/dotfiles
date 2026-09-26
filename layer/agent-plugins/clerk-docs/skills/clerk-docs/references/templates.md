# Templates

Starting points, not forms. Keep only the sections a project needs; a
template section that stays empty is a vestige. Names, dates, and status
carriers follow the project's contract; the defaults shown are the skill's.

## Contract: `docs/README.md`

```markdown
# Documentation

Documentation lives here in three roles: living docs state current truth and are
rewritten in place; working docs carry a status and an end; records are dated
and never edited. Rules and the capture checklist: the `clerk-docs` skill.

## Living (`docs/*.md`)

- [spec.md](spec.md): what the system does
- [architecture.md](architecture.md): how it is built
- [ux.md](ux.md): how it looks and feels   <!-- products with a UI -->

Each fact lives in exactly one of these. When truth changes, rewrite as if it
had always been decided that way; if dropping context feels wasteful, move it
to `research/`. Where a rule rests on a decision or a memo, link it; records
link back to what consumed them.

## Plans (`docs/plans/`)

- `YYYY-MM-topic.md`, the month it started. First line after the title:
  `Status: draft | active | done | abandoned`.
- While open: current intent only, revised in place. On close: flip the status,
  add a one-line outcome linking to what it produced, freeze. Never cite a
  frozen plan as current truth.

## Research (`docs/research/`)

- `YYYY-MM-topic.md`. Starts with a blockquote banner: what it was for, what
  came of it (settled / deferred / rejected), where the decision now lives.
- Never updated, never deleted, never cited as authority.

## Issues (`docs/issues/`)   <!-- include when problems outlive a plan -->

- `topic.md`, undated. Banner: `open — action needed` or `open — further
  research`, one line on what it is, and that it frames the problem only.
- Resolves into the spec or a plan, then is deleted or converted to research.
```

A project that layers by edit semantics replaces the living section with a
table of `Doc | Semantics | Question it answers` (maintained / deliberate
revision only / disposable / append-only / immutable) and adds the placement rules
that follow from it: rationale never lives in tasks, procedures never live in
things that close, decisions are promoted out of log entries.

## Entry file sections (`CLAUDE.md` / `AGENTS.md`)

```markdown
## Documentation

- **`docs/spec.md`**: what the system does
- **`docs/architecture.md`**: how it is built
- **`docs/plans/`**: open work, one file per plan
- **`docs/research/`**: dated records of investigation; not authority
- **`CLAUDE.md`** (this file): how to work here

This project uses the `clerk-docs` skill for documentation; per-directory rules are in `docs/README.md`. Persist context to these files rather than in separate memory stores.

## Workflow

1. **Update documentation.** Once the intent of a change is known, update the living docs first. Refactors, bug fixes, and explorations may go code-first and promote into `docs/` afterwards. Non-trivial work gets a plan in `docs/plans/`.
2. **Implement**, with tests or another form of verification.
3. **Verify**: <project's lint / typecheck / test / build commands>.
4. **Capture**: before finishing, run the `clerk-docs` capture checklist.
```

Projects that would benefit from a session log can add a step such as "every
substantive session ends with the session-filing procedure", linking to it.

## Plan (working)

```markdown
# <Intent in one line>

Status: draft

<One paragraph: what this is for and why now.> Lands in [spec §3](../spec.md#3-x)
and [architecture §7](../architecture.md#7-y). Evidence:
[research/YYYY-MM-topic.md](../research/YYYY-MM-topic.md).

## You are here

<Current state in two or three sentences. Next step. How to run and verify.
Rewritten in place; a fresh session resumes from this block alone.>

## Why

## What changes

- ... (mark **BREAKING** where applicable)

## Impact

<Affected code, data, APIs, dependencies, operations.>

## Spec deltas

### MODIFIED: spec §1.3 Shop list
<Full replacement text of the section.>

### ADDED: spec §2.7 Pantry
<New section text.>

### REMOVED: spec §2.2 Manual list
**Reason:** ... **Migration:** ...

## Design   <!-- only if cross-cutting, new dependency/data model, security/perf/migration complexity, or an ambiguity to settle -->

Context · Goals / non-goals · Decisions · Risks and trade-offs · Open questions

## Tasks

- [ ] 1.1 ... (verify: `npm test` green on `x.test.ts`)
- [ ] 1.2 ...
```

On landing, the first lines become:

```markdown
Status: done — landed as spec §1.3 and §2.7, architecture §7.2; shipped in `abc123`.
```

## Research memo (record)

```markdown
# <Topic>

> **Status: settled (YYYY-MM-DD).** Prompted by [plan](../plans/YYYY-MM-x.md).
> Investigated <question> for <purpose>. Outcome: <adopted / deferred until …
> / rejected because …>; informs [spec §4](../spec.md#4-x). Findings below
> are as of the date and are not updated.

## Question
## Findings
## What we did with it
## Shelf life   <!-- which findings are timeless vs dated -->
## Sources
```

Frontmatter variant for projects that read fields; `prompted_by` and
`informs` carry the same two links as the banner:

```yaml
---
date: YYYY-MM-DD
status: current | superseded-by: <file> | promoted
prompted_by: <log entry, plan, task, or question>
informs: [links to what consumed it]
---
```

## Decision record (record)

For a call future-you would otherwise re-litigate. Smaller calls stay in a
sentence of rationale in the living doc or in the session log.

```markdown
---
date: YYYY-MM-DD
status: active | superseded-by: <file>
prompted_by: <log entry, plan, or issue>
informs: [living docs or plans this changed]
---

# <Decision stated as a sentence>

## Context      <!-- what forced the decision; link the research behind it -->
## Decision
## Alternatives rejected, and why
## Consequences
## Review trigger   <!-- what would reopen this -->
```

Immutable once made; supersede with a new record, never edit. Keep an index in
the directory README.

## Issue (working, problem-only)

```markdown
# <Topic>

> **open — action needed** (raised YYYY-MM-DD). <One line on what this is.>
> Frames the problem only; whoever picks it up decides the fix.

## Situation
## What is wrong or uncertain
## Evidence
## When it bites
## Related   <!-- spec sections, plans, research -->
```

## Session log entry (record)

For projects where deliberation is the product. Thin: it records that
deliberation happened and links to its products.

```markdown
---
date: YYYY-MM-DD
type: exploratory | decision | review | execution
---

# <Topic>

## Context
## Discussion       <!-- including options rejected and why -->
## Decisions        <!-- links to decisions/; or "none — exploratory" -->
## Deferred         <!-- and until when, or on what trigger -->
## Open questions
## Actions spawned
```

## Status banners

Prose banner (default):

```markdown
> **Status: deferred (2026-07).** Explored X for Y; parked until Z. Decision: [spec §2](../spec.md#2).
```

Plan status line: `Status: draft | active | done | abandoned`, first line after
the title, followed by a one-line outcome once closed.

Frontmatter: `date`, `status`, and `superseded-by` are the shared vocabulary;
add fields only when something reads them.
