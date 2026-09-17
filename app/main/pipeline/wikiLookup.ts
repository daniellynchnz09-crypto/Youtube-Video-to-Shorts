import Groq from 'groq-sdk'
import { z } from 'zod'
import { getWikiBaseUrl, type GlossaryCategory } from './glossary.js'

/**
 * Auto-populates glossary entries from the game's community wiki (see
 * backlog.md#game-specific-context-terminology--asset-recognition, "Wiki
 * lookup mechanics"). The wiki base URL comes from the local, gitignored
 * glossary.json (`wikiBaseUrl`) — this module has no game-specific strings
 * of its own.
 *
 * Built against a real Fandom wiki (2026-09-18) and shaped around two things
 * confirmed by hand against real terms before writing this: (1) this class of
 * wiki's `action=query&prop=extracts` (the TextExtracts extension) isn't
 * available, so content comes from `action=parse&prop=wikitext` instead —
 * raw wikitext, not clean prose, but capable LLMs handle the markup noise
 * fine for summarization; (2) a wiki can split its content across multiple
 * interlinked sites — e.g. a canonical wiki covering only the most notable
 * content directly, with a per-item interwiki link (`[[w:c:<subwiki>:Title]]`)
 * out to a companion wiki for the individual article. `resolveInterwikiLink`
 * exists specifically for that shape, confirmed against a real case: the
 * canonical wiki's overview page had only a table row for the target term,
 * linking out to a companion wiki's dedicated article with the actual detail.
 */

const SEARCH_RESULT_LIMIT = 8

interface WikiSearchHit {
  title: string
}

async function wikiApi(baseUrl: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${baseUrl}/api.php`)
  for (const [k, v] of Object.entries({ format: 'json', ...params })) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'YoutubeShortSplitter/1.0 (glossary lookup)' } })
  if (!res.ok) throw new Error(`Wiki API request failed: ${res.status} ${res.statusText} (${url})`)
  return res.json()
}

async function searchWiki(baseUrl: string, term: string): Promise<WikiSearchHit[]> {
  const data = await wikiApi(baseUrl, {
    action: 'query',
    list: 'search',
    srsearch: term,
    srlimit: String(SEARCH_RESULT_LIMIT)
  })
  return (data.query?.search ?? []).map((s: { title: string }) => ({ title: s.title }))
}

async function fetchWikitext(baseUrl: string, title: string): Promise<string | null> {
  const data = await wikiApi(baseUrl, { action: 'parse', page: title, prop: 'wikitext' })
  if (data.error) return null
  return data.parse?.wikitext?.['*'] ?? null
}

/**
 * Looks for an interwiki link to another Fandom site whose link text is a
 * close match to `term` (e.g. `[[w:c:some-subwiki:Some Level|Some Level]]`)
 * — the sign that the canonical wiki only has a passing mention/table row and
 * the real article lives on a companion wiki. Returns that subwiki's base URL
 * + page title, or null if no such link is found.
 */
function resolveInterwikiLink(wikitext: string, term: string): { baseUrl: string; title: string } | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\[\\[w:c:([a-z0-9-]+):([^|\\]]*${escaped}[^|\\]]*)(?:\\|[^\\]]*)?\\]\\]`, 'i')
  const match = wikitext.match(pattern)
  if (!match) return null
  const [, subwiki, title] = match
  return { baseUrl: `https://${subwiki}.fandom.com`, title: title!.trim() }
}

const VALID_CATEGORIES: GlossaryCategory[] = ['person', 'level', 'difficulty', 'mechanic', 'version', 'song', 'reference']

// category is a free-form string here rather than a strict enum — the free
// Groq model occasionally drifts off the requested category set (e.g.
// returning "official level" instead of "level"), and losing an otherwise
// good, grounded definition to a schema mismatch on one field is worse than
// coercing it. See the fallback in lookupTermOnWiki below.
/**
 * Truncates `text` to at most `maxChars`, centered on the term's own first
 * occurrence rather than the start of the text — see the caller's doc
 * comment for why a plain head-truncation misses long list pages entirely.
 * Falls back to head-truncation if the term isn't found verbatim (e.g. it
 * only appears via a variant spelling the regex below doesn't catch) —
 * still better than nothing, and the "found" field lets the LLM say so.
 */
