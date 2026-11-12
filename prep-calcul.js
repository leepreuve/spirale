// Spirale — Préparation : calcul du trajet optimal (tourne dans un Web Worker)
// Portage JavaScript du modèle MATLAB (optimiserTrajet2D) :
//   état = (branche, nœud, altitude) ; actions : monter, transiter, valider le point suivant ;
//   relief + marges, plafond et Vz par zone, cheminement en ligne droite, points de passage.
'use strict';

const RT = 6371000;
let C = null;               // circuit chargé : { id, D, relief }

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'charger') {
      C = { id: m.D.id, D: m.D, relief: preparerRelief(m.D.relief, new Int16Array(m.relief)) };
      self.postMessage({ type: 'charge', id: C.id });
    } else if (m.type === 'calculer') {
      const t0 = performance.now();
      let r = calculer(C, m.P, m.zones, m.exclusions || []);
      if (!r.ok && m.P.couloir < 25) {          // pas de trajet : on élargit le couloir (contourner un parc, une vallée…)
        progression('Aucun trajet dans le couloir de 15 km : élargissement à 25 km…');
        r = calculer(C, { ...m.P, couloir: 25 }, m.zones, m.exclusions || []);
        r.couloirElargi = true;
      }
      r.dureeCalcul = (performance.now() - t0) / 1000;
      r.id = C.id;
      self.postMessage({ type: 'resultat', r });
    }
  } catch (err) {
    self.postMessage({ type: 'erreur', message: String(err && err.stack || err) });
  }
};

function progression(texte) { self.postMessage({ type: 'progression', texte }); }

// ---------------------------------------------------------------- relief
function preparerRelief(R, Z) {
  // grille d'origine : lat (non uniforme, croissante) × lon ; on la rééchantillonne en lat uniforme
  const nLat = R.nLat, nLon = R.nLon, lat = R.lat, lon = R.lon;
  const latMin = lat[0], latMax = lat[nLat - 1], dLat = (latMax - latMin) / (nLat - 1);
  const lonMin = lon[0], dLon = (lon[nLon - 1] - lon[0]) / (nLon - 1);
  const U = new Float32Array(nLat * nLon);
  let k = 0;
  for (let i = 0; i < nLat; i++) {
    const la = latMin + i * dLat;
    while (k < nLat - 2 && lat[k + 1] < la) k++;
    const f = Math.min(1, Math.max(0, (la - lat[k]) / (lat[k + 1] - lat[k])));
    for (let j = 0; j < nLon; j++) U[i * nLon + j] = Z[k * nLon + j] * (1 - f) + Z[(k + 1) * nLon + j] * f;
  }
  return { U, nLat, nLon, latMin, dLat, lonMin, dLon };
}

function sol(rel, la, lo) {
  let fi = (la - rel.latMin) / rel.dLat, fj = (lo - rel.lonMin) / rel.dLon;
  fi = Math.min(rel.nLat - 1.0001, Math.max(0, fi)); fj = Math.min(rel.nLon - 1.0001, Math.max(0, fj));
  const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, n = rel.nLon, U = rel.U;
  return (U[i * n + j] * (1 - b) + U[i * n + j + 1] * b) * (1 - a) + (U[(i + 1) * n + j] * (1 - b) + U[(i + 1) * n + j + 1] * b) * a;
}

