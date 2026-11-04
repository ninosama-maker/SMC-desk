// SMC cloud scanner. Runs on GitHub Actions every few minutes (no phone needed).
// Finds liquidity sweep + structure shift + order block setups, places simulated
// orders, tracks them with 1-minute candles, and sends Telegram alerts.
const fs = require('fs');

const SYMS = (process.env.SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim()).filter(Boolean);
const TFS = (process.env.TFS || '15m').split(',').map(s => s.trim()).filter(Boolean);
const MIN = +(process.env.MIN || 70), BAL = +(process.env.BAL || 1000), RISK = +(process.env.RISK || 1);
const TFMS = { '5m': 3e5, '15m': 9e5, '1h': 36e5 };
const HOSTS = ['data-api.binance.vision', 'api.binance.us', 'api.binance.com'];
const TG = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
const STATE = process.env.STATE_FILE || 'state.json';

const fx = v => v.toFixed(v > 1000 ? 1 : v > 10 ? 2 : 4);
const usd = v => (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(2);

async function get(path) {
  let err;
  for (const h of HOSTS) {
    try {
      const r = await fetch(`https://${h}${path}`);
      if (!r.ok) throw new Error(`${h} HTTP ${r.status}`);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}
const toC = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });

async function tg(text) {
  console.log('ALERT:', text.replace(/\n/g, ' | '));
  if (!TG || !CHAT) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text })
    });
    if (!r.ok) console.log('Telegram error', r.status);
  } catch (e) { console.log('Telegram failed', e.message); }
}

// ---------- SMC logic ----------
const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map(v => e = v * k + e * (1 - k)); };
const atr = (c, n = 14) => {
  let s = 0, q = 0;
  for (let i = Math.max(1, c.length - n); i < c.length; i++) {
    s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); q++;
  }
  return s / q;
};
function piv(c, n = 3) {
  const H = [], L = [];
  for (let i = n; i < c.length - n; i++) {
    let h = 1, l = 1;
    for (let j = 1; j <= n; j++) {
      if (c[i].h <= c[i - j].h || c[i].h <= c[i + j].h) h = 0;
      if (c[i].l >= c[i - j].l || c[i].l >= c[i + j].l) l = 0;
    }
    if (h) H.push(i);
    if (l) L.push(i);
  }
  return { H, L };
}
function scanLong(c, a) {
  const n = c.length, { H, L } = piv(c);
  for (let s = n - 1; s >= n - 16; s--) {
    const p = [...L].reverse().find(i => i < s - 2 && s - i <= 60 && c[s].l < c[i].l && c[s].c > c[i].l &&
      Math.min(...c.slice(i + 1, s).map(x => x.l)) >= c[i].l);
    if (p === undefined) continue;
    const ph = [...H].reverse().find(i => i < s);
    if (ph === undefined) continue;
    let d = -1;
    for (let i = s; i < Math.min(s + 7, n); i++) {
      if (c[i].c > c[i].o && c[i].c - c[i].o >= 0.8 * a && c[i].c > c[ph].h) { d = i; break; }
    }
    if (d < 0) continue;
    let ob = -1;
    for (let i = d - 1; i >= Math.max(0, s - 4); i--) { if (c[i].c < c[i].o) { ob = i; break; } }
    if (ob < 0) continue;
    const lo = c[ob].l, hi = c[ob].h, en = (lo + hi) / 2, sl = c[s].l - 0.1 * a;
    return { t: c[s].t, age: n - 1 - d, lvl: c[p].l, lo, hi, en, sl, tp: en + 2 * (en - sl) };
  }
  return null;
}
const mir = c => c.map(x => ({ t: x.t, o: -x.o, h: -x.l, l: -x.h, c: -x.c }));
function analyze(all, now = new Date()) {
  const c = all.slice(0, -1), px = all[all.length - 1].c, a = atr(c);
  const cl = c.map(x => x.c), e50 = ema(cl, 50).at(-1), e200 = ema(cl, 200).at(-1);
  const up = e50 > e200 && px > e50, dn = e50 < e200 && px < e50, h = now.getUTCHours(), found = [];
  const L = scanLong(c, a); if (L) found.push({ dir: 'LONG', ...L });
  const m = scanLong(mir(c), a);
  if (m) found.push({ dir: 'SHORT', t: m.t, age: m.age, lvl: -m.lvl, lo: -m.hi, hi: -m.lo, en: -m.en, sl: -m.sl, tp: -m.tp });
  found.forEach(x => {
    const lg = x.dir === 'LONG'; let sc = 65;
    if (lg ? up : dn) sc += 15;
    if ((h >= 7 && h < 10) || (h >= 12 && h < 15)) sc += 10;
    if ((px >= x.lo && px <= x.hi) || Math.abs(px - x.en) <= a * 0.6) sc += 10;
    const prog = (lg ? px - x.en : x.en - px) / Math.abs(x.en - x.sl);
    x.sc = sc;
    x.st = lg ? (px <= x.sl ? 'INVALID' : px >= x.tp ? 'DONE' : prog >= 1 ? 'MISSED' : px <= x.hi ? 'IN ZONE' : 'WAITING')
              : (px >= x.sl ? 'INVALID' : px <= x.tp ? 'DONE' : prog >= 1 ? 'MISSED' : px >= x.lo ? 'IN ZONE' : 'WAITING');
    x.live = x.st === 'IN ZONE' || x.st === 'WAITING';
  });
  found.sort((p, q) => (q.live - p.live) || (q.sc - p.sc) || (p.age - q.age));
  return { px, up, dn, sig: found[0] || null };
}

