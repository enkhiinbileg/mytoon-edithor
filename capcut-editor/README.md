# Cutline — desktop video editor

A desktop editor inspired by the CapCut Windows workspace, built with React,
TypeScript, Electron, and FFmpeg. This is an independent editor, not CapCut.

This is an original implementation that imitates CapCut's *layout and visual
style*. It contains no CapCut code, branding or assets.

## Desktop workspace update

- Horizontal Media / Audio / Text / Stickers / Effects / Transitions / Filters / Auto dub tabs.
- Searchable local media library, central Player, right inspector, resizable timeline.
- Versioned `.cutline` project files: Menu → Save / Save as / Open / New.
- A recovery draft is saved after edits and before normal window close, then restored on launch.
- Undo / redo (100 edits), grouped dragging, selected-clip split, duplicate, track locks and mute.
- 16:9, 9:16, 1:1, and 4:3 canvases, selectable frame rate, MP4 export settings.
- Absolute-position export preserves empty gaps, video layers, muted tracks, stills, and audio placement.

Double-click `../Start Editor.cmd` to launch the built app. After code changes run
`npm run build` first. `npm start` builds and opens the app without a Vite server.

For the portable Windows build, open `release/Cutline/Cutline.exe`. Keep the
entire `Cutline` folder together: the executable needs its adjacent runtime
files. `npm run package:portable` rebuilds this folder using the already installed
Electron runtime. It does not bundle FFmpeg, so Shotcut's FFmpeg installation
or the binary paths described below are still required for media operations.

## Requirements

- Node.js 20+
- FFmpeg and FFprobe. The app auto-detects the binaries that ship with Shotcut at
  `%LOCALAPPDATA%\Programs\Shotcut\`. Otherwise set `FFMPEG_PATH` / `FFPROBE_PATH`,
  or put them on `PATH`.

## Running

```bash
npm install
npm run dev
```

`npm run dev` starts Vite on port 5173 and launches Electron against it.

You can pass media files on the command line and they are imported and placed on
the timeline at startup:

```bash
npx electron . "C:\path\to\clip.mp4"
```

## Project layout

| Path | Purpose |
| --- | --- |
| `electron/main.js` | Window creation, IPC, the `media://` protocol |
| `electron/ffmpeg.js` | Probe, thumbnail extraction, export pipeline |
| `electron/preload.js` | The `window.api` bridge |
| `src/store.ts` | All editor state (zustand): media, tracks, clips, playhead |
| `src/components/Timeline.tsx` | Ruler, tracks, clips, drag/trim/split, zoom |
| `src/components/Preview.tsx` | Playhead-driven playback |
| `src/styles.css` | The CapCut-style theme |

## Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` / `Ctrl+B` | Split selected clip at playhead |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+D` | Duplicate selected clip |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as |
| `Ctrl+O` / `Ctrl+N` | Open / new project |
| `Ctrl+E` | Export settings |
| `Delete` | Delete selected clip |
| `←` / `→` | Step one frame (hold `Shift` for one second) |
| `Home` | Jump to start |
| `+` / `-` | Zoom timeline |

## What works

- Import video/audio/stills, probed with ffprobe, thumbnail strips via ffmpeg
- Multi-track timeline (overlay / video / audio): drag to move, drag edges to
  trim, split, delete, snapping
- Drag media from the library onto a specific track
- Preview playback driven by the timeline playhead
- **Text** — six presets; content, size, colour, bold, shadow and background are
  editable in the inspector, and the overlay can be dragged around the preview
- **Stickers** — emoji overlays with the same positioning and timing controls
- **Filters** — eight colour looks (warm, cool, mono, vivid, vintage, cinematic…)
- **Effects** — zoom in/out, shake, pulse, fade in/out
- **Transitions** — dissolve, wipes, slides, circle open, fade to black, with an
  adjustable length
- Export: per-clip filters and effects, real transitions, overlay compositing,
  audio-track mixing, H.264/AAC with live progress

## How looks stay consistent

`src/looks.ts` contains CSS preview and FFmpeg implementations of the looks.
CSS and FFmpeg colour/motion filters are approximations of one another; they
are not guaranteed to be pixel-identical.

Text and stickers take this further: the renderer rasterises each overlay to a
transparent PNG with a canvas (`src/overlayRaster.ts`) and ffmpeg composites that
exact image, so fonts, emoji and shadows render identically in both.

## How the render graph is built

1. A black video canvas and silent audio bed cover the complete timeline.
2. Source clips are trimmed, normalised, filtered, shifted to their authored start,
   then composited in track order. Later video tracks appear above earlier tracks.
