---
name: context-graph
description: Use the project memory graph. Applies when a [context-graph] block appears in context, when the user refers to an earlier session or decision ("what did we decide about X", "like last time"), when the user asks you to remember something for later, or after this conversation was compacted and an exact earlier detail matters.
---

# Project memory graph

This project keeps a small graph of earlier conversations in `.claude/context-graph/`. Topics have ids like `n12`. Turns of the current conversation have ids like `t7`.

## Reading

- A `[context-graph]` block lists topics as `id label: gist`. The gist is a pointer, not the record.
- When an answer depends on the exact wording, a number, a path, or the reason behind a decision, call the **recall** tool with the id first. Do not guess from the gist.
- After a compaction, the block lists every earlier turn (`t1`, `t2`, ...). Recall a turn instead of relying on the compaction summary when details matter.
- A topic marked `[replaces n4]` is the newer decision. Prefer it.

## Writing

- When a `[context-graph]` message asks you to save turns, call the **remember** tool once, then stop.
- When the user says "remember this" or similar, call **remember** with one topic citing the current turn number. The stats command shows how many turns this conversation has.
- One topic per decision, fact, task, artifact or open question. Label: what someone would search for. Gist: what is true now and why. Aliases: other words, in every language the user writes. Always cite turns.
- Reuse an existing id for the same topic. For a changed decision, add the new topic and an edge `[new, old, "supersedes"]`.

## Saving tokens

Memory survives `/clear`. When the user switches to an unrelated task in a long conversation, suggest `/clear`: the next session starts with the project map, so nothing important is lost and every later request is smaller.
