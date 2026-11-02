/* Helpers every adapter needs */

/* Restore puts back the first read, so connecting needs every setting. One retry covers a dropped reply. */
async function readAll(d, need) {
  for (let i = 0; i < 2; i++) {
    d.atConnect = null; const s = await d.read(), missing = need(s).filter(k => s[k] == null);
    if (!missing.length) return;
    if (i) throw new Error(`Could not read the mic's ${missing.join(', ')}. Unplug it, plug it back in and connect again.`);
  }
}

/* "on" or "off" as typed in the CLI. Anything else is an error, so a typo never turns a setting off. */
function onOff(v) {
  if (/^(on|true|1|yes)$/i.test(v)) return true;
  if (/^(off|false|0|no)$/i.test(v)) return false;
  throw new Error(`"${v}" is not on or off`);
}

export { readAll, onOff };
