"""
Invoked as a subprocess from transcribe.ts (Node has no local ASR of its
own — this is the Python half of the pipeline). Runs WhisperX transcription
plus its dedicated phoneme-based forced-alignment pass, and writes
word-level timestamps as JSON to an output file.

WhisperX exists specifically to fix a known weakness in vanilla Whisper
(including Groq's hosted whisper-large-v3, previously used here): word-level
timestamps derived from Whisper's own cross-attention weights are
imprecise — confirmed in this project (2026-08-31) as several-second-scale
error that didn't improve by shortening the input, meaning it isn't a
"long audio accumulates drift" problem so much as an inherent limitation of
that timing method. WhisperX instead re-times every word using a dedicated
wav2vec2 phoneme-alignment model against the actual audio, a fundamentally
different (and much more accurate) approach to word timing than Whisper's
own attention weights.

The optional `initial_prompt` biases decoding toward expected vocabulary and
spellings — used here to feed the source video's title/description so proper
nouns (level names, creators, game jargon) come out spelled correctly instead
of phonetically mangled. It's a soft bias with a ~224-token budget, not a
guarantee.

Usage: python whisperx_transcribe.py <audio_path> <output_json_path> [language] [initial_prompt]
"""
import sys
import json
import gc

import torch
import whisperx


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "usage: whisperx_transcribe.py <audio_path> <output_json_path> [language] [initial_prompt]",
            file=sys.stderr,
        )
        sys.exit(1)

    audio_path = sys.argv[1]
    output_path = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 else "en"
    initial_prompt = sys.argv[4].strip() if len(sys.argv) > 4 and sys.argv[4].strip() else None

    device = "cuda" if torch.cuda.is_available() else "cpu"
    # float16 on GPU (this project's RTX 4060 has 8GB VRAM — comfortable for
    # large-v3 at float16 once the transcription model is freed before the
    # alignment model loads, see below); int8 fallback keeps CPU-only usable.
    compute_type = "float16" if device == "cuda" else "int8"

    audio = whisperx.load_audio(audio_path)

    # initial_prompt goes through asr_options — faster-whisper feeds it to the
    # decoder as leading context to bias vocabulary/spelling (see module docstring).
    asr_options = {"initial_prompt": initial_prompt} if initial_prompt else None
    model = whisperx.load_model(
        "large-v3", device, compute_type=compute_type, language=language, asr_options=asr_options
    )
    result = model.transcribe(audio, batch_size=16)

    # Free the transcription model before loading the alignment model —
    # keeps peak VRAM down instead of holding both at once, matching
    # WhisperX's own recommended usage pattern for cards in this class.
    del model
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

    align_model, align_metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    aligned = whisperx.align(
        result["segments"], align_model, align_metadata, audio, device, return_char_alignments=False
    )

    words = []
    for segment in aligned["segments"]:
        for w in segment.get("words", []):
            # Alignment occasionally can't place a word (e.g. it fell
            # outside the recognized phoneme sequence) — skip rather than
            # emit a timestamp-less/malformed entry downstream has to guard
            # against.
            if "start" not in w or "end" not in w:
                continue
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})

    duration = len(audio) / whisperx.audio.SAMPLE_RATE
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"words": words, "duration": duration}, f)


if __name__ == "__main__":
    main()
