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
      const r = calculer(C, m.P, m.zones, m.exclusions || []);
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
function polaire() {
  const v = [90, 130, 180].map(x => x / 3.6), w = [0.58, 0.85, 1.75];
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
  let hDepart = 2500, hArrivee = 1000;
  if (tache[0].hmax > 0) hDepart = Math.min(hDepart, tache[0].hmax);
  if (tache[M - 1].hmin > 0) hArrivee = tache[M - 1].hmin;

  // ----- nœuds : points du circuit, thermiques kk7, pompes de fond, points de passage
  const lat = [], lon = [], vz = [], pAct = [], src = [];
  for (const t of tache) { lat.push(t.lat); lon.push(t.lon); vz.push(0); pAct.push(0); src.push(0); }
  const probs = D.kk7.map(r => r[2]);
  const pRef = quantile(probs, 0.98);
  // Autre option : on retire les points proches des trajets déjà trouvés (sauf autour des points du circuit)
  const exclu = fabriquerExclusion(exclusions, tache);
  for (const [la, lo, p] of D.kk7) {
    lat.push(la); lon.push(lo); src.push(1);
    vz.push(P.vzMin + (vzMaxZ(la, lo) - P.vzMin) * Math.min(1, p / pRef));
    pAct.push(Math.min(1, p / pRef));
  }
  for (const [la, lo] of D.fond) { lat.push(la); lon.push(lo); vz.push(P.vzFond); pAct.push(0.5); src.push(2); }
  for (const [la, lo, s] of D.passage) {
    if (s + marge < plafond(la, lo)) { lat.push(la); lon.push(lo); vz.push(0); pAct.push(0); src.push(3); }
  }
  const NG = lat.length;
  let la0 = 0, lo0 = 0; for (let i = 0; i < NG; i++) { la0 += lat[i]; lo0 += lon[i]; } la0 /= NG; lo0 /= NG;
  const kx = 111195 * Math.cos(la0 * Math.PI / 180), ky = 111195;
  const xG = new Float64Array(NG), yG = new Float64Array(NG), plafG = new Float64Array(NG);
  for (let i = 0; i < NG; i++) { xG[i] = (lon[i] - lo0) * kx; yG[i] = (lat[i] - la0) * ky; plafG[i] = plafond(lat[i], lon[i]); }
  const solXY = (x, y) => sol(rel, la0 + y / ky, lo0 + x / kx);
  const rWP = tache.map(t => t.rayon);

  let hMax = 0; for (let i = 0; i < NG; i++) hMax = Math.max(hMax, plafG[i]);
  const hMin = 300, pasAlt = 25;
  const nL = Math.floor((hMax - hMin) / pasAlt) + 1;
  const h = new Float64Array(nL); for (let l = 0; l < nL; l++) h[l] = hMin + l * pasAlt;

  const pol = polaire();
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

  // altitude requise au départ + gain de cheminement, pour une ligne (x0,y0) -> (x1,y1)
  const req = new Float64Array(NV), gain = new Float64Array(NV);
  function ligne(x0, y0, x1, y1, mg, mgFin, approche) {
    const d = Math.hypot(x1 - x0, y1 - y0);
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
      for (let iv = 0; iv < NV; iv++) {
        const r = Z + m + S / fins[iv] - effT * I / vites[iv];
        if (r > req[iv]) req[iv] = r;
      }
    }
    for (let iv = 0; iv < NV; iv++) gain[iv] = effT * I / vites[iv];
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
      q = { sel: Int32Array.from(sel), d: new Float32Array(n), req: new Float32Array(n * NV), G: new Float32Array(n * NV) };
      for (let k = 0; k < n; k++) {
        const c = cib[sel[k]];
        q.d[k] = ligne(xG[g], yG[g], xG[c], yG[c], marge, margeTh, 0);
        for (let iv = 0; iv < NV; iv++) { q.req[k * NV + iv] = req[iv]; q.G[k * NV + iv] = gain[iv]; }
      }
      const dGP = Math.hypot(xG[p] - xG[g], yG[p] - yG[g]);
      q.dP = Math.max(0, dGP - rWP[p]);
      const fr = q.dP / Math.max(dGP, 1);
      const xe = xG[g] + (xG[p] - xG[g]) * fr, ye = yG[g] + (yG[p] - yG[g]) * fr;
      if (p === M - 1) ligne(xG[g], yG[g], xe, ye, marge, 0, 3000);
      else ligne(xG[g], yG[g], xe, ye, marge, margePt, 1000);
      q.reqP = Float64Array.from(req); q.Gp = Float64Array.from(gain);
      cache[L][j] = q;
    }

    const hl = h[l], base = offset[L];
    for (let iv = 0; iv < NV; iv++) {
      const fin = fins[iv], v = vites[iv];
      // transiter vers un point du couloir
      transiter(q, iv, fin, v, hl, t, s, L, base);
      // valider le point suivant
      if (hl < q.reqP[iv]) continue;
      const hP0 = hl - q.dP / fin;
      const hP = Math.min(Math.max(hP0, plafG[p]), hP0 + q.Gp[iv]);
      const t2 = t + q.dP / v;
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
      const d = qd[k], hArr = hl - d / fin, G = qG[kv];
      if (hArr + G < hMin) continue;
      const jj = sel[k], pc = plafG[locL[jj]];
      let hA = hArr + G; if (hA > pc) hA = hArr > pc ? hArr : pc;   // pas au-dessus du plafond
      let l2 = ((hA - hMin) / pasAlt + 1e-9) | 0; if (l2 > nL - 1) l2 = nL - 1; else if (l2 < 0) l2 = 0;
      if (hm[jj] >= l2) continue;
      const s2 = base + l2 * nLL + jj, t2 = t + d / v;
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
      const h1 = h[niv[k]], hs = h1 - dd / fins[iv];
      const h2 = Math.min(Math.max(hs, plafG[n2]), hs + gain[iv]);
      E.push({ type: 'T', de: n1, vers: n2, h1, h2, dist: dd / 1000, duree: dd / vites[iv],
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
    alt.push(E[0].h1 + (1 - s) * dApp / finesse); spi.push(0);
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
