---
name: git
description: "Git version control operations: commits, branches, merges, rebases, history."
metadata:
  cereworker:
    emoji: "\U0001F500"
    requires:
      bins: ["git"]
---

# Git Skill

Use `git` for version control operations.

## Common Commands

### Status & History
```bash
git status
git log --oneline -20
git diff
git diff --staged
```

### Branching
```bash
git branch -a
git checkout -b feature/new-branch
git switch main
git merge feature/new-branch
```

### Committing
```bash
git add <files>
git commit -m "description of changes"
git push origin <branch>
```

### Stashing
```bash
git stash
git stash pop
git stash list
```
