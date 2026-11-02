# Mic Tuning Lab

Record your voice, see how it measures against the levels that calls and streams expect, and fix what is off. It works with any microphone. For the Shure MV7 and MV7+ it can also change the mic's own settings from the page.

**Open it:** https://tsmith165.github.io/mic-tuning-lab/ (Chrome or Edge for mic control. Measuring works in any current browser.)

Your audio stays on your computer. Runs are saved in the browser's own storage, and nothing is uploaded. When the page runs from `mic-lab serve`, runs are also saved to a folder that the command line tool reads.

## How to use it

The page has two views. **Tune** is where you record. **Runs** keeps every recording so you can compare them.

1. **Pick your input.** Press Allow microphone, then pick your mic at the top left. The large number is your live speech peaks, and the meter shows the target band. Choose what you are tuning for at the top: Calls (Google Meet, Zoom, Teams), YouTube or Twitch. Set how far your mouth is from the mic.
2. **Connect mic control** (MV7 and MV7+, Chrome or Edge). The mic's settings appear under the meter, and every change is read back from the mic. Fixes and the sweep work only while that mic is the selected input, so the page never changes one mic while measuring another.
3. **Record.** Pick one:
   - **Record check** (43 s): six short prompts covering room tone, normal voice, quiet voice, plosives, sibilance and a projected line.
   - **Find best settings** (about 1 minute, needs mic control): you read one sentence after each settings change. The page keeps the best settings on the mic. Stop puts your own settings back.
   - **Free talk**: talk as you normally would, up to 3 minutes.
4. **Read the result.** A score out of 100, a one-line verdict, four levels against their targets, and up to three fixes. With mic control, a fix is a button that changes the setting. Record again to hear the difference. Each result shows its score change against the run before it on the same mic.

**Runs** lists every run with its score and what changed since the run before it. Tick two or three runs to compare the settings that changed, each level side by side and the spectra. A/B listening switches between the runs at the same point in the recording (keys A, B and C, Space to play or pause). Export saves every run in one .tar file, and Import takes that file back, or any WAV.

**Copy report** puts a Markdown summary with the full JSON on your clipboard, ready to paste into a chat with an assistant or into an issue. **Save WAV** saves the recording with its segments and mic settings inside the file, so the command line tool reads it exactly as the page did. For YouTube and Twitch, the **OBS chain** tab holds a software chain for OBS that the page can push into OBS over its WebSocket.

## Supported mics

| Mic | Measuring and advice | Settings control |
|---|---|---|
| Any mic | Yes | No. Advice is given in words, for example "lower the input gain about 6 dB". |
| Shure MV7 (USB 14ED:1012) | Yes | Yes. Tested on firmware 0.0.52.0. |
| Shure MV7+ (USB 14ED:1019) | Yes | **Untested.** Written from published captures. Every change is read back, a value that cannot be read back counts as a failure, and Restore puts back the settings you connected with. Reports from MV7+ owners are welcome. |

Close Shure's MOTIV app while using mic control. Only one app can hold the mic's control channel.

## Targets

| | Calls | YouTube | Twitch |
|---|---|---|---|
| Speech peaks | −12 to −6 dBFS | −12 to −6 dBFS | −12 to −6 dBFS |
| Speech level (RMS) | −28 to −18 dBFS | −28 to −18 dBFS | −28 to −18 dBFS |
| Noise floor, at most | −60 dBFS | −65 dBFS | −62 dBFS |
| Voice over noise, at least | 30 dB | 40 dB | 36 dB |
| Loudness range, at most | 10 LU | 14 LU | 12 LU |
| Final loudness after the OBS chain | −18 LUFS | −14 LUFS | −16 LUFS |

Calls take the mic signal as it is, so for calls the fixes are on the mic. For streams, the OBS chain sets the final loudness.

## How it measures

The page records the raw signal at 48 kHz with the browser's echo cancellation, noise suppression and auto gain turned off. The Browser processing switch turns them on, to hear what a call app would do.

- **Speech peaks**: the 95th percentile of 20 ms peak levels while you talk at normal effort. On a Quick check that is the normal voice segment only.
- **Speech level**: the average power of the same frames.
- **Noise floor**: the room-tone segment, ignoring its loudest 10%. Without a room-tone segment, the 10th percentile of the take's 20 ms levels.
- **Voice over noise**: speech level minus noise floor.
- **Loudness**: integrated loudness and loudness range, following the methods of ITU-R BS.1770 and EBU R128. They have not been checked against the standards' conformance test signals.
- **Plosives**: bursts under 150 Hz at least 12 dB above your usual low end.
- **Sibilance**: 5 to 10 kHz energy compared with your speech level.
- **Tonal balance**: your average voice spectrum in bands, compared with average male speech (Byrne et al. 1994).

