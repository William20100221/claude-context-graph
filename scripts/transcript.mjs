/**
 * Reads Claude Code's session transcript (the JSONL file at a hook's `transcript_path`).
 * Human turns are `user` entries holding the person's own text: not tool results, slash-command
 * plumbing, compaction summaries, or sidechain (subagent) messages.
 */
import { readFileSync } from 'node:fs'

export function readTranscript(path) {
  if (!path) return []
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch { /* a line still being written */ }
  }
  return entries
}

const PLUMBING = /^(<local-command-|<command-name>|<command-message>|<command-args>|<bash-input>|<bash-stdout>|<bash-stderr>|<system-reminder>|\[Request interrupted)/

const textBlocks = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')

/** The person's text in a transcript entry, or undefined when the entry is not a human turn. */
export function humanText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return undefined
  const content = entry.message?.content
  let text
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result')) text = textBlocks(content)
  text = text?.trim()
  return text && !PLUMBING.test(text) ? text : undefined
}

/** Every human turn in order: [{ turn: 1, index, text }]. */
export function humanTurns(entries) {
  const turns = []
  entries.forEach((entry, index) => {
    const text = humanText(entry)
    if (text) turns.push({ turn: turns.length + 1, index, text })
  })
  return turns
}

function resultText(block) {
  const c = block?.content
  return typeof c === 'string' ? c : textBlocks(c)
}

/** Turn `n` word for word: the prompt, Claude's text, tool calls and (capped) tool results. */
export function turnText(entries, n, { maxToolChars = 2000 } = {}) {
  const turns = humanTurns(entries)
  const start = turns[n - 1]
  if (!start) return undefined
  const end = turns[n]?.index ?? entries.length
  const out = [`**user:**\n${start.text}`]
  for (const entry of entries.slice(start.index + 1, end)) {
    if (entry.isSidechain) continue
    const content = entry.message?.content
    if (entry.type === 'assistant' && Array.isArray(content)) {
      const text = textBlocks(content).trim()
      if (text) out.push(`**assistant:**\n${text}`)
      for (const b of content) if (b?.type === 'tool_use') out.push(`**tool call** ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 300)}`)
    } else if (entry.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const text = resultText(b)
        out.push(`**tool result:**\n${text.length > maxToolChars ? `${text.slice(0, maxToolChars)}\n…[${text.length - maxToolChars} more chars]` : text}`)
      }
    }
  }
  return out.join('\n\n')
}
