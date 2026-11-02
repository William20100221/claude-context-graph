---
description: Search the project memory graph for topics
argument-hint: <words>
allowed-tools: Bash(node:*)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" find $ARGUMENTS
```

Show the matches above to the user as a short list. If one is clearly what they want, offer to open it with the recall tool. Add nothing else.
