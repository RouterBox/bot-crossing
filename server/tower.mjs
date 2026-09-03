/**
 * The town's line to the tower — the phone's chat relay on 127.0.0.1:3014.
 *
 * The tower is the roster of truth for the phone: every session bound to it shows there,
 * `live` while something is polling its inbox and `idle` otherwise. It also keeps one shared
 * room, `lobby`, that every bound session and the phone are in. The colony joins that room
 * as an ordinary session named `bot-crossing`, so the room can be read and written from the
 * town, and it mirrors the roster so the phone and the town never disagree about who is
 * around.
 *
 * Everything here is best effort. The tower is optional — a colony without one simply has
 * no lobby — and it restarts now and then, dropping the parked long-poll. Registrations
 * survive a restart, but re-registering is idempotent, so a failure forgets it and starts
 * over after a short wait rather than retrying hot.
 */
import { setTimeout as sleep } from 'node:timers/promises'

const TOWER = process.env.BOT_CROSSING_TOWER || 'http://127.0.0.1:3014'
const NAME = 'bot-crossing'
const NICK = 'Town Hall'
/** Room lines remembered for a page that has just loaded. */
const KEEP = 200
/** The tower caps a long-poll at 300s; the fetch is allowed a little longer. */
const WAIT_S = 300
const ROSTER_TTL_MS = 5000
const RETRY_MS = 5000

const state = {
  started: false,
  registered: false,
  error: '',
  seq: 0,
  lines: [],
  roster: [],
  rosterAt: 0,
}

async function api(path, body, signal) {
  const res = await fetch(TOWER + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) throw new Error(`tower ${path}: ${res.status}`)
  return res.json()
}

async function register() {
  await api('/session/register', {
    name: NAME,
    nick: NICK,
    description: 'Bot Crossing — the colony running on the PC',
  })
  state.registered = true
}

function remember(line) {
  state.lines.push({ n: ++state.seq, ...line })
  if (state.lines.length > KEEP) state.lines.splice(0, state.lines.length - KEEP)
}

/**
 * One parked read at a time, forever. Room lines arrive tagged `room: "lobby"`; anything
 * else in this inbox is a direct message to the town, which nobody sends yet, and is dropped.
 */
async function loop() {
  for (;;) {
    try {
      if (!state.registered) await register()
      const res = await api(`/session/inbox?name=${NAME}&wait=${WAIT_S}`, null, AbortSignal.timeout((WAIT_S + 15) * 1000))
      for (const m of res.messages || []) {
        if (m.room !== 'lobby') continue
        remember({
          at: m.at,
          from: m.from || '',
          nick: m.nick || m.from || '',
          text: String(m.text || ''),
          addressed: Boolean(m.addressed),
          self: false,
        })
      }
      state.error = ''
    } catch (err) {
      state.registered = false
      state.error = err?.name === 'TimeoutError' ? 'tower did not answer' : String(err?.message || err)
      await sleep(RETRY_MS)
    }
  }
}

/** Idempotent: the first snapshot request starts the loop, so a build never does. */
export function start() {
  if (state.started) return
  state.started = true
  loop()
}

/** Everyone the tower knows about, minus the room itself. Cached a few seconds. */
export async function roster() {
  if (Date.now() - state.rosterAt < ROSTER_TTL_MS) return state.roster
  try {
    const res = await api('/contexts')
    state.roster = (res.contexts || [])
      .filter((c) => !c.room)
      .map((c) => ({ name: c.name, nick: c.nick || c.name, state: c.state || 'idle', external: Boolean(c.external) }))
    state.rosterAt = Date.now()
  } catch (err) {
    state.error = String(err?.message || err)
  }
  return state.roster
}

/** What the page polls: new room lines since `since`, plus the roster. */
export async function snapshot(since = 0) {
  start()
  return {
    available: state.registered && !state.error,
    error: state.error,
    name: NAME,
    nick: NICK,
    seq: state.seq,
    lines: state.lines.filter((l) => l.n > since),
    roster: await roster(),
  }
}

/**
 * Post into the room as the town. The tower does not echo a session's own lines back to
 * it, so the line is remembered here as well, marked `self`. The phone speaks room lines
 * aloud by default; `speak: false` keeps a line silent there.
 */
export async function say(text, { speak = true } = {}) {
  const t = String(text || '').trim().slice(0, 2000)
  if (!t) return { ok: false, error: 'Nothing to say' }
  await api('/push', { context: 'lobby', from: NAME, text: t, speak: Boolean(speak) })
  remember({ at: new Date().toISOString(), from: NAME, nick: NICK, text: t, addressed: false, self: true })
  return { ok: true }
}
