# Where this skill goes

`SKILL.md` is the [Anthropic Agent Skills][skills] format — YAML frontmatter plus
a markdown body. **No Microsoft product ingests a `SKILL.md` file directly.**
There is no "upload skill" button in Copilot Studio, and looking for one will
waste an afternoon.

What the format gives you is a single versioned definition of the behaviour that
drops into each platform's own instruction field. Below is where, for each.

[skills]: https://code.claude.com/docs/en/skills

---

## Copilot Studio

Copilot Studio agents take a free-text instruction prompt. The skill body is that
prompt.

1. **Copilot Studio → your agent → Overview → Instructions.**
2. Paste **everything below the closing `---` of the frontmatter**. Leave the
   frontmatter out — `name` and `description` are Agent Skills metadata and mean
   nothing here.
3. Paste the contents of `reference/item-constants.md` at the end, under a
   heading `## Item constants`. Copilot Studio has no progressive disclosure, so
   a referenced file is a file it never reads. Flatten it in.
4. **Knowledge → Add knowledge → SharePoint**, and point it at the purchase order
   folder only.
5. **Settings → Generative AI → Moderation: High.** This tightens how far the
   model will go beyond its sources, which is the behaviour this skill is built
   around.
6. Turn **general knowledge off** if the toggle is available. There is nothing
   outside your documents that should reach a tracker row.

### If you get a Copilot Studio licence with actions

The skill is written for the read-and-report shape: the agent produces a row and
a person pastes it. If you later add a Power Automate action that writes to the
workbook, **the four formula columns become the whole problem** — an automated
write to column S breaks the running balance for every row beneath it.

Any write action must: fill down from the previous row first, then set only the
value columns by name, never by index, and never touch I, K, S or T. Add that
constraint to the instructions before you enable the action, not after.

## Microsoft 365 Copilot — Agent Builder

Same content, tighter box.

1. **Create agent → Configure** (not Describe, which rewrites what you paste).
2. **Name:** `AMI PO Reader`
3. **Description:** the `description` line from the frontmatter, trimmed to fit.
4. **Instructions:** the body, plus the **short form** of the constants from
   `reference/item-constants.md` — not the full table. See the sizes below.
5. **Knowledge:** the purchase orders folder and the reference folder.
6. **Web search: off.**

### It does not all fit — use the short form

The instructions field caps at **8,000 characters**. Measured:

| | Characters |
| --- | --- |
| Skill body (below the frontmatter) | 6,987 |
| Full constants table | 1,800 |
| **Body + full table** | **8,787 — over the limit** |
| Short-form constants | ~210 |
| **Body + short form** | **~7,200 — fits** |

The short form carries the four constants the arithmetic uses and drops the
reference detail (HS code, closed dates, minimum order) that the calculation
never touches. Copilot Studio has room for the full table; Agent Builder does
not.

**Check the character counter after pasting.** A silently truncated instruction
sheet is the failure that looks like the model simply ignoring you, and it is
the cross-checks at the bottom that get cut first.

If you still need to trim, cut in this order: the Boundaries section, then the
per-column `BLANK` rows in the table — keeping the four formula columns and every
column that carries a value. **Never cut the rule at the top or the
cross-checks.**

## Claude

Drop the folder into `.claude/skills/` in a project, or a personal skills
directory. It loads as-is — frontmatter, reference file and all — and the
reference file is read only when needed.

---

## Keeping the three in step

The behaviour now lives in three pasted copies. When you change one, change the
others the same day, or they drift and nobody knows which is right.

`SKILL.md` is the original. Edit it first, then re-paste. Put a line in your
change note saying which platforms you updated.
