---
name: cron-task
description: "Best practices for recurring autonomous tasks: goal execution, state tracking, error recovery."
metadata:
  cereworker:
    emoji: "\U0001F504"
---

# Recurring Task Skill

Guidelines for executing recurring autonomous tasks effectively.

## Execution Pattern

1. **Review history**: Check your conversation history for outcomes from previous runs
2. **Check state**: Use `memory_read` to recall any notes from last time
3. **Execute goal**: Use tools to accomplish the task
4. **Verify**: Confirm the action succeeded (check API responses, file changes, etc.)
5. **Log outcomes**: Use `memory_log` to record what happened

## Error Recovery

- If credentials are missing, log which credentials are needed and where to put them
- If an API is down, log the failure and skip gracefully — don't retry endlessly
- If a task partially succeeds, log what worked and what didn't

## State Between Runs

Use `memory_log` to persist information across runs:
```
memory_log: "daily-report: Posted successfully. Engagement on yesterday's post: 12 likes, 3 replies."
memory_log: "repo-check: 2 new issues found, CI green on all repos."
```

## Credential Management

Check these locations for API keys:
1. Environment variables (e.g., `$GITHUB_TOKEN`, `$SLACK_WEBHOOK`)
2. Config files (`~/.cereworker/config.yml`)
3. Credential stores (`~/.config/gh/hosts.yml` for GitHub)

If credentials are missing, clearly describe what's needed in the task output.