function truncateAroundTerm(text: string, term: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const idx = text.toLowerCase().indexOf(term.toLowerCase())
  if (idx === -1) return `${text.slice(0, maxChars)}…`

  const halfWindow = Math.floor(maxChars / 2)
  const start = Math.max(0, idx - halfWindow)
  const end = Math.min(text.length, start + maxChars)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

const draftSchema = z.object({
  found: z.boolean(),
  category: z.string(),
  definition: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string()
})

export interface WikiLookupDraft {
  term: string
  found: boolean
  category: GlossaryCategory
  definition: string
  confidence: 'high' | 'medium' | 'low'
  notes: string
  sourceUrl: string | null
  sourceTitle: string | null
  fetchedAt: string
}

/**
 * Searches the configured wiki for `term`, resolves to the page that actually
 * has the content (following one interwiki hop if the canonical wiki only
 * has a passing mention), and asks the LLM to compress that into a short
 * glossary-style definition — grounded in the fetched wikitext so it can't
 * hallucinate specifics. `contextSentence` (the line from the video's own
 * transcript where the term came up) helps the model pick the right sense of
 * an ambiguous term and judge whether the wiki content actually matches what
 * the video is talking about.
 *
 * Returns a DRAFT only — nothing is written to the glossary here. Matches
 * the user's explicit ask to review/workshop results before they're trusted,
 * consistent with this project's "verify before shipping" practice.
 */
export async function lookupTermOnWiki(
  groq: Groq,
  term: string,
  contextSentence?: string
): Promise<WikiLookupDraft> {
  const baseUrl = getWikiBaseUrl()
  const fetchedAt = new Date().toISOString()
  if (!baseUrl) {
    return {
      term,
      found: false,
      category: 'reference',
      definition: '',
      confidence: 'low',
      notes: 'No wikiBaseUrl configured in glossary.json — nothing to search.',
      sourceUrl: null,
      sourceTitle: null,
      fetchedAt
    }
  }

  const hits = await searchWiki(baseUrl, term)
  if (hits.length === 0) {
    return {
      term,
      found: false,
      category: 'reference',
      definition: '',
      confidence: 'low',
      notes: 'No search results on the wiki for this term.',
      sourceUrl: null,
      sourceTitle: null,
      fetchedAt
    }
  }

  // Prefer a search hit whose title is (close to) the term itself; otherwise
  // fall back to the top-ranked full-text result, which may only mention the
  // term in passing (e.g. a list/overview page) rather than being about it.
  const normalizedTerm = term.toLowerCase().replace(/^the\s+/, '')
  const titleMatch = hits.find((h) => h.title.toLowerCase().replace(/^the\s+/, '') === normalizedTerm)
  let page = titleMatch ?? hits[0]!
  let wikitext = await fetchWikitext(baseUrl, page.title)
  let sourceUrl = `${baseUrl}/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`

  if (wikitext && !titleMatch) {
    const interwiki = resolveInterwikiLink(wikitext, term)
    if (interwiki) {
      const linkedText = await fetchWikitext(interwiki.baseUrl, interwiki.title)
      if (linkedText) {
        wikitext = linkedText
        page = { title: interwiki.title }
        sourceUrl = `${interwiki.baseUrl}/wiki/${encodeURIComponent(interwiki.title.replace(/ /g, '_'))}`
      }
    }
  }

  if (!wikitext) {
    return {
      term,
      found: false,
      category: 'reference',
      definition: '',
      confidence: 'low',
      notes: `Found a search hit ("${page.title}") but couldn't fetch its content.`,
      sourceUrl,
      sourceTitle: page.title,
      fetchedAt
    }
  }

  // Wikitext can run long (infoboxes, galleries, trivia, or — for a
  // multi-topic list/overview page — every other entry on the page too) —
  // cap what's sent so this stays comfortably within Groq's
  // free-tier token budget, same reasoning as MAX_DESCRIPTION_CHARS
  // elsewhere. A plain head-truncation is wrong for the list-page case
  // though: confirmed directly (2026-09-18) that a term's actual mention can
  // sit tens of thousands of characters into an ~80K-char page, past where a
  // naive head-truncation would cut — the model then correctly reports the
  // term isn't discussed in what it was shown, having never seen it. Center
  // the window on the term's own first occurrence instead, when the raw
  // wikitext isn't already short enough to send whole.
  const MAX_WIKITEXT_CHARS = 6000
  const truncated = truncateAroundTerm(wikitext, term, MAX_WIKITEXT_CHARS)

  const contextNote = contextSentence
    ? `\n\nThe term came up in this line from the video's own transcript — use it to judge whether this wiki content actually matches what's being discussed, and to help disambiguate if the article could refer to something else:\n"${contextSentence}"`
    : ''

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'user',
        content: `You're drafting one entry for a glossary of game-specific terminology, sourced from this community wiki article. Compress the article into a short, information-dense definition (1-3 sentences) that keeps the term's most important, distinguishing attributes — the kind of facts that would help someone understand a casual spoken reference to it (creator/composer if relevant, difficulty/rating, what it's notable for, how it compares to similar things). Don't pad with generic filler; every sentence should carry a real fact from the article.

Term to define: "${term}"

Set found=false if this article isn't actually about the term (e.g. it's a list page that only mentions the term in passing without enough detail to define it, or covers something different with a similar name) — don't force a definition out of unrelated content.

Category must be one of: person, level, difficulty, mechanic, version, song, reference.${contextNote}

Wiki article ("${page.title}"), raw wikitext:
${truncated}

Respond with ONLY JSON matching: { "found": boolean, "category": string, "definition": string, "confidence": "high"|"medium"|"low", "notes": string }
"notes" is for you to flag anything the user should double-check (ambiguity, missing info, uncertainty about whether this is the right article) — empty string if nothing to flag.`
      }
    ],
    response_format: { type: 'json_object' }
  })

  const raw = completion.choices[0]?.message?.content ?? '{}'
  const parsed = draftSchema.parse(JSON.parse(raw))

  const category = VALID_CATEGORIES.includes(parsed.category as GlossaryCategory)
    ? (parsed.category as GlossaryCategory)
    : 'reference'
  const notes =
    category === parsed.category
      ? parsed.notes
      : [parsed.notes, `(model returned category "${parsed.category}", not one of the valid options — defaulted to "reference", double-check)`]
          .filter(Boolean)
          .join(' ')

  return {
    term,
    found: parsed.found,
    category,
    definition: parsed.definition,
    confidence: parsed.confidence,
    notes,
    sourceUrl,
    sourceTitle: page.title,
    fetchedAt
  }
}