// ---------- simulated orders ----------
function evalOrder(o, ms) {
  const lg = o.dir === 'LONG', ev = [];
  for (const x of ms) {
    if (o.st === 'PENDING') {
      if (lg ? x.l <= o.en : x.h >= o.en) { o.st = 'OPEN'; o.fillT = x.t; ev.push('fill'); }
      else if (lg ? x.h >= o.tp : x.l <= o.tp) { o.st = 'CANCELLED'; o.closeT = x.t; ev.push('cancel'); return ev; }
      else if (x.t - o.created > 12 * TFMS[o.tf]) { o.st = 'CANCELLED'; o.closeT = x.t; ev.push('expire'); return ev; }
    }
    if (o.st === 'OPEN') {
      if (lg ? x.l <= o.sl : x.h >= o.sl) { o.st = 'LOSS'; o.r = -1; o.closeT = x.t; ev.push('loss'); return ev; }
      if (lg ? x.h >= o.tp : x.l <= o.tp) { o.st = 'WIN'; o.r = o.rr; o.closeT = x.t; ev.push('win'); return ev; }
    }
  }
  return ev;
}
function summary(orders) {
  const cl = orders.filter(o => o.st === 'WIN' || o.st === 'LOSS');
  const cp = cl.reduce((a, o) => a + o.r * o.risk, 0), w = cl.filter(o => o.st === 'WIN').length;
  return `Balance $${(BAL + cp).toFixed(2)}  Closed ${usd(cp)}  Win rate ${cl.length ? Math.round(w / cl.length * 100) + '%' : 'none yet'} (${cl.length} closed)`;
}

const HB = +(process.env.HEARTBEAT_H || 12);
const HELP = 'I am your SMC scanner bot. I send an alert when an order is placed, filled, hits target or hits stop.\nCommands: /status, /orders, /help.\nI check every few minutes, so replies can take up to about 15 minutes.';

function statusText(S, now) {
  const lines = Object.entries(S.last || {}).map(([k, v]) => {
    const [sym, tf] = k.split('|');
    return `${sym.replace('USDT', '')} ${tf}: ${fx(v.px)}, ${v.trend}` + (v.sig ? `, ${v.sig.dir} setup score ${v.sig.sc} (${v.sig.st.toLowerCase()})` : ', no setup');
  });
  const act = S.orders.filter(o => o.st === 'OPEN' || o.st === 'PENDING').length;
  return `Scanner is running. Last check ${new Date(now).toUTCString().slice(17, 22)} UTC.\n${lines.join('\n')}\nActive orders: ${act}\n${summary(S.orders)}`;
}
function ordersText(S) {
  const act = S.orders.filter(o => o.st === 'OPEN' || o.st === 'PENDING');
  const done = S.orders.filter(o => o.st === 'WIN' || o.st === 'LOSS').slice(0, 5);
  const f = o => `${o.sym.replace('USDT', '')} ${o.dir} ${o.st.toLowerCase()}  entry ${fx(o.en)}  stop ${fx(o.sl)}  target ${fx(o.tp)}` + (o.r !== undefined ? `  ${o.r > 0 ? '+' : ''}${o.r.toFixed(1)}R` : '');
  return (act.length ? 'Active:\n' + act.map(f).join('\n') : 'No active orders.') + (done.length ? '\n\nRecent closed:\n' + done.map(f).join('\n') : '');
}
async function commands(S, now) {
  if (!TG || !CHAT) return;
  try {
    const first = S.tgOffset === undefined;
    const q = new URLSearchParams({ offset: String(S.tgOffset || 0), timeout: '0', allowed_updates: JSON.stringify(['message']) });
    const r = await fetch(`https://api.telegram.org/bot${TG}/getUpdates?${q}`);
    const d = await r.json();
    if (!d.ok) { console.log('getUpdates error', d.description); return; }
    for (const u of d.result) {
      S.tgOffset = u.update_id + 1;
      if (first) continue; // skip old messages from before the bot could reply
      const m = u.message;
      if (!m || String(m.chat.id) !== String(CHAT)) continue;
      const t = (m.text || '').trim().toLowerCase().split(/[ @]/)[0];
      if (t === '/status') await tg(statusText(S, now));
      else if (t === '/orders') await tg(ordersText(S));
      else if (t === '/start' || t === '/help') await tg(HELP);
      else await tg('I only send alerts and answer commands. Try /status, /orders or /help.');
    }
    if (S.tgOffset === undefined) S.tgOffset = 0;
  } catch (e) { console.log('commands failed', e.message); }
}

