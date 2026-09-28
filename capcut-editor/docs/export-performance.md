# Export performance validation — 2026-09-27

Measured on the user's i5-13500H / RTX 4050 laptop. The bundled FFmpeg's NVENC
requires API 13.1, while the installed driver exposes 13.0. The installed Shotcut
FFmpeg successfully encodes with NVENC. Export now probes that compatible runtime
before falling back to Intel QSV, AMD AMF, or software. Explicit FFMPEG_PATH overrides
are respected. The portable app uses Shotcut only if installed and the encoder probe
passes; it does not install drivers or alter Shotcut.

## Measurements

60-second samples, 1920×1080, 30 fps, HEVC, requested 1000 Kbps VBR:

| Sample | Previous implementation | Updated | Improvement |
| --- | ---: | ---: | ---: |
| 24 clips including 6 holds, 40 full-canvas captions | 32.92 s | 14.89 s | 2.21× |
| One continuous source clip | 8.14 s | 2.38 s | 3.43× |

Both outputs contain 1,800 frames and last exactly 60 seconds. VBR is not a fixed
size guarantee: the new samples are about 9.95 MB / 10.48 MB versus 7.15 MB / 7.39 MB
before; different hardware encoders make different rate-control decisions.
These are short sample measurements, not full 4-hour export times or CapCut comparisons.
An earlier baseline (49.34 s) ran while another export was active and is excluded here.

## Changes

- Encode eligible muted recap batches, including captions, directly to the final
  H.264/HEVC codec, then copy the video packets while mixing voice/audio.
- Decode and resize each held image once and reuse that frame.
- Read MP4 sample counts instead of decoding every intermediate again to count frames.
- Keep native-size/frame-rate single clips on the NVIDIA GPU through decode and encode.
- Retain the compositing path for effects, transforms, layers and unsupported captions.
- Display GPU selection and live export stage/speed.

## Checks

- `scripts/test_recap_sequence_export.cjs`: all 251 frames across 61 fractional cuts,
  duration and monotonic progress; H.264 and HEVC on NVIDIA.
- `tests/recap-overlay-export.cjs`: all 450 frames across 70 captions and 60 clips;
  H.264 and HEVC on NVIDIA.
- `tests/export-gpu.cjs`: GPU single/sequence timing, delayed voice audio and effect fallback.
- `tests/render-smoke.cjs`: gaps, layers, silence, held images, transitions and audio-only export.
- TypeScript, production build and portable package.

Reproduce samples with `node scripts/benchmark-export.cjs current <source.mp4>`;
add `--single` for the continuous sample. Baseline runs require the pre-change
module snapshot in `.test-output/export-baseline/`. Measurements and output samples
are in `.test-output/export-speed/`.
