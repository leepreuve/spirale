// Spirale — Préparation V1.2 : trajet optimal d'un circuit (interface)
// Le calcul tourne dans prep-calcul.js (Web Worker) pour ne pas figer la page.
(() => {
  'use strict';

  const CIRCUITS = [
    { id: 'tache_greoux_saintauban', titre: 'Gréoux → Saint-Auban' },
    { id: 'tache_versoud_barcelonnette', titre: 'Le Versoud → Barcelonnette' },
    { id: 'tache_stjean_challes', titre: 'St Jean → Challes' },
    { id: 'test_stcrepin_saintauban', titre: 'St Crépin → Saint-Auban' },
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
  const etat = { D: null, zonesBase: [], zones: [], corrections: {}, sel: null, charge: null, resultat: null, calcul: false };

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

  // ----- réglages
  CIRCUITS.forEach(c => $('p-circuit').add(new Option(c.titre, c.id)));
  const lire = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
  const regl = lire('spirale-prep-reglages', {});
  const curseurs = {
    marge: ['p-marge', 'o-marge', v => `${v} m`],
    mc: ['p-mc', 'o-mc', v => `${(+v).toFixed(1)} m/s`],
    eff: ['p-eff', 'o-eff', v => `${Math.round(v * 100)} %`],
    rayon: ['p-rayon', 'o-rayon', v => `${v} m`],
    pmax: ['p-pmax', 'o-pmax', v => `${v} m`],
    pmin: ['p-pmin', 'o-pmin', v => `${v} m`],
    vz: ['p-vz', 'o-vz', v => `${(+v).toFixed(1)} m/s`],
  };
  for (const [cle, [idIn, idOut, fmt]] of Object.entries(curseurs)) {
    if (regl[cle] != null) $(idIn).value = regl[cle];
    const maj = () => { $(idOut).textContent = fmt($(idIn).value); regl[cle] = +$(idIn).value; ecrire('spirale-prep-reglages', regl); };
    $(idIn).addEventListener('input', maj); maj();
    if (['pmax', 'pmin', 'vz'].includes(cle)) $(idIn).addEventListener('input', () => { majZones(); });
  }
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
  $('p-calculer').addEventListener('click', calculer);
  $('p-igc').addEventListener('click', telechargerIGC);

  // ----- chargement d'un circuit
  async function chargerCircuit(id) {
    etatTexte('Chargement du circuit…');
    $('p-calculer').disabled = true; $('p-igc').disabled = true;
    etat.resultat = null; viderResultat();
    try {
      const [D, relief] = await Promise.all([
        fetch(`prep/${id}/donnees.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch(`prep/${id}/relief.bin`).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
      ]);
      etat.D = D;
      etat.zonesBase = genererZonesVol(D, relief);
      etat.corrections = lire('spirale-prep-corr-' + id, {}) || {};
      etat.sel = null;
      majZones();
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
      if (!etat.premierCalcul) { etat.premierCalcul = true; calculer(); }
    } else if (m.type === 'progression') {
      etatTexte(m.texte);
    } else if (m.type === 'resultat') {
      finCalcul(); etat.resultat = m.r; afficherResultat(m.r);
    } else if (m.type === 'erreur') {
      finCalcul(); etatTexte('Erreur de calcul : ' + m.message.split('\n')[0], true); console.error(m.message);
    }
  };

  function calculer() {
    if (!etat.D || etat.charge !== etat.D.id || etat.calcul) return;
    etat.calcul = true;
    $('p-calculer').disabled = true; $('p-calculer').textContent = 'Calcul en cours…'; $('p-igc').disabled = true;
    etatTexte('Calcul…');
    worker.postMessage({
      type: 'calculer',
      zones: etat.zones,
      P: {
        margeSol: +$('p-marge').value, mc: +$('p-mc').value, efficacite: +$('p-eff').value, rayon: +$('p-rayon').value,
        vzMin: 1.0, vzFond: 1.5, couloir: 15, portee: 20,
      },
    });
  }
  function finCalcul() {
    etat.calcul = false; $('p-calculer').disabled = false; $('p-calculer').textContent = 'Calculer le trajet optimal';
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
  function dessinerTrajet(r) {
    calques.trajet.clearLayers();
    if (!r.ok) return;
    const pts = [[r.etapes[0].lat1, r.etapes[0].lon1]];
    r.etapes.forEach(e => { if (e.type === 'T') pts.push([e.lat2, e.lon2]); });
    L.polyline(pts, { color: '#fff', weight: 6, opacity: 0.9, interactive: false }).addTo(calques.trajet);
    L.polyline(pts, { color: '#111', weight: 2.5, interactive: false }).addTo(calques.trajet);
    r.etapes.forEach(e => {
      if (e.type === 'T' && !e.valide && !e.passage && e.gain > 0.5) {
        L.circleMarker([e.lat2, e.lon2], { radius: 2.5, color: '#111', weight: 0, fillColor: '#111', fillOpacity: 1 })
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
    dessinerThermiques(r.thermiques);
    dessinerTrajet(r);
    if (!r.ok) {
      viderResultat(); dessinerThermiques(r.thermiques);
      $('r-temps').textContent = 'Impossible';
      $('r-detail').textContent = 'Aucun trajet ne passe avec ces réglages : remonte le plafond sur les reliefs (ou corrige la zone d’un col haut), ou baisse la marge.';
      etatTexte(`Calcul fait en ${r.dureeCalcul.toFixed(1)} s — aucun trajet possible.`, true);
      return;
    }
    const E = r.etapes, mo = E.filter(e => e.type === 'M');
    const tSpi = mo.reduce((a, e) => a + e.duree, 0), gSpi = mo.reduce((a, e) => a + e.h2 - e.h1, 0);
    $('r-temps').textContent = hms(r.tempsTotal);
    $('r-vitesse').textContent = `${(r.distanceCircuit / (r.tempsTotal / 3600)).toFixed(1)} km/h · ${r.distanceCircuit.toFixed(1)} km`;
    $('r-detail').textContent = `Spirale ${Math.round(100 * tSpi / r.tempsTotal)} % du temps (${mo.length} spirales, ${(gSpi / Math.max(1, tSpi)).toFixed(1)} m/s) · cheminement +${Math.round(E.reduce((a, e) => a + e.gain, 0))} m · ${E.filter(e => e.passage).length} contournements · ${Math.round(r.hauteurMini)} m mini au-dessus du sol`;
    // tableau par branche
    const T = etat.D.tache, n = T.length - 1, br = [];
    let tc = 0;
    const acc = () => ({ t: 0, spi: 0, gain: 0, h: null });
    let cur = acc();
    for (const e of E) {
      cur.t += e.duree; tc += e.duree; if (e.type === 'M') cur.spi += e.duree; cur.gain += e.gain;
      if (e.valide) { cur.h = e.h2; cur.fin = tc; br.push(cur); cur = acc(); }
    }
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
  function dessinerProfil(r) {
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
  }
  window.addEventListener('resize', () => dessinerProfil(etat.resultat));

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
    lignes.push('AXSPSPIRALE', `HFDTEDATE:${dd},01`, 'HFPLTPILOTINCHARGE:Spirale trajet optimal', 'HFGTYGLIDERTYPE:Diana 2',
      'HFGIDGLIDERID:OPTIMAL', 'HFDTMGPSDATUM:WGS84', 'HFFTYFRTYPE:Spirale web V1.2');
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
    a.href = URL.createObjectURL(blob); a.download = `${D.id}_optimal.igc`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  chargerCircuit(CIRCUITS[0].id);
})();
