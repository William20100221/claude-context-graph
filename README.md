# context-graph for Claude Code

A Claude Code plugin that gives each project a small memory graph of past conversations. It works
in the Claude Code CLI and in the Claude desktop app's Code tab. A new session starts with a short
map of earlier decisions. Each prompt gets the few topics that match it. Claude recalls exact
earlier turns on demand instead of re-reading files or asking you to re-explain.

Sibling project: [dsh-context-graph](https://github.com/William20100221/dsh-context-graph) is
the DeepSeek Harness version. The two share the graph idea but are built for each app separately.

## How it saves tokens in Claude Code

Claude Code does not let plugins remove old messages from a running conversation, so this plugin
does not fold history the way the dsh version does. It saves tokens in three Claude-specific ways:

1. **`/clear` costs nothing.** Memory survives `/clear`, and the next session starts with the
   project map, so you can clear whenever you switch tasks. Every later request is smaller.
2. **Compaction loses nothing.** When Claude compacts a long conversation, the plugin adds a
   table of contents of every earlier turn (`t1`, `t2`, ...). Claude recalls the exact turn when a
   detail matters, instead of trusting a lossy summary.
3. **Claude indexes for itself.** Every 5 of your turns, the Stop hook asks Claude to save the new
   turns with the `remember` tool. Claude already has those turns in its cached context, so this
   costs one short extra step: no second model, no API key.

## What runs when

| Moment | What happens |
|---|---|
| Session start, after `/clear`, after resume | Up to 40 best-connected topics from earlier sessions, one line each. |
| After compaction | The turn-by-turn table of contents of this conversation, plus its topics. |
| Each prompt | Topics matching your words (word overlap, English and Chinese; no model call). A short, clearly best source is included word for word. |
| Every 5 turns, when Claude stops | Claude is asked once to call `remember` for those turns, then stops. |
| Claude calls `recall` | `n12`: a topic's saved turns, word for word, plus linked topics. `t7`: turn 7 of this conversation, word for word. |

Commands: `/context-graph:stats`, `/context-graph:find <words>`, `/context-graph:save`.

Data lives in `.claude/context-graph/` inside your project. Add it to `.gitignore` if you do not
want it committed.

## Install

Needs Node.js 20 or newer on your PATH.

From GitHub, inside Claude Code:

```
/plugin marketplace add William20100221/claude-context-graph
/plugin install context-graph@claude-context-graph
```

From a local folder:

```
/plugin marketplace add C:/path/to/claude-context-graph
/plugin install context-graph@claude-context-graph
```

Restart Claude Code after installing. Run `/context-graph:stats` to check it loaded.

## Settings

Optional file `.claude/context-graph/config.json` in your project:

```json
{ "autoIndexEveryTurns": 5, "maxHits": 5, "inlineMaxChars": 1200, "surfaceMaxNodes": 40 }
```

`autoIndexEveryTurns: 0` turns off the automatic save request. Use `/context-graph:save` to save
by hand instead.

## Files

```
.claude-plugin/plugin.json      plugin manifest
.claude-plugin/marketplace.json lets this repo act as its own marketplace
hooks/hooks.json                SessionStart, UserPromptSubmit and Stop hooks
.mcp.json                       the recall and remember tools
scripts/graph.mjs               pure core: match, merge, render
scripts/transcript.mjs          reads Claude Code's JSONL transcript
scripts/store.mjs               files under .claude/context-graph/
scripts/hook.mjs                the three hooks
scripts/mcp.mjs                 MCP server, zero dependencies
scripts/cli.mjs                 reports for the slash commands
commands/, skills/              slash commands and the usage skill
```

## Testing

```
npm test
```

## Known limits

- Two Claude sessions open in the same project at once: the tools act on whichever session sent
  the last message, and the last graph write wins.
- Turn numbers count your own messages in this conversation. Slash commands and tool results are
  not turns.
