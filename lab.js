// Strategy lab: tests several classic strategies on real Binance history, with fixed rules (no tuning),
// trading costs, and a split between the first 60% of the period (train) and the last 40% (test).
// Run it from GitHub Actions (Actions tab, lab, Run workflow). The report goes to the log and Telegram.
const fs = require('fs');

const DAYS = +(process.env.LAB_DAYS || 730);
const SYMS = (process.env.SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim()).filter(Boolean);
const FEE = (+(process.env.FEE_PCT || 0.1)) / 100;       // round-trip fees + slippage, as a share of the entry price
const RISK_PCT = +(process.env.RISK_PCT || 1);           // % of the account risked per trade, for the "about" lines
const HOSTS = ['data-api.binance.vision', 'api.binance.com', 'api.binance.us'];
const H = 36e5, WARM_DAYS = 260;                         // warm-up so the 200-period averages are ready on daily candles

// ---------- data ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  const errs = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const h of HOSTS) {
      try {
        const r = await fetch(`https://${h}${path}`);
        if (!r.ok) throw new Error(`${h} HTTP ${r.status}`);
        return await r.json();
      } catch (e) { errs.push(e.message); }
    }
    await sleep((attempt + 1) * 2500);
  }
  throw new Error('Binance data download failed: ' + [...new Set(errs)].slice(0, 4).join('; '));
}
async function hourly(sym, start, end) {
  const out = []; let last = -1;
  for (let t = start; t < end; t += 1000 * H) {
    const k = await get(`/api/v3/klines?symbol=${sym}&interval=1h&startTime=${t}&limit=1000`);
    for (const x of k) if (x[0] > last && x[0] < end) { out.push([x[0], +x[1], +x[2], +x[3], +x[4]]); last = x[0]; }
    await sleep(200);
  }
  return out;
}
function aggregate(h1, ms) {                              // build 4h / 1d candles from 1h candles (complete candles only)
  const per = ms / H, out = []; let g = [], b0 = null;
  const flush = () => { if (g.length === per) out.push({ t: b0, o: g[0][1], h: Math.max(...g.map(y => y[2])), l: Math.min(...g.map(y => y[3])), c: g[g.length - 1][4] }); };
  for (const x of h1) {
    const b = Math.floor(x[0] / ms) * ms;
    if (b !== b0) { if (g.length) flush(); g = []; b0 = b; }
    g.push(x);
  }
  if (g.length) flush();
  return out;
}

// ---------- indicators ----------
const emaA = (v, n) => { const k = 2 / (n + 1), out = []; let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; out.push(e); } return out; };
function atrA(c, n = 14) {
  const out = []; let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l;
    if (i < n) { a += tr; if (i === n - 1) a /= n; out.push(i === n - 1 ? a : NaN); } else { a = (a * (n - 1) + tr) / n; out.push(a); }
  }
  return out;
}
function rsiA(cl, n = 14) {
  const out = new Array(cl.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l)); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l)); }
  }
  return out;
}
const prevMax = (v, n) => v.map((_, i) => i < n ? NaN : Math.max(...v.slice(i - n, i)));
const prevMin = (v, n) => v.map((_, i) => i < n ? NaN : Math.min(...v.slice(i - n, i)));
function prep(c) {
  const cache = {}, cl = c.map(x => x.c), hi = c.map(x => x.h), lo = c.map(x => x.l);
  const memo = (k, f) => cache[k] || (cache[k] = f());
  return { c, cl, hi, lo, atr: atrA(c), ema: n => memo('e' + n, () => emaA(cl, n)), rsi: n => memo('r' + n, () => rsiA(cl, n)),
    pmax: (v, n) => memo('M' + (v === hi) + n, () => prevMax(v, n)), pmin: (v, n) => memo('m' + (v === lo) + n, () => prevMin(v, n)) };
}

