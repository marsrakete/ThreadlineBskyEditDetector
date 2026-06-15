(() => {
  "use strict";

  const API_BASE = "https://public.api.bsky.app/xrpc";
  const POST_PATH_RE = /^\/profile\/([^/]+)\/post\/([^/?#]+)/;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_PARALLEL = 4;
  const SCAN_DELAY_MS = 350;

  const memoryCache = new Map();
  const pending = new Map();
  let activeRequests = 0;
  const queue = [];
  let scanTimer = null;
  let activeDialog = null;

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, SCAN_DELAY_MS);
  }

  function parsePostUrl(href) {
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }

    if (url.hostname !== "bsky.app") return null;
    const match = url.pathname.match(POST_PATH_RE);
    if (!match) return null;

    return {
      actor: decodeURIComponent(match[1]),
      rkey: decodeURIComponent(match[2]),
      sourceUrl: url.href,
    };
  }

  async function xrpc(method, params) {
    const qs = new URLSearchParams(params);
    const response = await fetch(`${API_BASE}/${method}?${qs.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${method} failed: ${response.status} ${text}`.trim());
    }

    return response.json();
  }

  async function resolveHandleToDid(actor) {
    if (actor.startsWith("did:")) return actor;
    const data = await xrpc("com.atproto.identity.resolveHandle", { handle: actor });
    return data?.did || null;
  }

  async function getPostEditInfo(parsed) {
    const cacheKey = `${parsed.actor}/${parsed.rkey}`;
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;

    if (pending.has(cacheKey)) return pending.get(cacheKey);

    const task = enqueue(async () => {
      const did = await resolveHandleToDid(parsed.actor);
      if (!did) throw new Error("Could not resolve actor DID");

      const recordResponse = await xrpc("com.atproto.repo.getRecord", {
        repo: did,
        collection: "app.bsky.feed.post",
        rkey: parsed.rkey,
      });

      const record = recordResponse?.value;
      const isPost = record?.$type === "app.bsky.feed.post";
      const isEdited =
        isPost &&
        typeof record.originalText === "string" &&
        typeof record.updatedAt === "string";

      const value = {
        uri: `at://${did}/app.bsky.feed.post/${parsed.rkey}`,
        cid: String(recordResponse?.cid || ""),
        actorDid: did,
        sourceUrl: parsed.sourceUrl,
        isEdited,
        text: isPost ? String(record.text || "") : "",
        originalText: isEdited ? String(record.originalText || "") : "",
        createdAt: isPost ? String(record.createdAt || "") : "",
        updatedAt: isEdited ? String(record.updatedAt || "") : "",
      };

      memoryCache.set(cacheKey, { time: Date.now(), value });
      return value;
    }).finally(() => pending.delete(cacheKey));

    pending.set(cacheKey, task);
    return task;
  }

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (activeRequests < MAX_PARALLEL && queue.length > 0) {
      const job = queue.shift();
      activeRequests++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeRequests--;
          pumpQueue();
        });
    }
  }

  function findPostContainer(link) {
    return (
      link.closest('[data-testid="feedItem"]') ||
      link.closest('article') ||
      link.closest('[role="article"]') ||
      link.parentElement
    );
  }

  function formatDate(value) {
    if (!value) return "unbekannt";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
  }

  function addBadge(container, info) {
    if (!container || container.querySelector(":scope > .bsky-edit-detector-badge")) return;

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "bsky-edit-detector-badge";
    badge.textContent = `✏️ bearbeitet${info.updatedAt ? ` · ${formatDate(info.updatedAt)}` : ""}`;
    badge.title = "Bearbeitungsdetails anzeigen";
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showEditDialog(info);
    });

    const target = findInsertionPoint(container) || container;
    target.appendChild(badge);
  }

  function addErrorMark(container) {
    if (!container || container.dataset.bskyEditDetectorError === "1") return;
    container.dataset.bskyEditDetectorError = "1";
  }

  function findInsertionPoint(container) {
    const candidates = container.querySelectorAll("span, div");
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (/^\d+[smhd]$/.test(text) || text.includes(" ago") || text.includes("·")) {
        return el.parentElement || el;
      }
    }
    return container;
  }

  function tokenize(text) {
    return String(text || "").match(/\s+|[^\s]+/g) || [];
  }

  function diffTokens(oldText, newText) {
    const oldTokens = tokenize(oldText);
    const newTokens = tokenize(newText);
    const n = oldTokens.length;
    const m = newTokens.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = oldTokens[i] === newTokens[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const oldParts = [];
    const newParts = [];
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
      if (oldTokens[i] === newTokens[j]) {
        oldParts.push({ type: "equal", text: oldTokens[i] });
        newParts.push({ type: "equal", text: newTokens[j] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        oldParts.push({ type: "removed", text: oldTokens[i] });
        i++;
      } else {
        newParts.push({ type: "added", text: newTokens[j] });
        j++;
      }
    }

    while (i < n) oldParts.push({ type: "removed", text: oldTokens[i++] });
    while (j < m) newParts.push({ type: "added", text: newTokens[j++] });

    return { oldParts: mergeParts(oldParts), newParts: mergeParts(newParts) };
  }

  function mergeParts(parts) {
    const merged = [];
    for (const part of parts) {
      const last = merged[merged.length - 1];
      if (last && last.type === part.type) last.text += part.text;
      else merged.push({ ...part });
    }
    return merged;
  }

  function renderDiff(container, parts) {
    container.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const span = document.createElement("span");
      span.textContent = part.text;
      if (part.type === "added") span.className = "bsky-edit-detector-added";
      if (part.type === "removed") span.className = "bsky-edit-detector-removed";
      fragment.appendChild(span);
    }
    container.appendChild(fragment);
  }

  function showEditDialog(info) {
    closeEditDialog();

    const overlay = document.createElement("div");
    overlay.className = "bsky-edit-detector-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeEditDialog();
    });

    const dialog = document.createElement("section");
    dialog.className = "bsky-edit-detector-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Bearbeitungs-Details");

    const diff = diffTokens(info.originalText, info.text);

    dialog.innerHTML = `
      <button type="button" class="bsky-edit-detector-close" aria-label="Schließen">×</button>
      <h2>Bearbeitungs-Details</h2>
      <p class="bsky-edit-detector-muted">Dieser Post enthält eine Bearbeitung, die von Mu dokumentiert wurde.</p>
      <div class="bsky-edit-detector-meta">
        <div><span>Erstellt:</span> <strong>${escapeHtml(formatDate(info.createdAt))}</strong></div>
        <div><span>Geändert:</span> <strong>${escapeHtml(formatDate(info.updatedAt))}</strong></div>
      </div>
      <div class="bsky-edit-detector-url">
        <strong>Post-URL</strong>
        <a href="${escapeAttribute(info.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(info.sourceUrl)}</a>
      </div>
      <div class="bsky-edit-detector-diff-grid">
        <div class="bsky-edit-detector-panel">
          <h3>Ursprünglicher Text</h3>
          <div class="bsky-edit-detector-text" data-side="old"></div>
        </div>
        <div class="bsky-edit-detector-panel">
          <h3>Aktueller Text</h3>
          <div class="bsky-edit-detector-text" data-side="new"></div>
        </div>
      </div>
      <div class="bsky-edit-detector-legend">
        <span><i class="bsky-edit-detector-added"></i> Hinzugefügt</span>
        <span><i class="bsky-edit-detector-removed"></i> Entfernt</span>
      </div>
      <p class="bsky-edit-detector-note">Hinweis: Änderungen werden von Mu (mu.social) im ATProto-Record als <code>originalText</code> und <code>updatedAt</code> gespeichert.</p>
      <div class="bsky-edit-detector-actions"><button type="button">Schließen</button></div>
    `;

    overlay.appendChild(dialog);
    document.documentElement.appendChild(overlay);

    renderDiff(dialog.querySelector('[data-side="old"]'), diff.oldParts);
    renderDiff(dialog.querySelector('[data-side="new"]'), diff.newParts);

    dialog.querySelector(".bsky-edit-detector-close").addEventListener("click", closeEditDialog);
    dialog.querySelector(".bsky-edit-detector-actions button").addEventListener("click", closeEditDialog);

    const onKeyDown = (event) => {
      if (event.key === "Escape") closeEditDialog();
    };
    document.addEventListener("keydown", onKeyDown);

    activeDialog = { overlay, onKeyDown };
  }

  function closeEditDialog() {
    if (!activeDialog) return;
    document.removeEventListener("keydown", activeDialog.onKeyDown);
    activeDialog.overlay.remove();
    activeDialog = null;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    }[char]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }

  async function processLink(link) {
    if (link.dataset.bskyEditDetectorChecked === "1") return;
    const parsed = parsePostUrl(link.href);
    if (!parsed) return;

    link.dataset.bskyEditDetectorChecked = "1";
    const container = findPostContainer(link);

    try {
      const info = await getPostEditInfo(parsed);
      if (info.isEdited) addBadge(container, info);
    } catch (error) {
      console.debug("Bsky Edit Detector:", error);
      addErrorMark(container);
    }
  }

  function scanPage() {
    const links = Array.from(document.querySelectorAll('a[href*="/profile/"][href*="/post/"]'));
    for (const link of links) processLink(link);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  scanPage();
})();
