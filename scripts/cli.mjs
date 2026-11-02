#!/usr/bin/env node
/** Text reports for the slash commands: `node cli.mjs stats` and `node cli.mjs find <words>`. */
import { pathToFileURL } from 'node:url'

import { indexRequest, matchNodes } from './graph.mjs'
import { dataDir, loadConfig, loadCurrent, loadGraph, loadSession } from './store.mjs'
import { humanTurns, readTranscript } from './transcript.mjs'

export async function report(command, words, projectDir) {
  const dir = dataDir(projectDir)
  const graph = await loadGraph(dir)
  const topics = Object.keys(graph.nodes).length
  if (command === 'find') {
    const hits = matchNodes(graph, words.join(' '), { max: 10 })
    if (hits.length === 0) return 'No matching topics.'
    return [`${hits.length} matching ${hits.length === 1 ? 'topic' : 'topics'}:`, ...hits.map(({ id, node }) => `${id} ${node.label}: ${node.gist}`)].join('\n')
  }
  const cur = await loadCurrent(dir)
  if (command === 'pending') {
    if (!cur?.session) return 'Nothing to save yet: no conversation recorded.'
    const turns = humanTurns(readTranscript(cur.transcript))
    const state = await loadSession(dir, cur.session)
    const pending = turns.slice(Math.min(state.indexedTurns ?? 0, turns.length))
    // A manual save re-offers every turn when all were saved already, so the user can still add topics.
    return indexRequest(graph, pending.length > 0 ? pending : turns.length > 0 ? turns : [{ turn: 1, text: '(no turns yet)' }])
  }
  const cfg = await loadConfig(dir)
  const lines = [`${topics} topics · ${graph.edges.length} links`, `Folder: ${dir}`]
  if (cur?.session) {
    const turns = humanTurns(readTranscript(cur.transcript)).length
    const state = await loadSession(dir, cur.session)
    lines.push(`This conversation: ${turns} turns, ${Math.min(state.indexedTurns ?? 0, turns)} saved${state.compacted ? ', compacted once' : ''}`)
  }
  lines.push(cfg.autoIndexEveryTurns > 0
    ? `Auto-save: every ${cfg.autoIndexEveryTurns} turns (set autoIndexEveryTurns in config.json; 0 turns it off)`
    : 'Auto-save: off (autoIndexEveryTurns is 0 in config.json)')
  const recent = Object.entries(graph.nodes).sort(([, a], [, b]) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 5)
  if (recent.length > 0) lines.push('Recently updated:', ...recent.map(([id, n]) => `  ${id} ${n.label}`))
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command = 'stats', ...words] = process.argv.slice(2)
  console.log(await report(command, words, process.env.CLAUDE_PROJECT_DIR || process.cwd()))
}
