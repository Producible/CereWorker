---
name: github
description: "GitHub operations via gh CLI: issues, PRs, CI runs, code review, API queries."
metadata:
  cereworker:
    emoji: "\U0001F419"
    requires:
      bins: ["gh"]
    install:
      - kind: brew
        formula: gh
        bins: ["gh"]
      - kind: apt
        package: gh
        bins: ["gh"]
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

## Common Commands

### Pull Requests
```bash
gh pr list --repo owner/repo
gh pr view 55 --repo owner/repo
gh pr create --title "feat: add feature" --body "Description"
gh pr checks 55 --repo owner/repo
```

### Issues
```bash
gh issue list --repo owner/repo --state open
gh issue create --title "Bug: something" --body "Details..."
gh issue close 42 --repo owner/repo
```

### CI/Workflow Runs
```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo --log-failed
```

### API Queries
```bash
gh api repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```
