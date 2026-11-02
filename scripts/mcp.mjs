#!/usr/bin/env node
/**
 * MCP server (stdio, zero dependencies) giving Claude two tools:
 * - recall: a topic (n12) with its verbatim source and neighbours, or a turn (t7) of the current
 *   conversation word for word.
 * - remember: save topics drawn from this conversation's turns; each must cite turns that exist,
 *   and those turns are stored verbatim so the topic can always be expanded later.
 * The current conversation is the one the hooks recorded last (state/current.json).
 */
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import { KINDS, mergeDelta, neighbors, RELATIONS } from './graph.mjs'
import { appendSource, dataDir, loadCurrent, loadGraph, loadSession, readSource, resolveProjectDir, saveGraph, saveSession } from './store.mjs'
import { humanTurns, readTranscript, turnText } from './transcript.mjs'

const VERSION = '0.1.0'

export const TOOLS = [
  {
    name: 'recall',
    description: 'Get the exact text behind an id shown in a [context-graph] block. A topic id (n12) returns the conversation turns it was saved from plus its linked topics; a turn id (t7) returns that turn of the current conversation word for word, including tool calls and results. Use it instead of guessing when a gist is not precise enough.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Topic id such as n12, or turn id such as t7.' },
        depth: { type: 'integer', description: '1 also shows each linked topic\'s gist. Default 0.' }
      },
      required: ['id']
    }
  },
  {
    name: 'remember',
    description: 'Save topics from this conversation to the project memory graph so later sessions can find them. Call it when a [context-graph] message asks you to, or when the user asks you to remember something. Each topic must cite the turns (t-numbers) it comes from.',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: ['string', 'null'], description: 'Existing topic id to update, or null for a new topic.' },
              label: { type: 'string', description: 'At most 6 words: what someone would search for.' },
              gist: { type: 'string', description: 'One line: what is true now and why.' },
              aliases: { type: 'array', items: { type: 'string' }, description: 'Other words a future message might use, in every language the user writes.' },
              kind: { type: 'string', enum: KINDS },
              turns: { type: 'array', items: { type: 'integer' }, description: 'Turn numbers (7 for t7) this topic comes from.' }
            },
            required: ['label', 'gist', 'turns']
          }
        },
        edges: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
          description: `[from, to, relation] with relation in ${RELATIONS.join(', ')}. Ids or labels of topics in this call.`
        }
      },
      required: ['nodes']
    }
  }
]

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })

async function current(dir) {
  const cur = await loadCurrent(dir)
  if (!cur?.transcript) throw new Error('No conversation recorded yet. The context-graph hooks record it on the first message of a session.')
  return { ...cur, entries: readTranscript(cur.transcript) }
}

export async function recall(dir, { id, depth = 0 }) {
  const key = String(id ?? '').trim()
  const turn = /^t(\d+)$/i.exec(key)
  if (turn) {
    const { entries } = await current(dir)
    const body = turnText(entries, Number(turn[1]))
    return body === undefined ? text(`No turn ${key} in this conversation.`, true) : text(`# ${key} (verbatim)\n\n${body}`)
  }
  const graph = await loadGraph(dir)
  const node = graph.nodes[key]
  if (!node) return text(`No topic "${key}" in this project's memory. Only use ids shown in a [context-graph] block.`, true)
  node.hits = (node.hits ?? 0) + 1
  await saveGraph(dir, graph)
  const lines = [`# ${key} ${node.label}`, `${node.kind}. ${node.gist}`, '', (await readSource(dir, key))?.trim() ?? '(no verbatim source stored for this topic)']
  const links = neighbors(graph, key)
  if (links.length > 0) {
    lines.push('', 'Linked topics:')
    for (const link of links) {
      const other = graph.nodes[link.id]
      const arrow = link.direction === 'out' ? `${key} ${link.relation} ${link.id}` : `${link.id} ${link.relation} ${key}`
      lines.push(`- ${arrow}: ${other.label}${depth >= 1 ? ` — ${other.gist}` : ''}`)
    }
  }
  return text(lines.join('\n'))
}

export async function remember(dir, { nodes = [], edges = [] }) {
  const { session, entries } = await current(dir)
  const turnCount = humanTurns(entries).length
  const valid = []
  const skipped = []
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const turns = (Array.isArray(n?.turns) ? n.turns : []).map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= turnCount)
    // Reversibility rule: a topic is saved only with turns that can be stored word for word.
    if (typeof n?.label !== 'string' || !n.label.trim() || turns.length === 0) { skipped.push(n?.label ?? '(no label)'); continue }
    valid.push({ ...n, turns: [...new Set(turns)].sort((a, b) => a - b) })
  }
  const graph = await loadGraph(dir)
  const at = new Date().toISOString()
  const touched = mergeDelta(graph, { nodes: valid, edges: (Array.isArray(edges) ? edges : []).filter((e) => Array.isArray(e) && e.length === 3) }, { session, now: at })
  for (const { id, turns } of touched) {
    const body = turns.map((t) => `### t${t}\n\n${turnText(entries, t)}`).join('\n\n')
    await appendSource(dir, id, { session, at, body })
  }
  await saveGraph(dir, graph)
  const state = await loadSession(dir, session)
  await saveSession(dir, session, { ...state, indexedTurns: Math.max(state.indexedTurns ?? 0, turnCount) })
  const created = touched.filter((t) => t.isNew).length
  const note = skipped.length > 0 ? ` Skipped ${skipped.length} without valid turn numbers (1-${turnCount}): ${skipped.join(', ')}.` : ''
  return text(`Saved ${touched.length} topics (${created} new). The project graph has ${Object.keys(graph.nodes).length} topics.${note}`)
}

export async function handle(msg, dir) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'context-graph', version: VERSION } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const args = msg.params?.arguments ?? {}
      try {
        if (msg.params?.name === 'recall') return await recall(dir, args)
        if (msg.params?.name === 'remember') return await remember(dir, args)
      } catch (error) {
        return text(`context-graph: ${error.message}`, true)
      }
      throw Object.assign(new Error(`Unknown tool: ${msg.params?.name}`), { code: -32602 })
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  // One request at a time: two parallel remember calls must not overwrite each other's graph.
  let queue = Promise.resolve()
  readline.createInterface({ input: process.stdin }).on('line', (line) => { queue = queue.then(() => onLine(line)) })
  async function onLine(line) {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (msg.id === undefined) return // notifications need no reply
    try {
      // Resolved per call: the project folder can appear after the server started.
      send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg, dataDir(await resolveProjectDir())) })
    } catch (error) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: error.code ?? -32603, message: error.message } })
    }
  }
}
