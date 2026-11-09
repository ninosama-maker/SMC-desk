// Backtest: replays the bot's strategy on real Binance history and compares settings.
// Run it from GitHub Actions (Actions tab, backtest, Run workflow). It sends the result to Telegram.
// It tests the SAME code as scanner.js, with 1-minute candles for exact fills, fees and slippage included.
const fs = require('fs'), cp = require('child_process');

const DAYS = +(process.env.BT_DAYS || 60);
const SYMS = (process.env.SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim()).filter(Boolean);
const TF = process.env.BT_TF || '15m';
const TFMS = { '5m': 3e5, '15m': 9e5 }[TF] || 9e5;
const FEE = (+(process.env.FEE_PCT || 0.06)) / 100;     // round-trip fees + slippage, as a share of the entry price
const MINSCORE = +(process.env.MIN || 70);
const MAXDAY = +(process.env.MAX_TRADES_PER_DAY || 3);
const TZ = process.env.BT_TZ || 'Asia/Kolkata';
const CUT = +(process.env.CUTOFF_HOUR || 21);
const DATA = process.env.BT_DATA || '/tmp/bt-data.json';
const HOSTS = ['data-api.binance.vision', 'api.binance.com', 'api.binance.us'];
const STEP = { '1m': 6e4, '15m': 9e5, '5m': 3e5, '1h': 36e5 };

// ---------- data ----------
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
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } }));
  return out;
}
async function range(sym, interval, start, end, conc) {
  const chunk = STEP[interval] * 1000, starts = [];
  for (let t = start; t < end; t += chunk) starts.push(t);
  const parts = await pool(starts, conc || 1, async t => (await get(`/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${t}&limit=1000`)).map(x => [x[0], +x[1], +x[2], +x[3], +x[4]]));
  const out = []; let last = -1;
  for (const p of parts) for (const x of p) if (x[0] > last && x[0] < end) { out.push(x); last = x[0]; }
  return out;
}
async function download() {
  const end = Math.floor(Date.now() / 36e5) * 36e5;           // last full hour
  const tStart = end - DAYS * 864e5, warm = tStart - 12 * 864e5;
  const data = { tStart, end, tf: TF };
  for (const sym of SYMS) {
    console.log('downloading', sym, '...');
    data[sym] = {
      m15: await range(sym, TF, warm, end),
      h1: await range(sym, '1h', warm, end),
      m1: await range(sym, '1m', tStart, end, 6)
    };
    console.log(`  ${sym}: ${data[sym].m15.length} x ${TF}, ${data[sym].h1.length} x 1h, ${data[sym].m1.length} x 1m`);
  }
  fs.writeFileSync(DATA, JSON.stringify(data));
}

