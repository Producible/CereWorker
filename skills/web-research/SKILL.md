---
name: web-research
description: "Web research via webSearch tool: find documentation, news, tutorials, API references."
metadata:
  cereworker:
    emoji: "\U0001F50D"
    requires:
      tools: ["webSearch"]
---

# Web Research Skill

Use the `webSearch` tool to find information on the web.

## Search Patterns

### Find API documentation
```
webSearch: "Twitter API v2 post tweet endpoint documentation"
```

### Find current news
```
webSearch: "AI news today 2026"
```

### Find CLI tool usage
```
webSearch: "how to use jq to filter JSON arrays"
```

### Find package/library docs
```
webSearch: "node.js axios POST request example"
```

## Tips

- Be specific in search queries — include the tool/API name and what you're trying to do
- For APIs, search for "official documentation" or "API reference" to get authoritative sources
- Use `httpFetch` to read the full content of pages found via search
- When researching how to do something new, check if there's a CLI tool that makes it easier
- After solving a novel problem, write a SKILL.md so you don't need to research it again
