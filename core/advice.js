/* Targets, findings, scoring and the settings sweep. Pure: the page, the CLI and the tests share it.

   Hardware is described by two plain objects from the mic's adapter (see adapters/README in the main README):
   - caps: what the mic can change, e.g. { mode: true, gain: { min: 0, max: 36, step: 1.5 }, comp: [...], hp: true, pres: true }
   - state: what it is set to now, e.g. { mode: 'manual', gain: 27, comp: 1, hp: true, pres: false }
   Without an adapter both are null and the advice is in words only. */
import { clamp } from './dsp.js';

const PROFILES = {
  calls:   { id: 'calls',   label: 'Calls',   noun: 'calls',   peak: [-12, -6], speech: [-28, -18], noise: -60, snr: 30, lra: 10, final: -18 },
  youtube: { id: 'youtube', label: 'YouTube', noun: 'YouTube', peak: [-12, -6], speech: [-28, -18], noise: -65, snr: 40, lra: 14, final: -14 },
  twitch:  { id: 'twitch',  label: 'Twitch',  noun: 'Twitch',  peak: [-12, -6], speech: [-28, -18], noise: -62, snr: 36, lra: 12, final: -16 },
};
const profileOf = id => PROFILES[id] || PROFILES[id === 'meet' ? 'calls' : ''] || PROFILES.calls;

/* Software chain presets, in OBS filter order (gate, 3-band EQ, compressor, gain, limiter) */
const CHAIN_PRESETS = {
  calls:   { gateOn: false, gateOpen: -50, eqLow: 0, eqMid: 0, eqHigh: 0, compOn: true, thr: -24, ratio: 3, att: 6, rel: 60, target: -18, ceil: -2 },
  youtube: { gateOn: true, gateOpen: -50, eqLow: -1, eqMid: 0, eqHigh: 1.5, compOn: true, thr: -22, ratio: 3, att: 6, rel: 80, target: -14, ceil: -1 },
  twitch:  { gateOn: true, gateOpen: -48, eqLow: -1, eqMid: 0, eqHigh: 1.5, compOn: true, thr: -22, ratio: 4, att: 6, rel: 60, target: -16, ceil: -1 },
};

const fmt = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d).replace('-', '−') : '—';
const fmtS = (v, d = 1) => Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d).replace('-', '−') : '—';
const snapGain = (g, caps) => { const G = (caps && caps.gain) || { min: 0, max: 36, step: 1.5 }; return clamp(Math.floor(g / G.step + 1e-6) * G.step, G.min, G.max); };
const usedBrowserProcessing = meta => !!(meta.proc && (meta.proc.ec || meta.proc.ns || meta.proc.agc));

/* Findings for one take, most severe first. Each fix is { label, set } where set is a partial state the
   adapter can apply. Fixes act on the mic as it is now and change one setting, so an old take never undoes
   newer changes. Gain fixes appear only while the mic still matches the take. */