// ---------- replay (runs in a child process so each setting loads scanner.js with its own switches) ----------
function localHour(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false }).formatToParts(new Date(ms));
  return parseInt(f.find(p => p.type === 'hour').value, 10) % 24;
}
function child() {
  const m = require('./scanner.js');
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const S = {};
  for (const sym of SYMS) {
    const d = data[sym];
    S[sym] = { c: d.m15.map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4] })), h1: d.h1.map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4] })),
      m1: d.m1.map(a => ({ t: a[0], h: a[2], l: a[3] })), hp: 0, mp: 0, seen: new Set() };
  }
  const base = S[SYMS[0]].c, trades = [], perDay = new Map();
  let cancelled = 0, unresolved = 0;
  let i0 = 300; while (i0 < base.length && base[i0].t < data.tStart) i0++;
  for (let i = i0; i < base.length; i++) {
    const now = base[i].t + TFMS;
    const day = m.tradingDay(now, TZ), hr = localHour(now);
    const open = hr >= 5 && hr < CUT;
    for (const sym of SYMS) {
      const s = S[sym];
      if (!s.c[i] || s.c[i].t !== base[i].t) continue;
      while (s.hp < s.h1.length && s.h1[s.hp].t + 36e5 <= now) s.hp++;
      while (s.mp < s.m1.length && s.m1[s.mp].t < now) s.mp++;
      if (!open || (perDay.get(day) || 0) >= MAXDAY) continue;      // same gates as the live bot
      const px = s.c[i].c, all = s.c.slice(i - 299, i + 1).concat([{ t: now, o: px, h: px, l: px, c: px }]);
      const res = m.analyze(all, new Date(now), s.h1.slice(Math.max(0, s.hp - 250), s.hp), TZ), x = res.sig;
      if (!x || !x.live || x.sc < MINSCORE) continue;
      const id = `${sym}|${x.dir}|${x.t}`;
      if (s.seen.has(id)) continue;
      s.seen.add(id);
      const o = { id, sym, dir: x.dir, en: x.en, sl: x.sl, tp: x.tp, rr: Math.abs(x.tp - x.en) / Math.abs(x.en - x.sl), created: now, tf: TF, st: 'PENDING' };
      perDay.set(day, (perDay.get(day) || 0) + 1);
      m.evalOrder(o, s.m1.slice(s.mp, s.mp + 20000));
      if (o.st === 'WIN' || o.st === 'LOSS') {
        const net = o.r - (FEE * o.en) / Math.abs(o.en - o.sl);   // costs expressed in R
        trades.push({ sym, dir: o.dir, t: now, win: o.st === 'WIN', r: o.r, net });
      } else if (o.st === 'CANCELLED') cancelled++; else unresolved++;
    }
  }
  console.log('@@RESULT@@' + JSON.stringify(stats(trades, data.tStart, data.end, DAYS, cancelled, unresolved)));
}
function stats(trades, t0, t1, days, cancelled, unresolved) {
  const n = trades.length, sum = a => a.reduce((x, y) => x + y, 0);
  if (!n) return { n: 0, cancelled, unresolved };
  const nets = trades.map(t => t.net), gp = sum(nets.filter(v => v > 0)), gl = -sum(nets.filter(v => v < 0));
  let cum = 0, peak = 0, dd = 0, st = 0, ms = 0;
  for (const t of trades) { cum += t.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (t.win) st = 0; else { st++; ms = Math.max(ms, st); } }
  const mean = sum(nets) / n, sd = n > 1 ? Math.sqrt(sum(nets.map(v => (v - mean) ** 2)) / (n - 1)) : 0, tScore = sd ? mean / (sd / Math.sqrt(n)) : 0;
  const mid = (t0 + t1) / 2, a = trades.filter(t => t.t < mid), b = trades.filter(t => t.t >= mid);
  const avg = x => x.length ? sum(x.map(t => t.net)) / x.length : null;
  const coins = {}; for (const t of trades) (coins[t.sym] = coins[t.sym] || []).push(t.net);
  return { n, win: 100 * trades.filter(t => t.win).length / n, avgR: sum(nets) / n, pf: gl ? gp / gl : 99, totalR: sum(nets), maxDD: dd, streak: ms, tScore, perDay: n / days,
    firstHalf: { n: a.length, avgR: avg(a) }, secondHalf: { n: b.length, avgR: avg(b) },
    coins: Object.fromEntries(Object.entries(coins).map(([k, v]) => [k, { n: v.length, avgR: sum(v) / v.length }])), cancelled, unresolved };
}

