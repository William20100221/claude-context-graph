/**
 * context-graph core for Claude Code. Pure: no I/O, so `node --test` covers it without Claude running.
 *
 * A graph is `{ version, nextId, nodes: { [id]: Node }, edges: [[from, to, relation], ...] }`.
 * A Node is `{ label, gist, aliases, kind, src: [{ session, turns, at }], updated, hits }`; turns are t-numbers.
 * The verbatim source text of a node lives outside the graph (see store.mjs); `src` is provenance.
 */

export const GRAPH_VERSION = 1
export const SOURCE_KIND = 'context-graph'
export const RELATIONS = ['uses', 'part-of', 'supersedes', 'caused-by', 'relates-to']
export const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']

const STOPWORDS = new Set((
  'a an the and or but if then so of to in on at for with by from as is are was were be been being ' +
  'do does did done have has had can could should would will shall may might must not no yes ' +
  'i me my we our you your he she it its they them this that these those there here what which who ' +
  'how when where why also just like get got make made use used using want need let please ok okay ' +
  'now new one two about into over under again more most some any all each other than too very ' +
  '的 了 是 在 我 你 他 她 它 们 这 那 个 和 与 或 吗 呢 吧 啊 把 被 给 让 就 都 也 还 很 不 没 有 要 会 能 可以 什么 怎么 这个 那个 一下 一个'
).split(/\s+/))

export function emptyGraph() {
  return { version: GRAPH_VERSION, nextId: 1, nodes: {}, edges: [] }
}

/** Rough token estimate for budget caps; CJK is close to one token per char. */
export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

/**
 * Lowercased word tokens plus CJK bigrams, stopwords removed.
 * "clear_conversation tool" -> ["clear_conversation", "clear", "conversation", "tool"]
 * "清除上下文" -> ["清除", "除上", "上下", "下文"]
 */
export function tokenize(text) {
  const out = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const run of lower.match(/[぀-ヿ㐀-鿿가-힯]+/g) ?? []) {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.add(run); continue }
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) out.add(bigram)
    }
  }
  for (const word of lower.replace(/[぀-ヿ㐀-鿿가-힯]+/g, ' ').match(/[a-z0-9_./-]{2,}/g) ?? []) {
    if (STOPWORDS.has(word)) continue
    out.add(word)
    if (/[_./-]/.test(word)) for (const part of word.split(/[_./-]+/)) if (part.length >= 2 && !STOPWORDS.has(part)) out.add(part)
  }
  return [...out]
}

function nodeTokens(node) {
  return {
    strong: new Set(tokenize([node.label, ...(node.aliases ?? [])].join(' '))),
    weak: new Set(tokenize(node.gist ?? ''))
  }
}

/** True when every provenance entry of `node` comes from `session` (its text is still in that session's context). */
export function onlyFromSession(node, session) {
  return Boolean(session) && (node.src ?? []).length > 0 && node.src.every((s) => s.session === session)
}

export function degree(graph, id) {
  let n = 0
  for (const [a, b] of graph.edges) if (a === id || b === id) n++
  return n
}

/** Edges touching `id`, oriented from its point of view. */
export function neighbors(graph, id) {
  const out = []
  for (const [a, b, relation] of graph.edges) {
    if (a === id && graph.nodes[b]) out.push({ id: b, relation, direction: 'out' })
    else if (b === id && graph.nodes[a]) out.push({ id: a, relation, direction: 'in' })
  }
  return out
}

/** Follow `supersedes` edges forward so a stale decision resolves to its replacement. */
export function resolveSuperseded(graph, id) {
  const seen = new Set()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const next = graph.edges.find(([from, to, rel]) => rel === 'supersedes' && to === current && graph.nodes[from])
    if (!next) return current
    current = next[0]
  }
  return current
}

/**
 * Lexical match of a user message against node labels/aliases (weight 2) and gists (weight 1),
 * with a small boost for well-connected nodes. Nodes whose every source is the current session are
 * skipped while that session has not compacted: their text is still on the surface.
 * @returns [{ id, node, score }] best first, at most `max`, only nodes with a strong (label/alias) hit.
 */
export function matchNodes(graph, query, { max = 5, session, sessionCompacted = false } = {}) {
  const q = tokenize(query)
  if (q.length === 0) return []
  const scored = []
  for (const [rawId, node] of Object.entries(graph.nodes)) {
    if (!sessionCompacted && onlyFromSession(node, session)) continue
    const { strong, weak } = nodeTokens(node)
    let strongHits = 0
    let weakHits = 0
    for (const t of q) {
      if (strong.has(t)) strongHits++
      else if (weak.has(t)) weakHits++
    }
    if (strongHits === 0) continue
    const score = strongHits * 2 + weakHits + 0.25 * Math.log1p(degree(graph, rawId))
    const id = resolveSuperseded(graph, rawId)
    scored.push({ id, node: graph.nodes[id], score, via: id === rawId ? undefined : rawId })
  }
  scored.sort((a, b) => b.score - a.score || (b.node.updated ?? '').localeCompare(a.node.updated ?? ''))
  const seen = new Set()
  return scored.filter(({ id }) => !seen.has(id) && seen.add(id)).slice(0, max)
}

/** God nodes: most connected first, newest first among equals. */
export function surfaceNodes(graph, max = 40) {
  return Object.keys(graph.nodes)
    .map((id) => ({ id, d: degree(graph, id), u: graph.nodes[id].updated ?? '' }))
    .sort((a, b) => b.d - a.d || b.u.localeCompare(a.u))
    .slice(0, max)
    .map(({ id }) => id)
}

function line(id, node) {
  const date = (node.updated ?? '').slice(0, 10)
  return `- ${id} ${node.label}: ${node.gist}${date ? ` (${date})` : ''}`
}