function findingsFor(take, ctx = {}) {
  const a = take.a, meta = take.meta || {}, P = profileOf(ctx.profile), hw = meta.hw || null, d = meta.distance, out = [];
  const caps = ctx.caps || null, now = caps && ctx.now ? ctx.now : null, describe = ctx.describe || (() => '');
  const can = k => !!(now && caps[k]), man = now && now.mode === 'manual', auto = now && now.mode === 'auto';
  const fix = (cond, label, set) => cond ? { label, set: typeof set === 'function' ? set() : set } : null;
  /* A take from another mic model never drives changes on this one */
  const otherMic = !!(ctx.adapter && meta.adapter && meta.adapter !== ctx.adapter.id), describeTake = ctx.describeHw ? h => ctx.describeHw(h, meta.adapter) : describe;
  const same = now && hw && !otherMic && describe(now) === describe(hw);
  const gainFix = g => fix(same && can('gain') && (man || !caps.mode), `Set gain ${fmt(g, Number.isInteger(g) ? 0 : 1)} dB`, caps && caps.mode ? { mode: 'manual', gain: g } : { gain: g });
  const add = (id, sev, title, detail, ...fixes) => out.push({ id, sev, title, detail, fixes: fixes.filter(Boolean) });
  const targetPk = (P.peak[0] + P.peak[1]) / 2, pk = a.phases.some(p => p.id === 'normal') ? 'Normal speech peaks' : 'Speech peaks';
  const G = (caps && caps.gain) || null, maxGain = G ? G.max : null, hwManual = hw && (hw.mode === 'manual' || (!hw.mode && Number.isFinite(hw.gain)));
  const hpFix = () => fix(man && can('hp') && !now.hp, 'High-pass on', { mode: 'manual', hp: true });
  const compFix = () => man && caps.comp && now.comp < 2 ? { label: `Compressor ${caps.comp[2]}`, set: { mode: 'manual', comp: 2 } } : null;

  if (now && hw && !same) add('mic-changed', 'info', 'The mic has changed since this take', `Recorded ${otherMic ? 'on another mic' : 'at'} ${describeTake(hw)}. The mic is now at ${describe(now)}. Record a new take to measure the current settings.`);
  if (meta.hwChanged) add('changed-during-take', 'info', 'Settings changed during this take', 'The levels mix two sets of mic settings.');
  if (usedBrowserProcessing(meta)) add('browser-processing', 'info', 'Browser processing was on', 'Chrome changed this signal before analysis. Use Raw input to measure the mic itself.');
  if (a.noiseContaminated) add('room-tone-noisy', 'warn', 'Room-tone segment had sound in it', 'Noise floor and voice over noise may read worse than reality. Re-record and stay silent for the first seconds.');
  if (a.clips > 0) {
    const ng = hwManual ? snapGain(hw.gain - 6, caps) : null;
    add('clipping', 'bad', `Clipping (${a.clips}×)`, `The signal hit 0 dBFS and distorted. ${ng != null ? `Drop gain to ${fmt(ng)} dB.` : 'Lower input gain about 6 dB.'}`, ng != null && gainFix(ng));
  }
  const need = targetPk - a.typPeak;
  if (a.typPeak > P.peak[1] && !a.clips) {
    const ng = hwManual ? snapGain(hw.gain + need, caps) : null;
    add('running-hot', 'warn', 'Running hot', `${pk} sit at ${fmt(a.typPeak)} dBFS, above the ${fmt(P.peak[1], 0)} dBFS ceiling for ${P.noun}. ${ng != null ? `Set gain to ${fmt(ng)} dB.` : `Lower gain about ${fmt(-need, 0)} dB.`}`, ng != null && gainFix(ng));
  }
  if (a.typPeak < P.peak[0]) {
    const want = `${P.noun === 'calls' ? 'Calls want' : `${P.noun} wants`} ${fmt(P.peak[0], 0)} to ${fmt(P.peak[1], 0)}`;
    if (hwManual && hw.mode !== 'auto') {
      const top = maxGain ?? 36, wantGain = hw.gain + need, ng = snapGain(wantGain, caps), short = wantGain - top, maxed = hw.gain >= top;
      const closer = d ? `, to about ${Math.max(1, Math.round(d * Math.pow(10, -short / 20)))} in` : '';
      let txt = maxed ? `${pk} reach ${fmt(a.typPeak)} dBFS. ${want}, and gain is already at its ${fmt(top, 0)} dB maximum.`
        : `${pk} reach only ${fmt(a.typPeak)} dBFS. ${want}. Raise gain from ${fmt(hw.gain)} to ${fmt(ng)} dB (+${fmt(ng - hw.gain)} dB).`;
      if (short > 1.5) txt += maxed ? ` Move closer${closer} for the last ${fmt(short, 0)} dB.` : ` That runs out of gain at ${fmt(top, 0)} dB, still ${fmt(short, 0)} dB short: move closer${closer}.`;
      add('too-quiet', a.typPeak < P.peak[0] - 3 ? 'bad' : 'warn', 'Too quiet', txt, ng > hw.gain && gainFix(ng));
    } else if (hw && hw.mode === 'auto') {
      const pos = d && d > 6 ? 'far' : 'near';
      add('too-quiet-auto', 'bad', 'Too quiet in Auto Level', `Auto Level is choosing gain and your ${pk.toLowerCase()} still reach only ${fmt(a.typPeak)} dBFS. ${d && d > 6 ? `At ${d} in the mic hears more room than voice. Move within 2 to 6 in${caps && caps.position ? ' and use Near' : ''}` : 'Move closer, to about 2 in'}, or switch to Manual and raise gain.`,
        fix(auto && can('position') && now.position !== pos, `Auto ${pos === 'near' ? 'Near' : 'Far'}`, { mode: 'auto', position: pos }),
        fix(auto && can('mode'), 'Switch to Manual', { mode: 'manual' }));
    } else add('too-quiet', 'bad', 'Too quiet', `${pk} reach only ${fmt(a.typPeak)} dBFS. The target is ${fmt(P.peak[0], 0)} to ${fmt(P.peak[1], 0)}. Raise input gain about ${fmt(need, 0)} dB, or move closer (halving the distance adds about 6 dB).`);
  }
  if (!a.clips && a.peak > -3) add('little-headroom', 'warn', 'Little headroom', `${a.loudPeak > -3 ? 'Your projected voice peaks' : 'The loudest moment peaks'} at ${fmt(a.peak)} dBFS, ${fmt(-a.peak)} dB from clipping, so a laugh can distort. ${man && caps.comp && now.comp < 2 ? `The ${caps.comp[2]} compressor holds those peaks down.` : 'Lower gain a step if normal speech has room to spare.'}`, compFix());
  if (a.snr < P.snr) {
    add('low-snr', a.snr < P.snr - 10 ? 'bad' : 'warn', `Voice only ${fmt(a.snr, 0)} dB above the noise`,
      `Gain can't fix this: it raises voice and noise together. ${d ? `From ${d} in, moving to ${Math.max(1, Math.round(d / 2))} in buys about 6 dB.` : 'Halving the distance buys about 6 dB.'} Then quiet fans or the keyboard${caps && caps.hp ? ', and turn on high-pass' : ''}.`,
      hpFix(), fix(can('denoise') && !now.denoise, 'Denoiser on', { denoise: true }));
  } else if (a.noise > P.noise) add('noise-floor', 'warn', `Noise floor ${fmt(a.noise, 0)} dBFS`, `Above ${fmt(P.noise, 0)} dBFS. You have voice over noise to spare, so lower gain a notch and move a little closer.`,
    fix(can('denoise') && !now.denoise, 'Denoiser on', { denoise: true }));
  if (a.hum) add('hum', 'warn', `${a.hum.f0} Hz hum`, `Mains hum shows in ${a.hum.hits} harmonics (up to ${fmt(a.hum.worst, 0)} dB above its neighbours). Try another USB port without a hub, unplug any XLR cable, or move the mic cable away from power bricks.`);
  /* Rumble is judged on the room tone: speech itself carries energy below 80 Hz */
  if (a.rumbleShape > 20) add('rumble', 'warn', 'Low rumble in the room', `Room noise below 80 Hz sits ${fmt(a.rumbleShape, 0)} dB above its 500 Hz to 2 kHz level: HVAC, traffic or desk vibration. ${hw && hw.hp ? 'High-pass was already on, so look for the source.' : 'Turn on a high-pass filter.'}`, hpFix());
  if (a.plosives.length) add('plosives', a.plosives.length > 3 ? 'warn' : 'info', `${a.plosives.length} plosive pop${a.plosives.length > 1 ? 's' : ''}`, `Bursts up to ${fmt(Math.max(...a.plosives.map(p => p.excess)), 0)} dB over your normal low end. Aim the mic at the corner of your mouth instead of straight on, add a foam windscreen, and keep high-pass on.`,
    fix(can('popper') && !now.popper, 'Popper stopper on', { popper: true }), hpFix());
  if (a.sibPeak > 3) add('sibilance', 'warn', 'Sharp S sounds', `Sibilant peaks run ${fmt(a.sibPeak, 0)} dB over your average voice. Angle the mic 15 to 30° off-axis${auto && caps.tones ? ' or use the Dark tone' : ''}. In OBS, lower the EQ High band.`,
    fix(auto && caps.tones && caps.tones.includes('dark') && now.tone !== 'dark', 'Tone: Dark', { mode: 'auto', tone: 'dark' }),
    fix(can('toneLevel') && Number.isFinite(now.toneLevel) && now.toneLevel > caps.toneLevel.min, 'Tone darker', () => ({ toneLevel: Math.max(caps.toneLevel.min, now.toneLevel - 3) })));
  /* Published speech averages sit about +9 dB (Body) and −13 dB (Presence) against the mids, so only clear departures count */
  const b = a.bands && a.bands.rel;
  if (b) {
    if (b.Body > 16) add('boomy', 'warn', 'Boomy', `Lows sit ${fmt(b.Body, 0)} dB over the mids. Average male speech sits about +9 dB. ${hw && hw.hp ? 'High-pass is already on and leaves this band mostly untouched. ' : ''}Backing off an inch cuts it, at the cost of about 2 dB of level${caps && caps.pres && hw && hw.mode === 'manual' && !hw.pres ? '. Presence boost brightens the voice instead' : ''}.`,
      hpFix(), fix(man && can('pres') && !now.pres, 'Presence on', { mode: 'manual', pres: true }));
    if (b.Presence < -22) add('muffled', 'warn', 'Muffled', `Presence (2 to 5 kHz) is ${fmt(-b.Presence, 0)} dB under the mids. Average speech sits about 13 dB under. Point the mic straight at your mouth${man && caps.pres ? ' and turn on Presence boost' : auto && caps.tones ? ' or try the Bright tone' : ''}.`,
      fix(man && can('pres') && !now.pres, 'Presence on', { mode: 'manual', pres: true }),
      fix(auto && caps.tones && caps.tones.includes('bright') && now.tone !== 'bright', 'Tone: Bright', { mode: 'auto', tone: 'bright' }),
      fix(can('toneLevel') && Number.isFinite(now.toneLevel) && now.toneLevel < caps.toneLevel.max, 'Tone brighter', () => ({ toneLevel: Math.min(caps.toneLevel.max, now.toneLevel + 3) })));
  }
  const q = a.phases.find(p => p.id === 'quiet'), nv = a.phases.find(p => p.id === 'normal');
  if (q && Number.isFinite(q.speech)) {
    const qs = q.speech - a.noise;
    if (qs < 15) add('quiet-voice-buried', 'warn', 'Quiet voice gets buried', `Your soft voice is ${fmt(qs, 0)} dB above the noise${nv ? ` and ${fmt(nv.speech - q.speech, 0)} dB below your normal voice` : ''}. Move closer${man && caps.comp && now.comp < 2 ? ` or use the ${caps.comp[2]} compressor` : ''}.`, compFix());
  }
  /* A short scripted take varies effort on purpose, so its range is a hint, not a verdict */
  if (Number.isFinite(a.lra) && a.lra > P.lra) add('level-swings', a.lraScope === 'whole take' && a.dur >= 60 ? 'warn' : 'info', `Level swings ${fmt(a.lra, 0)} LU`, `The loudness range of your ${a.lraScope} is above ${P.lra} LU for ${P.noun}, so listeners ride the volume. ${P.id === 'calls' ? 'Auto Level or a hardware compressor evens this out.' : 'The compressor in the streaming chain fixes this in OBS.'}`, compFix());
  if (hw && hw.mode === 'auto' && hw.position && d) {
    if (d > 6 && hw.position === 'near') add('position-mismatch', 'warn', 'Position setting mismatch', `You sat ${d} in away with Auto Level set to Near. Far suits 6 to 18 in.`, fix(auto && can('position') && now.position !== 'far', 'Auto Far', { mode: 'auto', position: 'far' }));
    if (d <= 6 && hw.position === 'far') add('position-mismatch', 'warn', 'Position setting mismatch', `You sat ${d} in away with Auto Level set to Far. Near suits 1 to 6 in and gives a fuller sound.`, fix(auto && can('position') && now.position !== 'near', 'Auto Near', { mode: 'auto', position: 'near' }));
  }
  if (!out.some(f => f.sev === 'bad' || f.sev === 'warn')) add('on-target', 'good', `On target for ${P.noun}`, 'Levels, noise and tone all sit inside the targets.');
  const rank = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((x, y) => rank[x.sev] - rank[y.sev]);
}