// ---------- compare settings ----------
const CONFIGS = [
  { name: 'Current: key levels only, ADX 20+', env: {} },
  { name: 'Any swing sweep (levels off)', env: { REQUIRE_LEVEL: 'off' } },
  { name: 'Levels off, ADX 25+', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '25' } },
  { name: 'Levels off, 3R target', env: { REQUIRE_LEVEL: 'off', MIN_RR: '3' } },
  { name: 'Levels off, ADX 25+, 3R target', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '25', MIN_RR: '3' } },
  { name: 'Levels off, ADX 30+, 3R target', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '30', MIN_RR: '3' } },
  { name: 'Levels off, ADX 25+, 4R target', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '25', MIN_RR: '4' } },
  { name: 'Levels off, ADX 25+, 3R, killzones only', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '25', MIN_RR: '3', KILLZONE_ONLY: 'on' } },
  { name: 'Key levels, ADX 25+, 3R target', env: { ADX_MIN: '25', MIN_RR: '3' } },
  { name: 'Levels off, ADX 25+, 3R, score 80+', env: { REQUIRE_LEVEL: 'off', ADX_MIN: '25', MIN_RR: '3', MIN: '80' } }
];
function runChild(cfg) {
  return new Promise(res => {
    const p = cp.spawn(process.execPath, [__filename, '--child'], { env: { ...process.env, ...cfg.env, BT_DATA: DATA } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', () => { const m = out.match(/@@RESULT@@(.*)/); res(m ? JSON.parse(m[1]) : { error: (err || out).slice(0, 200) }); });
  });
}
const f = (v, d = 2) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d);
async function main() {
  if (process.argv.includes('--child')) return child();
  console.log(`Backtest: ${SYMS.join(', ')} on ${TF}, last ${DAYS} days, cost ${(FEE * 100).toFixed(2)}% per trade, max ${MAXDAY} trades/day`);
  if (!fs.existsSync(DATA) || process.env.BT_REFRESH) await download();
  const list = CONFIGS.slice(0, +(process.env.BT_LIMIT || CONFIGS.length));
  const results = await pool(list, 2, async cfg => ({ cfg, r: await runChild(cfg) }));
  const lines = [], good = [];
  results.forEach(({ cfg, r }, k) => {
    if (r.error) { lines.push(`${k + 1}. ${cfg.name}: failed (${r.error})`); return; }
    if (!r.n) { lines.push(`${k + 1}. ${cfg.name}: 0 trades`); return; }
    lines.push(`${k + 1}. ${cfg.name}\n   ${r.n} trades (${r.perDay.toFixed(2)}/day), win ${r.win.toFixed(0)}%, avg ${f(r.avgR)}R/trade, PF ${r.pf.toFixed(2)}, total ${f(r.totalR, 1)}R, worst drop ${r.maxDD.toFixed(1)}R\n   1st half ${f(r.firstHalf.avgR)}${r.firstHalf.n ? 'R' : ''} (${r.firstHalf.n} trades), 2nd half ${f(r.secondHalf.avgR)}${r.secondHalf.n ? 'R' : ''} (${r.secondHalf.n} trades)\n   luck check: ${r.n < 10 ? 'too few trades to judge' : 't-score ' + r.tScore.toFixed(1) + ' (2 or more = unlikely to be luck)'}`);
    if (r.n >= 40 && r.avgR > 0 && r.pf >= 1.2 && r.tScore >= 1.5 && r.firstHalf.avgR > 0 && r.secondHalf.avgR > 0) good.push({ cfg, r });
  });
  good.sort((a, b) => b.r.avgR - a.r.avgR);
  const verdict = good.length
    ? `Promising (40+ trades, profit factor 1.2+, t-score 1.5+, profitable in both halves): ${good.map(g => g.cfg.name).join('; ')}. Best: ${good[0].cfg.name} at ${f(good[0].r.avgR)}R per trade. I tested ${list.length} settings on one period, so the best one looks better than it really is. Paper trade it for a few weeks before trusting it.`
    : `No setting passed the check (40+ trades, profit factor 1.2+, t-score 1.5+, profitable in both halves). With few trades, results can be luck either way. Do not trade real money with this yet.`;
  const head = `Backtest, last ${DAYS} days, ${SYMS.map(s => s.replace('USDT', '')).join('/')} on ${TF}. R = your risk per trade; costs included.`;
  const text = [head, '', ...lines, '', verdict].join('\n');
  console.log('\n' + text);
  const TG = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
  if (TG && CHAT) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 4000) }) });
      console.log(r.ok ? 'Sent to Telegram.' : `Telegram error ${r.status}`);
    } catch (e) { console.log('Telegram failed', e.message); }
  }
}
main().catch(e => { console.log('fatal', e.message); process.exit(1); });
