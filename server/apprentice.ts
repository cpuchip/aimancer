// The apprentice's I/O half: env config + the OpenAI-compatible chat call.
// Any /v1/chat/completions endpoint works (llama-chip's router, llama.cpp,
// OpenAI, vLLM, LM Studio…). Configure via env — NEVER commit values:
//   APPRENTICE_BASE_URL      e.g. http://127.0.0.1:8090/v1  (unset = practice mode)
//   APPRENTICE_MODEL_CHEAP   model id for cheap drafts
//   APPRENTICE_MODEL_SMART   model id for smart drafts
//   APPRENTICE_API_KEY       optional bearer
//   APPRENTICE_TIMEOUT_MS    per-request cap (default 20000) — on timeout the
//                            room refunds via a draftFailed command
// The pure half (prompts, parsing, seeded flaw injection) is shared/apprentice.ts.

import { parseDrafts, systemPrompt, userPrompt, type SeatBrief } from '../shared/apprentice.ts'
import type { DraftTier, Script } from '../shared/sim/types.ts'

export interface ApprenticeConfig {
  baseUrl: string
  modelCheap: string
  modelSmart: string
  apiKey?: string
  timeoutMs: number
}

/** Read the env each call (cheap, and tests can vary it). null = practice mode. */
export function apprenticeConfig(): ApprenticeConfig | null {
  const baseUrl = (process.env.APPRENTICE_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (!baseUrl) return null
  const modelCheap = (process.env.APPRENTICE_MODEL_CHEAP ?? '').trim()
  const modelSmart = (process.env.APPRENTICE_MODEL_SMART ?? '').trim()
  return {
    baseUrl,
    modelCheap: modelCheap || modelSmart || 'default',
    modelSmart: modelSmart || modelCheap || 'default',
    apiKey: (process.env.APPRENTICE_API_KEY ?? '').trim() || undefined,
    timeoutMs: Math.max(1000, Number(process.env.APPRENTICE_TIMEOUT_MS) || 20000),
  }
}

export function apprenticeMode(): 'live' | 'practice' {
  return apprenticeConfig() ? 'live' : 'practice'
}

/** One real draft call. Returns the PARSED drafts ([] = the model returned
 * gibberish — the caller's organic-fallback path). Throws on network error or
 * timeout — the caller refunds via draftFailed. */
export async function fetchDrafts(cfg: ApprenticeConfig, tier: DraftTier, brief: SeatBrief, order?: string): Promise<Script[]> {
  const model = tier === 'smart' ? cfg.modelSmart : cfg.modelCheap
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(brief, order) },
        ],
        temperature: 0.7,
        // generous: thinking-tuned local models burn budget before answering
        max_tokens: 2000,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`apprentice endpoint ${res.status}`)
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = body.choices?.[0]?.message?.content ?? ''
    return parseDrafts(content)
  } finally {
    clearTimeout(timer)
  }
}
