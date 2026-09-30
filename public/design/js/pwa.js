// Installable app: the service worker (module type) and the iOS "Add to Home Screen" hint. Both
// fail quietly: the editor works without them.
export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/design/sw.js", { scope: "/design/", type: "module" });
  } catch {
    /* unsupported (older browsers can't run module service workers) or blocked: no offline mode */
  }
}

export function showInstallHint(el) {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  el.hidden = !(ios && !standalone);
}
