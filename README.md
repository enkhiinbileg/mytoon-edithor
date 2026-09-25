# VIDEO EDITHOR

Two separate things live here, both aimed at getting a CapCut-style editing UI on
Windows.

## 1. `capcut-editor/` — new editor (the main line of work)

A CapCut-style editor built from scratch with Electron + React + TypeScript +
FFmpeg. This is the path that can actually reach a CapCut-identical look, because
the UI is HTML/CSS rather than a native widget toolkit.

See [capcut-editor/README.md](capcut-editor/README.md) for how to run it.

```bash
cd capcut-editor
npm install
npm run dev
```

## 2. Shotcut timeline restyle (earlier experiment)

Shotcut ships its timeline as loose QML files, so its timeline could be restyled
to look like CapCut **without rebuilding the app**. That work is applied to the
installed Shotcut at `%LOCALAPPDATA%\Programs\Shotcut\share\shotcut\qml\`.

What it covers: timeline background, tracks, track heads, ruler, rounded clips
with thumbnail strips, clip labels, selection ring, fade handles, playhead.

What it cannot cover: menus, toolbars, dock titles and dialogs. Those are Qt
Widgets painted from `shotcut.exe`, and Shotcut calls `qApp->setStyleSheet()` on
startup (`mainwindow.cpp:4207`), which overrides any stylesheet injected with the
`-stylesheet` command-line flag. Changing them requires building Shotcut from
source.

### Scripts

| Script | Purpose |
| --- | --- |
| `tools/revert-theme.ps1` | Restore Shotcut's original QML from `backup/qml-original` |
| `tools/apply-theme.ps1` | Re-apply the theme from `theme/qml-capcut` (e.g. after a Shotcut update) |
| `tools/capture-window.ps1` | Screenshot a window by process name, even when it is behind others |
| `tools/screenshot.ps1` | Full-screen screenshot |
| `tools/launch.ps1` | Launch Shotcut, optionally with an injected stylesheet |

```bash
powershell -ExecutionPolicy Bypass -File tools\revert-theme.ps1
```

### Backups

- `backup/qml-original/` — Shotcut's untouched QML (548 files)
- `backup/shotcut-settings.reg` — Shotcut settings/layout export

## `testmedia/`

Generated test clips (ffmpeg `testsrc2`, `smptebars`, `mandelbrot`, `rgbtestsrc`
plus a sine-wave mp3) and `capcut-test.mlt`, a Shotcut project that puts them on
three tracks — used to verify the timeline restyle.
