export type ProjectStatus = 'pending' | 'transcribing' | 'analyzing' | 'rendering' | 'ready' | 'failed'

export interface Project {
  id: string
  sourceUrl: string
  title: string
  status: ProjectStatus
  createdAt: string
}

export type ClipRenderStatus = 'pending' | 'rendering' | 'done' | 'failed'
export type ClipReviewStatus = 'unreviewed' | 'selected' | 'rejected'

export interface WordTimestamp {
  word: string
  /** seconds, relative to the clip's own start (not the source video) */
  start: number
  end: number
}

export interface SubtitleWord extends WordTimestamp {
  /** true once the user has overridden the transcribed word during review */
  edited?: boolean
}

export interface Clip {
  id: string
  projectId: string
  title: string
  /** seconds, offset into the source video */
  startTime: number
  endTime: number
  words: SubtitleWord[]
  renderStatus: ClipRenderStatus
  reviewStatus: ClipReviewStatus
  filePath: string | null
  thumbnailPath: string | null
}

export interface DictionaryTerm {
  id: string
  misheard: string
  correct: string
  contextNotes: string | null
}
