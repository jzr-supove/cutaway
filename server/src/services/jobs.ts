import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { JobKind, JobState } from '../types.ts'

interface Entry {
  state: JobState
  emitter: EventEmitter
  finishedAt: number | null
}

/** Finished jobs are dropped after this long, so the map cannot grow forever. */
const RETENTION_MS = 30 * 60 * 1000

class JobRegistry {
  #jobs = new Map<string, Entry>()

  create(kind: JobKind, phase: string): JobState {
    const state: JobState = {
      id: randomUUID(),
      kind,
      status: 'running',
      phase,
      percent: null,
      speed: null,
      eta: null,
      result: null,
      error: null,
    }
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0)
    this.#jobs.set(state.id, { state, emitter, finishedAt: null })
    this.#prune()
    return state
  }

  get(id: string): JobState | undefined {
    return this.#jobs.get(id)?.state
  }

  update(id: string, patch: Partial<JobState>): void {
    const entry = this.#jobs.get(id)
    if (!entry) return
    Object.assign(entry.state, patch)
    if (entry.state.status !== 'running' && entry.finishedAt === null) {
      entry.finishedAt = Date.now()
    }
    entry.emitter.emit('change', entry.state)
  }

  succeed(id: string, result: unknown): void {
    this.update(id, { status: 'done', phase: 'Done', percent: 100, result, speed: null, eta: null })
  }

  fail(id: string, error: string): void {
    this.update(id, { status: 'error', phase: 'Failed', error, speed: null, eta: null })
  }

  /** Returns an unsubscribe function. Fires immediately with current state. */
  subscribe(id: string, listener: (state: JobState) => void): () => void {
    const entry = this.#jobs.get(id)
    if (!entry) return () => {}
    listener(entry.state)
    entry.emitter.on('change', listener)
    return () => entry.emitter.off('change', listener)
  }

  #prune(): void {
    const cutoff = Date.now() - RETENTION_MS
    for (const [id, entry] of this.#jobs) {
      if (entry.finishedAt !== null && entry.finishedAt < cutoff) this.#jobs.delete(id)
    }
  }
}

export const jobs = new JobRegistry()