// ---------- strategies (fixed, textbook settings) ----------
// Each returns { entry(i): {dir, dist} | null, exit(i, pos): bool, target? }. Signals use candle i's close; trades happen at the next open.
function donchian(P, N, X, K, filter) {
  const hh = P.pmax(P.hi, N), ll = P.pmin(P.lo, N), xh = P.pmax(P.hi, X), xl = P.pmin(P.lo, X), e200 = P.ema(200), a = P.atr;
  return {
    entry: i => {
      if (isNaN(hh[i]) || isNaN(a[i]) || isNaN(ll[i])) return null; const c = P.cl[i];
      if (c > hh[i] && (!filter || c > e200[i])) return { dir: 1, dist: K * a[i] };
      if (c < ll[i] && (!filter || c < e200[i])) return { dir: -1, dist: K * a[i] };
      return null;
    },
    exit: (i, pos) => pos.dir === 1 ? P.cl[i] < xl[i] : P.cl[i] > xh[i]
  };
}
function emaCross(P, f, s, K, filter) {
  const ef = P.ema(f), es = P.ema(s), e200 = P.ema(200), a = P.atr;
  return {
    entry: i => {
      if (i < 1 || isNaN(a[i])) return null; const c = P.cl[i];
      if (ef[i - 1] <= es[i - 1] && ef[i] > es[i] && (!filter || c > e200[i])) return { dir: 1, dist: K * a[i] };
      if (ef[i - 1] >= es[i - 1] && ef[i] < es[i] && (!filter || c < e200[i])) return { dir: -1, dist: K * a[i] };
      return null;
    },
    exit: (i, pos) => pos.dir === 1 ? ef[i] < es[i] : ef[i] > es[i]
  };
}
function pullback(P, K, target) {
  const e21 = P.ema(21), e50 = P.ema(50), e200 = P.ema(200), a = P.atr;
  return {
    target,
    entry: i => {
      if (i < 1 || isNaN(a[i])) return null; const cl = P.cl;
      if (e50[i] > e200[i] && cl[i - 1] <= e21[i - 1] && cl[i] > e21[i]) return { dir: 1, dist: K * a[i] };
      if (e50[i] < e200[i] && cl[i - 1] >= e21[i - 1] && cl[i] < e21[i]) return { dir: -1, dist: K * a[i] };
      return null;
    },
    exit: (i, pos) => pos.dir === 1 ? e50[i] < e200[i] : e50[i] > e200[i]
  };
}
function rsiRev(P, lo, hi, K) {
  const r = P.rsi(14), e200 = P.ema(200), a = P.atr;
  return {
    entry: i => {
      if (isNaN(r[i]) || isNaN(a[i])) return null; const c = P.cl[i];
      if (r[i] < lo && c > e200[i]) return { dir: 1, dist: K * a[i] };
      if (r[i] > hi && c < e200[i]) return { dir: -1, dist: K * a[i] };
      return null;
    },
    exit: (i, pos) => pos.dir === 1 ? r[i] > 50 : r[i] < 50
  };
}
const STRATS = [
  { name: 'Donchian breakout 20/10, 4h, no filter', tf: '4h', make: P => donchian(P, 20, 10, 2, false) },
  { name: 'Donchian breakout 20/10, 4h, with 200 EMA trend filter', tf: '4h', make: P => donchian(P, 20, 10, 2, true) },
  { name: 'Donchian breakout 55/20, 4h, with 200 EMA trend filter', tf: '4h', make: P => donchian(P, 55, 20, 2, true) },
  { name: 'Donchian breakout 20/10, daily', tf: '1d', make: P => donchian(P, 20, 10, 2, false) },
  { name: 'Donchian breakout 55/20, daily', tf: '1d', make: P => donchian(P, 55, 20, 2, false) },
  { name: 'EMA 20/50 cross, daily', tf: '1d', make: P => emaCross(P, 20, 50, 2.5, false) },
  { name: 'EMA 20/50 cross, 4h, with 200 EMA filter', tf: '4h', make: P => emaCross(P, 20, 50, 2.5, true) },
  { name: 'Trend pullback (reclaim 21 EMA in a 50/200 trend), 1h, 3R target', tf: '1h', make: P => pullback(P, 1.5, 3) },
  { name: 'Trend pullback, 4h, 3R target', tf: '4h', make: P => pullback(P, 1.5, 3) },
  { name: 'RSI dip buying / rally selling with 200 EMA filter, 1h', tf: '1h', make: P => rsiRev(P, 25, 75, 2) },
  { name: 'RSI dip buying / rally selling with 200 EMA filter, 4h', tf: '4h', make: P => rsiRev(P, 25, 75, 2) }
];

