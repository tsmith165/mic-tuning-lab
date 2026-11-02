/* Runs kept in this browser with Dexie (IndexedDB). A run row holds a run@1 record from core/runs.js, and an
   audio row holds a take's WAV bytes under the file name the runs folder uses. When mic-lab serve runs the page,
   the browser and the runs folder share one history. */
import Dexie from '../vendor/dexie.mjs';
import { checkRun } from '../core/runs.js';

const db = new Dexie('mic-lab');
/* Version 1. A release that changes these tables adds db.version(2).stores({...}).upgrade(tx => ...) below it. */
db.version(1).stores({ runs: 'id, createdAt', audio: 'name, run' });

const served = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
let remote = null;

async function api(method, path, body, type) {
  const r = await fetch(path, { method, body, cache: 'no-store', headers: type ? { 'content-type': type } : {} });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${method} ${path} answered ${r.status}`);
  return r;
}
const dropLocal = id => db.transaction('rw', db.runs, db.audio, async () => { await db.runs.delete(id); await db.audio.where('run').equals(id).delete(); });

/* Audio first, then the record, so the folder never lists a run whose audio is missing */
async function push(id) {
  if (!remote) return;
  const row = await db.runs.get(id); if (!row) return;
  for (const t of row.rec.takes) { const a = t.audio && await db.audio.get(t.audio); if (a) await api('PUT', '/api/audio/' + t.audio, a.bytes, 'audio/wav'); }
  await api('PUT', '/api/runs/' + id, JSON.stringify(row.rec), 'application/json');
  await db.runs.update(id, { synced: true });
}

const store = {
  get remote() { return remote; },
  async open() { await db.open(); try { await navigator.storage.persist(); } catch { } },
  async all() { return (await db.runs.orderBy('createdAt').toArray()).map(r => r.rec); },
  async put(rec, audio = []) {
    await db.transaction('rw', db.runs, db.audio, async () => {
      for (const a of audio) await db.audio.put({ name: a.name, run: rec.id, bytes: a.bytes });
      await db.runs.put({ id: rec.id, createdAt: rec.createdAt, rec, synced: false });
    });
    push(rec.id).catch(e => console.warn('Run not copied to the runs folder yet:', e.message));
  },
  async del(id) { await dropLocal(id); if (remote) await api('DELETE', '/api/runs/' + id).catch(() => { }); },
  async audio(name) {
    const row = await db.audio.get(name); if (row) return row.bytes;
    if (!remote) return null;
    const bytes = new Uint8Array(await (await api('GET', '/api/audio/' + name)).arrayBuffer());
    await db.audio.put({ name, run: name.replace(/-\d+\.wav$/, ''), bytes });
    return bytes;
  },
  async bytesUsed() { try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; } },
  /* Copies runs that are only on one side. A run synced before and now gone from the folder was removed there
     (mic-lab runs rm), so it is removed here too. Returns null when no runs folder is reachable. */
  async sync() {
    if (!served) return null;
    let list; try { list = await (await api('GET', '/api/runs')).json(); } catch { remote = null; return null; }
    remote = { dir: list.dir };
    const there = new Map(list.runs.map(r => [r.id, r])), here = await db.runs.toArray(), ids = new Set(here.map(r => r.id)), out = { pulled: 0, pushed: 0, removed: 0, dir: list.dir };
    for (const row of here) {
      if (there.has(row.id)) { if (!row.synced) await db.runs.update(row.id, { synced: true }); }
      else if (row.synced) { await dropLocal(row.id); out.removed++; }
      else { try { await push(row.id); out.pushed++; } catch (e) { console.warn(e.message); } }
    }
    for (const [id, rec] of there) if (!ids.has(id)) { try { checkRun(rec); await db.runs.put({ id, createdAt: rec.createdAt, rec, synced: true }); out.pulled++; } catch { } }
    return out;
  },
};

export { store };