// ---------------------------------------------------------------- polaire (Diana 2, provisoire)
// Diana 2 ; k = facteur de charge (1,18 = ballastée, calé sur les vols Condor : vitesses et chutes × √charge)
function polaire(k = 1) {
  const v = [90, 130, 180].map(x => x * k / 3.6), w = [0.58, 0.85, 1.75].map(x => x * k);
  // parabole passant par les 3 points : w = a v² + b v + c
  const M = v.map(x => [x * x, x, 1]);
  const s = resoudre3(M, w);
  const [a, b, c] = s;
  return {
    a, b, c,
    chute: (x) => a * x * x + b * x + c,
    vitesseMC: (mc) => Math.sqrt(Math.max(0, c + mc) / a),
    vFinesseMax: Math.sqrt(c / a),
  };
}
function resoudre3(M, y) {
  const A = M.map((r, i) => [...r, y[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = 0; k < 3; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]; }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// ---------------------------------------------------------------- zones météo
function melangeZones(zones, champ) {
  return (la, lo) => {
    let sw = 0, sv = 0;
    for (const z of zones) {
      const dk = Math.hypot((la - z.lat) * 111.2, (lo - z.lon) * 111.2 * Math.cos(la * Math.PI / 180)) + 1;
      const w = 1 / (dk * dk * dk * dk);
      sw += w; sv += w * z[champ];
    }
    return sv / sw;
  };
}

function quantile(arr, p) {   // même convention que MATLAB : positions (i - 0.5) / n
  const s = Float64Array.from(arr).sort(), n = s.length;
  const pos = p * n - 0.5;
  if (pos <= 0) return s[0];
  if (pos >= n - 1) return s[n - 1];
  const i = Math.floor(pos), f = pos - i;
  return s[i] * (1 - f) + s[i + 1] * f;
}

// ---------------------------------------------------------------- tas binaire (Dijkstra)
class Tas {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.n * 2); v2.set(this.v); this.v = v2;
    }
    let i = this.n++; const k = this.k, v = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {   // renvoie la valeur, la clé est dans this.dernier
    const k = this.k, v = this.v, top = v[0]; this.dernier = k[0];
    const n = --this.n; const key = k[n], val = v[n];
    let i = 0;
    while (true) {
      let c = 2 * i + 1; if (c >= n) break;
      if (c + 1 < n && k[c + 1] < k[c]) c++;
      if (k[c] >= key) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = key; v[i] = val;
    return top;
  }
}

// ---------------------------------------------------------------- calcul complet
function calculer(C, P, zones, exclusions = []) {
  const D = C.D, rel = C.relief, tache = D.tache, M = tache.length;
  const plafond = melangeZones(zones, 'plafond'), vzMaxZ = melangeZones(zones, 'vzMax');
  const marge = P.margeSol, margeTh = P.margeSol, margePt = Math.min(100, P.margeSol);

  // hauteurs imposées par la tâche
  let hDepart = 1700, hArrivee = 1000;   // départ à 1700 m maximum (ou moins si la tâche l'impose)
  if (tache[0].hmax > 0) hDepart = Math.min(hDepart, tache[0].hmax);
  if (tache[M - 1].hmin > 0) hArrivee = tache[M - 1].hmin;

  // ----- nœuds : points du circuit, thermiques kk7, pompes de fond, points de passage
  const lat = [], lon = [], vz = [], pAct = [], src = [];
  for (const t of tache) { lat.push(t.lat); lon.push(t.lon); vz.push(0); pAct.push(0); src.push(0); }
  const probs = D.kk7.map(r => r[2]);
  const pRef = quantile(probs, 0.98);
  // Autre option : on retire les points proches des trajets déjà trouvés (sauf autour des points du circuit)
  const exclu = fabriquerExclusion(exclusions, tache);
  // cœurs de parcs nationaux : survol à 1000 m/sol minimum, sauf dans les cheminements autorisés
  const parcs = P.parcs ? P.parcs.filter(p => p.role === 'outer') : [];
  const terr = analyserTerrain(rel);
  for (const [la, lo, p] of D.kk7) {
    lat.push(la); lon.push(lo); src.push(1);
    vz.push(P.vzMin + (vzMaxZ(la, lo) - P.vzMin) * Math.min(1, p / pRef));
    pAct.push(Math.min(1, p / pRef));
  }
  for (const [la, lo] of D.fond) { lat.push(la); lon.push(lo); vz.push(P.vzFond); pAct.push(0.5); src.push(2); }
  for (const [la, lo, s] of D.passage) {
    if (s + marge < plafond(la, lo)) { lat.push(la); lon.push(lo); vz.push(0); pAct.push(0); src.push(3); }
  }
  // Crêtes : thermiques de crête (pentes ensoleillées) et vol de pente (crêtes au vent)
  const plafNode = new Array(lat.length).fill(NaN);
  const vent = ventVecteur(P.ventDir || 0, P.ventKmh || 0);
  const soleil = positionSoleil((tache[0].lat + tache[M - 1].lat) / 2, (D.heureDepart || 46800) / 3600 + 1);
  const cretes = valeursCretes(terr, rel, soleil, vent, P, vzMaxZ, plafond);
  const kk7Proche = (la, lo) => {     // kk7 a déjà un thermique à moins de 1,5 km : on ne double pas
    const k = Math.cos(la * Math.PI / 180);
    for (let i = M; i < M + D.kk7.length; i++) if (Math.abs(lat[i] - la) < 0.0135 && Math.hypot((lat[i] - la) * 111.2, (lon[i] - lo) * 111.2 * k) < 1.5) return true;
    return false;
  };
  for (const c of cretes) {
    if (c.vzT > 0 && kk7Proche(c.lat, c.lon)) c.vzT = 0;
    if (c.vzT > 0) { lat.push(c.lat); lon.push(c.lon); vz.push(c.vzT); pAct.push(c.pT); src.push(4); plafNode.push(NaN); }
    if (c.vzD > 0) { lat.push(c.latD); lon.push(c.lonD); vz.push(c.vzD); pAct.push(0); src.push(5); plafNode.push(c.topD); }
  }
  const NG = lat.length;
  let la0 = 0, lo0 = 0; for (let i = 0; i < NG; i++) { la0 += lat[i]; lo0 += lon[i]; } la0 /= NG; lo0 /= NG;
  const kx = 111195 * Math.cos(la0 * Math.PI / 180), ky = 111195;
  const xG = new Float64Array(NG), yG = new Float64Array(NG), plafG = new Float64Array(NG);
  for (let i = 0; i < NG; i++) { xG[i] = (lon[i] - lo0) * kx; yG[i] = (lat[i] - la0) * ky; plafG[i] = plafond(lat[i], lon[i]); if (!isNaN(plafNode[i])) plafG[i] = Math.min(plafG[i], plafNode[i]); }
  const solXY = (x, y) => sol(rel, la0 + y / ky, lo0 + x / kx);
  const rWP = tache.map(t => t.rayon);

  let hMax = 0; for (let i = 0; i < NG; i++) hMax = Math.max(hMax, plafG[i]);
  const hMin = 300, pasAlt = 25;
  const nL = Math.floor((hMax - hMin) / pasAlt) + 1;
  const h = new Float64Array(nL); for (let l = 0; l < nL; l++) h[l] = hMin + l * pasAlt;

  const pol = polaire(P.ballast || 1);
  const vites = [pol.vitesseMC(P.mc), pol.vFinesseMax, pol.vitesseMC(P.mc + 2.5)];
  const fins = vites.map(v => v / pol.chute(v));
  const NV = vites.length;

  // ----- carte du Vz « attendu en ligne droite » (cheminement)
  const effT = P.efficacite, rA = P.rayon;
  const phi = carteAscendance(xG, yG, vz, pAct, M, rA);
  const pasLigne = Math.min(400, Math.max(150, rA / 2));
  // sol rééchantillonné sur la même grille de 100 m que la carte d'ascendance (une seule recherche d'indice)
  const gr = phi.grille, SOL = new Float32Array(gr.nx * gr.ny);
  for (let i = 0; i < gr.ny; i++) for (let j = 0; j < gr.nx; j++) {
    SOL[i * gr.nx + j] = sol(rel, la0 + (gr.y0 + i * 100) / ky, lo0 + (gr.x0 + j * 100) / kx);
  }
  const PHI = gr.A, NX = gr.nx, NY = gr.ny, GX0 = gr.x0, GY0 = gr.y0;
  // Vols Condor : le cheminement « kk7 » ne vaut qu'environ 45 % de la carte (kk7 = vrais vols, pas Condor)
  for (let k = 0; k < PHI.length; k++) PHI[k] *= 0.45;
  // Carte IA (apprise sur les vols Condor) : elle remplace kk7, la bande de crête et la descendance sous le vent
  // pour les cheminements. Les thermiques restent ceux de kk7 et des crêtes (l'IA ne sait pas encore les placer).
  const IA = P.ia || null;
  if (IA) {
    const G = IA.netto, ny = G.length, nx = G[0].length;
    for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
      const la = la0 + (GY0 + i * 100) / ky, lo = lo0 + (GX0 + j * 100) / kx;
      const gi = Math.round((la - IA.lat0) * IA.ky / IA.pas_m), gj = Math.round((lo - IA.lon0) * IA.kx / IA.pas_m);
      PHI[i * NX + j] = gi >= 0 && gj >= 0 && gi < ny && gj < nx ? G[gi][gj] : 0;
    }
  }
  // descendance sous le vent : pentes abritées du vent (négatif dans la carte d'ascendance)
  if (!IA && vent.U > 0 && (P.sousVent || 0) > 0) {
    for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
      const la = la0 + (GY0 + i * 100) / ky, lo = lo0 + (GX0 + j * 100) / kx;
      const o = indiceTerrain(rel, la, lo);
      const face = Math.cos((terr.aspect[o] - vent.dir) * Math.PI / 180);
      if (face < -0.3) PHI[i * NX + j] -= P.sousVent * 0.5 * vent.U * Math.sin(terr.pente[o]) * (-face);
    }
  }
  // Bande de crête : ascendance alignée tout le long des grandes crêtes (thermiques qui décrochent de l'arête,
  // brise de pente). Calée sur 21 vols Condor : ~+1 m/s à l'ombre, ~+2 m/s au soleil pour une crête de 2000 m,
  // plus forte quand la crête est haute, mais s'éteint quand elle approche du plafond (plus de marge au-dessus).
  if (!IA) {
    const rd = Math.PI / 180, sinE = Math.max(0.1, Math.sin(soleil.elev * rd)), cosE = Math.cos(soleil.elev * rd);
    for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
      const la = la0 + (GY0 + i * 100) / ky, lo = lo0 + (GX0 + j * 100) / kx;
      const o = indiceTerrain(rel, la, lo), a = terr.arete[o];
      if (a < 0.05) continue;
      const p = terr.pente[o], asp = terr.aspect[o];
      const ins = Math.max(0, Math.cos(p) * sinE + Math.sin(p) * cosE * Math.cos((soleil.az - asp) * rd)) / sinE;
      const fSol = 0.5 + 0.5 * Math.min(1, ins);
      const face = Math.cos((asp - vent.dir) * rd);
      const dyn = vent.U > 0 && face > 0 ? 0.6 * (P.effPente ?? 1) * vent.U * Math.sin(p) * face : 0;
      const vmax = vzMaxZ(la, lo), k = i * NX + j, hs = rel.U[o];
      const fH = Math.max(0.3, Math.min(1.5, (hs - 1000) / 1000));          // altitude de la crête
      const fMarge = Math.max(0.4, Math.min(1, (plafond(la, lo) - hs + 200) / 700)); // marge sous le plafond
      PHI[k] = Math.min(PHI[k] + a * (2.2 * fSol * fH * fMarge + dyn), Math.max(PHI[k], vmax));
    }
  }
  // masque des parcs sur la même grille (balayage ligne par ligne)
  const PARC = new Uint8Array(NX * NY);
  for (const p of parcs) {
    const xs = p.pts.map(q => ((q[1] - lo0) * kx - GX0) / 100), ys = p.pts.map(q => ((q[0] - la0) * ky - GY0) / 100);
    for (let i = 0; i < NY; i++) {
      const cuts = [];
      for (let k = 0; k < xs.length - 1; k++) {
        const ya = ys[k], yb = ys[k + 1];
        if ((ya > i) !== (yb > i)) cuts.push(xs[k] + (i - ya) / (yb - ya) * (xs[k + 1] - xs[k]));
      }
      cuts.sort((a, b) => a - b);
      for (let c = 0; c + 1 < cuts.length; c += 2) {
        const j0 = Math.max(0, Math.ceil(cuts[c])), j1 = Math.min(NX - 1, Math.floor(cuts[c + 1]));
        for (let j = j0; j <= j1; j++) PARC[i * NX + j] = 1;
      }
    }
  }
  const margeParc = 1000;
  // cheminements autorisés : altitude plancher dans le couloir (-1 = pas de couloir ici)
  const CORR = new Float32Array(NX * NY).fill(-1);
  const versGrille = (la, lo) => [((lo - lo0) * kx - GX0) / 100, ((la - la0) * ky - GY0) / 100];
  const tamponner = (ci, cj, rCel, alt, filtre) => {
    for (let i = Math.max(0, Math.floor(ci - rCel)); i <= Math.min(NY - 1, Math.ceil(ci + rCel)); i++)
      for (let j = Math.max(0, Math.floor(cj - rCel)); j <= Math.min(NX - 1, Math.ceil(cj + rCel)); j++) {
        const o = i * NX + j;
        if (PARC[o] && filtre(i, j) && (CORR[o] < 0 || alt < CORR[o])) CORR[o] = alt;
      }
  };
  for (const c of (P.couloirs || [])) {
    if (c.type === 'disque') {
      const [cj, ci] = versGrille(c.centre[0], c.centre[1]), rc = c.rayonKm * 10;
      tamponner(ci, cj, rc, c.altMin, (i, j) => Math.hypot(i - ci, j - cj) <= rc);
    } else {
      const demi = c.largeurKm * 5;       // demi-largeur en cellules de 100 m
      for (let k = 0; k < c.pts.length - 1; k++) {
        const [aj, ai] = versGrille(c.pts[k][0], c.pts[k][1]), [bj, bi] = versGrille(c.pts[k + 1][0], c.pts[k + 1][1]);
        const n = Math.ceil(Math.hypot(bi - ai, bj - aj) / 3) + 1;
        for (let t = 0; t <= n; t++) {
          const ci = ai + (bi - ai) * t / n, cj = aj + (bj - aj) * t / n;
          tamponner(ci, cj, demi, c.altMin, (i, j) => distanceSegment(j, i, aj, ai, bj, bi) <= demi);
        }
      }
    }
  }

  // altitude requise au départ + gain de cheminement, pour une ligne (x0,y0) -> (x1,y1)
  const req = new Float64Array(NV), gain = new Float64Array(NV);
  const vgL = new Float64Array(NV), finG = new Float64Array(NV);
  function ligne(x0, y0, x1, y1, mg, mgFin, approche) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    // vitesse sol avec le vent (cap corrigé de la dérive), finesse sol
    const bx = d > 0 ? (x1 - x0) / d : 0, by = d > 0 ? (y1 - y0) / d : 1;
    const wa = vent.wx * bx + vent.wy * by, wc = -vent.wx * by + vent.wy * bx;
    for (let iv = 0; iv < NV; iv++) {
      const v = vites[iv], vg = v > Math.abs(wc) ? Math.sqrt(v * v - wc * wc) + wa : 0;
      vgL[iv] = Math.max(vg, 1); finG[iv] = vg > 1 ? fins[iv] * vg / v : 0.001;
    }
    const K = Math.max(1, Math.ceil(d / pasLigne)), ds = d / K;
    for (let iv = 0; iv < NV; iv++) req[iv] = -Infinity;
    let I = 0, phPrec = phi(x0, y0);
    for (let k = 1; k <= K; k++) {
      const f = k / K, S = d * f;
      let fi = (y0 + (y1 - y0) * f - GY0) / 100, fj = (x0 + (x1 - x0) * f - GX0) / 100;
      if (fi < 0) fi = 0; else if (fi > NY - 1.0001) fi = NY - 1.0001;
      if (fj < 0) fj = 0; else if (fj > NX - 1.0001) fj = NX - 1.0001;
      const ii = fi | 0, jj = fj | 0, a = fi - ii, b = fj - jj, o = ii * NX + jj;
      const w00 = (1 - a) * (1 - b), w01 = (1 - a) * b, w10 = a * (1 - b), w11 = a * b;
      const Z = SOL[o] * w00 + SOL[o + 1] * w01 + SOL[o + NX] * w10 + SOL[o + NX + 1] * w11;
      const ph = PHI[o] * w00 + PHI[o + 1] * w01 + PHI[o + NX] * w10 + PHI[o + NX + 1] * w11;
      I += (phPrec + ph) / 2 * ds; phPrec = ph;
      const m = approche > 0 ? mgFin + (mg - mgFin) * Math.min(1, (d - S) / approche) : (k === K ? mgFin : mg);
      let hMinPt = Z + m;
      const oP = Math.round(fi) * NX + Math.round(fj);
      if (PARC[oP]) {                                  // cœur de parc national
        if (CORR[oP] >= 0) hMinPt = Math.max(hMinPt, CORR[oP]);   // cheminement autorisé (≥ 2800 m aux Écrins)
        else hMinPt = Math.max(hMinPt, Z + margeParc);            // ailleurs : 1000 m/sol minimum
      }
      for (let iv = 0; iv < NV; iv++) {
        const r = hMinPt + S / finG[iv] - effT * I / vgL[iv];
        if (r > req[iv]) req[iv] = r;
      }
    }
    for (let iv = 0; iv < NV; iv++) gain[iv] = effT * I / vgL[iv];
    return d;
  }

  // ----- couches : couche L = branche du point L vers le point L+1
  const nC = M - 1, loc = [];
  for (let L = 0; L < nC; L++) {
    const a = [L];
    for (let i = M; i < NG; i++) {
      if (distanceSegment(xG[i], yG[i], xG[L], yG[L], xG[L + 1], yG[L + 1]) <= P.couloir * 1000 && !exclu(lat[i], lon[i], L)) a.push(i);
    }
    loc.push(Int32Array.from(a));
  }
  const nLoc = loc.map(a => a.length);
  const offset = [0]; for (let L = 0; L < nC; L++) offset.push(offset[L] + nLoc[L] * nL);
  const S = offset[nC], sFin = S;
  progression(`${NG - M} points, ${S.toLocaleString('fr-FR')} états`);
  const T = new Float64Array(S + 1).fill(Infinity), prec = new Int32Array(S + 1).fill(-1);
  const fait = new Uint8Array(S + 1), modeV = new Uint8Array(S + 1);
  const cache = loc.map(a => new Array(a.length));
  // dominance : à un même nœud, un état plus haut atteint plus tôt fait au moins aussi bien
  const hautMax = loc.map(a => new Int16Array(a.length).fill(-1));

  let l0 = 0; for (let l = 0; l < nL; l++) if (h[l] <= hDepart) l0 = l;
  const s0 = offset[0] + l0 * nLoc[0] + 0;
  T[s0] = 0;
  const tas = new Tas(1 << 20); tas.push(0, s0);
  const portee = P.portee * 1000;
  let nExp = 0;

  while (tas.n > 0) {
    const s = tas.pop(), t = tas.dernier;
    if (fait[s] || t > T[s]) continue;
    fait[s] = 1;
    if (s === sFin) break;
    if (++nExp % 50000 === 0) progression(`Calcul… ${Math.round(t / 60)} min de vol explorées`);
    let L = 0; while (s >= offset[L + 1]) L++;
    const r = s - offset[L], l = Math.floor(r / nLoc[L]), j = r - l * nLoc[L];
    const g = loc[L][j];
    if (hautMax[L][j] >= l) continue;                     // déjà passé ici plus haut et plus tôt
    hautMax[L][j] = l;

    // monter d'un palier
    if (vz[g] > 0 && l < nL - 1 && h[l + 1] <= plafG[g]) {
      const vzEff = vz[g] * Math.max(0.4, Math.min(1, (plafG[g] - h[l]) / 400));
      relax(s + nLoc[L], t + pasAlt / vzEff, s, 0);
    }

    // cibles et altitudes requises (une fois par nœud et par branche)
    let q = cache[L][j];
    const p = L + 1;
    if (!q) {
      const cib = loc[L], sel = [];
      for (let k = 1; k < cib.length; k++) {
        const c = cib[k];
        if (c !== g && Math.hypot(xG[c] - xG[g], yG[c] - yG[g]) <= portee) sel.push(k);
      }
      const n = sel.length;
      q = { sel: Int32Array.from(sel), d: new Float32Array(n), req: new Float32Array(n * NV), G: new Float32Array(n * NV), vg: new Float32Array(n * NV) };
      for (let k = 0; k < n; k++) {
        const c = cib[sel[k]];
        q.d[k] = ligne(xG[g], yG[g], xG[c], yG[c], marge, margeTh, 0);
        for (let iv = 0; iv < NV; iv++) { q.req[k * NV + iv] = req[iv]; q.G[k * NV + iv] = gain[iv]; q.vg[k * NV + iv] = vgL[iv]; }
      }
      const dGP = Math.hypot(xG[p] - xG[g], yG[p] - yG[g]);
      q.dP = Math.max(0, dGP - rWP[p]);
      const fr = q.dP / Math.max(dGP, 1);
      const xe = xG[g] + (xG[p] - xG[g]) * fr, ye = yG[g] + (yG[p] - yG[g]) * fr;
      if (p === M - 1) ligne(xG[g], yG[g], xe, ye, marge, 0, 3000);
      else ligne(xG[g], yG[g], xe, ye, marge, margePt, 1000);
      q.reqP = Float64Array.from(req); q.Gp = Float64Array.from(gain); q.vgP = Float64Array.from(vgL);
      cache[L][j] = q;
    }

    const hl = h[l], base = offset[L];
    for (let iv = 0; iv < NV; iv++) {
      const fin = fins[iv], v = vites[iv];
      // transiter vers un point du couloir
      transiter(q, iv, fin, v, hl, t, s, L, base);
      // valider le point suivant
      if (hl < q.reqP[iv]) continue;
      const vgp = q.vgP[iv], hP0 = hl - q.dP * v / (fin * vgp);
      const hP = Math.min(Math.max(hP0, plafG[p]), hP0 + q.Gp[iv]);
      const t2 = t + q.dP / vgp;
      if (p === M - 1) {
        if (hP >= hArrivee) relax(sFin, t2, s, iv);
      } else if (hP >= hMin) {
        const l2 = Math.min(nL - 1, Math.floor((Math.min(hMax, hP) - hMin) / pasAlt + 1e-9));
        relax(offset[p] + l2 * nLoc[p], t2, s, iv);
      }
    }
  }

  function transiter(q, iv, fin, v, hl, t, s, L, base) {
    const sel = q.sel, qreq = q.req, qd = q.d, qG = q.G, locL = loc[L], hm = hautMax[L], nLL = nLoc[L], n = sel.length;
    for (let k = 0; k < n; k++) {
      const kv = k * NV + iv;
      if (hl < qreq[kv]) continue;                         // le relief bloque
      const d = qd[k], vg = q.vg[kv], hArr = hl - d * v / (fin * vg), G = qG[kv];
      if (hArr + G < hMin) continue;
      const jj = sel[k], pc = plafG[locL[jj]];
      let hA = hArr + G; if (hA > pc) hA = hArr > pc ? hArr : pc;   // pas au-dessus du plafond
      let l2 = ((hA - hMin) / pasAlt + 1e-9) | 0; if (l2 > nL - 1) l2 = nL - 1; else if (l2 < 0) l2 = 0;
      if (hm[jj] >= l2) continue;
      const s2 = base + l2 * nLL + jj, t2 = t + d / vg;
      if (fait[s2] === 0 && t2 < T[s2]) { T[s2] = t2; prec[s2] = s; modeV[s2] = iv; tas.push(t2, s2); }
    }
  }

  function relax(s2, t2, s, iv) {
    if (!fait[s2] && t2 < T[s2]) { T[s2] = t2; prec[s2] = s; modeV[s2] = iv; tas.push(t2, s2); }
  }

  const out = {
    ok: isFinite(T[sFin]), nbEtats: S, nbPoints: NG - M,
    nbPassage: src.filter(x => x === 3).length,
    vitesses: vites.map(v => v * 3.6), finesse: fins[0],
    hDepart, hArrivee,
  };
  out.distanceCircuit = 0;
  for (let i = 0; i < M - 1; i++) out.distanceCircuit += Math.hypot(xG[i + 1] - xG[i], yG[i + 1] - yG[i]) / 1000;
  out.thermiques = [];
  for (let i = M; i < NG; i++) if (src[i] === 1 || src[i] === 2) out.thermiques.push([lat[i], lon[i], Math.round(vz[i] * 10) / 10, src[i]]);
  out.cretes = cretes.map(c => [c.lat, c.lon, Math.round(c.vzT * 10) / 10, Math.round(c.vzD * 10) / 10, Math.round(c.h), c.latD, c.lonD, Math.round(c.topD || 0)]);
  out.soleil = { az: Math.round(soleil.az), elev: Math.round(soleil.elev) };
  if (!out.ok) return out;

  // ----- reconstruction du chemin
  const chemin = []; let s = sFin;
  while (s !== -1) { chemin.push(s); if (s === s0) break; s = prec[s]; }
  chemin.reverse();
  const noeud = [], niv = [];
  for (let k = 0; k < chemin.length - 1; k++) {
    const sk = chemin[k]; let L = 0; while (sk >= offset[L + 1]) L++;
    const r = sk - offset[L], l = Math.floor(r / nLoc[L]), j = r - l * nLoc[L];
    noeud.push(loc[L][j]); niv.push(l);
  }
  noeud.push(M - 1); niv.push(-1);
  const E = [];
  let k = 0; const n = chemin.length;
  while (k < n - 1) {
    const n1 = noeud[k];
    if (noeud[k + 1] === n1 && k + 1 < n - 1) {           // montée
      let k2 = k; while (k2 < n - 2 && noeud[k2 + 1] === n1) k2++;
      E.push({ type: 'M', de: n1, vers: n1, h1: h[niv[k]], h2: h[niv[k2]], dist: 0,
        duree: T[chemin[k2]] - T[chemin[k]], vz: vz[n1], gain: 0, valide: '' });
      k = k2;
    } else {                                             // transition
      const n2 = noeud[k + 1];
      let dd = Math.hypot(xG[n2] - xG[n1], yG[n2] - yG[n1]), nom = '';
      if (n2 < M) { dd = Math.max(0, dd - rWP[n2]); nom = tache[n2].nom; }      // validation d'un point
      const iv = modeV[chemin[k + 1]];
      const fr = dd / Math.max(1, Math.hypot(xG[n2] - xG[n1], yG[n2] - yG[n1]));
      ligne(xG[n1], yG[n1], xG[n1] + (xG[n2] - xG[n1]) * fr, yG[n1] + (yG[n2] - yG[n1]) * fr, 0, 0, 0);
      const h1 = h[niv[k]], hs = h1 - dd / finG[iv];
      const h2 = Math.min(Math.max(hs, plafG[n2]), hs + gain[iv]);
      E.push({ type: 'T', de: n1, vers: n2, h1, h2, dist: dd / 1000, duree: dd / vgL[iv],
        vz: vites[iv] * 3.6, gain: gain[iv], valide: nom, passage: src[n2] === 3 });
      k++;
    }
  }
  out.tempsTotal = T[sFin];
  out.etapes = E.map(e => ({ ...e, lat1: lat[e.de], lon1: lon[e.de], lat2: lat[e.vers], lon2: lon[e.vers] }));
  out.trace = construireTrace(out.etapes, vites[0], fins[0], D.heureDepart);
  // sol, plafond et distance le long de la trace (profil)
  const tr = out.trace, nt = tr.t.length;
  tr.sol = new Float32Array(nt); tr.plafond = new Float32Array(nt); tr.dist = new Float32Array(nt);
  let dcum = 0;
  for (let i = 0; i < nt; i++) {
    if (i > 0) dcum += distSol(tr.lat[i - 1], tr.lon[i - 1], tr.lat[i], tr.lon[i]);
    tr.dist[i] = dcum / 1000; tr.sol[i] = sol(rel, tr.lat[i], tr.lon[i]); tr.plafond[i] = plafond(tr.lat[i], tr.lon[i]);
  }
  let hmin = Infinity; for (let i = 0; i < nt; i++) if (tr.t[i] >= D.heureDepart) hmin = Math.min(hmin, tr.alt[i] - tr.sol[i]);
  out.hauteurMini = hmin;
  return out;
}

