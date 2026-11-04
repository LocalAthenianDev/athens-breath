// Κρατάει στη μνήμη τις ωριαίες μετρήσεις των τελευταίων ημερών και υπολογίζει
// τα στατιστικά ανά σταθμό, ανά δημοτική κοινότητα και για όλη την πόλη.
import { readFile } from 'node:fs/promises';
import { clean, eaqi, BANDS, WHO_24H, LEVELS } from './airquality.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);
const VALUES = ['pm2_5', 'pm10', 'no2', 'o3', 'so2', 'co', 'temperature', 'humidity'];
const COMMUNITY_NAMES = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [i, `${i}η Δημοτική Κοινότητα`]));

const coordsP = readFile(new URL('../data/station-coords.json', import.meta.url), 'utf8').then(JSON.parse);
const centroidsP = readFile(new URL('../data/centroids.json', import.meta.url), 'utf8').then(JSON.parse);

// ---------- χρόνος Αθήνας ----------
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const localCache = new Map();
// Το interval_timestamp είναι το τέλος της ώρας μέτρησης (στρογγυλοποίηση προς τα πάνω),
// οπότε η μέτρηση ανήκει στην προηγούμενη ώρα: 15:00 UTC → μετρήσεις 14:00–15:00.
function local(t) {
  let r = localCache.get(t);
  if (!r) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t - HOUR)).map((x) => [x.type, x.value]));
    r = { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
    localCache.set(t, r);
  }
  return r;
}

const parseTs = (s) => Date.parse(String(s).slice(0, 19) + 'Z');
const cleanName = (s) => String(s || '').replace(/_\d+$/, '').replace(/\s+/g, ' ').trim();
const nn = (s) => String(s).toUpperCase().replace(/I/g, 'Ι').replace(/Σ{2}/g, 'Σ').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^Α-ΩA-Z0-9]/g, '');

// ---------- βοηθητικά ----------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

// ---------- κατάσταση ----------
export const state = {
  rows: new Map(), // `${sid}|${t}` -> εγγραφή
  meta: new Map(), // sid -> { name, nb, dk }
  registry: new Map(), // sid -> εγγραφή Μητρώου
  latest: 0,
};

export function ingest(records) {
  let added = 0;
  for (const rec of records) {
    const sid = Number(rec.station_id);
    const t = parseTs(rec.interval_timestamp);
    if (!sid || !Number.isFinite(t)) continue;
    const key = `${sid}|${t}`;
    if (!state.rows.has(key)) added++;
    const { v, pmRejected } = clean(rec);
    state.rows.set(key, { sid, t, v, pmRejected, aqiSrc: rec.aqi ?? null });
    state.meta.set(sid, { name: cleanName(rec.station_name), nb: rec.neighbourhood_name || '', dk: Number(rec.municipal_district_id) || null });
    if (t > state.latest) state.latest = t;
  }
  // Κράτα μόνο το παράθυρο ημερών
  const cutoff = state.latest - WINDOW_DAYS * DAY;
  for (const [k, r] of state.rows) if (r.t <= cutoff) state.rows.delete(k);
  return added;
}

export function setRegistry(records) {
  for (const r of records) state.registry.set(Number(r.station_id), r);
}

