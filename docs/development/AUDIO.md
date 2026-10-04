# Audio

## Sound bank

`frontend/public/audio/` contains the original BaboReborn effects and music;
`coverage/` contains CC0 effects. See [Credits](../../CREDITS.md#sound-effects-and-music)
for licenses and attribution.

WAV effects use mono PCM16 at 44.1 kHz; `music.ogg` is an Opus conversion of
`Music.mp3`. The [runtime catalog](../../frontend/src/presentation/audio/audio-catalog.ts)
owns sample mappings, alternate takes and playback gains.

## CC0 coverage bank

[Per-file credits](../../frontend/public/audio/coverage/CREDITS.md) map each output
to its original file, author and source page. The
[source manifest](../../devtools/assets/audio/sources.json) records SHA-256 hashes,
selections, trimming and gain.

Download the listed archives and extract each into `SOURCE_DIRECTORY/PACK/unpacked`
(including the 7z). Keep standalone downloads under `SOURCE_DIRECTORY/PACK`.
With Python 3 and ffmpeg installed, regenerate the bank and its credits:

```sh
python3 devtools/assets/audio/build.py SOURCE_DIRECTORY
```

The script verifies source hashes, downmixes to mono PCM16 at 44.1 kHz, normalizes
peaks, fades one-shot edges and crossfades loops. It uses local source files;
playback gains remain in the runtime catalog.

## Mix

Calibrate each take's playback gain from its loudest 400 ms using EBU R128
momentary loudness; check automatic weapons at their sustained firing cadence.
Heavy shots lead the mix; contacts, equipment cues and loops stay below them.
Player volume and spatial attenuation apply after per-take gains. Music volume
is independent.

## Playback constraints

- Spawn and deployment cues require server acceptance; pickups play only for
  the recipient. Locally predicted fire must not replay on confirmation.
- Participant entry/exit cues use fresh activities, never installation history.
  Required events preserve freshness and deduplication; decorative contacts are
  rate-limited and yield to combat voices.
- Photon loops start from authoritative shots and end after the configured beam
  duration on the Web Audio clock. Scene loops select the five nearest sources plus
  ambience, leaving room for finite beams within the eight-loop limit. Leases
  expire after 350 ms without an update.
- All voices stop on mute, hidden tab, page exit or match reset. Scene loops also
  stop in menus, intermission and stale connections.

## Auditioning

Use `make dev` to review the mix in a busy match. For raw samples, sequential
playback and game-mix controls, run `npm run dev:tools` and open
`/devtools/browser/audio.html`.

Waveform, decoder and voice-lifecycle checks do not replace human mix review.
