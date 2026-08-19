import { z } from 'zod'

/**
 * Validates the untrusted JSON that comes back from the Groq LLM calls
 * before it touches the DB or gets passed into a Remotion render.
 */

export const wordTimestampSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative()
})

export const segmentSchema = z
  .object({
    startTime: z.number().nonnegative(),
    endTime: z.number().positive(),
    reason: z.string().min(1),
    /** false when the segment is a quick cut before the speaker pivots to a
     * new, unexplored topic — lets the title generator avoid basing the
     * title on a trailing tease the clip doesn't actually show. */
    endsAtSentenceEnd: z.boolean()
  })
  .refine((s) => s.endTime > s.startTime, { message: 'endTime must be after startTime' })

export const titleResponseSchema = z.object({
  title: z.string().min(1).max(120)
})

export type Segment = z.infer<typeof segmentSchema>
export type TitleResponse = z.infer<typeof titleResponseSchema>
