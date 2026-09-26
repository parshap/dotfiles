# clerk-docs

An [Agent Plugin](https://agent-plugins.org) carrying one skill, `clerk-docs`: a
documentation system for projects worked with AI agents. It fixes three
document roles (living truth, working docs, dated record), the rules that keep
them true, a loose spec-driven change flow, and an end-of-work capture checklist.

- [`skills/clerk-docs/SKILL.md`](skills/clerk-docs/SKILL.md): the system
- [`references/templates.md`](skills/clerk-docs/references/templates.md): contract, entry-file sections, plan, memo, decision, issue, log entry
- [`references/adopting.md`](skills/clerk-docs/references/adopting.md): setting up or auditing a project, and the choices each project makes for itself

## Opting a project in

The skill never activates on its own. A project opts in from its
`CLAUDE.md`/`AGENTS.md`, which names the system, maps the project's docs, and
states the workflow. The map and workflow are the project's own; the skill
supplies the roles, rules, and capture checklist behind them. This is how a recipe
app does it:

```markdown
## Documentation map (source of truth per layer)

This project uses the `clerk-docs` documentation system.

- **`docs/SPEC.md`** — Functional spec — *what* the app does
- **`docs/DESIGN.md`** — The design — *how it looks and feels*
- **`docs/ARCHITECTURE.md`** — Technical architecture — *how it's built*
- **`docs/plans/`** — Working plans; archive or delete once landed
- **`CLAUDE.md`** (this file) — How to work in this project

Persist durable learnings and working preferences in these files rather than in separate memory stores.

## Workflow

1. **Update documentation.** Once the intent of the change is known, update relevant documentation in `docs/` first. Functional changes should generally involve `docs/SPEC.md`. Refactors, bug fixes, or code explorations can jump straight into code and promote changes into `docs/` later.
2. **Implement the change**, with tests or other verification. For sufficiently complex changes, enter plan mode first.
3. **Run static verification**: `npm run lint`, `npm run typecheck`, `npm run test`.
4. **Capture.** Before finishing, run the `clerk-docs` capture checklist.
5. **Commit changes** as you go in logical increments.
```

Projects with more record-keeping add the directories that need it (research,
issues, decisions, a session log) and a `docs/README.md` stating each
directory's naming and lifecycle; `references/adopting.md` covers the choices.

## Installing

The plugin is a plain directory; any client that reads `plugin.json` and
`skills/` can load it.

- **Pi**: `pi install /path/to/clerk-docs`, or add the path to `packages` in
  settings. Pi loads local packages in place.
- **Claude Code**: `claude plugin marketplace add parshap/dotfiles` then
  `claude plugin install clerk-docs@dotfiles`. Claude Code copies marketplace
  plugins into its cache, so a local checkout is better loaded in place by
  linking `skills/clerk-docs` into `~/.claude/skills/`, or with
  `claude --plugin-dir /path/to/clerk-docs` for one session.
