import express from 'express';
import compression from 'compression';
import { fetchSince, fetchRegistry } from './lib/ckan.js';
import { state, ingest, setRegistry, compute } from './lib/store.js';
import { mockRows } from './lib/mock.js';

const PORT = process.env.PORT || 3000;
const REFRESH_MIN = Number(process.env.REFRESH_MIN || 15);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);
const MOCK = process.env.MOCK === '1';
const APP_ENV = process.env.APP_ENV || 'production';
const HOUR = 3_600_000;

const cache = { data: null, at: 0, loading: null, lastError: null };
const iso = (t) => new Date(t).toISOString().slice(0, 19);

// Πρώτη φόρτωση: όλο το παράθυρο ημερών. Μετά: μόνο οι νέες ώρες,
// με 6 ώρες επικάλυψη για μετρήσεις που φτάνουν καθυστερημένα.
async function load() {
  const started = Date.now();
  if (MOCK) {
    if (!state.rows.size) ingest(await mockRows(WINDOW_DAYS));
  } else {
    if (!state.registry.size) {
      try { setRegistry(await fetchRegistry()); } catch (e) { console.warn('[registry]', e.message); }
    }
    const since = state.latest ? state.latest - 6 * HOUR : Date.now() - WINDOW_DAYS * 24 * HOUR;
    const rows = await fetchSince(iso(since));
    const added = ingest(rows);
    console.log(`[load] ${rows.length} εγγραφές, ${added} νέες`);
  }
  cache.data = await compute();
  cache.at = Date.now();
  cache.lastError = null;
  console.log(`[cache] ${cache.data.meta.online}/${cache.data.meta.stations} σταθμοί, τελευταία ώρα ${cache.data.meta.latest}, ${Date.now() - started}ms`);
}

function refresh() {
  if (cache.loading) return cache.loading;
  cache.loading = load()
    .catch((e) => { cache.lastError = e.message; console.error('[load] αποτυχία:', e.message); if (!cache.data) throw e; })
    .finally(() => { cache.loading = null; });
  return cache.loading;
}

async function getData() {
  if (!cache.data) await refresh();
  else if (Date.now() - cache.at > REFRESH_MIN * 60_000) refresh();
  return cache.data;
}

const app = express();
app.disable('x-powered-by');
app.use(compression());
if (APP_ENV !== 'production') app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
app.use(express.static('public', { maxAge: '5m' }));
// Ανοιχτές βιβλιοθήκες και γραμματοσειρά από τον δικό μας server, χωρίς CDN τρίτων
const vendor = (p) => express.static(new URL(`./node_modules/${p}`, import.meta.url).pathname, { maxAge: '7d' });
app.use('/vendor/leaflet', vendor('leaflet/dist'));
app.use('/vendor/chartjs', vendor('chart.js/dist'));
app.use('/vendor/commissioner', vendor('@fontsource/commissioner'));

const send = (res, fn) => getData()
  .then((d) => { res.set('Cache-Control', 'public, max-age=120'); fn(d); })
  .catch((e) => res.status(503).json({ error: 'Τα ανοιχτά δεδομένα δεν είναι διαθέσιμα αυτή τη στιγμή', detail: e.message }));

app.get('/api/overview', (req, res) => send(res, (d) => res.json({
  meta: { ...d.meta, env: APP_ENV, mock: MOCK, updated: new Date(cache.at).toISOString(), lastError: cache.lastError },
  city: d.city, communities: d.communities, stations: d.stations,
})));
app.get('/api/city', (req, res) => send(res, (d) => res.json(d.detail.city)));
app.get('/api/communities/:id', (req, res) => send(res, (d) => {
  const c = d.detail.community[req.params.id];
  return c ? res.json(c) : res.status(404).json({ error: 'Άγνωστη κοινότητα' });
}));
app.get('/api/stations/:id', (req, res) => send(res, (d) => {
  const s = d.detail.station[req.params.id];
  return s ? res.json(s) : res.status(404).json({ error: 'Άγνωστος σταθμός' });
}));
app.get('/healthz', (req, res) => res.json({ ok: true, cached: Boolean(cache.data), latest: cache.data?.meta.latest ?? null }));

app.listen(PORT, () => {
  console.log(`Athens Breath στο http://localhost:${PORT}${MOCK ? ' (MOCK)' : ''}`);
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), REFRESH_MIN * 60_000).unref();
});