// ---------- στατιστικά μιας ωριαίας σειράς ----------
// series: [{ t, v: {pm2_5,...}, level }] ταξινομημένη κατά χρόνο
function summarize(series, latest) {
  const out = {};
  const win = (h) => series.filter((r) => r.t > latest - h * HOUR);
  const periods = { h24: 24, d7: 24 * 7, d30: 24 * WINDOW_DAYS };
  for (const [name, hours] of Object.entries(periods)) {
    const rows = win(hours);
    const o = { hours: rows.length };
    for (const k of VALUES) {
      const vals = rows.map((r) => r.v[k]).filter((x) => x !== null && x !== undefined);
      // Χρειάζεται κάλυψη τουλάχιστον 50% των ωρών για να βγει μέσος όρος
      o[k] = vals.length >= Math.max(1, hours * 0.5) ? r1(mean(vals)) : null;
    }
    o.level = eaqi(o).level;
    const lv = rows.map((r) => r.level).filter((x) => x);
    o.goodShare = lv.length ? Math.round((100 * lv.filter((x) => x <= 2).length) / lv.length) : null;
    o.poorShare = lv.length ? Math.round((100 * lv.filter((x) => x >= 4).length) / lv.length) : null;
    out[name] = o;
  }

  // Τελευταία μέτρηση (μέχρι 3 ώρες πριν από την πιο πρόσφατη ώρα του dataset)
  const last = series[series.length - 1];
  out.now = last && last.t >= latest - 3 * HOUR
    ? { t: new Date(last.t).toISOString(), level: last.level, driver: last.driver, ...Object.fromEntries(VALUES.map((k) => [k, r1(last.v[k])])) }
    : null;

  // Ημερήσιοι μέσοι όροι (ημέρα Αθήνας), μόνο με ≥ 18 έγκυρες ώρες
  const days = new Map();
  for (const r of series) {
    const d = local(r.t).day;
    let o = days.get(d);
    if (!o) days.set(d, (o = { n: 0, ...Object.fromEntries(VALUES.map((k) => [k, []])) }));
    o.n++;
    for (const k of VALUES) if (r.v[k] !== null && r.v[k] !== undefined) o[k].push(r.v[k]);
  }
  out.daily = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, o]) => {
    const d = { day };
    for (const k of VALUES) d[k] = o[k].length >= 18 ? r1(mean(o[k])) : null;
    d.level = eaqi(d).level;
    return d;
  });

  // Πόσες ημέρες ξεπεράστηκε η ημερήσια τιμή του ΠΟΥ
  out.who = {};
  for (const [k, lim] of Object.entries(WHO_24H)) {
    const ds = out.daily.filter((d) => d[k] !== null);
    out.who[k] = ds.length ? { days: ds.length, over: ds.filter((d) => d[k] > lim).length, limit: lim } : null;
  }

  // Προφίλ ανά ώρα της ημέρας (ώρα Αθήνας)
  const prof = Array.from({ length: 24 }, () => ({ pm2_5: [], no2: [], o3: [], temperature: [], level: [] }));
  for (const r of series) {
    const h = local(r.t).hour;
    for (const k of ['pm2_5', 'no2', 'o3', 'temperature']) if (r.v[k] !== null && r.v[k] !== undefined) prof[h][k].push(r.v[k]);
    if (r.level) prof[h].level.push(r.level);
  }
  out.hourly = prof.map((p, hour) => ({
    hour,
    pm2_5: r1(mean(p.pm2_5)), no2: r1(mean(p.no2)), o3: r1(mean(p.o3)), temperature: r1(mean(p.temperature)),
    level: p.level.length ? Math.round(mean(p.level) * 100) / 100 : null,
  }));
  // Καλύτερη και χειρότερη ώρα: με βάση τον μέσο δείκτη, ισοπαλίες με τα PM2.5
  const ranked = out.hourly.filter((h) => h.level !== null)
    .map((h) => ({ hour: h.hour, score: h.level + (h.pm2_5 ?? 0) / 1000 + (h.no2 ?? 0) / 10000 }))
    .sort((a, b) => a.score - b.score);
  out.bestHour = ranked.length ? ranked[0].hour : null;
  out.worstHour = ranked.length ? ranked[ranked.length - 1].hour : null;

  // Τελευταίες 72 ώρες για γράφημα
  out.recent = series.filter((r) => r.t > latest - 72 * HOUR).map((r) => ({
    t: new Date(r.t).toISOString(), level: r.level,
    pm2_5: r1(r.v.pm2_5), pm10: r1(r.v.pm10), no2: r1(r.v.no2), o3: r1(r.v.o3), temperature: r1(r.v.temperature),
  }));
  return out;
}

// Μέσο προφίλ ενός συνόλου σταθμών: για κάθε ώρα, η διάμεσος των σταθμών που μέτρησαν έγκυρα.
function combine(seriesList) {
  const byT = new Map();
  for (const s of seriesList) for (const r of s) {
    let o = byT.get(r.t);
    if (!o) byT.set(r.t, (o = Object.fromEntries(VALUES.map((k) => [k, []]))));
    for (const k of VALUES) if (r.v[k] !== null && r.v[k] !== undefined) o[k].push(r.v[k]);
  }
  return [...byT.entries()].sort(([a], [b]) => a - b).map(([t, o]) => {
    const v = Object.fromEntries(VALUES.map((k) => [k, median(o[k])]));
    const e = eaqi(v);
    return { t, v, level: e.level, driver: e.driver };
  });
}

const slim = (s) => ({ now: s.now, h24: s.h24, d7: s.d7, d30: s.d30, who: s.who, bestHour: s.bestHour, worstHour: s.worstHour });

