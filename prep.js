// Spirale — Préparation V1.7 : trajet optimal d'un circuit (interface)
// Le calcul tourne dans prep-calcul.js (Web Worker) pour ne pas figer la page.
(() => {
  'use strict';

  const CIRCUITS = [
    { id: 'tache_greoux_saintauban', titre: 'Gréoux → Saint-Auban' },
    { id: 'tache_versoud_barcelonnette', titre: 'Le Versoud → Barcelonnette' },
    { id: 'tache_stjean_challes', titre: 'St Jean → Challes' },
    { id: 'test_stcrepin_saintauban', titre: 'St Crépin → Saint-Auban' },
    { id: 'tache_versoud_aubenasson', titre: 'Le Versoud → Aubenasson (CdF J1R3)' },
    { id: 'tache_gap_fayence', titre: 'Gap-Tallard → Fayence (CdF 2025 É4)' },
  ];
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ----- version
  (() => {
    const v = window.SPIRALE_VERSION; if (!v) return;
    const d = new Date(v.date);
    const txt = `Version ${v.numero} · mise à jour le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    document.querySelectorAll('[data-version]').forEach(el => { el.textContent = txt; });
  })();

  // ----- worker (même numéro anti-cache que ce script)
  const vParam = (document.currentScript && document.currentScript.src.split('?')[1]) || '';
  const worker = new Worker('prep-calcul.js' + (vParam ? '?' + vParam : ''));
  const etat = { D: null, zonesBase: [], zones: [], corrections: {}, sel: null, charge: null, resultat: null, calcul: false, options: [], vue: 0, mode: 'nouveau' };

  // ----- carte
  const carte = L.map('p-carte', { preferCanvas: true, zoomControl: true });
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: 'Carte © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · thermiques <a href="https://thermal.kk7.ch">kk7</a>',
  }).addTo(carte);
  carte.createPane('zonesVol').style.zIndex = 350;                     // sous les thermiques
  const rendZones = L.svg({ pane: 'zonesVol' });
  const calques = {
    zonesFond: L.layerGroup().addTo(carte),
    thermiques: L.layerGroup().addTo(carte), circuit: L.layerGroup().addTo(carte),
    zones: L.layerGroup().addTo(carte), trajet: L.layerGroup().addTo(carte),
  };
  carte.setView([44.4, 6.2], 9);

  // ----- crêtes : repères (beige), thermiques de crête (orange) et vol de pente (bleu)
  calques.cretes = L.layerGroup().addTo(carte);
  function dessinerCretes() {
    calques.cretes.clearLayers();
    if (!$('p-voir-cretes').checked || !etat.cretes) return;
    const rend = L.canvas({ padding: 0.3 });
    etat.cretes.forEach(([la, lo, vzT, vzD, h, laD, loD, top]) => {
      if (!(vzT > 0) && !(vzD > 0)) L.circleMarker([la, lo], { renderer: rend, radius: 2.5, color: '#6b4f2a', weight: 1, fillColor: '#c8a97e', fillOpacity: 0.8 })
        .bindTooltip(`Crête · ${h} m`).addTo(calques.cretes);
      if (vzT > 0) L.circleMarker([la, lo], { renderer: rend, radius: 4, color: '#7a4a00', weight: 1, fillColor: '#f59f00', fillOpacity: 0.9 })
        .bindTooltip(`Thermique de crête · ${h} m · ~${vzT} m/s`).addTo(calques.cretes);
      if (vzD > 0) {
        L.polyline([[la, lo], [laD, loD]], { renderer: rend, color: '#1971c2', weight: 2, interactive: false }).addTo(calques.cretes);
        L.circleMarker([laD, loD], { renderer: rend, radius: 4, color: '#0b3d91', weight: 1, fillColor: '#4dabf7', fillOpacity: 0.95 })
          .bindTooltip(`Vol de pente · ~${vzD} m/s jusqu'à ${top} m (crête ${h} m)`).addTo(calques.cretes);
      }
    });
  }
  $('p-voir-cretes').addEventListener('change', dessinerCretes);

  // ----- cœurs de parcs nationaux (Écrins, Vanoise, Mercantour) et cheminements autorisés
  calques.parcs = L.layerGroup().addTo(carte);
  etat.parcs = []; etat.couloirs = [];
  Promise.all([fetch('prep/parcs.json').then(r => r.json()), fetch('prep/couloirs.json').then(r => r.json())])
    .then(([p, c]) => { etat.parcs = p; etat.couloirs = c; dessinerParcs(); }).catch(() => {});
  function dessinerParcs() {
    calques.parcs.clearLayers();
    if ($('p-sansparcs').checked) return;
    etat.parcs.filter(p => p.role === 'outer').forEach(p => {
      L.polygon(p.pts, { renderer: rendZones, pane: 'zonesVol', interactive: false, color: '#2b8a3e', weight: 2, fillColor: '#2b8a3e', fillOpacity: 0.15 }).addTo(calques.parcs);
      let la = 0, lo = 0; p.pts.forEach(q => { la += q[0]; lo += q[1]; });
      L.marker([la / p.pts.length, lo / p.pts.length], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'etq-parc', html: `<span>${p.nom.replace('Parc national', 'PN')}<br><small>cœur : 1000 m/sol mini</small></span>`, iconSize: null }) }).addTo(calques.parcs);
    });
    etat.couloirs.forEach(c => {
      const bulle = `${c.nom} (${c.parc})<br>${c.altMin ? `cheminement autorisé à plus de ${c.altMin} m` : 'secteur autorisé sous 1000 m/sol'}`;
      if (c.type === 'disque') L.circle(c.centre, { radius: c.rayonKm * 1000, color: '#e8590c', weight: 2, dashArray: '5 4', fillColor: '#e8590c', fillOpacity: 0.15 }).bindTooltip(bulle).addTo(calques.parcs);
      else L.polyline(c.pts, { color: '#e8590c', weight: 7, opacity: 0.55, lineCap: 'round' }).bindTooltip(bulle).addTo(calques.parcs);
    });
  }

  // ----- réglages
  CIRCUITS.forEach(c => $('p-circuit').add(new Option(c.titre, c.id)));
  const lire = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
  const regl = lire('spirale-prep-reglages-v26', {});   // v26 : nouveaux réglages par défaut (calage Condor)
  const curseurs = {
    marge: ['p-marge', 'o-marge', v => `${v} m`],
    mc: ['p-mc', 'o-mc', v => `${(+v).toFixed(1)} m/s`],
    eff: ['p-eff', 'o-eff', v => `${Math.round(v * 100)} %`],
    rayon: ['p-rayon', 'o-rayon', v => `${v} m`],
    vdir: ['p-vdir', 'o-vdir', v => `${v}° (${['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(v / 45) % 8]})`],
    vkmh: ['p-vkmh', 'o-vkmh', v => +v ? `${v} km/h` : 'sans vent'],
    cretes: ['p-cretes', 'o-cretes', v => `${Math.round(v * 100)} %`],
    pente: ['p-pente', 'o-pente', v => `${Math.round(v * 100)} %`],
    svent: ['p-svent', 'o-svent', v => `${Math.round(v * 100)} %`],
    pmax: ['p-pmax', 'o-pmax', v => `${v} m`],
    pmin: ['p-pmin', 'o-pmin', v => `${v} m`],
    vz: ['p-vz', 'o-vz', v => `${(+v).toFixed(1)} m/s`],
  };
  for (const [cle, [idIn, idOut, fmt]] of Object.entries(curseurs)) {
    if (regl[cle] != null) $(idIn).value = regl[cle];
    const maj = () => { $(idOut).textContent = fmt($(idIn).value); regl[cle] = +$(idIn).value; ecrire('spirale-prep-reglages-v26', regl); };
    $(idIn).addEventListener('input', maj); maj();
    if (['pmax', 'pmin', 'vz'].includes(cle)) $(idIn).addEventListener('input', () => { majZones(); });
  }
  // ----- cases Condor : parcs et ballast (mémorisées)
  for (const id of ['p-ballast', 'p-sansparcs']) {
    if (regl[id] != null) $(id).checked = !!regl[id];
    $(id).addEventListener('change', () => { regl[id] = $(id).checked ? 1 : 0; ecrire('spirale-prep-reglages-v26', regl); if (id === 'p-sansparcs') dessinerParcs(); });
  }
  // ----- météo d'un plan de vol Condor (.fpl) : vent de la zone de base, plafonds, force des thermiques
  $('p-fpl').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    appliquerMeteoFpl(new TextDecoder('latin1').decode(await f.arrayBuffer()), f.name);
    ev.target.value = '';
  });
  function appliquerMeteoFpl(txt, nomFichier) {
    const zonesM = txt.split(/\[WeatherZone\d+\]/).slice(1).map(b => {
      const v = k => { const m = b.match(new RegExp('^' + k + '=([-0-9.]+)', 'm')); return m ? +m[1] : NaN; };
      return { dir: v('WindDir'), vit: v('WindSpeed'), force: v('ThermalsStrength'), inv: v('ThermalsInversionheight') };
    }).filter(z => isFinite(z.inv));
    if (!zonesM.length) { $('p-fpl-info').textContent = 'Pas de météo trouvée dans ce fichier.'; return false; }
    const base = zonesM[0], invs = zonesM.map(z => z.inv);
    const regle = (id, v) => { const el = $(id); el.value = Math.max(+el.min, Math.min(+el.max, v)); el.dispatchEvent(new Event('input')); };
    regle('p-vdir', Math.round(base.dir / 5) * 5 % 360);
    regle('p-vkmh', Math.round(base.vit * 3.6));
    regle('p-pmax', Math.round(Math.max(...invs) / 50) * 50);
    regle('p-pmin', Math.round(Math.max(Math.min(...invs), 1500) / 50) * 50);
    if (isFinite(base.force)) regle('p-vz', 2.8 + 0.6 * base.force);
    const nom = (txt.match(/^TaskName=(.*)$/m) || [, nomFichier])[1].trim();
    $('p-fpl-info').textContent = `${nom} : vent du ${Math.round(base.dir)}° ${Math.round(base.vit * 3.6)} km/h, plafonds ${Math.round(Math.min(...invs))}–${Math.round(Math.max(...invs))} m, force ${base.force} (${zonesM.length} zone${zonesM.length > 1 ? 's' : ''} météo). Relance le calcul.`;
    return true;
  }

  // ----- tâches Condor chargées depuis un .fpl ou un .ftr (paysage AA3) : relief et thermiques
  // découpés dans les données de la région, la tâche est ajoutée à la liste des circuits
  const AA3 = { zone: 32, x0: 1059840, n0: 4786560 };   // projection Condor du paysage AA3 (UTM 32)
  function utm2ll(E, N, zone) {
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996;
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)), mu = N / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
    const p = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2), T1 = Math.tan(p) ** 2, C1 = ep2 * Math.cos(p) ** 2;
    const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p) ** 2) ** 1.5, D = (E - 500000) / (N1 * k0);
    const lat = p - (N1 * Math.tan(p) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720);
    const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(p);
    return [lat * 180 / Math.PI, lon * 180 / Math.PI + (zone - 1) * 6 - 177];
  }
  const versLatLon = (x, y) => utm2ll(AA3.x0 - x, y + AA3.n0, AA3.zone);
  function pointTache(k, n, nom, x, y, rayon, angle, hauteur) {
    const [lat, lon] = versLatLon(x, y);
    const p = { nom: k === 0 ? 'Départ ' + nom : k === n - 1 ? 'Arrivée ' + nom : `P${k} ${nom}`, lat, lon, rayon, forme: angle === 180 ? 'secteur' : 'cylindre', angle: angle === 180 ? 180 : 360, hmin: 0, hmax: 10000 };
    if (k === 0 && hauteur > 0 && hauteur < 10000) p.hmax = hauteur;
    return p;
  }
  function lireTacheFpl(txt) {
    const v = (k) => { const m = txt.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
    const n = +v('Count'); if (!(n >= 3)) throw new Error('pas de tâche dans ce .fpl');
    const pays = v('Landscape'); if (pays && pays !== 'AA3') throw new Error(`paysage ${pays} non pris en charge (seulement AA3)`);
    const tache = [];
    for (let k = 1; k < n; k++) tache.push(pointTache(k - 1, n - 1, v('TPName' + k), +v('TPPosX' + k), +v('TPPosY' + k), +v('TPRadius' + k), +v('TPAngle' + k), +v('TPHeight' + k)));
    return { titre: v('TaskName') || 'Tâche Condor', tache, heureDepart: (+v('StartTime') || 13) * 3600 };
  }
  function lireTacheFtr(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf), tp = [];
    for (let k = 0; k < 16; k++) {
      const o = 247 + 84 * k, n = b[o]; if (!n || n > 16) break;
      tp.push({ nom: new TextDecoder('latin1').decode(b.slice(o + 1, o + 1 + n)), x: dv.getFloat32(o + 17, true), y: dv.getFloat32(o + 21, true),
                rayon: dv.getInt32(o + 44, true), angle: dv.getInt32(o + 48, true), h: dv.getFloat32(o + 60, true) });
    }
    if (tp.length < 3 || String.fromCharCode(b[0], b[1], b[2]) !== 'FTR') throw new Error('fichier .ftr non reconnu');
    const pts = tp.slice(1), n = pts.length;
    const nomPil = (new TextDecoder('latin1').decode(b.slice(150, 240)).match(/[ -~]{2,}/g) || []).slice(0, 2).join(' ');
    return { titre: `${pts[0].nom} → ${pts[n - 1].nom}` + (nomPil ? ` (replay ${nomPil})` : ''), heureDepart: 13 * 3600,
             tache: pts.map((p, k) => pointTache(k, n, p.nom, p.x, p.y, p.rayon, p.angle, p.h)) };
  }
  let region = null;
  async function chargerRegion() {
    if (region) return region;
    const [D, buf] = await Promise.all([
      fetch('prep/region_aa3/donnees.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch('prep/region_aa3/relief.bin').then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    ]);
    return (region = { D, Z: new Int16Array(buf) });
  }
  function construireCircuit(def, R) {
    const t = def.tache, marge = 15;
    const lat0 = (Math.min(...t.map(p => p.lat)) + Math.max(...t.map(p => p.lat))) / 2;
    const kLat = 111.195, kLon = kLat * Math.cos(lat0 * Math.PI / 180);
    const z = { latMin: Math.min(...t.map(p => p.lat - (p.rayon / 1000 + marge) / kLat)), latMax: Math.max(...t.map(p => p.lat + (p.rayon / 1000 + marge) / kLat)),
                lonMin: Math.min(...t.map(p => p.lon - (p.rayon / 1000 + marge) / kLon)), lonMax: Math.max(...t.map(p => p.lon + (p.rayon / 1000 + marge) / kLon)) };
    const La = R.D.relief.lat, Lo = R.D.relief.lon, NL = R.D.relief.nLon;
    const i0 = La.findIndex(x => x >= z.latMin), j0 = Lo.findIndex(x => x >= z.lonMin);
    let i1 = La.length - 1; while (i1 > 0 && La[i1] > z.latMax) i1--;
    let j1 = Lo.length - 1; while (j1 > 0 && Lo[j1] > z.lonMax) j1--;
    if (i0 <= 0 || j0 <= 0 || i1 >= La.length - 1 || j1 >= Lo.length - 1 || i1 <= i0 || j1 <= j0)
      throw new Error('tâche en dehors de la zone couverte par le site');
    const nLat = i1 - i0 + 1, nLon = j1 - j0 + 1, Z = new Int16Array(nLat * nLon);
    for (let i = 0; i < nLat; i++) Z.set(R.Z.subarray((i0 + i) * NL + j0, (i0 + i) * NL + j1 + 1), i * nLon);
    const dans = (p) => p[0] >= z.latMin && p[0] <= z.latMax && p[1] >= z.lonMin && p[1] <= z.lonMax;
    const D = { id: def.id, titre: def.titre, heureDepart: def.heureDepart, tache: t, zone: z,
                kk7: R.D.kk7.filter(dans), fond: R.D.fond.filter(dans), passage: R.D.passage.filter(dans),
                relief: { lat: La.slice(i0, i1 + 1), lon: Lo.slice(j0, j1 + 1), nLat, nLon } };
    return { D, relief: Z.buffer };
  }
  const tachesPerso = lire('spirale-taches-perso', []) || [];
  tachesPerso.forEach(d => $('p-circuit').add(new Option('★ ' + d.titre, d.id)));
  $('p-tache').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return; ev.target.value = '';
    try {
      const buf = await f.arrayBuffer(), estFpl = /\.fpl$/i.test(f.name);
      const txt = estFpl ? new TextDecoder('latin1').decode(buf) : null;
      const def = estFpl ? lireTacheFpl(txt) : lireTacheFtr(buf);
      def.id = 'perso_' + def.tache.map(p => p.lat.toFixed(3) + p.lon.toFixed(3)).join('').replace(/\D/g, '').slice(-24);
      const i = tachesPerso.findIndex(d => d.id === def.id);
      if (i >= 0) tachesPerso.splice(i, 1); else $('p-circuit').add(new Option('★ ' + def.titre, def.id));
      tachesPerso.push(def); while (tachesPerso.length > 12) tachesPerso.shift();
      ecrire('spirale-taches-perso', tachesPerso);
      $('p-circuit').value = def.id;
      const meteo = estFpl && appliquerMeteoFpl(txt, f.name);
      $('p-tache-info').textContent = `${def.titre} : ${def.tache.length - 1} branches` + (meteo ? ', météo du plan de vol appliquée.' : (estFpl ? '.' : ' (le .ftr ne contient pas la météo : charge le .fpl pour la régler).'));
      chargerCircuit(def.id);
    } catch (err) {
      $('p-tache-info').textContent = 'Impossible de lire cette tâche : ' + err.message;
    }
  });
  // ----- zones de vol (plafond automatique selon la hauteur des crêtes + corrections par zone)
  function majZones() {
    if (!etat.D) return;
    etat.zones = reglerZonesVol(etat.zonesBase, { plafondMax: +$('p-pmax').value, plafondPlaine: +$('p-pmin').value, vzMax: +$('p-vz').value }, etat.corrections);
    dessinerZones(); afficherZoneSel();
  }
  function afficherZoneSel() {
    const z = etat.zones.find(x => x.id === etat.sel);
    $('p-zone-reglage').hidden = !z;
    if (!z) { $('p-zone-info').textContent = 'Clique une zone sur la carte pour la corriger.'; return; }
    const c = etat.corrections[z.id] || {};
    $('p-zone-info').textContent = `Zone n° ${z.id + 1} · crêtes vers ${Math.round(z.crete)} m · plafond automatique ${z.auto} m`;
    $('p-corr').value = c.plafond || 0; $('o-corr').textContent = `${(c.plafond || 0) >= 0 ? '+' : ''}${c.plafond || 0} m → ${z.plafond} m`;
    $('p-vzz').value = c.vz || 1; $('o-vzz').textContent = `×${(c.vz || 1).toFixed(2)} → ${z.vzMax.toFixed(1)} m/s`;
  }
  function corriger() {
    if (etat.sel == null) return;
    const c = etat.corrections[etat.sel] = etat.corrections[etat.sel] || {};
    c.plafond = +$('p-corr').value; c.vz = +$('p-vzz').value;
    if (!c.plafond && c.vz === 1) delete etat.corrections[etat.sel];
    ecrire('spirale-prep-corr-' + etat.D.id, etat.corrections);
    majZones();
  }
  $('p-corr').addEventListener('input', corriger);
  $('p-vzz').addEventListener('input', corriger);
  $('p-zones-defaut').addEventListener('click', () => {
    etat.corrections = {}; ecrire('spirale-prep-corr-' + etat.D.id, {}); majZones();
  });
  carte.on('click', (e) => {     // zone cliquée = germe le plus proche (cellules de Voronoï)
    if (!etat.zones.length) return;
    let b = null, db = Infinity;
    const k = Math.cos(e.latlng.lat * Math.PI / 180);
    etat.zones.forEach(z => { const d = (z.lat - e.latlng.lat) ** 2 + ((z.lon - e.latlng.lng) * k) ** 2; if (d < db) { db = d; b = z.id; } });
    etat.sel = etat.sel === b ? null : b;
    dessinerZones(); afficherZoneSel();
  });
  $('p-circuit').addEventListener('change', () => chargerCircuit($('p-circuit').value));
  $('p-calculer').addEventListener('click', () => calculer('nouveau'));
  $('p-autre').addEventListener('click', () => calculer('autre'));
  $('p-igc').addEventListener('click', telechargerIGC);

  // ----- chargement d'un circuit
  async function chargerCircuit(id) {
    etatTexte('Chargement du circuit…');
    if (id.startsWith('perso_') && !region) {
      try { etatTexte('Chargement des données de la région (une seule fois)…'); await chargerRegion(); }
      catch (err) { etatTexte('Données de la région introuvables (' + err.message + ').', true); return; }
    }
    $('p-calculer').disabled = true; $('p-igc').disabled = true;
    etat.resultat = null; etat.options = []; etat.finOptions = false; etat.vue = 0; viderResultat(); majOptions();
    try {
      const perso = tachesPerso.find(d => d.id === id);
      if (perso) etatTexte('Découpe du relief et des thermiques de la région…');
      const [D, relief] = perso ? (() => { const c = construireCircuit(perso, region); return [c.D, c.relief]; })()
        : await Promise.all([
          fetch(`prep/${id}/donnees.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
          fetch(`prep/${id}/relief.bin`).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
        ]);
      etat.D = D;
      // carte IA des cheminements, si elle existe pour ce circuit
      etat.ia = perso ? null : await fetch(`prep/${id}/carte_ia.json`).then(r => r.ok ? r.json() : null).catch(() => null);
      $('p-ia').disabled = !etat.ia;
      if (!etat.ia) $('p-ia').checked = false;
      $('p-ia-info').textContent = etat.ia
        ? `Carte apprise pour : vent du ${Math.round(etat.ia.meteo.vent_dir)}° ${Math.round(etat.ia.meteo.vent_kmh)} km/h, plafond ${Math.round(etat.ia.meteo.plafond_m)} m, thermiques ${etat.ia.meteo.vz_moyen.toFixed(1)} m/s.`
        : 'Pas de carte IA pour ce circuit (il faut des vols Condor de ce circuit).';
      etat.zonesBase = genererZonesVol(D, relief);
      etat.corrections = lire('spirale-prep-corr-' + id, {}) || {};
      etat.sel = null;
      majZones(); remplirBranches();
      dessinerCircuit(); dessinerThermiquesBruts();
      carte.fitBounds([[D.zone.latMin, D.zone.lonMin], [D.zone.latMax, D.zone.lonMax]], { padding: [10, 10] });
      worker.postMessage({ type: 'charger', D, relief }, [relief]);
    } catch (err) {
      etatTexte('Impossible de charger le circuit (' + err.message + ').', true);
    }
  }

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'charge') {
      etat.charge = m.id; $('p-calculer').disabled = false;
      etatTexte('Prêt. Règle les zones puis clique « Calculer ».');
      if (etat.calcul) etat.aRelancer = true; else calculer('nouveau');   // calcul automatique du trajet A
    } else if (m.type === 'progression') {
      etatTexte(m.texte);
    } else if (m.type === 'resultat') {
      finCalcul();
      if (!etat.D || m.r.id !== etat.D.id) {          // résultat d'un circuit qu'on vient de quitter
        if (etat.aRelancer && etat.charge === (etat.D && etat.D.id)) { etat.aRelancer = false; calculer('nouveau'); }
        return;
      }
      recevoir(m.r);
    } else if (m.type === 'erreur') {
      finCalcul(); etatTexte('Erreur de calcul : ' + m.message.split('\n')[0], true); console.error(m.message);
    }
  };

  // ----- options : A = trajet optimal ; B, C, D = meilleurs trajets en évitant les couloirs déjà trouvés
  const LETTRES = 'ABCDEF', COULEURS = ['#111111', '#1f6feb', '#1e8c3a', '#d9730d', '#9c36b5', '#c2255c'];
  const pointsTrajet = (r) => { const p = [[r.etapes[0].lat1, r.etapes[0].lon1]]; r.etapes.forEach(e => { if (e.type === 'T') p.push([e.lat2, e.lon2]); }); return p; };
  function pointsParBranche(r) {      // le trajet découpé entre deux points du circuit validés
    const br = []; let cur = [[r.etapes[0].lat1, r.etapes[0].lon1]];
    r.etapes.forEach(e => {
      if (e.type !== 'T') return;
      cur.push([e.lat2, e.lon2]);
      if (e.valide) { br.push(cur); cur = [[e.lat2, e.lon2]]; }
    });
    return br;
  }
  function tempsBranches(r) {         // temps, spirale, cheminement et altitude par branche
    const br = []; let cur = { t: 0, spi: 0, gain: 0, h: null };
    for (const e of r.etapes) {
      cur.t += e.duree; if (e.type === 'M') cur.spi += e.duree; cur.gain += e.gain;
      if (e.valide) { cur.h = e.h2; br.push(cur); cur = { t: 0, spi: 0, gain: 0, h: null }; }
    }
    return br;
  }
  const nomCourt = (t) => t.nom.replace(/^(Départ|Arrivée) /, '');
  function remplirBranches() {
    const T = etat.D.tache, sel = $('p-branche');
    sel.innerHTML = '';
    sel.add(new Option('Tout le circuit', '-1'));
    for (let i = 0; i < T.length - 1; i++) sel.add(new Option(`${nomCourt(T[i])} → ${nomCourt(T[i + 1])}`, String(i)));
  }
  function recevoir(r) {
    if (etat.mode === 'nouveau') {
      r.variante = 'Optimal';
      etat.options = [r]; etat.vue = 0; etat.finOptions = false;
      etat.cretes = r.cretes || []; dessinerCretes();
      dessinerThermiques(r.thermiques);
    } else if (r.ok) {
      r.variante = etat.varianteDemandee;
      etat.options.push(r); etat.vue = etat.options.length - 1;
    } else {
      etat.finOptions = true; majOptions();
      etatTexte(`Pas d'autre itinéraire possible pour « ${etat.varianteDemandee} » en évitant les options déjà trouvées (relief ou plafond trop justes). Essaie une autre branche.`, true);
      return;
    }
    afficherOption(etat.vue);
  }
  function afficherOption(i) {
    etat.vue = i; etat.resultat = etat.options[i];
    afficherResultat(etat.resultat);
    dessinerTrajets(); majOptions();
  }
  function majOptions() {
    const A = etat.options[0], box = $('r-options'), n = etat.options.length;
    box.innerHTML = '';
    $('r-nav').hidden = n < 2;
    if (n > 1) {
      etat.options.forEach((o, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'r-option' + (i === etat.vue ? ' actif' : '');
        b.style.setProperty('--c', COULEURS[i]);
        b.innerHTML = `<b>${LETTRES[i]}</b> ${hms(o.tempsTotal)}`;
        b.title = `Option ${LETTRES[i]} — ${o.variante}`;
        b.addEventListener('click', () => afficherOption(i));
        box.appendChild(b);
      });
      $('r-prec').disabled = etat.vue === 0; $('r-suiv').disabled = etat.vue === n - 1;
      $('r-vue').textContent = `Option ${LETTRES[etat.vue]} · ${etat.options[etat.vue].variante}` +
        (etat.vue ? ` · ${etat.options[etat.vue].tempsTotal >= A.tempsTotal ? '+' : '−'}${hms(Math.abs(etat.options[etat.vue].tempsTotal - A.tempsTotal))} sur A` : '');
    }
    majComparaison();
    $('p-autre').disabled = !(A && A.ok) || n >= LETTRES.length || etat.calcul || !!etat.finOptions;
    $('p-autre').textContent = `Proposer une option ${LETTRES[n] || ''}`.trim();
  }
  function majComparaison() {
    const tab = $('r-comparaison'), n = etat.options.length, bloc = $('r-comparaison-bloc');
    if (bloc.hidden !== (n < 2)) {                       // la carte change de taille
      bloc.hidden = n < 2;
      requestAnimationFrame(() => { carte.invalidateSize(); dessinerProfil(etat.resultat); });
    }
    if (n < 2) { tab.innerHTML = ''; return; }
    const T = etat.D.tache, nb = T.length - 1, A = etat.options[0];
    const tb = etat.options.map(tempsBranches);
    const mini = [];
    for (let k = 0; k < nb; k++) mini.push(Math.min(...tb.map(b => b[k] ? b[k].t : Infinity)));
    const tMin = Math.min(...etat.options.map(o => o.tempsTotal));
    let h = '<thead><tr><th>Option</th><th>Variante</th><th>Temps</th><th>km/h</th><th>Écart</th>';
    for (let k = 0; k < nb; k++) h += `<th title="${nomCourt(T[k])} → ${nomCourt(T[k + 1])}">→ ${nomCourt(T[k + 1]).replace(/^P(\d+).*/, 'P$1')}</th>`;
    h += '</tr></thead><tbody>';
    etat.options.forEach((o, i) => {
      const d = o.tempsTotal - A.tempsTotal;
      h += `<tr class="${i === etat.vue ? 'actif' : ''}" data-i="${i}"><td><span class="pastille-opt" style="background:${COULEURS[i]}">${LETTRES[i]}</span></td>`;
      h += `<td>${o.variante}</td><td${o.tempsTotal === tMin ? ' class="meilleur"' : ''}>${hms(o.tempsTotal)}</td>`;
      h += `<td>${(o.distanceCircuit / (o.tempsTotal / 3600)).toFixed(1)}</td><td>${i ? (d >= 0 ? '+' : '−') + hms(Math.abs(d)) : '—'}</td>`;
      for (let k = 0; k < nb; k++) {
        const x = tb[i][k];
        h += x ? `<td${x.t === mini[k] ? ' class="meilleur"' : ''}>${hms(x.t)}<br><small>${Math.round(distKm(T[k], T[k + 1]) / (x.t / 3600))} km/h</small></td>` : '<td>—</td>';
      }
      h += '</tr>';
    });
    tab.innerHTML = h + '</tbody>';
    tab.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => afficherOption(+tr.dataset.i)));
  }
  $('r-prec').addEventListener('click', () => { if (etat.vue > 0) afficherOption(etat.vue - 1); });
  $('r-suiv').addEventListener('click', () => { if (etat.vue < etat.options.length - 1) afficherOption(etat.vue + 1); });
  $('p-branche').addEventListener('change', () => { etat.finOptions = false; majOptions(); });

  function exclusionsPour(b) {
    etat.varianteDemandee = b < 0 ? 'Tout le circuit' : $('p-branche').selectedOptions[0].textContent;
    return etat.options.filter(o => o.ok).map(o => ({
      pts: b < 0 ? pointsTrajet(o) : (pointsParBranche(o)[b] || []), rayonKm: 6, protegeKm: 8, branche: b,
    })).filter(e => e.pts.length > 1);
  }
  function calculer(mode) {
    if (!etat.D || etat.charge !== etat.D.id || etat.calcul) return;
    etat.calcul = true; etat.mode = mode;
    $('p-calculer').disabled = true; $('p-autre').disabled = true; $('p-igc').disabled = true;
    (mode === 'nouveau' ? $('p-calculer') : $('p-autre')).textContent = 'Calcul en cours…';
    etatTexte(mode === 'nouveau' ? 'Calcul…' : 'Recherche d\'un autre itinéraire…');
    worker.postMessage({
      type: 'calculer',
      zones: etat.zones,
      exclusions: mode === 'autre' ? exclusionsPour(+$('p-branche').value) : [],
      P: {
        margeSol: +$('p-marge').value, mc: +$('p-mc').value, efficacite: +$('p-eff').value, rayon: +$('p-rayon').value,
        vzMin: 1.0, vzFond: 1.5, couloir: 15, portee: 20,
        parcs: $('p-sansparcs').checked ? [] : etat.parcs, couloirs: etat.couloirs,
        ballast: $('p-ballast').checked ? 1.18 : 1,
        ia: $('p-ia').checked && etat.ia ? etat.ia : null,
        ventDir: +$('p-vdir').value, ventKmh: +$('p-vkmh').value,
        poidsCretes: +$('p-cretes').value, effPente: +$('p-pente').value, sousVent: +$('p-svent').value,
      },
    });
  }
  function finCalcul() {
    etat.calcul = false; $('p-calculer').disabled = false; $('p-calculer').textContent = 'Calculer le trajet optimal';
    majOptions();
  }
  function etatTexte(t, erreur) { $('p-etat').textContent = t; $('p-etat').classList.toggle('erreur', !!erreur); }

  // ----- dessin de la carte
  const VIOLET = () => css('--circuit') || '#7048e8';
  function cercleLatLon(t) { return L.circle([t.lat, t.lon], { radius: t.rayon, color: VIOLET(), weight: 1.5, fill: false, interactive: false }); }
  function dessinerCircuit() {
    calques.circuit.clearLayers();
    const T = etat.D.tache;
    L.polyline(T.map(t => [t.lat, t.lon]), { color: VIOLET(), weight: 2, dashArray: '6 6', interactive: false }).addTo(calques.circuit);
    T.forEach(t => {
      cercleLatLon(t).addTo(calques.circuit);
      L.circleMarker([t.lat, t.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: VIOLET(), fillOpacity: 1 })
        .bindTooltip(t.nom, { permanent: true, direction: 'right', className: 'etq-point', offset: [6, 0] })
        .addTo(calques.circuit);
    });
  }
  function couleurPlafond(p) {     // rose pâle (bas) -> rouge (haut), comme XC Therm
    const f = Math.max(0, Math.min(1, (p - 1500) / 2500));
    return `hsl(${Math.round(8 - 6 * f)}, ${Math.round(45 + 35 * f)}%, ${Math.round(80 - 32 * f)}%)`;
  }
  function dessinerZones() {
    calques.zones.clearLayers(); calques.zonesFond.clearLayers();
    etat.zones.forEach(z => {
      const sel = z.id === etat.sel;
      L.polygon(z.poly, {
        renderer: rendZones, pane: 'zonesVol', interactive: false,
        color: sel ? '#1f6feb' : '#5a4a4a', weight: sel ? 3 : 1, opacity: sel ? 1 : 0.45,
        fillColor: couleurPlafond(z.plafond), fillOpacity: 0.3,
      }).addTo(calques.zonesFond);
      L.marker([z.lat, z.lon], {
        icon: L.divIcon({ className: 'etq-zone' + (sel ? ' sel' : '') + (z.corrige ? ' corrige' : ''), html: `<span><b>${z.plafond}</b><small>${z.vzMax.toFixed(1)} m/s</small></span>`, iconSize: null, iconAnchor: [0, 0] }),
        interactive: false, keyboard: false,
      }).addTo(calques.zones);
    });
  }
  function couleurVz(vz, vmax) {
    const f = Math.max(0, Math.min(1, (vz - 1) / Math.max(0.5, vmax - 1)));
    return `hsl(${Math.round(55 - 55 * f)}, 95%, ${Math.round(55 - 8 * f)}%)`;   // jaune -> rouge
  }
  function dessinerThermiquesBruts() {   // avant calcul : kk7 colorés par intensité
    calques.thermiques.clearLayers();
    const r = L.canvas({ padding: 0.3 });
    const pmax = Math.max(...etat.D.kk7.map(t => t[2]));
    etat.D.kk7.forEach(([la, lo, p]) => L.circleMarker([la, lo], { renderer: r, radius: 3, stroke: false, fillColor: couleurVz(1 + 3 * p / pmax, 4), fillOpacity: 0.75, interactive: false }).addTo(calques.thermiques));
  }
  function dessinerThermiques(th) {
    calques.thermiques.clearLayers();
    const r = L.canvas({ padding: 0.3 });
    const vmax = Math.max(...th.map(t => t[2]));
    th.slice().sort((a, b) => a[2] - b[2]).forEach(([la, lo, vz, src]) => {
      if (src === 2) L.circleMarker([la, lo], { renderer: r, radius: 4, color: '#555', weight: 1, fill: false, interactive: false }).addTo(calques.thermiques);
      else L.circleMarker([la, lo], { renderer: r, radius: 3, stroke: false, fillColor: couleurVz(vz, vmax), fillOpacity: 0.75, interactive: false }).addTo(calques.thermiques);
    });
  }
  function dessinerTrajets() {
    calques.trajet.clearLayers();
    // les autres options d'abord, en pointillés de leur couleur
    etat.options.forEach((o, i) => {
      if (i === etat.vue || !o.ok) return;
      const p = pointsTrajet(o);
      L.polyline(p, { color: COULEURS[i], weight: 2.5, opacity: 0.8, dashArray: '7 6', interactive: false }).addTo(calques.trajet);
      const m = p[Math.floor(p.length / 2)];
      L.marker(m, { icon: L.divIcon({ className: 'etq-option', html: `<span style="background:${COULEURS[i]}">${LETTRES[i]}</span>`, iconSize: null }), interactive: false }).addTo(calques.trajet);
    });
    const r = etat.options[etat.vue];
    if (!r || !r.ok) return;
    const pts = pointsTrajet(r), coul = COULEURS[etat.vue];
    L.polyline(pts, { color: '#fff', weight: 6, opacity: 0.9, interactive: false }).addTo(calques.trajet);
    L.polyline(pts, { color: coul, weight: 2.5, interactive: false }).addTo(calques.trajet);
    r.etapes.forEach(e => {
      if (e.type === 'T' && !e.valide && !e.passage && e.gain > 0.5) {
        L.circleMarker([e.lat2, e.lon2], { radius: 2.5, color: coul, weight: 0, fillColor: coul, fillOpacity: 1 })
          .bindTooltip(`Traversé sans spiraler · +${Math.round(e.gain)} m`).addTo(calques.trajet);
      }
    });
    r.etapes.filter(e => e.type === 'M').forEach(e => {
      const vzm = (e.h2 - e.h1) / e.duree;
      L.circleMarker([e.lat1, e.lon1], { radius: 8, color: '#d00', weight: 3, fill: false })
        .bindTooltip(`+${vzm.toFixed(1)} m/s<br>${Math.round(e.h1)} → ${Math.round(e.h2)} m`, { permanent: true, direction: 'left', className: 'etq-spirale', offset: [-8, 0] })
        .addTo(calques.trajet);
    });
  }

  // ----- résultat
  const hms = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
  function viderResultat() {
    $('r-temps').textContent = '—'; $('r-vitesse').textContent = ''; $('r-detail').textContent = '';
    $('r-branches').innerHTML = ''; calques.trajet.clearLayers(); dessinerProfil(null);
  }
  function afficherResultat(r) {
    if (!r.ok) {
      viderResultat();
      $('r-temps').textContent = 'Impossible';
      $('r-detail').textContent = 'Aucun trajet ne passe avec ces réglages : remonte le plafond sur les reliefs (ou corrige la zone d’un col haut), ou baisse la marge.';
      etatTexte(`Calcul fait en ${r.dureeCalcul.toFixed(1)} s — aucun trajet possible.`, true);
      return;
    }
    const E = r.etapes, mo = E.filter(e => e.type === 'M');
    const tSpi = mo.reduce((a, e) => a + e.duree, 0), gSpi = mo.reduce((a, e) => a + e.h2 - e.h1, 0);
    $('r-temps').textContent = hms(r.tempsTotal);
    $('r-vitesse').textContent = `${(r.distanceCircuit / (r.tempsTotal / 3600)).toFixed(1)} km/h · ${r.distanceCircuit.toFixed(1)} km`;
    $('r-detail').textContent = (r.couloirElargi ? 'Couloir élargi à 25 km pour trouver un passage · ' : '') + `Spirale ${Math.round(100 * tSpi / r.tempsTotal)} % du temps (${mo.length} spirales, ${(gSpi / Math.max(1, tSpi)).toFixed(1)} m/s) · cheminement +${Math.round(E.reduce((a, e) => a + e.gain, 0))} m · ${E.filter(e => e.passage).length} contournements · ${Math.round(r.hauteurMini)} m mini au-dessus du sol`;
    // tableau par branche
    const T = etat.D.tache, n = T.length - 1, br = tempsBranches(r);
    let html = '<thead><tr><th>Jusqu\'à</th><th>km</th><th>Temps</th><th>km/h</th><th>Spirale</th><th>Chem.</th><th>Alt.</th></tr></thead><tbody>';
    for (let i = 0; i < Math.min(n, br.length); i++) {
      const d = distKm(T[i], T[i + 1]), x = br[i];
      html += `<tr><td>${T[i + 1].nom.replace(/^(Départ|Arrivée) /, '')}</td><td>${d.toFixed(1)}</td><td>${hms(x.t)}</td><td>${Math.round(d / (x.t / 3600))}</td><td>${Math.round(100 * x.spi / x.t)} %</td><td>+${Math.round(x.gain)}</td><td>${Math.round(x.h)}</td></tr>`;
    }
    $('r-branches').innerHTML = html + '</tbody>';
    dessinerProfil(r);
    $('p-igc').disabled = false;
    etatTexte(`Calcul fait en ${r.dureeCalcul.toFixed(1)} s (${r.nbPoints.toLocaleString('fr-FR')} points, dont ${r.nbPassage} de contournement).`);
  }
  function distKm(a, b) {
    const k = Math.PI / 180, dLa = (b.lat - a.lat) * k, dLo = (b.lon - a.lon) * k;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  // ----- profil
  function dessinerProfil(r, iCurseur) {
    const cv = $('p-profil'), box = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(10, box.width * dpr); cv.height = Math.max(10, box.height * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = box.width, H = box.height; g.clearRect(0, 0, W, H);
    if (!r || !r.ok) return;
    const tr = r.trace, n = tr.dist.length;
    const ml = 44, mr = 10, mt = 10, mb = 24;
    let x0 = Infinity, x1 = -Infinity; for (let i = 0; i < n; i++) { x0 = Math.min(x0, tr.dist[i]); x1 = Math.max(x1, tr.dist[i]); }
    const iDep = tr.t.findIndex(t => t >= tr.heureDepart); const dDep = tr.dist[Math.max(0, iDep)];
    let yMax = 0; for (let i = 0; i < n; i++) yMax = Math.max(yMax, tr.alt[i], tr.plafond[i], tr.sol[i]);
    yMax = Math.ceil((yMax + 200) / 500) * 500;
    const X = d => ml + (d - x0) / (x1 - x0) * (W - ml - mr), Y = a => mt + (1 - a / yMax) * (H - mt - mb);
    etat.profilGeo = { ml, mr, W, x0, x1, dDep };
    g.font = '11px system-ui, sans-serif'; g.fillStyle = css('--texte-2'); g.strokeStyle = css('--grille'); g.lineWidth = 1;
    for (let a = 0; a <= yMax; a += 500) { g.beginPath(); g.moveTo(ml, Y(a)); g.lineTo(W - mr, Y(a)); g.stroke(); g.fillText(a, 4, Y(a) + 4); }
    const pasKm = (x1 - x0) > 200 ? 50 : 25;
    for (let d = Math.ceil((x0 - dDep) / pasKm) * pasKm; d + dDep <= x1; d += pasKm) g.fillText(`${d} km`, X(d + dDep) - 12, H - 6);
    // sol
    g.beginPath(); g.moveTo(X(tr.dist[0]), Y(0));
    for (let i = 0; i < n; i++) g.lineTo(X(tr.dist[i]), Y(tr.sol[i]));
    g.lineTo(X(tr.dist[n - 1]), Y(0)); g.closePath(); g.fillStyle = 'rgba(158,128,97,.65)'; g.fill();
    // plafond
    g.setLineDash([6, 4]); g.strokeStyle = '#2f6fd0'; g.beginPath();
    for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, X(tr.dist[i]), Y(tr.plafond[i])); g.stroke(); g.setLineDash([]);
    // trajet + spirales
    g.lineWidth = 1.6; g.strokeStyle = css('--texte'); g.beginPath();
    for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, X(tr.dist[i]), Y(tr.alt[i])); g.stroke();
    g.lineWidth = 2.6; g.strokeStyle = '#d00'; g.beginPath();
    for (let i = 1; i < n; i++) if (tr.spirale[i]) { g.moveTo(X(tr.dist[i - 1]), Y(tr.alt[i - 1])); g.lineTo(X(tr.dist[i]), Y(tr.alt[i])); }
    g.stroke();
    // légende
    const leg = 'trajet noir · spirales rouges · plafond bleu · sol marron', lw = g.measureText(leg).width + 10;
    g.fillStyle = css('--surface'); g.globalAlpha = 0.85; g.fillRect(W - mr - lw, H - mb - 20, lw, 16); g.globalAlpha = 1;
    g.fillStyle = css('--texte-2'); g.fillText(leg, W - mr - lw + 5, H - mb - 8);
    // curseur (souris sur le profil)
    if (iCurseur != null && iCurseur >= 0 && iCurseur < n) {
      const i = iCurseur, x = X(tr.dist[i]);
      g.strokeStyle = css('--accent') || '#1f6feb'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, mt); g.lineTo(x, H - mb); g.stroke(); g.setLineDash([]);
      g.fillStyle = css('--accent') || '#1f6feb'; g.beginPath(); g.arc(x, Y(tr.alt[i]), 4, 0, 2 * Math.PI); g.fill();
      const txt = `${Math.round(tr.dist[i] - dDep)} km · ${hms(Math.max(0, tr.t[i] - tr.heureDepart))} · ${Math.round(tr.alt[i])} m · sol ${Math.round(tr.sol[i])} m${tr.spirale[i] ? ' · spirale' : ''}`;
      const tw = g.measureText(txt).width + 10, tx = Math.min(Math.max(ml, x - tw / 2), W - mr - tw);
      g.fillStyle = css('--surface'); g.globalAlpha = 0.92; g.fillRect(tx, mt, tw, 17); g.globalAlpha = 1;
      g.fillStyle = css('--texte'); g.fillText(txt, tx + 5, mt + 12);
    }
  }
  window.addEventListener('resize', () => dessinerProfil(etat.resultat));

  // Souris sur le profil : le point correspondant suit sur la carte
  const curseurCarte = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2.5, fillColor: '#1f6feb', fillOpacity: 1, interactive: false });
  function indiceProfil(clientX) {
    const r = etat.resultat, G = etat.profilGeo;
    if (!r || !r.ok || !G) return -1;
    const box = $('p-profil').getBoundingClientRect();
    const d = G.x0 + (clientX - box.left - G.ml) / (G.W - G.ml - G.mr) * (G.x1 - G.x0);
    const D = r.trace.dist; let lo = 0, hi = D.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (D[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }
  function survolProfil(e) {
    const i = indiceProfil(e.clientX); if (i < 0) return;
    const tr = etat.resultat.trace;
    dessinerProfil(etat.resultat, i);
    curseurCarte.setLatLng([tr.lat[i], tr.lon[i]]);
    if (!carte.hasLayer(curseurCarte)) curseurCarte.addTo(carte);
    if (etat.suivreProfil && !carte.getBounds().pad(-0.2).contains(curseurCarte.getLatLng())) carte.panTo(curseurCarte.getLatLng(), { animate: false });
  }
  const zoneProfil = $('p-profil');
  zoneProfil.addEventListener('pointermove', survolProfil);
  zoneProfil.addEventListener('pointerdown', (e) => { etat.suivreProfil = true; survolProfil(e); });   // clic / doigt : la carte suit
  zoneProfil.addEventListener('pointerleave', () => {
    etat.suivreProfil = false;
    if (carte.hasLayer(curseurCarte)) carte.removeLayer(curseurCarte);
    dessinerProfil(etat.resultat);
  });

  // ----- export IGC
  function telechargerIGC() {
    const r = etat.resultat; if (!r || !r.ok) return;
    const D = etat.D, T = D.tache, tr = r.trace, lignes = [];
    const now = new Date(), dd = `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCFullYear() % 100).padStart(2, '0')}`;
    const hhmmss = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
    const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
    const coord = (x, deg, pos, neg) => {
      const a = Math.abs(x); let d = Math.floor(a), m = Math.round((a - d) * 60000); if (m >= 60000) { d++; m -= 60000; }
      return String(d).padStart(deg, '0') + String(m).padStart(5, '0') + (x >= 0 ? pos : neg);
    };
    const lat = (x) => coord(x, 2, 'N', 'S'), lon = (x) => coord(x, 3, 'E', 'W');
    lignes.push('AXSPSPIRALE', `HFDTEDATE:${dd},01`, `HFPLTPILOTINCHARGE:Spirale option ${LETTRES[etat.vue]}`, 'HFGTYGLIDERTYPE:Diana 2',
      'HFGIDGLIDERID:OPTIMAL', 'HFDTMGPSDATUM:WGS84', 'HFFTYFRTYPE:Spirale web');
    lignes.push(`C${dd}${hhmmss}${dd}0001${String(T.length - 2).padStart(2, '0')}Trajet optimal`);
    lignes.push(`C${lat(T[0].lat)}${lon(T[0].lon)}Takeoff`);
    T.forEach(t => lignes.push(`C${lat(t.lat)}${lon(t.lon)}${ascii(t.nom)}`));
    lignes.push(`C${lat(T[T.length - 1].lat)}${lon(T[T.length - 1].lon)}Landing`);
    T.forEach((t, k) => {
      let z;
      if (t.forme === 'ligne') z = `Style=2,R1=${t.rayon}m,A1=90,Line=1`;
      else if (t.forme === 'secteur') z = `Style=${k === 0 ? 2 : k === T.length - 1 ? 3 : 1},R1=${t.rayon}m,A1=${t.angle > 0 ? t.angle / 2 : 90}`;
      else z = `Style=1,R1=${t.rayon}m,A1=180`;
      lignes.push(`LSEEYOU OZ=${k - 1},${z}`);
    });
    let dernier = -1;
    for (let i = 0; i < tr.t.length; i++) {
      const s = Math.round(tr.t[i]); if (s <= dernier) continue; dernier = s;
      const j = ((s % 86400) + 86400) % 86400, a = String(Math.max(0, Math.round(tr.alt[i]))).padStart(5, '0');
      lignes.push(`B${String(Math.floor(j / 3600)).padStart(2, '0')}${String(Math.floor(j % 3600 / 60)).padStart(2, '0')}${String(j % 60).padStart(2, '0')}${lat(tr.lat[i])}${lon(tr.lon[i])}A${a}${a}`);
    }
    const blob = new Blob([lignes.join('\r\n') + '\r\n'], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${D.id}_option${LETTRES[etat.vue]}.igc`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  chargerCircuit(CIRCUITS[0].id);
})();