The score starts at 100. It loses points for each dB outside the level, noise and voice-over-noise targets, for too little headroom, clipping, plosives and harsh sibilance, and for a boomy or dull tone. The rules live in [`core/advice.js`](core/advice.js), and the measurements in [`core/dsp.js`](core/dsp.js).

The OBS chain preview runs its own gate, EQ, compressor and limiter with the same controls as OBS's filters. The levels come out close to OBS's. The waveforms can differ in fine detail.

## Run it locally

The page uses JavaScript modules, which browsers do not load from a file opened from disk. Serve it instead:

```sh
git clone https://github.com/tsmith165/mic-tuning-lab
cd mic-tuning-lab
node cli/mic-lab.js serve        # http://localhost:8417
```

Served this way, the page saves each run to the runs folder as well as the browser, and shows runs that the command line saved. The folder is `~/.local/share/mic-lab/runs`, or `$MIC_LAB_HOME/runs` when that is set. Each run is a JSON record (`<id>.json`) beside its WAV files (`<id>-1.wav`, `<id>-2.wav` and on).

There is no build step and no runtime dependency. Node 22 or later runs the command line tool and the tests.

## Command line and agents

`mic-lab` measures saved WAV files, keeps them as runs, compares runs, and reads or changes the mic's settings, with JSON output for scripts and coding agents:

```sh
node cli/mic-lab.js analyze take.wav --json   # measure and save as a run
node cli/mic-lab.js runs                      # every run, newest first, with what changed
node cli/mic-lab.js runs compare 3 4          # two or three runs side by side
npm install                                   # optional: node-hid, for mic control from the command line
node cli/mic-lab.js device status
node cli/mic-lab.js device set gain=36 comp=medium
```

[AGENTS.md](AGENTS.md) describes the commands, the report and run formats, and the rules for changing a mic's settings.

## Add a mic

Mic control lives in `adapters/`. An adapter is one file that exports a plain object:

```js
export default {
  id: 'maker-model', name: 'Maker Model', tested: false,
  hid: { vendorId: 0x1234, productId: 0x5678 },   // how WebHID and node-hid find it
  labelMatch: /Model/i,                            // matches the audio input's name
  caps: { mode: false, gain: { min: 0, max: 40, step: 1 }, comp: ['Off', 'On'], hp: true, settable: ['gain', 'comp', 'hp'] },
  describe: state => `Gain ${state.gain} dB`,
  parseSettings: args => ({ /* "gain=30" -> { gain: 30 } */ }),
  async open(transport, opts) { /* returns { state, read(), apply(target), batch(fn), restore(), close() } */ },
};
```

`caps` tells the advice and the sweep what the mic can change, so findings offer fix buttons only for settings that exist. Add the adapter to `adapters/index.js`, add a simulated mic to `test/helpers.js` and tests next to `test/mv7.test.js`, and set `tested: true` only after running it on the real mic. The comment at the top of [`adapters/index.js`](adapters/index.js) has the full interface.

## Tests

```sh
npm test
```

The tests use synthetic recordings and simulated mics, so they need no hardware.

## Credits

The mic protocols come from people who documented them first. This project's code is written independently from those facts.

- [schlarpc/shure-mv7-firmware-re](https://github.com/schlarpc/shure-mv7-firmware-re) (MIT): reverse engineering of the MV7's firmware and its text command shell.
- [matteodelabre/mv7config](https://github.com/matteodelabre/mv7config) (GPL-3.0): MV7 configuration over USB HID.
- [Humblemonk/shurectl](https://github.com/Humblemonk/shurectl) (GPL-3.0): the MV7+ binary protocol, its addresses and the USB captures used as test vectors here.

Included with the page:

- [Dexie](https://dexie.org) 4.4.7 (Apache-2.0), in `vendor/` with its license: the browser's run storage.
- [Geist and Geist Mono](https://vercel.com/font) (SIL Open Font License 1.1), in `app/fonts/` with the license.
- Icons from [Lucide](https://lucide.dev) (ISC), drawn inline in `app/charts.js`.

Not affiliated with or endorsed by Shure. MV7 and MV7+ are Shure trademarks.

## License

MIT. See [LICENSE](LICENSE).