// ---------- πλήρης υπολογισμός ----------
export async function compute() {
  const [coords, centroids] = await Promise.all([coordsP, centroidsP.catch(() => ({ g: {}, k: {} }))]);
  const latest = state.latest;
  const bySid = new Map();
  for (const r of state.rows.values()) {
    if (!bySid.has(r.sid)) bySid.set(r.sid, []);
    bySid.get(r.sid).push(r);
  }

  const stations = [];
  const detail = { station: {}, community: {}, city: null };
  const seriesBySid = new Map();
  for (const [sid, rows] of bySid) {
    rows.sort((a, b) => a.t - b.t);
    const meta = state.meta.get(sid) || {};
    const reg = state.registry.get(sid);
    // Χαλασμένος αισθητήρας σωματιδίων: πάνω από 25% απορρίψεις την τελευταία εβδομάδα
    const week = rows.filter((r) => r.t > latest - 7 * DAY);
    const rejectShare = week.length ? week.filter((r) => r.pmRejected).length / week.length : 0;
    const pmFault = rejectShare > 0.25;
    const series = rows.map((r) => {
      const v = pmFault ? { ...r.v, pm1: null, pm2_5: null, pm10: null } : r.v;
      const e = eaqi(v);
      return { t: r.t, v, level: e.level, driver: e.driver };
    });
    seriesBySid.set(sid, series);
    const s = summarize(series, latest);

    let pos = coords[sid];
    let how = pos?.how;
    if (!pos) {
      const c = centroids.g[nn(meta.nb)] || centroids.k[meta.dk];
      if (c) { pos = { lat: c[0], lon: c[1] }; how = centroids.g[nn(meta.nb)] ? 'neighbourhood-centroid' : 'community-centroid'; }
    }
    const last = rows[rows.length - 1].t;
    const st = {
      id: sid,
      name: meta.name || reg?.station_name || `Σταθμός ${sid}`,
      neighbourhood: meta.nb || reg?.neighbourhood_name || null,
      community: meta.dk || Number(reg?.municipal_district_id) || null,
      address: reg?.station_address || null,
      citizenhub: reg?.neighbourhood_url || null,
      dataset: reg?.station_dataset_url || null,
      lat: pos?.lat ?? null, lon: pos?.lon ?? null,
      approxPosition: !how || how !== 'address',
      lastReading: new Date(last).toISOString(),
      online: last >= latest - 6 * HOUR,
      pmFault,
      ...slim(s),
    };
    stations.push(st);
    detail.station[sid] = { ...st, daily: s.daily, hourly: s.hourly, recent: s.recent };
  }

  // Κοινότητες: μόνο σταθμοί σε λειτουργία
  const communities = [];
  for (const dk of [1, 2, 3, 4, 5, 6, 7]) {
    const members = stations.filter((s) => s.community === dk);
    const active = members.filter((s) => s.online);
    const s = summarize(combine(active.map((m) => seriesBySid.get(m.id))), latest);
    const c = {
      id: dk, name: COMMUNITY_NAMES[dk],
      stations: members.length, online: active.length,
      stationIds: members.map((m) => m.id),
      ...slim(s),
    };
    communities.push(c);
    detail.community[dk] = { ...c, daily: s.daily, hourly: s.hourly, recent: s.recent };
  }
  // Κατάταξη 30 ημερών: μέσος δείκτης ωρών, μετά PM2.5
  const order = [...communities].filter((c) => c.d30.hours)
    .sort((a, b) => (a.d30.poorShare - b.d30.poorShare) || ((a.d30.pm2_5 ?? 99) - (b.d30.pm2_5 ?? 99)));
  order.forEach((c, i) => { c.rank = i + 1; detail.community[c.id].rank = i + 1; });

  const online = stations.filter((s) => s.online);
  const cs = summarize(combine(online.map((s) => seriesBySid.get(s.id))), latest);
  const city = { name: 'Δήμος Αθηναίων', stations: stations.length, online: online.length, ...slim(cs) };
  detail.city = { ...city, daily: cs.daily, hourly: cs.hourly, recent: cs.recent };

  const meta = {
    latest: new Date(latest).toISOString(),
    windowDays: WINDOW_DAYS,
    rows: state.rows.size,
    stations: stations.length,
    online: online.length,
    pmFaults: stations.filter((s) => s.pmFault).map((s) => s.id),
    levels: LEVELS,
    who: WHO_24H,
    bands: BANDS,
  };
  return { meta, stations, communities, city, detail };
}