3. Adjacent opaque clips on the same track can use a transition. The outgoing
   last frame is held while the incoming clip transitions in, preserving duration.
4. Rasterised text/stickers use absolute overlay timing; source audio and audio
   tracks are delayed to their timeline start and mixed over the silent bed.

Transitions on nonadjacent/overlapping or partially transparent clips are currently
cuts. Transition preview is an approximation of FFmpeg. Audio at a transition is
cut at the original timeline boundary, not crossfaded.

## Auto dub

Turns a foreign-language video into a dubbed one: **transcribe → translate →
speak → lay onto the timeline**. Each stage leaves its output in place, so the
run can stop and resume — and the translation is editable *before* any TTS
credits are spent, which is the expensive and irreversible part.

| Stage | How |
| --- | --- |
| Transcript | Whisper running locally via `whisper-cli` (bundled with Shotcut), or an imported SRT/VTT |
| Translation | Claude, Gemini, OpenAI, or a local Ollama model — batched 40 segments per request |
| Voice | ElevenLabs (default) or Azure Speech — the provider layer in `electron/tts.js` |

The ElevenLabs model list is read from the account at runtime (`GET /v1/models`),
not hardcoded, so a newly released model appears in the picker without a code
change — and its credit multiplier comes from the API rather than a stale
constant. A static list (including `eleven_v3`) is the fallback for when no key
is set. `eleven_v3` takes a different settings shape than the v2-era models, so
the request omits `voice_settings` and the previous/next stitching context for
it rather than sending fields it would reject.
| Placement | Each line becomes its own clip on a new audio track, at its original timestamp |

### Translation engines

The prompt, the batching and the JSON handling live once in `electron/translate.js`;
a provider in `electron/translate-providers.js` only has to turn a prompt into
text. That keeps every engine behaving identically and makes adding another one
a few dozen lines.

| Engine | Key | Notes |
| --- | --- | --- |
| Claude | `sk-ant-…` | Best quality for Mongolian; uses the official SDK with a cached system prompt |
| Google Gemini | Google AI key | Has a free tier |
| OpenAI | `sk-…` | Pay as you go |
| Ollama | none | Runs locally and free; the model list is read from the running instance |

Model names are a free-text field with suggestions rather than a fixed list —
a hardcoded list goes stale as soon as a provider ships a new model. Replies are
parsed leniently (fenced or prose-wrapped JSON is recovered), because local
models in particular do not always honour a response schema. A line the model
omits stays empty rather than being invented.

### Fitting speech to timing

The hard part is not the speech, it's the fit: a translated line rarely takes
exactly as long to say as the original. Every line gets a slot running from its
own start to wherever the next line begins, and `atempo` nudges it to fit —
capped at 1.35× because past roughly that, speech stops sounding like a person.
Lines that still overflow are flagged rather than silently clipped, so they can
be shortened by hand.

### Keys

API keys are entered in the Auto dub panel and stored encrypted with Electron's
`safeStorage` (DPAPI/Keychain) under the app's user-data folder. The renderer
only ever learns *whether* a key is set — the values never cross the IPC
boundary and are read from the encrypted store in the main process at call time.

### What a dub costs

Cost tracks the **character count of speech**, not video length. Whisper is free
and local; Claude translation is a few cents; the TTS provider dominates.
Roughly, for ~10 minutes of speech (~10,000 characters): translation ~$0.25,
ElevenLabs ~$2.20 on Multilingual v2 — halved by picking Turbo or Flash v2.5,
which bill 0.5 credits per character. The panel shows the character and credit
count, and the remaining quota, before you spend anything.

## Not implemented yet

- Keyframed animation of overlay position/scale
- Speed changes, reverse, freeze frames
- Animated text/sticker effects (static text/stickers export with exact rasterisation)
- CapCut cloud services, template catalogue, AI background removal, tracking, and collaboration
- Relinking moved media; project files reference original paths rather than embedding media
- Export cancellation and an installer (a portable Windows folder is available)

## Verification

`npx tsc --noEmit`, `npm run build`, `node tests/project-validation.cjs`, and
`node tests/render-smoke.cjs` cover types, production build, project validation,
and real FFmpeg output. `tests/desktop-smoke.cjs` uses Playwright Electron with
an isolated profile to exercise import, editing, save/open, restart recovery,
responsive layout, and MP4 export. Set `PLAYWRIGHT_MODULE` to an installed
Playwright package if it is not on Node's module path. Test outputs go in `.test-output`.
