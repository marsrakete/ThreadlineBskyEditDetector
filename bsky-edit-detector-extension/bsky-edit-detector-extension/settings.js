"use strict";

const template = document.querySelector("#threadline-settings-template");
const content = template.content.cloneNode(true);
document.body.appendChild(content);

const toggle = document.querySelector("#mutual-stardust-toggle");
const count = document.querySelector("#mutual-stardust-count");
const countValue = document.querySelector("#mutual-stardust-count-value");
const status = document.querySelector(".threadline-settings-status");
const MIN_MUTUAL_STARDUST_COUNT = 10;
const MAX_MUTUAL_STARDUST_COUNT = 50;
const DEFAULT_MUTUAL_STARDUST_COUNT = 20;

/** Begrenzt einen gespeicherten Symbolwert auf den erlaubten Bereich. @param {unknown} value Gespeicherter oder eingegebener Wert. @returns {number} Ganze Symbolanzahl zwischen 10 und 50. */
function normalizeMutualStardustCount(value) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue)) return DEFAULT_MUTUAL_STARDUST_COUNT;
  if (numericValue < MIN_MUTUAL_STARDUST_COUNT) return MIN_MUTUAL_STARDUST_COUNT;
  if (numericValue > MAX_MUTUAL_STARDUST_COUNT) return MAX_MUTUAL_STARDUST_COUNT;
  return numericValue;
}

/** Liest die gespeicherten Einstellungen für Mutual-Sternenstaub. Keine Parameter. @returns {Promise<{enabled: boolean, count: number}>} Schalterzustand und Symbolanzahl. */
async function readMutualStardustSettings() {
  const result = await chrome.storage.sync.get({
    mutualStardust: false,
    mutualStardustCount: DEFAULT_MUTUAL_STARDUST_COUNT,
  });
  return {
    enabled: result.mutualStardust === true,
    count: normalizeMutualStardustCount(result.mutualStardustCount),
  };
}

/** Aktualisiert die sichtbare Zahl am Mengen-Slider. @param {number} symbolCount Gültige Anzahl der Symbole pro Post. @returns {void} */
function renderMutualStardustCount(symbolCount) {
  count.value = String(symbolCount);
  countValue.value = String(symbolCount);
  countValue.textContent = String(symbolCount);
}

/** Aktualisiert den sichtbaren Status des Mutual-Sternenstaubs. @param {boolean} enabled Aktueller Schalterwert. @param {number} symbolCount Gültige Anzahl der Symbole pro Post. @returns {void} */
function renderMutualStardustStatus(enabled, symbolCount) {
  if (enabled) {
    status.textContent = `Sternenstaub für Mutuals ist eingeschaltet: ${symbolCount} Symbole pro Post.`;
  } else {
    status.textContent = "Sternenstaub für Mutuals ist ausgeschaltet.";
  }
}

/** Speichert den Schalter und aktualisiert den sichtbaren Status. @param {boolean} enabled Neuer Schalterwert. @returns {Promise<void>} Abschluss des Speichervorgangs. */
async function saveMutualStardustEnabled(enabled) {
  await chrome.storage.sync.set({ mutualStardust: enabled });
  renderMutualStardustStatus(enabled, normalizeMutualStardustCount(count.value));
}

/** Speichert die Symbolanzahl und aktualisiert den sichtbaren Status. @param {number} symbolCount Neue Anzahl der Symbole pro Post. @returns {Promise<void>} Abschluss des Speichervorgangs. */
async function saveMutualStardustCount(symbolCount) {
  const normalizedCount = normalizeMutualStardustCount(symbolCount);
  await chrome.storage.sync.set({ mutualStardustCount: normalizedCount });
  renderMutualStardustCount(normalizedCount);
  renderMutualStardustStatus(toggle.checked, normalizedCount);
}

/** Initialisiert Schalter und Mengen-Slider aus den Erweiterungseinstellungen. Keine Parameter. @returns {Promise<void>} Abschluss der Initialisierung. */
async function initializeSettings() {
  try {
    const settings = await readMutualStardustSettings();
    toggle.checked = settings.enabled;
    renderMutualStardustCount(settings.count);
    renderMutualStardustStatus(settings.enabled, settings.count);
  } catch {
    toggle.disabled = true;
    count.disabled = true;
    status.textContent = "Die Einstellung ist derzeit nicht verfügbar.";
  }
}

toggle.addEventListener("change", () => {
  saveMutualStardustEnabled(toggle.checked).catch(() => {
    status.textContent = "Die Einstellung konnte nicht gespeichert werden.";
  });
});

count.addEventListener("input", () => {
  renderMutualStardustCount(normalizeMutualStardustCount(count.value));
});

count.addEventListener("change", () => {
  saveMutualStardustCount(normalizeMutualStardustCount(count.value)).catch(() => {
    status.textContent = "Die Einstellung konnte nicht gespeichert werden.";
  });
});

void initializeSettings();
