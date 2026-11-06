# Spirale — analyse de vol IGC

Site 100 % navigateur : on dépose un fichier `.igc`, il affiche la trace, le barogramme
et les statistiques (thermiques, transitions, finesse, vitesses, vent).

## Lancer

1. Ouvrir ce dossier dans VS Code (*Fichier → Ouvrir le dossier*).
2. Installer l'extension **Live Server**, puis clic droit sur `index.html` → *Open with Live Server*.
   (Un double-clic sur `index.html` marche aussi.)
3. Déposer un fichier IGC, ou cliquer sur « Voir un vol de démo ». `vol-demo.igc` est fourni pour tester.

Une connexion internet est nécessaire (Leaflet, Chart.js et les fonds de carte viennent d'internet).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `style.css` | Mise en forme (mode clair / sombre) |
| `analyse.js` | Lecture de l'IGC + tous les calculs (aucun affichage) |
| `app.js` | Affichage : carte, barogramme, tuiles, tableaux |

## Comment l'analyse fonctionne (`analyse.js`)

- **Lissage** : vitesse sol (±5 s), vario (±10 s) et taux de virage (±8 s) sur des fenêtres glissantes.
- **Décollage / atterrissage** : vitesse sol > 36 km/h pendant au moins 60 s.
- **Largage** : après au moins 100 m de gain, la première spirale franche (> 10 °/s) ou le premier passage en descente.
- **Thermique** : taux de virage moyen > 4 °/s, au moins 20 s et 300° de virage cumulé.
  Une ligne droite de moins de 30 s entre deux spirales reste dans le même thermique.
- **Transition** : tout le reste après le largage.
  Finesse = distance parcourue / hauteur perdue ; vitesse = distance / durée.
- **Vent** : dérive du planeur sur un nombre entier de tours de spirale.
- **Vitesse air en spirale** : vitesse sol corrigée du vent.
- **Inclinaison** : tan φ = V·ω / g.

Les seuils sont regroupés dans `REGLAGES` en haut d'`analyse.js`.

## Modes (boutons en haut des résultats)

- **Analyse de vol** : les thermiques sont étiquetés directement sur la carte (Vz moyen et gain).
- **Circuit CT** : circuit à points de virage. Départ validé à la dernière sortie du cylindre de départ
  avant le PV 1, puis chaque PV doit être atteint dans l'ordre (cylindre de 500 m par défaut).
  Distance = somme des branches entre les centres.
- **Circuit AAT** : épreuve à zones (20 km par défaut). Dans chaque zone, le programme retient le point
  qui donne la plus grande distance. Vitesse = distance / max(temps réel, temps minimum).

Le circuit est lu dans le fichier IGC s'il a été déclaré (enregistrements `C`), avec les paramètres
**propres à chaque zone** quand ils sont présents (lignes `LSEEYOU OZ=…` / LXNAV) : rayon, secteur (angle,
orientation), cylindre intérieur, ligne de départ/arrivée, et temps minimum AAT (`TaskTime`).
Sinon on le dessine en cliquant sur la carte. Les repères sont déplaçables, et le nom, la forme et le rayon
de chaque point sont modifiables. Sous chaque point : heure et altitude de passage, ou distance manquée.
Rayons par défaut si rien n'est déclaré : départ 5 km, PV 500 m, zone AAT 20 km, arrivée 3 km.

## Gains et pertes de temps

Référence MacCready : une hauteur perdue devra être regagnée au Vz de référence (par défaut ton Vz moyen).
- Thermique : temps gagné = hauteur gagnée / MC − durée.
- Transition : temps équivalent = durée + hauteur perdue / MC, comparé à ta vitesse équivalente moyenne.
- En plus : centrage (temps avant d'atteindre 80 % du Vz du thermique), sorties tardives (fin du thermique
  sous 50 % du Vz), spirales sans gain, détours (zigzags mesurés sur des tranches de 60 s).
- Le mode carte « Gain / perte » colore la trace et numérote les 5 plus grosses pertes et les 5 plus gros gains.

## Idées pour la suite

- Détection du moteur (extension `ENL` / `MOP` des IGC) pour les motoplaneurs.
- Replay animé du vol.
- Comparaison de deux vols.
- Déclaration d'épreuve et calcul de distance type OLC.