// ---------------------------------------------------------------- relief : pentes, crêtes, soleil, vent
function indiceTerrain(rel, la, lo) {
  let i = Math.round((la - rel.latMin) / rel.dLat), j = Math.round((lo - rel.lonMin) / rel.dLon);
  i = Math.min(rel.nLat - 1, Math.max(0, i)); j = Math.min(rel.nLon - 1, Math.max(0, j));
  return i * rel.nLon + j;
}

// Pente (rad), orientation de la pente (direction vers l'aval, ° depuis le nord), crêtes repérées
function analyserTerrain(rel) {
  if (rel.terrain) return rel.terrain;
  const { U, nLat, nLon } = rel, N = nLat * nLon;
  const latMid = rel.latMin + rel.dLat * nLat / 2;
  const dy = rel.dLat * 111195, dx = rel.dLon * 111195 * Math.cos(latMid * Math.PI / 180);
  const pente = new Float32Array(N), aspect = new Float32Array(N);
  for (let i = 1; i < nLat - 1; i++) for (let j = 1; j < nLon - 1; j++) {
    const o = i * nLon + j;
    const gx = (U[o + 1] - U[o - 1]) / (2 * dx), gy = (U[o + nLon] - U[o - nLon]) / (2 * dy);
    pente[o] = Math.atan(Math.hypot(gx, gy));
    aspect[o] = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360;
  }
  // moyennes locales (image intégrale) -> position topographique à ~1 km et ~3 km
  const S = new Float64Array((nLat + 1) * (nLon + 1)), W = nLon + 1;
  for (let i = 0; i < nLat; i++) { let ligneS = 0; for (let j = 0; j < nLon; j++) { ligneS += U[i * nLon + j]; S[(i + 1) * W + j + 1] = S[i * W + j + 1] + ligneS; } }
  const moy = (i, j, ri, rj) => {
    const a = Math.max(0, i - ri), b = Math.min(nLat - 1, i + ri), c = Math.max(0, j - rj), d = Math.min(nLon - 1, j + rj);
    return (S[(b + 1) * W + d + 1] - S[a * W + d + 1] - S[(b + 1) * W + c] + S[a * W + c]) / ((b - a + 1) * (d - c + 1));
  };
  const r1i = Math.round(1000 / dy), r1j = Math.round(1000 / dx), r3i = Math.round(3000 / dy), r3j = Math.round(3000 / dx);
  // arête : 1 sur le haut des grands reliefs (saillant à 1 km et à 3 km), étalé sur ~700 m autour
  const R0 = new Float32Array(N);
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
    const o = i * nLon + j, t1 = U[o] - moy(i, j, r1i, r1j), t3 = U[o] - moy(i, j, r3i, r3j);
    R0[o] = Math.max(0, Math.min(1, (t3 - 150) / 450)) * Math.max(0, Math.min(1, (t1 + 20) / 80));
  }
  const arete = etalerMax(R0, nLat, nLon, Math.round(700 / dy), Math.round(700 / dx), true);
  // relief le plus haut à moins de 3 km : repère les thermiques au pied des grandes faces
  const max3 = etalerMax(U, nLat, nLon, r3i, r3j, false);
  // crêtes : le point le plus « saillant » de chaque carré d'environ 2 km
  const bi = Math.max(1, Math.round(2000 / dy)), bj = Math.max(1, Math.round(2000 / dx)), cretes = [];
  for (let I = 0; I < nLat; I += bi) for (let J = 0; J < nLon; J += bj) {
    let best = null;
    for (let i = I; i < Math.min(nLat, I + bi); i++) for (let j = J; j < Math.min(nLon, J + bj); j++) {
      const o = i * nLon + j, t1 = U[o] - moy(i, j, r1i, r1j), t3 = U[o] - moy(i, j, r3i, r3j);
      if (t1 > 60 && t3 > 200 && (!best || t3 > best.t3)) best = { i, j, o, t1, t3 };
    }
    if (!best) continue;
    // pentes sous la crête (dans 1,5 km, plus basses que la crête) : servent pour le soleil et le vent
    const ech = [], h0 = U[best.o], ri = Math.round(1500 / dy), rj = Math.round(1500 / dx), pi = Math.max(1, Math.round(250 / dy)), pj = Math.max(1, Math.round(250 / dx));
    for (let i = best.i - ri; i <= best.i + ri; i += pi) for (let j = best.j - rj; j <= best.j + rj; j += pj) {
      if (i < 1 || j < 1 || i >= nLat - 1 || j >= nLon - 1) continue;
      if (((i - best.i) * dy) ** 2 + ((j - best.j) * dx) ** 2 > 1500 * 1500) continue;
      const o = i * nLon + j; if (U[o] < h0 - 20 && pente[o] > 0.15) ech.push(o);
    }
    cretes.push({ lat: rel.latMin + best.i * rel.dLat, lon: rel.lonMin + best.j * rel.dLon, h: h0, hauteur: Math.min(1500, best.t3), ech, i: best.i, j: best.j });
  }
  return (rel.terrain = { pente, aspect, cretes, dx, dy, arete, max3 });
}

