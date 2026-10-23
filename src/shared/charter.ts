// The charter: what a goal was understood to be, agreed before anyone starts. The gate shows it, the
// Lead is briefed from it and the Ready card is checked against it, so all three read one object.
//
// Pure — the main process and the renderer both import it. Confidence is computed here, from the
// evidence a model offered, never taken from the model: asked for a number it says 90-plus nearly
// every time.

import { estimateOf } from './live'
import { enforceable } from './mergeReview'

export interface CharterAssumption {
  text: string
  /** it rests on something in the repo, named in `from` — otherwise it is a guess */
  known: boolean
  /** the path or command that backs a `known` assumption */
  from?: string
  /**
   * The key of the repo-knowledge fact a `known` assumption rests on (shared/knowledge.ts). Set by the
   * gate's evidence check and nothing else: one a model writes is not believed.
   */
  fact?: string
}

/** Which kind of gap makes a charter unsure; each has a one-question fix. */
export type Ambiguity = 'scope' | 'acceptance' | 'subject' | 'constraint'

export interface Charter {
  /** the user's own words, verbatim */
  request: string
  understood: string
  assumptions: CharterAssumption[]
  wontTouch: string[]
  /** the check that proves it, a command where possible; empty when there is none */
  doneWhen: string
  confidence: number
  ambiguity?: Ambiguity
  question?: { text: string; options: string[] }
  /** minutes the whole job was expected to take, by the model that drafted this; it colours the elapsed time and nothing else */
  estimate?: number
  /** set when this is a follow-up to a Lead already running */
  followUpTo?: string
  /** the running Lead whose team confirming this would replace, by name; set at the gate, never stored */
  replaces?: string
  at: number
}

/** Below this the charter opens to the full card; at or above it is a one-line glance. */
export const FULL_CARD_BELOW = 80

const AMBIGUITIES: Ambiguity[] = ['scope', 'acceptance', 'subject', 'constraint']

/** Strings only: a number or object where text belongs is the model's mistake, not something to show. */
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
const strs = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, max) : [])

function coerceAssumption(raw: unknown): CharterAssumption | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const text = str(a.text, 300)
  if (!text) return null
  const from = str(a.from, 200)
  const fact = str(a.fact, 80)
  // a claim of knowing is only believed once it names what it rests on
  return a.known === true && from ? { text, known: true, from, ...(fact ? { fact } : {}) } : { text, known: false }
}

function coerceQuestion(raw: unknown): Charter['question'] {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as Record<string, unknown>
  const text = str(q.text, 300)
  return text ? { text, options: strs(q.options, 80, 4) } : undefined
}

/**
 * Whatever a model replied, a charter the gate can show. A reply that is not usable costs
 * confidence (no assumptions, no check, no exclusions) but never the goal: `understood` falls back
 * to the request itself.
 */
export function coerceCharter(raw: unknown, request: string, at: number = Date.now()): Charter {
  const r: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const assumptions = (Array.isArray(r.assumptions) ? r.assumptions : []).map(coerceAssumption).filter((a): a is CharterAssumption => a !== null).slice(0, 12)
  const wontTouch = strs(r.wontTouch, 200, 20)
  const doneWhen = str(r.doneWhen, 300)
  const question = coerceQuestion(r.question)
  const ambiguity = AMBIGUITIES.find((x) => x === str(r.ambiguity, 20).toLowerCase())
  const estimate = estimateOf(r.estimate)
  return {
    request,
    understood: str(r.understood, 600) || request,
    assumptions,
    wontTouch,
    doneWhen,
    confidence: scoreConfidence({ assumptions, wontTouch, doneWhen, question }),
    ...(ambiguity ? { ambiguity } : {}),
    ...(question ? { question } : {}),
    ...(estimate ? { estimate } : {}),
    at
  }
}

/**
 * 0..100, from the work a charter shows rather than a claim it makes: the share of its assumptions
 * that cite evidence, marked down for each thing it left unsaid.
 */
export function scoreConfidence(c: Pick<Charter, 'assumptions' | 'wontTouch' | 'doneWhen' | 'question'>): number {
  // no assumptions is no work shown, which is not the same as nothing assumed
  let n = c.assumptions.length ? Math.round((c.assumptions.filter((a) => a.known).length / c.assumptions.length) * 100) : 50
  // a rule the merge gate cannot hold anyone to (a description) is no rule
  if (!c.wontTouch.some(enforceable)) n -= 10
  // however well the rest is known, nothing says when it is finished
  if (!c.doneWhen.trim()) n = Math.min(n, 60)
  if (c.question) n = Math.min(n, 70)
  return Math.max(0, Math.min(100, n))
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)
const one = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * What the Lead is told the job is, in place of the user's raw words. One line of plain text: it is
 * typed into a terminal, where a newline submits it and markdown is just noise.
 */
export function charterBrief(c: Charter): string {
  const parts = [sentence(one(c.understood))]
  if (c.assumptions.length) {
    parts.push(sentence(`Assumptions: ${c.assumptions.map((a) => (a.known && a.from ? `${one(a.text)} (from ${one(a.from)})` : `${one(a.text)} (a guess)`)).join('; ')}`))
  }
  if (c.wontTouch.length) parts.push(sentence(`Do not touch: ${c.wontTouch.map(one).join(', ')}`))
  if (c.doneWhen.trim()) parts.push(sentence(`Done when: ${one(c.doneWhen)}`))
  return parts.join(' ')
}

/**
 * What the Lead is told about a piece of work: the charter, and the goal after it when the goal is more
 * than the request the user typed (a playbook's step list, Oracle's rewrite). The charter says what the job
 * is and how it is known to be done; such a goal says how to go about it, which the charter does not. One
 * rule, for the Lead's first message and for a follow-up to it, so the two cannot disagree. One line, like
 * the brief.
 */
export function charterMessage(c: Charter, goal: string): string {
  const brief = charterBrief(c)
  const how = one(goal)
  return how && how !== one(c.request) ? `${brief} ${how}` : brief
}