async function main() {
  let S = { orders: [], started: 0 };
  try { S = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {}
  if (!S.started) {
    S.started = Date.now();
    S.lastBeat = Date.now();
    await tg(`SMC scanner is live.\nWatching ${SYMS.map(s => s.replace('USDT', '')).join(', ')} on ${TFS.join(', ')}.\nI will message you when an order is placed, filled, hits target or hits stop.`);
  }
  const now = Date.now();

  // 1) look for new setups and place simulated orders
  for (const sym of SYMS) for (const tf of TFS) {
    try {
      const k = (await get(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=300`)).map(toC);
      const r = analyze(k), x = r.sig;
      S.last = S.last || {};
      S.last[`${sym}|${tf}`] = { px: r.px, trend: r.up ? 'uptrend' : r.dn ? 'downtrend' : 'no clear trend', sig: x ? { dir: x.dir, sc: x.sc, st: x.st } : null };
      if (!x || !x.live || x.sc < MIN) continue;
      const id = `${sym}|${tf}|${x.dir}|${x.t}`;
      if (S.orders.some(o => o.id === id)) continue;
      const o = { id, sym, tf, dir: x.dir, en: x.en, sl: x.sl, tp: x.tp, rr: Math.abs(x.tp - x.en) / Math.abs(x.en - x.sl),
        sc: x.sc, risk: BAL * RISK / 100, created: now, chk: now, st: 'PENDING' };
      S.orders.unshift(o);
      await tg(`${sym.replace('USDT', '')} ${x.dir} order placed (${tf})\nLimit ${fx(x.en)}  Stop ${fx(x.sl)}  Target ${fx(x.tp)}\nScore ${x.sc}/100`);
    } catch (e) { console.log(`scan ${sym} ${tf} failed:`, e.message); }
  }

  // 2) track active orders with 1-minute candles since the last check
  for (const sym of SYMS) {
    const act = S.orders.filter(o => o.sym === sym && (o.st === 'PENDING' || o.st === 'OPEN'));
    if (!act.length) continue;
    try {
      const from = Math.min(...act.map(o => o.chk));
      const ms = (await get(`/api/v3/klines?symbol=${sym}&interval=1m&startTime=${Math.floor(from / 6e4) * 6e4}&limit=1000`)).map(toC)
        .filter(x => x.t + 6e4 <= Date.now());
      for (const o of act) {
        const name = sym.replace('USDT', '');
        for (const e of evalOrder(o, ms.filter(x => x.t >= Math.floor(o.chk / 6e4) * 6e4))) {
          if (e === 'fill') await tg(`${name} ${o.dir} filled at ${fx(o.en)}`);
          if (e === 'win') await tg(`${name} ${o.dir} TARGET HIT ${usd(o.r * o.risk)} (+${o.rr.toFixed(1)}R)\n${summary(S.orders)}`);
          if (e === 'loss') await tg(`${name} ${o.dir} STOP HIT ${usd(-o.risk)} (-1R)\n${summary(S.orders)}`);
          if (e === 'cancel' || e === 'expire') await tg(`${name} ${o.dir} order cancelled (${e === 'expire' ? 'never filled' : 'price ran away'})`);
        }
        if (ms.length) o.chk = ms[ms.length - 1].t + 6e4;
      }
    } catch (e) { console.log(`track ${sym} failed:`, e.message); }
  }

  await commands(S, now);
  if (HB > 0 && S.lastBeat && now - S.lastBeat > HB * 3600e3) {
    S.lastBeat = now;
    await tg('Check-in: ' + statusText(S, now));
  }

  S.orders = S.orders.slice(0, 300);
  S.updated = Date.now();
  fs.writeFileSync(STATE, JSON.stringify(S, null, 1));
  console.log('done.', summary(S.orders));
}

module.exports = { analyze, evalOrder, scanLong, mir, main };
if (require.main === module) main().catch(e => { console.log('fatal', e.message); process.exit(0); });
