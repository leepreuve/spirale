/* =====================================================================
   analyse.js — Lecture d'un fichier IGC et calcul des statistiques
   ---------------------------------------------------------------------
   Ce fichier ne s'occupe PAS de l'affichage. Il prend le texte d'un
   fichier .igc et renvoie un objet contenant :
     - les points GPS lissés (vitesse, vario, taux de virage)
     - les phases : remorqué (R), thermiques (T), transitions (G)
     - les statistiques de chaque phase et les totaux du vol
   ===================================================================== */
(function (global) {
  'use strict';

  // --- Réglages de la détection (tu peux les ajuster) -----------------
  const REGLAGES = {
    vitesseVol: 10,              // m/s (36 km/h) : au-dessus, on vole
    seuilSpirale: 4,             // °/s : taux de virage moyen => spirale
    fenetreVirage: 8,            // s : demi-fenêtre de lissage du virage
    fenetreVario: 10,            // s : demi-fenêtre de lissage du vario
    fenetreVitesse: 5,           // s : demi-fenêtre de lissage de la vitesse
    dureeMinThermique: 20,       // s : spirale plus courte = ignorée
    virageMinThermique: 300,     // ° cumulés minimum pour un thermique
    pauseMaxThermique: 30,       // s : ligne droite courte entre 2 spirales = même thermique
    seuilLargageVirage: 10,      // °/s : spirale franche après décollage = largué
    dureeMaxRemorque: 25 * 60    // s : au-delà, on considère qu'il n'y a pas eu de remorqué
  };

  const R_TERRE = 6371000;
  const RAD = Math.PI / 180;
  const G = 9.81;

  // --- Outils géographiques -------------------------------------------
  function distance(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLon = (b.lon - a.lon) * RAD;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function cap(a, b) {
    const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
      Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // Déplacement (est, nord) en mètres entre deux points proches
  function vecteur(a, b) {
    const x = (b.lon - a.lon) * RAD * R_TERRE * Math.cos((a.lat + b.lat) / 2 * RAD);
    const y = (b.lat - a.lat) * RAD * R_TERRE;
    return [x, y];
  }

  // Ramène un écart d'angle entre -180 et +180
  function ecartAngle(d) { return ((d % 360) + 540) % 360 - 180; }

  // Point situé à une distance d (m) dans la direction capDeg
  function destination(p, capDeg, d) {
    const dl = d / R_TERRE, th = capDeg * RAD, f1 = p.lat * RAD, l1 = p.lon * RAD;
    const f2 = Math.asin(Math.sin(f1) * Math.cos(dl) + Math.cos(f1) * Math.sin(dl) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(f1), Math.cos(dl) - Math.sin(f1) * Math.sin(f2));
    return { lat: f2 / RAD, lon: l2 / RAD };
  }

  // "500m", "20km", "2.5nm" -> mètres
  function lireDistance(v) {
    if (v == null) return null;
    const m = String(v).match(/([\d.]+)\s*(km|nm|mi|ft|m)?/i);
    if (!m) return null;
    const f = { km: 1000, nm: 1852, mi: 1609.34, ft: 0.3048, m: 1 }[(m[2] || 'm').toLowerCase()];
    const r = parseFloat(m[1]) * f;
    return r > 0 ? r : null;
  }

  // =====================================================================
  // 1. LECTURE DU FICHIER IGC
  // =====================================================================
  // Un enregistrement B (un point GPS) ressemble à :
  //   B 115032 4344220N 00547040E A 00512 00540
  //     heure  latitude  longitude  ok  alt.pression  alt.GPS
  function lire(texte) {
    const lignes = texte.split(/\r?\n/);
    const entete = {};
    let date = null;
    const extensions = [];
    const points = [];
    const circuitBrut = [];
    const zonesOZ = [];       // paramètres de zones (lignes L... OZ=)
    let tempsCircuit = null;  // temps minimum AAT déclaré (TaskTime)
    let decalageJour = 0;
    let dernier = -1;

    for (const brute of lignes) {
      const l = brute.trim();
      if (!l) continue;
      const type = l[0];

      if (type === 'H') {
        const code = l.substring(2, 5).toUpperCase();
        const valeur = l.includes(':') ? l.substring(l.indexOf(':') + 1).trim() : l.substring(5).trim();
        if (code === 'DTE') {
          const m = l.substring(5).match(/(\d{2})(\d{2})(\d{2})/);
          if (m) date = { d: +m[1], m: +m[2], y: 2000 + +m[3] };
        } else if (code === 'PLT') entete.pilote = valeur;
        else if (code === 'GTY') entete.planeur = valeur;
        else if (code === 'GID') entete.immat = valeur;
        else if (code === 'CID') entete.concours = valeur;
        else if (code === 'FTY') entete.enregistreur = valeur;
      } else if (type === 'I') {
        const nb = parseInt(l.substring(1, 3), 10) || 0;
        for (let k = 0; k < nb; k++) {
          const bloc = l.substring(3 + k * 7, 10 + k * 7);
          extensions.push({ debut: +bloc.substring(0, 2), fin: +bloc.substring(2, 4), code: bloc.substring(4, 7) });
        }
      } else if (type === 'C') {
        // Circuit déclaré : C DDMMmmm N DDDMMmmm E Nom
        const m = l.match(/^C(\d{2})(\d{5})([NS])(\d{3})(\d{5})([EW])(.*)$/);
        if (m) {
          let lat = +m[1] + +m[2] / 60000; if (m[3] === 'S') lat = -lat;
          let lon = +m[4] + +m[5] / 60000; if (m[6] === 'W') lon = -lon;
          circuitBrut.push({ lat, lon, nom: m[7].trim() });
        }
      } else if (type === 'L' && /OZ=/i.test(l)) {
        // Zone d'observation (format SeeYou / LXNAV) :
        // LSEEYOU OZ=-1,Style=2,R1=5000m,A1=180,Line=1
        const kv = {};
        l.replace(/([A-Za-z0-9]+)=([^,]*)/g, (_, k, v) => { kv[k.toUpperCase()] = v.trim(); return ''; });
        const idx = parseInt(kv.OZ, 10);
        if (!isNaN(idx)) zonesOZ.push({ idx, kv });
      } else if (type === 'L' && /TaskTime=/i.test(l)) {
        const m = l.match(/TaskTime=(\d+):(\d+)(?::(\d+))?/i);
        if (m) tempsCircuit = +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0);
      } else if (type === 'B' && l.length >= 35) {
        let sec = +l.substring(1, 3) * 3600 + +l.substring(3, 5) * 60 + +l.substring(5, 7);
        if (dernier >= 0 && sec + decalageJour < dernier - 43200) decalageJour += 86400; // passage de minuit UTC
        sec += decalageJour;
        if (sec <= dernier) continue; // doublon d'horodatage
        let lat = +l.substring(7, 9) + +l.substring(9, 14) / 1000 / 60;
        if (l[14] === 'S') lat = -lat;
        let lon = +l.substring(15, 18) + +l.substring(18, 23) / 1000 / 60;
        if (l[23] === 'W') lon = -lon;
        if (!lat && !lon) continue;
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const pt = {
          t: sec, lat, lon,
          altP: parseInt(l.substring(25, 30), 10) || 0,
          altG: parseInt(l.substring(30, 35), 10) || 0
        };
        for (const ext of extensions) {
          if (ext.code === 'ENL') pt.enl = parseInt(l.substring(ext.debut - 1, ext.fin), 10);
        }
        points.push(pt);
        dernier = sec;
      }
    }

    if (points.length < 30) {
      throw new Error("Ce fichier ne ressemble pas à un fichier IGC valide (pas assez de points GPS).");
    }
    // Les enregistrements C sont : décollage, départ, PV..., arrivée, atterrissage
    let circuit = circuitBrut.length >= 4 ? circuitBrut.slice(1, -1) : circuitBrut;
    circuit = circuit.filter(p => p.lat !== 0 || p.lon !== 0);
    if (circuit.length < 2) circuit = [];

    // Applique les paramètres de zones déclarés (rayon, secteur, ligne…)
    if (circuit.length && zonesOZ.length) {
      const min = Math.min(...zonesOZ.map(z => z.idx)); // OZ=-1 ou OZ=0 = départ selon le logiciel
      for (const { idx, kv } of zonesOZ) {
        const p = circuit[idx - min];
        if (!p) continue;
        const r1 = lireDistance(kv.R1), r2 = lireDistance(kv.R2);
        const a1 = kv.A1 != null ? parseFloat(kv.A1) : 180;
        if (r1) p.rayon = r1;
        p.forme = kv.LINE === '1' ? 'ligne' : (a1 < 180 ? 'secteur' : 'cylindre');
        p.demiAngle = a1;
        if (r2) { p.rayon2 = r2; p.demiAngle2 = kv.A2 != null ? parseFloat(kv.A2) : 180; }
        if (kv.STYLE != null) p.style = parseInt(kv.STYLE, 10);
        if (kv.A12 != null) p.a12 = parseFloat(kv.A12);
        p.declare = true;
      }
    }

    return { entete, date, points, extensions, circuit, tempsCircuit };
  }

  // =====================================================================
  // 2. ANALYSE
  // =====================================================================
  function analyser(vol, reglages) {
    const R = Object.assign({}, REGLAGES, reglages || {});
    const P = vol.points;
    const n = P.length;
    const t = P.map(p => p.t);

    // Altitude : GPS si disponible, sinon pression
    const avecGps = P.filter(p => p.altG !== 0).length > n * 0.5;
    const alt = P.map(p => (avecGps ? p.altG : p.altP));

    // Distance cumulée le long de la trace
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + distance(P[i - 1], P[i]);

    // Cap "déroulé" (on additionne les virages, sans retour à 0 après 360°)
    const capD = new Float64Array(n);
    let capPrec = null, cumulCap = 0;
    for (let i = 0; i < n - 1; i++) {
      if (cum[i + 1] - cum[i] > 2) {
        const c = cap(P[i], P[i + 1]);
        if (capPrec !== null) cumulCap += ecartAngle(c - capPrec);
        capPrec = c;
      }
      capD[i] = cumulCap;
    }
    capD[n - 1] = cumulCap;

    // Fenêtres glissantes en temps
    function fenetres(demi) {
      const lo = new Int32Array(n), hi = new Int32Array(n);
      let a = 0, b = 0;
      for (let i = 0; i < n; i++) {
        while (t[a] < t[i] - demi) a++;
        if (b < i) b = i;
        while (b < n - 1 && t[b + 1] <= t[i] + demi) b++;
        let l0 = a, h0 = b;
        if (h0 === l0) { if (i < n - 1) h0 = i + 1; else l0 = i - 1; }
        lo[i] = l0; hi[i] = h0;
      }
      return { lo, hi };
    }
    const deriver = (tab, f) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = (tab[f.hi[i]] - tab[f.lo[i]]) / (t[f.hi[i]] - t[f.lo[i]]);
      return out;
    };
    const vit = deriver(cum, fenetres(R.fenetreVitesse));     // m/s
    const vz = deriver(alt, fenetres(R.fenetreVario));        // m/s
    const virage = deriver(capD, fenetres(R.fenetreVirage));  // °/s

    // --- Décollage / atterrissage --------------------------------------
    const enVol = i => vit[i] > R.vitesseVol;
    let deco = -1, atterro = -1;
    for (let i = 0; i < n && deco < 0; i++) {
      if (!enVol(i)) continue;
      let ok = true;
      for (let j = i; j < n && t[j] < t[i] + 60; j++) if (!enVol(j)) { ok = false; break; }
      if (ok) deco = i;
    }
    for (let i = n - 1; i >= 0 && atterro < 0; i--) {
      if (!enVol(i)) continue;
      let ok = true;
      for (let j = i; j >= 0 && t[j] > t[i] - 60; j--) if (!enVol(j)) { ok = false; break; }
      if (ok) atterro = i;
    }
    if (deco < 0 || atterro <= deco) { deco = 0; atterro = n - 1; }

    // --- Largage (fin du remorqué ou du treuil) -------------------------
    // Départ en vol (Condor, enregistrement commencé en l'air) : pas de remorqué.
    // Largage forcé (reglages.largage = indice du point) : choisi à la main.
    const departEnVol = deco <= 2 && enVol(0);
    let largage = deco, largageAuto = true;
    if (R.largage != null && R.largage > deco && R.largage < atterro) {
      largage = R.largage;
      largageAuto = false;
    } else if (!departEnVol) {
      let maxAlt = alt[deco], iMax = deco, trouve = false;
      for (let i = deco; i <= atterro && t[i] < t[deco] + R.dureeMaxRemorque; i++) {
        if (alt[i] > maxAlt) { maxAlt = alt[i]; iMax = i; }
        if (maxAlt - alt[deco] < 100 || t[i] < t[deco] + 30) continue;
        if (Math.abs(virage[i]) > R.seuilLargageVirage) { largage = i; trouve = true; break; }
        if (vz[i] < -0.3) { largage = iMax; trouve = true; break; }
      }
      if (!trouve) largage = deco;
    }

    // --- Spirale ou ligne droite ? --------------------------------------
    const drapeau = new Array(n).fill('S');
    for (let i = largage; i <= atterro; i++) drapeau[i] = Math.abs(virage[i]) > R.seuilSpirale ? 'T' : 'G';

    function decouper() {
      const r = [];
      let s = largage;
      for (let i = largage + 1; i <= atterro + 1; i++) {
        if (i > atterro || drapeau[i] !== drapeau[s]) { r.push({ type: drapeau[s], s, e: i - 1 }); s = i; }
      }
      return r;
    }
    const remplir = (x, type) => { for (let i = x.s; i <= x.e; i++) drapeau[i] = type; };

    let runs = decouper();
    for (const x of runs) {
      if (x.type !== 'T') continue;
      const duree = t[x.e] - t[x.s];
      const tour = Math.abs(capD[x.e] - capD[x.s]);
      if (duree < R.dureeMinThermique || tour < R.virageMinThermique) remplir(x, 'G');
    }
    runs = decouper();
    for (let k = 1; k < runs.length - 1; k++) {
      const x = runs[k];
      if (x.type === 'G' && runs[k - 1].type === 'T' && runs[k + 1].type === 'T' &&
          t[x.e] - t[x.s] < R.pauseMaxThermique) remplir(x, 'T');
    }
    runs = decouper();

    // Phases avec bornes partagées (la fin d'une phase = début de la suivante)
    const phases = [];
    if (largage > deco) phases.push({ type: 'R', s: deco, e: largage });
    runs.forEach((x, k) => {
      const e = k < runs.length - 1 ? runs[k + 1].s : atterro;
      if (t[e] - t[x.s] >= 2) phases.push({ type: x.type, s: x.s, e });
    });

    const phaseDe = new Array(n).fill('S');
    for (const ph of phases) for (let i = ph.s; i <= ph.e; i++) phaseDe[i] = ph.type;

    // --- Statistiques d'un thermique ------------------------------------
    function statsThermique(s, e) {
      const duree = t[e] - t[s];
      const gain = alt[e] - alt[s];
      const tourTotal = capD[e] - capD[s];
      const tours = Math.abs(tourTotal) / 360;
      let vzMax = -Infinity, sLat = 0, sLon = 0;
      for (let i = s; i <= e; i++) { if (vz[i] > vzMax) vzMax = vz[i]; sLat += P[i].lat; sLon += P[i].lon; }
      const res = {
        s, e, debut: t[s], duree, altDebut: alt[s], altFin: alt[e], gain,
        vzMoy: gain / duree, vzMax, tours,
        sens: tourTotal < 0 ? 'gauche' : 'droite',
        centre: { lat: sLat / (e - s + 1), lon: sLon / (e - s + 1) },
        tempsTour: tours >= 1 ? duree / tours : null,
        vent: null, vitAir: null, inclinaison: null
      };
      // Vent : dérive mesurée sur un nombre entier de tours
      if (tours >= 1.5) {
        const nbTours = Math.floor(tours);
        let e2 = s;
        while (e2 < e && Math.abs(capD[e2] - capD[s]) < nbTours * 360) e2++;
        const d = t[e2] - t[s];
        if (d > 0) {
          const [dx, dy] = vecteur(P[s], P[e2]);
          const wx = dx / d, wy = dy / d;
          res.vent = { wx, wy, vit: Math.hypot(wx, wy), dir: (Math.atan2(wx, wy) / RAD + 180 + 360) % 360 };
          // Vitesse air = vitesse sol corrigée du vent
          let somme = 0, tt = 0;
          for (let i = s; i < e2; i++) {
            const dt = t[i + 1] - t[i];
            const [vx, vy] = vecteur(P[i], P[i + 1]);
            somme += Math.hypot(vx / dt - wx, vy / dt - wy) * dt;
            tt += dt;
          }
          res.vitAir = somme / tt;
          // Inclinaison : tan(φ) = V·ω / g
          const omega = 2 * Math.PI / (d / nbTours);
          res.inclinaison = Math.atan(res.vitAir * omega / G) / RAD;
        }
      }
      return res;
    }

    // --- Statistiques d'une transition ----------------------------------
    function statsTransition(s, e) {
      const duree = t[e] - t[s];
      const dist = cum[e] - cum[s];
      const directe = distance(P[s], P[e]);
      const perte = alt[s] - alt[e];
      return {
        s, e, debut: t[s], duree, dist, directe, perte,
        altDebut: alt[s], altFin: alt[e],
        finesse: perte > 0 ? dist / perte : Infinity,
        vitesse: dist / duree,
        vzMoy: -perte / duree,
        detour: directe > 50 ? dist / directe : null
      };
    }

    const thermiques = [], transitions = [];
    for (const ph of phases) {
      if (ph.type === 'T') { ph.stats = statsThermique(ph.s, ph.e); thermiques.push(ph.stats); }
      else if (ph.type === 'G') { ph.stats = statsTransition(ph.s, ph.e); transitions.push(ph.stats); }
    }

    // --- Totaux ----------------------------------------------------------
    const somme = (tab, f) => tab.reduce((acc, x) => acc + f(x), 0);
    const tempsApresLargage = Math.max(1, t[atterro] - t[largage]);

    let altMax = -Infinity, altMin = Infinity, distMax = 0;
    for (let i = deco; i <= atterro; i++) {
      if (alt[i] > altMax) altMax = alt[i];
      if (i >= largage && alt[i] < altMin) altMin = alt[i];
      const d = distance(P[deco], P[i]);
      if (d > distMax) distMax = d;
    }

    const tempsSpirale = somme(thermiques, x => x.duree);
    const gainNetThermique = somme(thermiques, x => x.gain);
    const moyennePonderee = (cle) => {
      const v = thermiques.filter(x => x[cle] != null);
      const d = somme(v, x => x.duree);
      return d > 0 ? somme(v, x => x[cle] * x.duree) / d : null;
    };

    // Vent moyen (moyenne vectorielle pondérée par la durée)
    let vent = null;
    {
      const v = thermiques.filter(x => x.vent);
      const d = somme(v, x => x.duree);
      if (d > 0) {
        const wx = somme(v, x => x.vent.wx * x.duree) / d;
        const wy = somme(v, x => x.vent.wy * x.duree) / d;
        vent = { vit: Math.hypot(wx, wy), dir: (Math.atan2(wx, wy) / RAD + 180 + 360) % 360 };
      }
    }

    const candidatsMeilleur = thermiques.filter(x => x.duree >= 60);
    const meilleur = candidatsMeilleur.length
      ? candidatsMeilleur.reduce((a, b) => (b.vzMoy > a.vzMoy ? b : a)) : null;

    const tempsT = tempsSpirale;
    const tempsGauche = somme(thermiques.filter(x => x.sens === 'gauche'), x => x.duree);

    const tempsG = somme(transitions, x => x.duree);
    const distG = somme(transitions, x => x.dist);
    const perteG = somme(transitions, x => x.perte);
    const detours = transitions.filter(x => x.detour != null && x.duree >= 60);

    // Temps passé par taux de montée (en spirale)
    const bornes = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const histo = new Array(bornes.length + 1).fill(0);
    for (const th of thermiques) {
      for (let i = th.s; i < th.e; i++) {
        let b = 0;
        while (b < bornes.length && vz[i] >= bornes[b]) b++;
        histo[b] += (t[i + 1] - t[i]) / 60;
      }
    }

    const totaux = {
      dureeVol: t[atterro] - t[deco],
      heureDeco: t[deco], heureAtterro: t[atterro],
      distanceTrace: cum[atterro] - cum[deco],
      vitesseMoy: (cum[atterro] - cum[largage]) / tempsApresLargage,
      altMax, altMin, altDeco: alt[deco], distMax,
      largage: largage > deco ? { t: t[largage], alt: alt[largage], gain: alt[largage] - alt[deco], duree: t[largage] - t[deco] } : null,

      nbThermiques: thermiques.length,
      tempsSpirale, pctSpirale: tempsSpirale / tempsApresLargage,
      gainThermique: somme(thermiques, x => Math.max(0, x.gain)),
      vzMoyThermique: tempsT > 0 ? gainNetThermique / tempsT : null,
      meilleur,
      pctGauche: tempsT > 0 ? tempsGauche / tempsT : null,
      inclinaisonMoy: moyennePonderee('inclinaison'),
      vitAirSpirale: moyennePonderee('vitAir'),
      tempsTourMoy: moyennePonderee('tempsTour'),
      vent,

      nbTransitions: transitions.length,
      tempsTransition: tempsG,
      distTransition: distG,
      perteTransition: perteG,
      finesseMoy: perteG > 0 ? distG / perteG : Infinity,
      vitTransition: tempsG > 0 ? distG / tempsG : null,
      distMoyTransition: transitions.length ? distG / transitions.length : null,
      vzTransition: tempsG > 0 ? -perteG / tempsG : null,
      detourMoy: detours.length ? somme(detours, x => x.detour * x.duree) / somme(detours, x => x.duree) : null,

      histo: { bornes, minutes: histo },
      repartition: {
        R: largage > deco ? t[largage] - t[deco] : 0,
        T: tempsT,
        G: tempsG
      }
    };

    return {
      entete: vol.entete, date: vol.date, circuitIGC: vol.circuit || [], tempsCircuitIGC: vol.tempsCircuit || null,
      sourceAlt: avecGps ? 'GPS' : 'pression',
      points: P, t, alt, vit, vz, virage, cum,
      deco, atterro, largage, largageAuto, departEnVol,
      phases, phaseDe, thermiques, transitions, totaux
    };
  }

  // =====================================================================
  // 3. CIRCUIT (AAT ou CT)
  // =====================================================================
  // zones : [{ lat, lon, nom, rayon (m) }] — la 1re = départ, la dernière = arrivée
  // CT  : circuit à points de virage. Distance = somme des branches entre centres.
  // AAT : zones à atteindre. On cherche dans chaque zone le point qui donne
  //       la plus grande distance (programmation dynamique), et la vitesse
  //       est calculée sur max(temps réel, temps minimum).

  // Statistiques d'une portion de vol (entre deux indices de points)
  function statsIntervalle(a, s, e) {
    let tempsT = 0, gainT = 0, tempsG = 0, distG = 0, perteG = 0;
    for (const ph of a.phases) {
      const s2 = Math.max(s, ph.s), e2 = Math.min(e, ph.e);
      if (e2 <= s2) continue;
      const dt = a.t[e2] - a.t[s2];
      if (ph.type === 'T') { tempsT += dt; gainT += a.alt[e2] - a.alt[s2]; }
      else if (ph.type === 'G') { tempsG += dt; distG += a.cum[e2] - a.cum[s2]; perteG += a.alt[s2] - a.alt[e2]; }
    }
    const duree = a.t[e] - a.t[s];
    return {
      duree, tempsT, gainT, tempsG, distG, perteG, hDebut: a.alt[s], hFin: a.alt[e],
      vzT: tempsT > 0 ? gainT / tempsT : null,
      pctSpirale: duree > 0 ? tempsT / duree : null,
      finesse: perteG > 0 ? distG / perteG : (distG > 0 ? Infinity : null),
      vitG: tempsG > 0 ? distG / tempsG : null
    };
  }

  // --- Géométrie des zones --------------------------------------------
  // forme : 'cylindre' | 'secteur' | 'ligne'
  // style (SeeYou) : 0 fixe (a12), 1 symétrique, 2 vers le suivant, 3 vers le précédent, 4 vers le départ
  // axe  : direction (°) de la bissectrice du secteur, vers l'extérieur
  // sens : direction de franchissement d'une ligne de départ / d'arrivée
  function preparerZones(zones) {
    const n = zones.length;
    return zones.map((z, k) => {
      const prev = k > 0 ? zones[k - 1] : null, next = k < n - 1 ? zones[k + 1] : null;
      const dirPrev = prev ? cap(z, prev) : null, dirNext = next ? cap(z, next) : null;
      const style = z.style != null ? z.style : (k === 0 ? 2 : k === n - 1 ? 3 : 1);
      let axe;
      if (style === 0 && z.a12 != null) axe = z.a12;
      else if (style === 2 && dirNext != null) axe = dirNext + 180;
      else if (style === 3 && dirPrev != null) axe = dirPrev + 180;
      else if (style === 4 && k > 0) axe = cap(z, zones[0]) + 180;
      else if (dirPrev != null && dirNext != null) axe = dirPrev + ecartAngle(dirNext - dirPrev) / 2 + 180;
      else axe = dirNext != null ? dirNext + 180 : dirPrev != null ? dirPrev + 180 : 0;
      const sens = k === 0 ? (dirNext || 0) : (dirPrev != null ? dirPrev + 180 : 0);
      return Object.assign({}, z, {
        forme: z.forme || 'cylindre',
        demiAngle: z.demiAngle != null ? z.demiAngle : 45,
        axe: ((axe % 360) + 360) % 360,
        sens: ((sens % 360) + 360) % 360
      });
    });
  }

  function contient(z, p) {
    if (z.forme === 'ligne') return false;
    const d = distance(z, p);
    if (z.rayon2 && d <= z.rayon2) {
      if (!z.demiAngle2 || z.demiAngle2 >= 180) return true;
      if (Math.abs(ecartAngle(cap(z, p) - z.axe)) <= z.demiAngle2) return true;
    }
    if (d > z.rayon) return false;
    if (z.forme === 'cylindre' || z.demiAngle >= 180 || d < 1) return true;
    return Math.abs(ecartAngle(cap(z, p) - z.axe)) <= z.demiAngle;
  }

  // Franchissement d'une ligne (longueur 2 × rayon) dans le sens z.sens entre p1 et p2
  function franchitLigne(z, p1, p2) {
    const [x1, y1] = vecteur(z, p1), [x2, y2] = vecteur(z, p2);
    const ux = Math.sin(z.sens * RAD), uy = Math.cos(z.sens * RAD);
    const u1 = x1 * ux + y1 * uy, u2 = x2 * ux + y2 * uy;
    if (!(u1 < 0 && u2 >= 0)) return false;
    const f = u1 / (u1 - u2);
    const vx = x1 + (x2 - x1) * f, vy = y1 + (y2 - y1) * f;
    return Math.abs(vx * uy - vy * ux) <= z.rayon;
  }

  // Contour d'une zone pour l'affichage : liste de [lat, lon]
  function contourZone(z) {
    if (z.forme === 'ligne') {
      const a = destination(z, z.sens - 90, z.rayon), b = destination(z, z.sens + 90, z.rayon);
      return { type: 'ligne', points: [[a.lat, a.lon], [b.lat, b.lon]] };
    }
    if (z.forme === 'cylindre' || z.demiAngle >= 180) {
      return { type: 'cercle', rayon: z.rayon, rayon2: null };
    }
    const pts = [[z.lat, z.lon]];
    for (let ang = -z.demiAngle; ang <= z.demiAngle + 0.01; ang += 3) {
      const q = destination(z, z.axe + ang, z.rayon);
      pts.push([q.lat, q.lon]);
    }
    pts.push([z.lat, z.lon]);
    return { type: 'secteur', points: pts, rayon2: z.rayon2 || null };
  }

  function analyserCircuit(a, zonesBrutes, type, opts) {
    opts = opts || {};
    const nZ = zonesBrutes.length;
    if (nZ < 2) return null;
    const zones = preparerZones(zonesBrutes);
    const P = a.points, t = a.t, debut = a.largage, fin = a.atterro;
    const dedans = (k, i) => contient(zones[k], P[i]);
    // "atteint" : entrée dans la zone, ou franchissement de la ligne d'arrivée
    const atteint = (k, i) => zones[k].forme === 'ligne' ? (i > 0 && franchitLigne(zones[k], P[i - 1], P[i])) : dedans(k, i);
    // Départ : sortie de la zone, ou franchissement de la ligne de départ
    const evDepart = (i) => zones[0].forme === 'ligne' ? franchitLigne(zones[0], P[i], P[i + 1]) : (dedans(0, i) && !dedans(0, i + 1));

    let nominale = 0;
    for (let k = 1; k < nZ; k++) nominale += distance(zones[k - 1], zones[k]);

    const res = {
      type, zones, distanceNominale: nominale, termine: false, nbAtteints: 0,
      evenements: [], chemin: [], branches: [], distance: 0, raison: null
    };

    // --- Départ : dernière sortie du cylindre avant d'entrer dans la zone 1
    let sortie = -1, entree1 = -1;
    for (let i = debut; i < fin; i++) {
      if (evDepart(i)) sortie = i + 1;
      if (sortie >= 0 && i >= sortie && atteint(1, i)) { entree1 = i; break; }
    }

    // Vérification point par point (heure de passage, ou distance manquée)
    const verifier = (ev) => zones.map((z, k) => {
      const e = ev.find(x => x.k === k);
      if (e) return { ok: true, i: e.i, t: t[e.i], alt: a.alt[e.i] };
      const iDeb = ev.length ? ev[ev.length - 1].i : debut;
      let dMin = Infinity, iMin = null;
      for (let i = iDeb; i <= fin; i++) { const d = distance(z, P[i]); if (d < dMin) { dMin = d; iMin = i; } }
      return { ok: false, iProche: iMin, dMin, manque: Math.max(0, dMin - z.rayon) };
    });

    if (sortie < 0) {
      res.raison = zones[0].forme === 'ligne'
        ? 'Départ non validé : la ligne de départ n\'est jamais franchie dans le bon sens'
        : 'Départ non validé : le planeur ne sort jamais de la zone de départ';
      res.verification = verifier([]);
      return res;
    }

    // --- Zones suivantes, dans l'ordre
    const ev = [{ k: 0, i: sortie }];
    if (entree1 >= 0) {
      ev.push({ k: 1, i: entree1 });
      let prec = entree1;
      for (let k = 2; k < nZ; k++) {
        let trouve = -1;
        for (let i = prec + 1; i <= fin; i++) if (atteint(k, i)) { trouve = i; break; }
        if (trouve < 0) break;
        ev.push({ k, i: trouve });
        prec = trouve;
      }
    }
    res.evenements = ev;
    res.nbAtteints = ev.length;
    res.termine = ev.length === nZ;
    const iDep = sortie;
    const iArr = res.termine ? ev[nZ - 1].i : null;
    const iBorne = res.termine ? iArr : fin;

    // --- Chemin retenu pour la distance
    let chemin;
    if (type === 'AAT') {
      const nbZones = Math.min(ev.length, nZ - 1) - 1; // zones intermédiaires atteintes
      let prec = [{ lat: zones[0].lat, lon: zones[0].lon, i: iDep, d: 0, parent: null }];
      for (let k = 1; k <= nbZones; k++) {
        const liste = [];
        for (let i = ev[k].i; i <= iBorne; i++) if (dedans(k, i)) liste.push(i);
        const pas = Math.max(1, Math.ceil(liste.length / 500));
        const cand = [];
        for (let q = 0; q < liste.length; q += pas) {
          const i = liste[q];
          let meilleur = null, dMax = -1;
          for (const p of prec) {
            if (p.i > i) continue;
            const d = p.d + distance(p, P[i]);
            if (d > dMax) { dMax = d; meilleur = p; }
          }
          if (meilleur) cand.push({ lat: P[i].lat, lon: P[i].lon, i, d: dMax, parent: meilleur });
        }
        if (!cand.length) break;
        prec = cand;
      }
      let dernier;
      if (res.termine) {
        const Z = zones[nZ - 1];
        let meilleur = null, dMax = -1;
        for (const p of prec) {
          if (p.i > iArr) continue;
          const d = p.d + distance(p, Z);
          if (d > dMax) { dMax = d; meilleur = p; }
        }
        dernier = { lat: Z.lat, lon: Z.lon, i: iArr, d: dMax, parent: meilleur };
      } else {
        dernier = prec.reduce((x, y) => (y.d > x.d ? y : x));
      }
      chemin = [];
      for (let p = dernier; p; p = p.parent) chemin.unshift({ lat: p.lat, lon: p.lon, i: p.i });
    } else {
      chemin = ev.map(x => ({ lat: zones[x.k].lat, lon: zones[x.k].lon, i: x.i }));
    }
    res.chemin = chemin;

    let dist = 0;
    for (let k = 1; k < chemin.length; k++) dist += distance(chemin[k - 1], chemin[k]);

    // Circuit non terminé : on ajoute la progression vers la zone suivante
    if (!res.termine) {
      const suivante = zones[chemin.length];
      const der = chemin[chemin.length - 1];
      if (suivante) {
        const dRef = distance(der, suivante);
        let dMin = dRef;
        for (let i = der.i; i <= fin; i++) { const d = distance(P[i], suivante); if (d < dMin) dMin = d; }
        res.partiel = Math.max(0, dRef - dMin);
        dist += res.partiel;
      }
      res.raison = res.nbAtteints === 1
        ? `Zone « ${zones[1].nom} » jamais atteinte`
        : `Zone « ${zones[res.nbAtteints].nom} » jamais atteinte`;
    }
    res.distance = dist;

    // --- Temps et vitesse
    res.tDepart = t[iDep];
    res.altDepart = a.alt[iDep];
    res.tArrivee = res.termine ? t[iArr] : null;
    res.duree = (res.termine ? t[iArr] : t[fin]) - t[iDep];
    res.tempsMini = type === 'AAT' ? (opts.tempsMini || 0) : 0;
    res.tempsCompte = res.termine ? Math.max(res.duree, res.tempsMini) : res.duree;
    res.vitesse = res.termine && res.tempsCompte > 0 ? dist / res.tempsCompte : null;
    res.global = statsIntervalle(a, iDep, iBorne);
    res.verification = verifier(ev);
    if (type === 'AAT') {
      chemin.forEach((p, k) => { if (res.verification[k]) res.verification[k].tRetenu = t[p.i]; });
    }

    // --- Branches
    for (let k = 1; k < chemin.length; k++) {
      const s = chemin[k - 1].i, e = chemin[k].i;
      const d = distance(chemin[k - 1], chemin[k]);
      const st = statsIntervalle(a, s, e);
      res.branches.push(Object.assign({
        de: zones[k - 1].nom, a: zones[k].nom, s, e, debut: t[s], dist: d,
        vitesse: st.duree > 0 ? d / st.duree : null
      }, st));
    }
    return res;
  }

  // =====================================================================
  // 4. GAINS ET PERTES DE TEMPS
  // =====================================================================
  // Principe (théorie de MacCready) : une hauteur perdue devra être
  // regagnée en thermique au taux de référence MC. Donc :
  //   - thermique  : gain de temps = hauteur gagnée / MC − durée
  //                  (négatif si on monte moins vite que MC)
  //   - transition : temps équivalent = durée + hauteur perdue / MC
  //                  vitesse équivalente = distance en ligne droite / temps équivalent
  //                  gain de temps = distance / Vréf − temps équivalent
  //     où Vréf est ta vitesse équivalente moyenne sur toutes les transitions.
  // En plus : temps perdu au centrage, en sortie tardive, en spirales sans gain
  // et en détours.
  function analyserTemps(a, opts) {
    opts = opts || {};
    const t = a.t, alt = a.alt, P = a.points;
    const mc = opts.mc > 0 ? opts.mc : Math.max(0.5, a.totaux.vzMoyThermique || 1.5);
    const altArr = alt[a.atterro];
    const segs = [];
    const derniereG = [...a.phases].reverse().find(p => p.type === 'G');

    // Vz local à l'intérieur d'un thermique (fenêtre ±10 s, bornée au thermique)
    const vzLocal = (s, e, i) => {
      let lo = i, hi = i;
      while (lo > s && t[i] - t[lo - 1] <= 10) lo--;
      while (hi < e && t[hi + 1] - t[i] <= 10) hi++;
      return hi > lo ? (alt[hi] - alt[lo]) / (t[hi] - t[lo]) : 0;
    };

    let kT = 0, kG = 0;
    for (const ph of a.phases) {
      if (ph.type === 'T') {
        const st = ph.stats, k = kT++;
        const seg = {
          type: 'T', k, s: ph.s, e: ph.e, debut: st.debut, duree: st.duree,
          hauteur: st.gain, vz: st.vzMoy, gain: st.gain / mc - st.duree,
          sansGain: st.gain < 30, centrage: 0, sortie: 0
        };
        const vzTh = st.vzMoy;
        if (!seg.sansGain && vzTh > 0.3) {
          // Centrage : jusqu'à ce que le Vz atteigne 80 % du Vz moyen du thermique
          let c = ph.s;
          while (c < ph.e && vzLocal(ph.s, ph.e, c) < 0.8 * vzTh) c++;
          const dc = t[c] - t[ph.s];
          if (dc >= 10 && c < ph.e) {
            seg.centrage = Math.max(0, dc - Math.max(0, alt[c] - alt[ph.s]) / vzTh);
            seg.iCentrage = c;
          }
          // Sortie tardive : fin du thermique où le Vz est sous 50 % de la moyenne
          let f = ph.e;
          while (f > ph.s && vzLocal(ph.s, ph.e, f) < 0.5 * vzTh) f--;
          const df = t[ph.e] - t[f];
          if (df >= 20 && f > ph.s) {
            seg.sortie = Math.max(0, df - Math.max(0, alt[ph.e] - alt[f]) / vzTh);
            seg.iSortie = f;
          }
        }
        segs.push(seg);
      } else if (ph.type === 'G') {
        const k = kG++;
        let e = ph.e;
        // Dernière transition : on s'arrête à 250 m au-dessus du terrain (tour de piste exclu)
        if (ph === derniereG && ph.e === a.atterro) {
          let c = ph.s;
          while (c < ph.e && alt[c] > altArr + 250) c++;
          if (t[c] - t[ph.s] > 30) e = c;
        }
        const duree = t[e] - t[ph.s];
        if (duree < 15) continue;
        const dist = a.cum[e] - a.cum[ph.s];
        // Distance "utile" : somme des lignes droites sur des tranches de 60 s.
        // Les zigzags comptent comme détour, mais pas un virage à un point de virage.
        let directe = 0;
        for (let i0 = ph.s; i0 < e;) {
          let i1 = i0;
          while (i1 < e && t[i1] - t[i0] < 60) i1++;
          directe += distance(P[i0], P[i1]);
          i0 = i1;
        }
        const perte = alt[ph.s] - alt[e];
        const tEq = duree + perte / mc;
        segs.push({
          type: 'G', k, s: ph.s, e, debut: t[ph.s], duree, dist, directe, perte, tEq,
          vEq: tEq > 0 ? directe / tEq : null,
          vitesse: dist / duree,
          finesse: perte > 0 ? dist / perte : Infinity,
          detour: dist > 0 ? duree * (1 - directe / dist) : 0
        });
      }
    }

    const transitions = segs.filter(x => x.type === 'G');
    const sd = transitions.reduce((s, x) => s + x.directe, 0);
    const st = transitions.reduce((s, x) => s + x.tEq, 0);
    const vRef = st > 0 ? sd / st : null;
    for (const x of transitions) x.gain = vRef ? x.directe / vRef - x.tEq : 0;

    const somme = (liste, f) => liste.reduce((s, x) => s + f(x), 0);
    const thermiques = segs.filter(x => x.type === 'T');
    const sansGain = thermiques.filter(x => x.sansGain);
    const resume = {
      mc, vRef,
      thermGagne: somme(thermiques, x => Math.max(0, x.gain)),
      thermPerdu: somme(thermiques, x => Math.min(0, x.gain)),
      transGagne: somme(transitions, x => Math.max(0, x.gain)),
      transPerdu: somme(transitions, x => Math.min(0, x.gain)),
      centrage: somme(thermiques, x => x.centrage),
      sortie: somme(thermiques, x => x.sortie),
      nbSansGain: sansGain.length,
      tempsSansGain: somme(sansGain, x => x.duree),
      detour: somme(transitions, x => x.detour)
    };
    const tries = [...segs].sort((x, y) => x.gain - y.gain);
    return {
      mc, vRef, segments: segs, resume,
      pertes: tries.filter(x => x.gain < -15).slice(0, 5),
      gains: tries.filter(x => x.gain > 15).reverse().slice(0, 5)
    };
  }

  // =====================================================================
  // 5. COMPARAISON DE DEUX VOLS
  // =====================================================================
  // Progression sur le circuit : pour chaque point, part du circuit déjà faite (0 → 1).
  // Le chemin de référence est celui que le pilote a réellement validé
  // (centres en CT, points retenus dans les zones en AAT), complété par les
  // centres des zones qu'il n'a pas atteintes.
  // restant = distance jusqu'au prochain point du chemin + branches suivantes.
  // ---------------------------------------------------------------------
  // Analyse des pompes (thermiques après le départ)
  //   vzPompe   : force réelle de la pompe une fois centrée = meilleur Vz moyen sur
  //               ~2 tours (au moins 40 s) dans le thermique
  //   centrage  : temps depuis l'entrée jusqu'à ce que le Vz sur un tour atteigne 90 % de vzPompe
  //   (Vz calculés en énergie totale pour ne pas compter la ressource d'entrée comme de la montée)
  //   mcTheo    : MC atteignable = vzPompe (si on avait monté à fond dès l'entrée)
  //   mcReel    : Vz réellement obtenu = gain / durée totale (centrage et sortie compris)
  //   perdu     : temps perdu par rapport à une montée à vzPompe = durée − gain / vzPompe
  // ---------------------------------------------------------------------
  function analyserPompes(a, circ) {
    const t = a.t, P = a.points, n = t.length;
    // Altitude « énergie totale » : h + v²/2g. Sans ça, la ressource à l'entrée du thermique
    // (on ralentit de 160 à 100 km/h = +60 à 80 m en quelques secondes) passe pour une pompe
    // déjà centrée. v = vitesse sol lissée sur ±3 s (en spirale, le vent se compense sur un tour).
    const alt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let lo = i, hi = i;
      while (lo > 0 && t[i] - t[lo - 1] <= 3) lo--;
      while (hi < n - 1 && t[hi + 1] - t[i] <= 3) hi++;
      const v = hi > lo ? distance(P[lo], P[hi]) / (t[hi] - t[lo]) : 0;
      alt[i] = a.alt[i] + v * v / (2 * G);
    }
    const tDep = circ && circ.tDepart != null ? circ.tDepart : null;
    const tFin = circ && circ.tArrivee != null ? circ.tArrivee : Infinity;
    const vzFenetre = (s, e, i, d) => {      // Vz moyen sur [t_i, t_i + d] borné au thermique
      let j = i;
      while (j < e && t[j] - t[i] < d) j++;
      return t[j] - t[i] >= d * 0.8 ? (alt[j] - alt[i]) / (t[j] - t[i]) : null;
    };
    const pompes = [];
    for (const th of a.thermiques) {
      if (tDep != null && th.debut < tDep) continue;
      if (th.debut > tFin || th.gain < 50 || th.duree < 40) continue;
      const s = th.s, e = th.e;
      const tour = th.tempsTour && th.tempsTour > 12 && th.tempsTour < 60 ? th.tempsTour : 25;
      const dLong = Math.min(th.duree, Math.max(40, 2 * tour));
      let vzPompe = -Infinity, iMax = s;
      for (let i = s; i <= e; i++) {
        if (t[e] - t[i] < dLong * 0.8) break;
        const v = vzFenetre(s, e, i, dLong);
        if (v != null && v > vzPompe) { vzPompe = v; iMax = i; }
      }
      if (!(vzPompe > 0.2)) vzPompe = Math.max(0.2, th.vzMoy);
      vzPompe = Math.min(vzPompe, Math.max(th.vzMax, th.vzMoy));      // garde-fou contre un pic de vitesse
      // centrage : premier tour (glissant) où l'on monte à 90 % de la valeur de la pompe
      const vzTour1 = vzFenetre(s, e, s, tour);
      let c = s;
      while (c < e) {
        const v = vzFenetre(s, e, c, tour);
        if (v != null && v >= 0.9 * vzPompe) break;
        c++;
      }
      const centrage = Math.max(0, t[c] - t[s]);
      const mcReel = th.gain / th.duree;
      pompes.push({
        k: a.thermiques.indexOf(th), s, e, debut: th.debut, duree: th.duree, gain: th.gain,
        altDebut: th.altDebut, altFin: th.altFin, centre: th.centre,
        vzPompe, mcTheo: vzPompe, mcReel, centrage, iCentre: c, iMax, vzTour1, tour,
        perdu: Math.max(0, th.duree - th.gain / vzPompe),
        efficacite: mcReel / vzPompe
      });
    }
    const somme = (f) => pompes.reduce((x, p) => x + f(p), 0);
    const gain = somme(p => p.gain), duree = somme(p => p.duree);
    const resume = pompes.length ? {
      nb: pompes.length, gain, duree,
      mcReel: gain / duree,                                  // Vz moyen réellement obtenu en spirale
      mcTheo: gain / somme(p => p.gain / p.vzPompe),         // Vz moyen si chaque pompe était prise centrée dès l'entrée
      centrage: somme(p => p.centrage), perdu: somme(p => p.perdu),
      apresDepart: tDep != null
    } : null;
    return { pompes, resume };
  }

  function progression(a, circ) {
    if (!circ || !circ.nbAtteints || !circ.chemin.length) return null;
    const P = a.points, n = P.length;
    const chemin = circ.chemin.map(p => ({ lat: p.lat, lon: p.lon, i: p.i }));
    for (let k = chemin.length; k < circ.zones.length; k++) {
      chemin.push({ lat: circ.zones[k].lat, lon: circ.zones[k].lon, i: Infinity });
    }
    const m = chemin.length;
    const reste = new Float64Array(m);
    for (let j = m - 2; j >= 0; j--) reste[j] = reste[j + 1] + distance(chemin[j], chemin[j + 1]);
    const L = reste[0];
    const iDep = chemin[0].i;
    const iFin = circ.termine ? chemin[m - 1].i : a.atterro;
    const f = new Float64Array(n);      // progression brute
    const env = new Float64Array(n);    // progression déjà acquise (maximum atteint jusque-là)
    let j = 1, max = 0;
    for (let i = 0; i < n; i++) {
      if (i < iDep) { f[i] = 0; env[i] = 0; continue; }
      if (circ.termine && i >= iFin) { f[i] = 1; max = 1; env[i] = 1; continue; }
      while (j < m - 1 && chemin[j].i <= i) j++;
      const restant = distance(P[i], chemin[j]) + reste[j];
      f[i] = Math.max(0, Math.min(1, (L - restant) / L));
      if (f[i] > max) max = f[i];
      env[i] = max;
    }
    return { f, env, L, iDep, iFin, termine: circ.termine, chemin };
  }

  // Série temporelle d'un pilote, avec une origine de temps (son départ ou minuit)
  function serie(a, pr, origine) {
    return { a, pr, origine, tDep: a.t[pr.iDep] - origine, tFin: a.t[pr.iFin] - origine };
  }

  function indiceAuTemps(a, t) {
    const T = a.t;
    if (t <= T[0]) return 0;
    if (t >= T[T.length - 1]) return T.length - 1;
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (T[mi] <= t) lo = mi; else hi = mi; }
    return lo;
  }

  // État d'un pilote au temps τ (dans son repère) ; après l'arrivée on garde l'état d'arrivée
  function etatAu(S, tau) {
    const a = S.a, fini = S.pr.termine && tau >= S.tFin;
    const tt = (fini ? S.tFin : tau) + S.origine;
    const i = indiceAuTemps(a, tt);
    const i2 = Math.min(i + 1, a.t.length - 1);
    const r = i2 > i ? Math.max(0, Math.min(1, (tt - a.t[i]) / (a.t[i2] - a.t[i]))) : 0;
    return {
      i, fini,
      f: S.pr.env[i] + (S.pr.env[i2] - S.pr.env[i]) * r,
      h: a.alt[i] + (a.alt[i2] - a.alt[i]) * r
    };
  }

  // Premier instant où le pilote a atteint la progression f (et son altitude à ce moment)
  function quandProgression(S, f) {
    const a = S.a, env = S.pr.env;
    let lo = S.pr.iDep, hi = S.pr.iFin;
    if (env[hi] < f) return null;
    if (env[lo] >= f) return { tau: a.t[lo] - S.origine, h: a.alt[lo], i: lo };
    while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (env[mi] >= f) hi = mi; else lo = mi; }
    const r = env[hi] > env[lo] ? (f - env[lo]) / (env[hi] - env[lo]) : 1;
    return {
      tau: a.t[lo] + (a.t[hi] - a.t[lo]) * r - S.origine,
      h: a.alt[lo] + (a.alt[hi] - a.alt[lo]) * r,
      i: hi
    };
  }

  // Avance de A sur B au temps τ (s). Positif = A devant.
  // On compare à même position sur le circuit : le retardataire passe là où le leader
  // était plus tôt. Écart de temps + écart d'altitude converti en temps (hauteur / MC).
  function avanceAu(SA, SB, tau, mc) {
    const eA = etatAu(SA, tau), eB = etatAu(SB, tau);
    if (eA.f <= 0 && eB.f <= 0) return { brut: 0, comp: 0, eA, eB };
    const devantA = eA.f >= eB.f;
    const [Sl, et] = devantA ? [SA, eB] : [SB, eA];       // leader, état du retardataire
    const Sr = devantA ? SB : SA;
    const q = quandProgression(Sl, et.f);
    if (!q) return { brut: 0, comp: 0, eA, eB };
    const tRetard = et.fini ? Sr.tFin : tau;
    const brut = tRetard - q.tau;
    const comp = brut + (et.fini || et.f <= 0 ? 0 : (q.h - et.h) / mc);
    return { brut: devantA ? brut : -brut, comp: devantA ? comp : -comp, eA, eB };
  }

  function comparerVols(A, B, opts) {
    opts = opts || {};
    const prA = progression(A.a, A.circ), prB = progression(B.a, B.circ);
    if (!prA || !prB) {
      return { erreur: !prA && !prB ? 'Aucun des deux vols ne prend le départ du circuit.'
        : `Le vol ${!prA ? 'A' : 'B'} ne prend pas le départ du circuit.` };
    }
    const mc = opts.mc > 0 ? opts.mc : 1.5;
    const course = opts.alignement !== 'reel';
    const SA = serie(A.a, prA, course ? A.a.t[prA.iDep] : 0);
    const SB = serie(B.a, prB, course ? B.a.t[prB.iDep] : 0);

    // --- Avance / retard en continu
    const tMin = course ? 0 : Math.min(SA.tDep, SB.tDep) - 120;
    const tMax = Math.max(SA.tFin, SB.tFin) + (course ? 60 : 120);
    const pas = Math.max(5, Math.ceil((tMax - tMin) / 1500));
    const grille = [];
    for (let tau = tMin; tau <= tMax; tau += pas) {
      const r = avanceAu(SA, SB, tau, mc);
      grille.push({ tau, comp: r.comp, brut: r.brut, fA: r.eA.f, fB: r.eB.f, hA: r.eA.h, hB: r.eB.h, iA: r.eA.i, iB: r.eB.i });
    }

    // --- Points du circuit : temps de passage et avance au point
    const points = [];
    const nP = Math.min(prA.chemin.length, prB.chemin.length);
    for (let k = 0; k < nP; k++) {
      const ia = prA.chemin[k].i, ib = prB.chemin[k].i;
      if (!isFinite(ia) || !isFinite(ib)) break;
      const tA = A.a.t[ia] - SA.origine, tB = B.a.t[ib] - SB.origine;
      const fin = k === nP - 1 && prA.termine && prB.termine;
      const hA = A.a.alt[ia], hB = B.a.alt[ib];
      points.push({ k, tA, tB, hA, hB, ia, ib, comp: (tB - tA) + (fin || k === 0 ? 0 : (hA - hB) / mc) });
    }
    const branches = [];
    for (let k = 1; k < points.length; k++) {
      const p0 = points[k - 1], p1 = points[k];
      const dA = distance(prA.chemin[k - 1], prA.chemin[k]), dB = distance(prB.chemin[k - 1], prB.chemin[k]);
      const durA = p1.tA - p0.tA, durB = p1.tB - p0.tB;
      const sA = statsIntervalle(A.a, p0.ia, p1.ia), sB = statsIntervalle(B.a, p0.ib, p1.ib);
      branches.push({
        k, durA, durB, dA, dB, vA: dA / durA, vB: dB / durB,
        vzA: sA.vzT, vzB: sB.vzT, ecart: durB - durA, avanceAuPoint: p1.comp
      });
    }

    // --- Qui gagne grâce à quoi : décomposition sur la partie commune du circuit
    const fc = Math.min(prA.env[prA.iFin], prB.env[prB.iFin]);
    let bilan = null;
    if (fc > 0.05) {
      const mesure = (S) => {
        const q = quandProgression(S, fc);
        const e = Math.max(S.pr.iDep + 1, q.i);
        const st = statsIntervalle(S.a, S.pr.iDep, e);
        const D = fc * S.pr.L;
        const nbTh = S.a.thermiques.filter(x => x.s >= S.pr.iDep && x.s < e && x.gain > 0).length;
        return {
          e, D, duree: st.duree, st, nbTh,
          k: st.distG / D,
          vg: st.tempsG > 0 ? st.distG / st.tempsG : 30,
          ld: st.perteG > 1 ? Math.min(200, st.distG / st.perteG) : 200,
          vz: st.tempsT > 0 && st.gainT > 0 ? Math.max(0.1, st.gainT / st.tempsT) : 0.1,
          e2: (st.hFin - st.hDebut) / D,
          vitesse: D / st.duree
        };
      };
      const mA = mesure(SA), mB = mesure(SB);
      const Dref = (mA.D + mB.D) / 2;
      const F = (x) => Dref * (x.k / x.vg + (x.k / x.ld + x.e2) / x.vz);
      const facteurs = ['vz', 'vg', 'ld', 'k', 'e2'];
      const fact = [1, 1, 2, 6, 24, 120];
      const nF = facteurs.length;
      const parts = {};
      for (let q = 0; q < nF; q++) {
        let phi = 0;
        for (let masque = 0; masque < (1 << nF); masque++) {
          if (masque & (1 << q)) continue;
          let s = 0;
          const x0 = {}, x1 = {};
          for (let r = 0; r < nF; r++) {
            const deA = (masque & (1 << r)) !== 0;
            if (deA) s++;
            x0[facteurs[r]] = deA ? mA[facteurs[r]] : mB[facteurs[r]];
            x1[facteurs[r]] = (deA || r === q) ? mA[facteurs[r]] : mB[facteurs[r]];
          }
          phi += fact[s] * fact[nF - s - 1] / fact[nF] * (F(x1) - F(x0));
        }
        parts[facteurs[q]] = -phi; // secondes gagnées par A grâce à ce facteur
      }
      const memeDistance = Math.abs(mA.D - mB.D) < 0.002 * Dref;
      bilan = {
        fc, Dref, mA, mB, parts, memeDistance,
        total: F(mB) - F(mA), // secondes gagnées par A (à distance égale)
        vitesseA: mA.vitesse, vitesseB: mB.vitesse
      };
    }

    return { SA, SB, prA, prB, mc, course, pas, grille, points, branches, bilan };
  }

  // =====================================================================
  // 6. VOL DE DÉMONSTRATION (simulé, pour tester sans fichier)
  // =====================================================================
  // opts : graine (vol différent), pilote, immat, concours, decalage (s),
  //        vTransition (m/s air), zigzag (° d'écart de cap en transition), bonusVz (m/s)
  function genererVolDemo(opts) {
    const o = Object.assign({ graine: 7, pilote: 'Pilote Demo', immat: 'F-CDEM', concours: 'DM',
      decalage: 0, vTransition: 36, zigzag: 0, bonusVz: 0 }, opts || {});
    let graine = o.graine;
    const alea = () => { graine = (graine * 16807) % 2147483647; return graine / 2147483647; };
    const SOL = 270;
    const maison = { lat: 43.737, lon: 5.784 };
    const ventDe = 300 * RAD, ventV = 15 / 3.6;
    const wx = -Math.sin(ventDe) * ventV, wy = -Math.cos(ventDe) * ventV;

    let lat = maison.lat, lon = maison.lon, alt = SOL, t = 11 * 3600 + 2 * 60 + o.decalage, capDeg = 300;
    const lignes = [
      'AXXXDEMO',
      'HFDTEDATE:120726,01',
      'HFPLTPILOTINCHARGE:' + o.pilote,
      'HFGTYGLIDERTYPE:Discus 2b',
      'HFGIDGLIDERID:' + o.immat,
      'HFCIDCOMPETITIONID:' + o.concours,
      'C120726105500120726000102Circuit demo',
      'C4344220N00547040EVinon',
      'C4344220N00547040EVinon',
      'C4403000N00555800ETP1 Sisteron Est',
      'C4351000N00618000ETP2 Riez',
      'C4344220N00547040EVinon',
      'C4344220N00547040EVinon',
      'LSEEYOU OZ=-1,Style=2,R1=5000m,A1=180,Line=1',
      'LSEEYOU OZ=0,Style=1,R1=15000m,A1=180',
      'LSEEYOU OZ=1,Style=1,R1=8000m,A1=180',
      'LSEEYOU OZ=2,Style=3,R1=3000m,A1=180',
      'LSEEYOU TSK,NoStart=13:00:00,TaskTime=01:00:00,WpDis=False'
    ];
    const p2 = n => String(n).padStart(2, '0');
    const coord = (v, nbDeg) => {
      const a = Math.abs(v);
      let deg = Math.floor(a);
      let mil = Math.round((a - deg) * 60 * 1000);
      if (mil >= 60000) { deg++; mil -= 60000; }
      return String(deg).padStart(nbDeg, '0') + String(mil).padStart(5, '0');
    };
    const enregistrer = () => {
      if (t % 2 !== 0) return;
      const s = t % 86400;
      const altG = Math.round(alt + (alea() - 0.5) * 4);
      lignes.push('B' + p2(Math.floor(s / 3600)) + p2(Math.floor(s % 3600 / 60)) + p2(s % 60) +
        coord(lat, 2) + 'N' + coord(lon, 3) + 'EA' +
        String(Math.max(0, Math.round(alt - 15))).padStart(5, '0') + String(Math.max(0, altG)).padStart(5, '0'));
    };
    const avancer = (vAir, vzv, avecVent = true) => {
      const c = capDeg * RAD;
      const vx = Math.sin(c) * vAir + (avecVent ? wx : 0);
      const vy = Math.cos(c) * vAir + (avecVent ? wy : 0);
      lat += vy / R_TERRE / RAD;
      lon += vx / (R_TERRE * Math.cos(lat * RAD)) / RAD;
      alt += vzv;
      t += 1;
      enregistrer();
    };
    const tournerVers = (cible, max) => { capDeg += Math.max(-max, Math.min(max, ecartAngle(cible - capDeg))); };

    // Au sol puis roulage
    for (let i = 0; i < 30; i++) { t++; enregistrer(); }
    for (let i = 0; i < 25; i++) avancer(i * 1.2, 0, false);
    // Remorqué
    for (let i = 0; i < 420; i++) {
      if (i > 120 && i < 240) capDeg += 1;
      avancer(32, 2.8 + (alea() - 0.5) * 0.6);
    }

    const avantDepart = destination(maison, cap(maison, { lat: 44.05, lon: 5.93 }) + 180, 3000);
    const cibles = [
      { lat: avantDepart.lat, lon: avantDepart.lon, seuil: 800 }, // derrière la ligne de départ
      { lat: 44.05, lon: 5.93, seuil: 300 },                 // TP1
      { lat: 43.85, lon: 6.30, seuil: 300 },                 // TP2
      { lat: maison.lat, lon: maison.lon, seuil: 2000 }      // arrivée
    ];
    let k = 0, garde = 0;
    while (k < cibles.length && garde++ < 40) {
      // Transition
      while (true) {
        const ici = { lat, lon };
        const d = distance(ici, cibles[k]);
        if (d < cibles[k].seuil) { k++; if (k >= cibles.length) break; continue; }
        const final = k === cibles.length - 1;
        if ((!final && alt < 1000 + alea() * 200) || (final && alt < SOL + 300 + d / 25)) break;
        tournerVers(cap(ici, cibles[k]) + o.zigzag * Math.sin(t / 90), 3);
        avancer(o.vTransition, -1.3 * Math.pow(o.vTransition / 36, 2) + 0.6 * Math.sin(t / 40) + (alea() - 0.5) * 0.4);
      }
      if (k >= cibles.length) break;
      // Thermique
      const fort = 1.5 + alea() * 2.2 + o.bonusVz;
      const sens = alea() < 0.6 ? 1 : -1;
      const dMaison = distance({ lat, lon }, maison);
      let sommet = 1900 + alea() * 400;
      if (k === cibles.length - 1) sommet = Math.max(sommet, SOL + 450 + dMaison / 25);
      let tt = 0;
      while (alt < sommet && tt < 3000) {
        capDeg += sens * 18;
        const entree = Math.min(1, tt / 25);
        avancer(25, fort * entree + 0.7 * Math.sin(capDeg * RAD) + (alea() - 0.5) * 0.6 - 0.3 * (1 - entree));
        tt++;
      }
    }
    // Approche et atterrissage
    while (alt > SOL + 2) { capDeg += 2; avancer(28, -2.4); }
    alt = SOL;
    for (let i = 0; i < 25; i++) avancer(25 - i, 0, false);
    for (let i = 0; i < 40; i++) { t++; enregistrer(); }
    return lignes.join('\r\n');
  }

  const IGC = {
    lire, analyser, analyserCircuit, analyserTemps, analyserPompes, statsIntervalle, genererVolDemo,
    progression, comparerVols, avanceAu, etatAu,
    preparerZones, contourZone, contient, destination, REGLAGES, distance
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = IGC;
  else global.IGC = IGC;
})(typeof window !== 'undefined' ? window : globalThis);
