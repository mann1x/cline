# Built-in skills

The skills that ship with Cerebriline: the extension, the CLI and the SDK all
carry this folder. One folder per skill, each with a `SKILL.md`.

- `name` and `description` in the frontmatter are required here. The
  description is all the model sees when it decides whether to load the skill.
- `disabled: true` means the skill ships turned off. That is only the default:
  the user's choice is kept in the global settings (`bundledSkills`), because
  an update replaces these files.
- A skill of the same name in the user's own or the workspace's skills folder
  replaces the built-in one.

Each skill here is listed in `docs/customization/skills.mdx` under "Built-in Skills": add a row there when adding a folder here.
