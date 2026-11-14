// Configurazione del frontend.
// In produzione imposta l'URL pubblico del backend (es. su Render).
// L'utente può comunque sovrascriverlo da ⚙ Impostazioni (salvato nel suo browser).
window.APP_CONFIG = {
  API_URL: 'https://appuntamenti-backend-xxxx.onrender.com',
  REQUIRE_CUSTOMER_LOGIN: false
};
  // false = prenotazione libera (il backend attuale non ha ancora gli account cliente).
  // true  = serve un account cliente: richiede gli endpoint /api/clienti/* descritti in BACKEND.md.
  REQUIRE_CUSTOMER_LOGIN: false

