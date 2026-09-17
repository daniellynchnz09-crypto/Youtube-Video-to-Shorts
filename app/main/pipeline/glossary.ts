import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type GlossaryCategory =
  | 'person'
  | 'level'
  | 'difficulty'
  | 'mechanic'
  | 'version'
  | 'song'
  | 'reference'

export interface GlossaryEntry {
  term: string
  category: GlossaryCategory
  aliases: string[]
  misheard: string[]
  definition: string
}

interface GlossaryFile {
  entries: GlossaryEntry[]
  /** extra game/community-specific words to ignore when guessing new terms */
  candidateStopwords?: string[]
  /** base URL (no trailing slash) of the game's community wiki, e.g. a Fandom site — used by wikiLookup.ts */
  wikiBaseUrl?: string
}

/**
 * The real glossary (`glossary.json`) is a local, gitignored file — it holds
 * the specific game/community terminology the channel covers. A generic
 * `glossary.example.json` is committed so a fresh checkout still runs.
 */
function loadFile(): GlossaryFile {
  const real = join(__dirname, 'glossary.json')
  const path = existsSync(real) ? real : join(__dirname, 'glossary.example.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as GlossaryFile
}

let cachedFile: GlossaryFile | null = null
function file(): GlossaryFile {
  if (!cachedFile) cachedFile = loadFile()
  return cachedFile
}

export function loadGlossary(): GlossaryEntry[] {
  return file().entries
}

export function getWikiBaseUrl(): string | undefined {
  return file().wikiBaseUrl
}

function phraseRegex(form: string): RegExp {
  // Whole-token match, case-insensitive; internal whitespace matches any run
  // of whitespace/punctuation so "top 1" also matches "top-1".
  const escaped = form
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s\\-]+')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i')
}

export interface GlossaryMatch {
  entry: GlossaryEntry
  /** the surface strings actually found in the text */
  matchedForms: string[]
  /** true when ONLY a misheard form matched — the transcript's spelling is probably wrong */
  viaMisheardOnly: boolean
}

/**
 * Finds every glossary entry referenced in `text` (by term, alias, or a
 * known mis-transcription). Used to inject only the relevant definitions
 * into the analyzer/title prompts, and to flag known terms during the
 * new-video transcript review.
 */
export function matchGlossary(text: string, glossary: GlossaryEntry[] = loadGlossary()): GlossaryMatch[] {
  const matches: GlossaryMatch[] = []
  for (const entry of glossary) {
    const correct = [entry.term, ...entry.aliases]
    const found: string[] = []
    let anyCorrect = false
    for (const form of correct) {
      if (phraseRegex(form).test(text)) {
        found.push(form)
        anyCorrect = true
      }
    }
    for (const form of entry.misheard) {
      if (phraseRegex(form).test(text)) found.push(form)
    }
    if (found.length > 0) {
      matches.push({ entry, matchedForms: [...new Set(found)], viaMisheardOnly: !anyCorrect })
    }
  }
  return matches
}

const KNOWN_FORMS = (() => {
  const set = new Set<string>()
  for (const e of loadGlossary()) {
    for (const f of [e.term, ...e.aliases, ...e.misheard]) set.add(f.toLowerCase())
  }
  return set
})()

const KNOWN_COMPACT = [...KNOWN_FORMS].map((f) => f.replace(/[^a-z0-9]/g, ''))

const CONTRACTION = /^(?:i|you|he|she|we|they|it|that|there|here|what|who|let)'[a-z]+$/i

function isKnownOrFragment(phrase: string): boolean {
  const lower = phrase.toLowerCase()
  if (KNOWN_FORMS.has(lower)) return true
  const compact = lower.replace(/[^a-z0-9]/g, '')
  // Drop fragments of a known multi-word term (e.g. one word of a two-word
  // level name) and phrases built only from known terms.
  return KNOWN_COMPACT.some((k) => k.length >= 4 && (k.includes(compact) || compact.includes(k)))
}

/**
 * Generic words that show up capitalised or shouted in transcripts but
 * aren't terminology — sentence-openers and common exclamations. The
 * glossary file can add game/community-specific ones via `candidateStopwords`.
 */