/** The per-turn block appended to the user's message. `inline` carries one node's verbatim text when it is short. */
export function renderHits(graph, hits, { inline } = {}) {
  if (hits.length === 0) return ''
  const lines = [`[${SOURCE_KIND}] Related past context. Call the recall tool with an id for the verbatim source.`]
  for (const { id, node, via } of hits) lines.push(line(id, node) + (via ? ` [replaces ${via}]` : ''))
  if (inline) lines.push('', `Verbatim source of ${inline.id}:`, inline.text.trim())
  return lines.join('\n')
}

/** The cross-session surface layer sent once at the start of a session. */
export function renderSurface(graph, ids) {
  if (ids.length === 0) return ''
  const lines = [
    `[${SOURCE_KIND}] Memory of earlier sessions in this project (${Object.keys(graph.nodes).length} nodes). ` +
    'Each line is one node: id, label, gist. Call the recall tool with an id for the verbatim source and its neighbours. ' +
    'Treat this as background; do not restate it.'
  ]
  for (const id of ids) lines.push(line(id, graph.nodes[id]))
  return lines.join('\n')
}
/**
 * Apply what Claude passed to the remember tool. New nodes get ids; existing ones are updated in place (gist replaced,
 * aliases unioned, provenance appended). Edges may name new nodes by label. Returns the ids
 * touched with the turn numbers they cite, so the caller can store those turns verbatim.
 */
export function mergeDelta(graph, delta, { session, now }) {
  const byLabel = new Map()
  const touched = []
  for (const n of delta.nodes) {
    let id = typeof n.id === 'string' && graph.nodes[n.id] ? n.id : undefined
    if (!id) {
      const existing = Object.entries(graph.nodes).find(([, x]) => x.label.toLowerCase() === n.label.trim().toLowerCase())
      id = existing ? existing[0] : `n${graph.nextId++}`
    }
    const prev = graph.nodes[id]
    const aliases = [...new Set([...(prev?.aliases ?? []), ...(Array.isArray(n.aliases) ? n.aliases : [])].map((a) => String(a).trim()).filter(Boolean))]
    graph.nodes[id] = {
      label: n.label.trim(),
      gist: String(n.gist ?? prev?.gist ?? '').trim().slice(0, 200),
      aliases,
      kind: KINDS.includes(n.kind) ? n.kind : prev?.kind ?? 'fact',
      src: [...(prev?.src ?? []), { session, turns: n.turns, at: now }],
      updated: now,
      hits: prev?.hits ?? 0
    }
    byLabel.set(n.label.trim().toLowerCase(), id)
    if (typeof n.id === 'string') byLabel.set(n.id, id)
    touched.push({ id, turns: n.turns, isNew: !prev })
  }
  const resolve = (ref) => graph.nodes[ref] ? ref : byLabel.get(ref) ?? byLabel.get(String(ref).toLowerCase())
  for (const [from, to, relation] of delta.edges) {
    const a = resolve(from)
    const b = resolve(to)
    if (!a || !b || a === b || !RELATIONS.includes(relation)) continue
    if (!graph.edges.some(([x, y, r]) => x === a && y === b && r === relation)) graph.edges.push([a, b, relation])
  }
  return touched
}

const firstLine = (text, width) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

/**
 * Shown after Claude Code compacts this conversation: the compaction summary is lossy, so list
 * every earlier turn (t1..tN) and this conversation's topics, each recallable word for word.
 */
export function renderTurnIndex(graph, session, turns, { maxNodes = 40, maxTurns = 60, width = 90 } = {}) {
  const lines = [
    `[${SOURCE_KIND}] This conversation was compacted. Its earlier turns t1-t${turns.length} are listed below and still exist word for word.`,
    'Before answering anything that depends on their exact details, call the recall tool with a turn id (t7) or a topic id (n12). Do not guess.'
  ]
  const ids = surfaceNodes(graph, Infinity).filter((id) => (graph.nodes[id].src ?? []).some((s) => s.session === session)).slice(0, maxNodes)
  if (ids.length > 0) {
    lines.push('', 'Topics:')
    for (const id of ids) lines.push(line(id, graph.nodes[id]))
  }
  lines.push('', 'Turns (what the user asked):')
  const shown = turns.slice(-maxTurns)
  if (shown.length < turns.length) lines.push(`- t1-t${turns.length - shown.length}: earlier turns, recall by id`)
  for (const t of shown) lines.push(`- t${t.turn}: ${firstLine(t.text, width)}`)
  return lines.join('\n')
}

/** Stop-hook request asking Claude to save turns it has just seen, through the remember tool. */
export function indexRequest(graph, turns, width = 90) {
  const existing = Object.entries(graph.nodes).slice(-60).map(([id, n]) => `${id} ${n.label}`).join('; ')
  return [
    `[${SOURCE_KIND}] Before stopping, save turns t${turns[0].turn}-t${turns.at(-1).turn} of this conversation to the project memory graph so a later session can find them.`,
    'Call the remember tool once. Add one node per decision, fact, task, artifact (file, tool, repo) or open question worth recalling later; skip chit-chat.',
    'Each node: label (at most 6 words, what someone would search for), gist (one line, what is true now and why), aliases (other words a future message might use, in every language the user writes), kind, and turns (the t-numbers it comes from).',
    'Reuse an existing id when it is the same topic; for a changed decision add an edge [new, old, "supersedes"]. If nothing is worth keeping, call remember with an empty nodes list.',
    'After the tool call, stop. Do not write anything else.',
    existing ? `Existing topics: ${existing}` : 'Existing topics: none',
    '',
    'Turns to save:',
    ...turns.map((t) => `- t${t.turn}: ${firstLine(t.text, width)}`)
  ].join('\n')
}

