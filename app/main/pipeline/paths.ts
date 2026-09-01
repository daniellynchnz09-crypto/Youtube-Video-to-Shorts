import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProjectPaths {
  root: string
  audioPath: string
  videoPath: string
  segmentDir: string
  outputDir: string
}

export async function resolveProjectPaths(baseDir: string, projectId: string): Promise<ProjectPaths> {
  const root = join(baseDir, projectId)
  const paths: ProjectPaths = {
    root,
    audioPath: join(root, 'audio.m4a'),
    videoPath: join(root, 'video.mp4'),
    segmentDir: join(root, 'segments'),
    outputDir: join(root, 'output')
  }
  await mkdir(paths.segmentDir, { recursive: true })
  await mkdir(paths.outputDir, { recursive: true })
  return paths
}