// Maximum glissant séparable (lignes puis colonnes) ; décroissance linéaire avec la distance si demandé
function etalerMax(A, nI, nJ, ri, rj, decroit) {
  const T = new Float32Array(A.length), B = new Float32Array(A.length);
  for (let i = 0; i < nI; i++) for (let j = 0; j < nJ; j++) {
    let m = -Infinity;
    for (let k = Math.max(0, j - rj); k <= Math.min(nJ - 1, j + rj); k++) {
      const v = A[i * nJ + k] * (decroit ? 1 - Math.abs(k - j) / (rj + 1) : 1); if (v > m) m = v;
    }
    T[i * nJ + j] = m;
  }
  for (let j = 0; j < nJ; j++) for (let i = 0; i < nI; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - ri); k <= Math.min(nI - 1, i + ri); k++) {
      const v = T[k * nJ + j] * (decroit ? 1 - Math.abs(k - i) / (ri + 1) : 1); if (v > m) m = v;
    }
    B[i * nJ + j] = m;
  }
  return B;
}

// Soleil un 15 juillet à l'heure locale donnée (heure d'été) : azimut et hauteur (°)
function positionSoleil(lat, heureLocale) {
  const r = Math.PI / 180, decl = 21.5 * r, H = (heureLocale - 13.6) * 15 * r, f = lat * r;
  const sinE = Math.sin(f) * Math.sin(decl) + Math.cos(f) * Math.cos(decl) * Math.cos(H);
  const elev = Math.asin(sinE);
  const az = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(f) - Math.tan(decl) * Math.cos(f)) / r + 180 + 360) % 360;
  return { az, elev: elev / r };
}

