/* The report agents and people read: one JSON object per take, the same from the page and the CLI.
   Field names carry their units. Bump SCHEMA when a field changes meaning. */
import { profileOf, fitScore, verdict } from './advice.js';

const SCHEMA = 'mic-lab/report@1';
const r1 = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
/* The CLI command that applies a fix, so an agent can act on a finding */
const commandFor = set => 'mic-lab device set ' + Object.entries(set).map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`).join(' ');

/* take: { name, created, a (analysis), meta: { mode, distance, note, device, proc, hw, adapter, hwChanged, step, sweepId } }
   ctx: { profile, adapter, caps, now, describe, describeHw(hw, adapterId) } as for findingsFor */
function takeSummary(take, ctx = {}) {
  const a = take.a, m = take.meta || {}, P = profileOf(ctx.profile), v = verdict(take, ctx);
  const describe = ctx.describeHw ? h => ctx.describeHw(h, m.adapter) : ctx.describe || (() => null);
  return {
    take: take.name || null, createdAt: take.created ? new Date(take.created).toISOString() : null, use: P.id,
    recording: { mode: m.mode || 'file', distanceIn: m.distance ?? null, note: m.note || '', inputDevice: m.device || null, browserProcessing: m.proc || null, sweepStep: m.step || null },
    mic: m.hw ? { adapter: m.adapter || null, settings: m.hw, text: describe(m.hw), changedDuringTake: !!m.hwChanged } : null,
    score: fitScore(a, P.id), verdict: v.title,
    metrics: {
      durationS: r1(a.dur), sampleRateHz: a.fs, speechPeaksDbfs: r1(a.typPeak), speechRmsDbfs: r1(a.speech), maxPeakDbfs: r1(a.peak), projectedPeakDbfs: r1(a.loudPeak), clips: a.clips,
      loudnessLufs: r1(a.callLufs), integratedLufs: r1(a.integrated), loudnessRangeLu: r1(a.lra), loudnessRangeOf: a.lraScope,
      noiseFloorDbfs: r1(a.noise), voiceOverNoiseDb: r1(a.snr), plosives: a.plosives.length, sibilanceDb: r1(a.sibPeak), humHz: a.hum ? a.hum.f0 : null,
      bandsVsMidDb: a.bands ? Object.fromEntries(Object.entries(a.bands.rel).filter(([k]) => k !== 'Mid').map(([k, x]) => [k, r1(x)])) : null,
    },
    targets: { speechPeaksDbfs: P.peak, speechRmsDbfs: P.speech, noiseFloorMaxDbfs: P.noise, voiceOverNoiseMinDb: P.snr, loudnessRangeMaxLu: P.lra },
    segments: a.phases.map(p => ({ segment: p.id, lufs: r1(p.lufs), speechPeaksDbfs: r1(p.peak), overNoiseDb: r1(p.speech - a.noise) })),
    findings: v.findings.map(f => ({ id: f.id, severity: f.sev, title: f.title, detail: f.detail, fixes: f.fixes.map(x => ({ label: x.label, set: x.set, command: commandFor(x.set) })) })),
  };
}

function report(takes, ctx = {}) {
  const P = profileOf(ctx.profile), describe = ctx.describe || (() => null);
  const summaries = takes.map(t => takeSummary(t, ctx)), sweepId = takes.length > 1 && takes.every(t => t.meta && t.meta.sweepId && t.meta.sweepId === takes[0].meta.sweepId) ? takes[0].meta.sweepId : null;
  return {
    schema: SCHEMA, generatedAt: new Date().toISOString(), use: P.id,
    mic: ctx.adapter ? { adapter: ctx.adapter.id, name: ctx.adapter.name, tested: ctx.adapter.tested, settings: ctx.now || null, text: ctx.now ? describe(ctx.now) : null } : null,
    sweepRanking: sweepId ? summaries.slice().sort((x, y) => y.score - x.score).map(s => ({ take: s.take, step: s.recording.sweepStep, score: s.score })) : null,
    takes: summaries,
  };
}

/* Markdown for pasting into a chat: short lines first, then the JSON */
function reportMarkdown(rep, extra = '') {
  const P = profileOf(rep.use), L = [`# Mic Tuning Lab report`, `Use: ${P.label} · ${new Date(rep.generatedAt).toLocaleString()}`, `Mic now: ${rep.mic ? `${rep.mic.name} · ${rep.mic.text || 'unknown'}` : 'no hardware control'}`, ''];
  if (rep.sweepRanking) L.push(`Sweep ranking: ${rep.sweepRanking.map(s => `${s.step} ${s.score}`).join(' · ')}`, '');
  for (const t of rep.takes) {
    const m = t.metrics;
    L.push(`## ${t.take || 'Take'} · ${t.recording.mode} · ${t.recording.distanceIn ?? '?'} in · ${t.mic ? t.mic.text : 'hardware unknown'}${t.recording.note ? ' · ' + t.recording.note : ''} · score ${t.score}`);
    L.push(`Speech peaks ${m.speechPeaksDbfs} dBFS · speech level ${m.speechRmsDbfs} dBFS · max ${m.maxPeakDbfs} (${m.clips} clips) · ${m.loudnessLufs} LUFS · range ${m.loudnessRangeLu} LU · noise ${m.noiseFloorDbfs} dBFS · voice over noise ${m.voiceOverNoiseDb} dB · plosives ${m.plosives} · sibilance ${m.sibilanceDb} dB${m.humHz ? ' · hum ' + m.humHz + ' Hz' : ''}`);
    if (m.bandsVsMidDb) L.push(`Bands vs mid: ${Object.entries(m.bandsVsMidDb).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    t.findings.forEach(f => L.push(`- [${f.severity}] ${f.title}: ${f.detail}${f.fixes.length ? ` Fix: ${f.fixes.map(x => '`' + x.command + '`').join(' or ')}` : ''}`));
    L.push('');
  }
  if (extra) L.push(extra, '');
  L.push('```json', JSON.stringify(rep), '```');
  return L.join('\n');
}

export { SCHEMA, takeSummary, report, reportMarkdown, commandFor };
