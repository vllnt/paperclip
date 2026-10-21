---
title: Writing a Skill
summary: SKILL.md format and best practices
---

Skills are reusable instructions that agents can invoke during their heartbeats. They're markdown files that teach agents how to perform specific tasks.

## Skill Structure

A skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```
skills/
└── my-skill/
    ├── SKILL.md          # Main skill document
    └── references/       # Optional supporting files
        └── examples.md
```

## SKILL.md Format

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic — the agent reads this to decide
  whether to load the full skill content.
---

# My Skill

Detailed instructions for the agent...
```

### Frontmatter Fields

- **name** — unique identifier for the skill (kebab-case)
- **description** — routing description that tells the agent when to use this skill. Write it as decision logic, not marketing copy.

## How Skills Work at Runtime

1. Agent sees skill metadata (name + description) in its context
2. Agent decides whether the skill is relevant to its current task
3. If relevant, agent loads the full SKILL.md content
4. Agent follows the instructions in the skill

This keeps the base prompt small — full skill content is only loaded on demand.

## Best Practices

- **Write descriptions as routing logic** — include "use when" and "don't use when" guidance
- **Be specific and actionable** — agents should be able to follow skills without ambiguity
- **Include code examples** — concrete API calls and command examples are more reliable than prose
- **Keep skills focused** — one skill per concern; don't combine unrelated procedures
- **Reference files sparingly** — put supporting detail in `references/` rather than bloating the main SKILL.md
- **Treat the SKILL.md body as a cost of every turn** — once a skill is loaded, its whole body is re-read on every turn of the run. Keep the body to what every run needs (the loop, the hot routes, the critical rules). Move anything an agent needs only in one area to a file in `references/`, and say in the body when to read it

## The Bundled `paperclip` Skill: a Small Core

The bundled `paperclip` skill follows the rule above strictly. `skills/paperclip/SKILL.md` is the core and stays within 20,000 characters: the heartbeat loop, the hot routes, the critical rules and a **Reference index** that says when to read each file in `skills/paperclip/references/`. Every other section (interactions, decisions, approvals, monitors, planning, secrets, chat, and the rest) is a reference that the agent reads in full before it acts in that area.

When you change this skill:

- Add detail to the matching reference, not to the core. Add a rule to the core only if every run needs it.
- Give a new reference file one line in the **Reference index** of `SKILL.md`. The line names the file and says when to read it.
- Use relative links inside the skill (`references/x.md` from the core, `x.md` between references). Write a command path relative to the skill directory, as `scripts/paperclip-upload-artifact.sh` is.
- Add the new file to `skillSources` in `packages/paperclip-runner/spec/capability/source-contract.json`, then regenerate the capability contract (see `packages/paperclip-runner/package.json`, scripts `generate:capability-contract` and `check:capability-inventory`).
- `server/src/__tests__/paperclip-skill-core.test.ts` checks the size budget, that every reference is indexed, and that every local link and anchor resolves.

## Skill Injection

Adapters are responsible for making skills discoverable to their agent runtime. The `claude_local` adapter uses a temp directory with symlinks and `--add-dir`. The `codex_local` adapter uses the global skills directory. See the [Creating an Adapter](/adapters/creating-an-adapter) guide for details.