// Vent « venant de » dir (°), en km/h -> composantes (m/s) vers où il souffle
function ventVecteur(dir, kmh) {
  const U = kmh / 3.6, to = (dir + 180) * Math.PI / 180;
  return { U, dir, wx: U * Math.sin(to), wy: U * Math.cos(to) };
}

// Pour chaque crête : thermique de crête (ensoleillement des pentes) et vol de pente (pentes au vent)
function valeursCretes(terr, rel, sol, vent, P, vzMaxZ, plafond) {
  const r = Math.PI / 180, sinE = Math.max(0.1, Math.sin(sol.elev * r)), cosE = Math.cos(sol.elev * r);
  const out = [];
  for (const c of terr.cretes) {
    if (!c.ech.length) continue;
    let ins = 0, dyn = 0, nDyn = 0, ax = 0, ay = 0;
    for (const o of c.ech) {
      const p = terr.pente[o], a = terr.aspect[o];
      ins += Math.max(0, Math.cos(p) * sinE + Math.sin(p) * cosE * Math.cos((sol.az - a) * r)) / sinE;
      const face = Math.cos((a - vent.dir) * r);           // pente tournée vers d'où vient le vent
      if (face > 0.5) { dyn += vent.U * Math.sin(p) * face; nDyn++; ax += Math.sin(a * r); ay += Math.cos(a * r); }
    }
    ins /= c.ech.length;
    const fT = Math.max(0, Math.min(1, (ins - 0.7) / 0.6)) * Math.min(1, c.hauteur / 700) * (P.poidsCretes ?? 1);
    let vzT = 0, pT = 0;
    if (fT > 0.3) {
      vzT = P.vzMin + (vzMaxZ(c.lat, c.lon) - P.vzMin) * Math.min(1, fT);
      pT = Math.min(1, 0.8 * fT);
    }
    let vzD = 0, latD = c.lat, lonD = c.lon, topD = NaN;
    if (nDyn >= 3 && vent.U > 0) {
      vzD = (P.effPente ?? 1) * 0.9 * dyn / nDyn;
      if (vzD < 0.5) vzD = 0;
      else {   // point de vol de pente : 300 m côté vent, plafond = crête + moitié de la hauteur de pente
        const n = Math.hypot(ax, ay) || 1;
        latD = c.lat + 300 * (ay / n) / 111195; lonD = c.lon + 300 * (ax / n) / (111195 * Math.cos(c.lat * r));
        topD = Math.min(plafond(c.lat, c.lon), c.h + Math.min(600, 0.5 * c.hauteur));
      }
    }
    out.push({ lat: c.lat, lon: c.lon, h: c.h, vzT, pT, vzD, latD, lonD, topD });
  }
  return out;
}

