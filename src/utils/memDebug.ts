/**
 * Memory diagnostic logger for openclaude #546 investigation.
 *
 * Emits a JSON-line record per logged turn capturing:
 *   - process.memoryUsage() snapshot
 *   - tool-result retention stats (count, bytes, top-3 largest)
 *   - ContentReplacementState stats
 *   - scrubber + LRU eviction counts since previous emit
 *
 * Records land on stderr (so tmux scrollback captures them) AND in
 * ~/.openclaude/mem-debug-<pid>.jsonl (so a post-mortem after a hard OOM
 * still has the trail). We sample on the first few turns (to confirm the
 * patched build is loaded) and then every N turns, with extra emits when
 * heapUsed crosses one of a small set of thresholds.
 *
 * Activation is automatic for builds where this module is included; opt
 * out by setting OPENCLAUDE_MEM_DEBUG=0. Override sampling cadence via
 * OPENCLAUDE_MEM_DEBUG_EVERY (default 25).
 */

import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const HEAP_THRESHOLDS_BYTES = [
  256 * 1024 * 1024,
  384 * 1024 * 1024,
  512 * 1024 * 1024,
  768 * 1024 * 1024,
  1024 * 1024 * 1024,
  1536 * 1024 * 1024,
  2048 * 1024 * 1024,
  3072 * 1024 * 1024,
]

const STATE = {
  initialized: false,
  enabled: false,
  every: 25,
  turn: 0,
  lastThresholdIdx: -1,
  probeLastThresholdIdx: -1,
  firstProbeSent: false,
  startedAt: 0,
  logFile: '',
}

function init() {
  if (STATE.initialized) return
  STATE.initialized = true
  const flag = process.env.OPENCLAUDE_MEM_DEBUG
  STATE.enabled = flag !== '0' && flag !== 'false'
  const every = Number.parseInt(
    process.env.OPENCLAUDE_MEM_DEBUG_EVERY ?? '',
    10,
  )
  STATE.every = Number.isFinite(every) && every > 0 ? every : 1
  STATE.startedAt = Date.now()
  try {
    const dir = join(homedir(), '.openclaude')
    mkdirSync(dir, { recursive: true })
    STATE.logFile = join(dir, `mem-debug-${process.pid}.jsonl`)
  } catch {
    STATE.logFile = ''
  }
  if (STATE.enabled) {
    emitBanner()
  }
}

function emitBanner() {
  const banner = {
    event: 'memdebug_banner',
    ts: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    title: process.title,
    keepRecentToolResults: parseEnvKeepRecent(),
    crsCap: parseEnvCRSCap(),
    every: STATE.every,
    logFile: STATE.logFile,
  }
  writeRecord(banner)
}

export function parseEnvKeepRecent(): number {
  const raw = process.env.OPENCLAUDE_KEEP_RECENT_TOOL_RESULTS
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100
}

export function parseEnvCRSCap(): number {
  const raw = process.env.OPENCLAUDE_CRS_MAX
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000
}

function writeRecord(record: Record<string, unknown>) {
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    line = JSON.stringify({ event: 'memdebug_serialization_failed' })
  }
  try {
    process.stderr.write(`[openclaude:memdebug] ${line}\n`)
  } catch {
    /* ignore */
  }
  if (STATE.logFile) {
    try {
      appendFileSync(STATE.logFile, line + '\n')
    } catch {
      /* ignore */
    }
  }
}

function shouldEmit(heapUsed: number): boolean {
  if (!STATE.enabled) return false
  if (STATE.turn <= 5) return true
  if (STATE.turn % STATE.every === 0) return true
  for (let i = HEAP_THRESHOLDS_BYTES.length - 1; i >= 0; i--) {
    if (heapUsed >= HEAP_THRESHOLDS_BYTES[i]! && STATE.lastThresholdIdx < i) {
      STATE.lastThresholdIdx = i
      return true
    }
  }
  return false
}

export type MemDebugSnapshot = {
  retention: {
    totalMessages: number
    userMessages: number
    withToolUseResult: number
    approxBytes: number
    topPayloads: Array<{ index: number; size: number; toolUseId?: string }>
  }
  crs: { seenIds: number; replacements: number; approxReplacementBytes: number }
  scrubbed: number // newly-scrubbed messages this turn
  evicted: number // newly-evicted CRS entries this turn
  contentScrubbed?: number
  contentScrubbedBytes?: number
}

export function emitTurnSnapshot(snap: MemDebugSnapshot) {
  init()
  STATE.turn++
  if (!STATE.enabled) return
  const mu = process.memoryUsage()
  if (!shouldEmit(mu.heapUsed)) return
  writeRecord({
    event: 'memdebug_turn',
    ts: new Date().toISOString(),
    turn: STATE.turn,
    uptimeSec: Math.round((Date.now() - STATE.startedAt) / 1000),
    mem: {
      rss: mu.rss,
      heapTotal: mu.heapTotal,
      heapUsed: mu.heapUsed,
      external: mu.external,
      arrayBuffers: mu.arrayBuffers,
    },
    ret: snap.retention,
    crs: snap.crs,
    scrubbedThisTurn: snap.scrubbed,
    crsEvictedThisTurn: snap.evicted,
    contentScrubbedThisTurn: snap.contentScrubbed ?? 0,
    contentScrubbedBytes: snap.contentScrubbedBytes ?? 0,
  })
}

/**
 * Intra-turn probe — called from hotspots that may allocate large amounts
 * mid-turn (tool execution, API stream completion, message normalization).
 * Logs only when heap crosses a new threshold, so cheap to leave wired in.
 *
 * Why this exists: fix546.2's turn-boundary probe missed the climb on
 * disko because the heap went from 420 MB at turn 5 directly to OOM before
 * the next turn boundary. Single tool calls (giant Reads, big API streams)
 * can blow the heap inside a turn. We need to catch that within-turn delta.
 */
export function emitProbe(
  label: string,
  extras?: Record<string, unknown>,
): void {
  init()
  if (!STATE.enabled) return
  const mu = process.memoryUsage()
  // Probes only emit on heap-threshold crossings — they're called from hot
  // loops so per-tool emit would be noise. Threshold table is cumulative
  // across turn+probe emits via shouldEmit's lastThresholdIdx.
  let fire = false
  for (let i = HEAP_THRESHOLDS_BYTES.length - 1; i >= 0; i--) {
    if (mu.heapUsed >= HEAP_THRESHOLDS_BYTES[i]! && STATE.probeLastThresholdIdx < i) {
      STATE.probeLastThresholdIdx = i
      fire = true
      break
    }
  }
  // Always fire on the first probe of a session (validates the wiring).
  if (!STATE.firstProbeSent) {
    STATE.firstProbeSent = true
    fire = true
  }
  if (!fire) return
  writeRecord({
    event: 'memdebug_probe',
    ts: new Date().toISOString(),
    label,
    turn: STATE.turn,
    uptimeSec: Math.round((Date.now() - STATE.startedAt) / 1000),
    mem: {
      rss: mu.rss,
      heapTotal: mu.heapTotal,
      heapUsed: mu.heapUsed,
      external: mu.external,
      arrayBuffers: mu.arrayBuffers,
    },
    ...(extras ?? {}),
  })
}
