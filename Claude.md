# YouTube Short Splitter

A tool that takes a YouTube video URL and automatically splits it into vertical (1080x1920) shorts suitable for YouTube Shorts/TikTok — similar to TikTok's own clipping tool or Vizard AI. It finds the most engaging segments, generates clickable titles, burns in animated karaoke-style subtitles, and lets the user review/edit/export the results. Runs as a local Electron desktop app (see [claude/architecture.md](claude/architecture.md) for why).

This doc set is split by purpose under `claude/` — update the relevant file as decisions change or work progresses:

- **[claude/architecture.md](claude/architecture.md)** — system diagram, tech choices and why, storage, data model, folder structure, known risks/constraints.
- **[claude/spec.md](claude/spec.md)** — the product spec: pipeline steps, rendering spec, editing/review, export, project lifecycle.
- **[claude/plan.md](claude/plan.md)** — current status and the build-order stages.
- **[claude/backlog.md](claude/backlog.md)** — deferred feature ideas, kept so the thinking isn't lost.
- **[claude/bugs.md](claude/bugs.md)** — known issues, grouped by issue (open + resolved).
- **[claude/journal.md](claude/journal.md)** — chronological log of significant work.

Changes to these docs alone don't need a deploy/build (there's currently no deployment anyway — see architecture.md).
