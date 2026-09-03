#!/usr/bin/env node
/**
 * Claude Code hooks that keep the tower's roster equal to the sessions actually running.
 *
 * The phone shows whatever the tower knows about, and the town mirrors the same list, so
 * the way to make "if I see a bot on the phone I see it in the town, and vice versa" true
 * is to register every session as it starts and drop it as it ends — from the session
 * itself, which is the only thing that knows both moments.
 *
 *   SessionStart → node tools/tower-hooks.mjs register
 *   SessionEnd   → node tools/tower-hooks.mjs remove
 *
 * Claude Code hands a hook one JSON object on stdin (`session_id`, `cwd`, `hook_event_name`,
 * …). The context is named `<repo>-<six chars of the id>` so two sessions in one repo stay
 * apart; the nick is the repo, which is what the room is asked to call things after. Sessions
 * registered this way carry `kind: "auto"` and show `idle` on the phone until something
 * parks a long-poll on their inbox — that is honest: nobody is listening. `sessionId`, `cwd`
 * and `pid` ride along so the tower can key a context to a Claude session and prune one
 * whose process has died, once it reads those fields.
 *
 * Never installed by this repo. It goes in Claude Code's own settings, which are the user's:
 *
 *   "hooks": {
 *     "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/github/bot-crossing/tools/tower-hooks.mjs register" }] }],
 *     "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node C:/github/bot-crossing/tools/tower-hooks.mjs remove" }] }]
 *   }
 *
 * A hook must never break a session: every failure here is swallowed, and the tower being
 * down is the normal case on a machine where it is not running.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOWER = process.env.BOT_CROSSING_TOWER || 'http://127.0.0.1:3014'
const action = process.argv[2]

/**
 * The pid of the Claude Code process itself — not `process.ppid`, which is the throwaway
 * shell the hook runs under and is dead before the tower looks at it (the tower prunes a
 * context whose pid has gone, which is exactly what we want it to do to real sessions).
 * Claude Code registers every live process in `~/.claude/sessions/<pid>.json` with its
 * session id, so the pid is looked up by that. Unknown means unknown: no pid is sent.
 */
function claudePidFor(sessionId) {
  if (!sessionId) return undefined
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return undefined
  }
  for (const name of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (rec.sessionId === sessionId && Number.isInteger(rec.pid)) return rec.pid
    } catch {
      /* a record mid-write; skip it */
    }
  }
  return undefined
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

async function post(route, body) {
  const res = await fetch(TOWER + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  })
  return res.ok
}

function contextFor(hook) {
  const id = String(hook.session_id || '')
  const cwd = String(hook.cwd || process.cwd())
  const repo = path.basename(cwd) || 'session'
  return { name: `${repo}-${id.slice(0, 6) || 'unknown'}`, nick: repo, sessionId: id, cwd }
}

async function main() {
  const hook = await readStdin()
  const ctx = contextFor(hook)
  if (action === 'register') {
    await post('/session/register', {
      name: ctx.name,
      nick: ctx.nick,
      description: `Claude Code session in ${ctx.cwd}`,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      pid: claudePidFor(ctx.sessionId),
      kind: 'auto',
    })
  } else if (action === 'remove') {
    // Remove, not unregister: unregister leaves the thread on the phone routed to RCL, and
    // a session that has ended has nothing left to say there.
    await post('/contexts/remove', { name: ctx.name })
  } else {
    process.stderr.write('usage: tower-hooks.mjs register|remove  (hook JSON on stdin)\n')
    process.exitCode = 2
  }
}

main().catch(() => {
  /* the tower is optional; a hook that fails must not break the session */
})
