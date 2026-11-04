// Θέσεις περιβαλλοντικών σταθμών: geocoding της διεύθυνσης του Μητρώου με το τοπικό
// ευρετήριο διευθύνσεων OpenStreetMap του athenshoods.gr, και έλεγχος ότι το σημείο
// πέφτει μέσα στη γειτονιά που δηλώνει το Μητρώο. Αλλιώς, κέντρο της γειτονιάς.
// Χρήση: node scripts/geocode-stations.cjs <path to geitonies-athinas/public>
const fs = require('fs');
const path = require('path');
const pub = process.argv[2];
global.window = {};
require(path.join(pub, 'data/athens-data.js'));
const A = window.ATHENS;
require(path.join(pub, 'geocoder.js'));
const Geocoder = window.AthensGeocoder.Geocoder;
const gc = new Geocoder(JSON.parse(fs.readFileSync(path.join(pub, 'data/addresses.json'))));
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry-raw.json')));
const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'overrides.json')));

const nn = (s) => String(s).toUpperCase().replace(/I/g, 'Ι').replace(/Σ{2}/g, 'Σ').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^Α-ΩA-Z0-9]/g, '');
function inRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const polys = (r) => (typeof r[0][0][0] === 'number' ? [r] : r);
const inPoly = (pt, r) => polys(r).some((p) => inRing(pt, p[0]) && !p.slice(1).some((h) => inRing(pt, h)));
function centroid(r) {
  let best = null;
  for (const p of polys(r)) if (!best || p[0].length > best.length) best = p[0];
  const n = best.length; let x = 0, y = 0;
  for (const [a, b] of best) { x += a; y += b; }
  return [x / n, y / n];
}
const findG = (name) => A.g.find((g) => nn(g.n) === nn(name)) || A.g.find((g) => nn(g.n).includes(nn(name)) || nn(name).includes(nn(g.n)));
const whereIs = (pt) => ({ k: A.k.find((k) => inPoly(pt, k.r))?.id, g: A.g.find((g) => inPoly(pt, g.r))?.n });

const out = {}; const report = [];
for (const [id, name, addr, nid, nname, dk] of reg) {
  const g = findG(nname);
  let pt = null, how = '';
  if (overrides[id]) { pt = overrides[id]; how = 'override'; }
  else if (addr && !/Αγ\. Παρασκευή|Δάφνη|Γαλάτσι/.test(addr)) {
    const street = addr.split(',')[0];
    const r = gc.search(street, 8).results;
    // προτίμησε αποτέλεσμα μέσα στη δηλωμένη γειτονιά, μετά στη δηλωμένη κοινότητα
    const pick = (g && r.find((x) => inPoly([x.lon, x.lat], g.r))) || r.find((x) => whereIs([x.lon, x.lat]).k === 'k' + dk);
    if (pick) { pt = [pick.lon, pick.lat]; how = (pick.exact ? 'address' : 'street') + (g && inPoly(pt, g.r) ? '' : ' (εκτός γειτονιάς)'); }
  }
  if (!pt && g) { pt = centroid(g.r); how = 'neighbourhood-centroid'; }
  const w = pt ? whereIs(pt) : {};
  out[id] = { lat: +pt[1].toFixed(5), lon: +pt[0].toFixed(5), how };
  report.push(`${id}\t${how}\t${nname} → ${w.g || '-'}\t${w.k}${w.k === 'k' + dk ? '' : ' !! δηλωμένη k' + dk}\t${addr}`);
}
// Σταθμοί που υπάρχουν στις μετρήσεις αλλά όχι στο Μητρώο: γνωστές πλατείες με θέση από χάρτη,
// αλλιώς κέντρο της γειτονιάς. Ελέγχεται ότι το σημείο πέφτει στη δηλωμένη κοινότητα.
for (const [id, name, nname, dk, ll] of JSON.parse(fs.readFileSync(path.join(__dirname, 'extra-stations.json')))) {
  const g = findG(nname);
  let pt = null, how = 'manual';
  if (typeof ll === 'string') { const o = out[ll.split(':')[1]]; pt = [o.lon + 0.0004, o.lat]; how = 'same-site'; }
  else if (ll) pt = ll;
  if (pt && whereIs(pt).k !== 'k' + dk) { report.push(`${id}\t!! χειροκίνητη θέση εκτός k${dk}, πάει στο κέντρο γειτονιάς`); pt = null; }
  if (!pt && g) { pt = centroid(g.r); how = 'neighbourhood-centroid'; }
  if (!pt) { report.push(`${id}\t!! χωρίς θέση (${nname})`); continue; }
  const w = whereIs(pt);
  out[id] = { lat: +pt[1].toFixed(5), lon: +pt[0].toFixed(5), how };
  report.push(`${id}\t${how}\t${nname} → ${w.g || '-'}\t${w.k}\t${name}`);
}
// Κέντρα γειτονιών και κοινοτήτων, για σταθμούς που θα προστεθούν αργότερα.
const centroids = { g: {}, k: {} };
for (const g of A.g) { const c = centroid(g.r); centroids.g[nn(g.n)] = [+c[1].toFixed(5), +c[0].toFixed(5)]; }
for (const k of A.k) centroids.k[k.id.slice(1)] = [k.c[1], k.c[0]];
fs.writeFileSync(path.join(__dirname, '../data/centroids.json'), JSON.stringify(centroids));
fs.writeFileSync(path.join(__dirname, '../data/station-coords.json'), JSON.stringify(out, null, 1));
console.log(report.join('\n'));
