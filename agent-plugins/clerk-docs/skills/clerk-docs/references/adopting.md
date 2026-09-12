# Adopting the system in a project

For setting up a fresh project, auditing one that has drifted, or migrating an
existing docs tree. The outcome is a contract (`docs/README.md` plus the entry
file's doc map and workflow) that the capture checklist can be run against.

## 1. Inventory

List every prose document in the repo, including the entry file, READMEs,
`plans/`, `notes/`, wiki exports, and anything under `docs/`. For each, answer:

- Which role is it behaving as: living, working, or record?
- Which role should it be? Mismatches are the findings: a spec with a history
  section, a plan cited as truth, a "notes" file that is really three research
  memos and one issue, a decision buried in a commit message.
- Does the fact it holds live anywhere else? Duplication is what drifts.

## 2. Choose the contract

The roles and rules are fixed; each project decides the rest. Defaults apply
when unstated.

| Knob | Options | Default | Choose otherwise when |
|---|---|---|---|
| Living split | by concern (what / look / how) · by edit semantics (who may change it, when) | concern | one repo holds standing policy beside ongoing deliberation |
| Records kept | research · decisions · session log · none | research | decisions: a choice has been re-litigated once; log: deliberation is itself the product and there is no diff to gate on |
| Capture trigger | per change · per session | per change | there is no diff to gate on |
| Open problems | "You are here" block in the plan · issues (problem-only, undated) · task queue | plan block | problems outlive a single plan |
| Status carrier | prose paragraph · blockquote banner · YAML frontmatter | blockquote banner | templates or tooling read the fields |
| Date precision | none · `YYYY-MM-` · `YYYY-MM-DD-` | `YYYY-MM-` | several records land per month |

Formality tracks how much of the project's value sits in its docs rather than
its code. Four undated docs and no records is a complete system for a small
app. Do not add fields nothing reads.

## 3. Write the contract

- `docs/README.md` from the template in `templates.md`: one section per role
  the project keeps, each stating filename pattern, required banner or
  frontmatter, what happens on resolution, and whether it may be cited.
- The entry file's **Documentation** and **Workflow** sections from the
  template, mapping each doc to the question it answers and naming the
  verification commands. Keep the entry file near 150 lines; move anything
  longer into the doc it belongs to.
- A README in any directory that holds a role, even if it repeats one line of
  the contract. Directories with no README become dumping grounds.

## 4. Migrate

Work through the inventory findings:

- Move misfiled content to its role. A history section in a spec becomes a
  dated research memo, or is cut. A decision in a plan becomes a sentence of
  rationale in the living doc, or a decision record.
- Apply the rewrite rule to every living doc: remove deltas, "previously",
  "we used to", and comparisons to superseded options. Move salvageable
  context into records.
- Give every working doc a status and a destination. Close what is done. Give
  every record a banner or frontmatter.
- Fix links so records are cited by their consumers and living docs never cite
  a record as authority.
- Commit the migration as its own change, separate from any content edits.

## 5. Verify the loop closes

Before finishing, run the capture checklist from `SKILL.md` against the
migration itself: the doc map is current, directory READMEs exist, no living
doc contains a vestige, and the workflow section names the verification
commands the project actually has. The first real change after adoption is
the test; if the checklist cannot be answered from the contract, the contract
is incomplete.