// ---------- simulation (candle by candle, no peeking ahead; if a stop and target are in one candle the stop counts) ----------
function simulate(c, strat, tStart) {
  const trades = []; let pos = null;
  const close = (px, t) => {
    const r = pos.dir * (px - pos.en) / pos.dist, cost = FEE * pos.en / pos.dist;
    trades.push({ t: pos.t, dir: pos.dir, r, net: r - cost, cost, win: r > 0, stop: pos.dist / pos.en });
    pos = null;
  };
  for (let i = 1; i < c.length - 1; i++) {
    const x = c[i];
    if (pos) {
      let px = null;
      if (pos.dir === 1) {
        if (x.l <= pos.stop) px = Math.min(pos.stop, x.o);
        else if (pos.target && x.h >= pos.target) px = Math.max(pos.target, x.o);
      } else {
        if (x.h >= pos.stop) px = Math.max(pos.stop, x.o);
        else if (pos.target && x.l <= pos.target) px = Math.min(pos.target, x.o);
      }
      if (px === null && strat.exit(i, pos)) px = c[i + 1].o;
      if (px !== null) close(px);
      continue;
    }
    if (x.t < tStart) continue;
    const s = strat.entry(i);
    if (s && s.dist > 0) {
      const en = c[i + 1].o;
      pos = { dir: s.dir, en, dist: s.dist, stop: en - s.dir * s.dist, target: strat.target ? en + s.dir * s.dist * strat.target : null, t: c[i + 1].t };
    }
  }
  if (pos) close(c[c.length - 1].c);                       // count a still-open trade at its current value
  return trades;
}

