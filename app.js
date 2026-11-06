/* =====================================================================
   app.js — Affichage : carte, barogramme, stats, tableaux
   S'appuie sur analyse.js (objet global IGC), Leaflet et Chart.js.
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const etat = {
    analyse: null, carte: null, couches: {}, marqueur: null,
    graphe: null, histo: null, modeCouleur: 'phases',
    tCurseur: null, selection: null, redessin: false,
    vue: 'analyse',          // 'analyse' | 'AAT' | 'CT'
    circuit: [],             // [{ lat, lon, nom, nomAuto, rayon (m) ou null = défaut }]
    tempsMini: 3 * 3600,     // temps minimum AAT (s)
    dessin: false,           // ajout de points par clic sur la carte
    resCircuit: null,
    mc: null,                // Vz de référence choisi (null = Vz moyen du vol)
    temps: null              // résultat gains / pertes de temps
  };

  // ----- Formatage ---------------------------------------------------
  const nf = (x, d = 0) => (x == null || !isFinite(x)) ? '—'
    : x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const signe = (x, d = 1) => (x == null || !isFinite(x)) ? '—' : (x > 0 ? '+' : '') + nf(x, d);
  const p2 = (n) => String(n).padStart(2, '0');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function fmtDuree(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (h) return `${h} h ${p2(m)}`;
    if (m) return `${m} min ${p2(sec)}`;
    return `${sec} s`;
  }
  function fmtDureeTab(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`;
  }
  function fmtHeure(t, avecSec) {
    const a = etat.analyse;
    if (a && a.date) {
      const d = new Date(Date.UTC(a.date.y, a.date.m - 1, a.date.d) + t * 1000);
      return d.toLocaleTimeString('fr-FR', avecSec
        ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' });
    }
    const s = ((Math.round(t) % 86400) + 86400) % 86400;
    return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s % 3600 / 60)) + (avecSec ? ':' + p2(s % 60) : '') + ' UTC';
  }
  function fmtFinesse(f) {
    if (f === Infinity) return '∞';
    if (f == null || !isFinite(f)) return '—';
    if (f > 200) return '> 200';
    return nf(f, f < 100 ? 1 : 0);
  }
  function fmtEcart(s) {
    const v = Math.abs(Math.round(s));
    if (v === 0) return '0 s';
    const sig = s >= 0 ? '+' : '−';
    const m = Math.floor(v / 60), sec = v % 60;
    return m ? `${sig}${m} min ${p2(sec)}` : `${sig}${sec} s`;
  }
  const fmtDist = (m) => m < 1000 ? `${nf(m)} m` : `${nf(m / 1000, 1)} km`;
  const fleche = (dir) => `<span class="fleche" style="transform:rotate(${Math.round(dir + 180)}deg)">↑</span>`;

  // ----- Couleurs ----------------------------------------------------
  const couleurPhase = (p) => ({ R: css('--remorque'), T: css('--thermique'), G: css('--transition') }[p] || css('--remorque'));
  const ECHELLE_VARIO = [
    { max: -2, c: '#1e4f8f', lab: '< −2' },
    { max: -1, c: '#3d80c4', lab: '−2…−1' },
    { max: 0, c: '#8fb9dc', lab: '−1…0' },
    { max: 1, c: '#f2cf4a', lab: '0…1' },
    { max: 2, c: '#f2963a', lab: '1…2' },
    { max: 3, c: '#e2561a', lab: '2…3' },
    { max: Infinity, c: '#ac1f1f', lab: '> 3' }
  ];
  const couleurVario = (v) => ECHELLE_VARIO.find(e => v < e.max).c;
  const alpha = (hex, a) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };

  // ===================================================================
  // Chargement du fichier
  // ===================================================================
  function lireFichier(f) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => charger(r.result, f.name);
    r.onerror = () => erreur('Impossible de lire ce fichier.');
    r.readAsText(f);
  }

  function erreur(msg) {
    if (!$('#resultats').hidden) {
      // Message temporaire en haut de page (pas d'alert(), bloqué sur certains hébergements)
      let toast = $('#toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        toast.setAttribute('role', 'alert');
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.hidden = false;
      clearTimeout(erreur.minuteur);
      erreur.minuteur = setTimeout(() => { toast.hidden = true; }, 6000);
      return;
    }
    const el = $('#erreur');
    el.textContent = msg;
    el.hidden = false;
  }

  function charger(texte, nom) {
    let a;
    try {
      a = IGC.analyser(IGC.lire(texte));
    } catch (e) {
      console.error(e);
      erreur(e.message || "Erreur pendant l'analyse du fichier.");
      return;
    }
    etat.analyse = a;
    etat.temps = null;
    etat.resCircuit = null;
    etat.selection = null;
    etat.tCurseur = null;
    $('#erreur').hidden = true;
    $('#accueil').hidden = true;
    $('#resultats').hidden = false;
    $('#btn-autre').hidden = false;
    $('#nom-fichier').textContent = nom;
    document.title = `${nom} — Spirale`;

    afficherInfos();
    afficherKpi();
    afficherCarte();
    afficherBarogramme();
    afficherRepartition();
    afficherHisto();
    afficherTables();
    etat.mc = null;
    afficherTemps();
    chargerCircuitIGC();
    afficherVue();
    window.scrollTo(0, 0);
  }

  // ===================================================================
  // En-tête du vol
  // ===================================================================
  function afficherInfos() {
    const a = etat.analyse, e = a.entete || {};
    const date = a.date
      ? new Date(Date.UTC(a.date.y, a.date.m - 1, a.date.d)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      : null;
    const items = [
      ['Date', date],
      ['Pilote', e.pilote],
      ['Planeur', e.planeur],
      ['Immatriculation', [e.immat, e.concours].filter(Boolean).join(' · ')],
      ['Décollage', fmtHeure(a.totaux.heureDeco)],
      ['Atterrissage', fmtHeure(a.totaux.heureAtterro)]
    ].filter(x => x[1]);
    $('#infos-vol').innerHTML = items.map(([l, v]) =>
      `<div class="info"><span class="info-lab">${l}</span><span class="info-val">${echapper(v)}</span></div>`).join('');
    $('#source-alt').textContent = a.sourceAlt === 'GPS' ? '· altitude GPS' : '· altitude pression (QNE)';
  }
  function echapper(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ===================================================================
  // Tuiles de statistiques
  // ===================================================================
  const tuile = (lab, val, unite = '', sous = '', vedette = false) =>
    `<div class="tuile${vedette ? ' vedette' : ''}"><div class="t-lab">${lab}</div>` +
    `<div class="t-val">${val}${unite ? `<span class="t-u">${unite}</span>` : ''}</div>` +
    (sous ? `<div class="t-sous">${sous}</div>` : '') + '</div>';

  function afficherKpi() {
    const T = etat.analyse.totaux;

    $('#kpi-general').innerHTML = [
      tuile('Durée de vol', fmtDuree(T.dureeVol), '', `${fmtHeure(T.heureDeco)} → ${fmtHeure(T.heureAtterro)}`, true),
      tuile('Distance parcourue', nf(T.distanceTrace / 1000, 1), 'km', 'le long de la trace', true),
      tuile('Vitesse moyenne', nf(T.vitesseMoy * 3.6, 1), 'km/h', 'après largage'),
      tuile('Altitude max', nf(T.altMax), 'm', `terrain ${nf(T.altDeco)} m`),
      tuile('Éloignement max', nf(T.distMax / 1000, 1), 'km', 'du point de décollage'),
      T.largage
        ? tuile('Largage', nf(T.largage.alt), 'm', `${fmtHeure(T.largage.t)} · ${fmtDuree(T.largage.duree)} de remorqué`)
        : tuile('Largage', '—', '', 'non détecté (autonome ?)'),
      tuile('Vent moyen', T.vent ? `${fleche(T.vent.dir)} ${nf(T.vent.dir)}°` : '—', '',
        T.vent ? `${nf(T.vent.vit * 3.6)} km/h, mesuré en spirale` : 'pas assez de spirales'),
      tuile('Altitude mini', nf(T.altMin), 'm', 'après largage')
    ].join('');

    const m = T.meilleur;
    $('#kpi-thermiques').innerHTML = [
      tuile('Vz moyen', signe(T.vzMoyThermique, 2), 'm/s', 'gain net / temps en spirale', true),
      tuile('Temps en spirale', nf(T.pctSpirale * 100), '%', fmtDuree(T.tempsSpirale), true),
      tuile('Nombre de thermiques', nf(T.nbThermiques)),
      tuile('Gain cumulé', nf(T.gainThermique), 'm', 'en thermique'),
      tuile('Meilleur thermique', m ? signe(m.vzMoy, 1) : '—', m ? 'm/s' : '', m ? `${fmtHeure(m.debut)} · +${nf(m.gain)} m` : ''),
      tuile('Sens de spirale', T.pctGauche == null ? '—' : `${nf(T.pctGauche * 100)} % G`, '',
        T.pctGauche == null ? '' : `${nf((1 - T.pctGauche) * 100)} % à droite`),
      tuile('Inclinaison moyenne', nf(T.inclinaisonMoy), '°', 'estimée'),
      tuile('Vitesse en spirale', nf(T.vitAirSpirale && T.vitAirSpirale * 3.6), 'km/h', 'vitesse air estimée'),
      tuile('Temps par tour', nf(T.tempsTourMoy, 1), 's')
    ].join('');

    $('#kpi-transitions').innerHTML = [
      tuile('Finesse moyenne', fmtFinesse(T.finesseMoy), '', 'distance / hauteur perdue', true),
      tuile('Vitesse moyenne', nf(T.vitTransition && T.vitTransition * 3.6), 'km/h', 'vitesse sol en transition', true),
      tuile('Distance totale', nf(T.distTransition / 1000, 1), 'km', `${nf(T.distTransition / T.distanceTrace * 100)} % de la trace`),
      tuile('Nombre de transitions', nf(T.nbTransitions)),
      tuile('Distance moyenne', nf(T.distMoyTransition && T.distMoyTransition / 1000, 1), 'km', 'par transition'),
      tuile('Vz moyen', signe(T.vzTransition, 2), 'm/s', 'taux de chute moyen'),
      tuile('Temps en transition', fmtDuree(T.tempsTransition)),
      tuile('Hauteur perdue', nf(T.perteTransition), 'm', 'cumulée'),
      tuile('Détour moyen', T.detourMoy ? `+${nf((T.detourMoy - 1) * 100)}` : '—', T.detourMoy ? '%' : '', 'par rapport à la ligne droite')
    ].join('');
  }

  // ===================================================================
  // Carte
  // ===================================================================
  function afficherCarte() {
    const a = etat.analyse;
    if (!etat.carte) {
      const carte = L.map('carte', { preferCanvas: true });
      const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)'
      }).addTo(carte);
      const plan = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
      });
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 18, attribution: '© Esri'
      });
      L.control.layers({ 'Relief': topo, 'Plan': plan, 'Satellite': sat }).addTo(carte);
      // Si le fond de carte ne charge pas (hors ligne ou hébergement qui bloque les images)
      [topo, plan, sat].forEach(c => c.on('tileerror', () => {
        if ($('#note-fond')) return;
        const note = document.createElement('span');
        note.id = 'note-fond';
        note.className = 'note-fond';
        note.textContent = 'Fond de carte indisponible ici : la trace s\'affiche sur fond neutre.';
        $('.carte-pied').appendChild(note);
      }));
      L.control.scale({ imperial: false }).addTo(carte);
      etat.couches.trace = L.layerGroup().addTo(carte);
      etat.couches.selection = L.layerGroup().addTo(carte);
      etat.couches.circuit = L.layerGroup().addTo(carte);
      etat.couches.thermiques = L.layerGroup().addTo(carte);
      etat.couches.temps = L.layerGroup().addTo(carte);
      etat.couches.reperes = L.layerGroup().addTo(carte);
      carte.on('click', (e) => { if (etat.dessin) ajouterPoint(e.latlng.lat, e.latlng.lng); });
      etat.marqueur = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2.5, fillColor: '#111', fillOpacity: 1 });
      etat.carte = carte;
    }
    setTimeout(() => etat.carte.invalidateSize(), 0);

    etat.couches.selection.clearLayers();
    etat.couches.reperes.clearLayers();
    etat.marqueur.remove();
    dessinerTrace();

    // Départ / arrivée
    const P = a.points;
    L.circleMarker([P[a.deco].lat, P[a.deco].lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#2b8a3e', fillOpacity: 1 })
      .bindTooltip('Décollage').addTo(etat.couches.reperes);
    L.circleMarker([P[a.atterro].lat, P[a.atterro].lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#c92a2a', fillOpacity: 1 })
      .bindTooltip('Atterrissage').addTo(etat.couches.reperes);
    if (a.largage > a.deco) {
      L.circleMarker([P[a.largage].lat, P[a.largage].lon], { radius: 5, color: '#fff', weight: 2, fillColor: css('--remorque'), fillOpacity: 1 })
        .bindTooltip(`Largage · ${nf(a.alt[a.largage])} m`).addTo(etat.couches.reperes);
    }

    const coords = [];
    for (let i = a.deco; i <= a.atterro; i++) coords.push([P[i].lat, P[i].lon]);
    etat.carte.fitBounds(L.latLngBounds(coords), { padding: [24, 24] });
  }

  function dessinerTrace() {
    const a = etat.analyse, P = a.points;
    etat.couches.trace.clearLayers();
    let coulTemps = null;
    if (etat.modeCouleur === 'temps' && etat.temps) {
      coulTemps = new Array(P.length).fill(css('--remorque'));
      for (const sg of etat.temps.segments) {
        const c = couleurTemps(sg.gain / Math.max(1, sg.duree));
        for (let i = sg.s; i <= sg.e; i++) coulTemps[i] = c;
      }
    }
    const coul = (i) => coulTemps ? coulTemps[i]
      : etat.modeCouleur === 'phases' ? couleurPhase(a.phaseDe[i]) : couleurVario(a.vz[i]);
    let courant = coul(a.deco);
    let pts = [[P[a.deco].lat, P[a.deco].lon]];
    for (let i = a.deco + 1; i <= a.atterro; i++) {
      const c = coul(i);
      pts.push([P[i].lat, P[i].lon]);
      if (c !== courant || i === a.atterro) {
        L.polyline(pts, { color: courant, weight: 3, opacity: 0.95, interactive: false }).addTo(etat.couches.trace);
        pts = [[P[i].lat, P[i].lon]];
        courant = c;
      }
    }
    // Légende
    $('#legende').innerHTML = etat.modeCouleur === 'phases'
      ? [['Remorqué', '--remorque'], ['Thermique', '--thermique'], ['Transition', '--transition']]
        .map(([l, v]) => `<span><i style="background:${css(v)}"></i>${l}</span>`).join('')
      : etat.modeCouleur === 'temps'
        ? ECHELLE_TEMPS.map(e => `<span><i style="background:${e.c}"></i>${e.lab}</span>`).join('')
        : ECHELLE_VARIO.map(e => `<span><i style="background:${e.c}"></i>${e.lab}</span>`).join('') + '<span>m/s</span>';
    dessinerReperesTemps();
  }

  // Échelle gain / perte : secondes gagnées par seconde de vol
  const ECHELLE_TEMPS = [
    { max: -0.4, c: '#a51111', lab: 'Grosse perte' },
    { max: -0.15, c: '#e8590c', lab: 'Perte' },
    { max: -0.05, c: '#ffa94d', lab: 'Légère perte' },
    { max: 0.05, c: '#adb5bd', lab: 'Dans ta moyenne' },
    { max: 0.15, c: '#8ce99a', lab: 'Léger gain' },
    { max: 0.4, c: '#37b24d', lab: 'Gain' },
    { max: Infinity, c: '#1b6e2c', lab: 'Gros gain' }
  ];
  const couleurTemps = (r) => ECHELLE_TEMPS.find(e => r < e.max).c;

  // Repères numérotés des plus grosses pertes / gains (mode "Gain / perte")
  function dessinerReperesTemps() {
    const g = etat.couches.temps;
    if (!g) return;
    g.clearLayers();
    if (etat.modeCouleur !== 'temps' || !etat.temps) return;
    const a = etat.analyse;
    const placer = (liste, classe) => liste.forEach((sg, n) => {
      const p = a.points[Math.floor((sg.s + sg.e) / 2)];
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: `repere-temps ${classe}`, html: String(n + 1), iconSize: [22, 22], iconAnchor: [11, 11] })
      }).bindTooltip(`<b>${fmtEcart(sg.gain)}</b> · ${raisonSegment(sg)}`)
        .on('click', () => selectionnerSegment(sg))
        .addTo(g);
    });
    placer(etat.temps.pertes, 'perte');
    placer(etat.temps.gains, 'gain');
  }

  // ===================================================================
  // Barogramme
  // ===================================================================
  const pluginBandes = {
    id: 'bandes',
    beforeDatasetsDraw(chart) {
      const a = etat.analyse;
      if (!a) return;
      const { ctx, chartArea: z, scales: { x } } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.rect(z.left, z.top, z.right - z.left, z.bottom - z.top);
      ctx.clip();
      for (const ph of a.phases) {
        if (ph.type === 'G') continue;
        const x0 = x.getPixelForValue(a.t[ph.s]), x1 = x.getPixelForValue(a.t[ph.e]);
        ctx.fillStyle = alpha(couleurPhase(ph.type), ph.type === 'T' ? 0.14 : 0.12);
        ctx.fillRect(x0, z.top, x1 - x0, z.bottom - z.top);
      }
      if (etat.selection) {
        const x0 = x.getPixelForValue(a.t[etat.selection.s]), x1 = x.getPixelForValue(a.t[etat.selection.e]);
        ctx.fillStyle = alpha(css('--selection'), 0.28);
        ctx.fillRect(x0, z.top, x1 - x0, z.bottom - z.top);
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: z, scales: { x } } = chart;
      // Passages de circuit (départ, zones, arrivée)
      const r = etat.resCircuit;
      if (etat.vue !== 'analyse' && r && r.chemin.length) {
        ctx.save();
        ctx.strokeStyle = css('--circuit');
        ctx.fillStyle = css('--circuit');
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.font = '600 11px ' + Chart.defaults.font.family;
        ctx.textAlign = 'center';
        r.chemin.forEach((p, k) => {
          const px = x.getPixelForValue(etat.analyse.t[p.i]);
          if (px < z.left || px > z.right) return;
          ctx.beginPath(); ctx.moveTo(px, z.top + 14); ctx.lineTo(px, z.bottom); ctx.stroke();
          ctx.fillText(roleCourt(k, r.zones.length), px, z.top + 10);
        });
        ctx.restore();
      }
      if (etat.tCurseur == null) return;
      const px = x.getPixelForValue(etat.tCurseur);
      if (px < z.left || px > z.right) return;
      ctx.save();
      ctx.strokeStyle = css('--texte');
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, z.top);
      ctx.lineTo(px, z.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  function afficherBarogramme() {
    const a = etat.analyse;
    if (etat.graphe) etat.graphe.destroy();
    Chart.defaults.color = css('--texte-2');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const grille = css('--grille');

    const i0 = Math.max(0, a.deco - 15), i1 = Math.min(a.points.length - 1, a.atterro + 15);
    const pas = Math.max(1, Math.ceil((i1 - i0 + 1) / 3000));
    const dAlt = [], dVit = [], dVz = [];
    for (let i = i0; i <= i1; i += pas) {
      dAlt.push({ x: a.t[i], y: a.alt[i] });
      dVit.push({ x: a.t[i], y: a.vit[i] * 3.6 });
      dVz.push({ x: a.t[i], y: a.vz[i] });
    }
    const accent = css('--accent');

    etat.graphe = new Chart($('#barogramme'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Altitude', data: dAlt, yAxisID: 'y', borderColor: accent, backgroundColor: alpha(accent, 0.12), fill: 'start', borderWidth: 1.5, pointRadius: 0 },
          { label: 'Vitesse sol', data: dVit, yAxisID: 'y2', hidden: true, borderColor: css('--texte-2'), borderWidth: 1, pointRadius: 0 },
          { label: 'Vario', data: dVz, yAxisID: 'y3', hidden: true, borderColor: css('--thermique'), borderWidth: 1, pointRadius: 0 }
        ]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        parsing: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: a.t[i0], max: a.t[i1], grid: { color: grille },
            ticks: { callback: (v) => fmtHeure(v), maxTicksLimit: 10, maxRotation: 0 } },
          y: { title: { display: true, text: 'Altitude (m)' }, grid: { color: grille } },
          y2: { position: 'right', display: 'auto', title: { display: true, text: 'km/h' }, grid: { drawOnChartArea: false } },
          y3: { position: 'right', display: 'auto', title: { display: true, text: 'm/s' }, grid: { drawOnChartArea: false } }
        },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { boxWidth: 12, boxHeight: 2 } },
          tooltip: { enabled: false }
        },
        onHover: (ev, _els, chart) => {
          const x = chart.scales.x.getValueForPixel(ev.x);
          if (x >= chart.scales.x.min && x <= chart.scales.x.max) curseur(x);
        },
        onClick: (ev, _els, chart) => {
          const x = chart.scales.x.getValueForPixel(ev.x);
          const i = indiceProche(a.t, x);
          const type = a.phaseDe[i];
          const liste = type === 'T' ? a.thermiques : type === 'G' ? a.transitions : null;
          if (!liste) return;
          const k = liste.findIndex(p => i >= p.s && i <= p.e);
          if (k >= 0) selectionner(type, k);
        }
      },
      plugins: [pluginBandes]
    });
  }

  function indiceProche(t, x) {
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m; else hi = m; }
    return (x - t[lo] < t[hi] - x) ? lo : hi;
  }

  const NOM_PHASE = { R: 'remorqué', T: 'thermique', G: 'transition', S: 'au sol' };
  function curseur(x) {
    const a = etat.analyse;
    const i = indiceProche(a.t, x);
    etat.tCurseur = a.t[i];
    const p = a.points[i];
    etat.marqueur.setLatLng([p.lat, p.lon]);
    if (!etat.carte.hasLayer(etat.marqueur)) etat.marqueur.addTo(etat.carte);
    $('#curseur-info').textContent =
      `${fmtHeure(a.t[i], true)} · ${nf(a.alt[i])} m · Vz ${signe(a.vz[i], 1)} m/s · ${nf(a.vit[i] * 3.6)} km/h · ${NOM_PHASE[a.phaseDe[i]]}`;
    redessiner();
  }
  function redessiner() {
    if (etat.redessin) return;
    etat.redessin = true;
    requestAnimationFrame(() => { etat.redessin = false; if (etat.graphe) etat.graphe.draw(); });
  }

  // ===================================================================
  // Sélection d'un thermique / d'une transition
  // ===================================================================
  function selectionner(type, k) {
    const a = etat.analyse;
    const ph = (type === 'T' ? a.thermiques : a.transitions)[k];
    etat.selection = { type, k, s: ph.s, e: ph.e };

    const coords = [];
    for (let i = ph.s; i <= ph.e; i++) coords.push([a.points[i].lat, a.points[i].lon]);
    etat.couches.selection.clearLayers();
    L.polyline(coords, { color: css('--selection'), weight: 9, opacity: 0.45, interactive: false }).addTo(etat.couches.selection);
    etat.carte.fitBounds(L.latLngBounds(coords), { padding: [50, 50], maxZoom: 14 });

    montrerOnglet(type);
    document.querySelectorAll('tbody tr').forEach(tr => tr.classList.remove('actif'));
    const ligne = document.querySelector(`#table-${type} tr[data-k="${k}"]`);
    if (ligne) ligne.classList.add('actif');
    redessiner();
  }

  // ===================================================================
  // Répartition du temps + histogramme
  // ===================================================================
  function afficherRepartition() {
    const r = etat.analyse.totaux.repartition;
    const total = r.R + r.T + r.G || 1;
    const lignes = [
      ['Remorqué', r.R, '--remorque'],
      ['Spirale (thermiques)', r.T, '--thermique'],
      ['Ligne droite (transitions)', r.G, '--transition']
    ].filter(x => x[1] > 0);
    $('#repartition').innerHTML =
      `<div class="barre-rep">${lignes.map(([, d, v]) => `<div style="width:${d / total * 100}%;background:${css(v)}"></div>`).join('')}</div>` +
      `<div class="rep-liste">${lignes.map(([l, d, v]) =>
        `<div class="rep-ligne"><i style="background:${css(v)}"></i><span>${l}</span><span class="pct">${nf(d / total * 100)} %</span><span class="dur">${fmtDuree(d)}</span></div>`).join('')}</div>`;
  }

  function afficherHisto() {
    const h = etat.analyse.totaux.histo;
    if (etat.histo) etat.histo.destroy();
    const b = h.bornes;
    const labels = h.minutes.map((_, k) =>
      k === 0 ? `< ${nf(b[0], 0)}` : k === b.length ? `≥ ${nf(b[b.length - 1], 0)}` : `${nf(b[k - 1], 1)}–${nf(b[k], 1)}`);
    const couleurs = h.minutes.map((_, k) => couleurVario(k === 0 ? -0.5 : k === b.length ? 4 : (b[k - 1] + b[k]) / 2));
    etat.histo = new Chart($('#histo'), {
      type: 'bar',
      data: { labels, datasets: [{ data: h.minutes, backgroundColor: couleurs, borderRadius: 4, maxBarThickness: 36 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Vz (m/s)' }, grid: { display: false } },
          y: { title: { display: true, text: 'minutes' }, grid: { color: css('--grille') }, beginAtZero: true }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${nf(c.parsed.y, 1)} min` } }
        }
      }
    });
  }

  // ===================================================================
  // Tableaux
  // ===================================================================
  function afficherTables() {
    const a = etat.analyse;
    $('#table-T').innerHTML =
      `<thead><tr><th>N°</th><th>Début</th><th>Durée</th><th>Alt. entrée → sortie</th><th>Gain</th><th>Vz moy</th><th>Vz max</th><th>Sens</th><th>Tours</th><th>Inclinaison</th><th>V. air</th><th>Vent</th></tr></thead><tbody>` +
      a.thermiques.map((x, k) => `<tr data-type="T" data-k="${k}">
        <td>${k + 1}</td><td>${fmtHeure(x.debut)}</td><td>${fmtDureeTab(x.duree)}</td>
        <td>${nf(x.altDebut)} → ${nf(x.altFin)} m</td>
        <td class="${x.gain < 0 ? 'neg' : ''}">${signe(x.gain, 0)} m</td>
        <td class="fort">${signe(x.vzMoy, 1)}</td><td>${signe(x.vzMax, 1)}</td>
        <td>${x.sens === 'gauche' ? '↺ G' : '↻ D'}</td><td>${nf(x.tours, 1)}</td>
        <td>${x.inclinaison ? nf(x.inclinaison) + '°' : '—'}</td>
        <td>${x.vitAir ? nf(x.vitAir * 3.6) + ' km/h' : '—'}</td>
        <td>${x.vent ? `${fleche(x.vent.dir)} ${nf(x.vent.dir)}° / ${nf(x.vent.vit * 3.6)}` : '—'}</td></tr>`).join('') +
      '</tbody>';

    $('#table-G').innerHTML =
      `<thead><tr><th>N°</th><th>Début</th><th>Durée</th><th>Distance</th><th>Alt. début → fin</th><th>Hauteur perdue</th><th>Finesse</th><th>Vitesse</th><th>Vz moy</th><th>Détour</th></tr></thead><tbody>` +
      a.transitions.map((x, k) => `<tr data-type="G" data-k="${k}">
        <td>${k + 1}</td><td>${fmtHeure(x.debut)}</td><td>${fmtDureeTab(x.duree)}</td>
        <td>${nf(x.dist / 1000, 1)} km</td><td>${nf(x.altDebut)} → ${nf(x.altFin)} m</td>
        <td>${nf(x.perte)} m</td><td class="fort">${fmtFinesse(x.finesse)}</td>
        <td>${nf(x.vitesse * 3.6)} km/h</td><td>${signe(x.vzMoy, 1)}</td>
        <td>${x.detour ? '+' + nf((x.detour - 1) * 100) + ' %' : '—'}</td></tr>`).join('') +
      '</tbody>';

    document.querySelector('[data-onglet="T"]').textContent = `Thermiques (${a.thermiques.length})`;
    document.querySelector('[data-onglet="G"]').textContent = `Transitions (${a.transitions.length})`;
    montrerOnglet('T');
  }

  function montrerOnglet(type) {
    document.querySelectorAll('[data-onglet]').forEach(b => b.classList.toggle('actif', b.dataset.onglet === type));
    $('#table-T').hidden = type !== 'T';
    $('#table-G').hidden = type !== 'G';
  }

  // ===================================================================
  // Thermiques sur la carte
  // En mode "Analyse de vol" : étiquette permanente avec le Vz et le gain.
  // En mode circuit : simples points discrets (le circuit passe devant).
  // ===================================================================
  function dessinerThermiques() {
    const a = etat.analyse;
    const g = etat.couches.thermiques;
    g.clearLayers();
    const modeAnalyse = etat.vue === 'analyse';
    a.thermiques.forEach((th, k) => {
      if (th.gain <= 0) return;
      const m = L.circleMarker([th.centre.lat, th.centre.lon], {
        radius: modeAnalyse ? Math.max(4, Math.min(10, 3 + th.vzMoy * 2)) : 4,
        color: '#fff', weight: 1.5, fillColor: css('--thermique'), fillOpacity: modeAnalyse ? 0.95 : 0.7
      });
      if (modeAnalyse) {
        m.bindTooltip(`${signe(th.vzMoy, 1)} <span>· ${nf(th.gain)} m</span>`, {
          permanent: true, direction: 'top', offset: [0, -6], className: 'etiquette-th'
        });
      } else {
        m.bindTooltip(`<b>Thermique n°${k + 1}</b><br>${signe(th.vzMoy, 1)} m/s · +${nf(th.gain)} m<br>${fmtHeure(th.debut)} · ${fmtDureeTab(th.duree)}`);
      }
      m.on('click', () => { if (!etat.dessin) selectionner('T', k); });
      m.addTo(g);
    });
  }

  // ===================================================================
  // Mode : Analyse de vol / Circuit AAT / Circuit CT
  // ===================================================================
  function afficherVue() {
    const v = etat.vue;
    document.querySelectorAll('[data-vue]').forEach(b => b.classList.toggle('actif', b.dataset.vue === v));
    $('#panneau-circuit').hidden = v === 'analyse';
    $('#ligne-temps-mini').hidden = v !== 'AAT';
    $('#titre-circuit').textContent = v === 'AAT'
      ? 'Circuit AAT — épreuve à zones'
      : 'Circuit CT — circuit à points de virage';
    if (v === 'analyse') basculerDessin(false);
    dessinerThermiques();
    majCircuit();
    if (v !== 'analyse' && etat.circuit.length) cadrerCircuit();
  }

  // Rayons par défaut (modifiables dans la liste)
  function rayonDefaut(k, n, type) {
    if (k === 0) return 5000;          // départ : cylindre 5 km
    if (k === n - 1) return 3000;      // arrivée : cylindre 3 km
    return type === 'AAT' ? 20000 : 500; // zone AAT 20 km / PV 500 m
  }
  function roleCourt(k, n) { return k === 0 ? 'D' : k === n - 1 ? 'A' : String(k); }
  function nomAuto(k, n) {
    if (k === 0) return 'Départ';
    if (k === n - 1 && n > 1) return 'Arrivée';
    return (etat.vue === 'AAT' ? 'Zone ' : 'PV ') + k;
  }
  function renommer() {
    const n = etat.circuit.length;
    etat.circuit.forEach((p, k) => { if (p.nomAuto) p.nom = nomAuto(k, n); });
  }
  function zonesEffectives() {
    const n = etat.circuit.length;
    return etat.circuit.map((p, k) => ({
      lat: p.lat, lon: p.lon, nom: p.nom || nomAuto(k, n),
      rayon: p.rayon != null ? p.rayon : rayonDefaut(k, n, etat.vue),
      forme: (p.forme === 'ligne' && k > 0 && k < n - 1) ? 'cylindre' : (p.forme || 'cylindre'),
      demiAngle: p.demiAngle, rayon2: p.rayon2, demiAngle2: p.demiAngle2, style: p.style, a12: p.a12
    }));
  }

  function chargerCircuitIGC() {
    const a = etat.analyse;
    const c = (a && a.circuitIGC) || [];
    // On garde tout ce qui est déclaré : rayon propre à chaque zone, secteur, ligne…
    etat.circuit = c.map(p => Object.assign({}, p, { nomAuto: !p.nom, rayon: p.rayon != null ? p.rayon : null }));
    renommer();
    $('#btn-circuit-igc').hidden = !c.length;
    if (a && a.tempsCircuitIGC) {
      etat.tempsMini = a.tempsCircuitIGC;
      $('#temps-mini').value = +(a.tempsCircuitIGC / 3600).toFixed(2);
    }
  }

  function decrireZone(z) {
    if (z.forme === 'ligne') return `ligne de ${fmtDist(2 * z.rayon)}`;
    let txt = z.forme === 'secteur' && (z.demiAngle || 45) < 180
      ? `secteur ${nf(2 * (z.demiAngle || 45))}° de ${fmtDist(z.rayon)}`
      : `cylindre de ${fmtDist(z.rayon)}`;
    if (z.rayon2) txt += ` + cylindre de ${fmtDist(z.rayon2)}`;
    return txt;
  }

  function statutPoint(k, n) {
    const r = etat.resCircuit;
    const v = r && r.verification ? r.verification[k] : null;
    if (!v) return '';
    if (v.ok) {
      const quoi = k === 0 ? 'Départ' : k === n - 1 ? 'Arrivée' : 'Atteinte';
      let txt = `✓ ${quoi} à ${fmtHeure(v.t, true)} · ${nf(v.alt)} m`;
      if (v.tRetenu && k > 0 && k < n - 1) txt += ` · point retenu à ${fmtHeure(v.tRetenu)}`;
      return `<div class="pt-statut ok">${txt}</div>`;
    }
    const z = r.zones[k];
    const premierKo = r.verification.findIndex(x => !x.ok);
    if (premierKo >= 0 && k > premierKo) {
      return `<div class="pt-statut ko">✗ Non comptée : « ${echapper(r.zones[premierKo].nom)} » doit être validée avant</div>`;
    }
    const txt = k === 0 ? '✗ Départ non validé'
      : z.forme === 'cylindre' && v.manque > 0
        ? `✗ Non atteinte · passé à ${fmtDist(v.manque)} de la zone`
        : `✗ Non atteinte · au plus près à ${fmtDist(v.dMin)} du centre`;
    return `<div class="pt-statut ko">${txt}</div>`;
  }

  function ajouterPoint(lat, lon) {
    etat.circuit.push({ lat, lon, nom: '', nomAuto: true, rayon: null });
    renommer();
    majCircuit();
  }

  function basculerDessin(actif) {
    etat.dessin = actif;
    $('#btn-dessin').classList.toggle('actif', actif);
    $('#btn-dessin').textContent = actif ? 'Terminer l\'ajout de points' : 'Ajouter des points sur la carte';
    $('#carte').classList.toggle('dessin', actif);
    majAide();
  }

  function majAide() {
    const n = etat.circuit.length;
    let txt;
    if (etat.dessin) txt = 'Cliquez sur la carte pour ajouter les points dans l\'ordre : départ, puis ' +
      (etat.vue === 'AAT' ? 'les zones' : 'les points de virage') + ', puis l\'arrivée. Les repères se déplacent à la souris.';
    else if (!n) txt = 'Aucun circuit déclaré dans ce fichier : cliquez « Ajouter des points sur la carte ».';
    else if (n < 2) txt = 'Ajoutez au moins un départ et une arrivée.';
    else txt = 'Les repères sont déplaçables sur la carte. Rayon vide = valeur par défaut.';
    $('#aide-circuit').textContent = txt;
    const src = etat.analyse && etat.analyse.circuitIGC.length ? 'circuit déclaré dans le fichier IGC disponible' : '';
    $('#source-circuit').textContent = src;
  }

  function majCircuit() {
    const a = etat.analyse;
    if (!a || !etat.carte) return;
    if (etat.vue === 'analyse') {
      etat.resCircuit = null;
      etat.couches.circuit.clearLayers();
      redessiner();
      return;
    }
    const Z = zonesEffectives();
    etat.resCircuit = Z.length >= 2 ? IGC.analyserCircuit(a, Z, etat.vue, { tempsMini: etat.tempsMini }) : null;
    afficherEditeurCircuit(Z);
    dessinerCircuit(Z);
    afficherResultatsCircuit();
    majAide();
    redessiner();
  }

  function cadrerCircuit() {
    const a = etat.analyse;
    const b = L.latLngBounds([]);
    for (let i = a.deco; i <= a.atterro; i += 10) b.extend([a.points[i].lat, a.points[i].lon]);
    zonesEffectives().forEach(z => b.extend(L.latLng(z.lat, z.lon).toBounds(2 * z.rayon)));
    etat.carte.fitBounds(b, { padding: [24, 24] });
  }

  function afficherEditeurCircuit(Z) {
    const n = Z.length;
    $('#liste-points').innerHTML = Z.map((z, k) => {
      const extremite = k === 0 || k === n - 1;
      const angle = nf(2 * (z.demiAngle || 45));
      return `
      <div class="pt-ligne" data-k="${k}">
        <span class="pt-role" title="${k === 0 ? 'Départ' : k === n - 1 ? 'Arrivée' : 'Zone ' + k}">${roleCourt(k, n)}</span>
        <input class="pt-nom" value="${echapper(z.nom)}" aria-label="Nom du point" title="${echapper(decrireZone(z))}">
        <select class="pt-forme" aria-label="Forme de la zone">
          <option value="cylindre"${z.forme === 'cylindre' ? ' selected' : ''}>Cylindre</option>
          <option value="secteur"${z.forme === 'secteur' ? ' selected' : ''}>Secteur ${angle}°</option>
          ${extremite ? `<option value="ligne"${z.forme === 'ligne' ? ' selected' : ''}>Ligne</option>` : ''}
        </select>
        <label class="pt-rayon" title="${z.forme === 'ligne' ? 'Demi-longueur de la ligne' : 'Rayon de la zone'}"><input class="pt-r" type="number" min="0.05" step="0.1"
          value="${etat.circuit[k].rayon != null ? +(etat.circuit[k].rayon / 1000).toFixed(2) : ''}"
          placeholder="${+(rayonDefaut(k, n, etat.vue) / 1000).toFixed(2)}" aria-label="Rayon (km)"> km</label>
        <button class="pt-suppr" title="Supprimer ce point" aria-label="Supprimer">×</button>
        ${statutPoint(k, n)}
      </div>`;
    }).join('');
  }

  function dessinerCircuit(Z) {
    const g = etat.couches.circuit;
    g.clearLayers();
    if (!Z.length) return;
    const coul = css('--circuit');
    const n = Z.length;
    const r0 = etat.resCircuit;
    const prep = IGC.preparerZones(Z);
    const style = { color: coul, weight: 1.5, fillColor: coul, fillOpacity: 0.08, interactive: false };
    prep.forEach((z) => {
      const c = IGC.contourZone(z);
      if (c.type === 'ligne') L.polyline(c.points, { color: coul, weight: 4, interactive: false }).addTo(g);
      else if (c.type === 'cercle') L.circle([z.lat, z.lon], Object.assign({ radius: z.rayon }, style)).addTo(g);
      else L.polygon(c.points, style).addTo(g);
      if (c.rayon2) L.circle([z.lat, z.lon], Object.assign({ radius: c.rayon2 }, style)).addTo(g);
    });
    // Zones manquées : point de passage le plus proche
    if (r0 && r0.verification) {
      r0.verification.forEach((v, k) => {
        if (v.ok || v.iProche == null || k === 0) return;
        const p = etat.analyse.points[v.iProche];
        L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: css('--erreur'), fillOpacity: 1 })
          .bindTooltip(`Au plus près de « ${echapper(Z[k].nom)} » : ${fmtDist(v.dMin)} du centre, ${fmtHeure(etat.analyse.t[v.iProche])}`)
          .addTo(g);
      });
    }
    if (n > 1) {
      L.polyline(Z.map(z => [z.lat, z.lon]), { color: coul, weight: 2, opacity: 0.8, dashArray: '6 6', interactive: false }).addTo(g);
    }
    // Chemin optimisé AAT (points retenus dans les zones)
    const r = etat.resCircuit;
    if (r && r.type === 'AAT' && r.chemin.length > 1) {
      L.polyline(r.chemin.map(p => [p.lat, p.lon]), { color: coul, weight: 3, interactive: false }).addTo(g);
      r.chemin.slice(1, r.termine ? -1 : undefined).forEach(p => {
        L.circleMarker([p.lat, p.lon], { radius: 5, color: coul, weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(`Point retenu · ${fmtHeure(etat.analyse.t[p.i])}`).addTo(g);
      });
    }
    // Repères déplaçables
    Z.forEach((z, k) => {
      const v = r0 && r0.verification ? r0.verification[k] : null;
      const classe = v ? (v.ok ? ' ok' : ' ko') : '';
      const m = L.marker([z.lat, z.lon], {
        draggable: true,
        icon: L.divIcon({ className: 'pv-icone' + classe, html: roleCourt(k, n), iconSize: [24, 24], iconAnchor: [12, 12] })
      }).bindTooltip(`<b>${echapper(z.nom)}</b> · ${decrireZone(z)}` +
        (v ? (v.ok ? `<br>✓ ${fmtHeure(v.t, true)} · ${nf(v.alt)} m` : '<br>✗ non validé') : '')).addTo(g);
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        etat.circuit[k].lat = ll.lat;
        etat.circuit[k].lon = ll.lng;
        majCircuit();
      });
    });
  }

  function afficherResultatsCircuit() {
    const r = etat.resCircuit;
    if (!r) {
      $('#kpi-circuit').innerHTML = '';
      $('#table-branches').innerHTML = '';
      return;
    }
    const nbBranches = r.zones.length - 1;
    const faites = Math.max(0, r.nbAtteints - 1);
    const statut = r.termine
      ? `<div class="tuile vedette ok"><div class="t-lab">Statut</div><div class="t-val">Terminé ✓</div><div class="t-sous">arrivée ${fmtHeure(r.tArrivee)}</div></div>`
      : `<div class="tuile vedette ko"><div class="t-lab">Statut</div><div class="t-val">${r.nbAtteints ? `${faites}/${nbBranches} branches` : 'Non parti'}</div><div class="t-sous">${echapper(r.raison || '')}</div></div>`;
    const sousVitesse = r.type === 'AAT' && r.termine && r.duree < r.tempsMini
      ? `calculée sur ${fmtDuree(r.tempsMini)} (temps mini)` : 'sur le circuit';
    const g = r.global || {};
    $('#kpi-circuit').innerHTML = [
      statut,
      tuile('Vitesse', r.vitesse ? nf(r.vitesse * 3.6, 1) : '—', r.vitesse ? 'km/h' : '', r.vitesse ? sousVitesse : 'circuit non terminé', true),
      tuile('Distance', nf(r.distance / 1000, 1), 'km',
        r.type === 'AAT' ? (r.termine ? 'optimisée dans les zones' : 'réalisée') : (r.termine ? 'circuit validé' : 'réalisée'), true),
      tuile('Temps de circuit', r.nbAtteints ? fmtDuree(r.duree) : '—', '',
        r.type === 'AAT' ? `temps mini ${fmtDuree(r.tempsMini)}` : ''),
      tuile('Départ', r.nbAtteints ? fmtHeure(r.tDepart) : '—', '', r.nbAtteints ? `à ${nf(r.altDepart)} m` : ''),
      tuile('Distance nominale', nf(r.distanceNominale / 1000, 1), 'km', 'entre les centres'),
      tuile('Vz moyen', signe(g.vzT, 2), 'm/s', 'thermiques du circuit'),
      tuile('Temps en spirale', g.pctSpirale != null ? nf(g.pctSpirale * 100) : '—', '%', 'pendant le circuit'),
      tuile('Finesse', fmtFinesse(g.finesse), '', 'transitions du circuit'),
      tuile('Vitesse en transition', g.vitG ? nf(g.vitG * 3.6) : '—', 'km/h', 'pendant le circuit')
    ].join('');

    $('#table-branches').innerHTML = r.branches.length ?
      `<thead><tr><th>Branche</th><th>Départ</th><th>Durée</th><th>Distance</th><th>Vitesse</th><th>Vz therm.</th><th>Spirale</th><th>Finesse</th><th>V. transition</th></tr></thead><tbody>` +
      r.branches.map((b, k) => `<tr data-branche="${k}">
        <td>${echapper(b.de)} → ${echapper(b.a)}</td><td>${fmtHeure(b.debut)}</td><td>${fmtDureeTab(b.duree)}</td>
        <td>${nf(b.dist / 1000, 1)} km</td><td class="fort">${b.vitesse ? nf(b.vitesse * 3.6, 1) + ' km/h' : '—'}</td>
        <td>${signe(b.vzT, 1)}</td><td>${b.pctSpirale != null ? nf(b.pctSpirale * 100) + ' %' : '—'}</td>
        <td>${fmtFinesse(b.finesse)}</td><td>${b.vitG ? nf(b.vitG * 3.6) + ' km/h' : '—'}</td></tr>`).join('') + '</tbody>'
      : '';
  }

  // ===================================================================
  // Gains et pertes de temps
  // ===================================================================
  function raisonSegment(sg) {
    if (sg.type === 'T') {
      if (sg.sansGain) return `Spirale sans gain (${signe(sg.hauteur, 0)} m en ${fmtDureeTab(sg.duree)})`;
      let txt = sg.gain < 0
        ? `Thermique faible : ${signe(sg.vz, 1)} m/s pendant ${fmtDureeTab(sg.duree)}`
        : `Bon thermique : ${signe(sg.vz, 1)} m/s, +${nf(sg.hauteur)} m`;
      const extra = [];
      if (sg.centrage >= 20) extra.push(`centrage ${fmtDuree(sg.centrage)} perdu`);
      if (sg.sortie >= 20) extra.push(`sortie tardive ${fmtDuree(sg.sortie)} perdue`);
      return extra.length ? `${txt} (${extra.join(', ')})` : txt;
    }
    const base = `${nf(sg.vEq * 3.6)} km/h équivalent · ${nf(sg.directe / 1000, 1)} km, finesse ${fmtFinesse(sg.finesse)}`;
    let txt = (sg.gain < 0 ? 'Transition lente : ' : 'Transition rapide : ') + base;
    if (sg.gain < 0 && sg.detour >= 30) txt += `, détours ${fmtDuree(sg.detour)}`;
    return txt;
  }

  function selectionnerSegment(sg) { selectionner(sg.type, sg.k); }

  function afficherTemps() {
    const a = etat.analyse;
    const r = IGC.analyserTemps(a, { mc: etat.mc });
    etat.temps = r;
    const R = r.resume;
    $('#mc').value = (Math.round(r.mc * 10) / 10).toFixed(1);

    $('#temps-explication').innerHTML =
      `Référence : <b>${nf(r.mc, 1)} m/s</b> en thermique${etat.mc ? '' : ' (ton Vz moyen du vol)'} et ` +
      `<b>${nf(r.vRef && r.vRef * 3.6)} km/h</b> de vitesse équivalente en transition (ta moyenne). ` +
      `Chaque mètre perdu en transition compte pour le temps qu'il faut pour le regagner à ${nf(r.mc, 1)} m/s. ` +
      `Mets ton calage MacCready ou le Vz d'un pilote de référence pour te comparer à un autre niveau.`;

    const t = (lab, v, sous, classe) =>
      `<div class="tuile ${classe || ''}"><div class="t-lab">${lab}</div><div class="t-val">${v}</div>${sous ? `<div class="t-sous">${sous}</div>` : ''}</div>`;
    const nbT = r.segments.filter(x => x.type === 'T' && !x.sansGain).length || 1;
    $('#kpi-temps').innerHTML = [
      t('Thermiques forts', fmtEcart(R.thermGagne), 'plus rapides que la référence', 'gain'),
      t('Thermiques faibles', fmtEcart(R.thermPerdu), 'plus lents que la référence', 'perte'),
      t('Transitions rapides', fmtEcart(R.transGagne), 'au-dessus de ta moyenne', 'gain'),
      t('Transitions lentes', fmtEcart(R.transPerdu), 'sous ta moyenne', 'perte'),
      t('Centrage', fmtEcart(-R.centrage), `≈ ${fmtDuree(R.centrage / nbT)} par thermique`, 'perte'),
      t('Sorties tardives', fmtEcart(-R.sortie), 'à rester quand ça faiblit', R.sortie > 0 ? 'perte' : ''),
      t('Spirales sans gain', R.nbSansGain ? fmtEcart(-R.tempsSansGain) : '0', `${R.nbSansGain} tentative${R.nbSansGain > 1 ? 's' : ''}`, R.nbSansGain ? 'perte' : ''),
      t('Détours', fmtEcart(-R.detour), 'zigzags en transition', 'perte')
    ].join('');

    // Graphique : un bâton par thermique / transition, dans l'ordre du vol
    if (etat.grapheTemps) etat.grapheTemps.destroy();
    const segs = r.segments;
    etat.grapheTemps = new Chart($('#graphe-temps'), {
      type: 'bar',
      data: {
        labels: segs.map(s => `${s.type === 'T' ? 'Th' : 'Tr'} ${s.k + 1} · ${fmtHeure(s.debut)}`),
        datasets: [{
          data: segs.map(s => s.gain / 60),
          backgroundColor: segs.map(s => couleurTemps(s.gain / Math.max(1, s.duree))),
          borderRadius: 3, maxBarThickness: 28
        }]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, callback: (v, i) => segs[i] ? fmtHeure(segs[i].debut) : '' } },
          y: { title: { display: true, text: 'minutes gagnées (+) / perdues (−)' }, grid: { color: css('--grille') } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (it) => it[0].label, label: (c) => `${fmtEcart(segs[c.dataIndex].gain)} · ${raisonSegment(segs[c.dataIndex])}` } }
        },
        onClick: (_e, els) => { if (els && els.length) selectionnerSegment(segs[els[0].index]); }
      }
    });

    const ligne = (sg, n, classe) => `<li class="${classe}" data-idx="${segs.indexOf(sg)}">
      <span class="lt-num">${n + 1}</span><span class="lt-val">${fmtEcart(sg.gain)}</span>
      <span class="lt-txt"><b>${fmtHeure(sg.debut)}</b> · ${raisonSegment(sg)}</span></li>`;
    $('#liste-pertes').innerHTML = r.pertes.length
      ? r.pertes.map((s, n) => ligne(s, n, 'perte-li')).join('')
      : '<li class="vide">Aucune perte notable</li>';
    $('#liste-gains').innerHTML = r.gains.length
      ? r.gains.map((s, n) => ligne(s, n, 'gain-li')).join('')
      : '<li class="vide">Rien qui sorte du lot</li>';

    if (etat.modeCouleur === 'temps') dessinerTrace();
  }

  function selectionnerBranche(k) {
    const a = etat.analyse, b = etat.resCircuit.branches[k];
    etat.selection = { type: 'B', k, s: b.s, e: b.e };
    const coords = [];
    for (let i = b.s; i <= b.e; i++) coords.push([a.points[i].lat, a.points[i].lon]);
    etat.couches.selection.clearLayers();
    L.polyline(coords, { color: css('--selection'), weight: 9, opacity: 0.45, interactive: false }).addTo(etat.couches.selection);
    etat.carte.fitBounds(L.latLngBounds(coords), { padding: [50, 50] });
    document.querySelectorAll('tbody tr').forEach(tr => tr.classList.remove('actif'));
    const ligne = document.querySelector(`#table-branches tr[data-branche="${k}"]`);
    if (ligne) ligne.classList.add('actif');
    redessiner();
  }

  // ===================================================================
  // Événements
  // ===================================================================
  document.querySelectorAll('[data-vue]').forEach(b => b.addEventListener('click', () => {
    if (etat.vue === b.dataset.vue) return;
    etat.vue = b.dataset.vue;
    renommer();
    afficherVue();
  }));
  $('#btn-dessin').addEventListener('click', () => basculerDessin(!etat.dessin));
  $('#btn-effacer').addEventListener('click', () => { etat.circuit = []; basculerDessin(true); majCircuit(); });
  $('#btn-circuit-igc').addEventListener('click', () => { chargerCircuitIGC(); majCircuit(); cadrerCircuit(); });
  $('#temps-mini').addEventListener('change', (e) => {
    etat.tempsMini = Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0) * 3600;
    majCircuit();
  });
  $('#liste-points').addEventListener('change', (e) => {
    const ligne = e.target.closest('.pt-ligne');
    if (!ligne) return;
    const p = etat.circuit[+ligne.dataset.k];
    if (e.target.classList.contains('pt-nom')) { p.nom = e.target.value.trim(); p.nomAuto = !p.nom; renommer(); }
    if (e.target.classList.contains('pt-forme')) {
      p.forme = e.target.value;
      if (p.forme === 'secteur' && !(p.demiAngle < 180)) p.demiAngle = 45; // secteur FAI 90°
    }
    if (e.target.classList.contains('pt-r')) {
      const v = parseFloat(String(e.target.value).replace(',', '.'));
      p.rayon = v > 0 ? v * 1000 : null;
    }
    majCircuit();
  });
  $('#liste-points').addEventListener('click', (e) => {
    if (!e.target.classList.contains('pt-suppr')) return;
    etat.circuit.splice(+e.target.closest('.pt-ligne').dataset.k, 1);
    renommer();
    majCircuit();
  });
  $('#mc').addEventListener('change', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    etat.mc = v > 0 ? v : null;
    afficherTemps();
  });
  document.querySelector('.listes-temps').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (li && etat.temps) selectionnerSegment(etat.temps.segments[+li.dataset.idx]);
  });
  $('#table-branches').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-branche]');
    if (tr) selectionnerBranche(+tr.dataset.branche);
  });

  $('#fichier').addEventListener('change', (e) => { lireFichier(e.target.files[0]); e.target.value = ''; });
  $('#btn-autre').addEventListener('click', () => $('#fichier').click());
  $('#btn-demo').addEventListener('click', () => charger(IGC.genererVolDemo(), 'vol-demo.igc'));

  document.querySelectorAll('[data-onglet]').forEach(b => b.addEventListener('click', () => montrerOnglet(b.dataset.onglet)));
  document.querySelectorAll('.bascule button').forEach(b => b.addEventListener('click', () => {
    etat.modeCouleur = b.dataset.mode;
    document.querySelectorAll('.bascule button').forEach(x => x.classList.toggle('actif', x === b));
    if (etat.analyse) dessinerTrace();
  }));
  $('#table-T').parentElement.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (tr) selectionner(tr.dataset.type, +tr.dataset.k);
  });

  // Glisser-déposer n'importe où sur la page
  let compteurDrag = 0;
  const voile = $('#voile-depot');
  window.addEventListener('dragenter', (e) => { e.preventDefault(); compteurDrag++; voile.hidden = false; $('#zone-depot').classList.add('survol'); });
  window.addEventListener('dragleave', () => { if (--compteurDrag <= 0) { compteurDrag = 0; voile.hidden = true; $('#zone-depot').classList.remove('survol'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    compteurDrag = 0;
    voile.hidden = true;
    $('#zone-depot').classList.remove('survol');
    lireFichier(e.dataTransfer.files[0]);
  });
})();
