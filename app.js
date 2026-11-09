/* =====================================================================
   app.js — Interface : carte, frise (barogramme + lecture), panneau Duel
   S'appuie sur analyse.js (objet global IGC), Leaflet et Chart.js.
   Un seul curseur de temps (etat.t, en heure du vol A) pilote tout.
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const etat = {
    vols: [],               // { id, nom, vol (lu), largage (indice ou null), analyse, circ }
    idA: null, idB: null,
    circuit: [],            // zones déclarées (IGC)
    typeCircuit: 'CT', typeForce: false,
    tempsMini: 0,
    alignement: 'course',   // 'course' (départs alignés) | 'reel'
    mc: null,
    comp: null, compErreur: null,
    decalB: 0,              // heure A = heure B + decalB
    t: null,                // curseur (heure du vol A, s depuis minuit UTC)
    tMin: 0, tMax: 0,
    vitesse: 30, lecture: false, dernierFrame: 0,
    filtre: 'tout',
    etiquettes: { circuit: true, montees: true, transitions: true },
    suivre: false,
    etapes: [], etape: 0,
    uniteParcours: 'temps',
    carte: null, couches: {}, planeurs: {},
    baro: null, grapheParcours: null, redessin: false
  };

  // ----- Formatage ---------------------------------------------------
  const nf = (x, d = 0) => (x == null || !isFinite(x)) ? '—'
    : x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const signe = (x, d = 1) => (x == null || !isFinite(x)) ? '—' : (x > 0 ? '+' : '') + nf(x, d);
  const p2 = (n) => String(n).padStart(2, '0');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const echapper = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtDuree(s) {
    s = Math.round(Math.abs(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (h) return `${h} h ${p2(m)}`;
    if (m) return `${m} min ${p2(sec)}`;
    return `${sec} s`;
  }
  function fmtChrono(s) {
    s = Math.round(Math.abs(s));
    return `${Math.floor(s / 3600)}:${p2(Math.floor(s % 3600 / 60))}:${p2(s % 60)}`;
  }
  function fmtHeure(t, avecSec) {
    const s = ((Math.round(t) % 86400) + 86400) % 86400;
    // Heure locale de Paris si la date est connue, sinon UTC
    const A = volA();
    if (A && A.analyse.date) {
      const d = A.analyse.date;
      return new Date(Date.UTC(d.y, d.m - 1, d.d) + s * 1000).toLocaleTimeString('fr-FR',
        avecSec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    }
    return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s % 3600 / 60)) + (avecSec ? ':' + p2(s % 60) : '');
  }
  const fmtFinesse = (f) => (f === Infinity || f > 200) ? '> 200' : (f == null || !isFinite(f)) ? '—' : nf(f, f < 100 ? 1 : 0);
  const fmtDist = (m) => Math.abs(m) < 1000 ? `${nf(m)} m` : `${nf(m / 1000, 1)} km`;
  const alpha = (hex, a) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };
  function indice(T, t) {
    if (t <= T[0]) return 0;
    if (t >= T[T.length - 1]) return T.length - 1;
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    return (t - T[lo] < T[hi] - t) ? lo : hi;
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.m);
    toast.m = setTimeout(() => { el.hidden = true; }, 6000);
  }

  // ----- Version du site ----------------------------------------------
  (function afficherVersion() {
    const v = window.SPIRALE_VERSION;
    if (!v) return;
    const d = new Date(v.date);
    const txt = `Version ${v.numero} · mise à jour le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    document.querySelectorAll('[data-version]').forEach(el => { el.textContent = txt; });
    etat.texteVersion = txt;
  })();

  // ----- Couleurs ------------------------------------------------------
  const couleurPhase = (p) => ({ T: css('--thermique'), G: css('--transition') }[p] || css('--remorque'));
  const NOM_PHASE = { R: 'remorqué', T: 'montée', G: 'transition', S: 'au sol' };

  // ===================================================================
  // Vols
  // ===================================================================
  let compteurId = 0;
  const volA = () => etat.vols.find(v => v.id === etat.idA) || null;
  const volB = () => (etat.idB != null ? etat.vols.find(v => v.id === etat.idB) : null) || null;
  const nomVol = (v) => (v.analyse.entete.pilote || v.analyse.entete.concours || v.nom.replace(/\.igc$/i, '') || '?');
  const nomCourt = (v) => {
    const n = nomVol(v).trim().split(/\s+/);
    return n.length > 1 ? n[n.length - 1] : n[0];
  };
  const codeVol = (v) => v.analyse.entete.concours || nomVol(v).split(/\s+/).map(x => x[0]).join('').slice(0, 3).toUpperCase();

  function ajouterVol(texte, nom) {
    let vol;
    try {
      vol = IGC.lire(texte);
    } catch (e) {
      toast(`${nom} : ${e.message}`);
      return null;
    }
    const v = { id: ++compteurId, nom, vol, largage: null };
    analyserVol(v);
    etat.vols.push(v);
    return v;
  }
  function analyserVol(v) {
    v.analyse = IGC.analyser(v.vol, v.largage != null ? { largage: v.largage } : null);
  }

  function lireFichiers(liste) {
    const fichiers = [...(liste || [])].filter(f => f && /\.igc$/i.test(f.name));
    if (!fichiers.length) { toast('Choisissez des fichiers .igc.'); return; }
    const resultats = new Array(fichiers.length);
    let restants = fichiers.length;
    fichiers.forEach((f, k) => {
      const r = new FileReader();
      r.onload = () => { resultats[k] = [r.result, f.name]; fin(); };
      r.onerror = () => { toast(`Impossible de lire ${f.name}.`); fin(); };
      r.readAsText(f);
    });
    function fin() {
      if (--restants > 0) return;
      const ajoutes = resultats.filter(Boolean).map(([t, n]) => ajouterVol(t, n)).filter(Boolean);
      apresAjout(ajoutes);
    }
  }

  function apresAjout(ajoutes) {
    if (!ajoutes.length) return;
    const premier = etat.idA == null;
    if (premier) etat.idA = ajoutes[0].id;
    if (etat.idB == null) {
      const autre = etat.vols.find(v => v.id !== etat.idA);
      if (autre) etat.idB = autre.id;
    }
    toutAfficher(true);
  }

  // ===================================================================
  // Circuit, calculs
  // ===================================================================
  function rayonDefaut(k, n, type) {
    if (k === 0) return 5000;
    if (k === n - 1) return 3000;
    return type === 'AAT' ? 20000 : 500;
  }

  function choisirCircuit() {
    const A = volA(), B = volB();
    const source = (A && A.analyse.circuitIGC.length >= 2) ? A : (B && B.analyse.circuitIGC.length >= 2) ? B : null;
    etat.circuit = source ? source.analyse.circuitIGC.map(p => Object.assign({}, p)) : [];
    etat.tempsMini = source && source.analyse.tempsCircuitIGC ? source.analyse.tempsCircuitIGC : 0;
    if (!etat.typeForce) {
      const large = etat.circuit.slice(1, -1).some(p => p.rayon != null && p.rayon >= 5000);
      etat.typeCircuit = etat.tempsMini || large ? 'AAT' : 'CT';
    }
  }

  function zones() {
    const n = etat.circuit.length;
    return etat.circuit.map((p, k) => ({
      lat: p.lat, lon: p.lon,
      nom: p.nom || (k === 0 ? 'Départ' : k === n - 1 ? 'Arrivée' : 'P' + k),
      rayon: p.rayon != null ? p.rayon : rayonDefaut(k, n, etat.typeCircuit),
      forme: p.forme, demiAngle: p.demiAngle, rayon2: p.rayon2, demiAngle2: p.demiAngle2, style: p.style, a12: p.a12
    }));
  }
  const nomPoint = (k, n) => (k === 0 ? 'D' : k === n - 1 ? 'A' : 'P' + k);

  function departDe(v) {
    return v.circ && v.circ.nbAtteints ? v.circ.tDepart : v.analyse.t[v.analyse.largage];
  }

  function calculer() {
    const A = volA(), B = volB();
    const Z = zones();
    for (const v of [A, B]) {
      if (v) v.circ = Z.length >= 2 ? IGC.analyserCircuit(v.analyse, Z, etat.typeCircuit, { tempsMini: etat.tempsMini }) : null;
    }
    etat.comp = null;
    etat.compErreur = null;
    etat.decalB = 0;
    if (!B) return;
    if (etat.alignement === 'course') etat.decalB = departDe(A) - departDe(B);
    if (etat.mc == null) {
      const vz = [A.analyse.totaux.vzMoyThermique, B.analyse.totaux.vzMoyThermique].filter(x => x > 0);
      etat.mc = vz.length ? Math.round(vz.reduce((s, x) => s + x, 0) / vz.length * 10) / 10 : 1.5;
    }
    if (!A.circ || !B.circ) {
      etat.compErreur = 'Aucun circuit déclaré dans ces fichiers : le duel compare seulement les altitudes et les positions.';
      return;
    }
    const r = IGC.comparerVols({ a: A.analyse, circ: A.circ }, { a: B.analyse, circ: B.circ },
      { mc: etat.mc, alignement: etat.alignement });
    if (r.erreur) etat.compErreur = r.erreur;
    else etat.comp = r;
  }

  // ===================================================================
  // Affichage général
  // ===================================================================
  function toutAfficher(recadrer) {
    const A = volA();
    if (!A) return;
    arreterLecture();
    $('#accueil').hidden = true;
    $('#espace').hidden = false;
    $('#selecteurs').hidden = false;
    choisirCircuit();
    calculer();
    remplirSelecteurs();
    afficherEntete();
    initCarte();
    construireEtapes();
    dessinerCarte(recadrer);
    afficherBarogramme();
    afficherLateral();
    const B = volB();
    etat.tMin = A.analyse.t[A.analyse.deco] - 30;
    etat.tMax = A.analyse.t[A.analyse.atterro] + 30;
    if (B) {
      etat.tMin = Math.min(etat.tMin, B.analyse.t[B.analyse.deco] + etat.decalB - 30);
      etat.tMax = Math.max(etat.tMax, B.analyse.t[B.analyse.atterro] + etat.decalB + 30);
    }
    if (etat.t == null || recadrer) etat.t = departDe(A);
    majCurseur();
    if (etat.carte) setTimeout(() => etat.carte.invalidateSize(), 0);
  }

  function remplirSelecteurs() {
    const opt = (v, sel, prefixe) => {
      const d = v.analyse.date;
      const date = d ? new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : v.nom;
      return `<option value="${v.id}"${sel ? ' selected' : ''}>${prefixe || ''}${echapper(date)} · ${echapper(nomVol(v))}${v.analyse.entete.concours ? ' (' + echapper(v.analyse.entete.concours) + ')' : ''}</option>`;
    };
    $('#choix-a').innerHTML = etat.vols.map(v => opt(v, v.id === etat.idA)).join('');
    const autres = etat.vols.filter(v => v.id !== etat.idA);
    $('#choix-b').innerHTML = `<option value="">Pas de duel</option>` +
      autres.map(v => opt(v, v.id === etat.idB, 'Duel : ')).join('');
    $('#choix-b').disabled = !autres.length;
  }

  function afficherEntete() {
    const A = volA(), a = A.analyse, e = a.entete;
    const d = a.date ? new Date(Date.UTC(a.date.y, a.date.m - 1, a.date.d)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
    const libre = a.departEnVol ? 'départ en vol' : a.largageAuto ? 'auto' : 'manuel';
    const items = [
      d && `<b>${echapper(d)}</b>`,
      `<b>${echapper(nomVol(A))}</b>`,
      [e.planeur, e.immat].filter(Boolean).map(echapper).join(' · '),
      `Décollage <b>${fmtHeure(a.t[a.deco])}</b>`,
      `Vol libre dès <b>${fmtHeure(a.t[a.largage])}</b> · ${nf(a.alt[a.largage])} m (${libre})`,
      `Atterrissage <b>${fmtHeure(a.t[a.atterro])}</b>`
    ].filter(Boolean);
    $('#entete-vol').innerHTML = items.map(x => `<span>${x}</span>`).join('');
    document.title = `${nomVol(A)} — Spirale`;
  }

  // ===================================================================
  // Carte
  // ===================================================================
  function initCarte() {
    if (etat.carte) return;
    const carte = L.map('carte', { preferCanvas: true, zoomControl: false });
    L.control.zoom({ position: 'topleft' }).addTo(carte);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)'
    }).addTo(carte);
    const plan = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: '© Esri' });
    L.control.layers({ Relief: topo, Plan: plan, Satellite: sat }, null, { position: 'bottomright' }).addTo(carte);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(carte);
    for (const c of ['circuit', 'traceB', 'traceA', 'etiquettes', 'planeurs']) etat.couches[c] = L.layerGroup().addTo(carte);
    // Clic près d'une trace : le curseur va à ce moment du vol
    carte.on('click', (e) => {
      const p = carte.latLngToContainerPoint(e.latlng);
      let meilleur = null;
      const chercher = (v, decal) => {
        const a = v.analyse;
        for (let i = a.deco; i <= a.atterro; i += 2) {
          const q = carte.latLngToContainerPoint([a.points[i].lat, a.points[i].lon]);
          const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
          if (d < 400 && (!meilleur || d < meilleur.d)) meilleur = { d, t: a.t[i] + decal };
        }
      };
      chercher(volA(), 0);
      if (volB()) chercher(volB(), etat.decalB);
      if (meilleur) { arreterLecture(); allerA(meilleur.t); }
    });
    etat.carte = carte;
  }

  function dessinerTrace(v, couche, couleur) {
    const a = v.analyse, P = a.points;
    couche.clearLayers();
    const filtre = etat.filtre;
    const coul = (i) => {
      const ph = a.phaseDe[i];
      const visible = filtre === 'tout' || ph === filtre;
      return visible ? (couleur || couleurPhase(ph)) : 'fondu';
    };
    let courant = coul(a.deco);
    let pts = [[P[a.deco].lat, P[a.deco].lon]];
    const tracer = (c, liste) => {
      if (liste.length < 2) return;
      L.polyline(liste, c === 'fondu'
        ? { color: css('--remorque'), weight: 1.5, opacity: 0.35, interactive: false }
        : { color: c, weight: 3, opacity: 0.95, interactive: false }).addTo(couche);
    };
    for (let i = a.deco + 1; i <= a.atterro; i++) {
      const c = coul(i);
      pts.push([P[i].lat, P[i].lon]);
      if (c !== courant || i === a.atterro) {
        tracer(courant, pts);
        pts = [[P[i].lat, P[i].lon]];
        courant = c;
      }
    }
  }

  function dessinerCarte(recadrer) {
    const A = volA(), B = volB();
    dessinerTrace(A, etat.couches.traceA, null);
    if (B) dessinerTrace(B, etat.couches.traceB, css('--pilote-b'));
    else etat.couches.traceB.clearLayers();
    dessinerCircuit();
    dessinerEtiquettes();
    // Planeurs
    etat.couches.planeurs.clearLayers();
    const planeur = (v, cl, couleur) => L.circleMarker([v.analyse.points[v.analyse.deco].lat, v.analyse.points[v.analyse.deco].lon], {
      radius: 7, color: '#fff', weight: 2.5, fillColor: couleur, fillOpacity: 1, interactive: false
    }).bindTooltip(echapper(codeVol(v)), { permanent: true, direction: 'top', offset: [0, -8], className: 'et et-planeur ' + cl })
      .addTo(etat.couches.planeurs);
    etat.planeurs.a = planeur(A, 'a', B ? css('--pilote-a') : '#111');
    etat.planeurs.b = B ? planeur(B, 'b', css('--pilote-b')) : null;
    // Légende
    $('#legende').innerHTML = `<b>Phase</b>` +
      `<span><i style="background:${css('--thermique')}"></i>Montée (spirale)</span>` +
      `<span><i style="background:${css('--transition')}"></i>Transition</span>` +
      `<span><i style="background:${css('--remorque')}"></i>Remorqué / sol</span>` +
      (B ? `<span><i style="background:${css('--pilote-b')}"></i>${echapper(nomVol(B))}</span>` : '');
    if (recadrer) cadrer(null);
  }

  function cadrer(etape) {
    const A = volA(), B = volB();
    const b = L.latLngBounds([]);
    const ajouter = (v, s, e) => { for (let i = s; i <= e; i += 5) b.extend([v.analyse.points[i].lat, v.analyse.points[i].lon]); };
    if (etape && etape.s != null) {
      ajouter(A, etape.s, etape.e);
    } else {
      ajouter(A, A.analyse.deco, A.analyse.atterro);
      if (B) ajouter(B, B.analyse.deco, B.analyse.atterro);
      zones().forEach(z => b.extend(L.latLng(z.lat, z.lon).toBounds(2 * z.rayon)));
    }
    if (b.isValid()) etat.carte.fitBounds(b, { padding: [40, 40] });
  }

  function dessinerCircuit() {
    const g = etat.couches.circuit;
    g.clearLayers();
    const Z = zones();
    if (Z.length < 2 || !etat.etiquettes.circuit) return;
    const coul = css('--circuit');
    const A = volA(), r = A.circ;
    const prep = IGC.preparerZones(Z);
    const style = { color: coul, weight: 1.5, fillColor: coul, fillOpacity: 0.07, interactive: false };
    prep.forEach((z) => {
      const c = IGC.contourZone(z);
      if (c.type === 'ligne') L.polyline(c.points, { color: coul, weight: 4, interactive: false }).addTo(g);
      else if (c.type === 'cercle') L.circle([z.lat, z.lon], Object.assign({ radius: z.rayon }, style)).addTo(g);
      else L.polygon(c.points, style).addTo(g);
      if (c.rayon2) L.circle([z.lat, z.lon], Object.assign({ radius: c.rayon2 }, style)).addTo(g);
    });
    const n = Z.length, aat = etat.typeCircuit === 'AAT';
    for (let k = 1; k < n; k++) {
      const z0 = Z[k - 1], z1 = Z[k];
      L.polyline([[z0.lat, z0.lon], [z1.lat, z1.lon]], { color: coul, weight: 2, opacity: 0.8, dashArray: aat ? '6 6' : null, interactive: false }).addTo(g);
      L.circleMarker([(z0.lat + z1.lat) / 2, (z0.lon + z1.lon) / 2], { radius: 0, opacity: 0, fillOpacity: 0, interactive: false })
        .bindTooltip(`B${k} · ${nf(IGC.distance(z0, z1) / 1000, 1)} km`, { permanent: true, direction: 'center', className: 'et et-branche' })
        .addTo(g);
    }
    if (aat && r && r.chemin.length > 1) {
      L.polyline(r.chemin.map(p => [p.lat, p.lon]), { color: coul, weight: 3, interactive: false }).addTo(g);
    }
    Z.forEach((z, k) => {
      const v = r && r.verification ? r.verification[k] : null;
      const cl = v ? (v.ok ? ' ok' : ' ko') : '';
      L.marker([z.lat, z.lon], {
        interactive: false,
        icon: L.divIcon({ className: 'pv-icone' + cl, html: nomPoint(k, n), iconSize: [24, 24], iconAnchor: [12, 12] })
      }).bindTooltip(`${echapper(z.nom)}${v && v.ok ? ` <span>${fmtHeure(v.t)}</span>` : v ? ' <span>✗</span>' : ''}`,
        { permanent: true, direction: 'right', offset: [12, 0], className: 'et et-pv' + cl }).addTo(g);
    });
  }

  function dessinerEtiquettes() {
    const g = etat.couches.etiquettes;
    g.clearLayers();
    const a = volA().analyse;
    if (etat.etiquettes.montees && etat.filtre !== 'G') {
      a.thermiques.forEach(th => {
        if (th.gain <= 0) return;
        L.circleMarker([th.centre.lat, th.centre.lon], {
          radius: Math.max(4, Math.min(9, 3 + th.vzMoy * 1.8)), color: '#fff', weight: 1.5, fillColor: css('--thermique'), fillOpacity: 1
        }).bindTooltip(`${signe(th.vzMoy, 1)} <span>· ${nf(th.gain)} m</span>`, { permanent: true, direction: 'top', offset: [0, -6], className: 'et et-th' })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); arreterLecture(); allerA(a.t[th.s]); })
          .addTo(g);
      });
    }
    if (etat.etiquettes.transitions && etat.filtre !== 'T') {
      a.transitions.forEach(tr => {
        if (tr.dist < 2000 || tr.duree < 45) return;
        const moitie = a.cum[tr.s] + tr.dist / 2;
        let i = tr.s;
        while (i < tr.e && a.cum[i] < moitie) i++;
        L.circleMarker([a.points[i].lat, a.points[i].lon], { radius: 3.5, color: '#fff', weight: 1.5, fillColor: css('--transition'), fillOpacity: 1 })
          .bindTooltip(`${nf(tr.vitesse * 3.6)} km/h <span>· f ${fmtFinesse(tr.finesse)}</span>`, { permanent: true, direction: 'bottom', offset: [0, 5], className: 'et et-tr' })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); arreterLecture(); allerA(a.t[tr.s]); })
          .addTo(g);
      });
    }
  }

  // ----- Étapes : vue d'ensemble, puis chaque branche (ou chaque montée) -----
  function construireEtapes() {
    const A = volA(), a = A.analyse, r = A.circ, Z = zones();
    const etapes = [{ nom: "Vue d'ensemble" }];
    if (r && r.chemin.length > 1) {
      for (let k = 1; k < r.chemin.length; k++) {
        etapes.push({ nom: `B${k} · ${Z[k - 1].nom} → ${Z[k].nom}`, s: r.chemin[k - 1].i, e: r.chemin[k].i });
      }
    } else {
      a.thermiques.forEach((th, k) => {
        if (th.gain > 0) etapes.push({ nom: `Montée ${k + 1} · ${signe(th.vzMoy, 1)} m/s`, s: th.s, e: th.e });
      });
    }
    etat.etapes = etapes;
    if (etat.etape >= etapes.length) etat.etape = 0;
    $('#etape-nom').textContent = etapes[etat.etape].nom;
  }
  function allerEtape(k) {
    const n = etat.etapes.length;
    etat.etape = ((k % n) + n) % n;
    const et = etat.etapes[etat.etape];
    $('#etape-nom').textContent = et.nom;
    cadrer(et);
    if (et.s != null) { arreterLecture(); allerA(volA().analyse.t[et.s]); }
  }

  // ===================================================================
  // Frise : barogramme + curseur
  // ===================================================================
  const pluginFrise = {
    id: 'frise',
    afterDatasetsDraw(chart) {
      const A = volA();
      if (!A) return;
      const a = A.analyse, { ctx, chartArea: z, scales: { x } } = chart;
      ctx.save();
      // Largage
      if (a.largage > a.deco || a.departEnVol) {
        const px = x.getPixelForValue(a.t[a.largage]);
        ctx.strokeStyle = css('--texte-2');
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px, z.top); ctx.lineTo(px, z.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css('--texte');
        ctx.font = '600 11px ' + Chart.defaults.font.family;
        ctx.fillText(a.departEnVol ? '⚑ départ en vol' : `⚑ largage (${a.largageAuto ? 'auto' : 'manuel'})`, px + 4, z.top + 11);
      }
      // Départ et arrivée du circuit (vol A)
      if (A.circ && A.circ.nbAtteints) {
        ctx.strokeStyle = css('--circuit');
        ctx.fillStyle = css('--circuit');
        ctx.font = '700 10px ' + Chart.defaults.font.family;
        const n = A.circ.zones.length;
        A.circ.verification.forEach((v, k) => {
          if (!v.ok) return;
          const px = x.getPixelForValue(v.t);
          ctx.globalAlpha = 0.5;
          ctx.beginPath(); ctx.moveTo(px, z.bottom - 8); ctx.lineTo(px, z.bottom); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillText(nomPoint(k, n), px - 4, z.bottom - 10);
        });
      }
      // Curseur
      if (etat.t != null) {
        const px = x.getPixelForValue(etat.t);
        ctx.strokeStyle = css('--texte');
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, z.top); ctx.lineTo(px, z.bottom); ctx.stroke();
      }
      ctx.restore();
    }
  };

  function serieAlt(v, decal) {
    const a = v.analyse, i0 = Math.max(0, a.deco - 10), i1 = Math.min(a.points.length - 1, a.atterro + 10);
    const pas = Math.max(1, Math.ceil((i1 - i0) / 2500));
    const data = [], idx = [];
    for (let i = i0; i <= i1; i += pas) { data.push({ x: a.t[i] + decal, y: a.alt[i] }); idx.push(i); }
    return { data, idx };
  }

  function afficherBarogramme() {
    const A = volA(), B = volB();
    if (etat.baro) etat.baro.destroy();
    Chart.defaults.color = css('--texte-2');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const sA = serieAlt(A, 0);
    const datasets = [{
      label: nomVol(A), data: sA.data, borderWidth: 1.6, pointRadius: 0, borderColor: css('--transition'),
      segment: { borderColor: (c) => couleurPhase(A.analyse.phaseDe[sA.idx[c.p0DataIndex]]) }
    }];
    if (B) {
      const sB = serieAlt(B, etat.decalB);
      datasets.push({ label: nomVol(B), data: sB.data, borderWidth: 1.6, pointRadius: 0, borderColor: css('--pilote-b') });
    }
    const tMin = Math.min(...datasets.map(d => d.data[0].x)), tMax = Math.max(...datasets.map(d => d.data[d.data.length - 1].x));
    etat.baro = new Chart($('#barogramme'), {
      type: 'line',
      data: { datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
        events: [],
        layout: { padding: { top: 4 } },
        scales: {
          x: { type: 'linear', min: tMin, max: tMax, grid: { color: css('--grille') }, ticks: { callback: (v) => fmtHeure(v), maxTicksLimit: 9, maxRotation: 0, font: { size: 11 } } },
          y: { grid: { color: css('--grille') }, ticks: { maxTicksLimit: 4, font: { size: 11 } } }
        },
        plugins: { legend: { display: false }, tooltip: { enabled: false } }
      },
      plugins: [pluginFrise]
    });
  }

  // Glisser sur le barogramme pour déplacer le curseur
  (function () {
    const zone = $('.baro');
    let actif = false;
    const placer = (e) => {
      if (!etat.baro) return;
      const r = zone.getBoundingClientRect();
      const x = etat.baro.scales.x.getValueForPixel(e.clientX - r.left);
      allerA(x);
    };
    zone.addEventListener('pointerdown', (e) => { actif = true; arreterLecture(); zone.setPointerCapture(e.pointerId); placer(e); });
    zone.addEventListener('pointermove', (e) => { if (actif) placer(e); });
    zone.addEventListener('pointerup', () => { actif = false; });
    zone.addEventListener('pointercancel', () => { actif = false; });
  })();

  function allerA(t) {
    etat.t = Math.max(etat.tMin, Math.min(etat.tMax, t));
    majCurseur();
  }

  // Mise à jour de tout ce qui dépend du curseur
  function majCurseur() {
    const A = volA(), B = volB();
    if (!A || etat.t == null) return;
    const a = A.analyse;
    const iA = indice(a.t, etat.t);
    let iB = null;
    if (B) iB = indice(B.analyse.t, etat.t - etat.decalB);
    if (etat.planeurs.a) etat.planeurs.a.setLatLng([a.points[iA].lat, a.points[iA].lon]);
    if (etat.planeurs.b && iB != null) etat.planeurs.b.setLatLng([B.analyse.points[iB].lat, B.analyse.points[iB].lon]);
    if (etat.suivre && etat.carte) {
      const p = [a.points[iA].lat, a.points[iA].lon];
      if (!etat.carte.getBounds().pad(-0.25).contains(p)) etat.carte.panTo(p, { animate: false });
    }

    // Valeurs en direct dans la frise
    const ligne = (v, i, cl) => {
      const an = v.analyse;
      const enAir = i > an.deco && i < an.atterro;
      return `<div class="direct-ligne"><span class="point ${cl}"></span><span class="nom">${echapper(nomVol(v))}</span>
        <span>${nf(an.alt[i])} m</span><span>${enAir ? nf(an.vit[i] * 3.6) + ' km/h' : NOM_PHASE.S}</span></div>`;
    };
    let html = ligne(A, iA, 'a') + (B ? ligne(B, iB, 'b') : '');
    const av = avanceCourante();
    if (av) {
      const cl = Math.abs(av.comp) < 5 ? '' : av.comp > 0 ? 'a' : 'b';
      html += `<span class="pastille-avance ${cl}">${cl ? `${echapper(nomCourt(cl === 'a' ? A : B))} +${fmtDuree(av.comp)}` : 'À égalité'} · ${fmtDist(Math.abs(av.dist))}</span>`;
    }
    $('#direct').innerHTML = html;
    majDuelDirect(av, iA, iB);

    if (!etat.redessin) {
      etat.redessin = true;
      requestAnimationFrame(() => {
        etat.redessin = false;
        if (etat.baro) etat.baro.draw();
        if (etat.grapheParcours) etat.grapheParcours.draw();
      });
    }
  }

  // Avance au curseur : temps (compensé et sans altitude), distance sur le circuit, altitude
  function avanceCourante() {
    const r = etat.comp;
    if (!r) return null;
    const tau = etat.t - r.SA.origine;
    const x = IGC.avanceAu(r.SA, r.SB, tau, r.mc);
    const L = (r.prA.L + r.prB.L) / 2;
    return { comp: x.comp, brut: x.brut, dist: (x.eA.f - x.eB.f) * L, alt: x.eA.h - x.eB.h, fA: x.eA.f, fB: x.eB.f };
  }

  // ----- Lecture ------------------------------------------------------
  function boucle(ts) {
    if (!etat.lecture) return;
    const dt = etat.dernierFrame ? (ts - etat.dernierFrame) / 1000 : 0;
    etat.dernierFrame = ts;
    allerA(etat.t + dt * etat.vitesse);
    if (etat.t >= etat.tMax) { arreterLecture(); return; }
    requestAnimationFrame(boucle);
  }
  function lancerLecture() {
    if (etat.t >= etat.tMax - 1) etat.t = etat.tMin;
    etat.lecture = true;
    etat.dernierFrame = 0;
    $('#lecture').textContent = '❚❚';
    $('#lecture').setAttribute('aria-label', 'Mettre en pause');
    requestAnimationFrame(boucle);
  }
  function arreterLecture() {
    etat.lecture = false;
    $('#lecture').textContent = '▶';
    $('#lecture').setAttribute('aria-label', 'Lire le vol');
  }

  // ===================================================================
  // Panneau latéral : circuit + duel
  // ===================================================================
  const FACTEURS = {
    vz: { nom: 'Spirale', grace: 'à la spirale', sur: 'sur la spirale', detail: (m) => `Vz ${signe(m.vz, 2)} m/s` },
    vg: { nom: 'Vitesse transition', grace: 'à la vitesse en transition', sur: 'sur la vitesse en transition', detail: (m) => `${nf(m.vg * 3.6)} km/h` },
    ld: { nom: 'Finesse transition', grace: 'à la finesse en transition', sur: 'sur la finesse en transition', detail: (m) => `finesse ${nf(m.ld, 1)}` },
    k: { nom: 'Cheminement', grace: 'au cheminement', sur: 'sur le cheminement', detail: (m) => `${nf(m.k * 100)} km parcourus / 100 km` },
    e2: { nom: 'Alti départ / arrivée', grace: "à l'altitude de départ et d'arrivée", sur: "sur l'altitude de départ et d'arrivée", detail: (m) => `${nf(m.st.hDebut)} → ${nf(m.st.hFin)} m` }
  };
  const lettre = (x) => (Math.abs(x) < 3 ? null : x > 0 ? 'a' : 'b');

  function afficherLateral() {
    const A = volA(), B = volB();
    let html = blocCircuit(A, B);
    html += blocPompes(A, 'a', 0, !!B);
    if (B) html += blocPompes(B, 'b', etat.decalB, true);
    html += B ? blocDuel(A, B) : `<section class="bloc"><div class="bloc-titre"><h2>Duel</h2></div>
      <div class="invitation">Ajoutez le vol d'un autre pilote sur la même épreuve avec « Ajouter des vols… », puis choisissez-le dans le menu Duel.
      <button class="btn" data-action="demo-b">Comparer avec un vol de démo</button></div></section>`;
    html += `<div class="pied">${echapper(etat.texteVersion || '')}</div>`;
    $('#lateral').innerHTML = html;
    if (etat.grapheParcours) { etat.grapheParcours.destroy(); etat.grapheParcours = null; }
    if (etat.comp) afficherParcours();
  }

  // Analyse des pompes après le départ : force réelle, temps de centrage, MC atteignable / MC réel
  function blocPompes(v, cl, decal, duel) {
    const P = IGC.analyserPompes(v.analyse, v.circ), R = P.resume;
    const titre = `Pompes${duel ? ` · <span class="point ${cl}"></span>${echapper(nomCourt(v))}` : ''}`;
    if (!R) return `<section class="bloc"><div class="bloc-titre"><h2>${titre}</h2></div><p class="discret petit">Aucune pompe exploitable${v.circ && v.circ.tDepart != null ? ' après le départ' : ''}.</p></section>`;
    const pct = (x) => `${nf(x * 100)} %`;
    let h = `<section class="bloc"><div class="bloc-titre"><h2>${titre}</h2>
      <span class="discret petit">${R.apresDepart ? 'après le départ' : 'tout le vol (pas de départ)'}</span></div>
      <div class="pompes-resume">
        <div><span>MC atteignable</span><b>${nf(R.mcTheo, 1)} m/s</b><small>pompes centrées dès l'entrée</small></div>
        <div><span>MC réel</span><b>${nf(R.mcReel, 1)} m/s</b><small>${pct(R.mcReel / R.mcTheo)} de l'atteignable</small></div>
        <div><span>Centrage</span><b>${fmtDuree(R.centrage)}</b><small>sur ${R.nb} pompes</small></div>
        <div><span>Temps perdu</span><b>${fmtDuree(R.perdu)}</b><small>vs montée à fond</small></div>
      </div>
      <div class="table-wrap"><table class="pompes"><thead><tr><th>#</th><th>Heure</th><th>Alt.</th><th title="Force de la pompe une fois centrée (meilleur Vz moyen sur ~2 tours)">Pompe</th><th title="Temps pour atteindre 80 % de la force de la pompe">Centrage</th><th title="Vz réellement obtenu sur tout le thermique">MC réel</th><th title="Temps perdu par rapport à une montée à la force de la pompe dès l'entrée">Perdu</th></tr></thead><tbody>`;
    P.pompes.forEach((p, n) => {
      const eff = p.efficacite, cls = eff >= 0.85 ? 'bon' : eff >= 0.7 ? 'moyen' : 'faible';
      h += `<tr data-action="pompe" data-t="${p.debut + decal}" data-lat="${p.centre.lat}" data-lon="${p.centre.lon}">
        <td>${n + 1}</td><td>${fmtHeure(p.debut)}</td><td>${nf(p.altDebut)}→${nf(p.altFin)}</td>
        <td><b>${nf(p.vzPompe, 1)}</b></td><td>${fmtDuree(p.centrage)}</td>
        <td class="${cls}">${nf(p.mcReel, 1)}</td><td>${fmtDuree(p.perdu)}</td></tr>`;
    });
    h += `</tbody></table></div>
      <p class="discret petit">Pompe = meilleur Vz moyen sur ~2 tours une fois centré. Centrage = temps pour atteindre 80 % de cette valeur. Clique une ligne pour y aller.</p></section>`;
    return h;
  }

  function blocCircuit(A, B) {
    const Z = zones();
    if (Z.length < 2) {
      return `<section class="bloc"><div class="bloc-titre"><h2>Circuit</h2></div>
        <p class="discret">Aucun circuit déclaré dans ${B ? 'ces fichiers' : 'ce fichier'}.</p></section>`;
    }
    const r = A.circ;
    let res = '';
    if (!B && r) {
      res = r.termine
        ? `<div class="resultat ok"><b>Terminé</b> en ${fmtChrono(r.duree)} · ${nf(r.vitesse * 3.6, 1)} km/h</div>`
        : `<div class="resultat ko"><b>Non terminé</b> ${echapper(r.raison || '')}</div>`;
    }
    return `<section class="bloc">
      <div class="bloc-titre"><h2>Circuit</h2>
        <div class="segment" role="group" aria-label="Type de circuit">
          <button data-action="type" data-val="CT" class="${etat.typeCircuit === 'CT' ? 'actif' : ''}">CT</button>
          <button data-action="type" data-val="AAT" class="${etat.typeCircuit === 'AAT' ? 'actif' : ''}">AAT</button>
        </div></div>
      <p class="trajet">${Z.map(z => echapper(z.nom)).join(' → ')}</p>
      <p class="discret petit">${nf((r ? r.distanceNominale : 0) / 1000, 1)} km entre les centres${etat.tempsMini ? ` · temps mini ${fmtDuree(etat.tempsMini)}` : ''}</p>
      ${res}
    </section>`;
  }

  function resumePilote(v) {
    const r = v.circ;
    if (!r || !r.nbAtteints) return { chrono: '—', sous: 'pas de départ' };
    if (r.termine) return { chrono: fmtChrono(r.duree), sous: `${nf(r.vitesse * 3.6, 1)} km/h` };
    const pr = etat.comp ? (v === volA() ? etat.comp.prA : etat.comp.prB) : null;
    return { chrono: pr ? `${nf(pr.env[pr.iFin] * 100)} %` : '—', sous: 'non terminé' };
  }

  function blocDuel(A, B) {
    const rA = A.circ, rB = B.circ;
    // Vainqueur
    let gagnant = null, ecart = '';
    if (rA && rB && rA.termine && rB.termine) {
      if (etat.typeCircuit === 'AAT') {
        gagnant = rA.vitesse >= rB.vitesse ? 'a' : 'b';
        ecart = `${nf(Math.abs(rA.vitesse - rB.vitesse) * 3.6, 1)} km/h`;
      } else {
        gagnant = rA.duree <= rB.duree ? 'a' : 'b';
        ecart = fmtDuree(rA.duree - rB.duree);
      }
    } else if (rA && rA.termine) gagnant = 'a';
    else if (rB && rB.termine) gagnant = 'b';
    const carte = (v, cl) => {
      const s = resumePilote(v), e = v.analyse.entete;
      return `<div class="duel-pilote ${cl}${gagnant === cl ? ' gagnant' : ''}">
        ${gagnant === cl ? '<span class="vainqueur">Vainqueur</span>' : ''}
        <div class="nom"><span class="point ${cl}"></span>${echapper(nomCourt(v))}</div>
        <div class="chrono">${s.chrono}</div>
        <div class="sous">${s.sous}</div>
        <div class="sous">${echapper([e.planeur, e.concours].filter(Boolean).join(' · '))}</div></div>`;
    };
    let html = `<section class="bloc"><div class="bloc-titre"><h2>Duel</h2></div>
      <div class="duel-tete">${carte(A, 'a')}<div class="duel-ecart">${ecart ? `écart<b>${ecart}</b>` : 'vs'}</div>${carte(B, 'b')}</div>`;
    if (rA && rB && rA.nbAtteints && rB.nbAtteints) {
      html += `<p class="duel-info">${nf(rA.distanceNominale / 1000, 1)} km · circuit ${etat.typeCircuit} · départs ${fmtHeure(rA.tDepart, true)} (${echapper(nomCourt(A))}) et ${fmtHeure(rB.tDepart, true)} (${echapper(nomCourt(B))}), heure de passage de la ligne</p>`;
    }
    html += `<div class="segment" role="group" aria-label="Temps de comparaison">
        <button data-action="alignement" data-val="course" class="${etat.alignement === 'course' ? 'actif' : ''}">Départs alignés</button>
        <button data-action="alignement" data-val="reel" class="${etat.alignement === 'reel' ? 'actif' : ''}">Heure réelle</button></div>`;
    if (etat.compErreur) html += `<p class="discret petit">${echapper(etat.compErreur)}</p>`;
    if (etat.comp) {
      html += `<div class="direct-carte">
        <div class="direct-tete"><span>En direct · à hauteur égale</span><span id="dd-heure"></span></div>
        <div class="direct-gros" id="dd-avance"></div>
        <div class="tir"><div class="tir-barre"><span class="tir-curseur" id="dd-tir"></span></div>
          <div class="tir-noms"><span class="b">◀ ${echapper(nomCourt(B))}</span><span class="a">${echapper(nomCourt(A))} ▶</span></div></div>
        <div class="deltas">
          <div class="delta"><span>Temps</span><div id="dd-temps"></div></div>
          <div class="delta"><span>Distance</span><div id="dd-dist"></div></div>
          <div class="delta"><span>Altitude</span><div id="dd-alt"></div></div>
        </div>
        <div class="direct-brut" id="dd-brut"></div>
      </div>`;
      html += blocParcours();
      html += blocBilan(A, B);
      html += blocBranches(A, B);
    }
    return html + '</section>';
  }

  function majDuelDirect(av, iA, iB) {
    const el = $('#dd-avance');
    if (!el || !av) return;
    const A = volA(), B = volB();
    const cl = lettre(av.comp);
    const nom = (c) => echapper(nomCourt(c === 'a' ? A : B));
    $('#dd-heure').textContent = fmtHeure(etat.t, true);
    el.className = 'direct-gros ' + (cl || '');
    el.innerHTML = cl ? `${nom(cl)} +${fmtDuree(av.comp)}` : 'À égalité';
    const tir = $('#dd-tir');
    tir.className = 'tir-curseur ' + (cl || '');
    tir.style.left = `${50 + Math.max(-1, Math.min(1, av.comp / 600)) * 46}%`;
    // Chaque écart : la valeur, et en dessous le pilote qui a l'avantage
    const cel = (id, val, c, sous) => {
      const e = $(id);
      e.innerHTML = c ? `<b class="${c}">+${val}</b><small class="${c}">${nom(c)} ${sous}</small>` : '<b>égalité</b><small>&nbsp;</small>';
    };
    cel('#dd-temps', fmtDuree(av.comp), cl, 'devant');
    const cd = Math.abs(av.dist) < 50 ? null : av.dist > 0 ? 'a' : 'b';
    cel('#dd-dist', fmtDist(Math.abs(av.dist)), cd, 'plus loin');
    const ch = Math.abs(av.alt) < 5 ? null : av.alt > 0 ? 'a' : 'b';
    cel('#dd-alt', `${nf(Math.abs(av.alt))} m`, ch, 'plus haut');
    const cb = lettre(av.brut);
    $('#dd-brut').innerHTML = `Sans l'altitude : ${cb ? `${nom(cb)} +${fmtDuree(av.brut)}` : 'à égalité'} au même point du circuit` +
      ` · ${nf(av.fA * 100)} % du circuit pour ${nom('a')}, ${nf(av.fB * 100)} % pour ${nom('b')}`;
  }

  // ----- Au fil du parcours -----------------------------------------
  function blocParcours() {
    const r = etat.comp, B = r.bilan;
    const vRef = B ? (B.vitesseA + B.vitesseB) / 2 : (r.prA.L / Math.max(1, r.SA.tFin - r.SA.tDep));
    const sec100 = 100 / r.mc;
    return `<div class="bloc-titre"><h3 class="petit">Au fil du parcours</h3>
        <div class="segment" role="group" aria-label="Axe horizontal">
          <button data-action="unite" data-val="km" class="${etat.uniteParcours === 'km' ? 'actif' : ''}">km</button>
          <button data-action="unite" data-val="temps" class="${etat.uniteParcours === 'temps' ? 'actif' : ''}">temps</button></div></div>
      <div class="parcours"><canvas id="graphe-parcours"></canvas></div>
      <p class="note">Aire colorée : avance <b>à hauteur égale</b>, la vraie avance. Pointillés : sans tenir compte de l'altitude.
        Ici, 100 m de hauteur valent <b>${nf(sec100)} s</b>, le temps de les reprendre à
        <input type="number" id="mc" step="0.1" min="0.2" value="${r.mc.toFixed(1)}" aria-label="Taux de montée de référence"> m/s
        (la montée moyenne des deux pilotes), soit <b>${nf(sec100 * vRef / 1000, 1)} km</b> à ${nf(vRef * 3.6)} km/h.</p>`;
  }

  function afficherParcours() {
    const r = etat.comp, g = r.grille;
    const cA = css('--pilote-a'), cB = css('--pilote-b');
    const km = etat.uniteParcours === 'km';
    const LA = r.prA.L;
    // Abscisse : heure du vol A, ou km faits par A
    const pts = [], ptsBrut = [];
    let fPrec = -1;
    for (const p of g) {
      const x = km ? p.fA * LA / 1000 : p.tau + r.SA.origine;
      if (km) { if (p.fA <= 0 || p.fA <= fPrec) continue; fPrec = p.fA; }
      pts.push({ x, y: p.comp / 60 });
      ptsBrut.push({ x, y: p.brut / 60 });
    }
    if (pts.length < 2) return;
    // Repères des points du circuit
    const chemin = r.prA.chemin, n = chemin.length;
    const reperes = [];
    let cumul = 0;
    for (let k = 0; k < n; k++) {
      if (k > 0) cumul += IGC.distance(chemin[k - 1], chemin[k]);
      const x = km ? cumul / 1000 : (isFinite(chemin[k].i) ? volA().analyse.t[chemin[k].i] : null);
      if (x != null) reperes.push({ x, lab: nomPoint(k, n) });
    }
    const A = volA(), B = volB();
    const pluginParcours = {
      id: 'parcours',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: z, scales: { x, y } } = chart;
        ctx.save();
        ctx.font = '600 10px ' + Chart.defaults.font.family;
        ctx.fillStyle = css('--texte-2');
        ctx.strokeStyle = css('--grille');
        reperes.forEach(rp => {
          const px = x.getPixelForValue(rp.x);
          if (px < z.left - 1 || px > z.right + 1) return;
          ctx.beginPath(); ctx.moveTo(px, z.top); ctx.lineTo(px, z.bottom); ctx.stroke();
          ctx.fillText(rp.lab, px + 2, z.bottom - 3);
        });
        if (y.min < 0 && y.max > 0) {
          const py = y.getPixelForValue(0);
          ctx.strokeStyle = css('--texte-2');
          ctx.beginPath(); ctx.moveTo(z.left, py); ctx.lineTo(z.right, py); ctx.stroke();
        }
        ctx.fillStyle = cA; ctx.fillText(`${nomCourt(A)} devant`, z.left + 4, z.top + 10);
        ctx.fillStyle = cB; ctx.fillText(`${nomCourt(B)} devant`, z.left + 4, z.bottom - 14);
        // Curseur
        const av = avanceCourante();
        if (av) {
          const cx = km ? av.fA * LA / 1000 : etat.t;
          const px = x.getPixelForValue(cx);
          if (px >= z.left && px <= z.right) {
            ctx.strokeStyle = css('--texte');
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(px, z.top); ctx.lineTo(px, z.bottom); ctx.stroke();
          }
        }
        ctx.restore();
      }
    };
    const max = Math.max(1, ...pts.map(p => Math.abs(p.y)), ...ptsBrut.map(p => Math.abs(p.y)));
    etat.grapheParcours = new Chart($('#graphe-parcours'), {
      type: 'line',
      data: {
        datasets: [
          {
            data: pts, borderWidth: 2, pointRadius: 0, borderColor: cA,
            segment: { borderColor: (c) => ((c.p0.parsed.y + c.p1.parsed.y) / 2 >= 0 ? cA : cB) },
            fill: { target: 'origin', above: alpha(cA, 0.2), below: alpha(cB, 0.2) }
          },
          { data: ptsBrut, borderWidth: 1, pointRadius: 0, borderDash: [4, 4], borderColor: css('--texte-2') }
        ]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
        events: ['click'],
        onClick: (ev, _e, chart) => {
          const xv = chart.scales.x.getValueForPixel(ev.x);
          if (!km) { arreterLecture(); allerA(xv); return; }
          const f = xv * 1000 / LA, p = g.find(q => q.fA >= f);
          if (p) { arreterLecture(); allerA(p.tau + r.SA.origine); }
        },
        scales: {
          x: { type: 'linear', min: pts[0].x, max: pts[pts.length - 1].x, grid: { display: false },
            ticks: { maxTicksLimit: 6, maxRotation: 0, font: { size: 10 }, callback: (v) => (km ? `${nf(v)} km` : fmtHeure(v)) } },
          y: { min: -Math.ceil(max), max: Math.ceil(max), grid: { color: css('--grille') },
            ticks: { maxTicksLimit: 5, font: { size: 10 }, callback: (v) => `${v > 0 ? '+' : ''}${v} min` } }
        },
        plugins: { legend: { display: false }, tooltip: { enabled: false } }
      },
      plugins: [pluginParcours]
    });
  }

  // ----- Qui gagne grâce à quoi ------------------------------------
  function blocBilan(A, B) {
    const bl = etat.comp.bilan;
    if (!bl) return '';
    const cles = Object.keys(bl.parts).sort((x, y) => Math.abs(bl.parts[y]) - Math.abs(bl.parts[x]));
    const maxV = Math.max(30, ...cles.map(c => Math.abs(bl.parts[c])));
    const nom = (c) => echapper(nomCourt(c === 'a' ? A : B));
    let txt;
    const portion = bl.fc < 0.999 ? `Jusqu'à ${nf(bl.fc * 100)} % du circuit` : 'Sur tout le circuit';
    if (Math.abs(bl.total) < 5) txt = `${portion} : égalité ou presque.`;
    else {
      const g = bl.total > 0 ? 'a' : 'b', s = g === 'a' ? 1 : -1;
      const pour = cles.filter(c => s * bl.parts[c] > 3).sort((x, y) => s * (bl.parts[y] - bl.parts[x]));
      const contre = cles.filter(c => s * bl.parts[c] < -3).sort((x, y) => s * (bl.parts[x] - bl.parts[y]));
      txt = `${portion}${bl.memeDistance ? '' : ' (à distance égale)'}, <b>${nom(g)} gagne ${fmtDuree(bl.total)}</b>`;
      if (pour.length) txt += `, surtout grâce ${FACTEURS[pour[0]].grace} (${fmtDuree(bl.parts[pour[0]])})`;
      if (contre.length) txt += `, mais perd ${fmtDuree(bl.parts[contre[0]])} ${FACTEURS[contre[0]].sur}`;
      txt += '.';
    }
    const lignes = cles.map(c => {
      const v = bl.parts[c], l = lettre(v), w = Math.abs(v) / maxV * 50;
      return `<div class="facteur" title="${echapper(nomCourt(A))} : ${echapper(FACTEURS[c].detail(bl.mA))} · ${echapper(nomCourt(B))} : ${echapper(FACTEURS[c].detail(bl.mB))}">
        <span class="f-nom">${FACTEURS[c].nom}</span>
        <span class="f-barre">${l ? `<i class="${l}" style="width:${w}%"></i>` : ''}</span>
        <span class="f-val ${l || 'nul'}">${l ? `${nom(l)} +${fmtDuree(v)}` : '≈ 0'}</span></div>
        <div class="petit discret" style="margin:-4px 0 2px 120px">${echapper(FACTEURS[c].detail(bl.mA))} · ${echapper(FACTEURS[c].detail(bl.mB))}</div>`;
    }).join('');
    return `<h3 class="petit">Qui gagne grâce à quoi</h3><p class="synthese">${txt}</p><div class="facteurs">${lignes}</div>`;
  }

  function blocBranches(A, B) {
    const r = etat.comp, Z = zones();
    if (!r.branches.length) return '';
    const nom = (c) => echapper(nomCourt(c === 'a' ? A : B));
    const av = (x) => { const l = lettre(x); return l ? `<td class="${l}">${nom(l)} +${fmtDuree(x)}</td>` : '<td>=</td>'; };
    return `<h3 class="petit">Branche par branche</h3><div class="table-wrap"><table>
      <thead><tr><th>Branche</th><th>${nom('a')}</th><th>${nom('b')}</th><th>Plus rapide</th><th>Au point</th></tr></thead><tbody>` +
      r.branches.map(x => `<tr><td title="${echapper(Z[x.k - 1].nom)} → ${echapper(Z[x.k].nom)}">B${x.k}</td>
        <td>${fmtChrono(x.durA)}<br><span class="discret">${nf(x.vA * 3.6)} km/h</span></td>
        <td>${fmtChrono(x.durB)}<br><span class="discret">${nf(x.vB * 3.6)} km/h</span></td>
        ${av(x.ecart)}${av(x.avanceAuPoint)}</tr>`).join('') + '</tbody></table></div>';
  }

  // ===================================================================
  // Événements
  // ===================================================================
  const volsDemo = () => {
    const a = ajouterVol(IGC.genererVolDemo(), 'vol-demo.igc');
    const b = ajouterVol(IGC.genererVolDemo({
      graine: 11, pilote: 'Pilote B', immat: 'F-CBBB', concours: 'BB',
      decalage: 420, vTransition: 40, zigzag: 20, bonusVz: -0.3
    }), 'vol-demo-b.igc');
    return [a, b];
  };
  $('#btn-demo').addEventListener('click', () => apresAjout(volsDemo()));
  $('#fichiers-accueil').addEventListener('change', (e) => { lireFichiers(e.target.files); e.target.value = ''; });
  $('#fichiers').addEventListener('change', (e) => { lireFichiers(e.target.files); e.target.value = ''; });

  $('#choix-a').addEventListener('change', (e) => {
    etat.idA = +e.target.value;
    if (etat.idB === etat.idA) etat.idB = null;
    etat.mc = null; etat.typeForce = false; etat.etape = 0;
    toutAfficher(true);
  });
  $('#choix-b').addEventListener('change', (e) => {
    etat.idB = e.target.value ? +e.target.value : null;
    etat.mc = null;
    toutAfficher(false);
  });

  document.querySelectorAll('[data-filtre]').forEach(b => b.addEventListener('click', () => {
    etat.filtre = b.dataset.filtre;
    document.querySelectorAll('[data-filtre]').forEach(x => x.classList.toggle('actif', x === b));
    if (volA()) dessinerCarte(false);
  }));
  document.querySelectorAll('[data-etiquette]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.etiquette;
    etat.etiquettes[k] = !etat.etiquettes[k];
    b.classList.toggle('actif', etat.etiquettes[k]);
    b.setAttribute('aria-pressed', String(etat.etiquettes[k]));
    if (volA()) { dessinerCircuit(); dessinerEtiquettes(); }
  }));
  $('#etape-prec').addEventListener('click', () => allerEtape(etat.etape - 1));
  $('#etape-suiv').addEventListener('click', () => allerEtape(etat.etape + 1));
  $('#suivre').addEventListener('change', (e) => { etat.suivre = e.target.checked; majCurseur(); });

  $('#lecture').addEventListener('click', () => (etat.lecture ? arreterLecture() : lancerLecture()));
  document.querySelectorAll('[data-vitesse]').forEach(b => b.addEventListener('click', () => {
    etat.vitesse = +b.dataset.vitesse;
    document.querySelectorAll('[data-vitesse]').forEach(x => x.classList.toggle('actif', x === b));
  }));
  $('#fixer-largage').addEventListener('click', () => {
    const A = volA();
    if (!A) return;
    const i = indice(A.analyse.t, etat.t);
    if (i <= A.analyse.deco || i >= A.analyse.atterro) { toast('Placez le curseur pendant le vol pour fixer le largage.'); return; }
    A.largage = i;
    analyserVol(A);
    toutAfficher(false);
  });
  $('#largage-auto').addEventListener('click', () => {
    const A = volA();
    if (!A || A.largage == null) return;
    A.largage = null;
    analyserVol(A);
    toutAfficher(false);
  });

  // Boutons du panneau latéral (contenu redessiné : délégation)
  $('#lateral').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const act = b.dataset.action, val = b.dataset.val;
    if (act === 'type') { etat.typeCircuit = val; etat.typeForce = true; toutAfficher(false); }
    else if (act === 'pompe') {
      arreterLecture(); allerA(+b.dataset.t);
      if (etat.carte) etat.carte.setView([+b.dataset.lat, +b.dataset.lon], Math.max(etat.carte.getZoom(), 12));
    }
    else if (act === 'alignement') { etat.alignement = val; toutAfficher(false); }
    else if (act === 'unite') { etat.uniteParcours = val; afficherLateral(); majCurseur(); }
    else if (act === 'demo-b') {
      const b2 = ajouterVol(IGC.genererVolDemo({ graine: 11, pilote: 'Pilote B', immat: 'F-CBBB', concours: 'BB', decalage: 420, vTransition: 40, zigzag: 20, bonusVz: -0.3 }), 'vol-demo-b.igc');
      if (b2) { etat.idB = b2.id; toutAfficher(false); }
    }
  });
  $('#lateral').addEventListener('change', (e) => {
    if (e.target.id !== 'mc') return;
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (v > 0) { etat.mc = v; toutAfficher(false); }
  });

  // Clavier : espace = lecture, flèches = ±10 s (±60 s avec Maj)
  document.addEventListener('keydown', (e) => {
    if (!volA() || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); etat.lecture ? arreterLecture() : lancerLecture(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      arreterLecture();
      allerA(etat.t + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 10));
    }
  });

  // Glisser-déposer de fichiers n'importe où
  let compteurDrag = 0;
  const voile = $('#voile-depot');
  window.addEventListener('dragenter', (e) => { e.preventDefault(); compteurDrag++; voile.hidden = false; });
  window.addEventListener('dragleave', () => { if (--compteurDrag <= 0) { compteurDrag = 0; voile.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    compteurDrag = 0;
    voile.hidden = true;
    lireFichiers(e.dataTransfer.files);
  });
})();