// ---------- results ----------
const sum = a => a.reduce((x, y) => x + y, 0);
const f = (v, d = 2) => v == null || isNaN(v) ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d);
function stats(trades, tSplit) {
  const n = trades.length; if (!n) return { n: 0 };
  const nets = trades.map(t => t.net), mean = sum(nets) / n, sd = n > 1 ? Math.sqrt(sum(nets.map(v => (v - mean) ** 2)) / (n - 1)) : 0;
  const gp = sum(nets.filter(v => v > 0)), gl = -sum(nets.filter(v => v < 0));
  let cum = 0, peak = 0, dd = 0; for (const t of trades.slice().sort((a, b) => a.t - b.t)) { cum += t.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const tr = trades.filter(t => t.t < tSplit), te = trades.filter(t => t.t >= tSplit), avg = a => a.length ? sum(a.map(t => t.net)) / a.length : null;
  return { n, win: 100 * trades.filter(t => t.win).length / n, avg: mean, pf: gl ? gp / gl : 99, total: sum(nets), dd, t: sd ? mean / (sd / Math.sqrt(n)) : 0,
    train: { n: tr.length, avg: avg(tr) }, test: { n: te.length, avg: avg(te) }, cost: sum(trades.map(t => t.cost)) / n };
}
async function main() {
  const end = Math.floor(Date.now() / H) * H, tStart = end - DAYS * 864e5, tSplit = tStart + 0.6 * (end - tStart);
  console.log(`Strategy lab: ${SYMS.join(', ')}, last ${DAYS} days, cost ${(FEE * 100).toFixed(2)}% per trade, split at ${new Date(tSplit).toISOString().slice(0, 10)}`);
  const data = {};
  for (const s of SYMS) {
    console.log('downloading', s, '...');
    data[s] = await hourly(s, tStart - WARM_DAYS * 864e5, end);
    console.log(`  ${s}: ${data[s].length} hourly candles`);
  }
  const hold = SYMS.map(s => { const a = data[s].find(x => x[0] >= tStart), b = data[s][data[s].length - 1]; return a ? `${s.replace('USDT', '')} ${f(100 * (b[4] / a[1] - 1), 0)}%` : null; }).filter(Boolean).join(', ');
  const tfs = { '1h': 1, '4h': 4 * H, '1d': 24 * H }, cands = {};
  for (const s of SYMS) { cands[s] = {}; for (const k of Object.keys(tfs)) { const c = k === '1h' ? data[s].map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] })) : aggregate(data[s], tfs[k]); cands[s][k] = { c, P: prep(c) }; } }
  const lines = [], good = [];
  STRATS.forEach((st, k) => {
    let all = []; const coin = {};
    for (const s of SYMS) { const { c, P } = cands[s][st.tf]; const tr = simulate(c, st.make(P), tStart); all = all.concat(tr); coin[s] = tr.length ? sum(tr.map(t => t.net)) / tr.length : null; }
    const r = stats(all, tSplit);
    if (!r.n) { lines.push(`${k + 1}. ${st.name}: 0 trades`); return; }
    const pos = Object.values(coin).filter(v => v != null && v > 0).length;
    lines.push(`${k + 1}. ${st.name}\n   ${r.n} trades, win ${r.win.toFixed(0)}%, avg ${f(r.avg)}R, PF ${r.pf.toFixed(2)}, total ${f(r.total, 1)}R (about ${f(r.total * RISK_PCT, 0)}% at ${RISK_PCT}% risk), worst drop ${r.dd.toFixed(1)}R\n   train ${f(r.train.avg)}R (${r.train.n}), test ${f(r.test.avg)}R (${r.test.n}), luck check ${r.n < 10 ? 'too few trades' : 't-score ' + r.t.toFixed(1)}, profitable on ${pos} of ${SYMS.length} coins`);
    if (r.n >= 40 && r.avg > 0 && r.pf >= 1.2 && r.t >= 1.5 && r.train.avg > 0 && r.test.avg > 0 && pos >= 2) good.push({ st, r });
  });
  good.sort((a, b) => b.r.avg - a.r.avg);
  const verdict = good.length
    ? `Promising (40+ trades, profit factor 1.2+, t-score 1.5+, profit in both train and test, 2+ coins): ${good.map(g => g.st.name).join('; ')}. I tested ${STRATS.length} strategies, so the best one looks better than it really is. Paper trade it for a few weeks first.`
    : 'No strategy passed every check (40+ trades, profit factor 1.2+, t-score 1.5+, profit in both train and test, 2+ coins). Do not trade real money with these yet.';
  const text = [`Strategy lab, last ${DAYS} days, ${SYMS.map(s => s.replace('USDT', '')).join('/')}. R = your risk per trade; costs included. Just holding: ${hold}.`, '', ...lines, '', verdict].join('\n');
  console.log('\n' + text);
  const TG = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
  if (TG && CHAT) {
    for (let p = 0; p < text.length; p += 3800) {
      try { const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: text.slice(p, p + 3800) }) }); console.log(r.ok ? 'Sent to Telegram.' : `Telegram error ${r.status}`); }
      catch (e) { console.log('Telegram failed', e.message); }
    }
  }
}
module.exports = { simulate, donchian, emaCross, pullback, rsiRev, prep, aggregate, stats };
if (require.main === module) main().catch(e => { console.log('fatal', e.message); process.exit(1); });