/* One number per take for the chosen use: points off for each dB outside the target, so close calls stay close */
function fitScore(a, profile) {
  const P = profileOf(profile);
  const out = (v, lo, hi) => !Number.isFinite(v) ? 0 : v < lo ? lo - v : v > hi ? v - hi : 0;
  let s = 100 - 4 * out(a.typPeak, P.peak[0], P.peak[1]) - 2 * out(a.speech, P.speech[0], P.speech[1]) - 2 * Math.max(0, P.snr - a.snr) - 1.5 * Math.max(0, a.noise - P.noise)
    - (a.clips ? 30 : 0) - 3 * Math.max(0, a.peak + 3) - 3 * a.plosives.length - 2 * Math.max(0, a.sibPeak || 0);
  if (a.bands) s -= 1.5 * Math.max(0, -22 - a.bands.rel.Presence) + 1.5 * Math.max(0, a.bands.rel.Body - 16);
  return clamp(Math.round(s), 0, 100);
}

/* The headline for a take: what to do first, in one line */
function verdict(take, ctx = {}) {
  const fs = findingsFor(take, ctx), P = profileOf(ctx.profile), score = fitScore(take.a, P.id);
  /* Two problems can share a fix (boomy and muffled both offer Presence), so each button shows once */
  const seen = new Set(), fixes = fs.filter(f => f.sev === 'bad' || f.sev === 'warn').slice(0, 3)
    .map(f => ({ ...f, fixes: f.fixes.filter(x => !seen.has(x.label) && seen.add(x.label)) }));
  const notes = fs.filter(f => f.sev === 'info' && /^(mic-changed|changed-during-take|browser-processing)$/.test(f.id));
  const title = !fixes.length ? `On target for ${P.noun}` : fixes[0].id === 'too-quiet' || fixes[0].id === 'too-quiet-auto' ? `Too quiet for ${P.noun}` : fixes[0].title;
  return { score, title, fixes, notes, findings: fs };
}

