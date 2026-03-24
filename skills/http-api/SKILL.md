---
name: http-api
description: "Make HTTP API calls via httpFetch tool: REST, GraphQL, webhooks, any HTTP method with auth headers."
metadata:
  cereworker:
    emoji: "\U0001F310"
    requires:
      tools: ["httpFetch"]
---

# HTTP API Skill

Use the `httpFetch` tool to call any HTTP API. Supports all methods, custom headers, and request bodies.

## Patterns

### GET request
```
httpFetch: https://api.example.com/data
```

### POST with JSON body
```
httpFetch:
  url: https://api.example.com/items
  method: POST
  headers:
    Content-Type: application/json
    Authorization: Bearer $TOKEN
  body: '{"name": "new item", "value": 42}'
```

### GraphQL query
```
httpFetch:
  url: https://api.github.com/graphql
  method: POST
  headers:
    Authorization: bearer $GITHUB_TOKEN
  body: '{"query": "{ viewer { login repositories(first: 5) { nodes { name } } } }"}'
```

### Common APIs

**GitHub API** (prefer `gh` CLI when available):
```
httpFetch:
  url: https://api.github.com/repos/owner/repo
  headers:
    Authorization: token $GITHUB_TOKEN
    Accept: application/vnd.github.v3+json
```

**Slack webhook**:
```
httpFetch:
  url: https://hooks.slack.com/services/T.../B.../xxx
  method: POST
  body: '{"text": "Hello from CereWorker!"}'
```

## Tips
- Check environment variables for API keys before asking the user
- Use `webSearch` to find API documentation if you're unsure about endpoints
- Parse JSON responses to extract what you need
- For pagination, follow `Link` headers or `next` cursors
