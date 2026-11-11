(() => {
  "use strict";

  const API_BASE = "https://public.api.bsky.app/xrpc";
  const POST_PATH_RE = /^\/profile\/([^/]+)\/post\/([^/?#]+)/;
  const POST_LINK_SELECTOR = 'a[href*="/profile/"][href*="/post/"]:not(.bsky-edit-detector-overlay *)';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_PARALLEL = 4;
  const SCAN_DELAY_MS = 350;
  const PLC_DIRECTORY_URL = "https://plc.directory";
  const WSOCIAL_PDS_HOSTS = new Set(["pds.wsocial.network"]);
  const MUTUAL_STARDUST_SETTING = "mutualStardust";
  const MUTUAL_STARDUST_THEME_SETTING = "mutualStardustTheme";
  const THREAD_DATA_BUTTON_SETTING = "showThreadDataButton";
  const MUTUAL_STARDUST_COUNT_SETTING = "mutualStardustCount";
  const MIN_MUTUAL_STARDUST_COUNT = 10;
  const MAX_MUTUAL_STARDUST_COUNT = 50;
  const DEFAULT_MUTUAL_STARDUST_COUNT = 20;
  const STARDUST_THEMES = {
    stardust: { glyphs: ["✦", "✧", "⋆", "❋", "✺", "✨", "·"], color: "202, 138, 4" },
    space: { glyphs: ["🪐", "🌙", "☄️", "🚀", "🛸", "🌌", "⭐"], color: "124, 92, 220" },
    carnival: { glyphs: ["🎭", "🎉", "🎊", "🎈", "🥳", "🪅", "✨"], color: "219, 39, 119" },
    birthday: { glyphs: ["🎂", "🧁", "🎈", "🎉", "🎁", "🍰", "✨"], color: "236, 72, 153" },
    flowers: { glyphs: ["🌸", "🌼", "🌻", "🌷", "🦋", "🌿", "✨"], color: "219, 39, 119" },
    ocean: { glyphs: ["🐠", "🐚", "🫧", "🐬", "🪸", "🌊", "✨"], color: "8, 145, 178" },
    forest: { glyphs: ["🍃", "🍂", "🍄", "🌿", "🌱", "🦋", "✨"], color: "22, 120, 76" },
    disco: { glyphs: ["🪩", "💃", "🕺", "🎶", "🌈", "✨", "🎵"], color: "147, 51, 234" },
    halloween: { glyphs: ["🎃", "👻", "🦇", "🕸️", "🕷️", "🌙", "✨"], color: "234, 88, 12" },
    winter: { glyphs: ["❄️", "☃️", "⛄", "🧊", "🌨️", "⭐", "✨"], color: "37, 99, 235" },
  };

  const memoryCache = new Map();
  const pdsCache = new Map();
  const relationshipCache = new Map();
  const listMembershipCache = new Map();
  const pending = new Map();
  let activeRequests = 0;
  const queue = [];
  let scanTimer = null;
  let activeDialog = null;
  let mutualStardustSettingsTask = null;

  /** Plant einen gebündelten Durchlauf der sichtbaren Post-Links. Keine Parameter. @returns {void} */

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

    if (!isSupportedPostHost(url.hostname)) return null;
    const match = url.pathname.match(POST_PATH_RE);
    if (!match) return null;

    return {
      actor: decodeURIComponent(match[1]),
      rkey: decodeURIComponent(match[2]),
      sourceUrl: url.href,
    };
  }

  /** Prüft, ob ein Host zu einer unterstützten Bluesky-Weboberfläche oder deren Subdomain gehört. @param {string} hostname Hostname aus einer Post-URL. @returns {boolean} Ob die URL für die Post-Erkennung unterstützt wird. */
  function isSupportedPostHost(hostname) {
    const host = hostname.toLowerCase();
    if (host === "bsky.app") return true;
    if (host === "cope.works") return true;
    if (host === "mu.social" || host.endsWith(".mu.social")) return true;
    if (host === "blacksky.app" || host.endsWith(".blacksky.app")) return true;
    if (host === "portal.eurosky.tech") return true;
    if (host === "eurosky.social" || host.endsWith(".eurosky.social")) return true;
    return false;
  }

  /** Liest die PDS-Adresse aus einem did:plc-Dokument. @param {object} didDocument DID-Dokument aus dem PLC-Verzeichnis. @returns {string} HTTPS-Ursprung oder leerer String. */
  function pdsFromDidDocument(didDocument) {
    if (!didDocument || !Array.isArray(didDocument.service)) return "";

    for (const service of didDocument.service) {
      if (!service || service.type !== "AtprotoPersonalDataServer") continue;
      if (typeof service.serviceEndpoint !== "string") continue;

      try {
        const endpoint = new URL(service.serviceEndpoint);
        if (endpoint.protocol === "https:") return endpoint.origin;
      } catch {
        continue;
      }
    }
    return "";
  }

  /** Ermittelt einmalig pro did:plc die veröffentlichte PDS-Adresse. @param {string} did Dezentrale Kennung des Kontos. @returns {Promise<string>} HTTPS-Ursprung oder leerer String bei unbekanntem PDS. */
  async function getPdsForDid(did) {
    if (!did.startsWith("did:plc:")) return "";
    if (pdsCache.has(did)) return pdsCache.get(did);

    const task = fetch(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) return "";
        const didDocument = await response.json();
        return pdsFromDidDocument(didDocument);
      })
      .catch(() => "");

    pdsCache.set(did, task);
    return task;
  }

  /** Prüft, ob eine PDS-Adresse zum bekannten WSocial-PDS gehört. @param {string} pds HTTPS-Ursprung einer PDS. @returns {boolean} Ob die PDS von WSocial betrieben wird. */
  function isWsocialPds(pds) {
    try {
      return WSOCIAL_PDS_HOSTS.has(new URL(pds).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  /** Prüft, ob ein Handle die öffentliche WSocial-Domain nutzt. @param {string} handle Handle eines Kontos. @returns {boolean} Ob das Handle auf wsocial.eu endet. */
  function isWsocialHandle(handle) {
    const normalized = String(handle || "").toLowerCase();
    if (normalized === "wsocial.eu") return true;
    return normalized.endsWith(".wsocial.eu");
  }

  /** Übersetzt eine Threadgate-Regel in einen lesbaren Antwortkreis. @param {object} rule Eintrag aus `threadgate.allow`. @returns {string} Deutscher Regelname oder leerer String. */
  function labelThreadgateRule(rule) {
    if (!rule || typeof rule.$type !== "string") return "";
    if (rule.$type === "app.bsky.feed.threadgate#mentionRule") return "Erwähnte";
    if (rule.$type === "app.bsky.feed.threadgate#followerRule") return "Follower";
    if (rule.$type === "app.bsky.feed.threadgate#followingRule") return "Gefolgte";
    if (rule.$type === "app.bsky.feed.threadgate#listRule") return "Liste";
    return "";
  }

  /** Fasst eine Threadgate-Antwortbeschränkung für die Anzeige zusammen. @param {object|null} record Threadgate-Record oder null. @returns {string} Hinweistext oder leerer String, wenn Antworten offen sind. */
  function getReplyRestriction(record) {
    if (!record || !Array.isArray(record.allow)) return "";
    if (record.allow.length === 0) return "Antworten gesperrt";

    const labels = [];
    for (const rule of record.allow) {
      const label = labelThreadgateRule(rule);
      if (label && !labels.includes(label)) labels.push(label);
    }
    if (labels.length === 0) return "Antworten eingeschränkt";
    return `Antworten nur für: ${labels.join(", ")}`;
  }

  /** Liest den optionalen Threadgate-Record eines Originalposts. @param {string} did DID des Post-Autors. @param {string} rkey Record-Schlüssel des Originalposts. @returns {Promise<object|null>} Threadgate-Record oder null, wenn keine Beschränkung gespeichert ist. */
  async function getThreadgateRecord(did, rkey) {
    const query = new URLSearchParams({
      repo: did,
      collection: "app.bsky.feed.threadgate",
      rkey,
    });
    const response = await fetch(`${API_BASE}/com.atproto.repo.getRecord?${query.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Threadgate request failed: ${response.status}`);

    const result = await response.json();
    if (!result || !result.value) return null;
    return result.value;
  }

  /** Liest ausschließlich die DID des lokal ausgewählten Bluesky-Kontos. Keine Parameter. @returns {string} DID des Kontos oder leerer String, wenn keine lesbare Sitzung vorliegt. */
  function getCurrentAccountDid() {
    try {
      const raw = localStorage.getItem("BSKY_STORAGE");
      if (!raw) return "";
      const session = JSON.parse(raw)?.session;
      const current = session?.currentAccount;
      if (!current || typeof current.did !== "string") return "";
      if (!current.did.startsWith("did:")) return "";
      return current.did;
    } catch {
      return "";
    }
  }

  /** Prüft, ob die eingeloggte DID in den Erwähnungen eines Posts steht. @param {object} record Post-Record mit optionalen Facets. @param {string} viewerDid DID des eingeloggten Kontos. @returns {boolean} Ob das Konto erwähnt wurde. */
  function postMentionsDid(record, viewerDid) {
    if (!record || !Array.isArray(record.facets) || !viewerDid) return false;

    for (const facet of record.facets) {
      if (!facet || !Array.isArray(facet.features)) continue;
      for (const feature of facet.features) {
        if (!feature || feature.$type !== "app.bsky.richtext.facet#mention") continue;
        if (feature.did === viewerDid) return true;
      }
    }
    return false;
  }

  /** Liest die öffentliche Beziehung zwischen dem eingeloggten Konto und dem Post-Autor. @param {string} viewerDid DID des eingeloggten Kontos. @param {string} authorDid DID des Post-Autors. @returns {Promise<object|null>} Beziehung oder null bei fehlender öffentlicher Antwort. */
  async function getRelationship(viewerDid, authorDid) {
    const key = `${viewerDid}:${authorDid}`;
    if (relationshipCache.has(key)) return relationshipCache.get(key);

    const task = xrpc("app.bsky.graph.getRelationships", {
      actor: viewerDid,
      others: authorDid,
    }).then((result) => {
      if (!result || !Array.isArray(result.relationships)) return null;
      for (const relationship of result.relationships) {
        if (relationship && relationship.did === authorDid) return relationship;
      }
      return null;
    });

    relationshipCache.set(key, task);
    return task;
  }

  /** Begrenzt eine gespeicherte Symbolanzahl auf den erlaubten Bereich. @param {unknown} value Gespeicherter Wert aus den Erweiterungseinstellungen. @returns {number} Ganze Symbolanzahl zwischen 10 und 50. */
  function normalizeMutualStardustCount(value) {
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue)) return DEFAULT_MUTUAL_STARDUST_COUNT;
    if (numericValue < MIN_MUTUAL_STARDUST_COUNT) return MIN_MUTUAL_STARDUST_COUNT;
    if (numericValue > MAX_MUTUAL_STARDUST_COUNT) return MAX_MUTUAL_STARDUST_COUNT;
    return numericValue;
  }

  /** Liest die gespeicherten Einstellungen für Mutual-Sternenstaub höchstens einmal bis zur nächsten Änderung. Keine Parameter. @returns {Promise<{enabled: boolean, count: number}>} Schalterzustand und Symbolanzahl. */
  async function getMutualStardustSettings() {
    if (mutualStardustSettingsTask) return mutualStardustSettingsTask;

    const extensionChrome = globalThis.chrome;
    if (!extensionChrome || !extensionChrome.storage || !extensionChrome.storage.sync) {
      return { enabled: false, count: DEFAULT_MUTUAL_STARDUST_COUNT };
    }

    mutualStardustSettingsTask = extensionChrome.storage.sync.get({
      [MUTUAL_STARDUST_SETTING]: false,
      [MUTUAL_STARDUST_THEME_SETTING]: "stardust",
      [MUTUAL_STARDUST_COUNT_SETTING]: DEFAULT_MUTUAL_STARDUST_COUNT,
    })
      .then((settings) => ({
        enabled: settings[MUTUAL_STARDUST_SETTING] === true,
        theme: Object.hasOwn(STARDUST_THEMES, settings[MUTUAL_STARDUST_THEME_SETTING])
          ? settings[MUTUAL_STARDUST_THEME_SETTING]
          : "stardust",
        count: normalizeMutualStardustCount(settings[MUTUAL_STARDUST_COUNT_SETTING]),
      }))
      .catch(() => ({ enabled: false, theme: "stardust", count: DEFAULT_MUTUAL_STARDUST_COUNT }));
    return mutualStardustSettingsTask;
  }

  /** Prüft die öffentliche gegenseitige Folgebeziehung zum Post-Autor. @param {string} authorDid DID des Post-Autors. @returns {Promise<boolean>} Ob Autor und lokal eingeloggtes Konto ein Mutual sind. */
  async function isMutual(authorDid) {
    const viewerDid = getCurrentAccountDid();
    if (!viewerDid || viewerDid === authorDid) return false;

    try {
      const relationship = await getRelationship(viewerDid, authorDid);
      if (!relationship) return false;
      if (!relationship.following) return false;
      if (!relationship.followedBy) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Erzeugt oder findet das Template für einen einzelnen Mutual-Stern. Keine Parameter. @returns {HTMLTemplateElement} Wiederverwendbares Stern-Template. */
  function getMutualStardustTemplate() {
    const existing = document.getElementById("bsky-edit-detector-mutual-stardust-template");
    if (existing instanceof HTMLTemplateElement) return existing;

    const template = document.createElement("template");
    template.id = "bsky-edit-detector-mutual-stardust-template";
    const layer = document.createElement("span");
    layer.className = "bsky-edit-detector-mutual-stardust-layer";
    const star = document.createElement("span");
    star.className = "bsky-edit-detector-mutual-star";
    star.setAttribute("aria-hidden", "true");
    layer.appendChild(star);
    template.content.appendChild(layer);
    document.documentElement.appendChild(template);
    return template;
  }

  /** Liefert einen neuen kryptografischen Zufallswert zwischen null und eins. @returns {number} Zufallswert. */
  function randomStardustValue() {
    return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  }

  /** Entfernt vorhandenen Mutual-Sternenstaub aus einem Post-Container. @param {Element|null} container Post-Container. @returns {void} */
  function removeMutualStardust(container) {
    if (!container) return;
    for (const layer of container.querySelectorAll(".bsky-edit-detector-mutual-stardust-layer")) {
      layer.remove();
    }
    container.classList.remove("bsky-edit-detector-has-mutual-stardust");
  }

  /** Rendert sanften Sternenstaub ausschließlich an Posts von Mutuals. @param {Element|null} container Post-Container. @param {string} authorDid DID des Post-Autors. @param {string} postUri AT-URI des Posts. @returns {Promise<void>} Abschluss der Bewertung und Darstellung. */
  async function renderMutualStardust(container, authorDid, postUri) {
    removeMutualStardust(container);
    if (!container) return;
    const stardustSettings = await getMutualStardustSettings();
    if (!stardustSettings.enabled) return;
    if (!(await isMutual(authorDid))) return;

    const theme = STARDUST_THEMES[stardustSettings.theme] || STARDUST_THEMES.stardust;
    const glyphs = Array.from({ length: stardustSettings.count }, () =>
      theme.glyphs[Math.floor(randomStardustValue() * theme.glyphs.length)]);
    for (let index = glyphs.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(randomStardustValue() * (index + 1));
      [glyphs[index], glyphs[swapIndex]] = [glyphs[swapIndex], glyphs[index]];
    }
    const template = getMutualStardustTemplate();
    container.classList.add("bsky-edit-detector-has-mutual-stardust");
    for (let index = 0; index < stardustSettings.count; index++) {
      const layer = template.content.firstElementChild.cloneNode(true);
      const star = layer.querySelector(".bsky-edit-detector-mutual-star");
      const horizontal = 3 + Math.round(randomStardustValue() * 94);
      const vertical = 5 + Math.round(randomStardustValue() * 90);
      const duration = 5000 + Math.round(randomStardustValue() * 14000);
      const delay = -Math.round(randomStardustValue() * duration);
      const size = 12 + Math.round(randomStardustValue() * 13);
      star.dataset.glyph = glyphs[index];
      star.style.setProperty("--stardust-color", theme.color);
      star.style.setProperty("--stardust-x", `${horizontal}%`);
      star.style.setProperty("--stardust-y", `${vertical}%`);
      star.style.setProperty("--stardust-size", `${size}px`);
      star.style.setProperty("--stardust-rotation", `${Math.round(randomStardustValue() * 70 - 35)}deg`);
      star.style.setProperty("--stardust-duration", `${duration}ms`);
      star.style.setProperty("--stardust-delay", `${delay}ms`);
      container.appendChild(layer);
    }
  }

  /** Reagiert auf eine geänderte Sternenstaub-Einstellung und plant einen neuen Seitendurchlauf. Keine Parameter. @returns {void} */
  function refreshMutualStardust() {
    mutualStardustSettingsTask = null;
    for (const container of document.querySelectorAll("[data-bsky-edit-detector-current-post]")) {
      delete container.dataset.bskyEditDetectorCurrentPost;
    }
    for (const link of document.querySelectorAll('a[href*="/profile/"][href*="/post/"]')) {
      delete link.dataset.bskyEditDetectorChecked;
    }
    for (const container of document.querySelectorAll(".bsky-edit-detector-has-mutual-stardust")) {
      removeMutualStardust(container);
    }
    scheduleScan();
  }

  /** Prüft mit höchstens zehn öffentlichen Listenseiten, ob ein Konto Mitglied einer Antwortliste ist. @param {string} listUri AT-URI der Antwortliste. @param {string} viewerDid DID des eingeloggten Kontos. @returns {Promise<boolean|null>} true bei Mitgliedschaft, false bei vollständiger öffentlicher Liste, null bei unvollständiger Prüfung. */
  async function isOnReplyList(listUri, viewerDid) {
    const key = `${listUri}:${viewerDid}`;
    if (listMembershipCache.has(key)) return listMembershipCache.get(key);

    const task = (async () => {
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const params = { list: listUri, limit: "100" };
        if (cursor) params.cursor = cursor;
        const result = await xrpc("app.bsky.graph.getList", params);
        if (!result || !Array.isArray(result.items)) return null;
        for (const item of result.items) {
          if (item?.subject?.did === viewerDid) return true;
        }
        if (typeof result.cursor !== "string" || !result.cursor) return false;
        cursor = result.cursor;
      }
      return null;
    })();

    listMembershipCache.set(key, task);
    return task;
  }

  /** Ermittelt, ob die öffentliche Threadgate-Regel eine Antwort des eingeloggten Kontos zulässt. @param {object|null} threadgate Threadgate-Record oder null. @param {object} record Originaler Post-Record. @param {string} viewerDid DID des eingeloggten Kontos. @param {string} authorDid DID des Post-Autors. @returns {Promise<string>} Verständlicher persönlicher Antwortstatus. */
  async function getPersonalReplyStatus(threadgate, record, viewerDid, authorDid) {
    if (!viewerDid) return "Antwort für dich nicht prüfbar: kein eingeloggtes Konto";
    if (!threadgate || !Array.isArray(threadgate.allow)) return "Du kannst antworten";
    if (threadgate.allow.length === 0) return "Du kannst nicht antworten: Antworten gesperrt";
    if (postMentionsDid(record, viewerDid)) {
      for (const rule of threadgate.allow) {
        if (rule?.$type === "app.bsky.feed.threadgate#mentionRule") return "Du kannst antworten: Du bist erwähnt";
      }
    }

    let relationship;
    try {
      relationship = await getRelationship(viewerDid, authorDid);
    } catch {
      relationship = null;
    }

    if (!relationship) return "Antwort für dich nicht eindeutig bestimmbar";
    if (relationship?.blocking || relationship?.blockedBy || relationship?.blockingByList || relationship?.blockedByList) {
      return "Du kannst nicht antworten: Blockierung";
    }

    let hasUnknownRule = false;
    for (const rule of threadgate.allow) {
      if (!rule || typeof rule.$type !== "string") {
        hasUnknownRule = true;
        continue;
      }
      if (rule.$type === "app.bsky.feed.threadgate#followerRule") {
        if (!relationship) {
          hasUnknownRule = true;
          continue;
        }
        if (relationship.following) return "Du kannst antworten: Du folgst diesem Konto";
      }
      if (rule.$type === "app.bsky.feed.threadgate#followingRule") {
        if (!relationship) {
          hasUnknownRule = true;
          continue;
        }
        if (relationship.followedBy) return "Du kannst antworten: Das Konto folgt dir";
      }
      if (rule.$type === "app.bsky.feed.threadgate#listRule") {
        if (typeof rule.list !== "string" || !rule.list) {
          hasUnknownRule = true;
          continue;
        }
        try {
          const isMember = await isOnReplyList(rule.list, viewerDid);
          if (isMember === true) return "Du kannst antworten: Du bist auf der Antwortliste";
          if (isMember === null) hasUnknownRule = true;
        } catch {
          hasUnknownRule = true;
        }
      }
    }

    if (hasUnknownRule) return "Antwort für dich nicht eindeutig bestimmbar";
    return "Du kannst nicht antworten: Antwortkreis erlaubt dich nicht";
  }

  /** Fragt die öffentliche API ab und meldet das Ergebnis. @param {string} method XRPC-Methode. @param {object} params Suchparameter. @returns {Promise<object>} JSON-Antwort; wirft bei Fehlern. */
  async function xrpc(method, params, signal) {
    const qs = new URLSearchParams(params);
    let response;
    try {
      response = await fetch(`${API_BASE}/${method}?${qs.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (error) {
      BskyEditDetectorConnection.reportRequest(method, "Netzwerkfehler");
      throw error;
    }

    if (!response.ok) {
      BskyEditDetectorConnection.reportRequest(method, `HTTP ${response.status}`);
      throw new Error(`${method} failed: ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      BskyEditDetectorConnection.reportRequest(method, "Ungültige JSON-Antwort");
      throw error;
    }
    BskyEditDetectorConnection.reportRequest(method, `Erfolgreich · HTTP ${response.status}`);
    return data;
  }

  async function resolveHandleToDid(actor) {
    if (actor.startsWith("did:")) return actor;
    const data = await xrpc("com.atproto.identity.resolveHandle", { handle: actor });
    return data?.did || null;
  }

  async function getPostThread(uri) {
    const { thread } = await xrpc("app.bsky.feed.getPostThread", {
      uri,
      depth: 1,
      parentHeight: 0,
    }, AbortSignal.timeout(5000));
    return thread;
  }

  /** Prüft direkte Antworten auf eine frühere Record-Fassung desselben Posts. */
  async function hasDifferentReplyCid(uri, cid) {
    if (!cid) return false;

    try {
      const thread = await getPostThread(uri);
      if (thread?.post?.uri !== uri || thread.post.cid !== cid || !Array.isArray(thread.replies)) {
        return false;
      }

      return thread.replies.some(({ post }) => {
        const parent = post?.record?.reply?.parent;
        return parent?.uri === uri && typeof parent.cid === "string" && parent.cid !== "" && parent.cid !== cid;
      });
    } catch (error) {
      console.debug("Bsky Edit Detector: Antwortreferenzen konnten nicht geladen werden.", error);
      return false;
    }
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
      const hasEditMetadata =
        isPost &&
        typeof record.originalText === "string" &&
        typeof record.updatedAt === "string";
      const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
      const cid = String(recordResponse?.cid || "");
      const isEdited = hasEditMetadata || (isPost && await hasDifferentReplyCid(uri, cid));
      const pds = await getPdsForDid(did);
      const usesWsocialPds = isWsocialPds(pds);
      let replyRestriction = "";
      let personalReplyStatus = "";

      if (isPost && usesWsocialPds && !record.reply) {
        try {
          const threadgate = await getThreadgateRecord(did, parsed.rkey);
          replyRestriction = getReplyRestriction(threadgate);
          personalReplyStatus = await getPersonalReplyStatus(threadgate, record, getCurrentAccountDid(), did);
        } catch (error) {
          console.debug("Bsky Edit Detector: Threadgate konnte nicht geladen werden.", error);
          personalReplyStatus = "Antwort für dich derzeit nicht prüfbar";
        }
      }

      const value = {
        uri,
        cid,
        actorDid: did,
        sourceUrl: parsed.sourceUrl,
        isEdited,
        text: isPost ? String(record.text || "") : "",
        originalText: hasEditMetadata ? record.originalText : null,
        createdAt: isPost ? String(record.createdAt || "") : "",
        updatedAt: hasEditMetadata ? record.updatedAt : "",
        pds,
        usesWsocialPds,
        usesWsocialHandle: isWsocialHandle(parsed.actor),
        replyRestriction,
        personalReplyStatus,
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

  /** Findet den ersten ausreichend hohen Vorfahren eines Post-Links mit mindestens zwei Aktionsschaltflächen. @param {HTMLAnchorElement} link Post-Link aus Bluesky oder einer kompatiblen Oberfläche. @returns {Element|null} Einzelne Post-Karte oder das direkte Eltern-Element. */
  function findInteractivePostContainer(link) {
    let ancestor = link.parentElement;
    while (ancestor && ancestor !== document.body) {
      const bounds = ancestor.getBoundingClientRect();
      const actionCount = ancestor.querySelectorAll('button, [role="button"]').length;
      if (bounds.height >= 72 && actionCount >= 2) return ancestor;
      ancestor = ancestor.parentElement;
    }

    return link.parentElement;
  }

  /** Findet den vollständigen, sichtbaren Karten-Container eines Post-Links. @param {HTMLAnchorElement} link Post-Link aus Bluesky oder einer kompatiblen Oberfläche. @returns {Element|null} Umfassender Post-Container oder eine einzelne interaktive Post-Karte. */
  function findPostContainer(link) {
    const feedItem = link.closest('[data-testid="feedItem"]');
    if (feedItem) return feedItem;

    const article = link.closest('article');
    if (article) return article;

    const roleArticle = link.closest('[role="article"]');
    if (roleArticle) return roleArticle;

    return findInteractivePostContainer(link);
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

  /** Fügt einen anklickbaren Bearbeitungshinweis an einen Post an. @param {Element} container Post-Container. @param {object} info Abgerufene Post-Informationen. @returns {void} */
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

  /** Erstellt oder findet das DOM-Template für WSocial- und Antwort-Hinweise. Keine Parameter. @returns {HTMLTemplateElement} Wiederverwendbares Badge-Template. */
  function getSignalTemplate() {
    const existing = document.getElementById("bsky-edit-detector-signal-template");
    if (existing instanceof HTMLTemplateElement) return existing;

    const template = document.createElement("template");
    template.id = "bsky-edit-detector-signal-template";
    const badge = document.createElement("span");
    badge.className = "bsky-edit-detector-signal";
    badge.setAttribute("role", "status");
    template.content.appendChild(badge);
    document.documentElement.appendChild(template);
    return template;
  }

  /** Fügt einen einmaligen, nicht anklickbaren Hinweis an einen Post an. @param {Element} container Post-Container. @param {string} key Stabile Kennung gegen doppelte Hinweise. @param {string} text Sichtbarer Hinweistext. @param {string} variant CSS-Variante. @returns {void} */
  function addSignalBadge(container, key, text, variant) {
    if (!container) return;
    if (container.querySelector(`[data-bsky-edit-detector-signal="${key}"]`)) return;

    const badge = getSignalTemplate().content.firstElementChild.cloneNode(true);
    badge.dataset.bskyEditDetectorSignal = key;
    badge.classList.add(`bsky-edit-detector-signal--${variant}`);
    badge.textContent = text;

    const target = findInsertionPoint(container) || container;
    target.appendChild(badge);
  }

  /** Markiert WSocial-Hosting und die Antwortbeschränkung eines Originalposts. @param {Element} container Post-Container. @param {object} info Abgerufene Post-Informationen. @returns {void} */
  function addAccountSignals(container, info) {
    if (info.usesWsocialPds) {
      let pdsLabel = "WSocial-PDS";
      if (info.usesWsocialHandle) pdsLabel = "WSocial-PDS · WSocial-Handle";
      addSignalBadge(container, "wsocial-pds", pdsLabel, "provider");
    }

    if (info.replyRestriction) {
      addSignalBadge(container, "reply-restriction", info.replyRestriction, "restriction");
    }

    if (info.personalReplyStatus) {
      let variant = "reply-blocked";
      if (info.personalReplyStatus.startsWith("Du kannst antworten")) variant = "reply-possible";
      addSignalBadge(container, "personal-reply-status", info.personalReplyStatus, variant);
    }
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

    const diff = info.originalText === null ? null : diffTokens(info.originalText, info.text);

    dialog.innerHTML = `
      <button type="button" class="bsky-edit-detector-close" aria-label="Schließen">×</button>
      <h2>Bearbeitungs-Details</h2>
      <p class="bsky-edit-detector-muted">${diff
        ? "Dieser Post enthält eine Bearbeitung, die von Mu dokumentiert wurde."
        : "Eine Antwort verweist auf eine andere Fassung dieses Posts. Der genaue Bearbeitungszeitpunkt ist unbekannt."}</p>
      <div class="bsky-edit-detector-meta">
        <div><span>Erstellt:</span> <strong>${escapeHtml(formatDate(info.createdAt))}</strong></div>
        ${diff ? `<div><span>Geändert:</span> <strong>${escapeHtml(formatDate(info.updatedAt))}</strong></div>` : ""}
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
      ${diff ? `<div class="bsky-edit-detector-legend">
        <span><i class="bsky-edit-detector-added"></i> Hinzugefügt</span>
        <span><i class="bsky-edit-detector-removed"></i> Entfernt</span>
      </div>
      <p class="bsky-edit-detector-note">Hinweis: Änderungen werden von Mu (mu.social) im ATProto-Record als <code>originalText</code> und <code>updatedAt</code> gespeichert.</p>` : ""}
      <div class="bsky-edit-detector-actions"><button type="button">Schließen</button></div>
    `;

    overlay.appendChild(dialog);
    document.documentElement.appendChild(overlay);

    const oldText = dialog.querySelector('[data-side="old"]');
    const newText = dialog.querySelector('[data-side="new"]');
    if (diff) {
      renderDiff(oldText, diff.oldParts);
      renderDiff(newText, diff.newParts);
    } else {
      oldText.textContent = "Frühere Fassung nicht verfügbar.";
      newText.textContent = info.text;
    }

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

  function addThreadDataButton(container, parsed) {
    if (!container || container.querySelector(".bsky-edit-detector-thread-button")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bsky-edit-detector-thread-button";
    button.textContent = "Thread-Daten";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void showThreadData(parsed);
    });
    findInsertionPoint(container).appendChild(button);
  }

  function renderThreadData(thread, record, uri) {
    const post = thread?.post;
    if (post?.uri !== uri) throw new Error("Post fehlt in der Thread-Antwort.");

    function referenceCell(reference) {
      if (!reference?.uri || !reference.cid) return "<td>—</td>";
      let comparison = "";
      if (reference.uri === uri && record.cid) {
        comparison = reference.cid === record.cid
          ? '<strong class="bsky-edit-detector-cid-match">Stimmt überein</strong>'
          : '<strong class="bsky-edit-detector-cid-mismatch">CID weicht ab</strong>';
      }
      return `<td><code>${escapeHtml(reference.uri)}</code><code>${escapeHtml(reference.cid)}</code>${comparison}</td>`;
    }

    function row(view, label) {
      const reply = view.record?.reply;
      return `<tr>
        <th scope="row">${escapeHtml(label)}<code>${escapeHtml(view.uri)}</code></th>
        <td class="bsky-edit-detector-thread-text">${escapeHtml(view.record?.text) || "—"}</td>
        <td><code>${escapeHtml(view.cid) || "—"}</code></td>
        ${referenceCell(reply?.parent)}
        ${referenceCell(reply?.root)}
      </tr>`;
    }

    const replies = Array.isArray(thread.replies) ? thread.replies.filter((reply) => reply?.post) : [];
    return `
      <p><strong>Aktuelle Record-CID</strong><code>${escapeHtml(record.cid) || "—"}</code></p>
      ${post.cid !== record.cid ? "<p>Thread-Ansicht und Record liefern unterschiedliche CIDs.</p>" : ""}
      <section aria-label="Verlauf der Post-Fassungen">
        <h3>Verlauf der Post-Fassungen</h3>
        <div class="bsky-edit-detector-thread-diagram">Diagramm wird geladen …</div>
      </section>
      <div class="bsky-edit-detector-thread-table-wrap" tabindex="0" role="region" aria-label="CID-Referenzen">
        <table class="bsky-edit-detector-thread-table">
          <caption>Post und direkte Antworten aus der öffentlichen Thread-Ansicht</caption>
          <thead><tr><th scope="col">Post</th><th scope="col" class="bsky-edit-detector-thread-text-heading">Text</th><th scope="col">CID in der Thread-Ansicht</th><th scope="col">Parent-Referenz</th><th scope="col">Root-Referenz</th></tr></thead>
          <tbody>
            ${row(post, "Ausgewählter Post")}
            ${replies.map(({ post: reply }) => row(reply, `Antwort von @${reply.author?.handle || "unbekannt"}`)).join("")}
          </tbody>
        </table>
      </div>
      ${replies.length ? "" : "<p>Keine direkten Antworten in der API-Antwort verfügbar.</p>"}
    `;
  }

  function diagramPostText(text) {
    if (typeof text !== "string" || !text.trim()) return "";
    return "<br/><br/>" + text.split(/\r?\n/).flatMap((line) => line.match(/.{1,56}(?:\s|$)|.{1,56}/gu) || [""])
      .map((line) => line.replace(/[&#"<>%`\\]/g, (character) => `#${character.charCodeAt(0)};`))
      .join("<br/>");
  }

  function threadDiagramSource(thread, record, uri) {
    const cid = typeof record.cid === "string" ? record.cid : "";
    const shortCid = (value) => value.replace(/[^a-z0-9]/gi, "").slice(0, 18);
    const dateFormat = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "medium" });
    const dateLabel = (timestamp, source) => Number.isFinite(timestamp)
      ? `${source} ${dateFormat.format(timestamp)}`
      : "Zeitpunkt unbekannt";
    const currentIndexedAt = thread.post?.cid === cid ? Date.parse(thread.post.indexedAt) : NaN;
    const currentTime = Number.isFinite(currentIndexedAt) ? currentIndexedAt : Date.parse(record.value?.createdAt);
    const currentDate = dateLabel(currentTime, Number.isFinite(currentIndexedAt) ? "Indexiert am" : "Record-Zeit");
    const timeline = [{
      id: "current",
      timestamp: currentTime,
      label: `Aktuelle Fassung<br/>${currentDate}<br/>CID ${shortCid(cid) || "unbekannt"}${diagramPostText(record.value?.text)}`,
    }];
    const replies = Array.isArray(thread.replies) ? thread.replies : [];

    for (const reply of replies) {
      const post = reply?.post;
      const parent = post?.record?.reply?.parent;
      if (parent?.uri !== uri || typeof parent.cid !== "string" || !parent.cid) continue;
      const handle = String(post.author?.handle || "").replace(/[^a-z0-9.-]/gi, "");
      const indexedAt = Date.parse(post.indexedAt);
      const timestamp = Number.isFinite(indexedAt) ? indexedAt : Date.parse(post.record.createdAt);
      const date = dateLabel(timestamp, Number.isFinite(indexedAt) ? "Indexiert am" : "Record-Zeit");
      timeline.push({
        id: `reply${timeline.length}`,
        timestamp,
        parentCid: parent.cid,
        label: `Antwort${handle ? `<br/>@${handle}` : ""}<br/>${date}<br/>Bezug auf CID ${shortCid(parent.cid)}${diagramPostText(post.record.text)}`,
      });
    }

    const order = (timestamp) => Number.isFinite(timestamp) ? timestamp : Infinity;
    timeline.sort((first, second) => order(first.timestamp) - order(second.timestamp));
    const versions = new Set();
    const lines = ["flowchart TB"];
    let previousId = "";
    for (const event of timeline) {
      if (event.parentCid && event.parentCid !== cid && !versions.has(event.parentCid)) {
        const versionId = `version${versions.size + 1}`;
        versions.add(event.parentCid);
        lines.push(`${versionId}["Referenzierte Fassung<br/>CID ${shortCid(event.parentCid)}<br/>Zeitpunkt unbekannt"]`);
        lines.push(`${versionId} -.->|referenziert von| ${event.id}`);
      }
      lines.push(`${event.id}["${event.label}"]`);
      if (previousId) lines.push(`${previousId} ${Number.isFinite(event.timestamp) ? "-->" : "-.->"} ${event.id}`);
      previousId = event.id;
    }
    return lines.join("\n");
  }

  async function renderThreadDiagram(target, thread, record, uri) {
    if (!target) return;
    const source = threadDiagramSource(thread, record, uri);
    const mermaid = globalThis.mermaid;
    try {
      if (!mermaid?.render) throw new Error("Mermaid fehlt im Content-Script.");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { wrappingWidth: 4096 },
        theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
      });
      const { svg } = await mermaid.render(
        `threadline-diagram-${crypto.randomUUID()}`,
        source,
        target
      );
      if (target.isConnected) target.innerHTML = svg;
    } catch (error) {
      console.debug("Bsky Edit Detector: Verlaufsdiagramm konnte nicht gerendert werden.", error);
      if (!target.isConnected) return;
      const message = document.createElement("p");
      message.textContent = mermaid?.render
        ? "Mermaid konnte dieses Diagramm nicht rendern."
        : "Mermaid wurde nicht geladen. Lade die Erweiterung und anschließend den Post-Tab neu.";
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Mermaid-Quelltext anzeigen";
      const reason = document.createElement("p");
      reason.textContent = String(error?.message || error);
      const code = document.createElement("pre");
      code.textContent = source;
      details.append(summary, reason, code);
      target.replaceChildren(message, details);
    }
  }

  async function showThreadData(parsed) {
    const dialog = document.createElement("dialog");
    dialog.className = "bsky-edit-detector-thread-dialog";
    dialog.setAttribute("aria-label", "Thread-Daten");
    dialog.innerHTML = `
      <form method="dialog" class="bsky-edit-detector-actions"><button autofocus>Schließen</button></form>
      <h2>Thread-Daten</h2>
      <p role="status">Thread-Daten werden geladen …</p>
      <div class="bsky-edit-detector-thread-content"></div>
    `;
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    // Mermaid looks up its temporary SVG inside document.body.
    document.body.appendChild(dialog);
    dialog.showModal();

    const status = dialog.querySelector('[role="status"]');
    try {
      const did = await resolveHandleToDid(parsed.actor);
      if (!did) throw new Error("Konto konnte nicht aufgelöst werden.");
      if (!dialog.open) return;
      const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
      const [thread, record] = await Promise.all([
        getPostThread(uri),
        xrpc("com.atproto.repo.getRecord", {
          repo: did,
          collection: "app.bsky.feed.post",
          rkey: parsed.rkey,
        }, AbortSignal.timeout(5000)),
      ]);
      if (!dialog.open) return;
      dialog.querySelector(".bsky-edit-detector-thread-content").innerHTML = renderThreadData(thread, record, uri);
      status.textContent = "";
      status.hidden = true;
      await renderThreadDiagram(dialog.querySelector(".bsky-edit-detector-thread-diagram"), thread, record, uri);
    } catch (error) {
      console.debug("Bsky Edit Detector: Thread-Daten konnten nicht geladen werden.", error);
      status.textContent = "Thread-Daten konnten nicht geladen werden. Schließe den Dialog und öffne ihn erneut.";
    }
  }

  /** Lädt die Post-Informationen und fügt Bearbeitungs- sowie Kontohinweise ein. @param {object} parsed Aufgelöste Post-URL. @param {Element|null} container Zugehöriger Post-Container. @returns {Promise<void>} Abschluss der Verarbeitung. */
  async function processPost(parsed, container) {
    addThreadDataButton(container, parsed);
    try {
      const info = await getPostEditInfo(parsed);
      if (info.isEdited) addBadge(container, info);
      addAccountSignals(container, info);
      await renderMutualStardust(container, info.actorDid, info.uri);
    } catch (error) {
      console.debug("Bsky Edit Detector:", error);
      addErrorMark(container);
    }
  }

  /** Verarbeitet einen Post-Link in einer Übersicht höchstens einmal. @param {HTMLAnchorElement} link Post-Link aus der Seite. @returns {Promise<void>} Abschluss der Verarbeitung. */
  async function processLink(link) {
    if (link.dataset.bskyEditDetectorChecked === "1") return;
    const parsed = parsePostUrl(link.href);
    if (!parsed) return;

    link.dataset.bskyEditDetectorChecked = "1";
    const container = findPostContainer(link);
    await processPost(parsed, container);
  }

  /** Findet auf einer einzelnen Postseite zuerst den Container des aktuellen Posts. @param {object} parsed Aufgelöste URL des geöffneten Posts. @returns {Element|null} Passender Container oder null, solange die Seite noch lädt. */
  function findCurrentPostContainer(parsed) {
    const links = document.querySelectorAll(POST_LINK_SELECTOR);
    for (const link of links) {
      const candidate = parsePostUrl(link.href);
      if (!candidate) continue;
      if (candidate.actor === parsed.actor && candidate.rkey === parsed.rkey) {
        return findPostContainer(link);
      }
    }

    return document.querySelector('[data-testid="feedItem"], article, [role="article"]');
  }

  /** Verarbeitet den in der Adressleiste geöffneten Post, auch ohne Feed-Link. Keine Parameter. @returns {void} */
  function processCurrentPostPage() {
    const parsed = parsePostUrl(location.href);
    if (!parsed) return;

    const container = findCurrentPostContainer(parsed);
    if (!container) return;
    const key = `${parsed.actor}/${parsed.rkey}`;
    if (container.dataset.bskyEditDetectorCurrentPost === key) return;

    container.dataset.bskyEditDetectorCurrentPost = key;
    void processPost(parsed, container);
  }

  /** Durchsucht Feed-Links und verarbeitet zusätzlich den direkt geöffneten Post. Keine Parameter. @returns {void} */
  function scanPage() {
    const links = document.querySelectorAll(POST_LINK_SELECTOR);
    for (const link of links) processLink(link);
    processCurrentPostPage();
  }

  /** Entfernt beim Wiederherstellen einer Verlaufsseite alte Dekorationsflächen und startet die Erkennung erneut. Keine Parameter. @returns {void} */
  function refreshAfterHistoryNavigation() {
    refreshMutualStardust();
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pageshow", refreshAfterHistoryNavigation);
  window.addEventListener("popstate", refreshAfterHistoryNavigation);

  const extensionChrome = globalThis.chrome;
  let threadDataSettingChanged = false;
  if (extensionChrome?.storage?.onChanged) {
    extensionChrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      if (changes[THREAD_DATA_BUTTON_SETTING]) {
        threadDataSettingChanged = true;
        document.documentElement.toggleAttribute(
          "data-bsky-edit-detector-hide-thread-data",
          changes[THREAD_DATA_BUTTON_SETTING].newValue === false
        );
      }
      const hasEnabledChange = Boolean(changes[MUTUAL_STARDUST_SETTING]);
      const hasCountChange = Boolean(changes[MUTUAL_STARDUST_COUNT_SETTING]);
      const hasThemeChange = Boolean(changes[MUTUAL_STARDUST_THEME_SETTING]);
      if (!hasEnabledChange && !hasCountChange && !hasThemeChange) return;
      refreshMutualStardust();
    });
  }
  if (extensionChrome?.storage?.sync) {
    extensionChrome.storage.sync.get({ [THREAD_DATA_BUTTON_SETTING]: true }).then((settings) => {
      if (threadDataSettingChanged) return;
      document.documentElement.toggleAttribute(
        "data-bsky-edit-detector-hide-thread-data",
        settings[THREAD_DATA_BUTTON_SETTING] === false
      );
    }).catch(() => {});
  }

  scanPage();
})();
