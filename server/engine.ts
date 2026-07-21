// The ENGINE HOST — one long-lived `aimancer-engine` (Go, Starlark) subprocess
// serving every room in this server. Line-delimited JSON: requests down stdin,
// one response line each on stdout, `{"type":"hello",...}` handshake first
// (see aimancer-go cmd/aimancer-engine + test/node-harness.mjs — this file is
// that harness productionized).
//
// FAULT MODEL (the probe's ruling, honored): the engine is deterministic, so
// a wall-clock timeout or crash is a SEAT fault, never replay state — we kill,
// respawn, reject the in-flight requests, and the affected scripts simply
// don't act that tick. The deployment container's memory limit is the hard
// wall behind the engine's own watchdog (see Dockerfile / docker-compose).
//
// Binary resolution (dev → prod):
//   1. $AIMANCER_ENGINE_BIN — explicit path (the Docker image sets this)
//   2. ./aimancer-engine(.exe) in the repo root
//   3. `go build` from the sibling checkout ($AIMANCER_GO_DIR or ../aimancer-go)
//      into node_modules/.cache/ — local dev needs Go once, then it's cached.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import type { EngineInfo } from '../shared/protocol.ts'
import type { Action } from '../shared/sim/types.ts'

export interface EngineRequest {
  id: string
  script: string
  world: unknown
  seed: number
  tick: number
  gasLimit: number
  memory: Record<string, unknown>
}

export interface EngineResponse {
  id: string
  actions: Action[]
  logs: string[]
  gasUsed: number
  memory: Record<string, unknown>
  err?: string
}

/** Per-request wall-clock budget. A hostile single op can burn CPU without
 * burning gas (engine package doc) — this is the wall the engine asks us to
 * hold. Timeout ⇒ kill + respawn (determinism makes respawn safe). */
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 2_000

export function resolveEngineBin(): string | null {
  const envBin = process.env.AIMANCER_ENGINE_BIN
  if (envBin && existsSync(envBin)) return envBin
  const exe = process.platform === 'win32' ? '.exe' : ''
  const local = resolve(process.cwd(), `aimancer-engine${exe}`)
  if (existsSync(local)) return local
  // build from the sibling checkout (dev path; cached until it changes)
  const goDir = process.env.AIMANCER_GO_DIR || resolve(process.cwd(), '..', 'aimancer-go')
  if (existsSync(join(goDir, 'cmd', 'aimancer-engine', 'main.go'))) {
    const cacheDir = resolve(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const out = join(cacheDir, `aimancer-engine${exe}`)
    const r = spawnSync('go', ['build', '-o', out, './cmd/aimancer-engine'], { cwd: goDir, stdio: 'pipe' })
    if (r.status === 0 && existsSync(out)) return out
    console.error(`[engine] go build failed (${r.status}): ${r.stderr?.toString().slice(0, 400)}`)
  }
  return null
}

interface Pending {
  resolve: (r: EngineResponse) => void
  reject: (e: Error) => void
}

export class EngineHost {
  private bin: string | null
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private serial = 0
  private helloInfo: EngineInfo | null = null
  private spawning = false
  /** consecutive spawn failures — after a few, stop hammering. */
  private spawnFails = 0

  constructor(bin?: string | null) {
    this.bin = bin === undefined ? resolveEngineBin() : bin
    if (!this.bin) {
      console.error('[engine] NO ENGINE BINARY — scripts will not run. Set AIMANCER_ENGINE_BIN or build aimancer-go (see README).')
    }
  }

  get available(): boolean {
    return this.bin !== null && this.spawnFails < 5
  }

  info(): EngineInfo | null {
    return this.helloInfo
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child
    if (!this.bin || this.spawnFails >= 5 || this.spawning) return null
    this.spawning = true
    try {
      const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stderr.on('data', (b: Buffer) => console.error(`[engine] ${b.toString().trim()}`))
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => this.onLine(line))
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null
          this.failAllPending(new Error(`engine exited (${code ?? signal})`))
        }
      })
      child.on('error', (e) => {
        this.spawnFails++
        if (this.child === child) this.child = null
        this.failAllPending(new Error(`engine spawn error: ${e.message}`))
      })
      this.child = child
      return child
    } finally {
      this.spawning = false
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg['type'] === 'hello') {
      this.spawnFails = 0
      this.helloInfo = {
        engine: String(msg['engine'] ?? 'aimancer-engine'),
        version: String(msg['version'] ?? '?'),
        language: String(msg['language'] ?? 'starlark'),
        protocol: Number(msg['protocol'] ?? 0),
      }
      return
    }
    const id = String(msg['id'] ?? '')
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve({
      id,
      actions: Array.isArray(msg['actions']) ? (msg['actions'] as Action[]) : [],
      logs: Array.isArray(msg['logs']) ? (msg['logs'] as string[]) : [],
      gasUsed: Number(msg['gasUsed'] ?? 0),
      memory: (msg['memory'] as Record<string, unknown>) ?? {},
      err: typeof msg['err'] === 'string' ? (msg['err'] as string) : undefined,
    })
  }

  private failAllPending(e: Error): void {
    for (const [, p] of this.pending) p.reject(e)
    this.pending.clear()
  }

  /** Kill the subprocess (wedged or hostile) — the next run respawns fresh. */
  private killChild(): void {
    const c = this.child
    this.child = null
    if (c) {
      try {
        c.kill()
      } catch {
        /* already gone */
      }
    }
  }

  /** Run one script for one tick. Rejects on engine fault (timeout, crash,
   * no binary) — the caller treats a rejection as a SEAT fault: the script
   * does not act this tick and the log records nothing for it. */
  run(req: Omit<EngineRequest, 'id'>, timeoutMs = TIMEOUT_MS): Promise<EngineResponse> {
    const child = this.ensureChild()
    if (!child) return Promise.reject(new Error('engine unavailable'))
    const id = `r${++this.serial}`
    return new Promise<EngineResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          // the engine may be wedged in a hostile script — kill and respawn;
          // every other in-flight request on this child faults with it
          this.killChild()
          this.failAllPending(new Error('engine timeout (sibling request)'))
          rejectPromise(new Error(`engine timeout after ${timeoutMs}ms`))
        }
      }, TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          resolvePromise(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          rejectPromise(e)
        },
      })
      child.stdin.write(JSON.stringify({ ...req, id }) + '\n', (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer)
          rejectPromise(err)
        }
      })
    })
  }

  /** Warm the subprocess (and capture the hello) without running a script. */
  async warm(): Promise<EngineInfo | null> {
    if (!this.available) return null
    this.ensureChild()
    // the hello arrives asynchronously; give it a moment
    for (let i = 0; i < 40 && !this.helloInfo; i++) await new Promise((r) => setTimeout(r, 50))
    return this.helloInfo
  }

  shutdown(): void {
    this.killChild()
    this.failAllPending(new Error('engine host shut down'))
  }
}

/** The server's singleton host (rooms share one subprocess by design). */
let host: EngineHost | null = null
export function engineHost(): EngineHost {
  if (!host) host = new EngineHost()
  return host
}