/* Settings sweep: a list of steps, each a target state for the adapter. Built from what the mic can do, so the
   MV7 gets Auto Level tones and Presence, and other mics get the steps they support.
   ctx: { caps, start (state), distance, profile, takes (earlier takes), lastManual } */
function sweepPlan(ctx) {
  const { caps, start, distance: dist } = ctx, P = profileOf(ctx.profile), mid = (P.peak[0] + P.peak[1]) / 2, steps = [];
  const pos = dist && dist > 6 ? 'far' : 'near', Pos = pos === 'near' ? 'Near' : 'Far';
  const keepKeys = caps.manualKeep || [], pickKeep = s => Object.fromEntries(keepKeys.filter(k => s && s[k] != null).map(k => [k, s[k]]));
  const base = start.mode === 'manual' || !caps.mode ? pickKeep(start) : { ...(caps.sweepDefaults || {}), ...pickKeep(ctx.lastManual) };
  /* Aim manual gain from a raw manual reading: this sweep's first one, else the latest earlier take at this distance.
     Auto Level readings can't aim it because the mic picks its own gain there. */
  const rawManual = t => t.meta.hw && (t.meta.hw.mode === 'manual' || !caps.mode) && Number.isFinite(t.meta.hw.gain) && !usedBrowserProcessing(t.meta) && Number.isFinite(t.a.typPeak);
  const aimed = res => {
    const ref = res.find(rawManual) || (ctx.takes || []).slice().reverse().find(t => rawManual(t) && t.meta.distance === dist && !res.includes(t));
    return snapGain(ref ? ref.meta.hw.gain + mid - ref.a.typPeak : start.gain ?? (caps.gain ? caps.gain.max * 0.75 : 27), caps);
  };
  const manual = (res, extra) => ({ ...(caps.mode ? { mode: 'manual' } : {}), gain: aimed(res), ...base, ...extra });
  const current = Object.fromEntries(Object.entries(start).filter(([k]) => (caps.settable || []).includes(k) && !(k === 'gain' && start.mode === 'auto')));
  steps.push({ label: 'Current settings', target: () => current });
  if (caps.mode) {
    if (caps.tones) for (const tone of caps.tones) steps.push({ label: `Auto Level${caps.position ? ' ' + Pos : ''} · ${tone[0].toUpperCase() + tone.slice(1)}`, target: () => ({ mode: 'auto', ...(caps.position ? { position: pos } : {}), tone }) });
    else steps.push({ label: 'Auto Level', target: () => ({ mode: 'auto' }) });
  }
  if (caps.gain) {
    steps.push({ label: 'Manual · gain aimed at target', target: res => manual(res) });
    if (caps.comp) { const alt = base.comp === 2 ? 1 : 2; steps.push({ label: `Manual · aimed gain · ${caps.comp[alt]} compressor`, target: res => manual(res, { comp: alt }) }); }
    if (caps.pres) steps.push({ label: 'Manual · aimed gain · Presence boost', target: res => manual(res, { pres: true }) });
    else if (caps.denoise) steps.push({ label: 'Manual · aimed gain · Denoiser', target: res => manual(res, { denoise: true }) });
  }
  return steps;
}

