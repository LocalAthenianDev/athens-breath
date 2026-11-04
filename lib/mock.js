// Συνθετικά δεδομένα για τοπική ανάπτυξη (MOCK=1), με το ίδιο σχήμα που δίνει το CKAN.
// Περιλαμβάνει και έναν «χαλασμένο» αισθητήρα σωματιδίων, για να δοκιμάζεται ο έλεγχος ποιότητας.
import { readFile } from 'node:fs/promises';

const HOUR = 3_600_000;

function rand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export async function mockRows(days = 30) {
  const coords = JSON.parse(await readFile(new URL('../data/station-coords.json', import.meta.url), 'utf8'));
  const reg = JSON.parse(await readFile(new URL('../scripts/registry-raw.json', import.meta.url), 'utf8'));
  const extra = JSON.parse(await readFile(new URL('../scripts/extra-stations.json', import.meta.url), 'utf8'));
  const info = new Map();
  for (const [id, name, , , nb, dk] of reg) info.set(id, { name, nb, dk });
  for (const [id, name, nb, dk] of extra) info.set(id, { name, nb, dk });

  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const rows = [];
  for (const id of Object.keys(coords).map(Number)) {
    const st = info.get(id);
    if (!st) continue;
    const rnd = rand(id * 7919);
    const traffic = 0.6 + rnd() * 0.9; // πόσο «δρόμος» είναι ο σταθμός
    const broken = id === 76;
    for (let t = end - days * 24 * HOUR; t <= end; t += HOUR) {
      const h = (new Date(t).getUTCHours() + 2) % 24;
      const rush = Math.exp(-((h - 9) ** 2) / 6) + 1.2 * Math.exp(-((h - 20) ** 2) / 8);
      const dayN = Math.floor(t / (24 * HOUR));
      const episode = 1 + 1.5 * Math.max(0, Math.sin(dayN / 3.1)) ** 6; // επεισόδια σκόνης
      const pm25 = Math.max(1, (6 + 10 * rush * traffic) * episode + rnd() * 4);
      const no2 = Math.max(1, 12 + 45 * rush * traffic + rnd() * 10);
      const o3 = Math.max(1, 70 - no2 * 0.6 + 25 * Math.exp(-((h - 15) ** 2) / 10) + rnd() * 8);
      const temp = 17 + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + rnd();
      if (rnd() < 0.01) continue; // κενά
      rows.push({
        interval_timestamp: new Date(t).toISOString().slice(0, 19),
        station_id: id,
        station_name: `${st.name}_${100 + id}`,
        neighbourhood_name: st.nb,
        municipal_district_id: st.dk,
        aqi: 2,
        temperature: +temp.toFixed(2),
        humidity: +(55 - (temp - 17) * 2 + rnd() * 5).toFixed(2),
        pm1: +(pm25 * 0.6).toFixed(1),
        pm2_5: broken ? 1200 + rnd() * 2000 : +pm25.toFixed(1),
        pm10: broken ? 1600 + rnd() * 2000 : +(pm25 * 1.7 + rnd() * 3).toFixed(1),
        co: +(250 + 300 * rush * traffic).toFixed(1),
        no2: +no2.toFixed(1),
        o3: +o3.toFixed(1),
        so2: +(0.5 + rnd()).toFixed(1),
      });
    }
  }
  rows.sort((a, b) => (a.interval_timestamp < b.interval_timestamp ? 1 : -1));
  return rows;
}
