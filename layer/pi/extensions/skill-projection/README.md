# Skill Projection

Projects an allowlisted subset of skills from installed-but-disabled marketplace plugins into Pi's native skill loader.

Configuration: `~/.pi/agent/skill-projection.json`. When the file is absent, the extension is an inactive no-op.

```json
{
  "version": 1,
  "plugins": {
    "plugin@marketplace": {
      "skills": {
        "skill-name": "model-visible",
        "another-skill": "manual-only"
      }
    }
  }
}
```

Exposure modes:

- `model-visible`: included in Pi's native `<available_skills>` system-prompt block and available through `/skill:<name>`.
- `manual-only`: omitted from `<available_skills>` but still available through native `/skill:<name>` expansion.

Only configured skills are projected. Newly added plugin skills remain absent until configured. The source marketplace plugin must remain installed at user scope with `enabled: false` so its other resources are not loaded.

Project marketplace state wins. If `.pi/marketplace/installed_plugins.json` or `.agents/marketplace/installed_plugins.json` contains an explicit entry for a configured plugin, the user projection is skipped for that plugin. Project-enabled plugins therefore load normally; project-disabled plugins remain disabled.

After changing configuration or marketplace versions, run `/reload`. Use `/skill-projection` to show current projections and warnings.
