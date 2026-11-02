# Working with Mic Tuning Lab as an agent

This file is for coding agents and scripts. People should start with [README.md](README.md).

## What is here

| Path | What it holds |
|---|---|
| `index.html`, `app/` | The page: Tune (input, mic settings, recording, the latest result) and Runs (every run, compare, A/B). `app/app.js` wires the page, `app/views.js` builds the result, run list and comparison, `app/charts.js` draws the SVG, `app/store.js` keeps runs in IndexedDB and syncs them with the runs folder. |
| `core/dsp.js` | Measurement: levels, loudness (ITU-R BS.1770), spectra, plosives, sibilance, hum, and the software chain used for OBS. |
| `core/advice.js` | Targets per use, findings with fixes, the score, and the settings sweep plan. Pure functions. |
| `core/report.js` | The JSON report (`mic-lab/report@1`) and its Markdown form. The page's Copy report and the CLI both use it. |
| `core/runs.js` | The run record (`mic-lab/run@1`), what changed between runs, and run comparison. |
| `core/wav.js` | WAV read and write. Files saved by the page carry their segments and mic settings in an `mlab` chunk. |
| `core/obs.js` | The software chain as OBS filters, and an obs-websocket v5 client. |
| `adapters/` | One file per mic whose settings can be changed over USB HID, plus the WebHID transport. |
| `cli/` | The `mic-lab` command and its node-hid transport. |
| `vendor/` | Dexie 4.4.7 (Apache-2.0), the page's IndexedDB wrapper, unchanged from its release. |
| `test/` | `node:test` files with synthetic recordings and simulated mics. No hardware needed. |

Everything is plain JavaScript modules that run unchanged in the browser and in Node 22 or later. There is no build step and no npm runtime dependency. The page loads Dexie from `vendor/`. `node-hid` is optional and only needed for `mic-lab device`.

## Commands

```sh
node cli/mic-lab.js analyze <take.wav>... [--use calls|youtube|twitch] [--guided | --room-tone <s>] [--distance <in>] [--mic] [--no-save] [--json]
node cli/mic-lab.js runs [--use <use>] [--json]
node cli/mic-lab.js runs show <run> [--use <use>] [--json]
node cli/mic-lab.js runs compare <run> <run> [<run>] [--use <use>] [--json]
node cli/mic-lab.js runs rm <run>... [--json]
node cli/mic-lab.js device list|status [--json]
node cli/mic-lab.js device set key=value... [--mic <id|serial>] [--json]
node cli/mic-lab.js serve [--port 8417]
```

- Add `--json` whenever you parse the output. Errors then print `{"error": "..."}`. `analyze` prints a report (below) and saves each file as a run, unless `--no-save`. Files from one sweep become one run. A file already saved, by content hash, is not saved again. `device` prints `{ "mic": { adapter, name, tested, settings, text } }`, and `device list` prints `{ "mics": [...] }`.
- Exit codes: 0 success, 1 failure (file, device or protocol), 2 usage error (unknown command or flag, conflicting flags, or a setting that does not parse).
- `analyze --mic` reads the connected mic, so findings can carry fix commands for it. Gain fixes appear only when the file was recorded on that mic at its current settings. Without `--mic`, fixes are empty and the advice is in words.
- A WAV saved by the page already knows its segments. For any other WAV, pass `--guided` if it follows the page's 43 s script, or `--room-tone <s>` if it starts with that many seconds of silence. Otherwise the noise floor is estimated from the quietest parts.
- `device set` keys:
  - MV7: `mode=manual|auto`, `position=near|far`, `tone=natural|dark|bright`, `gain=0..36` (1.5 dB steps), `comp=off|light|medium|heavy`, `hp=on|off`, `pres=on|off`, `muted=on|off`. Setting `gain`, `comp`, `hp` or `pres` switches to Manual. Setting `position` or `tone` switches to Auto Level.
  - MV7+ (untested): `mode`, `gain=0..36` (1 dB steps), `comp`, `hp`, `hpf=0|75|150`, `tone=-10..10`, `limiter`, `denoise`, `popper`, `muted`.
