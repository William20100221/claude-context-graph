#!/usr/bin/env node
/**
 * Claude Code hooks for context-graph. Usage (from hooks/hooks.json):
 *   node hook.mjs session-start | prompt | stop      (hook input JSON on stdin)
 * - session-start: start a session with the project map; after a compaction, add this
 *   conversation's turn-by-turn table of contents.
 * - prompt: attach the few topics that match the new message (no model call).
 * - stop: every few human turns, ask Claude to save them with the remember tool.
 * A hook must never break Claude: every failure is logged to stderr and the hook exits 0.
 */
import { pathToFileURL } from 'node:url'

import { matchNodes, onlyFromSession, renderHits, renderSurface, renderTurnIndex, indexRequest, surfaceNodes } from './graph.mjs'
import { dataDir, loadConfig, loadGraph, loadSession, readSource, saveCurrent, saveSession } from './store.mjs'
import { humanTurns, readTranscript } from './transcript.mjs'

const context = (eventName, text) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })

/**
 * @param {'session-start'|'prompt'|'stop'} event
 * @param {object} input - the hook's stdin JSON (session_id, transcript_path, cwd, ...)
 * @param {{ projectDir?: string }} [options]
 * @returns the JSON to print, or undefined for no output.
 */
export async function runHook(event, input, { projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() } = {}) {
  const dir = dataDir(projectDir)
  const session = String(input.session_id ?? '')
  if (!session) return undefined
  await saveCurrent(dir, input, projectDir)
  const cfg = await loadConfig(dir)
  const graph = await loadGraph(dir)
  const state = await loadSession(dir, session)

  if (event === 'session-start') {
    if (input.source === 'compact' && !state.compacted) await saveSession(dir, session, { ...state, compacted: true })
    const compacted = input.source === 'compact' || state.compacted
    const parts = []
    if (input.source === 'compact') {
      const turns = humanTurns(readTranscript(input.transcript_path))
      if (turns.length > 0) parts.push(renderTurnIndex(graph, session, turns, { maxNodes: cfg.surfaceMaxNodes }))
    }
    // This conversation's own topics are still in context unless it was compacted.
    const ids = surfaceNodes(graph, cfg.surfaceMaxNodes).filter((id) => compacted || !onlyFromSession(graph.nodes[id], session))
    if (ids.length > 0) parts.push(renderSurface(graph, ids))
    return parts.length > 0 ? context('SessionStart', parts.join('\n\n')) : undefined
  }

  if (event === 'prompt') {
    if (Object.keys(graph.nodes).length === 0) return undefined
    const hits = matchNodes(graph, input.prompt ?? '', { max: cfg.maxHits, session, sessionCompacted: state.compacted })
    if (hits.length === 0) return undefined
    let inline
    if (hits.length === 1 || hits[0].score >= 2 * hits[1].score) {
      const text = await readSource(dir, hits[0].id)
      if (text && text.length <= cfg.inlineMaxChars) inline = { id: hits[0].id, text }
    }
    return context('UserPromptSubmit', renderHits(graph, hits, { inline }))
  }

  if (event === 'stop') {
    // stop_hook_active: Claude is already continuing because of a Stop hook; never loop.
    if (input.stop_hook_active || !(cfg.autoIndexEveryTurns > 0)) return undefined
    const turns = humanTurns(readTranscript(input.transcript_path))
    const indexed = Math.min(state.indexedTurns ?? 0, turns.length)
    if (turns.length - indexed < cfg.autoIndexEveryTurns) return undefined
    const pending = turns.slice(indexed)
    // Marked as indexed now, so an ignored request is not repeated every turn.
    await saveSession(dir, session, { ...state, indexedTurns: turns.length })
    return { decision: 'block', reason: indexRequest(graph, pending) }
  }
  return undefined
}

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = await runHook(process.argv[2], JSON.parse((await readStdin()) || '{}'))
    if (output) process.stdout.write(JSON.stringify(output))
  } catch (error) {
    process.stderr.write(`context-graph hook failed (ignored): ${error?.stack ?? error}\n`)
  }
  process.exit(0)
}
