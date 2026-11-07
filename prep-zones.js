// Spirale — zones de vol automatiques (façon XC Therm)
// Le circuit est découpé en zones d'environ 22 km (cellules de Voronoï autour d'une grille
// hexagonale). Chaque zone connaît la hauteur de ses crêtes (90e centile du relief) ; son plafond
// est interpolé entre « plafond en plaine » et « plafond sur les plus hauts reliefs ».
'use strict';

function genererZonesVol(D, reliefBuf, espacementKm = 22) {
  const Z = new Int16Array(reliefBuf), R = D.relief;
  const lat0 = (D.zone.latMin + D.zone.latMax) / 2, lon0 = (D.zone.lonMin + D.zone.lonMax) / 2;
  const ky = 111.195, kx = 111.195 * Math.cos(lat0 * Math.PI / 180);
  const versKm = (la, lo) => [(lo - lon0) * kx, (la - lat0) * ky];
  const versDeg = (x, y) => [lat0 + y / ky, lon0 + x / kx];
  const [x0, y0] = versKm(D.zone.latMin, D.zone.lonMin), [x1, y1] = versKm(D.zone.latMax, D.zone.lonMax);

  // germes : grille hexagonale centrée sur la zone
  const s = espacementKm, dy = s * Math.sqrt(3) / 2, germes = [];
  const nl = Math.max(1, Math.round((y1 - y0) / dy)), oy = y0 + ((y1 - y0) - (nl - 1) * dy) / 2;
  for (let i = 0; i < nl; i++) {
    const y = oy + i * dy, dec = (i % 2) * s / 2;
    const nc = Math.max(1, Math.round((x1 - x0 - dec) / s)), ox = x0 + dec + ((x1 - x0 - dec) - (nc - 1) * s) / 2;
    for (let j = 0; j < nc; j++) germes.push({ x: ox + j * s, y });
  }

  // polygones de Voronoï (rectangle de la zone découpé par les médiatrices)
  const coupe = (poly, a, b) => {   // garde les points plus proches de a que de b
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, nx = b.x - a.x, ny = b.y - a.y;
    const f = (p) => (p[0] - mx) * nx + (p[1] - my) * ny, out = [];
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length], fp = f(p), fq = f(q);
      if (fp <= 0) out.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
    return out;
  };
  germes.forEach((g, i) => {
    let poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    germes.forEach((h, j) => { if (i !== j && Math.hypot(h.x - g.x, h.y - g.y) < 3 * s) poly = coupe(poly, g, h); });
    g.poly = poly.map(([x, y]) => versDeg(x, y));
    g.vals = [];
  });

  // hauteur des crêtes de chaque zone (un point de relief sur 3 dans chaque direction)
  const plusProche = (x, y) => {
    let b = 0, db = Infinity;
    for (let k = 0; k < germes.length; k++) { const d = (germes[k].x - x) ** 2 + (germes[k].y - y) ** 2; if (d < db) { db = d; b = k; } }
    return b;
  };
  for (let i = 0; i < R.nLat; i += 3) for (let j = 0; j < R.nLon; j += 3) {
    const [x, y] = versKm(R.lat[i], R.lon[j]);
    germes[plusProche(x, y)].vals.push(Z[i * R.nLon + j]);
  }
  return germes.map((g, id) => {
    const v = g.vals.sort((a, b) => a - b);
    const crete = v.length ? v[Math.min(v.length - 1, Math.floor(0.9 * v.length))] : 0;
    const [lat, lon] = versDeg(g.x, g.y);
    return { id, lat, lon, poly: g.poly, crete };
  });
}

// Plafond et Vz de chaque zone à partir des réglages globaux et des corrections par zone
function reglerZonesVol(zones, reg, corrections) {
  let rMin = Infinity, rMax = -Infinity;
  zones.forEach(z => { rMin = Math.min(rMin, z.crete); rMax = Math.max(rMax, z.crete); });
  const pMax = Math.max(reg.plafondMax, reg.plafondPlaine);
  return zones.map(z => {
    const f = rMax > rMin ? (z.crete - rMin) / (rMax - rMin) : 1;
    const c = (corrections && corrections[z.id]) || {};
    const auto = Math.round((reg.plafondPlaine + (pMax - reg.plafondPlaine) * f) / 50) * 50;
    return { ...z, auto, plafond: auto + (c.plafond || 0), vzMax: Math.round(reg.vzMax * (c.vz || 1) * 10) / 10, corrige: !!(c.plafond || (c.vz && c.vz !== 1)) };
  });
}
