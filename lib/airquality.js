// Έλεγχος ποιότητας μετρήσεων και Ευρωπαϊκός Δείκτης Ποιότητας Αέρα (EAQI).
//
// Οι σταθμοί Smart Sense είναι αισθητήρες χαμηλού κόστους. Κάποιοι αισθητήρες σωματιδίων
// χαλάνε και δίνουν τιμές πάνω από 1000 μg/m³ για μέρες, οπότε τις κόβουμε πριν από
// οποιονδήποτε μέσο όρο. Το EAQI το υπολογίζουμε εμείς από τις έγκυρες τιμές, ώστε ένας
// χαλασμένος αισθητήρας να μη βγάζει «Εξαιρετικά κακή» ποιότητα.

export const POLLUTANTS = ['pm2_5', 'pm10', 'no2', 'o3', 'so2'];

// Όρια EAQI (ΕΟΠ), ίδια κλίμακα 1–6 με το πεδίο aqi του dataset
// (οι «αναμενόμενες τιμές» του data dictionary ταιριάζουν με αυτά τα εύρη).
export const BANDS = {
  pm2_5: [10, 20, 25, 50, 75],
  pm10: [20, 40, 50, 100, 150],
  no2: [40, 90, 120, 230, 340],
  o3: [50, 100, 130, 240, 380],
  so2: [100, 200, 350, 500, 750],
};

export const LEVELS = ['Πολύ καλή', 'Καλή', 'Μέτρια', 'Κακή', 'Πολύ κακή', 'Εξαιρετικά κακή'];

// Ημερήσιες κατευθυντήριες τιμές ΠΟΥ 2021 (μέσος όρος 24ώρου, μg/m³)
export const WHO_24H = { pm2_5: 15, pm10: 45, no2: 25, so2: 40 };

// Πάνω από αυτές τις τιμές η μέτρηση θεωρείται σφάλμα αισθητήρα.
const MAX = { pm2_5: 300, pm10: 600, no2: 400, o3: 400, so2: 1000, co: 20000, temperature: 50, humidity: 100 };
const MIN = { temperature: -10, humidity: 0 };

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Καθαρίζει μία ωριαία εγγραφή. Επιστρέφει τις έγκυρες τιμές και αν τα σωματίδια απορρίφθηκαν.
export function clean(rec) {
  const v = {};
  for (const k of ['pm1', 'pm2_5', 'pm10', 'no2', 'o3', 'so2', 'co', 'temperature', 'humidity', 'pressure']) {
    let x = num(rec[k]);
    if (x !== null && (x < (MIN[k] ?? 0) || x > (MAX[k] ?? Infinity))) x = null;
    v[k] = x;
  }
  let pmRejected = false;
  const rawPm25 = num(rec.pm2_5);
  const rawPm10 = num(rec.pm10);
  if ((rawPm25 !== null && rawPm25 > MAX.pm2_5) || (rawPm10 !== null && rawPm10 > MAX.pm10)) pmRejected = true;
  // Τα PM2.5 είναι υποσύνολο των PM10: αν τα ξεπερνούν αισθητά, η μέτρηση δεν στέκει.
  if (v.pm2_5 !== null && v.pm10 !== null && v.pm2_5 > v.pm10 * 1.1 + 2) pmRejected = true;
  if (pmRejected) { v.pm1 = null; v.pm2_5 = null; v.pm10 = null; }
  return { v, pmRejected };
}

export function band(pollutant, value) {
  if (value === null || value === undefined) return null;
  const b = BANDS[pollutant];
  let lvl = 1;
  for (const t of b) if (value > t) lvl++;
  return lvl;
}

// EAQI = η χειρότερη βαθμίδα ανάμεσα στους ρύπους που μετρήθηκαν έγκυρα.
// Χρειάζεται τουλάχιστον ένα σωματίδιο ή το NO₂, αλλιώς δεν βγάζουμε δείκτη.
export function eaqi(v) {
  let lvl = null;
  let driver = null;
  for (const p of POLLUTANTS) {
    const b = band(p, v[p]);
    if (b !== null && (lvl === null || b > lvl)) { lvl = b; driver = p; }
  }
  if (v.pm2_5 === null && v.pm10 === null && v.no2 === null) return { level: null, driver: null };
  return { level: lvl, driver };
}
