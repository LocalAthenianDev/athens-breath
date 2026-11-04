"""Χώροι πρασίνου από το dataset «Τοπωνύμια Δήμου Αθηναίων» (GIS Δήμου Αθηναίων).

Το πεδίο `places` χωρίζει τα τοπωνύμια σε κατηγορίες (0 πλατείες, 100 κτήρια,
200 μνημεία, 900 χώροι πρασίνου). Κρατάμε τους χώρους πρασίνου (900) που είναι
ανοιχτοί για βόλτα. Εξαιρούνται τα νεκροταφεία, η Σχολή Ευελπίδων (στρατιωτικός
χώρος) και η Ακρόπολη (αρχαιολογικός χώρος με εισιτήριο).
Τα ονόματα με τόνους είναι στο scripts/green-names.json.

Χρήση: python3 scripts/build-places.py data-source/toponymia.geojson
"""
import json, os, sys

here = os.path.dirname(__file__)
src = sys.argv[1] if len(sys.argv) > 1 else 'data-source/toponymia.geojson'
d = json.load(open(src, encoding='utf-8'))
names = json.load(open(os.path.join(here, 'green-names.json'), encoding='utf-8'))
EXCLUDE = {"Α' ΚΟΙΜΗΤΗΡΙΟ", "Β' ΚΟΙΜΗΤΗΡΙΟ", 'ΣΧΟΛΗ ΕΥΕΛΠΙΔΩΝ', 'ΑΚΡΟΠΟΛΗ'}

out, missing = [], []
for f in d['features']:
    p = f['properties']
    if p.get('places') != 900 or p['names'] in EXCLUDE:
        continue
    if p['names'] not in names:
        missing.append(p['names'])
    out.append({
        'n': names.get(p['names'], p['names']),
        'dk': int(''.join(c for c in (p.get('dk') or '') if c.isdigit()) or 0),
        'lat': round(p['ywgs'], 5),
        'lon': round(p['xwgs'], 5),
    })
out.sort(key=lambda x: x['n'])
json.dump(out, open(os.path.join(here, '../public/data/green.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out), 'χώροι πρασίνου', '· χωρίς όνομα με τόνους:' if missing else '', missing or '')
