/**
 * Storage under `<project>/.claude/context-graph/`:
 *   graph.json            the graph (see graph.mjs)
 *   src/<id>.md           verbatim turns behind one topic, one section appended per save
 *   config.json           optional overrides of DEFAULTS
 *   state/current.json    the session the hooks saw last (the MCP server reads it)
 *   state/<session>.json  per-session progress: indexed turns, compacted flag
 * ponytail: last writer wins if two Claude sessions share one project; add a lock file if that bites.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { emptyGraph, GRAPH_VERSION } from './graph.mjs'

export const DEFAULTS = { autoIndexEveryTurns: 5, maxHits: 5, inlineMaxChars: 1200, surfaceMaxNodes: 40 }

export const dataDir = (projectDir) => join(projectDir, '.claude', 'context-graph')

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
  await rename(tmp, path)
}

export async function loadConfig(dir) {
  return { ...DEFAULTS, ...(await readJson(join(dir, 'config.json'), {})) }
}

export async function loadGraph(dir) {
  const graph = await readJson(join(dir, 'graph.json'), undefined)
  return graph?.version === GRAPH_VERSION && typeof graph.nodes === 'object' && Array.isArray(graph.edges) ? graph : emptyGraph()
}

export const saveGraph = (dir, graph) => writeJson(join(dir, 'graph.json'), graph)

const sessionFile = (dir, session) => join(dir, 'state', `${String(session).replace(/[^\w.-]/g, '_')}.json`)
export const loadSession = (dir, session) => readJson(sessionFile(dir, session), { indexedTurns: 0, compacted: false })
export const saveSession = (dir, session, state) => writeJson(sessionFile(dir, session), state)
export const loadCurrent = (dir) => readJson(join(dir, 'state', 'current.json'), undefined)
/** Where the hooks note the last active project, for an MCP server started outside the project folder. */
export const POINTER = process.env.CONTEXT_GRAPH_POINTER || join(homedir(), '.claude', 'context-graph-last.json')

export async function saveCurrent(dir, input, projectDir) {
  const at = new Date().toISOString()
  await writeJson(join(dir, 'state', 'current.json'), { session: input.session_id, transcript: input.transcript_path, at })
  await writeJson(POINTER, { projectDir, at })
}

/** Project folder for the MCP server: Claude's variable, else a folder that already has a graph, else the hooks' pointer. */
export async function resolveProjectDir(env = process.env, cwd = process.cwd()) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR
  if (existsSync(dataDir(cwd))) return cwd
  return (await readJson(POINTER, {})).projectDir || cwd
}

export async function appendSource(dir, id, { session, at, body }) {
  await mkdir(join(dir, 'src'), { recursive: true })
  await appendFile(join(dir, 'src', `${id}.md`), `## ${at} session ${session}\n\n${body}\n\n`, 'utf8')
}

export async function readSource(dir, id) {
  try {
    return await readFile(join(dir, 'src', `${id}.md`), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