- `device set` reads every value back and fails with "did not take the change" if the mic reports something else or a value cannot be read. On/off settings accept on, off, true, false, yes, no, 1 and 0. Anything else is a usage error.
- Mic settings persist in the mic itself, so they apply to every app that uses it.

## The report

`analyze --json` prints the same object the page copies. Abridged:

```json
{
  "schema": "mic-lab/report@1",
  "use": "calls",
  "mic": { "adapter": "shure-mv7", "name": "Shure MV7", "tested": true, "settings": { "mode": "manual", "gain": 36, "comp": 1, "hp": true }, "text": "Manual 36 dB · Comp Light · HPF" },
  "sweepRanking": [{ "take": "T2", "step": "Current settings", "score": 82 }],
  "takes": [{
    "take": "T2", "use": "calls", "score": 82, "verdict": "Too quiet for calls",
    "recording": { "mode": "sweep", "distanceIn": 4, "inputDevice": "Shure MV7", "browserProcessing": { "ec": false, "ns": false, "agc": false } },
    "mic": { "adapter": "shure-mv7", "settings": { "...": "as above, at recording time" }, "text": "Manual 36 dB · Comp Light · HPF", "changedDuringTake": false },
    "metrics": { "speechPeaksDbfs": -12.6, "speechRmsDbfs": -21.9, "noiseFloorDbfs": -59.1, "voiceOverNoiseDb": 37.2, "loudnessLufs": -24, "loudnessRangeLu": 0, "plosives": 0, "sibilanceDb": -35.2, "humHz": 60, "bandsVsMidDb": { "Body": 17.9, "Presence": -29.3 } },
    "targets": { "speechPeaksDbfs": [-12, -6], "speechRmsDbfs": [-28, -18], "noiseFloorMaxDbfs": -60, "voiceOverNoiseMinDb": 30, "loudnessRangeMaxLu": 10 },
    "segments": [{ "segment": "normal", "lufs": -24, "speechPeaksDbfs": -12.6, "overNoiseDb": 37.2 }],
    "findings": [{ "id": "too-quiet", "severity": "warn", "title": "Too quiet", "detail": "...", "fixes": [{ "label": "Set gain 36 dB", "set": { "mode": "manual", "gain": 36 }, "command": "mic-lab device set mode=manual gain=36" }] }]
  }]
}
```

- Units are in the key names: `Dbfs`, `Db`, `Lufs`, `Lu`, `Hz`, `S`, `In`. Missing metric values are `null`. `settings` objects list only what the mic reported.
- `severity` is `bad`, `warn`, `info` or `good`. Findings come most severe first.
- `findings[].id` is stable. The full list is in `findingsFor` in `core/advice.js`.
- `sweepRanking` lists the takes best first when every take in the report comes from one sweep. Otherwise it is `null`.
- `changedDuringTake: true` means the mic's settings changed while recording, so that take's numbers mix two settings.
- A take saved with **Tuned WAV** has `recording.mode: "tuned"` and no mic settings. Its levels are after the OBS chain, so it never produces hardware fixes.

## Runs

A run is one recording session: a Quick check, a Free talk, an imported file, or every reading of one Best settings sweep. The page and the CLI keep the same records.

- **Where:** `$MIC_LAB_HOME/runs`, else `$XDG_DATA_HOME/mic-lab/runs`, else `~/.local/share/mic-lab/runs`. Each run is `<id>.json` beside `<id>-1.wav`, `<id>-2.wav` and on. Ids look like `20261102-114208-k3x9` (UTC time, then 4 random characters), so they sort by time.
- **The page** keeps runs in the browser (IndexedDB database `mic-lab`). Served by `mic-lab serve`, it also writes each run to the runs folder and reads the runs the CLI saved there. On GitHub Pages it uses the browser only. Its Export button writes a .tar with the same file layout.
- **`<run>`** in a command is a run number (`3`) or an id.
- **`runs --json`** prints `{ dir, runs: [{ n, id, createdAt, kind, use, score, verdict, mic, input, distanceIn, changes, takes }], skipped }`, newest first. `changes` is the one line the page shows, such as `Gain 27 → 36 · 4 → 3 in`.
- **`runs compare --json`** prints `{ use, runs, changed, same, metrics }`. `changed` and `same` list setup rows `{ key, label, values }` with one value per run. Each metric has `values`, `change` (last minus first) and `closer` (true when the last run is nearer the target, null when neither is).
- **The record**, abridged:

