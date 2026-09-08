"use strict";
const content = document.querySelector("template").content.cloneNode(true);
document.body.appendChild(content);
const pds = new URL(location.href).searchParams.get("pds");
document.querySelector("[data-pds]").textContent = pds;

/** Fordert eine optionale Hostberechtigung über einen echten Benutzerklick an. Keine Parameter. @returns {Promise<void>} Zeigt Annahme oder Ablehnung an. */
async function allowPdsAccess() {
  const feedback = document.querySelector('[role="status"]');
  try {
    const url = new URL(pds);
    if (url.protocol !== "https:" || url.origin !== pds) {
      throw new Error("Ungültiger PDS");
    }
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (granted) {
      feedback.textContent = "Freigegeben. Zurück zum Bluesky-Tab wechseln; die Prüfung startet spätestens innerhalb einer Minute.";
      document.querySelector("button").disabled = true;
    } else {
      feedback.textContent = "Nicht freigegeben. Für diesen PDS wird keine direkte Prüfung ausgeführt.";
    }
  } catch {
    feedback.textContent = "Freigabe nicht möglich.";
  }
}

document.querySelector("button").addEventListener("click", allowPdsAccess);
