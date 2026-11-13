// Solo pulsante "Installa app". Il service worker è registrato UNA volta, da app.js (sw.js):
// prima c'erano due worker (service-worker.js e sw.js) sullo stesso scope che si sostituivano a vicenda.
(() => {
  const installButton = document.getElementById("btnInstall");
  if (!installButton) return;
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); installPrompt = event; installButton.hidden = false;
  });
  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt(); await installPrompt.userChoice;
    installPrompt = null; installButton.hidden = true;
  });
  window.addEventListener("appinstalled", () => { installButton.hidden = true; installPrompt = null; });
})();
