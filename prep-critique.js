// Spirale — zones critiques d'un trajet calculé :
//  * pompes critiques : sans le gain de cette spirale, la suite du trajet passe sous la marge au-dessus du sol
//    (relief à franchir) ou arrive trop bas à l'arrivée -> « à prendre sous peine d'être coincé » ;
//    on signale aussi les arrivées basses sur une pompe (pas de plan B si elle ne marche pas) ;
//  * passages délicats : franchissement d'un col ou d'une crête (sol plus haut qu'avant et après) avec peu de marge,
//    avec l'altitude à avoir en quittant la pompe précédente.
(function (racine) {
  'use strict';
  const dist = (a, b, c, d) => { const k = Math.PI / 180, x = Math.sin((c - a) * k / 2) ** 2 + Math.cos(a * k) * Math.cos(c * k) * Math.sin((d - b) * k / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(x))); };
  function zonesCritiques(r, o = {}) {
    const marge = o.marge ?? 150, seuilCol = o.seuilCol ?? 350, seuilBas = o.seuilBas ?? 450;
    const res = { pompes: [], cols: [] };
    if (!r || !r.ok || !r.trace) return res;
    const tr = r.trace, n = tr.t.length, h0 = tr.heureDepart;
    // spirales (ordre des étapes) et leur plage dans la trace (même découpage en temps que construireTrace)
    const M = []; let t = 0, num = 0;
    for (const e of r.etapes) { if (e.type === 'M') M.push({ e, n: ++num, ts: t, te: t + e.duree }); t += e.duree; }
    const tau = (i) => tr.t[i] - h0;
    const idx = (temps) => { let a = 0, b = n - 1; while (a < b) { const m = (a + b) >> 1; if (tau(m) < temps) a = m + 1; else b = m; } return a; };
    const iDep = idx(0);
    const fenetres = [];                                   // portions hors spirale : départ -> S1, S1 -> S2, …, Sn -> arrivée
    let debut = iDep, prec = null;
    for (const m of M) { fenetres.push({ i0: debut, i1: idx(m.ts), prec, suiv: m }); debut = idx(m.te); prec = m; }
    fenetres.push({ i0: debut, i1: n - 1, prec, suiv: null });
    const km = (i) => tr.dist[i] - tr.dist[iDep];

    // ----- pompes critiques
    fenetres.forEach(f => {
      const m = f.prec; if (!m) return;
      const gain = m.e.h2 - m.e.h1;
      let pire = Infinity, iP = -1;
      for (let i = f.i0; i <= f.i1; i++) {
        if (tr.spirale[i]) continue;
        const sans = tr.alt[i] - gain - tr.sol[i];
        if (sans < pire) { pire = sans; iP = i; }
      }
      let manque = marge - pire, raison = 'relief';
      if (!f.suiv) {                                       // dernière pompe : le local final
        const arr = tr.alt[n - 1] - gain, besoin = r.hArrivee ?? 1000;
        if (besoin - arr > manque) { manque = besoin - arr; raison = 'arrivee'; }
      }
      const iS = idx(m.ts), solS = tr.sol[iS], basse = m.e.h1 - solS < seuilBas;
      // plan B : autres thermiques au moins aussi bons (à 0,5 m/s près) atteignables en plané depuis l'arrivée sur cette pompe
      let alternatives = null;
      if (o.thermiques && o.sol) {
        alternatives = 0; const vzP = gain / m.e.duree, fin = o.finesse ?? 25;
        for (const [la, lo, vz] of o.thermiques) {
          if (vz < vzP - 0.5) continue;
          const d = dist(m.e.lat1, m.e.lon1, la, lo); if (d < 400 || d > (m.e.h1 - 200) * fin) continue;
          let ok = true;                                   // le plané reste au-dessus du sol + marge tout du long
          for (let k = 1; k <= 12 && ok; k++) {
            const f = k / 12, z = m.e.h1 - f * d / fin;
            if (z - o.sol(m.e.lat1 + f * (la - m.e.lat1), m.e.lon1 + f * (lo - m.e.lon1)) < marge) ok = false;
          }
          if (ok && ++alternatives >= 9) break;
        }
      }
      const isolee = alternatives !== null && alternatives <= (o.maxAlternatives ?? 2);
      if ((manque > 0 && isolee) || m.e.h1 - solS < 300) res.pompes.push({
        alternatives, isolee, niveau: manque > 0 && isolee ? 'critique' : m.e.h1 - solS < 300 ? 'importante' : null,
        n: m.n, lat: m.e.lat1, lon: m.e.lon1, h1: m.e.h1, h2: m.e.h2, vz: gain / m.e.duree, km: km(iS),
        critique: manque > 0, manque: Math.max(0, Math.round(manque)), raison,
        obstacle: iP >= 0 ? { km: km(iP), sol: Math.round(tr.sol[iP]) } : null,
        basse, hauteurArrivee: Math.round(m.e.h1 - solS),
      });
    });

    // ----- passages délicats (cols / crêtes franchis avec peu de marge)
    const pasKm = 1.5;
    fenetres.forEach(f => {
      const cand = [];
      for (let i = f.i0; i <= f.i1; i++) {
        if (tr.spirale[i]) continue;
        const c = tr.alt[i] - tr.sol[i];
        if (c >= seuilCol || tr.sol[i] < 700) continue;
        // sol plus haut qu'à 1,5 km avant et après : on franchit un col ou une crête
        let av = i, ap = i;
        while (av > f.i0 && tr.dist[i] - tr.dist[av] < pasKm) av--;
        while (ap < f.i1 && tr.dist[ap] - tr.dist[i] < pasKm) ap++;
        if (tr.sol[i] - tr.sol[av] < 120 || tr.sol[i] - tr.sol[ap] < 120) continue;
        cand.push({ i, c });
      }
      cand.sort((a, b) => a.c - b.c);
      const gardes = [];
      for (const k of cand) if (gardes.every(g => Math.abs(tr.dist[g.i] - tr.dist[k.i]) > 3)) gardes.push(k);
      gardes.slice(0, 3).forEach(({ i, c }) => {
        const m = f.prec;
        const sortie = m ? m.e.h2 : (r.hDepart ?? tr.alt[iDep]);           // altitude en quittant la pompe précédente (ou au départ)
        const besoin = Math.round((sortie - (c - marge)) / 10) * 10;
        res.cols.push({
          lat: tr.lat[i], lon: tr.lon[i], sol: Math.round(tr.sol[i]), alt: Math.round(tr.alt[i]), marge: Math.round(c), km: km(i),
          apres: m ? m.n : 0, besoin, plafond: Math.round(tr.plafond[i]),
        });
        const plafP = m ? tr.plafond[idx(m.ts)] : Infinity, col = res.cols[res.cols.length - 1];
        col.plafondPompe = Math.round(plafP); col.reserve = Math.round(plafP - besoin);   // ce qu'il reste sous le plafond
        col.delicat = col.reserve < (o.reserveCol ?? 250) || c < 100;
      });
    });
    res.cols.sort((a, b) => a.km - b.km);
    return res;
  }
  racine.zonesCritiques = zonesCritiques;
  if (typeof module !== 'undefined') module.exports = zonesCritiques;
})(typeof window !== 'undefined' ? window : globalThis);
