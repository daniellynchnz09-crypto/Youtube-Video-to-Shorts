import type { VideoMetadata } from '../../../shared/types.js'

/**
 * Formats the source video's metadata into a compact block for the analyzer
 * and title prompts. Descriptions run long (link dumps, socials, timestamps),
 * so they're truncated — the useful context is almost always in the opening
 * lines. Returns '' when there's nothing usable, so callers can drop the
 * whole context section rather than emit empty headings.
 */
const MAX_DESCRIPTION_CHARS = 700
const MAX_TAGS = 30

export function formatVideoMetadata(metadata: VideoMetadata | undefined): string {
  if (!metadata) return ''
  const lines: string[] = []

  const title = metadata.title.trim()
  if (title) lines.push(`Video title: ${title}`)

  const description = metadata.description.trim()
  if (description) {
    const trimmed =
      description.length > MAX_DESCRIPTION_CHARS
        ? `${description.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`
        : description
    lines.push(`Video description: ${trimmed}`)
  }

  if (metadata.tags.length > 0) {
    lines.push(`Video tags: ${metadata.tags.slice(0, MAX_TAGS).join(', ')}`)
  }

  return lines.join('\n')
}