const GENERIC_STOPWORDS = [
  'youtube', 'discord', 'god', 'okay', 'yeah', 'wow', 'oh', 'nah', 'hey',
  'i', 'a', 'the', 'and', 'but', 'so', 'in', 'it', 'we', 'you', 'they', 'this', 'that', 'today',
  'anyway', 'actually', 'yes', 'no', 'what', 'why', 'how', 'when', 'well', 'now', 'also', 'like',
  'million', 'millions', 'get', 'ready', 'turn', 'back', 'hold', 'stop', 'trying'
]

const CANDIDATE_STOPWORDS = new Set(
  [...GENERIC_STOPWORDS, ...(file().candidateStopwords ?? [])].map((w) => w.toLowerCase())
)

/**
 * Best-effort extraction of terminology that might be new to the glossary —
 * for the new-video transcript review. Flags ALL-CAPS runs (WhisperX renders
 * on-screen names and shouted callouts this way) and repeated TitleCase
 * phrases, minus anything already in the glossary or the stoplist. Imperfect
 * by design; the user curates the result.
 */
export function findUnknownTermCandidates(text: string): string[] {
  const candidates = new Map<string, number>()
  const add = (phrase: string): void => {
    const key = phrase.replace(/[^A-Za-z0-9' ]/g, '').trim()
    if (key.length < 3) return
    if (CONTRACTION.test(key)) return
    const lower = key.toLowerCase()
    if (isKnownOrFragment(key)) return
    if (lower.split(' ').every((w) => CANDIDATE_STOPWORDS.has(w))) return
    candidates.set(key, (candidates.get(key) ?? 0) + 1)
  }

  // ALL-CAPS runs (>= 3 letters somewhere in the run)
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9']{2,}(?:\s+[A-Z][A-Z0-9']{1,})*)\b/g)) add(m[1]!)

  // TitleCase runs of 2+ words, not counting a leading sentence-opener cap
  for (const m of text.matchAll(/(?<=[a-z,;:]\s)([A-Z][a-z']+(?:\s+[A-Z][a-z']+)+)/g)) add(m[1]!)

  // Single capitalised words appearing 2+ times mid-sentence
  const singles = new Map<string, number>()
  for (const m of text.matchAll(/(?<=[a-z,;:]\s)([A-Z][a-z']{2,})/g)) {
    singles.set(m[1]!, (singles.get(m[1]!) ?? 0) + 1)
  }
  for (const [word, n] of singles) if (n >= 2) add(word)

  return [...candidates.keys()].sort((a, b) => a.localeCompare(b))
}

/**
 * Canonical spellings of proper nouns (people, levels, songs, external
 * references) for Whisper's `initial_prompt` — these are the terms the model
 * mishears. Mechanics/difficulty terms are left out: they transcribe fine
 * and would just eat the prompt's limited token budget.
 */
export function glossaryHintNames(glossary: GlossaryEntry[] = loadGlossary()): string {
  const proper: GlossaryCategory[] = ['person', 'level', 'song', 'reference']
  return glossary
    .filter((e) => proper.includes(e.category))
    .map((e) => e.term)
    .join(', ')
}

/**
 * A definitions block for the analyzer / title prompts, built from the
 * entries that actually appear in the clip or transcript. `viaMisheardOnly`
 * entries also tell the model the transcript's spelling is wrong.
 *
 * `maxDefinitionChars` trims long definitions — the analyzer prompt is tight
 * on Groq's per-minute token budget and only needs the gist, while the title
 * prompt can afford the full text.
 */
export function formatGlossaryForPrompt(
  matches: GlossaryMatch[],
  { maxDefinitionChars = Infinity }: { maxDefinitionChars?: number } = {}
): string {
  if (matches.length === 0) return ''
  const lines = matches.map(({ entry, matchedForms, viaMisheardOnly }) => {
    let def = entry.definition
    if (def.length > maxDefinitionChars) {
      def = `${def.slice(0, maxDefinitionChars).replace(/\s+\S*$/, '')}…`
    }
    const wrongSpelling =
      viaMisheardOnly && matchedForms.length > 0
        ? ` (the transcript spells this "${matchedForms[0]}" — the correct spelling is "${entry.term}")`
        : ''
    return `- ${entry.term} (${entry.category}): ${def}${wrongSpelling}`
  })
  return lines.join('\n')
}
