// Spirale — accès par mot de passe (page d'entrée).
// GitHub Pages ne sait pas protéger un site côté serveur : ce verrou cache les pages tant que le
// bon mot de passe n'est pas saisi, mais les fichiers restent publics sur GitHub. C'est une
// barrière contre les visiteurs, pas une vraie sécurité.
// Numéro de version dans la pastille des onglets (rempli dès que version.js est chargé)
document.addEventListener('DOMContentLoaded', () => {
  const v = window.SPIRALE_VERSION;
  if (v) document.querySelectorAll('[data-version-court]').forEach(el => { el.textContent = 'V' + v.numero; });
});
(() => {
  'use strict';
  const EMPREINTE = '5019f314ef3cd502b3b85e0079fd490b27318d16af5423dfed65f23b3408734c';   // sha-256('spirale:' + mot de passe)
  const CLE = 'spirale-acces';
  let ok = false;
  try { ok = localStorage.getItem(CLE) === EMPREINTE; } catch { /* stockage indisponible */ }
  if (ok) return;

  const style = document.createElement('style');
  style.id = 'acces-verrou';
  style.textContent = `
    body > *:not(.acces) { visibility: hidden !important; }
    .acces { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; padding: 16px;
      background: var(--fond, #f4f6fa); color: var(--texte, #14181f); font-family: system-ui, sans-serif; }
    .acces form { width: min(340px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 24px;
      background: var(--surface, #fff); border: 1px solid var(--bord, #d8dde6); border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.12); }
    .acces h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 8px; }
    .acces p { margin: 0; font-size: 13px; color: var(--texte-2, #5b6472); }
    .acces input { height: 40px; border-radius: 8px; border: 1px solid var(--bord, #d8dde6); padding: 0 12px; font-size: 16px;
      background: var(--surface, #fff); color: inherit; }
    .acces button { height: 40px; border: 0; border-radius: 8px; font-weight: 700; font-size: 15px; cursor: pointer;
      background: var(--accent, #1f6feb); color: #fff; }
    .acces .erreur { color: #c62828; min-height: 1.2em; }`;
  document.head.appendChild(style);

  async function empreinte(txt) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('spirale:' + txt));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function afficher() {
    const div = document.createElement('div');
    div.className = 'acces';
    div.innerHTML = `
      <form autocomplete="off">
        <h1><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M16 16m-2 0a2 2 0 1 0 4 0a4 4 0 1 0-8 0a6 6 0 1 0 12 0a8 8 0 1 0-16 0a10 10 0 1 0 20 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>Spirale</h1>
        <p>Accès réservé. Entre le mot de passe.</p>
        <input type="password" aria-label="Mot de passe" placeholder="Mot de passe" autofocus>
        <button type="submit">Entrer</button>
        <p class="erreur" role="alert"></p>
      </form>`;
    document.body.appendChild(div);
    const form = div.querySelector('form'), champ = div.querySelector('input'), err = div.querySelector('.erreur');
    champ.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await empreinte(champ.value.trim()) === EMPREINTE) {
        try { localStorage.setItem(CLE, EMPREINTE); } catch { /* reste valable jusqu'au rechargement */ }
        div.remove(); style.remove();
        window.dispatchEvent(new Event('resize'));   // la carte et les graphiques se recalent
      } else {
        err.textContent = 'Mot de passe incorrect.'; champ.select();
      }
    });
  }
  if (document.body) afficher(); else document.addEventListener('DOMContentLoaded', afficher);
})();