function dansPolygone(la, lo, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[0] > la) !== (b[0] > la) && lo < (b[1] - a[1]) * (la - a[0]) / (b[0] - a[0]) + a[1]) c = !c;
  }
  return c;
}

// exclusions : [{ pts: [[lat, lon], ...], rayonKm, protegeKm, branche }] — vrai si (la, lo) est à moins de
// rayonKm d'un trajet déjà trouvé et à plus de protegeKm de tous les points du circuit.
// branche = numéro de la branche concernée (-1 = tout le circuit)
function fabriquerExclusion(exclusions, tache) {
  if (!exclusions.length) return () => false;
  const la0 = tache[0].lat, kx = 111.195 * Math.cos(la0 * Math.PI / 180), ky = 111.195;
  const segs = [];
  for (const ex of exclusions) {
    for (let i = 0; i < ex.pts.length - 1; i++) {
      segs.push([ex.pts[i][1] * kx, ex.pts[i][0] * ky, ex.pts[i + 1][1] * kx, ex.pts[i + 1][0] * ky, ex.rayonKm, ex.branche == null ? -1 : ex.branche]);
    }
  }
  const tp = tache.map(t => [t.lon * kx, t.lat * ky]), protege = exclusions[0].protegeKm;
  return (la, lo, L) => {
    const x = lo * kx, y = la * ky;
    for (const [px, py] of tp) if (Math.hypot(px - x, py - y) < protege) return false;
    for (const [ax, ay, bx, by, rk, br] of segs) if ((br < 0 || br === L) && distanceSegment(x, y, ax, ay, bx, by) < rk) return true;
    return false;
  };
}

