import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

// Keep the hooks' "last project" pointer out of the real home folder.
const scratch = await mkdtemp(join(tmpdir(), 'ccg-'))
process.env.CONTEXT_GRAPH_POINTER = join(scratch, 'pointer.json')
delete process.env.CLAUDE_PROJECT_DIR

const { humanTurns, readTranscript, turnText } = await import('../scripts/transcript.mjs')
const { runHook } = await import('../scripts/hook.mjs')
const { handle } = await import('../scripts/mcp.mjs')
const { report } = await import('../scripts/cli.mjs')
const { dataDir, resolveProjectDir } = await import('../scripts/store.mjs')

const root = new URL('../', import.meta.url)
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const say = (content) => ({ type: 'assistant', message: { role: 'assistant', content } })

// Claude Code transcript shape: human prompts are user entries with string content.
const lines = [
  { type: 'file-history-snapshot' },
  user('We decided to sign commits with the SSH key id_ed25519_signing'),
  say([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Noted.' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'git config gpg.format ssh' } }]),
  user([{ type: 'tool_result', tool_use_id: 'u1', content: 'OK '.repeat(1000) }]),
  say([{ type: 'text', text: 'Signing configured.' }]),
  user('<command-name>/context-graph:stats</command-name>'),
  user('side task', { isSidechain: true }),
  user('summary of earlier', { isCompactSummary: true }),
  user([{ type: 'text', text: 'second question about pnpm' }]),
  say([{ type: 'text', text: 'Use corepack pnpm.' }]),
  user('third question'),
  say([{ type: 'text', text: 'Answer three.' }])
]

let project
let transcript
before(async () => {
  project = await mkdtemp(join(tmpdir(), 'ccg-project-'))
  transcript = join(project, 'session.jsonl')
  await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial":', 'utf8')
})
after(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const input = (session, extra = {}) => ({ session_id: session, transcript_path: transcript, cwd: project, ...extra })
const call = (name, args) => handle({ method: 'tools/call', params: { name, arguments: args } }, dataDir(project))

test('transcript: human turns skip tool results, command plumbing, sidechains and compaction summaries', () => {
  const entries = readTranscript(transcript)
  assert.deepEqual(humanTurns(entries).map((t) => t.text), [
    'We decided to sign commits with the SSH key id_ed25519_signing', 'second question about pnpm', 'third question'
  ])
  const t1 = turnText(entries, 1, { maxToolChars: 9 })
  assert.match(t1, /^\*\*user:\*\*\nWe decided/)
  assert.match(t1, /\*\*tool call\*\* Bash \{"command":"git config gpg.format ssh"\}/)
  assert.match(t1, /OK OK OK \n…\[2991 more chars\]/)
  assert.match(t1, /Signing configured\.$/)
  assert.ok(!t1.includes('hmm'), 'thinking is not part of the record')
  assert.equal(turnText(entries, 4), undefined)
  assert.deepEqual(readTranscript(join(project, 'missing.jsonl')), [])
})

test('first session: nothing to inject; remember saves topics with their turns verbatim', async () => {
  assert.equal(await runHook('session-start', input('sA', { source: 'startup' })), undefined)
  assert.equal(await runHook('prompt', input('sA', { prompt: 'hello' })), undefined)
  const saved = await call('remember', {
    nodes: [
      { id: null, label: 'commit signing', gist: 'signed with SSH key id_ed25519_signing', aliases: ['gpg', '签名'], kind: 'decision', turns: [1] },
      { id: null, label: 'pnpm via corepack', gist: 'pnpm is not on PATH', turns: [2, 2, 99] },
      { id: null, label: 'no turns', gist: 'rejected', turns: [] }
    ],
    edges: [['pnpm via corepack', 'commit signing', 'relates-to']]
  })
  assert.match(saved.content[0].text, /Saved 2 topics \(2 new\)\. The project graph has 2 topics\. Skipped 1 .*: no turns/)
  const src = readFileSync(join(dataDir(project), 'src', 'n1.md'), 'utf8')
  assert.match(src, /### t1[\s\S]*id_ed25519_signing[\s\S]*Signing configured/)
  const graph = JSON.parse(readFileSync(join(dataDir(project), 'graph.json'), 'utf8'))
  assert.deepEqual(graph.nodes.n2.src[0].turns, [2], 'invalid and duplicate turns dropped')
})

test('a later session gets the project map, and matching topics per prompt', async () => {
  const start = await runHook('session-start', input('sB', { source: 'startup' }))
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(start.hookSpecificOutput.additionalContext, /Memory of earlier sessions in this project \(2 nodes\)[\s\S]*- n1 commit signing/)
  const hit = await runHook('prompt', input('sB', { prompt: 'which gpg key do we use?' }))
  assert.equal(hit.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(hit.hookSpecificOutput.additionalContext, /- n1 commit signing: signed with SSH key/)
  assert.ok(!hit.hookSpecificOutput.additionalContext.includes('Verbatim source'), 'source is over the inline cap, so only the gist is sent')
  const short = await runHook('prompt', input('sB', { prompt: 'corepack' }))
  assert.match(short.hookSpecificOutput.additionalContext, /Verbatim source of n2:[\s\S]*Use corepack pnpm/, 'a short source is inlined')
  assert.equal(await runHook('prompt', input('sB', { prompt: 'unrelated weather' })), undefined)
  // The session that wrote the topics still has them in context, so it is not told again.
  assert.equal(await runHook('prompt', input('sA', { prompt: 'gpg' })), undefined)
})

test('after compaction: turn table of contents, own topics, and recall of exact turns', async () => {
  const out = await runHook('session-start', input('sA', { source: 'compact' }))
  const text = out.hookSpecificOutput.additionalContext
  assert.match(text, /This conversation was compacted\. Its earlier turns t1-t3/)
  assert.match(text, /- t2: second question about pnpm/)
  assert.match(text, /Topics:\n- n1 commit signing/)
  assert.match((await runHook('prompt', input('sA', { prompt: 'gpg' }))).hookSpecificOutput.additionalContext, /n1 commit signing/)
  const t2 = await call('recall', { id: 't2' })
  assert.match(t2.content[0].text, /^# t2 \(verbatim\)\n\n\*\*user:\*\*\nsecond question about pnpm[\s\S]*corepack/)
  const n1 = await call('recall', { id: 'n1', depth: 1 })
  assert.match(n1.content[0].text, /# n1 commit signing\ndecision\. signed with SSH key[\s\S]*Linked topics:\n- n2 relates-to n1: pnpm via corepack — pnpm is not on PATH/)
  assert.equal((await call('recall', { id: 'n99' })).isError, true)
  assert.equal((await call('recall', { id: 't9' })).isError, true)
})

test('stop asks Claude to save every N turns, never loops, and can be turned off', async () => {
  await writeFile(join(dataDir(project), 'config.json'), JSON.stringify({ autoIndexEveryTurns: 2 }))
  const ask = await runHook('stop', input('sC'))
  assert.equal(ask.decision, 'block')
  assert.match(ask.reason, /save turns t1-t3[\s\S]*Call the remember tool once[\s\S]*Existing topics: n1 commit signing; n2 pnpm via corepack[\s\S]*- t3: third question/)
  assert.equal(await runHook('stop', input('sC')), undefined, 'not asked again for the same turns')
  assert.equal(await runHook('stop', input('sD', { stop_hook_active: true })), undefined, 'no loop')
  await writeFile(join(dataDir(project), 'config.json'), JSON.stringify({ autoIndexEveryTurns: 0 }))
  assert.equal(await runHook('stop', input('sD')), undefined, 'off')
})

test('MCP protocol basics and the command reports', async () => {
  const init = await handle({ method: 'initialize', params: { protocolVersion: '2025-06-18' } }, dataDir(project))
  assert.equal(init.serverInfo.name, 'context-graph')
  const { tools } = await handle({ method: 'tools/list' }, dataDir(project))
  assert.deepEqual(tools.map((t) => t.name), ['recall', 'remember'])
  await assert.rejects(handle({ method: 'tools/call', params: { name: 'nope' } }, dataDir(project)), /Unknown tool/)
  await runHook('prompt', input('sE', { prompt: 'x' }))
  const stats = await report('stats', [], project)
  assert.match(stats, /^2 topics · 1 links\nFolder: .*\nThis conversation: 3 turns, 0 saved\nAuto-save: off/)
  assert.match(await report('find', ['corepack'], project), /1 matching topic:\nn2 pnpm via corepack/)
  assert.match(await report('pending', [], project), /save turns t1-t3/)
  assert.equal(await resolveProjectDir({}, join(tmpdir(), 'nowhere')), project, 'falls back to the hooks pointer')
  assert.equal(await resolveProjectDir({ CLAUDE_PROJECT_DIR: 'X' }), 'X')
})

test('plugin wiring: manifest, marketplace, hooks, MCP server, commands, skill', () => {
  const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'))
  assert.equal(json('.claude-plugin/plugin.json').name, 'context-graph')
  assert.deepEqual(json('.claude-plugin/marketplace.json').plugins.map((p) => [p.name, p.source]), [['context-graph', './']])
  const hooks = json('hooks/hooks.json').hooks
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'Stop'])
  for (const [event, arg] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop']]) {
    assert.equal(hooks[event][0].hooks[0].command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ${arg}`)
  }
  assert.deepEqual(json('.mcp.json').mcpServers['context-graph'].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs'])
  for (const name of ['stats', 'find', 'save']) {
    const body = readFileSync(new URL(`commands/${name}.md`, root), 'utf8')
    assert.match(body, /^---\ndescription: /)
    assert.match(body, /"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cli\.mjs"/)
  }
  assert.match(readFileSync(new URL('skills/context-graph/SKILL.md', root), 'utf8'), /^---\nname: context-graph\ndescription: /)
  assert.ok(existsSync(new URL('scripts/hook.mjs', root)))
})
