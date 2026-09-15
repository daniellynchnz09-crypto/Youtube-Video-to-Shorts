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

Also runs a standalone voice-activity-detection (VAD) pass over the full
audio and includes its speech segments in the output — added 2026-09-15 to
address a residual desync bug (see bugs.md): an isolated word's forced-aligned
timestamp can be wrong by several seconds, and a plain energy/silence check
can't tell real (but quiet or SFX-adjacent) speech from game audio. WhisperX
already runs VAD internally (pyannote's segmentation model, bundled locally —
no download/token needed) to chunk audio before ASR, but doesn't expose the
raw speech segments; this calls the same model directly, unchunked, so
transcribe.ts can cross-check word timestamps against genuine detected
speech rather than just amplitude. Binarize's `onset`/`offset` thresholds
match WhisperX's own defaults (`vad_onset`/`vad_offset` in asr.py); no
`max_duration` cap here since we want the model's natural speech/silence
boundaries, not chunks sized for ASR batching.

Usage: python whisperx_transcribe.py <audio_path> <output_json_path> [language] [initial_prompt]
"""
import sys
import json
import gc

import torch
import whisperx
from whisperx.vads.pyannote import load_vad_model, Binarize, Pyannote


def extract_speech_segments(audio, device: str) -> list[dict]:
    vad_pipeline = load_vad_model(device)
    waveform = Pyannote.preprocess_audio(audio)
    scores = vad_pipeline({"waveform": waveform, "sample_rate": whisperx.audio.SAMPLE_RATE})

    binarize = Binarize(onset=0.500, offset=0.363, min_duration_on=0.1, min_duration_off=0.1)
    annotation = binarize(scores)

    del vad_pipeline
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

    return [{"start": seg.start, "end": seg.end} for seg in annotation.get_timeline()]


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

    # Free the alignment model before the VAD pass for the same peak-VRAM
    # reason as above — nothing here needs it anymore.
    del align_model
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()

    speech_segments = extract_speech_segments(audio, device)

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
        json.dump({"words": words, "duration": duration, "speechSegments": speech_segments}, f)


if __name__ == "__main__":
    main()