```json
{
  "schema": "mic-lab/run@1", "id": "20261102-114208-k3x9", "n": 4, "createdAt": "2026-11-02T11:42:08.000Z",
  "kind": "check", "use": "calls", "score": 82, "verdict": "On target for calls", "distanceIn": 3,
  "input": "Shure MV7", "mic": { "adapter": "shure-mv7", "settings": { "mode": "manual", "gain": 36, "comp": 1, "hp": true }, "text": "Manual 36 dB · Comp Light · HPF", "changedDuringTake": false }, "best": 0,
  "takes": [{ "...": "the report's take fields", "audio": "20261102-114208-k3x9-1.wav", "sha256": "...",
    "measure": { "fs": 48000, "marks": [], "meta": {}, "analysis": {}, "envelope": { "fps": 25, "rms": [], "peak": [] } } }]
}
```

- `kind` is `check`, `sweep`, `free` or `file`. `best` is the index of the take the run is scored by: the sweep's winner, else 0. Each take carries the same fields as a report take, plus `measure`, which holds the full analysis so the page redraws a run without decoding its audio. Non-finite numbers in `analysis` are stored as the strings `"NaN"`, `"Infinity"` and `"-Infinity"`.
- WAVs saved by the page are 16-bit, and the page measures those same 16-bit samples, so `mic-lab analyze` on a run's WAV gives the page's numbers.
- `mic-lab serve` accepts run writes only from its own page on localhost, and caps a run record at 2 MB and a WAV at 20 MB. Free talk stops at 3 minutes to stay under that.

## Helping someone tune their mic

1. Ask them to open the page, run a **Quick check**, and either press **Save WAV** or paste the **Copy report** text. If they run the page from `mic-lab serve`, the run is already in the runs folder: `mic-lab runs --json`.
2. Run `mic-lab analyze <file> --mic --json` on the WAV, or read the JSON block at the end of the pasted report.
3. Fix the first finding with severity `bad`, then `warn`. Use its `fixes[].command` when there is one, and its `detail` when there is not (distance, room noise and placement are things only the person can change).
4. Ask for another check and compare the two with `mic-lab runs compare <old> <new> --json`. Look at `score` and the metric the finding named.
5. For streaming, the OBS chain tab sets the final loudness. Calls use the mic's signal directly, so for calls every fix belongs on the mic.

## Rules for changing a mic

- **Ask before changing settings, and never while the person is on a call or streaming.** A change is heard instantly by everyone on the other end.
- Run `device status --json` first and keep its `settings`, so you can put them back with `device set`.
- Change one thing at a time, then record again. Several changes at once make it impossible to tell which one helped.
- Record audio only when the person asks you to. The page and the CLI never upload audio.
- The MV7+ adapter is untested on real hardware. Say so before using it, and stop at the first readback error.
- Shure's MOTIV app holds the mic's control channel. If `device` cannot open the mic, ask the person to quit MOTIV.

## Changing the code

- Run one test file at a time: `node --test test/advice.test.js`. `npm test` runs them all in sequence.
- Keep `core/` free of DOM and Node APIs. The page, the CLI and the tests share it, so the page and `mic-lab analyze` give the same numbers for the same file.
- A new mic is a new adapter. The interface is the comment at the top of `adapters/index.js`, and README.md has a sketch. Give it a simulated mic in `test/helpers.js` and tests. Leave `tested: false` until it has run on the real mic.
- The page loads as modules, which browsers block for files opened from disk. Open it through `node cli/mic-lab.js serve` or GitHub Pages.
- Match the existing style: small modules, short functions, comments only where the reason is not obvious.
