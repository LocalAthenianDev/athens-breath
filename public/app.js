/* Athens Breath · Ανάσα · MIT · github.com/LocalAthenianDev/athens-breath */
(function () {
  'use strict';

  // ---------- σταθερές ----------
  const LEVELS = ['Πολύ καλή', 'Καλή', 'Μέτρια', 'Κακή', 'Πολύ κακή', 'Εξαιρετικά κακή'];
  const QCOL = ['#50f0e6', '#50ccaa', '#f0e641', '#ff5050', '#960032', '#7d2181'];
  const BANDS = {
    pm2_5: [10, 20, 25, 50, 75], pm10: [20, 40, 50, 100, 150],
    no2: [40, 90, 120, 230, 340], o3: [50, 100, 130, 240, 380], so2: [100, 200, 350, 500, 750],
  };
  const WHO = { pm2_5: 15, pm10: 45, no2: 25 };
  const METRICS = {
    aqi: { label: 'Δείκτης αέρα', unit: '' },
    pm2_5: { label: 'PM2.5', unit: 'μg/m³', long: 'Λεπτά σωματίδια PM2.5' },
    pm10: { label: 'PM10', unit: 'μg/m³', long: 'Σωματίδια PM10' },
    no2: { label: 'NO₂', unit: 'μg/m³', long: 'Διοξείδιο του αζώτου' },
    o3: { label: 'O₃', unit: 'μg/m³', long: 'Όζον' },
    temperature: { label: 'Θερμοκρασία', unit: '°C' },
  };
  const PERIODS = { now: 'τώρα', h24: 'τις τελευταίες 24 ώρες', d7: 'τις τελευταίες 7 ημέρες', d30: 'τις τελευταίες 30 ημέρες' };
  const DRIVER = { pm2_5: 'τα σωματίδια PM2.5', pm10: 'τα σωματίδια PM10', no2: 'το NO₂', o3: 'το όζον', so2: 'το SO₂' };

  const S = { metric: 'aqi', period: 'now', view: { type: 'city' }, tab: 'recent', data: null, detail: null };
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt1 = (x) => (x === null || x === undefined ? '–' : Number(x).toLocaleString('el-GR', { maximumFractionDigits: x >= 100 ? 0 : 1 }));
  const tz = { timeZone: 'Europe/Athens' };
  const tAthens = (iso, o) => new Date(iso).toLocaleString('el-GR', { ...tz, ...o });
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  // Η ώρα στο dataset είναι το τέλος της ώρας μέτρησης
  const hourRange = (h) => `${hh(h)} έως ${hh((h + 1) % 24)}`;

  // ---------- τιμές και χρώματα ----------
  function bandOf(metric, v) {
    if (v === null || v === undefined) return null;
    let l = 1; for (const t of BANDS[metric]) if (v > t) l++; return l;
  }
  function valueOf(obj, metric = S.metric, period = S.period) {
    if (!obj) return null;
    const src = period === 'now' ? obj.now : obj[period];
    if (!src) return null;
    return metric === 'aqi' ? src.level ?? null : src[metric] ?? null;
  }
  function tempColor(t) {
    if (t === null) return null;
    const stops = [[5, [44, 123, 182]], [14, [171, 217, 233]], [20, [255, 255, 191]], [27, [253, 174, 97]], [35, [215, 25, 28]]];
    if (t <= stops[0][0]) return `rgb(${stops[0][1]})`;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (t - a) / (b - a);
        return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * f)).join(',')})`;
      }
    }
    return `rgb(${stops[stops.length - 1][1]})`;
  }
  function colorOf(metric, v) {
    if (v === null || v === undefined) return null;
    if (metric === 'temperature') return tempColor(v);
    const l = metric === 'aqi' ? Math.round(v) : bandOf(metric, v);
    return QCOL[Math.min(6, Math.max(1, l)) - 1];
  }
  const levelText = (l) => (l ? LEVELS[l - 1] : 'Χωρίς μέτρηση');
  const darkText = (l) => l >= 5;

  // ---------- χάρτης ----------
  const map = L.map('map', { zoomControl: true, attributionControl: true, minZoom: 11, maxZoom: 18 }).setView([37.982, 23.735], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const setDark = () => document.getElementById('map').classList.toggle('dark-tiles', dark.matches);
  setDark(); dark.addEventListener?.('change', setDark);

  const kLayer = L.layerGroup().addTo(map);
  const gLayer = L.layerGroup().addTo(map);
  const sLayer = L.layerGroup().addTo(map);
  const polys = {}; const dots = {};
  let GREEN = [];
  const GREEN_MAX_M = 1000; // πέρα από 1 χλμ. δεν δείχνουμε αέρα για έναν χώρο πρασίνου

  // Απόσταση σε μέτρα
  function meters(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtM = (m) => (m < 950 ? `${Math.round(m / 50) * 50 || 50} μ.` : `${(m / 1000).toLocaleString('el-GR', { maximumFractionDigits: 1 })} χλμ.`);

  // Για κάθε χώρο πρασίνου, ο κοντινότερος σταθμός σε λειτουργία που έχει δείκτη για την περίοδο
  function greenWithAir() {
    const sts = (S.data?.stations || []).filter((s) => s.online && s.lat !== null && valueOf(s, 'aqi') !== null);
    return GREEN.map((g) => {
      let best = null, dist = Infinity;
      for (const s of sts) { const m = meters(g.lat, g.lon, s.lat, s.lon); if (m < dist) { dist = m; best = s; } }
      return { ...g, station: dist <= GREEN_MAX_M ? best : null, dist };
    });
  }
  const greenRank = (g) => (g.station ? valueOf(g.station, 'aqi') * 1e4 + (valueOf(g.station, 'pm2_5') ?? 50) * 10 + g.dist / 1e4 : Infinity);
  const leafIcon = L.divIcon({ className: 'leaf', iconSize: [18, 18], iconAnchor: [9, 9],
    html: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2C5 5 4 8.5 4.6 11.3 5.2 14 7.4 15.6 9 16c1.6-.4 3.8-2 4.4-4.7C14 8.5 13 5 9 2Z"/><path d="M9 6v10" fill="none"/></svg>' });
  const toLL = (r) => (typeof r[0][0][0] === 'number' ? [r] : r).map((p) => p.map((ring) => ring.map(([x, y]) => [y, x])));

  async function loadBoundaries() {
    const [k, s, g] = await Promise.all([fetch('data/koinotites.json').then((r) => r.json()), fetch('data/synoikies.json').then((r) => r.json()), fetch('data/green.json').then((r) => r.json()).catch(() => [])]);
    GREEN = g;
    // Συνοικίες: μόνο λεπτό περίγραμμα για προσανατολισμό
    for (const x of s) L.polygon(toLL(x.r), { color: '#1d4f91', weight: 0.6, opacity: 0.35, fill: false, interactive: false, dashArray: x.pl ? '3 3' : null }).addTo(kLayer);
    const bounds = L.latLngBounds([]);
    for (const x of k) {
      const p = L.polygon(toLL(x.r), { color: '#1d4f91', weight: 2, fillOpacity: 0.32, fillColor: '#cccccc' })
        .on('click', () => go({ type: 'community', id: x.id }))
        .on('mouseover', () => p.setStyle({ weight: 3.5 }))
        .on('mouseout', () => p.setStyle({ weight: polys[x.id].selected ? 3.5 : 2 }));
      p.addTo(kLayer);
      p.bindTooltip('', { sticky: true, className: 'tip', direction: 'top' });
      L.tooltip({ permanent: true, direction: 'center', className: 'klabel', interactive: false })
        .setContent(`${x.id}η`).setLatLng([x.c[1], x.c[0]]).addTo(kLayer);
      polys[x.id] = p; bounds.extend(p.getBounds());
    }
    map.fitBounds(bounds, { padding: [10, 10] });
  }

  function paintMap() {
    const d = S.data; if (!d) return;
    const m = S.metric;
    for (const c of d.communities) {
      const p = polys[c.id]; if (!p) continue;
      const v = valueOf(c);
      const sel = S.view.type === 'community' && S.view.id === c.id;
      p.selected = sel;
      p.setStyle({ fillColor: colorOf(m, v) || '#bbbbbb', fillOpacity: v === null ? 0.12 : 0.38, weight: sel ? 3.5 : 2 });
      p.setTooltipContent(`<b>${esc(c.name)}</b>${tipValue(m, v)}<br><small>${c.online} από ${c.stations} σταθμούς σε λειτουργία</small>`);
    }
    sLayer.clearLayers();
    for (const s of d.stations) {
      if (s.lat === null) continue;
      const v = s.online ? valueOf(s) : null;
      const col = colorOf(m, v);
      const sel = S.view.type === 'station' && S.view.id === s.id;
      const mk = L.circleMarker([s.lat, s.lon], {
        radius: sel ? 10 : 7, weight: sel ? 3 : 1.5, color: sel ? '#14233f' : '#ffffff',
        fillColor: col || '#9aa3b2', fillOpacity: col ? 0.95 : 0.6, dashArray: s.online ? null : '2 2',
      });
      mk.bindTooltip(`<b>${esc(s.name)}</b>${esc(s.neighbourhood || '')}${s.online ? tipValue(m, v) : '<br>Εκτός λειτουργίας'}`, { className: 'tip', direction: 'top', offset: [0, -6] });
      mk.on('click', () => go({ type: 'station', id: s.id }));
      mk.addTo(sLayer); dots[s.id] = mk;
    }
    gLayer.clearLayers();
    for (const g of greenWithAir()) {
      const v = g.station ? valueOf(g.station) : null;
      const air = g.station
        ? `${tipValue(m, v)}<br><small>από τον σταθμό ${esc(g.station.name)}, ${fmtM(g.dist)}</small>`
        : '<br><small>Δεν υπάρχει σταθμός σε απόσταση 1 χλμ.</small>';
      const mk = L.marker([g.lat, g.lon], { icon: leafIcon, keyboard: false, zIndexOffset: -1000 })
        .bindTooltip(`<b>${esc(g.n)}</b>${air}`, { className: 'tip', direction: 'top', offset: [0, -8] });
      if (g.station) mk.on('click', () => go({ type: 'station', id: g.station.id }));
      mk.addTo(gLayer);
    }
    renderLegend();
  }
  function tipValue(m, v) {
    if (v === null) return '<br>Χωρίς μέτρηση';
    if (m === 'aqi') return `<br>${levelText(Math.round(v))}`;
    return `<br>${METRICS[m].label} ${fmt1(v)} ${METRICS[m].unit}`;
  }

  function greenToggle() {
    if (!GREEN.length) return '';
    return `<label class="gtoggle"><input type="checkbox" id="greenOn"${map.hasLayer(gLayer) ? ' checked' : ''}><span class="leaf-sw"></span>Χώροι πρασίνου (${GREEN.length})</label>`;
  }
  $('#legend').addEventListener('change', (e) => {
    if (e.target.id !== 'greenOn') return;
    if (e.target.checked) gLayer.addTo(map); else map.removeLayer(gLayer);
  });
  function renderLegend() {
    const m = S.metric; const el = $('#legend');
    if (m === 'temperature') {
      el.innerHTML = `<div class="t">Θερμοκρασία ${esc(PERIODS[S.period])}</div><div class="ramp"></div><div class="ends"><span>5°C</span><span>20°C</span><span>35°C</span></div>` + greenToggle();
      return;
    }
    const head = m === 'aqi' ? 'Ποιότητα αέρα' : `${METRICS[m].label} σε μg/m³`;
    const items = LEVELS.map((l, i) => {
      const b = BANDS[m];
      const lab = m === 'aqi' ? l : (i === 0 ? `έως ${b[0]}` : i === 5 ? `πάνω από ${b[4]}` : `${b[i - 1]} έως ${b[i]}`);
      return `<span class="it"><span class="sw" style="background:${QCOL[i]}"></span>${lab}</span>`;
    }).join('');
    el.innerHTML = `<div class="t">${head} ${esc(PERIODS[S.period])}</div><div class="row">${items}</div>` +
      (m !== 'aqi' ? '<div class="note">Βαθμίδες του Ευρωπαϊκού Δείκτη Ποιότητας Αέρα</div>' : '') + greenToggle();
  }

  // ---------- πάνελ ----------
  // Κλίμακα έξι βημάτων, από την καλύτερη (αριστερά) στη χειρότερη (δεξιά) ποιότητα αέρα
  function scale(level) {
    const steps = QCOL.map((c, i) => `<span class="step${level === i + 1 ? ' on' : ''}" style="background:${c}" title="${LEVELS[i]}"></span>`).join('');
    return `<div class="scale" role="img" aria-label="${level ? `${levelText(level)}, βαθμίδα ${level} στις 6, όπου 1 είναι η καλύτερη` : 'Χωρίς μέτρηση'}">` +
      `<div class="steps">${steps}</div><div class="ends"><span>Καθαρός αέρας</span><span>Επιβαρυμένος</span></div></div>`;
  }
  function heroBlock(obj) {
    const src = S.period === 'now' ? obj.now : obj[S.period];
    const level = src?.level ?? null;
    let why = '';
    if (S.period === 'now' && obj.now) {
      why = `Μέτρηση ${tAthens(obj.now.t, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` +
        (obj.now.driver && obj.now.level > 2 ? `, κυρίως από ${DRIVER[obj.now.driver]}` : '');
    } else if (src) {
      why = `Από τους μέσους όρους για ${PERIODS[S.period]}` + (src.goodShare !== null ? `, καλός αέρας στο ${src.goodShare}% των ωρών` : '');
    }
    return `<div class="hero"><div class="what"><span class="dotq" style="background:${level ? QCOL[level - 1] : 'var(--off)'}"></span>${levelText(level)}</div><div class="why">${esc(why)}</div>${scale(level)}</div>`;
  }
  function kpis(obj) {
    const src = S.period === 'now' ? obj.now : obj[S.period];
    const cell = (k, label) => {
      const v = src ? src[k] : null;
      const col = k === 'temperature' || k === 'humidity' ? null : colorOf(k, v);
      const unit = k === 'temperature' ? '°C' : k === 'humidity' ? '%' : 'μg/m³';
      return `<div class="kpi"><div class="l">${label}</div><div class="v">${col ? `<span class="chip" style="background:${col}"></span>` : ''}${fmt1(v)} <small>${unit}</small></div></div>`;
    };
    return `<div class="kpis">${cell('pm2_5', 'PM2.5')}${cell('pm10', 'PM10')}${cell('no2', 'NO₂')}${cell('o3', 'O₃')}${cell('temperature', 'Θερμοκρασία')}${cell('humidity', 'Υγρασία')}</div>`;
  }
  function facts(obj) {
    const out = [];
    if (obj.bestHour !== null && obj.bestHour !== undefined) {
      out.push(`<div class="fact"><span class="big">${hh(obj.bestHour)}</span><span class="txt">η πιο καθαρή ώρα της ημέρας για βόλτα ή τρέξιμο (μέσος όρος 30 ημερών)</span></div>`);
      out.push(`<div class="fact"><span class="big">${hh(obj.worstHour)}</span><span class="txt">η πιο επιβαρυμένη ώρα, ${hourRange(obj.worstHour)}</span></div>`);
    }
    const w = obj.who || {};
    if (w.pm2_5) out.push(`<div class="fact"><span class="big">${w.pm2_5.over}/${w.pm2_5.days}</span><span class="txt">ημέρες με PM2.5 πάνω από το ημερήσιο όριο του ΠΟΥ (${w.pm2_5.limit} μg/m³)</span></div>`);
    if (w.no2) out.push(`<div class="fact"><span class="big">${w.no2.over}/${w.no2.days}</span><span class="txt">ημέρες με NO₂ πάνω από το ημερήσιο όριο του ΠΟΥ (${w.no2.limit} μg/m³)</span></div>`);
    if (obj.d30 && obj.d30.poorShare !== null) out.push(`<div class="fact"><span class="big">${obj.d30.poorShare}%</span><span class="txt">των ωρών του μήνα με κακή ή χειρότερη ποιότητα αέρα</span></div>`);
    return out.length ? `<h3>Μέσα στον μήνα</h3><div class="facts">${out.join('')}</div>` : '';
  }
  function chartBlock() {
    const tabs = [['recent', '72 ώρες'], ['daily', '30 ημέρες'], ['hourly', 'Μέση ημέρα']];
    const m = S.metric === 'aqi' ? 'Δείκτης αέρα' : METRICS[S.metric].label;
    return `<h3>${esc(m)} στον χρόνο</h3><div class="tabs" role="group" aria-label="Γράφημα">${tabs.map(([k, l]) => `<button data-tab="${k}" aria-pressed="${S.tab === k}">${l}</button>`).join('')}</div><div class="chartbox"><canvas id="chart" aria-label="Γράφημα"></canvas></div>`;
  }
  function rankingRow(obj, rk, onclick, sub) {
    const v = obj.online === false ? null : valueOf(obj);
    const col = colorOf(S.metric, v);
    const shown = v === null ? '<span class="off">–</span>' : S.metric === 'aqi' ? levelText(Math.round(v)) : `${fmt1(v)}`;
    return `<li><button ${onclick}><span class="rk">${rk}</span><span class="nm">${esc(obj.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="val">${col ? `<span class="chip" style="background:${col}"></span>` : ''}${shown}</span></button></li>`;
  }
  // Στον δείκτη οι βαθμίδες ισοπαλούν συχνά, οπότε σπάμε την ισοπαλία με τα PM2.5 και το NO₂
  const sortKey = (o) => {
    const v = valueOf(o);
    if (v === null || o.online === false) return Infinity;
    if (S.metric !== 'aqi') return v;
    return v * 1e4 + (valueOf(o, 'pm2_5') ?? 50) * 10 + (valueOf(o, 'no2') ?? 50) / 100;
  };

  function greenBlock(list, title, empty) {
    const rows = list.map((g, i) => {
      const v = valueOf(g.station, 'aqi');
      return `<li><button data-s="${g.station.id}"><span class="rk">${i + 1}</span><span class="nm">${esc(g.n)}<small>${levelText(Math.round(v))} · σταθμός ${esc(g.station.name)}, ${fmtM(g.dist)}</small></span><span class="val"><span class="chip" style="background:${colorOf('aqi', v)}"></span></span></button></li>`;
    }).join('');
    return `<h3>${title}</h3>` + (rows ? `<ol class="list green">${rows}</ol>` : `<p class="sub">${empty}</p>`);
  }

  function renderCity() {
    const d = S.data; const c = d.city;
    const list = [...d.communities].sort((a, b) => sortKey(a) - sortKey(b));
    const unit = S.metric === 'aqi' ? '' : ` (${METRICS[S.metric].unit})`;
    $('#panel').innerHTML = `
      <h2>Δήμος Αθηναίων</h2>
      <p class="sub">${c.online} από ${c.stations} σταθμούς σε λειτουργία · ${esc(PERIODS[S.period])}</p>
      ${heroBlock(c)}${kpis(c)}
      <h3>Κοινότητες, από την πιο καθαρή${esc(unit)}</h3>
      <ol class="list">${list.map((k, i) => rankingRow(k, valueOf(k) === null ? '–' : i + 1, `data-k="${k.id}"`, `${k.online} σταθμοί`)).join('')}</ol>
      ${greenBlock(greenWithAir().filter((g) => g.station).sort((a, b) => greenRank(a) - greenRank(b)).slice(0, 5), `Πράσινο με τον πιο καθαρό αέρα ${esc(PERIODS[S.period])}`, '')}
      ${facts(c)}${chartBlock()}`;
    loadDetail('api/city');
  }

  function renderCommunity(id) {
    const d = S.data; const c = d.communities.find((x) => x.id === id);
    if (!c) return go({ type: 'city' });
    const sts = d.stations.filter((s) => s.community === id).sort((a, b) => sortKey(a) - sortKey(b));
    $('#panel').innerHTML = `
      <nav class="crumbs"><button data-go="city">Δήμος Αθηναίων</button></nav>
      <h2>${esc(c.name)}</h2>
      <p class="sub">${c.online} από ${c.stations} σταθμούς σε λειτουργία${c.rank ? ` · ${c.rank}η από 7 στον μήνα` : ''}</p>
      ${heroBlock(c)}${kpis(c)}
      ${greenBlock(greenWithAir().filter((g) => g.station && g.dk === id).sort((a, b) => greenRank(a) - greenRank(b)), `Χώροι πρασίνου της κοινότητας, από τον πιο καθαρό αέρα ${esc(PERIODS[S.period])}`, 'Τα τοπωνύμια του Δήμου δεν έχουν καταγεγραμμένο χώρο πρασίνου σε αυτή την κοινότητα.')}
      ${facts(c)}${chartBlock()}
      <h3>Σταθμοί της κοινότητας</h3>
      <ol class="list">${sts.map((s, i) => rankingRow(s, s.online && valueOf(s) !== null ? i + 1 : '–', `data-s="${s.id}"`, s.online ? s.neighbourhood : 'Εκτός λειτουργίας')).join('')}</ol>`;
    loadDetail(`api/communities/${id}`);
  }

  function nearGreen(s) {
    if (s.lat === null) return '';
    const near = GREEN.map((g) => ({ ...g, dist: meters(g.lat, g.lon, s.lat, s.lon) })).filter((g) => g.dist <= GREEN_MAX_M).sort((a, b) => a.dist - b.dist);
    if (!near.length) return '';
    return `<h3>Χώροι πρασίνου κοντά στον σταθμό</h3><ul class="near">${near.map((g) => `<li><span class="leaf-sw"></span>${esc(g.n)}<span>${fmtM(g.dist)}</span></li>`).join('')}</ul>`;
  }

  function renderStation(id) {
    const d = S.data; const s = d.stations.find((x) => x.id === id);
    if (!s) return go({ type: 'city' });
    const k = d.communities.find((x) => x.id === s.community);
    const notes = [];
    if (!s.online) notes.push(`<div class="notice warn">Ο σταθμός δεν έχει στείλει μέτρηση από ${tAthens(s.lastReading, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.</div>`);
    if (s.pmFault) notes.push('<div class="notice warn">Ο αισθητήρας σωματιδίων δίνει τιμές που δεν στέκουν, οπότε τα PM2.5 και PM10 αυτού του σταθμού δεν χρησιμοποιούνται. Ο δείκτης βγαίνει μόνο από τα αέρια.</div>');
    const links = [];
    if (s.citizenhub) links.push(`<a href="${esc(s.citizenhub)}" target="_blank" rel="noopener">Η γειτονιά στο CitizenHub</a>`);
    links.push(`<a href="${esc(s.dataset || 'https://opendata.cityofathens.gr/dataset/env-all-stations')}" target="_blank" rel="noopener">Ανοιχτά δεδομένα σταθμού</a>`);
    $('#panel').innerHTML = `
      <nav class="crumbs"><button data-go="city">Δήμος Αθηναίων</button><span>›</span><button data-k="${s.community}">${esc(k ? k.name : '')}</button></nav>
      <h2>${esc(s.name)}</h2>
      <p class="sub">${esc(s.neighbourhood || '')}${s.address ? ` · ${esc(s.address)}` : ''}${s.approxPosition ? ' · θέση στον χάρτη κατά προσέγγιση' : ''}</p>
      ${notes.join('')}
      ${heroBlock(s)}${kpis(s)}
      ${facts(s)}${chartBlock()}
      ${nearGreen(s)}
      <div class="links">${links.join('')}</div>`;
    loadDetail(`api/stations/${id}`);
  }

  async function loadDetail(url) {
    S.detail = null; drawChart();
    try {
      const r = await fetch(url); if (!r.ok) throw new Error(r.status);
      S.detail = await r.json(); drawChart();
    } catch { /* το γράφημα μένει κενό */ }
  }

  // ---------- γράφημα ----------
  let chart = null;
  function drawChart() {
    const cv = document.getElementById('chart'); if (!cv) return;
    if (chart) { chart.destroy(); chart = null; }
    const det = S.detail; if (!det) return;
    const m = S.metric;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--muted').trim() || '#4f5b6e';
    const grid = css.getPropertyValue('--rule').trim() || '#d5d9d1';
    let labels = [], vals = [], who = null;
    const key = m === 'aqi' ? 'level' : m;
    if (S.tab === 'recent') {
      labels = det.recent.map((r) => tAthens(new Date(new Date(r.t) - 3600e3).toISOString(), { weekday: 'short', hour: '2-digit' }));
      vals = det.recent.map((r) => r[key]);
    } else if (S.tab === 'daily') {
      labels = det.daily.map((r) => new Date(r.day + 'T12:00:00Z').toLocaleDateString('el-GR', { day: 'numeric', month: 'short' }));
      vals = det.daily.map((r) => r[key]);
      if (WHO[m]) who = WHO[m];
    } else {
      labels = det.hourly.map((r) => hh(r.hour));
      vals = det.hourly.map((r) => r[key]);
    }
    const isAqi = m === 'aqi';
    const colors = vals.map((v) => colorOf(m, v) || '#bbbbbb');
    const datasets = [{
      type: isAqi ? 'bar' : 'line', label: isAqi ? 'Δείκτης αέρα' : METRICS[m].label, data: vals,
      backgroundColor: isAqi ? colors : 'rgba(29,79,145,.12)', borderColor: isAqi ? colors : '#1d4f91',
      borderWidth: isAqi ? 0 : 2, pointRadius: S.tab === 'recent' ? 0 : 2.5, pointBackgroundColor: colors, pointBorderColor: colors,
      fill: !isAqi, tension: 0.3, spanGaps: false, barPercentage: 1, categoryPercentage: 0.95,
    }];
    if (who) datasets.push({ type: 'line', label: `Όριο ΠΟΥ ${who} μg/m³`, data: vals.map(() => who), borderColor: '#ff5050', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false });
    chart = new Chart(cv, {
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: Boolean(who), labels: { color: ink, boxWidth: 14, font: { family: 'Commissioner' } } },
          tooltip: { callbacks: { label: (c) => (isAqi && c.datasetIndex === 0 ? `${c.parsed.y.toFixed(S.tab === 'hourly' ? 1 : 0)} · ${levelText(Math.round(c.parsed.y))}` : `${c.dataset.label} ${fmt1(c.parsed.y)}${METRICS[m].unit ? ' ' + METRICS[m].unit : ''}`) } },
        },
        scales: {
          x: { ticks: { color: ink, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { family: 'Commissioner', size: 11 } }, grid: { display: false } },
          y: { beginAtZero: !['temperature'].includes(m), min: isAqi ? 0 : undefined, max: isAqi ? 6 : undefined, ticks: { color: ink, stepSize: isAqi ? 1 : undefined, font: { family: 'Commissioner', size: 11 } }, grid: { color: grid } },
        },
      },
    });
  }

  // ---------- πλοήγηση ----------
  function render() {
    if (!S.data) return;
    const v = S.view;
    if (v.type === 'community') renderCommunity(v.id);
    else if (v.type === 'station') renderStation(v.id);
    else renderCity();
    paintMap();
  }
  function go(view, push = true) {
    S.view = view;
    if (push) {
      const h = view.type === 'community' ? `#k${view.id}` : view.type === 'station' ? `#s${view.id}` : '#';
      history.pushState(null, '', h === '#' ? location.pathname : h);
    }
    render();
    $('#panel').scrollTop = 0;
    if (view.type === 'station') {
      const s = S.data.stations.find((x) => x.id === view.id);
      if (s && s.lat !== null && !map.getBounds().pad(-0.1).contains([s.lat, s.lon])) map.panTo([s.lat, s.lon]);
    } else if (view.type === 'community' && polys[view.id] && window.innerWidth > 900) {
      map.fitBounds(polys[view.id].getBounds(), { padding: [30, 30], maxZoom: 15 });
    }
  }
  function fromHash() {
    const m = location.hash.match(/^#([ks])(\d+)$/);
    return m ? { type: m[1] === 'k' ? 'community' : 'station', id: Number(m[2]) } : { type: 'city' };
  }
  window.addEventListener('popstate', () => go(fromHash(), false));

  $('#panel').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k) go({ type: 'community', id: Number(b.dataset.k) });
    else if (b.dataset.s) go({ type: 'station', id: Number(b.dataset.s) });
    else if (b.dataset.go === 'city') { go({ type: 'city' }); map.fitBounds(L.featureGroup(Object.values(polys)).getBounds(), { padding: [10, 10] }); }
    else if (b.dataset.tab) {
      S.tab = b.dataset.tab;
      b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawChart();
    }
  });
  function segment(id, key) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      S[key] = b.dataset.v;
      $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
  }
  segment('#metric', 'metric');
  segment('#period', 'period');

  // ---------- δεδομένα ----------
  async function loadOverview() {
    const st = $('#status');
    try {
      const r = await fetch('api/overview');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      S.data = await r.json();
      const m = S.data.meta;
      $('#envbar').hidden = m.env === 'production' && !m.mock;
      if (m.mock) $('#envbar').textContent = 'Συνθετικά δεδομένα (MOCK)';
      st.className = 'status';
      st.innerHTML = `<span class="dot"></span>Τελευταία μέτρηση ${tAthens(m.latest, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`;
      st.title = `${m.online} από ${m.stations} σταθμούς σε λειτουργία`;
      render();
    } catch (e) {
      st.className = 'status err';
      st.innerHTML = '<span class="dot"></span>Τα δεδομένα δεν είναι διαθέσιμα αυτή τη στιγμή';
      if (!S.data) $('#panel').innerHTML = '<p class="empty">Η πλατφόρμα ανοιχτών δεδομένων δεν απαντά. Δοκίμασε ξανά σε λίγο.</p>';
    }
  }

  S.view = fromHash();
  loadBoundaries().catch(() => {}).finally(loadOverview);
  setInterval(loadOverview, 10 * 60 * 1000);
})();
