// Μικρός client για το CKAN datastore API της πλατφόρμας ανοιχτών δεδομένων του Δήμου Αθηναίων.
const BASE = process.env.CKAN_BASE || 'https://opendata.cityofathens.gr';
const TIMEOUT_MS = Number(process.env.CKAN_TIMEOUT_MS || 30000);

// Ωριαίες Περιβαλλοντικές Μετρήσεις (Συγκεντρωτικό), dataset env-all-stations
export const ENV_RESOURCE = process.env.ENV_RESOURCE || 'a84cabca-bd0c-434d-8bee-21c082183442';
// Μητρώο Περιβαλλοντικών Σταθμών και Συσχετίσεων Πόρων, dataset env-stations-registry
export const REGISTRY_RESOURCE = process.env.REGISTRY_RESOURCE || '47ba486c-4ecf-497e-892b-4e47c53f422a';

export async function ckan(action, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${BASE}/api/3/action/${action}?${qs}`, {
    headers: { 'User-Agent': 'athens-breath/1.0 (+https://github.com/LocalAthenianDev/athens-breath)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CKAN ${action} HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`CKAN ${action}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const FIELDS = [
  'interval_timestamp', 'station_id', 'station_name', 'neighbourhood_name', 'municipal_district_id',
  'aqi', 'temperature', 'humidity', 'pm1', 'pm2_5', 'pm10', 'co', 'no2', 'o3', 'so2',
].join(',');

// Ωριαίες μετρήσεις από την πιο πρόσφατη προς τα πίσω, μέχρι το `sinceIso` (UTC, χωρίς Z).
// Το datastore_search δεν έχει φίλτρο εύρους, οπότε σελιδοποιούμε με ταξινόμηση κατά χρόνο.
export async function fetchSince(sinceIso, { pageSize = 32000, maxPages = 20 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await ckan('datastore_search', {
      resource_id: ENV_RESOURCE,
      fields: FIELDS,
      sort: 'interval_timestamp desc, station_id asc',
      limit: pageSize,
      offset: page * pageSize,
    });
    let reached = false;
    for (const rec of r.records) {
      if (rec.interval_timestamp < sinceIso) { reached = true; break; }
      rows.push(rec);
    }
    if (reached || r.records.length < pageSize) break;
  }
  return rows;
}

export async function fetchRegistry() {
  const r = await ckan('datastore_search', { resource_id: REGISTRY_RESOURCE, limit: 1000 });
  return r.records;
}