/* Readings at the same mode and gain differ by a few dB just from how the sentence was read, so a score gap made of that is not a verdict */
function sweepNote(ranked) {
  const [a, b] = ranked; if (!b) return '';
  const dPk = Math.abs(a.take.a.typPeak - b.take.a.typPeak), ha = a.take.meta.hw || {}, hb = b.take.meta.hw || {};
  const sameLevelSetting = ha.mode !== 'auto' && hb.mode !== 'auto' && ha.gain === hb.gain;
  return a.score - b.score < 3 ? 'The top two are within 3 points, about the difference between two readings of the same sentence. Listen to both.'
    : sameLevelSetting && dPk < 3 ? `${a.take.meta.step} and ${b.take.meta.step} differ mostly by ${fmt(dPk)} dB of level, about the variation between two readings of the same sentence. Listen to both.` : '';
}

/* Software chain suggested from a take, for OBS */
function suggestChain(a, profile) {
  const P = profileOf(profile), ch = { ...CHAIN_PRESETS[P.id] }, b = a.bands && a.bands.rel, q = a.phases.find(p => p.id === 'quiet');
  ch.gateOn = P.id !== 'calls' && a.snr > 18;
  /* open the gate between the room noise and your quiet voice */
  const ceilOpen = q && Number.isFinite(q.speech) ? q.speech - 6 : a.speech - 15;
  ch.gateOpen = Math.round(clamp(Math.min(a.noise + Math.max(10, a.snr * 0.4), ceilOpen), -75, -25));
  if (b) {
    ch.eqLow = b.Body > 14 ? -3 : b.Body < 4 ? 2 : 0;
    ch.eqHigh = a.sibPeak > 3 ? -2 : b.Presence < -20 ? 3 : 1;
  }
  ch.thr = Math.round(clamp(a.typPeak - 8, -45, -6)); ch.ratio = Number.isFinite(a.lra) && a.lra > 12 ? 4 : 3;
  ch.target = P.final;
  return ch;
}

export { PROFILES, profileOf, CHAIN_PRESETS, fmt, fmtS, snapGain, findingsFor, fitScore, verdict, sweepPlan, sweepNote, suggestChain, usedBrowserProcessing };
