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
  /** Highest tower transcript seq read for the room, and when it was last asked. */
  latest: 0,
  linesAt: 0,
  /** Tower seqs that have a persisted clip, and the cursor for the next index read. */
  clips: new Map(),
  clipsSince: 0,
  clipsAt: 0,
}
const LINES_TTL_MS = 3000

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
 * A room line as the tower's transcript stores it: `Nick: text`, with `role` saying whether
 * it was the phone. The nick is read back off the front. Whether the line is aimed at the
 * town is judged here, since the transcript does not say.
 */
function fromTranscript(l) {
  const text = String(l.text || '')
  const cut = text.indexOf(': ')
  const nick = cut > 0 && cut < 40 ? text.slice(0, cut) : ''
  const body = nick ? text.slice(cut + 2) : text
  return {
    seq: l.seq,
    at: l.at,
    from: l.role === 'user' ? 'user' : '',
    nick: nick || (l.role === 'user' ? 'Phone' : 'Tower'),
    text: body,
    addressed: /@(town|bot-crossing|everyone)\b/i.test(body),
    self: nick === NICK,
  }
}

/**
 * Room lines come from the tower's transcript rather than the inbox: the transcript carries
 * the tower's own `seq`, which is what a clip is filed under, and it survives a tower
 * restart, which the inbox does not. Polled on demand, a few seconds apart at most.
 */
async function pullLines() {
  if (Date.now() - state.linesAt < LINES_TTL_MS) return
  const res = await api(`/transcript?context=lobby&since=${state.latest}`)
  let lines = res.lines || []
  // First read: only the recent past, so the pane opens on a page of history, not months.
  if (!state.latest) lines = lines.slice(-HISTORY)
  for (const l of lines) {
    if (l.seq <= state.latest) continue
    remember(fromTranscript(l))
    state.latest = l.seq
  }
  if (res.latest > state.latest) state.latest = res.latest
  state.linesAt = Date.now()
}

/** Which room seqs have a clip on the tower. The index is cheap; probing seqs is not. */
async function pullClips() {
  if (Date.now() - state.clipsAt < LINES_TTL_MS) return
  const res = await api(`/audio?context=lobby&since=${state.clipsSince}`)
  for (const c of res.clips || []) {
    state.clips.set(c.seq, { seq: c.seq, nick: c.nick || '', at: c.at, ms: c.ms || 0 })
    if (c.seq > state.clipsSince) state.clipsSince = c.seq
  }
  // Keep the map to the same window as the lines.
  const floor = state.lines.length ? state.lines[0].seq || 0 : 0
  for (const seq of state.clips.keys()) if (seq < floor) state.clips.delete(seq)
  state.clipsAt = Date.now()
}

/** How much of the room's past a fresh town shows. */
const HISTORY = 60

/**
 * One parked read at a time, forever. Holding a long-poll on the town's inbox is what makes
 * the tower report it `live`; the messages themselves are not used — room lines are read
 * from the transcript, where they carry the tower's seq — so the inbox is simply drained.
 */
async function loop() {
  for (;;) {
    try {
      if (!state.registered) await register()
      await api(`/session/inbox?name=${NAME}&wait=${WAIT_S}`, null, AbortSignal.timeout((WAIT_S + 15) * 1000))
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
      .map((c) => ({
        name: c.name,
        nick: c.nick || c.name,
        state: c.state || 'idle',
        external: Boolean(c.external),
        // The join to a robot: a context registered with its Claude session id.
        sessionId: c.sessionId || '',
        kind: c.kind || '',
        cwd: c.cwd || '',
      }))
    state.rosterAt = Date.now()
  } catch (err) {
    state.error = String(err?.message || err)
  }
  return state.roster
}

/**
 * What the page polls: new room lines since `since`, the roster, and which tower seqs
 * have a clip. Reading is what drives the transcript and clip index reads, so a town with
 * no page open asks the tower for nothing but its own liveness.
 */
export async function snapshot(since = 0) {
  start()
  try {
    if (state.registered) {
      await pullLines()
      await pullClips()
      state.error = ''
    }
  } catch (err) {
    state.error = String(err?.message || err)
  }
  return {
    available: state.registered && !state.error,
    error: state.error,
    name: NAME,
    nick: NICK,
    seq: state.seq,
    lines: state.lines.filter((l) => l.n > since),
    clips: [...state.clips.values()],
    roster: await roster(),
  }
}

/**
 * The tower can open a new Claude Code session in a terminal on the PC's screen: a folder
 * under C:/github, a name, and it binds itself to the phone and the town on start. The
 * town only relays; the tower validates the folder, refuses a name already in use, and
 * decides what the session is allowed to do. A tower without the route reports the button
 * unavailable rather than failing on the click.
 */
export async function spawnDirs() {
  try {
    const res = await fetch(`${TOWER}/spawn/dirs`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { available: false, dirs: [] }
    const body = await res.json()
    return { available: true, dirs: body.dirs || body || [] }
  } catch {
    return { available: false, dirs: [] }
  }
}

export async function spawn({ dir, name, nick, voiceId, bypass }) {
  const cleanName = String(name || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(cleanName)) return { ok: false, error: 'Name must be kebab-case: letters, digits, dashes' }
  if (typeof dir !== 'string' || !dir) return { ok: false, error: 'Pick a folder' }
  const res = await fetch(`${TOWER}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, name: cleanName, nick: nick ? String(nick).trim() : undefined, voiceId: voiceId || undefined, bypass: bypass !== false }),
    signal: AbortSignal.timeout(15000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: body.error || `tower said ${res.status}` }
  return { ok: true, ...body }
}

/** Stream one clip through from the tower, so the page never talks to it directly. */
export async function clip(seq) {
  const n = Number(seq)
  if (!Number.isInteger(n) || n <= 0) return null
  const res = await fetch(`${TOWER}/audio/${n}`)
  if (!res.ok) return null
  return { type: res.headers.get('content-type') || 'audio/mpeg', body: Buffer.from(await res.arrayBuffer()) }
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
  // The transcript will carry it back with its seq on the next pull; nothing to remember here.
  state.linesAt = 0
  return { ok: true }
}