function carteAscendance(xG, yG, vz, pAct, M, rayon) {
  const NG = xG.length;
  const pas = 100, mg = Math.max(rayon, 0) + 500;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = M; i < NG; i++) { x0 = Math.min(x0, xG[i]); x1 = Math.max(x1, xG[i]); y0 = Math.min(y0, yG[i]); y1 = Math.max(y1, yG[i]); }
  x0 -= mg; y0 -= mg; x1 += mg; y1 += mg;
  const nx = Math.floor((x1 - x0) / pas) + 1, ny = Math.floor((y1 - y0) / pas) + 1;
  const A = new Float32Array(nx * ny), V = new Float32Array(nx * ny);
  const k = Math.ceil(rayon / pas), r2 = (rayon / pas) * (rayon / pas);
  for (let i = M; i < NG; i++) {
    if (!(vz[i] > 0 && pAct[i] > 0) || rayon <= 0) continue;
    const ci = Math.round((yG[i] - y0) / pas), cj = Math.round((xG[i] - x0) / pas);
    const w = vz[i] * pAct[i];
    for (let a = -k; a <= k; a++) {
      const ii = ci + a; if (ii < 0 || ii >= ny) continue;
      for (let b = -k; b <= k; b++) {
        const jj = cj + b; if (jj < 0 || jj >= nx) continue;
        const o = ii * nx + jj;
        if (a * a + b * b <= r2) A[o] += w;
        if (vz[i] > V[o]) V[o] = vz[i];               // maximum sur le carré voisin
      }
    }
  }
  for (let o = 0; o < A.length; o++) A[o] = Math.min(A[o], V[o]);
  const f = (x, y) => {
    let fi = (y - y0) / pas, fj = (x - x0) / pas;
    fi = Math.min(ny - 1.0001, Math.max(0, fi)); fj = Math.min(nx - 1.0001, Math.max(0, fj));
    const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j;
    return (A[i * nx + j] * (1 - b) + A[i * nx + j + 1] * b) * (1 - a) + (A[(i + 1) * nx + j] * (1 - b) + A[(i + 1) * nx + j + 1] * b) * a;
  };
  f.grille = { A, nx, ny, x0, y0 };
  return f;
}

function distanceSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  let t = ((px - ax) * abx + (py - ay) * aby) / Math.max(1e-9, abx * abx + aby * aby);
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function distSol(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * RT * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Trace « volée » : transitions droites, montées en spirale (rayon 150 m, un tour en 28 s),
// 3 km d'approche avant le départ ; un point toutes les 2 s.
function construireTrace(E, v, finesse, heureDepart) {
  const pas = 2, rSpi = 150, tTour = 28;
  const kLat = 111195, kLon = 111195 * Math.cos(E[0].lat1 * Math.PI / 180);
  const t = [], la = [], lo = [], alt = [], spi = [];
  const e1 = E.find(e => e.type === 'T') || E[0];
  let dla = e1.lat2 - E[0].lat1, dlo = e1.lon2 - E[0].lon1;
  let nrm = Math.hypot(dla * kLat, dlo * kLon); if (nrm === 0) { nrm = 1; dla = 1 / kLat; }
  const dApp = 3000, tApp = dApp / v;
  for (let u = 0; u < tApp; u += pas) {
    const s = u / tApp;
    t.push(u - tApp); la.push(E[0].lat1 - (1 - s) * dla / nrm * dApp); lo.push(E[0].lon1 - (1 - s) * dlo / nrm * dApp);
    alt.push(E[0].h1); spi.push(0);   // approche en palier : jamais au-dessus de l'altitude de départ
  }
  let t0 = 0;
  for (const e of E) {
    if (e.duree <= 0) continue;
    for (let u = 0; u < e.duree - 1e-9; u += pas) {
      if (e.type === 'M') {
        const a = 2 * Math.PI * u / tTour;
        la.push(e.lat1 + rSpi * (1 - Math.cos(a)) / kLat); lo.push(e.lon1 + rSpi * Math.sin(a) / kLon); spi.push(1);
      } else {
        const f = u / e.duree;
        la.push(e.lat1 + f * (e.lat2 - e.lat1)); lo.push(e.lon1 + f * (e.lon2 - e.lon1)); spi.push(0);
      }
      t.push(t0 + u); alt.push(e.h1 + u / e.duree * (e.h2 - e.h1));
    }
    t0 += e.duree;
  }
  const ef = E[E.length - 1];
  t.push(t0); la.push(ef.lat2); lo.push(ef.lon2); alt.push(ef.h2); spi.push(0);
  return { t: t.map(x => x + heureDepart), lat: la, lon: lo, alt, spirale: spi, heureDepart };
}
