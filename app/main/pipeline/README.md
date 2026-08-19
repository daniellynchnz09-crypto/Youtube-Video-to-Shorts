# pipeline

The core processing pipeline, run in the Electron main process: audio download → Groq transcription → Groq segment analysis → targeted video download → Remotion render. See `Claude.md` at the project root for the full spec.

Each pipeline module is an Electron-agnostic pure function taking an explicit config object (paths, API keys, DB handle) rather than importing `electron` directly — this lets `smoke-test.ts` exercise the whole pipeline under plain Node, and keeps the analysis/title-generation step swappable to Claude later (see Claude.md's "Future expandability note") without touching the rest of the pipeline.
