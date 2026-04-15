# Git History as Context

Before making recommendations, proposing architectural changes, or starting implementation on a feature area, run `git log --oneline -30` (or a more targeted `git log --oneline --all -- <path>` for specific files) to review recent commit messages. The owner writes extremely verbose commit messages that document design rationale, trade-offs considered, and the trajectory of each feature. Treat these messages as a primary source of project intent.

When the commit history reveals a deliberate pattern — a sequence of incremental refinements, a migration away from one approach, or a conscious decision to keep something a certain way — respect that trajectory. Do not suggest reversing or contradicting recent deliberate changes unless explicitly asked.

If a recommendation conflicts with the direction shown in recent commits, flag the conflict and explain why the new direction might be worth considering rather than silently overriding it.

## Commit Message Style

All commits should follow the owner's established style: verbose, past tense, ending with a period. The commit message should explain what changed, why it changed, and any relevant context or trade-offs considered.
