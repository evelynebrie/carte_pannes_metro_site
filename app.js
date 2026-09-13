(() => {
  'use strict';
  const D = window.PANNES;
  if (!D || !window.L) { document.getElementById('error').hidden = false; return; }

  const I = D.inc, N = I.day.length;
  const LINES = Object.keys(D.lines).sort();
  const BIT = { 1: 1, 2: 2, 4: 4, 5: 8 };
  const DT = ['sem', 'sam', 'dim'];
  const NH = 28, H0 = 5, H1 = 26;                 // service day: 5 h → 2 h (hours 24–26 are after midnight)
  const PEAK = new Set([6, 7, 8, 15, 16, 17]);
  const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

  // ---- dates & numbers ----
  const DAY = 864e5, EPOCH = Date.parse(D.meta.epoch + 'T00:00:00Z');
  const dayOf = s => Math.round((Date.parse(s + 'T00:00:00Z') - EPOCH) / DAY);
  const FIRST = dayOf(D.meta.first), LAST = dayOf(D.meta.last);
  const DTYPE = new Uint8Array(LAST + 1);
  for (let d = 0; d <= LAST; d++) { const w = new Date(EPOCH + d * DAY).getUTCDay(); DTYPE[d] = w === 0 ? 2 : w === 6 ? 1 : 0; }
  const longDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtDay = d => longDate.format(new Date(EPOCH + d * DAY)).replace(/^1 /, '1er ');
  const nf = d => new Intl.NumberFormat('fr-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
  const F0 = nf(0), F1 = nf(1), F2 = nf(2);
  const int = v => F0.format(Math.round(v));
  const pct = v => (v < 0.1 ? F2 : F1).format(v) + ' %';
  const hh = h => `${h % 24} h`;

  // ---- lookups ----
  const STMASK = {};
  for (const [sid, s] of Object.entries(D.stations)) STMASK[sid] = s.lines.reduce((m, l) => m | BIT[l], 0);
  const SEGS_AT = {};
  D.segments.forEach((s, k) => { for (const sid of [s.a, s.b]) (SEGS_AT[sid + '|' + s.line] ||= []).push(k); });
  const LIEUX = D.lieux.map(l => ({
    anchor: (l.kind === 'station' || l.kind === 'arriere-gare') && l.station ? l.station : null,
    seg: l.kind === 'interstation' ? l.seg : null,
  }));
  const HOUR = new Uint8Array(N), MASK = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    HOUR[i] = Math.min(Math.floor(I.t0[i] / 60), NH - 1);
    const L = LIEUX[I.lieu[i]];
    MASK[i] = I.lines[i] || (L.anchor ? STMASK[L.anchor] : L.seg != null ? BIT[D.segments[L.seg].line] : 0);
  }
  const lineWord = l => D.lines[l].key;                       // verte, orange, jaune, bleue
  const segName = k => `${D.stations[D.segments[k].a].name} – ${D.stations[D.segments[k].b].name}`;

  const CAUSES = {
    'Clientèle|Méfait volontaire': 'Méfait volontaire d’un usager',
    'Clientèle|Blessée ou malade': 'Usager blessé ou malade',
    'Clientèle|Nuisance involontaire': 'Nuisance involontaire d’un usager',
    'Matériel roulant|MR-73': 'Problème sur un train MR-73',
    'Matériel roulant|MPM-10': 'Problème sur un train Azur',
    'Matériel roulant|Véhicules de travaux': 'Véhicule de travaux',
    'Équipements fixes|Service aux trains': 'Équipement fixe lié aux trains',
    'Équipements fixes|Service de la voie': 'Problème de voie',
    'Équipements fixes|Service aux stations': 'Équipement de station',
    'Exploitation trains|Ligne 1, 2, 4, 5': 'Exploitation des trains',
    'Exploitation trains|Centre de contrôle': 'Centre de contrôle',
    'Autres|Causes externes': 'Cause externe',
    'Autres|Contrats Réno-Stations': 'Chantier en station',
    'Autres|Contrats Réno-Système': 'Chantier de rénovation',
    'Autres|Pers. / Équipement STM': 'Personnel ou équipement de la STM',
    'Autres|Pers. / Équipement Externe': 'Personnel ou équipement externe',
  };
  const causeOf = i => {
    const c1 = D.dict.cause1[I.c1[i]], c2 = D.dict.cause2[I.c2[i]];
    return CAUSES[c1 + '|' + c2] || (c2 === 'Autres' || c2 === '#N/A' ? 'Autre ou non précisé' : c2);
  };

  // ---- state ----
  const S = { period: '3m', line: 'all', min5: false, sel: null };
  const PRESETS = { '3m': 91, all: null };
  function currentRange() {
    if (/^\d{4}$/.test(S.period)) return [Math.max(FIRST, dayOf(S.period + '-01-01')), Math.min(LAST, dayOf(S.period + '-12-31'))];
    const n = PRESETS[S.period];
    return n == null ? [FIRST, LAST] : [Math.max(FIRST, LAST - n + 1), LAST];
  }

  // Segments that share an incident recorded at a station, on the affected line(s).
  function segsFor(i, sid, lb) {
    let segs = [];
    for (const l of LINES) if (MASK[i] & STMASK[sid] & lb & BIT[l]) segs = segs.concat(SEGS_AT[sid + '|' + l] || []);
    if (!segs.length) for (const l of D.stations[sid].lines) if (lb & BIT[l]) segs = segs.concat(SEGS_AT[sid + '|' + l] || []);
    return segs;
  }

  function compute() {
    const [a, b] = currentRange();
    const dc = [0, 0, 0];
    for (let d = a; d <= b; d++) dc[DTYPE[d]]++;
    const scope = S.line === 'all' ? LINES : [S.line];
    const lb = S.line === 'all' ? 15 : BIT[S.line];
    const trainH = new Float64Array(NH);
    let service = 0;
    for (const l of scope) DT.forEach((dt, k) => {
      const s = D.service[l][dt];
      for (let h = 0; h < NH; h++) { trainH[h] += s.minutes_train[h] * dc[k] / 60; service += s.minutes_service[h] * dc[k]; }
    });
    const R = { a, b, lb, trainH, service, n: 0, nAll: 0, n5All: 0, min: 0, lineMin: 0, hn: new Float64Array(NH),
                // per line as well, for the small clocks; an incident touching two lines counts in both,
                // so the four never have to add up to hn
                hnL: Object.fromEntries(LINES.map(l => [l, new Float64Array(NH)])),
                st: {}, sg: D.segments.map(() => 0), causes: new Map(), idx: [] };
    for (const sid in D.stations) R.st[sid] = 0;
    for (let i = 0; i < N; i++) {
      const d = I.day[i];
      if (d < a || d > b || !I.train[i]) continue;
      const m = MASK[i];
      if (S.line !== 'all' && !(m & lb)) continue;
      R.nAll++;                                   // counted before the 5-minute filter
      if (I.dur[i] >= 5) R.n5All++;
      if (S.min5 && I.dur[i] < 5) continue;
      const dur = Math.max(0, I.dur[i]);
      R.idx.push(i); R.n++; R.min += dur; R.hn[HOUR[i]]++;
      for (const l of LINES) if (m & BIT[l]) R.hnL[l][HOUR[i]]++;
      for (const l of scope) if (m & BIT[l]) R.lineMin += dur;
      const c = causeOf(i);
      R.causes.set(c, (R.causes.get(c) || 0) + 1);
      const L = LIEUX[I.lieu[i]];
      if (L.anchor) {
        R.st[L.anchor]++;
        const segs = segsFor(i, L.anchor, lb);
        for (const k of segs) R.sg[k] += 1 / segs.length;
      } else if (L.seg != null) R.sg[L.seg]++;
    }
    return R;
  }

  // ---- DOM helpers ----
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svText = (x, y, s, anchor) => { const t = sv('text', { x, y, 'text-anchor': anchor }); t.textContent = s; return t; };
  const dot = l => el('span', { class: 'dot', style: `background:${D.lines[l].color}`, title: `Ligne ${lineWord(l)}` });
  const tipBox = (title, sub) => el('div', {}, el('b', { text: title }), sub ? el('span', { text: sub }) : null);

  const tip = $('tip');
  function showTip(evt, strong, ...rest) {
    tip.textContent = '';
    tip.append(el('b', { text: strong }), ...rest.filter(Boolean).map(t => el('span', { text: t })));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + 12, y = evt.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 12;
    if (y < 8) y = evt.clientY + 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---- hour charts ----
  function niceTicks(max, n = 3) {
    if (!(max > 0)) return [0, 1];
    const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    const out = [];
    for (let v = 0; v < max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toPrecision(12));
    return out;
  }
  const barPath = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  };
  function hourChart(host, vals, { height = 148, fmt = int, label = '', mini = false, tipLine = null } = {}) {
    host.textContent = '';
    const W = Math.max(200, Math.floor(host.clientWidth || 300)), H = height;
    const m = mini ? { l: 0, r: 0, t: 4, b: 18 } : { l: 34, r: 2, t: 8, b: 22 };
    const hours = range(H0, H1 + 1);
    const pw = W - m.l - m.r, ph = H - m.t - m.b, step = pw / hours.length;
    const bw = Math.max(2, Math.min(mini ? 8 : 16, step - (mini ? 2 : 3)));
    const max = Math.max(0, ...hours.map(h => vals[h] || 0));
    const ticks = niceTicks(max), top = ticks[ticks.length - 1] || 1;
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': label });
    for (const [a, b] of [[6, 9], [15, 18]]) svg.append(sv('rect', { x: m.l + (a - H0) * step, y: m.t, width: (b - a) * step, height: ph, class: 'band' }));
    if (!mini) for (const t of ticks) {
      const y = m.t + ph - t / top * ph;
      if (t > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }));
      svg.append(svText(m.l - 8, y + 4, fmt(t), 'end'));
    }
    hours.forEach((h, k) => {
      const v = vals[h], x0 = m.l + k * step, x = x0 + (step - bw) / 2;
      let bar = null;
      if (v > 0) {
        const bh = Math.max(1, v / top * ph);
        bar = sv('path', { d: barPath(x, m.t + ph - bh, bw, bh, mini ? 1.5 : 3), class: 'bar' });
        svg.append(bar);
      }
      const hit = sv('rect', { x: x0, y: m.t, width: step, height: ph, class: 'hit' });
      hit.addEventListener('pointermove', e => { if (bar) bar.classList.add('on'); showTip(e, v == null ? 'Pas de service' : fmt(v), `${hh(h)} – ${hh(h + 1)}`, tipLine && tipLine(h)); });
      hit.addEventListener('pointerleave', () => { if (bar) bar.classList.remove('on'); hideTip(); });
      svg.append(hit);
      if (h % 6 === 0) svg.append(svText(x0 + step / 2, H - 5, hh(h), 'middle'));
    });
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: m.t + ph, y2: m.t + ph, class: 'base' }));
    host.append(svg);
  }

  // ---- map ----
  // the page itself never scrolls, so the wheel and trackpad are free to zoom the map
  const map = L.map('map', { scrollWheelZoom: true, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
  map.createPane('sel').style.zIndex = 415;
  map.createPane('lines').style.zIndex = 420;
  map.createPane('hits').style.zIndex = 425;
  map.createPane('stations').style.zIndex = 430;
  const esri = (layer, opts) => L.tileLayer(
    `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`,
    { maxNativeZoom: 16, maxZoom: 18, ...opts });
  esri('Base', { attribution: '© <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  esri('Reference', { opacity: 0.6 }).addTo(map);
  const bounds = L.latLngBounds(Object.values(D.stations).map(s => [s.lat, s.lon]));
  // Re-measure then refit: at load the panel has not reached its final size, so a single
  // fitBounds leaves the network cropped.
  const fitMap = () => { map.invalidateSize(false); map.fitBounds(bounds, { padding: [8, 8] }); };
  fitMap();
  map.attributionControl.setPrefix(false);

  const lines = D.segments.map(s => L.polyline(s.coords, { pane: 'lines', color: D.lines[s.line].color, weight: 3, lineCap: 'round', interactive: false }).addTo(map));
  const hits = D.segments.map((s, k) => L.polyline(s.coords, { pane: 'hits', weight: 22, opacity: 0, lineCap: 'round' })
    .on('click', e => { L.DomEvent.stopPropagation(e); select({ kind: 'seg', id: k }); }).addTo(map));
  const dots = {};
  for (const [sid, s] of Object.entries(D.stations)) {
    dots[sid] = L.circleMarker([s.lat, s.lon], { pane: 'stations', radius: s.lines.length > 1 ? 5 : 3.5, weight: s.lines.length > 1 ? 2 : 1.5, color: '#141414', fillColor: '#fff', fillOpacity: 1 })
      .on('click', e => { L.DomEvent.stopPropagation(e); select({ kind: 'station', id: sid }); }).addTo(map);
  }
  const selLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  map.on('click', () => { if (S.sel) select(null); });
  const width = (v, vmax) => 2.5 + 14 * Math.min(1, v / vmax);

  function renderMap(R) {
    const inLine = l => S.line === 'all' || l === S.line;
    const vmax = Math.max(1, ...R.sg.filter((_, k) => inLine(D.segments[k].line)));
    D.segments.forEach((s, k) => {
      const on = inLine(s.line);
      lines[k].setStyle({ color: on ? D.lines[s.line].color : '#dadada', weight: on ? width(R.sg[k], vmax) : 2 });
      hits[k].unbindTooltip();
      if (on) hits[k].bindTooltip(() => tipBox(segName(k), `${int(R.sg[k])} incidents`), { sticky: true, className: 'tt', direction: 'top', offset: [0, -10] });
    });
    for (const [sid, s] of Object.entries(D.stations)) {
      const on = s.lines.some(inLine);
      dots[sid].setStyle({ opacity: on ? 1 : 0.25, fillOpacity: on ? 1 : 0.4 });
      dots[sid].unbindTooltip();
      if (on) dots[sid].bindTooltip(() => tipBox(s.name, `${int(R.st[sid])} incidents à la station`), { className: 'tt', direction: 'top', offset: [0, -6] });
    }
    labelLayer.clearLayers();
    Object.entries(R.st).filter(([sid, v]) => v > 0 && D.stations[sid].lines.some(inLine))
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .forEach(([sid]) => L.tooltip({ permanent: true, direction: 'right', className: 'lbl', offset: [8, 0], interactive: false })
        .setLatLng([D.stations[sid].lat, D.stations[sid].lon]).setContent(el('span', { text: D.stations[sid].name })).addTo(labelLayer));

    selLayer.clearLayers();
    if (S.sel && S.sel.kind === 'seg') {
      const s = D.segments[S.sel.id];
      L.polyline(s.coords, { pane: 'sel', color: '#141414', weight: width(R.sg[S.sel.id], vmax) + 7, opacity: 0.18, lineCap: 'round', interactive: false }).addTo(selLayer);
    } else if (S.sel) {
      const s = D.stations[S.sel.id];
      L.circleMarker([s.lat, s.lon], { pane: 'stations', radius: 10, weight: 2, color: '#141414', fill: false, interactive: false }).addTo(selLayer);
    }

    // Width key with round numbers.
    const nice = v => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map(f => f * p).find(x => x >= v * 0.8) || v; };
    const keys = [...new Set([nice(vmax * 0.15), nice(vmax * 0.5), nice(vmax)].filter(v => v >= 1).map(Math.round))];
    const host = $('widths');
    host.textContent = '';
    keys.forEach(v => host.append(el('span', {}, el('i', { style: `height:${width(v, vmax).toFixed(1)}px` }), el('span', { text: int(v) }))));
  }

  // ---- place card ----
  function selectionWeights(R) {
    const out = [];
    if (S.sel.kind === 'station') {
      for (const i of R.idx) if (LIEUX[I.lieu[i]].anchor === S.sel.id) out.push([i, 1]);
    } else {
      const k = S.sel.id;
      for (const i of R.idx) {
        const L = LIEUX[I.lieu[i]];
        if (L.seg === k) out.push([i, 1]);
        else if (L.anchor) { const segs = segsFor(i, L.anchor, R.lb); if (segs.includes(k)) out.push([i, 1 / segs.length]); }
      }
    }
    return out;
  }

  function renderCard(R) {
    const card = $('card');
    if (!S.sel) { card.hidden = true; return; }
    const isSeg = S.sel.kind === 'seg';
    const W = selectionWeights(R);
    let n = 0, min = 0;
    const hn = new Float64Array(NH), causes = new Map();
    for (const [i, w] of W) {
      n += w; min += Math.max(0, I.dur[i]) * w; hn[HOUR[i]] += w;
      const c = causeOf(i); causes.set(c, (causes.get(c) || 0) + w);
    }
    const lns = isSeg ? [D.segments[S.sel.id].line] : D.stations[S.sel.id].lines;
    card.textContent = '';
    card.append(
      el('button', { class: 'close', type: 'button', 'aria-label': 'Fermer', text: '×', onclick: () => select(null) }),
      el('div', { class: 'kicker' }, ...lns.map(dot), el('span', { text: isSeg ? 'Entre deux stations' : 'Station' })),
      el('div', { class: 'name', text: isSeg ? segName(S.sel.id) : D.stations[S.sel.id].name }),
      el('div', { class: 'big' }, el('b', { text: int(n) }), Math.round(n) === 1 ? ' incident' : ' incidents'),
      el('div', { class: 'meta', text: `${int(min)} min d’arrêt au total` }));
    if (n >= 1) {
      let best = H0;
      for (let h = H0; h <= H1; h++) if (hn[h] > hn[best]) best = h;
      if (n >= 5) card.append(el('div', { class: 'meta', text: `Le plus souvent entre ${hh(best)} et ${hh(best + 1)}` }));
      card.append(el('div', { class: 'sub', text: 'Selon l’heure' }));
      const ch = el('div', { class: 'chart' });
      card.append(ch);
      requestAnimationFrame(() => hourChart(ch, hn, { height: 70, mini: true, label: 'Incidents selon l’heure' }));
      card.append(el('div', { class: 'sub', text: 'Causes principales' }));
      const ul = el('ul');
      [...causes].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([c, v]) => ul.append(el('li', {}, el('span', { text: c }), el('span', { text: int(v) }))));
      card.append(ul);
    }
    if (isSeg) card.append(el('p', { class: 'fine', text: 'Incidents entre ces deux stations, plus une part de ceux survenus à chacune d’elles.' }));
    card.hidden = false;
  }

  // ---- text & lists ----
  // ---- the flap board: a label on the left, its number on bigger flaps at the right ----
  // only the characters the board actually shows: every flap walks this list to reach its letter,
  // so each one dropped makes the roll shorter (anything else falls back to its unaccented form)
  const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZÉÊ0123456789%+',—";
  const FLIP = 24;                                    // must match --flip in styles.css
  const valueWidth = () => mode === 'wide' ? 14 : 7;   // the cell size the whole board is drawn from
  const ROWS = [
    { label: () => S.min5 ? ["NOMBRE D'ARRÊTS DE 5 MIN +", 'ARRÊTS 5 MIN +'] : ["NOMBRE D'INCIDENTS", 'INCIDENTS'],
      value: R => int(R.n) },
    // always the share of 5-minute-and-over incidents, measured against every incident of the
    // period — otherwise switching the filter on would make it 100 % by construction
    { label: () => ["% D'INCIDENTS DE 5 MIN ET +", '% DE 5 MIN ET +'],
      value: R => R.nAll ? F0.format(Math.round(R.n5All / R.nAll * 100)) + ' %' : '—' },
    { label: () => ["HEURES D'ARRÊT", "HEURES D'ARRÊT"], value: R => int(R.min / 60) },
    // Incidents per 100 hours of train running time. The share of service time it replaced
    // divided by how long a line is open, which flattered the short lines: the yellow one
    // reads 0,2 % of the time but 2,25 per 100 train-hours, the worst of the four.
    { label: () => ['POUR 100 HEURES DE CONDUITE', 'POUR 100 H'],
      value: R => {
        const th = R.trainH.reduce((s, v) => s + v, 0);
        if (!(th > 0)) return '—';
        // "1,26 INCIDENTS" is exactly the 14 cells the wide value zone has; the narrow board
        // drops the unit the way the old row dropped " DU TEMPS"
        const unit = mode === 'wide' ? (S.min5 ? ' ARRÊTS' : ' INCIDENTS') : '';
        return F2.format(R.n / th * 100) + unit;
      } },
  ];
  const boardEl = $('board');
  let mode = '', rowsUI = [];

  function makeFlap(variant) {
    const flap = el('div', { class: 'flap blank' + (variant ? ' ' + variant : '') });
    const part = cls => { const s = el('span', { text: ' ' }); flap.append(el('div', { class: cls }, s)); return s; };
    return { el: flap, top: part('half top'), bottom: part('half bottom'), leafTop: part('leaf top'), leafBottom: part('leaf bottom'),
             char: ' ', target: ' ', busy: false };
  }
  const labelWidth = () => mode === 'wide' ? 28 : 16;
  function buildBoard() {
    const want = innerWidth < 620 ? 'narrow' : 'wide';
    if (want === mode) return;
    mode = want;
    boardEl.textContent = '';
    const rowsBox = el('div', { class: 'board-rows' });
    rowsUI = ROWS.map(() => {
      const label = el('div', { class: 'zone label' }), value = el('div', { class: 'zone value' });
      const cells = {
        label: Array.from({ length: labelWidth() }, () => { const c = makeFlap(); label.append(c.el); return c; }),
        value: Array.from({ length: valueWidth() }, () => { const c = makeFlap('val'); value.append(c.el); return c; }),
      };
      rowsBox.append(el('div', { class: 'row' }, label, value));
      return cells;
    });
    boardEl.append(el('div', { class: 'board-body' }, rowsBox));
    sizeBoard();
  }
  function sizeBoard() {
    const frame = boardEl.parentElement;
    const pad = parseFloat(getComputedStyle(frame).paddingLeft) + parseFloat(getComputedStyle(frame).paddingRight);
    const width = Math.min((frame.clientWidth || 900) - pad, 1180);
    // labels and figures are the same size now, so the value zone no longer counts for more
    const units = labelWidth() * 1.08 + valueWidth() * 1.08 + 2.4;
    const cell = Math.max(7, Math.min(20, Math.floor((width - 10) / units)));
    document.documentElement.style.setProperty('--cell', cell + 'px');
  }
  const nextChar = ch => CHARS[(CHARS.indexOf(ch) + 1) % CHARS.length];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function flipOnce(c, to) {
    const from = c.char;
    c.top.textContent = to; c.bottom.textContent = from;
    c.leafTop.textContent = from; c.leafBottom.textContent = to;
    c.el.classList.remove('fold');
    void c.el.offsetWidth;                          // restart the fold animation
    c.el.classList.add('flipping', 'fold');
    await wait(FLIP);                               // timed, so the board lands right even if frames are dropped
    c.bottom.textContent = to; c.char = to;
    c.el.classList.remove('flipping', 'fold');
    c.el.classList.toggle('blank', to === ' ');
  }
  async function flipTo(c, ch) {
    c.target = ch;
    if (c.busy) return;
    c.busy = true;
    while (c.char !== c.target) await flipOnce(c, nextChar(c.char));
    c.busy = false;
  }
  const boardText = s => [...s.toUpperCase().replace(/[’‘]/g, "'").replace(/–/g, '-')]
    .map(ch => CHARS.includes(ch) ? ch : ch.normalize('NFD').replace(/[̀-ͯ]/g, ''))
    .map(ch => CHARS.includes(ch) ? ch : ' ').join('');
  function setCells(cells, text, align) {
    const t = boardText(text);
    let padded;
    if (align === 'center') {
      const room = Math.max(0, cells.length - t.length);
      padded = ' '.repeat(Math.floor(room / 2)) + t + ' '.repeat(Math.ceil(room / 2));
    } else padded = align ? t.padStart(cells.length) : t.padEnd(cells.length);
    const out = padded.slice(0, cells.length);
    cells.forEach((c, i) => {
      if (c.target !== out[i]) setTimeout(() => flipTo(c, out[i]), i * 6 + Math.random() * 25);
    });
  }
  const PERIODS = { '1m': '30 DERNIERS JOURS', '3m': '3 DERNIERS MOIS', '12m': '12 DERNIERS MOIS', all: `DEPUIS ${D.meta.first.slice(0, 4)}` };

  function renderBoard(R) {
    buildBoard();
    const wide = mode === 'wide';
    // the spoken figure has to be the one on the board, not the share of service time it replaced
    const th = R.trainH.reduce((s, v) => s + v, 0);
    const share = th > 0 ? F2.format(R.n / th * 100) : '—';
    // the accent rule above the board takes the selected line's colour
    document.documentElement.style.setProperty('--rail-paint', S.line === 'all'
      ? 'linear-gradient(90deg, #00b300 0 25%, #d95700 25% 50%, #ffd900 50% 75%, #0095e6 75% 100%)'
      : D.lines[S.line].color);
    // tab dots stay grey while every line is shown: coloured, they would read as line markers
    document.documentElement.style.setProperty('--tab', S.line === 'all' ? '#9b9890' : D.lines[S.line].color);
    document.documentElement.style.setProperty('--tab-ink', S.line === 'all' ? '#fbfaf6' : D.lines[S.line].text);
    ROWS.forEach((row, i) => {
      setCells(rowsUI[i].label, row.label()[wide ? 0 : 1], false);
      setCells(rowsUI[i].value, row.value(R), true);
    });
    boardEl.setAttribute('aria-label', `Du ${fmtDay(R.a)} au ${fmtDay(R.b)}, ${int(R.n)} `
      + `${S.min5 ? 'arrêts de 5 minutes ou plus' : 'incidents'}${S.line === 'all' ? '' : ' sur la ligne ' + lineWord(S.line)}, `
      + `${int(R.min / 60)} heures d’arrêt cumulées, soit ${share} incidents pour 100 heures de conduite.`);
  }

  function renderFresh(R) {
    // the date the STM file itself last changed, not the day we downloaded it
    const iso = D.meta.maj || D.meta.last;
    $('fresh').textContent = `Données de la STM mises à jour le ${longDate.format(new Date(iso + 'T00:00:00Z'))}`;
  }

  function renderHours(R) {
    // The dial takes the height the pane has left, measuring its real gaps, padding and
    // caption rather than assuming them.
    const pane = $('pane-heures');
    let avail = 230, paneW = 520;
    if (pane && pane.clientHeight) {
      const style = getComputedStyle(pane);
      const others = [...pane.children]
        .filter(c => !c.classList.contains('chart-block'))
        .reduce((s, c) => s + c.getBoundingClientRect().height, 0);
      const gaps = (parseFloat(style.rowGap) || 12) * (pane.children.length - 1);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const caption = [...pane.querySelectorAll('.chart-block figcaption')]
        .reduce((s, c) => s + c.getBoundingClientRect().height + 6, 0);
      // 24 px of slack: the two rows of small dials carry their own captions, which this
      // measurement cannot see before they are drawn. At 16 px the pane ran 4 px over on a
      // 768 px screen.
      avail = pane.clientHeight - others - gaps - padY - caption - 24;
      paneW = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }
    // With one line picked the small dials would only repeat it, so the big one takes the room.
    const solo = S.line !== 'all';
    const size = Math.max(120, Math.min(avail, solo ? paneW : paneW * 0.54));
    const perHour = h => R.trainH[h] > 1 ? `${F1.format(R.hn[h] / R.trainH[h] * 100)} pour 100 h de conduite` : null;
    clockChart($('clock-all'), R.hn, size, {
      center: int(R.n), centerSub: 'INCIDENTS', label: 'Incidents selon l’heure',
      tipLine: h => perHour(h),
    });
    const minis = $('clock-lines');
    minis.textContent = '';
    if (!solo) {
      const ms = Math.max(54, Math.min((paneW - size - 24) / 2, size * 0.46));
      for (const l of LINES) {
        const name = lineWord(l)[0].toUpperCase() + lineWord(l).slice(1);
        const n = range(H0, H1 + 1).reduce((s, h) => s + R.hnL[l][h], 0);
        const host = el('div');
        minis.append(el('div', { class: 'mini' }, host, el('span', { class: 'mini-name', text: `${name} · ${int(n)}` })));
        clockChart(host, R.hnL[l], ms, { fill: D.lines[l].color, labels: false,
          label: `Incidents selon l’heure — ligne ${lineWord(l)}`,
          tipLine: h => `ligne ${lineWord(l)}` });
      }
    }
  }

  // The service day as a dial: 5 h at the top, one sector an hour, radius the count.
  function clockChart(host, vals, size, { fill = null, labels = true, center = null, centerSub = '', label = '', tipLine = null } = {}) {
    host.textContent = '';
    const hours = range(H0, H1 + 1), n = hours.length;
    const half = size / 2, r0 = half * 0.34, r1 = half * (labels ? 0.78 : 0.9);
    const max = Math.max(0, ...hours.map(h => vals[h] || 0)) || 1;
    const svg = sv('svg', { width: size, height: size, class: 'clock', role: 'img', 'aria-label': label });
    const ang = k => (k / n) * 2 * Math.PI - Math.PI / 2;
    const pt = (a, r) => [half + Math.cos(a) * r, half + Math.sin(a) * r];
    const wedge = (a0, a1, rA, rB) => {
      const [x0, y0] = pt(a0, rB), [x1, y1] = pt(a1, rB), [x2, y2] = pt(a1, rA), [x3, y3] = pt(a0, rA);
      return `M${x0},${y0}A${rB},${rB} 0 0 1 ${x1},${y1}L${x2},${y2}A${rA},${rA} 0 0 0 ${x3},${y3}Z`;
    };
    hours.forEach((h, k) => {
      const a0 = ang(k) + 0.012, a1 = ang(k + 1) - 0.012;
      if (PEAK.has(h)) svg.append(sv('path', { d: wedge(a0, a1, r0, r1), class: 'peak' }));
      const v = vals[h] || 0;
      let arc = null;
      if (v > 0) {
        arc = sv('path', { d: wedge(a0, a1, r0, r0 + (r1 - r0) * (v / max)), class: 'wedge' });
        // a presentation attribute loses to the class rule, so set it as a style
        if (fill) arc.style.fill = fill;
        svg.append(arc);
      }
      const hit = sv('path', { d: wedge(a0, a1, r0, r1), class: 'hit' });
      hit.addEventListener('pointermove', e => {
        if (arc) arc.classList.add('on');
        showTip(e, int(v), `${hh(h)} – ${hh(h + 1)}`, tipLine && tipLine(h));
      });
      hit.addEventListener('pointerleave', () => { if (arc) arc.classList.remove('on'); hideTip(); });
      svg.append(hit);
    });
    svg.append(sv('circle', { cx: half, cy: half, r: r0, class: 'hub' }));
    if (labels) for (const k of [0, 4, 7, 11, 13, 19]) {
      const [x, y] = pt(ang(k) + Math.PI / n, r1 + 12);
      svg.append(svText(x, y + 3, hh(hours[k]), 'middle'));
    }
    if (center != null) {
      // The figure has to fit the hub, which scales with the dial. A fixed size held for "828"
      // but "27 907" ran straight through the ring, so derive it from the room available and
      // the number of characters: a monospace glyph advances about .6 em.
      const room = r0 * 2 * 0.84;
      const fs = Math.max(8, Math.min(size * 0.115, room / (String(center).length * 0.62)));
      const subFs = Math.max(6, Math.min(9, fs * 0.4));
      // below ~170 px the hub is narrower than the word, which then reads as "NCIDENT"
      const shown = centerSub && size >= 170;
      // digits sit on their cap height, roughly .35 em above the baseline
      const base = half + fs * 0.35 - (shown ? subFs * 0.8 : 0);
      const c = svText(half, base, center, 'middle');
      c.setAttribute('class', 'big');
      c.style.fontSize = fs.toFixed(1) + 'px';
      svg.append(c);
      if (shown) {
        // the gap has to clear the digits' own descender room, so it follows the figure's size
        // rather than the caption's: measured from subFs alone, the two blocks overlapped
        const s = svText(half, base + fs * 0.3 + subFs * 1.45, centerSub, 'middle');
        s.setAttribute('class', 'big-sub');
        s.style.fontSize = subFs.toFixed(1) + 'px';
        svg.append(s);
      }
    }
    host.append(svg);
  }

  function listRow(name, v, mx, { rank, lns = [], onclick } = {}) {
    return el('li', { class: rank ? null : 'no-rank' },
      rank ? el('span', { class: 'k', text: String(rank) }) : null,
      el('span', { class: 'nm' }, ...lns.map(dot), onclick ? el('button', { type: 'button', text: name, onclick }) : el('span', { text: name })),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: `width:${mx ? v / mx * 100 : 0}%` })),
      el('span', { class: 'num', text: int(v) }));
  }

  function renderLists(R) {
    const where = $('where'), why = $('why'), troncons = $('troncons');
    where.textContent = ''; why.textContent = ''; troncons.textContent = '';
    const st = Object.entries(R.st).filter(([sid, v]) => v > 0 && (S.line === 'all' || D.stations[sid].lines.includes(S.line)))
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    st.forEach(([sid, v], k) => where.append(listRow(D.stations[sid].name, v, st[0][1],
      { rank: k + 1, lns: D.stations[sid].lines, onclick: () => focusStation(sid) })));
    // worst stretches, using the same values the map draws
    const sg = R.sg.map((v, k) => [k, v])
      .filter(([k, v]) => v > 0 && (S.line === 'all' || D.segments[k].line === S.line))
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    sg.forEach(([k, v], i) => troncons.append(listRow(segName(k), v, sg[0][1],
      { rank: i + 1, lns: [D.segments[k].line], onclick: () => focusSegment(k) })));
    const cs = [...R.causes].sort((a, b) => b[1] - a[1]).slice(0, 8);
    cs.forEach(([c, v]) => why.append(listRow(c, v, cs[0][1])));
  }

  function focusSegment(k) {
    const coords = D.segments[k].coords;
    select({ kind: 'seg', id: k });
    map.setView(coords[Math.floor(coords.length / 2)] || coords[0], Math.max(map.getZoom(), 13), { animate: true });
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function focusStation(sid) {
    const s = D.stations[sid];
    select({ kind: 'station', id: sid });
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 13), { animate: true });
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- render ----
  let last = null;
  function render() {
    const R = compute();
    last = R;
    renderBoard(R);
    renderFresh(R);
    renderMap(R);
    renderCard(R);
    renderHours(R);
    renderLists(R);
  }
  function select(sel) { S.sel = sel; renderMap(last); renderCard(last); }

  // ---- controls ----
  const period = $('period');
  const lastYear = +D.meta.last.slice(0, 4), lastIsPartial = !D.meta.last.endsWith('12-31');
  period.append(el('option', { value: '3m', text: '3 derniers mois disponibles' }));
  for (let y = lastYear; y >= +D.meta.first.slice(0, 4); y--)
    period.append(el('option', { value: String(y), text: y === lastYear && lastIsPartial ? `${y} (jusqu’au ${longDate.format(new Date(EPOCH + LAST * DAY)).replace(/ \d{4}$/, '')})` : String(y) }));
  period.append(el('option', { value: 'all', text: `Depuis ${D.meta.first.slice(0, 4)}` }));
  period.value = S.period;
  period.addEventListener('change', () => { S.period = period.value; render(); });

  const pills = $('lines');
  const pill = (value, ...kids) => el('button', { type: 'button', 'data-v': value, 'aria-pressed': String(S.line === value) }, ...kids);
  pills.append(pill('all', 'Toutes'));
  for (const l of LINES) {
    const name = lineWord(l)[0].toUpperCase() + lineWord(l).slice(1);
    // the coloured dot names the line on screen; the label keeps it named for screen readers
    const b = pill(l, dot(l), el('span', { class: 'pill-name', text: name }));
    b.setAttribute('aria-label', `Ligne ${lineWord(l)}`);
    pills.append(b);
  }
  pills.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    S.line = b.dataset.v;
    for (const x of pills.children) x.setAttribute('aria-pressed', String(x === b));
    if (S.sel && S.line !== 'all') {
      const ok = S.sel.kind === 'seg' ? D.segments[S.sel.id].line === S.line : D.stations[S.sel.id].lines.includes(S.line);
      if (!ok) S.sel = null;
    }
    render();
  });
  $('min5').addEventListener('change', e => { S.min5 = e.target.checked; render(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && S.sel) select(null); });
  const info = $('info'), infoPanel = $('info-panel');
  const showInfo = on => { infoPanel.hidden = !on; info.setAttribute('aria-expanded', String(on)); };
  info.addEventListener('click', () => showInfo(infoPanel.hidden));
  $('info-close').addEventListener('click', () => { showInfo(false); info.focus(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !infoPanel.hidden) { showInfo(false); info.focus(); } });

  // a tab only gets its real width when shown, so redraw the charts then
  addEventListener('tabchange', () => { if (last) renderHours(last); });

  // web fonts change the height of the text the charts are sized against: measure again once they land
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { fitMap(); if (last) { renderBoard(last); renderHours(last); } });
  }

  let t;
  addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { sizeBoard(); fitMap(); if (last) { renderBoard(last); renderHours(last); renderCard(last); } }, 150);
  });

  $('footer').append('Sources : ', el('a', { href: D.meta.source, text: 'Incidents du réseau du métro' }),
    ' et horaires planifiés (STM, données ouvertes de Montréal). Fond de carte : Esri, OpenStreetMap.');

  render();
})();

/* Tabs: Heures · Stations · Causes · Méthode */
(() => {
  'use strict';
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;
  function show(tab) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    dispatchEvent(new Event('tabchange'));
  }
  tabs.forEach(tab => tab.addEventListener('click', () => show(tab)));
  document.querySelector('[role="tablist"]').addEventListener('keydown', e => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.focus();
    show(next);
  });
})();

