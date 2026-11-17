// Spirale — export PDF de la préparation : carte de relief lisible + trajets proposés, puis une page de détail par option.
// La carte est dessinée à partir du relief du circuit (ombrage + teintes d'altitude + courbes de niveau),
// les trajets, cylindres et textes sont en vectoriel (nets à l'impression).
(() => {
  'use strict';
  const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  let chargement = null;
  function chargerJsPDF() {
    if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
    if (!chargement) chargement = new Promise((ok, ko) => {
      const s = document.createElement('script'); s.src = JSPDF;
      s.onload = () => window.jspdf ? ok(window.jspdf.jsPDF) : ko(new Error('jsPDF absent'));
      s.onerror = () => { chargement = null; ko(new Error('impossible de charger jsPDF')); };
      document.head.appendChild(s);
    });
    return chargement;
  }

  // Polices standard du PDF (WinAnsi) : on remplace les caractères qu'elles n'ont pas
  const txt = (s) => String(s).replace(/→/g, '>').replace(/[−–—]/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/≈/g, '~').replace(/[  ]/g, ' ').replace(/[★⚠⤢⌖]/g, '').replace(/[^\x00-\xff]/g, '');
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const DEG = Math.PI / 180;
  const distKm = (a, b, c, d) => {
    const x = Math.sin((c - a) * DEG / 2) ** 2 + Math.cos(a * DEG) * Math.cos(c * DEG) * Math.sin((d - b) * DEG / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  const dm = (x, pos, neg) => { const a = Math.abs(x), d = Math.floor(a); return `${d}°${((a - d) * 60).toFixed(2).padStart(5, '0')}'${x >= 0 ? pos : neg}`; };

  // ----- teintes d'altitude (claires, pour garder les tracés lisibles)
  const RAMPE = [[0, 196, 222, 186], [400, 208, 230, 190], [800, 228, 234, 196], [1200, 240, 230, 196], [1600, 232, 214, 178],
    [2000, 216, 194, 160], [2500, 198, 182, 166], [3000, 214, 210, 206], [3500, 238, 238, 240], [5000, 255, 255, 255]];
  function teinte(z) {
    if (z <= RAMPE[0][0]) return RAMPE[0];
    for (let k = 1; k < RAMPE.length; k++) if (z <= RAMPE[k][0]) {
      const a = RAMPE[k - 1], b = RAMPE[k], f = (z - a[0]) / (b[0] - a[0]);
      return [0, a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2]), a[3] + f * (b[3] - a[3])];
    }
    return RAMPE[RAMPE.length - 1];
  }

  // ----- carte de relief en image (canvas -> JPEG)
  function imageRelief(D, Z, bb, Wpx, Hpx) {
    const La = D.relief.lat, Lo = D.relief.lon, nLa = La.length, nLo = Lo.length;
    const dLa = La[1] - La[0], dLo = Lo[1] - Lo[0], latM = (La[0] + La[nLa - 1]) / 2;
    const dy = dLa * 111195, dx = dLo * 111195 * Math.cos(latM * DEG), zf = 1.6;
    // ombrage sur la grille (lumière du nord-ouest, 45°)
    const S = new Float32Array(nLa * nLo).fill(0.7071);
    const Lx = -0.5, Ly = 0.5, Lz = 0.7071;
    for (let i = 1; i < nLa - 1; i++) for (let j = 1; j < nLo - 1; j++) {
      const k = i * nLo + j;
      const gx = zf * (Z[k + 1] - Z[k - 1]) / (2 * dx), gy = zf * (Z[k + nLo] - Z[k - nLo]) / (2 * dy);
      const n = Math.hypot(gx, gy, 1);
      S[k] = Math.max(0, (-gx * Lx - gy * Ly + Lz) / n);
    }
    const cv = document.createElement('canvas'); cv.width = Wpx; cv.height = Hpx;
    const g = cv.getContext('2d'), img = g.createImageData(Wpx, Hpx), px = img.data;
    const bande = new Int32Array(Wpx), bandeK = new Int32Array(Wpx);
    for (let y = 0; y < Hpx; y++) {
      const lat = bb.latN - (y + 0.5) / Hpx * (bb.latN - bb.latS), fi = (lat - La[0]) / dLa;
      const i0 = Math.floor(fi), ti = fi - i0;
      let bG = null, bGK = null;
      for (let x = 0; x < Wpx; x++) {
        const o = 4 * (y * Wpx + x);
        const lon = bb.lonO + (x + 0.5) / Wpx * (bb.lonE - bb.lonO), fj = (lon - Lo[0]) / dLo;
        const j0 = Math.floor(fj), tj = fj - j0;
        if (i0 < 0 || j0 < 0 || i0 >= nLa - 1 || j0 >= nLo - 1) {
          px[o] = px[o + 1] = px[o + 2] = 236; px[o + 3] = 255; bande[x] = -999; bandeK[x] = -999; continue;
        }
        const k = i0 * nLo + j0;
        const z = (1 - ti) * ((1 - tj) * Z[k] + tj * Z[k + 1]) + ti * ((1 - tj) * Z[k + nLo] + tj * Z[k + nLo + 1]);
        const s = (1 - ti) * ((1 - tj) * S[k] + tj * S[k + 1]) + ti * ((1 - tj) * S[k + nLo] + tj * S[k + nLo + 1]);
        const c = teinte(z); let f = Math.min(1.18, 0.42 + 0.8 * s);
        const b = Math.floor(z / 250), bK = Math.floor(z / 1000);           // courbes : 250 m fines, 1000 m marquées
        if ((bG !== null && bK !== bGK) || (y > 0 && bandeK[x] !== -999 && bK !== bandeK[x])) f *= 0.62;
        else if ((bG !== null && b !== bG) || (y > 0 && bande[x] !== -999 && b !== bande[x])) f *= 0.84;
        bG = b; bGK = bK; bande[x] = b; bandeK[x] = bK;
        px[o] = Math.min(255, c[1] * f); px[o + 1] = Math.min(255, c[2] * f); px[o + 2] = Math.min(255, c[3] * f); px[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv.toDataURL('image/jpeg', 0.9);
  }

  // ----- outils de dessin vectoriel
  function outils(doc) {
    const GS = (o) => { try { doc.setGState(new doc.GState({ opacity: o, 'stroke-opacity': o })); } catch { /* ancien jsPDF */ } };
    const poly = (P, ferme) => {
      if (P.length < 2) return;
      const d = []; for (let k = 1; k < P.length; k++) d.push([P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]]);
      doc.lines(d, P[0][0], P[0][1], [1, 1], 'S', !!ferme);
    };
    const texte = (s, x, y, o = {}) => {                 // texte avec un liseré blanc (lisible sur le relief)
      s = txt(s);
      doc.setFontSize(o.taille || 8); doc.setFont('helvetica', o.gras ? 'bold' : 'normal');
      if (o.halo !== false) {
        doc.setDrawColor(255, 255, 255); doc.setLineWidth(o.halo || 0.7); doc.setLineJoin('round');
        doc.text(s, x, y, { align: o.align || 'left', baseline: o.base || 'alphabetic', renderingMode: 'stroke' });
      }
      doc.setTextColor(...(o.couleur || [20, 24, 32]));
      doc.text(s, x, y, { align: o.align || 'left', baseline: o.base || 'alphabetic', renderingMode: 'fill' });
    };
    return { GS, poly, texte };
  }

  function pointsTrajet(r) { const p = [[r.etapes[0].lat1, r.etapes[0].lon1]]; r.etapes.forEach(e => { if (e.type === 'T') p.push([e.lat2, e.lon2]); }); return p; }

  // ----- emprise : tous les trajets + cylindres, avec une marge ; la page suit sa forme (paysage ou portrait)
  function emprise(C) {
    const { D, options } = C, T = D.tache;
    let latS = Infinity, latN = -Infinity, lonO = Infinity, lonE = -Infinity;
    const ajoute = (la, lo, r = 0) => {
      const kx = 111195 * Math.cos(la * DEG);
      latS = Math.min(latS, la - r / 111195); latN = Math.max(latN, la + r / 111195);
      lonO = Math.min(lonO, lo - r / kx); lonE = Math.max(lonE, lo + r / kx);
    };
    T.forEach(t => ajoute(t.lat, t.lon, t.rayon + 2000));
    options.forEach(o => o.ok && pointsTrajet(o).forEach(([la, lo]) => ajoute(la, lo, 2500)));
    const kx0 = 111195 * Math.cos((latS + latN) / 2 * DEG);
    return { latS, latN, lonO, lonE, paysage: (lonE - lonO) * kx0 >= (latN - latS) * 111195 };
  }
  // ----- page 1 : la carte
  function pageCarte(doc, C, U, E0) {
    const { D, options, vue, LETTRES, COULEURS, hms } = C, T = D.tache;
    const PW = E0.paysage ? 297 : 210, PH = E0.paysage ? 210 : 297, mx = 10, my0 = 20, mW = PW - 2 * mx, mH = PH - my0 - 12;
    let { latS, latN, lonO, lonE } = E0;
    const latC = (latS + latN) / 2, kx = 111195 * Math.cos(latC * DEG), ky = 111195;
    let wM = (lonE - lonO) * kx, hM = (latN - latS) * ky;
    const ratio = mW / mH;
    if (wM / hM < ratio) { const d = (hM * ratio - wM) / 2 / kx; lonO -= d; lonE += d; wM = hM * ratio; }
    else { const d = (wM / ratio - hM) / 2 / ky; latS -= d; latN += d; hM = wM / ratio; }
    const bb = { latS, latN, lonO, lonE };
    const X = (lo) => mx + (lo - lonO) / (lonE - lonO) * mW, Y = (la) => my0 + (latN - la) / (latN - latS) * mH;
    const mmParM = mW / wM;

    // en-tête
    U.texte(`Spirale · ${D.titre}`, mx, 9, { taille: 15, gras: true, halo: false });
    U.texte(C.sousTitre, mx, 15, { taille: 8.5, halo: false, couleur: [80, 88, 100] });
    U.texte(new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }), PW - mx, 9, { taille: 8.5, align: 'right', halo: false, couleur: [80, 88, 100] });

    // relief
    doc.addImage(imageRelief(D, C.relief, bb, Math.round(mW * 8), Math.round(mH * 8)), 'JPEG', mx, my0, mW, mH);
    doc.saveGraphicsState(); doc.rect(mx, my0, mW, mH, null); doc.clip(); doc.discardPath();

    // circuit : ligne pointillée et cylindres
    doc.setDrawColor(112, 72, 232); doc.setLineWidth(0.45); doc.setLineDashPattern([2.2, 1.6], 0);
    U.poly(T.map(t => [X(t.lon), Y(t.lat)])); doc.setLineDashPattern([], 0);
    T.forEach(t => { doc.setLineWidth(0.5); doc.circle(X(t.lon), Y(t.lat), Math.max(0.6, t.rayon * mmParM), 'S'); });

    // autres options (pointillés de leur couleur), puis l'option affichée par-dessus
    const ordre = options.map((o, i) => i).filter(i => i !== vue && options[i].ok).concat(options[vue] && options[vue].ok ? [vue] : []);
    for (const i of ordre) {
      const P = pointsTrajet(options[i]).map(([la, lo]) => [X(lo), Y(la)]), c = hex(COULEURS[i]), actif = i === vue;
      U.GS(0.9); doc.setDrawColor(255, 255, 255); doc.setLineWidth(actif ? 1.6 : 1.1); U.poly(P); U.GS(1);
      doc.setDrawColor(...c); doc.setLineWidth(actif ? 0.65 : 0.5);
      if (!actif) doc.setLineDashPattern([2.4, 1.4], 0);
      U.poly(P); doc.setLineDashPattern([], 0);
      if (options.length > 1) {                         // pastille avec la lettre, au milieu du trajet
        const m = P[Math.floor(P.length * (0.35 + 0.1 * i))] || P[0];
        doc.setFillColor(...c); doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.5); doc.circle(m[0], m[1], 2.2, 'FD');
        U.texte(LETTRES[i], m[0], m[1] + 0.05, { taille: 7.5, gras: true, halo: false, couleur: [255, 255, 255], align: 'center', base: 'middle' });
      }
    }
    // spirales de toutes les options : rouge pour l'option affichée, couleur de l'option sinon ; « A1 = B1 » si partagée
    (C.spirales || []).slice().reverse().forEach(sp => {
      const actif = sp.options.includes(vue), x = X(sp.lon), y = Y(sp.lat), c = actif ? [208, 0, 0] : hex(COULEURS[sp.options[0]]);
      doc.setDrawColor(255, 255, 255); doc.setLineWidth(1.1); doc.circle(x, y, actif ? 1.9 : 1.6, 'S');
      doc.setDrawColor(...c); doc.setLineWidth(actif ? 0.55 : 0.45); doc.circle(x, y, actif ? 1.9 : 1.6, 'S');
      const s = `${sp.tags.join('=')}  +${sp.vz.toFixed(1)}`; doc.setFontSize(actif ? 7 : 6.5); doc.setFont('helvetica', 'bold');
      const aGauche = x + 2.5 + doc.getTextWidth(s) > mx + mW - 2;
      U.texte(s, aGauche ? x - 2.5 : x + 2.5, y + 1, { taille: actif ? 7 : 6.5, gras: true, couleur: actif ? [170, 0, 0] : c, align: aGauche ? 'right' : 'left' });
    });
    // noms des points
    // (points confondus — ex. départ et arrivée au même terrain — regroupés en une seule étiquette)
    const etq = [];
    T.forEach((t, k) => {
      const nom = `${k === 0 ? 'D' : k === T.length - 1 ? 'A' : k} ${t.nom.replace(/^(Départ|Arrivée|P\d+) /, '')}`;
      const m = etq.find(e => distKm(e.t.lat, e.t.lon, t.lat, t.lon) < 0.5);
      if (m) { m.noms.push(nom); m.r = Math.max(m.r, t.rayon); } else etq.push({ t, noms: [nom], r: t.rayon });
    });
    doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    etq.forEach(e => {
      const s = txt(e.noms.join(' / ')), w = doc.getTextWidth(s), dr = Math.max(1.2, e.r * mmParM) + 0.8, x = X(e.t.lon);
      const aGauche = x + dr + w > mx + mW - 2;              // trop près du bord droit : étiquette à gauche du point
      U.texte(s, aGauche ? x - dr : x + dr, Y(e.t.lat) - 1, { taille: 8, gras: true, couleur: [84, 44, 196], align: aGauche ? 'right' : 'left' });
    });
    doc.restoreGraphicsState();
    doc.setDrawColor(150, 156, 166); doc.setLineWidth(0.3); doc.rect(mx, my0, mW, mH, 'S');

    // échelle + nord
    const km = [5, 10, 20, 25, 50].find(k => k * 1000 * mmParM >= 25) || 50, L = km * 1000 * mmParM, ex = mx + 5, ey = my0 + mH - 6;
    doc.setFillColor(255, 255, 255); U.GS(0.85); doc.rect(ex - 2, ey - 5, L + 16, 8, 'F'); U.GS(1);
    doc.setDrawColor(20, 24, 32); doc.setLineWidth(0.5); doc.line(ex, ey, ex + L, ey); doc.line(ex, ey - 1.2, ex, ey + 1.2); doc.line(ex + L, ey - 1.2, ex + L, ey + 1.2);
    U.texte(`${km} km`, ex + L + 2, ey + 1, { taille: 7.5, gras: true, halo: false });
    const nx = mx + mW - 8, ny = my0 + mH - 14;
    doc.setFillColor(20, 24, 32); doc.triangle(nx, ny - 5, nx - 2, ny + 1, nx + 2, ny + 1, 'F');
    U.texte('N', nx, ny + 5, { taille: 8, gras: true, align: 'center' });

    // légende
    const lignes = options.map((o, i) => o.ok ? `${LETTRES[i]}  ${hms(o.tempsTotal)} · ${(o.distanceCircuit / (o.tempsTotal / 3600)).toFixed(1)} km/h · ${o.variante || ''}` : null);
    const nL = lignes.filter(Boolean).length, lh = 10 + 4.6 * nL + 18;
    const occupe = [];                                     // tout ce qu'il ne faut pas cacher
    options.forEach(o => o.ok && pointsTrajet(o).forEach(([la, lo]) => occupe.push([X(lo), Y(la)])));
    T.forEach(t => { for (let k = 0; k < 12; k++) occupe.push([X(t.lon) + 2 + 3 * k, Y(t.lat)]); });
    const coins = [[mx + mW - 82, my0 + 4], [mx + 4, my0 + 4], [mx + mW - 82, my0 + mH - lh - 4], [mx + 4, my0 + mH - lh - 18]];
    const gene = ([x, y]) => occupe.filter(([a, b]) => a > x - 3 && a < x + 81 && b > y - 3 && b < y + lh + 3).length;
    const [lx, ly] = coins.reduce((m, c) => gene(c) < gene(m) ? c : m);
    doc.setFillColor(255, 255, 255); U.GS(0.9); doc.roundedRect(lx, ly, 78, lh, 1.5, 1.5, 'F'); U.GS(1);
    U.texte(options.length > 1 ? 'Trajets proposés (Diana 2)' : 'Trajet optimal (Diana 2)', lx + 3, ly + 5, { taille: 8, gras: true, halo: false });
    let yy = ly + 10;
    options.forEach((o, i) => {
      if (!o.ok) return;
      doc.setDrawColor(...hex(COULEURS[i])); doc.setLineWidth(i === vue ? 0.8 : 0.6);
      if (i !== vue) doc.setLineDashPattern([1.6, 1], 0);
      doc.line(lx + 3, yy - 1, lx + 10, yy - 1); doc.setLineDashPattern([], 0);
      U.texte(lignes[i], lx + 12, yy, { taille: 7.2, gras: i === vue, halo: false }); yy += 4.6;
    });
    doc.setDrawColor(208, 0, 0); doc.setLineWidth(0.5); doc.circle(lx + 6.5, yy + 0.2, 1.4, 'S');
    U.texte(options.length > 1 ? 'spirale (B2 = 2e de l\'option B, m/s) — détail par option' : 'spirale (n°, m/s) — détail page suivante', lx + 12, yy + 1, { taille: 7, halo: false }); yy += 4.6;
    doc.setDrawColor(112, 72, 232); doc.circle(lx + 6.5, yy + 0.2, 1.4, 'S');
    U.texte('cylindre / point du circuit', lx + 12, yy + 1, { taille: 7, halo: false }); yy += 4.6;
    // rampe d'altitudes
    const rx = lx + 3, rw = 72, alts = [0, 1000, 2000, 3000, 4000];
    for (let k = 0; k < 72; k++) { const c = teinte(k / 72 * 4000); doc.setFillColor(c[1], c[2], c[3]); doc.rect(rx + k * rw / 72, yy, rw / 72 + 0.05, 2.2, 'F'); }
    alts.forEach(a => U.texte(a === 4000 ? '4000 m' : String(a), rx + a / 4000 * rw, yy + 5.4, { taille: 6, halo: false, align: a === 4000 ? 'right' : a ? 'center' : 'left' }));

    U.texte(txt(`Calcul théorique Spirale ${C.version} · relief du circuit (ombrage, teintes et courbes tous les 250 m, maîtresses tous les 1000 m) · trajets à vérifier avant le vol`),
      mx, PH - 5, { taille: 6.8, halo: false, couleur: [110, 118, 130] });
  }

  // ----- profil en vectoriel
  function profil(doc, U, r, x0, y0, W, H) {
    const tr = r.trace, n = tr.dist.length; if (!n) return;
    let d0 = Infinity, d1 = -Infinity, zM = 0;
    for (let i = 0; i < n; i++) { d0 = Math.min(d0, tr.dist[i]); d1 = Math.max(d1, tr.dist[i]); zM = Math.max(zM, tr.alt[i], tr.plafond[i], tr.sol[i]); }
    zM = Math.ceil((zM + 200) / 500) * 500;
    const ml = 12, X = (d) => x0 + ml + (d - d0) / (d1 - d0) * (W - ml), Y = (z) => y0 + (1 - z / zM) * H;
    const iDep = Math.max(0, Array.prototype.findIndex.call(tr.t, t => t >= tr.heureDepart)), dDep = tr.dist[iDep];
    doc.setDrawColor(220, 224, 230); doc.setLineWidth(0.2);
    for (let z = 0; z <= zM; z += 500) { doc.line(x0 + ml, Y(z), x0 + W, Y(z)); U.texte(`${z}`, x0 + ml - 1.5, Y(z) + 1, { taille: 6.5, halo: false, align: 'right', couleur: [100, 108, 120] }); }
    const pas = (d1 - d0) > 200 ? 50 : 25;
    for (let d = Math.ceil((d0 - dDep) / pas) * pas; d + dDep <= d1; d += pas) U.texte(`${d} km`, X(d + dDep), y0 + H + 4, { taille: 6.5, halo: false, align: 'center', couleur: [100, 108, 120] });
    const pas2 = Math.max(1, Math.floor(n / 1500)), P = [];
    for (let i = 0; i < n; i += pas2) P.push(i);
    // sol
    doc.setFillColor(176, 150, 122); doc.setDrawColor(150, 124, 98); doc.setLineWidth(0.15);
    const solPts = [[X(tr.dist[0]), Y(0)], ...P.map(i => [X(tr.dist[i]), Y(Math.max(0, tr.sol[i]))]), [X(tr.dist[n - 1]), Y(0)]];
    const d = []; for (let k = 1; k < solPts.length; k++) d.push([solPts[k][0] - solPts[k - 1][0], solPts[k][1] - solPts[k - 1][1]]);
    doc.lines(d, solPts[0][0], solPts[0][1], [1, 1], 'FD', true);
    // plafond
    doc.setDrawColor(47, 111, 208); doc.setLineWidth(0.35); doc.setLineDashPattern([1.6, 1.1], 0);
    U.poly(P.map(i => [X(tr.dist[i]), Y(tr.plafond[i])])); doc.setLineDashPattern([], 0);
    // trajet puis spirales en rouge
    doc.setDrawColor(20, 24, 32); doc.setLineWidth(0.4); U.poly(P.map(i => [X(tr.dist[i]), Y(tr.alt[i])]));
    doc.setDrawColor(208, 0, 0); doc.setLineWidth(0.8);
    for (let i = 1; i < n; i++) if (tr.spirale[i]) doc.line(X(tr.dist[i - 1]), Y(tr.alt[i - 1]), X(tr.dist[i]), Y(tr.alt[i]));
    U.texte('Profil : trajet noir · spirales rouges · plafond bleu · sol marron', x0 + W, y0 - 1.5, { taille: 6.8, halo: false, align: 'right', couleur: [100, 108, 120] });
  }

  function tableau(doc, U, x, y, cols, lignes, o = {}) {
    const h = o.h || 4.4;
    doc.setFillColor(238, 241, 246); doc.rect(x, y - 3.2, cols.reduce((a, c) => a + c[1], 0), h, 'F');
    let cx = x; cols.forEach(([t, w, al]) => { U.texte(t, al === 'r' ? cx + w - 1 : cx + 1, y, { taille: 7, gras: true, halo: false, align: al === 'r' ? 'right' : 'left' }); cx += w; });
    y += h;
    lignes.forEach((l, k) => {
      if (k % 2) { doc.setFillColor(248, 249, 251); doc.rect(x, y - 3.2, cols.reduce((a, c) => a + c[1], 0), h, 'F'); }
      cx = x; cols.forEach(([, w, al], j) => { U.texte(l[j], al === 'r' ? cx + w - 1 : cx + 1, y, { taille: 7, halo: false, align: al === 'r' ? 'right' : 'left', gras: !!(o.gras && o.gras(k, j)) }); cx += w; });
      y += h;
    });
    return y;
  }

  // ----- une page de détail par option
  function pageOption(doc, C, U, i) {
    const { D, options, LETTRES, COULEURS, hms } = C, r = options[i], T = D.tache;
    doc.addPage('a4', 'landscape');
    const sg = (g) => `${g < 0 ? '-' : '+'}${Math.abs(Math.round(g))}`;
    doc.setFillColor(...hex(COULEURS[i])); doc.circle(14, 9, 3.4, 'F');
    U.texte(LETTRES[i], 14, 9.1, { taille: 10, gras: true, halo: false, couleur: [255, 255, 255], align: 'center', base: 'middle' });
    U.texte(`Option ${LETTRES[i]} · ${r.variante || 'Optimal'} — ${hms(r.tempsTotal)} · ${(r.distanceCircuit / (r.tempsTotal / 3600)).toFixed(1)} km/h · ${r.distanceCircuit.toFixed(1)} km`, 20, 11, { taille: 12.5, gras: true, halo: false });
    const E = r.etapes, mo = E.filter(e => e.type === 'M'), tSpi = mo.reduce((a, e) => a + e.duree, 0);
    U.texte(`${D.titre} · départ calculé à ${Math.round(r.hDepart)} m · spirale ${Math.round(100 * tSpi / r.tempsTotal)} % du temps (${mo.length} spirales) · ${Math.round(r.hauteurMini)} m mini au-dessus du sol` +
      (r.plafondsReleves ? ` · plafonds relevés de ${r.plafondsReleves.de} m` : ''), 20, 16.5, { taille: 8, halo: false, couleur: [80, 88, 100] });
    profil(doc, U, r, 10, 24, 277, 52);

    // branches
    const br = []; let cur = { t: 0, spi: 0, gain: 0, h: null };
    for (const e of E) { cur.t += e.duree; if (e.type === 'M') cur.spi += e.duree; cur.gain += e.gain; if (e.valide) { cur.h = e.h2; br.push(cur); cur = { t: 0, spi: 0, gain: 0, h: null }; } }
    const lb = [];
    for (let k = 0; k < Math.min(T.length - 1, br.length); k++) {
      const d = distKm(T[k].lat, T[k].lon, T[k + 1].lat, T[k + 1].lon), x = br[k];
      lb.push([T[k + 1].nom.replace(/^(Départ|Arrivée) /, ''), d.toFixed(1), hms(x.t), Math.round(d / (x.t / 3600)), `${Math.round(100 * x.spi / x.t)} %`, sg(x.gain), Math.round(x.h)]);
    }
    U.texte('Par branche', 10, 88, { taille: 9, gras: true, halo: false });
    tableau(doc, U, 10, 94, [['Jusqu\'à', 42], ['km', 13, 'r'], ['Temps', 17, 'r'], ['km/h', 13, 'r'], ['Spirale', 15, 'r'], ['Chem. m', 16, 'r'], ['Alt. m', 14, 'r']], lb);

    // spirales
    const ls = []; let t = 0, dist = 0, n = 0;
    for (const e of E) {
      if (e.type === 'M') { n++; ls.push([LETTRES[i] + n, Math.round(dist), hms(t), `${Math.round(e.h1)} > ${Math.round(e.h2)}`, ((e.h2 - e.h1) / e.duree).toFixed(1), hms(e.duree).replace(/^0:/, ''), `${dm(e.lat1, 'N', 'S')} ${dm(e.lon1, 'E', 'W')}`]); }
      t += e.duree; dist += e.dist || 0;
    }
    U.texte('Spirales (numéros de la carte)', 150, 88, { taille: 9, gras: true, halo: false });
    if (ls.length) tableau(doc, U, 150, 94, [['N°', 8], ['km', 11, 'r'], ['Après', 15, 'r'], ['Alt. m', 24, 'r'], ['m/s', 11, 'r'], ['Durée', 13, 'r'], ['Position', 55]], ls.slice(0, 22));
    else U.texte('Aucune spirale : le trajet se fait en cheminement.', 150, 95, { taille: 8, halo: false });
    if (ls.length > 22) U.texte(`… et ${ls.length - 22} autres`, 150, 94 + 23 * 4.4, { taille: 7, halo: false });

    // comparaison des options
    if (options.length > 1 && i === C.vue) {
      const A = options[0];
      const lc = options.map((o, k) => o.ok ? [LETTRES[k], o.variante || '', hms(o.tempsTotal), k ? `${o.tempsTotal >= A.tempsTotal ? '+' : '-'}${hms(Math.abs(o.tempsTotal - A.tempsTotal))}` : '—', (o.distanceCircuit / (o.tempsTotal / 3600)).toFixed(1)] : [LETTRES[k], 'impossible', '', '', '']);
      const y = 94 + 4.4 * (lb.length + 2);
      U.texte('Comparaison des options', 10, y, { taille: 9, gras: true, halo: false });
      tableau(doc, U, 10, y + 6, [['', 8], ['Variante', 58], ['Temps', 20, 'r'], ['Écart', 22, 'r'], ['km/h', 22, 'r']], lc);
    }
    U.texte(txt(`Spirale ${C.version} · ${C.sousTitre}`), 10, 205, { taille: 6.8, halo: false, couleur: [110, 118, 130] });
  }

  window.SpiralePDF = {
    async generer(C) {
      const jsPDF = await chargerJsPDF();
      const E0 = emprise(C);
      const doc = new jsPDF({ orientation: E0.paysage ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
      const U = outils(doc);
      pageCarte(doc, C, U, E0);
      const ordre = [C.vue, ...C.options.map((o, i) => i).filter(i => i !== C.vue)];
      for (const i of ordre) if (C.options[i].ok) pageOption(doc, C, U, i);
      const nom = `${C.D.id}_preparation${C.options.length > 1 ? '' : '_' + C.LETTRES[C.vue]}.pdf`;
      doc.save(nom);
      return nom;
    },
  };
})();
