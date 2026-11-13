# Appuntamenti PWA — prima versione

## File inclusi
- `index.html`, `styles.css`: interfaccia originale con logo integrato e pulsante installazione.
- `logo.svg`, `icon.svg`, `icon-192.png`, `icon-512.png`: identità grafica provvisoria.
- `manifest.webmanifest`: nome, icone e modalità standalone.
- `service-worker.js`: cache della shell per riapertura offline.
- `pwa.js`: registrazione service worker e gestione installazione Android/desktop.

## Dipendenze già previste nell'HTML originale
L'app originale richiama anche `config.js` e `app.js`: copiali nella stessa cartella di `index.html`.
Non sono stati caricati in questa conversazione, quindi non sono inclusi nello ZIP.

## Pubblicazione
La PWA deve essere pubblicata su HTTPS (localhost va bene per sviluppo).
Per provarla: apri il sito, attendi il caricamento, poi usa "Installa app" quando il browser lo propone.
Su iPhone: Safari > Condividi > Aggiungi alla schermata Home.
