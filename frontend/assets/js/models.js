/* Oddvark – model library. Browse/filter/download Ollama models.
   The catalog comes from window.MODELS_CATALOG (included via <script src>, no fetch).
   Installed models are detected live via OLLAMA/api/tags.
   Downloads run through OLLAMA/api/pull (NDJSON streaming) – exactly like in jarvis.js. */
(function () {
  "use strict";

  // IMPORTANT: deliberately 127.0.0.1 instead of localhost. Chrome allows only 6 concurrent
  // HTTP/1.1 connections PER HOSTNAME, shared across ALL tabs. Ongoing downloads/
  // benchmarks on this page would otherwise lock out the chat tab (app.js uses localhost:11434)
  // – its connect() would then hang forever in "Connecting …".
  // 127.0.0.1 and localhost get separate connection pools -> no contention.
  const OLLAMA = "http://127.0.0.1:11434";

  // --- i18n (self-contained; no window.JV_I18N) --------------------------------
  // Read the language ONCE at startup (no live toggle on this page).
  const _lng = (function () {
    try { return localStorage.getItem("jarvis.lang") === "de" ? "de" : "en"; }
    catch (e) { return "en"; }
  })();

  const I18N = {
    en: {
      back: "Back",
      models: "Models",
      ollamaNotice: "Ollama is not reachable – downloads and the “Installed” status require a running Ollama at {url}.",
      searchPlaceholder: "Search models …",
      sort: "Sort",
      sortPopularity: "Popularity",
      sortName: "Name (A–Z)",
      sortUpdated: "Recently updated",
      installed: "Installed",
      chooseSize: "Choose size",
      copy: "Copy",
      copied: "Copied",
      copyCommand: "Copy command",
      setActive: "Set as active model",
      downloadFirst: "Download first",
      download: "Download",
      dlSize: "Download {size}",
      downloads: "downloads",
      updatedAgo: "{v} ago",
      countModels: "{n} of {m} models",
      countLive: "{n}+ models",
      countDone: "{n} models",
      sizeUnknown: "Size unknown",
      estimate: "≈ {dl} GB · RAM ≈ {ram} GB (estimated)",
      noResults: "No results",
      noResultsSub: "Try a different search term or remove active filters.",
      starting: "Starting …",
      stManifest: "Manifest …",
      stChecking: "Checking …",
      stWriting: "Writing …",
      stDone: "Done",
      stDownloading: "Downloading …",
      stQueued: "Queued …",
      error: "Error",
      dlFailed: "Download failed: {msg}",
      retry: "Retry",
      scanBtn: "Scan my PC",
      scanTitle: "Your PC",
      scanning: "Reading hardware …",
      scanFailed: "Scan failed – is the action server (port 7864) running?",
      scanRecTitle: "Recommended for your hardware",
      scanRecNone: "No matching models found for this hardware.",
      scanClose: "Close",
      fitGpu: "fits in VRAM",
      fitRam: "runs on RAM/CPU",
      fitNo: "too big",
      catGeneral: "General",
      catCoding: "Coding",
      catReasoning: "Reasoning",
      catVision: "Vision",
      catEmbedding: "Embedding",
      benchStart: "Start deep benchmark",
      benchHint: "Measures real tokens/s of your installed models – can take a while depending on model count.",
      benchNeedsOllama: "Requires running Ollama with at least one installed model.",
      benchCancel: "Cancel",
      benchDone: "Benchmark finished.",
      benchWaitPulls: "Please wait until all downloads have finished – measuring under load gives wrong results.",
      benchLoad: "load {s}s",
      benchTps: "{v} tok/s",
      benchEst: "≈ {v} tok/s",
      showCard: "Show card",
    },
    de: {
      back: "Zurück",
      models: "Modelle",
      ollamaNotice: "Ollama ist nicht erreichbar – Downloads und der „Installiert“-Status benötigen ein laufendes Ollama unter {url}.",
      searchPlaceholder: "Modelle durchsuchen …",
      sort: "Sortieren",
      sortPopularity: "Beliebtheit",
      sortName: "Name (A–Z)",
      sortUpdated: "Zuletzt aktualisiert",
      installed: "Installiert",
      chooseSize: "Größe wählen",
      copy: "Kopieren",
      copied: "Kopiert",
      copyCommand: "Befehl kopieren",
      setActive: "Als aktives Modell setzen",
      downloadFirst: "Erst herunterladen",
      download: "Laden",
      dlSize: "{size} laden",
      downloads: "Downloads",
      updatedAgo: "vor {v}",
      countModels: "{n} von {m} Modellen",
      countLive: "{n}+ Modelle",
      countDone: "{n} Modelle",
      sizeUnknown: "Größe unbekannt",
      estimate: "≈ {dl} GB · RAM ≈ {ram} GB (geschätzt)",
      noResults: "Keine Treffer",
      noResultsSub: "Versuche einen anderen Suchbegriff oder entferne aktive Filter.",
      starting: "Starte …",
      stManifest: "Manifest …",
      stChecking: "Prüfe …",
      stWriting: "Schreibe …",
      stDone: "Fertig",
      stDownloading: "Lade …",
      stQueued: "Wartet …",
      error: "Fehler",
      dlFailed: "Laden fehlgeschlagen: {msg}",
      retry: "Erneut",
      scanBtn: "PC scannen",
      scanTitle: "Dein PC",
      scanning: "Hardware wird gelesen …",
      scanFailed: "Scan fehlgeschlagen – läuft der Aktions-Server (Port 7864)?",
      scanRecTitle: "Empfohlen für deine Hardware",
      scanRecNone: "Keine passenden Modelle für diese Hardware gefunden.",
      scanClose: "Schließen",
      fitGpu: "passt in VRAM",
      fitRam: "läuft über RAM/CPU",
      fitNo: "zu groß",
      catGeneral: "Allgemein",
      catCoding: "Coding",
      catReasoning: "Reasoning",
      catVision: "Vision",
      catEmbedding: "Embedding",
      benchStart: "Tiefen-Benchmark starten",
      benchHint: "Misst echte tokens/s deiner installierten Modelle – kann je nach Modellzahl eine Weile dauern.",
      benchNeedsOllama: "Benötigt laufendes Ollama mit mindestens einem installierten Modell.",
      benchCancel: "Abbrechen",
      benchDone: "Benchmark abgeschlossen.",
      benchWaitPulls: "Bitte warten, bis alle Downloads fertig sind – Messen unter Last liefert falsche Werte.",
      benchLoad: "Laden {s}s",
      benchTps: "{v} tok/s",
      benchEst: "≈ {v} tok/s",
      showCard: "Zur Karte",
    },
  };

  function t(key, subs) {
    const map = I18N[_lng] || I18N.en;
    let s = (map[key] != null) ? map[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return (subs && subs[k] != null) ? subs[k] : m;
    });
  }

  // --- Read the catalog robustly -----------------------------------------------
  const CATALOG = (window.MODELS_CATALOG && Array.isArray(window.MODELS_CATALOG.models))
    ? window.MODELS_CATALOG.models
    : [];

  // The actual "entire library" (~tens of thousands of models) are the GGUF repos on
  // HuggingFace – Ollama runs each one directly via `ollama run hf.co/<repo>`. The local
  // proxy paginates them cursor-based and delivers them as compact JSON. Nothing is
  // bundled: the bundled catalog appears immediately/offline, the rest streams on scroll.
  const LIBRARY = "http://127.0.0.1:7863/hf_library";
  const catalogNames = new Set(CATALOG.map(function (m) { return m.name; }));
  const remoteByName = new Map();   // lazily loaded library models: name -> model (for card lookups)
  const shownNames = new Set();     // names already rendered (dedup bundled + remote)
  const lib = { cursor: "", done: false, loading: false, io: null, token: 0, pages: 0 };
  let renderIndex = 0;
  function findModel(name) { return CATALOG.find(function (m) { return m.name === name; }) || remoteByName.get(name) || null; }

  const root = document.getElementById("models-app");
  if (!root) return;

  // --- State -------------------------------------------------------------------
  const state = {
    query: "",                 // search text (lowercase)
    caps: new Set(),           // active capability filters (tools/vision/embedding/thinking)
    installedOnly: false,      // "Installed" chip
    sort: "pulls",             // pulls | name | updated
    ollamaOk: false,           // is Ollama reachable?
    installedNames: new Set(), // base names before ":" (e.g. "llama3.2")
    installedTags: new Set(),  // full tags (e.g. "llama3.2:1b")
  };

  // Available capabilities as filter chips (fixed, sensible selection)
  const CAP_FILTERS = ["tools", "vision", "embedding", "thinking"];

  // Ongoing pull operations, so the same chip doesn't start twice.
  // Key: full tag "name:size". Value: true.
  const activePulls = new Set();

  // Per model (name), the selected size and active tab ("ollama" | "jarvis").
  // Survives re-rendering a card within the same filter pass.
  // Key: model.name.
  const cardSize = new Map(); // name -> size (or "" if the model has no fixed sizes)
  const cardTab = new Map();  // name -> "ollama" | "jarvis"

  // --- small SVG icon helper (no emoji) ---------------------------------------
  function icon(name) {
    // HugeIcons Free (MIT) via window.HI (assets/js/hugeicons.js); 'users' was dropped (unused).
    const MAP = { back: "back", search: "search", download: "download", check: "check", down: "downSmall", clock: "clock", info: "info", empty: "searchEmpty", copy: "copy", terminal: "terminal", spark: "sparkle" };
    return HI(MAP[name] || name, { cls: "mdl-ico" });
  }

  // --- Parser ------------------------------------------------------------------

  // "116.5M" / "1.2K" / "8,984" -> number (for sorting by pulls)
  function parsePulls(s) {
    if (!s) return 0;
    const t = String(s).trim().replace(/,/g, "");
    const m = t.match(/^([0-9.]+)\s*([KMB])?/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const unit = (m[2] || "").toUpperCase();
    if (unit === "K") n *= 1e3;
    else if (unit === "M") n *= 1e6;
    else if (unit === "B") n *= 1e9;
    return n;
  }

  // Parameter count from a size token: "8b"->8, "1.5b"->1.5, "405b"->405. Otherwise null.
  function parseParams(size) {
    if (!size) return null;
    const m = String(size).match(/([0-9.]+)\s*b/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return isFinite(n) ? n : null;
  }

  // Estimate download/RAM from the parameter count (Q4_K_M approximation).
  // Returns null when no number is parseable (e.g. "8x7b", "e2b").
  function estimate(size) {
    const n = parseParams(size);
    if (n === null) return null;
    const downloadGB = Math.round(n * 0.62 * 10) / 10; // one decimal place
    const ramGB = Math.ceil(downloadGB + 1.5);
    return { downloadGB: downloadGB, ramGB: ramGB };
  }

  // Display text for a size's requirements.
  function reqText(size) {
    const e = estimate(size);
    if (!e) return t("sizeUnknown");
    return t("estimate", { dl: e.downloadGB, ram: e.ramGB });
  }

  // --- Installed status ---------------------------------------------------------

  // A catalog entry counts as installed when a tag exists
  // whose part before ":" === model.name.
  function isModelInstalled(model) {
    return state.installedNames.has(model.name);
  }
  // A concrete size counts as installed when the tag "name:size" exists.
  function isSizeInstalled(model, size) {
    return state.installedTags.has(model.name + ":" + size);
  }

  // Load live – catch connection errors robustly (the page also runs without Ollama).
  async function loadInstalled() {
    state.installedNames.clear();
    state.installedTags.clear();
    try {
      const r = await fetch(OLLAMA + "/api/tags");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const tags = (j && Array.isArray(j.models)) ? j.models : [];
      tags.forEach(function (m) {
        const full = (m && m.name) ? String(m.name) : "";
        if (!full) return;
        const base = full.split(":")[0];
        state.installedNames.add(base);
        state.installedTags.add(full);
      });
      state.ollamaOk = true;
    } catch (err) {
      // No Ollama -> no installed markers, just the notice at the top.
      state.ollamaOk = false;
    }
  }

  // --- Filter + sorting --------------------------------------------------------
  function filtered() {
    const q = state.query;
    let list = CATALOG.filter(function (m) {
      // Search over name + description (case-insensitive)
      if (q) {
        const hay = (m.name + " " + (m.description || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      // Capability filter (all selected must be present)
      if (state.caps.size) {
        const caps = m.capabilities || [];
        for (const c of state.caps) {
          if (caps.indexOf(c) < 0) return false;
        }
      }
      // Installed only
      if (state.installedOnly && !isModelInstalled(m)) return false;
      return true;
    });

    if (state.sort === "name") {
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (state.sort === "updated") {
      // rough "newest first" sort via age estimate
      list.sort(function (a, b) { return ageScore(a.updated) - ageScore(b.updated); });
    } else {
      // Default: pulls descending
      list.sort(function (a, b) { return parsePulls(b.pulls) - parsePulls(a.pulls); });
    }
    return list;
  }

  // Rough age in days from "1 year ago" / "3 weeks ago" / "21 hours ago".
  function ageScore(s) {
    if (!s) return 1e9;
    const m = String(s).match(/([0-9.]+)\s*(hour|day|week|month|year)/i);
    if (!m) return 1e9;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const mult = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[unit] || 1;
    return n * mult;
  }

  // --- Rendering ----------------------------------------------------------------

  // Build the static shell once.
  function buildShell() {
    root.innerHTML =
      '<header class="mdl-header">' +
        '<div class="mdl-header-top">' +
          '<a class="mdl-back" id="mdl-back" href="index.html">' + icon("back") + "<span>" + t("back") + "</span></a>" +
          '<h1 class="mdl-title">' + t("models") + "</h1>" +
          '<span class="mdl-count" id="mdl-count"></span>' +
        "</div>" +
        '<div class="mdl-notice" id="mdl-notice" hidden>' + icon("info") +
          "<span>" + t("ollamaNotice", { url: OLLAMA }) + "</span>" +
        "</div>" +
        '<div class="mdl-controls">' +
          '<label class="mdl-search">' + icon("search") +
            '<input id="mdl-search" type="search" placeholder="' + escAttr(t("searchPlaceholder")) + '" autocomplete="off" spellcheck="false" />' +
          "</label>" +
          '<div class="mdl-chips" id="mdl-chips">' + buildChips() + "</div>" +
          '<div class="mdl-sort">' + t("sort") +
            '<button class="mdl-sort-trigger" id="mdl-sort" type="button" aria-haspopup="listbox" aria-expanded="false">' +
              '<span id="mdl-sort-label">' + t("sortPopularity") + "</span>" +
              '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="mdl-sort-caret" width="12" height="12"><path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>' +
            "</button>" +
          "</div>" +
          '<button type="button" class="mdl-scan" id="mdl-scan">' + HI("zap", { cls: "mdl-ico" }) +
            "<span>" + t("scanBtn") + "</span>" +
          "</button>" +
        "</div>" +
      "</header>" +
      '<section class="mdl-scanpanel" id="mdl-scanpanel" hidden></section>' +
      '<main class="mdl-grid" id="mdl-grid"></main>';

    // Back button: explicitly via JS (requirement), the link stays as a fallback.
    document.getElementById("mdl-back").addEventListener("click", function (e) {
      e.preventDefault();
      window.location.href = "index.html";
    });

    const search = document.getElementById("mdl-search");
    let searchTimer = 0;
    search.addEventListener("input", function () {
      state.query = search.value.trim().toLowerCase();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderGrid, 280); // debounced: don't query the library on every keystroke
    });

    // Sorting: custom dropdown (no native <select> – project-wide only custom popups).
    (function initSortDropdown() {
      const SORT = [
        { v: "pulls", label: t("sortPopularity") },
        { v: "name", label: t("sortName") },
        { v: "updated", label: t("sortUpdated") },
      ];
      const trig = document.getElementById("mdl-sort");
      const lbl = document.getElementById("mdl-sort-label");
      let panel = null, open = false;
      function setLabel() { const o = SORT.find(function (x) { return x.v === state.sort; }); lbl.textContent = o ? o.label : SORT[0].label; }
      function onDoc(e) { if (!panel) return; if (panel.contains(e.target) || trig.contains(e.target)) return; close(); }
      function close() { if (panel) panel.setAttribute("data-open", "false"); open = false; trig.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", onDoc, true); }
      function mark() { panel.querySelectorAll(".mdl-sort-item").forEach(function (it) { it.setAttribute("aria-checked", String(it._v === state.sort)); }); }
      function build() {
        panel = document.createElement("div"); panel.className = "mdl-sort-menu"; panel.setAttribute("role", "listbox");
        SORT.forEach(function (o) {
          const it = document.createElement("button"); it.type = "button"; it.className = "mdl-sort-item"; it.setAttribute("role", "menuitemradio");
          it.innerHTML = "<span>" + o.label + '</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="mdl-sort-check" width="14" height="14"><path d="M5 14L8.5 17.5L19 6.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>';
          it._v = o.v;
          it.addEventListener("click", function () { state.sort = o.v; setLabel(); mark(); renderGrid(); close(); });
          panel.appendChild(it);
        });
        document.body.appendChild(panel);
      }
      function position() { const r = trig.getBoundingClientRect(); panel.style.left = r.left + "px"; panel.style.top = (r.bottom + 4) + "px"; panel.style.minWidth = r.width + "px"; }
      function openMenu() { if (!panel) build(); mark(); position(); panel.setAttribute("data-open", "true"); open = true; trig.setAttribute("aria-expanded", "true"); setTimeout(function () { document.addEventListener("mousedown", onDoc, true); }, 0); }
      trig.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open ? close() : openMenu(); });
      window.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) close(); });
      setLabel();
    })();

    // Chip clicks (capabilities + "Installed") delegated.
    document.getElementById("mdl-chips").addEventListener("click", function (e) {
      const chip = e.target.closest(".mdl-chip");
      if (!chip) return;
      const cap = chip.dataset.cap;
      if (cap === "__installed") {
        state.installedOnly = !state.installedOnly;
        chip.setAttribute("aria-pressed", String(state.installedOnly));
      } else if (cap) {
        if (state.caps.has(cap)) state.caps.delete(cap);
        else state.caps.add(cap);
        chip.setAttribute("aria-pressed", String(state.caps.has(cap)));
      }
      renderGrid();
    });

    // "Scan my PC": read hardware + show recommendations (panel toggles).
    document.getElementById("mdl-scan").addEventListener("click", runScan);
    wireScanPanel();
  }

  const CAP_LABEL = {
    tools: "Tools",
    vision: "Vision",
    embedding: "Embedding",
    thinking: "Thinking",
    audio: "Audio",
  };

  function buildChips() {
    let html = "";
    CAP_FILTERS.forEach(function (c) {
      html +=
        '<button type="button" class="mdl-chip" data-cap="' + c + '" aria-pressed="false">' +
          '<span class="mdl-dot"></span>' + (CAP_LABEL[c] || c) +
        "</button>";
    });
    html +=
      '<button type="button" class="mdl-chip" data-cap="__installed" aria-pressed="false">' +
        t("installed") +
      "</button>";
    return html;
  }

  // Determine a card's currently selected size (default = first size).
  // Empty string if the model has no fixed sizes.
  function getSelectedSize(model) {
    const list = model.sizes || [];
    if (cardSize.has(model.name)) {
      const s = cardSize.get(model.name);
      // If the remembered size no longer exists, fall back to the default.
      if (s === "" || list.indexOf(s) >= 0) return s;
    }
    return list.length ? list[0] : "";
  }

  // A card's active tab ("ollama" default).
  function getTab(model) {
    return cardTab.get(model.name) === "jarvis" ? "jarvis" : "ollama";
  }

  // Full tag/token for the selected size.  name + (size? ":"+size : "")
  function tokenFor(model, size) {
    return size ? model.name + ":" + size : model.name;
  }

  // Size chips (selectable). An installed size gets a checkmark.
  function sizeChipsHTML(model) {
    const list = model.sizes || [];
    if (!list.length) return "";
    const selected = getSelectedSize(model);
    let html = '<div class="mdl-chips-sizes" role="group" aria-label="' + escAttr(t("chooseSize")) + '">';
    list.forEach(function (size) {
      const isSel = size === selected;
      const inst = isSizeInstalled(model, size);
      html +=
        '<button type="button" class="mdl-size-chip' + (inst ? " is-installed" : "") + '" ' +
          'data-size-chip="' + escAttr(size) + '" ' +
          'aria-pressed="' + (isSel ? "true" : "false") + '">' +
          escHtml(size) +
          (inst ? icon("check") : "") +
        "</button>";
    });
    html += "</div>";
    return html;
  }

  // Content of the action box (tab-dependent). Also re-rendered in isolation
  // when the tab or size changes.
  function actionInnerHTML(model) {
    const tab = getTab(model);
    const size = getSelectedSize(model);
    const token = tokenFor(model, size);

    if (tab === "ollama") {
      const cmd = "ollama run " + token;
      return (
        '<div class="mdl-cmd">' +
          '<span class="mdl-cmd-prompt">' + icon("terminal") + "</span>" +
          '<code class="mdl-cmd-text">' + escHtml(cmd) + "</code>" +
          '<button type="button" class="mdl-copy" data-copy="' + escAttr(cmd) + '" ' +
            'aria-label="' + escAttr(t("copyCommand")) + '">' +
            icon("copy") + '<span class="mdl-copy-label">' + t("copy") + "</span>" +
          "</button>" +
        "</div>"
      );
    }

    // "In Oddvark" tab
    const tokenInstalled = size
      ? isSizeInstalled(model, size)
      : isModelInstalled(model);

    if (tokenInstalled) {
      return (
        '<button type="button" class="mdl-set" data-set="' + escAttr(token) + '">' +
          icon("spark") + t("setActive") +
        "</button>"
      );
    }
    return (
      '<button type="button" class="mdl-set" data-set="' + escAttr(token) + '" disabled>' +
        icon("spark") + t("setActive") +
      "</button>" +
      '<span class="mdl-set-hint">' + icon("info") + t("downloadFirst") +
        (size ? " (" + escHtml(size) + ")" : "") + "</span>"
    );
  }

  // Loading/status row for the SELECTED size (keeps the download).
  function dlRowHTML(model) {
    const size = getSelectedSize(model);
    const installed = size ? isSizeInstalled(model, size) : isModelInstalled(model);
    const token = tokenFor(model, size);

    if (installed) {
      return '<span class="mdl-size-installed mdl-dl-row-state">' + icon("check") + t("installed") + "</span>";
    }
    if (!size && !(model.sizes || []).length) {
      // Model without fixed sizes -> downloadable by name.
      return (
        '<button type="button" class="mdl-dl" data-tag="' + escAttr(token) + '" data-state="idle">' +
          '<span class="mdl-dl-fill"></span>' + icon("download") +
          '<span class="mdl-dl-label">' + t("download") + "</span>" +
        "</button>"
      );
    }
    return (
      '<button type="button" class="mdl-dl" data-tag="' + escAttr(token) + '" data-state="idle">' +
        '<span class="mdl-dl-fill"></span>' + icon("download") +
        '<span class="mdl-dl-label">' + t("dlSize", { size: escHtml(size) }) + "</span>" +
      "</button>"
    );
  }

  // Complete action section (tabs + box + loading row). Its own block,
  // so tab/size changes only re-render this part.
  function actionSectionHTML(model) {
    const tab = getTab(model);
    return (
      '<div class="mdl-action" data-name="' + escAttr(model.name) + '">' +
        '<div class="mdl-tabs" role="tablist" data-tab="' + tab + '">' +
          '<span class="mdl-tab-glider" aria-hidden="true"></span>' +
          '<button type="button" class="mdl-tab" role="tab" data-tab-key="ollama" ' +
            'aria-selected="' + (tab === "ollama" ? "true" : "false") + '">Ollama</button>' +
          '<button type="button" class="mdl-tab" role="tab" data-tab-key="jarvis" ' +
            'aria-selected="' + (tab === "jarvis" ? "true" : "false") + '">In Oddvark</button>' +
        "</div>" +
        '<div class="mdl-action-box">' + actionInnerHTML(model) + "</div>" +
        '<div class="mdl-dl-row">' + dlRowHTML(model) + "</div>" +
      "</div>"
    );
  }

  // A card as an HTML string. data-name on the root element for later access.
  function cardHTML(model, index) {
    const installed = isModelInstalled(model);

    // Capability badges + size chips
    let badges = "";
    if (model.source === "huggingface") {
      badges += '<span class="mdl-badge mdl-badge-hf">Hugging Face</span>';
    }
    (model.capabilities || []).forEach(function (c) {
      badges += '<span class="mdl-badge" data-cap="' + c + '">' + (CAP_LABEL[c] || c) + "</span>";
    });
    if (installed) {
      badges += '<span class="mdl-badge is-installed">' + icon("check") + t("installed") + "</span>";
    }

    const chips = sizeChipsHTML(model);

    const pulls = model.pulls ? escHtml(String(model.pulls)) : "–";
    const updated = model.updated ? t("updatedAgo", { v: escHtml(String(model.updated).replace(/\s*ago$/i, "")) }) : "–";

    return (
      '<article class="mdl-card" data-name="' + escAttr(model.name) + '" style="--i:' + Math.min(index, 24) + '">' +
        '<div class="mdl-body">' +
          '<div class="mdl-card-head">' +
            '<h2 class="mdl-card-name">' + escHtml(model.label || model.name) + "</h2>" +
          "</div>" +
          '<div class="mdl-meta">' +
            "<span>" + icon("down") + pulls + " " + t("downloads") + "</span>" +
            "<span>" + icon("clock") + updated + "</span>" +
          "</div>" +
          '<p class="mdl-desc">' + escHtml(model.description || "") + "</p>" +
          (badges || chips
            ? '<div class="mdl-badges">' + badges + chips + "</div>"
            : "") +
          actionSectionHTML(model) +
        "</div>" +
      "</article>"
    );
  }

  // Redraw a card's action section in isolation (after tab/size change
  // or after a successful download). Only changes tabs/box/loading row.
  function rerenderAction(card) {
    if (!card) return;
    const name = card.getAttribute("data-name");
    const model = findModel(name);
    if (!model) return;

    const action = card.querySelector(".mdl-action");
    if (action) action.outerHTML = actionSectionHTML(model);

    // Size chips reflect the current selection/installed status.
    const chipsWrap = card.querySelector(".mdl-chips-sizes");
    if (chipsWrap) chipsWrap.outerHTML = sizeChipsHTML(model);
  }

  function emptyStateHTML() {
    return '<div class="mdl-empty">' + icon("empty") +
      '<div class="mdl-empty-title">' + t("noResults") + "</div>" +
      '<div class="mdl-empty-sub">' + t("noResultsSub") + "</div></div>";
  }
  function updateCount() {
    const el = document.getElementById("mdl-count");
    if (!el) return;
    el.textContent = t(lib.done ? "countDone" : "countLive", { n: shownNames.size });
  }
  // Card HTML for a batch: dedup (bundled+remote) + active capability/installed filters,
  // register remote models for later card lookups.
  function cardBatchHTML(models) {
    let html = "";
    models.forEach(function (m) {
      if (!m || !m.name || shownNames.has(m.name)) return;
      if (state.caps.size) { const caps = m.capabilities || []; for (const c of state.caps) if (caps.indexOf(c) < 0) return; }
      if (state.installedOnly && !isModelInstalled(m)) return;
      shownNames.add(m.name);
      if (!catalogNames.has(m.name)) remoteByName.set(m.name, m);
      html += cardHTML(m, renderIndex++);
    });
    return html;
  }
  function renderGrid() {
    const grid = document.getElementById("mdl-grid");
    if (!grid) return;
    shownNames.clear(); renderIndex = 0;
    lib.cursor = ""; lib.pages = 0; lib.done = false; lib.loading = false; lib.token++;
    if (lib.io) { lib.io.disconnect(); lib.io = null; }

    const notice = document.getElementById("mdl-notice");
    if (notice) notice.hidden = state.ollamaOk;

    const html = cardBatchHTML(filtered());
    // Only stream the full library when NOT "installed only" (that is a purely local view).
    const stream = !state.installedOnly;
    grid.innerHTML = html + (stream
      ? '<div id="mdl-sentinel" class="mdl-sentinel" aria-hidden="true"></div>' +
        '<div id="mdl-more" class="mdl-more" aria-hidden="true"><i></i><i></i><i></i></div>'
      : "");
    updateCount();

    if (stream) {
      const sentinel = document.getElementById("mdl-sentinel");
      lib.io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) loadMoreLib();
      }, { rootMargin: "800px 0px" });
      lib.io.observe(sentinel);
    } else if (!shownNames.size) {
      grid.innerHTML = emptyStateHTML();
    }
  }
  // Fetch the next library page from the local proxy and append it before the sentinel (infinite scroll).
  // HF paginates cursor-based: the proxy returns `next` (an opaque cursor) that we pass back.
  async function loadMoreLib() {
    if (lib.loading || lib.done) return;
    lib.loading = true;
    const more = document.getElementById("mdl-more");
    if (more) more.classList.add("is-loading");
    const token = lib.token;
    let data = null;
    try {
      const url = LIBRARY + "?q=" + encodeURIComponent(state.query) +
        (lib.cursor ? "&cursor=" + encodeURIComponent(lib.cursor) : "");
      const r = await fetch(url);
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (token !== lib.token) return;   // query/filter has changed -> discard the result
    lib.loading = false;
    const moreEl = document.getElementById("mdl-more");
    if (moreEl) moreEl.classList.remove("is-loading");
    if (!data || !Array.isArray(data.models)) { lib.done = true; }
    else {
      lib.pages++;
      lib.cursor = data.next || "";
      // No further cursor -> last page. Safety net against an infinite loop on "only duplicates".
      if (!lib.cursor || lib.pages >= 600) lib.done = true;
      const batch = cardBatchHTML(data.models);
      const sentinel = document.getElementById("mdl-sentinel");
      if (batch && sentinel) sentinel.insertAdjacentHTML("beforebegin", batch);
      updateCount();
      // Re-observe the sentinel -> if it's still visible (short page), the next page loads by itself.
      if (!lib.done && lib.io && sentinel) { lib.io.unobserve(sentinel); lib.io.observe(sentinel); }
    }
    if (lib.done) {
      const s = document.getElementById("mdl-sentinel");
      const m = document.getElementById("mdl-more");
      if (lib.io) { lib.io.disconnect(); lib.io = null; }
      if (s) s.remove();
      if (m) m.remove();
      if (!shownNames.size) grid0().innerHTML = emptyStateHTML();
    }
  }
  function grid0() { return document.getElementById("mdl-grid") || document.createElement("div"); }

  // --- Download (real) ----------------------------------------------------------
  // POST OLLAMA/api/pull, stream NDJSON – exactly like pullModel() in jarvis.js.
  // Updates exactly the chip with the matching data-tag (several possible in parallel).
  // Max 4 concurrent pull streams: leaves room in the browser's 6-connection budget
  // for /api/tags & benchmark and keeps the bandwidth per download usable.
  const PULL_MAX = 4;
  let runningPulls = 0;
  const pullQueue = []; // resolvers of waiting downloads (FIFO)

  async function startPull(tag, btn) {
    if (activePulls.has(tag)) return;
    activePulls.add(tag);

    const fill = btn.querySelector(".mdl-dl-fill");
    const label = btn.querySelector(".mdl-dl-label");
    btn.dataset.state = "busy";
    setProgress(fill, label, 0, t("starting"));

    if (runningPulls >= PULL_MAX) {
      setProgress(fill, label, null, t("stQueued"));
      await new Promise(function (res) { pullQueue.push(res); });
      setProgress(fill, label, 0, t("starting"));
    }
    runningPulls++;

    try {
      const res = await fetch(OLLAMA + "/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: tag, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let done = false;

      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let o;
          try { o = JSON.parse(line); } catch (e) { continue; }
          if (o.error) throw new Error(o.error);
          if (o.status) {
            // Percent from completed/total, otherwise status text.
            if (o.completed && o.total) {
              const pct = Math.round((o.completed / o.total) * 100);
              setProgress(fill, label, pct, pct + "%");
            } else {
              setProgress(fill, label, null, shortStatus(o.status));
            }
            if (o.status === "success") done = true;
          }
        }
      }

      // Success -> mark the size as installed.
      state.installedTags.add(tag);
      state.installedNames.add(tag.split(":")[0]);
      markInstalled(btn, tag);
    } catch (err) {
      btn.dataset.state = "error";
      if (fill) fill.style.width = "0%";
      if (label) label.textContent = t("error");
      btn.title = t("dlFailed", { msg: (err && err.message ? err.message : err) });
      // Make it clickable again after a short while (a retry is possible).
      setTimeout(function () {
        if (btn.dataset.state === "error") {
          btn.dataset.state = "idle";
          if (label) label.textContent = t("retry");
          btn.title = "";
        }
      }, 4000);
    } finally {
      activePulls.delete(tag);
      runningPulls--;
      const next = pullQueue.shift();
      if (next) next(); // start the next waiting download
    }
  }

  // Set the status display on the size button.
  function setProgress(fill, label, pct, text) {
    if (fill) fill.style.width = (pct === null ? 8 : pct) + "%";
    if (label) label.textContent = text;
  }

  // Shorten/localize Ollama status texts a bit.
  function shortStatus(s) {
    if (!s) return "…";
    if (/pulling manifest/i.test(s)) return t("stManifest");
    if (/verifying/i.test(s)) return t("stChecking");
    if (/writing|extracting/i.test(s)) return t("stWriting");
    if (/success/i.test(s)) return t("stDone");
    if (/pulling/i.test(s)) return t("stDownloading");
    return s.length > 14 ? s.slice(0, 13) + "…" : s;
  }

  // After a successful pull: update the card (size chips, action box,
  // loading row) and add the "Installed" header badge.
  function markInstalled(btn, tag) {
    const card = btn.closest(".mdl-card");
    if (card) {
      rerenderAction(card);
      // Add the "Installed" header badge (if not already present).
      if (!card.querySelector(".mdl-badge.is-installed")) {
        const badges = card.querySelector(".mdl-badges");
        if (badges) {
          const b = document.createElement("span");
          b.className = "mdl-badge is-installed";
          b.innerHTML = icon("check") + t("installed");
          // Insert before the size chips so badges/chips stay separated.
          const firstChip = badges.querySelector(".mdl-chips-sizes");
          if (firstChip) badges.insertBefore(b, firstChip);
          else badges.appendChild(b);
        }
      }
    }
  }

  // --- HTML escaping (the catalog is static, but clean stays clean) -------------
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
  }

  // --- "Scan my PC": hardware scan + recommendations + optional deep benchmark ---
  // Immediately: /hardware (action server 7864) returns CPU/RAM/GPU/VRAM -> fit check against
  // estimate() per catalog model/size. Optionally: the benchmark measures real tokens/s of the
  // INSTALLED models via Ollama /api/generate and uses that to calibrate the estimates.
  const HARDWARE = "http://127.0.0.1:7864/hardware";
  const scan = { hw: null, loading: false };
  const bench = { running: false, cancel: false, ctrl: null, results: [] }; // {tag, params, tps}

  // Does a size fit in VRAM (fast), in RAM (CPU/partially offloaded) or not at all?
  function fitForSize(size, hw) {
    const e = estimate(size);
    if (!e || !hw) return null;
    const vram = hw.vram_gb || 0;
    const ram = (hw.ram && hw.ram.total_gb) || 0;
    if (vram && e.downloadGB * 1.1 <= vram) return { cls: "gpu", label: t("fitGpu"), e: e };
    if (ram && e.ramGB <= ram * 0.8) return { cls: "ram", label: t("fitRam"), e: e };
    return { cls: "no", label: t("fitNo"), e: e };
  }
  // Largest size that still fits in VRAM; otherwise the largest that fits in RAM.
  function bestFittingSize(model, hw) {
    const sizes = (model.sizes || []).filter(function (s) { return parseParams(s) !== null; })
      .sort(function (a, b) { return parseParams(b) - parseParams(a); });
    for (let i = 0; i < sizes.length; i++) {
      const f = fitForSize(sizes[i], hw);
      if (f && f.cls === "gpu") return { size: sizes[i], fit: f };
    }
    for (let i = 0; i < sizes.length; i++) {
      const f = fitForSize(sizes[i], hw);
      if (f && f.cls === "ram") return { size: sizes[i], fit: f };
    }
    return null;
  }
  function categoryOf(m) {
    const caps = m.capabilities || [];
    if (caps.indexOf("embedding") >= 0) return "embedding";
    if (/coder|codellama|codegemma|codestral|starcoder/i.test(m.name)) return "coding";
    if (caps.indexOf("vision") >= 0) return "vision";
    if (caps.indexOf("thinking") >= 0) return "reasoning";
    return "general";
  }
  // Top 2 per category (by popularity), each with the best fitting size.
  function buildRecommendations(hw) {
    const byCat = { general: [], coding: [], reasoning: [], vision: [], embedding: [] };
    CATALOG.forEach(function (m) {
      const pick = bestFittingSize(m, hw);
      if (!pick) return;
      byCat[categoryOf(m)].push({ m: m, size: pick.size, fit: pick.fit, pulls: parsePulls(m.pulls) });
    });
    const out = [];
    ["general", "coding", "reasoning", "vision", "embedding"].forEach(function (cat) {
      byCat[cat].sort(function (a, b) { return b.pulls - a.pulls; });
      byCat[cat].slice(0, 2).forEach(function (r) { r.cat = cat; out.push(r); });
    });
    return out;
  }
  const CAT_T = { general: "catGeneral", coding: "catCoding", reasoning: "catReasoning", vision: "catVision", embedding: "catEmbedding" };

  function hwChipsHTML(hw) {
    const cpu = hw.cpu || {};
    const gpu = (hw.gpus && hw.gpus[0]) || null;
    let html = "";
    function chip(label, val) {
      return '<span class="mdl-hw-chip"><b>' + escHtml(label) + "</b>" + escHtml(val) + "</span>";
    }
    html += chip("CPU", (cpu.cores_physical || cpu.cores_logical || "?") + "× " + (cpu.max_mhz ? (cpu.max_mhz / 1000).toFixed(1) + " GHz" : ""));
    if (hw.ram) html += chip("RAM", hw.ram.total_gb + " GB");
    if (gpu) html += chip("GPU", gpu.name + (gpu.vram_gb ? " · " + gpu.vram_gb + " GB VRAM" : ""));
    return html;
  }
  function recRowHTML(r) {
    const tag = tokenFor(r.m, r.size);
    const installed = state.installedTags.has(tag) || (!r.size && isModelInstalled(r.m));
    const dl = installed
      ? '<span class="mdl-size-installed">' + icon("check") + t("installed") + "</span>"
      : '<button type="button" class="mdl-dl mdl-rec-dl" data-tag="' + escAttr(tag) + '" data-state="idle">' +
          '<span class="mdl-dl-fill"></span>' + icon("download") +
          '<span class="mdl-dl-label">' + t("download") + "</span>" +
        "</button>";
    return (
      '<div class="mdl-rec" data-name="' + escAttr(r.m.name) + '">' +
        '<span class="mdl-rec-cat" data-cat="' + r.cat + '">' + t(CAT_T[r.cat]) + "</span>" +
        '<span class="mdl-rec-name">' + escHtml(r.m.label || r.m.name) +
          (r.size ? ' <em class="mdl-rec-size">' + escHtml(r.size) + "</em>" : "") + "</span>" +
        '<span class="mdl-badge mdl-fit mdl-fit-' + r.fit.cls + '">' + r.fit.label + "</span>" +
        '<span class="mdl-rec-est">≈ ' + r.fit.e.downloadGB + " GB</span>" +
        '<span class="mdl-rec-tps" data-params="' + (parseParams(r.size) || "") + '"></span>' +
        dl +
      "</div>"
    );
  }
  function scanPanelHTML(hw) {
    const recs = buildRecommendations(hw);
    const canBench = state.ollamaOk && state.installedTags.size > 0;
    return (
      '<div class="mdl-scan-head">' +
        '<h2 class="mdl-scan-title">' + HI("zap", { cls: "mdl-ico" }) + t("scanTitle") + "</h2>" +
        '<button type="button" class="mdl-scan-close" id="mdl-scan-close" aria-label="' + escAttr(t("scanClose")) + '">' +
          HI("x", { cls: "mdl-ico" }) + "</button>" +
      "</div>" +
      '<div class="mdl-hw-chips">' + hwChipsHTML(hw) + "</div>" +
      '<h3 class="mdl-scan-sub">' + t("scanRecTitle") + "</h3>" +
      (recs.length
        ? '<div class="mdl-recs">' + recs.map(recRowHTML).join("") + "</div>"
        : '<p class="mdl-scan-none">' + t("scanRecNone") + "</p>") +
      '<div class="mdl-bench">' +
        '<button type="button" class="mdl-bench-btn" id="mdl-bench-btn"' + (canBench ? "" : " disabled") + ">" +
          HI("clock", { cls: "mdl-ico" }) + "<span>" + t("benchStart") + "</span>" +
        "</button>" +
        '<span class="mdl-bench-hint">' + (canBench ? t("benchHint") : t("benchNeedsOllama")) + "</span>" +
      "</div>" +
      '<div class="mdl-bench-list" id="mdl-bench-list"></div>'
    );
  }
  // Skeleton while /hardware responds (shimmer; reduced-motion variant in CSS).
  function scanSkeletonHTML() {
    return (
      '<div class="mdl-scan-head"><h2 class="mdl-scan-title">' + HI("zap", { cls: "mdl-ico" }) + t("scanning") + "</h2></div>" +
      '<div class="mdl-hw-chips">' +
        '<span class="mdl-skel" style="width:120px"></span>' +
        '<span class="mdl-skel" style="width:90px"></span>' +
        '<span class="mdl-skel" style="width:210px"></span>' +
      "</div>" +
      '<div class="mdl-recs">' +
        '<span class="mdl-skel mdl-skel-row"></span>' +
        '<span class="mdl-skel mdl-skel-row" style="width:82%"></span>' +
        '<span class="mdl-skel mdl-skel-row" style="width:64%"></span>' +
      "</div>"
    );
  }
  async function runScan() {
    const panel = document.getElementById("mdl-scanpanel");
    if (!panel || scan.loading) return;
    if (!panel.hidden && scan.hw) { panel.hidden = true; return; } // toggle
    panel.hidden = false;
    panel.innerHTML = scanSkeletonHTML();
    scan.loading = true;
    try {
      const r = await fetch(HARDWARE);
      if (!r.ok) throw new Error("HTTP " + r.status);
      scan.hw = await r.json();
      panel.innerHTML = scanPanelHTML(scan.hw);
    } catch (e) {
      scan.hw = null;
      panel.innerHTML =
        '<div class="mdl-scan-head"><h2 class="mdl-scan-title">' + HI("zap", { cls: "mdl-ico" }) + t("scanTitle") + "</h2>" +
        '<button type="button" class="mdl-scan-close" id="mdl-scan-close" aria-label="' + escAttr(t("scanClose")) + '">' +
        HI("x", { cls: "mdl-ico" }) + "</button></div>" +
        '<p class="mdl-scan-none">' + t("scanFailed") + "</p>";
    } finally {
      scan.loading = false;
    }
  }
  // Delegated clicks in the panel (survives every re-render of the panel content).
  function wireScanPanel() {
    const panel = document.getElementById("mdl-scanpanel");
    if (!panel) return;
    panel.addEventListener("click", async function (e) {
      if (e.target.closest("#mdl-scan-close")) {
        bench.cancel = true;
        if (bench.ctrl) { try { bench.ctrl.abort(); } catch (err) {} }
        panel.hidden = true;
        return;
      }
      const dl = e.target.closest(".mdl-rec-dl");
      if (dl) {
        const tag = dl.getAttribute("data-tag");
        if (tag && dl.dataset.state !== "busy") {
          await startPull(tag, dl);
          if (state.installedTags.has(tag)) {
            dl.outerHTML = '<span class="mdl-size-installed">' + icon("check") + t("installed") + "</span>";
          }
        }
        return;
      }
      if (e.target.closest("#mdl-bench-btn")) {
        if (bench.running) { // running -> a click cancels (button shows "Cancel")
          bench.cancel = true;
          if (bench.ctrl) { try { bench.ctrl.abort(); } catch (err) {} }
        } else {
          runBenchmark();
        }
      }
    });
  }
  // Deep benchmark: sequentially measures real tokens/s per INSTALLED model (Ollama
  // /api/generate non-stream: eval_count/eval_duration) and calibrates the recommendations
  // (tps × parameters ≈ constant per machine -> estimate for models that aren't installed).
  async function runBenchmark() {
    if (bench.running) return;
    const listEl = document.getElementById("mdl-bench-list");
    const btn = document.getElementById("mdl-bench-btn");
    if (!listEl || !btn) return;
    if (activePulls.size) { // measuring under download load = wrong tokens/s
      listEl.innerHTML = '<div class="mdl-scan-none">' + t("benchWaitPulls") + "</div>";
      return;
    }
    const tags = Array.from(state.installedTags)
      .filter(function (x) { return !/embed|bge-|minilm|arctic/i.test(x); });
    if (!tags.length) return;
    bench.running = true; bench.cancel = false; bench.results = [];
    const btnLabel = btn.querySelector("span");
    if (btnLabel) btnLabel.textContent = t("benchCancel");
    btn.dataset.bench = "running";
    listEl.innerHTML = tags.map(function (tag) {
      return '<div class="mdl-bench-row" data-tag="' + escAttr(tag) + '">' +
        '<span class="mdl-bench-name">' + escHtml(tag) + "</span>" +
        '<span class="mdl-bench-val"><span class="mdl-skel" style="width:70px"></span></span>' +
      "</div>";
    }).join("");
    for (let i = 0; i < tags.length; i++) {
      if (bench.cancel) break;
      const tag = tags[i];
      const row = listEl.querySelector('.mdl-bench-row[data-tag="' + tag.replace(/"/g, '\\"') + '"]');
      const val = row && row.querySelector(".mdl-bench-val");
      bench.ctrl = new AbortController();
      try {
        const r = await fetch(OLLAMA + "/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          signal: bench.ctrl.signal,
          body: JSON.stringify({
            model: tag, stream: false, prompt: "Write one short paragraph about the ocean.",
            options: { num_predict: 96, temperature: 0 },
          }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        const tps = (j.eval_count && j.eval_duration) ? (j.eval_count / (j.eval_duration / 1e9)) : 0;
        const loadS = j.load_duration ? (j.load_duration / 1e9) : 0;
        const params = parseParams((tag.split(":")[1] || "")) ||
          (function () { const m = tag.match(/(\d+(?:\.\d+)?)b/i); return m ? parseFloat(m[1]) : null; })();
        bench.results.push({ tag: tag, tps: tps, params: params });
        if (val) val.innerHTML = "<b>" + t("benchTps", { v: tps.toFixed(1) }) + "</b>" +
          (loadS > 0.5 ? ' <span class="mdl-bench-load">· ' + t("benchLoad", { s: loadS.toFixed(1) }) + "</span>" : "");
      } catch (e2) {
        if (val) val.textContent = bench.cancel ? "–" : t("error");
      }
    }
    bench.running = false; bench.ctrl = null;
    btn.dataset.bench = "";
    if (btnLabel) btnLabel.textContent = t("benchStart");
    // Calibration: median of tps*params -> estimated tokens/s per recommendation.
    const cal = bench.results
      .filter(function (r) { return r.tps > 0 && r.params; })
      .map(function (r) { return r.tps * r.params; })
      .sort(function (a, b) { return a - b; });
    if (cal.length) {
      const median = cal[Math.floor(cal.length / 2)];
      document.querySelectorAll("#mdl-scanpanel .mdl-rec-tps").forEach(function (elx) {
        const p = parseFloat(elx.getAttribute("data-params"));
        if (p) elx.textContent = t("benchEst", { v: (median / p).toFixed(0) });
      });
    }
    if (!bench.cancel) {
      const done = document.createElement("div");
      done.className = "mdl-bench-done";
      done.textContent = t("benchDone");
      listEl.appendChild(done);
    }
  }

  // Central click delegation on the grid (survives re-rendering of the grid).
  // Handles: download, size selection, tabs, copy, "Set as active model".
  function wireGridClicks() {
    const grid = document.getElementById("mdl-grid");

    grid.addEventListener("click", function (e) {
      // 1) Select a size chip
      const chip = e.target.closest(".mdl-size-chip");
      if (chip) {
        const card = chip.closest(".mdl-card");
        const name = card && card.getAttribute("data-name");
        const size = chip.getAttribute("data-size-chip");
        if (name && size != null) {
          cardSize.set(name, size);
          // Toggle the active chip (only aria-pressed, without a full rebuild)
          const group = chip.parentNode;
          if (group) {
            group.querySelectorAll(".mdl-size-chip").forEach(function (c) {
              c.setAttribute("aria-pressed", c === chip ? "true" : "false");
            });
          }
          // Update the action box + loading row to the new size
          rerenderAction(card);
        }
        return;
      }

      // 2) Switch tab
      const tab = e.target.closest(".mdl-tab");
      if (tab) {
        const card = tab.closest(".mdl-card");
        const name = card && card.getAttribute("data-name");
        const key = tab.getAttribute("data-tab-key");
        if (name && (key === "ollama" || key === "jarvis")) {
          cardTab.set(name, key);
          rerenderAction(card);
        }
        return;
      }

      // 3) Copy command
      const copyBtn = e.target.closest(".mdl-copy");
      if (copyBtn) {
        copyCommand(copyBtn);
        return;
      }

      // 4) Set as active model (only when installed -> button enabled)
      const setBtn = e.target.closest(".mdl-set");
      if (setBtn) {
        if (setBtn.disabled) return;
        const token = setBtn.getAttribute("data-set");
        if (token) {
          try { localStorage.setItem("jarvis.model", token); } catch (err) { /* ignore */ }
          window.location.href = "index.html";
        }
        return;
      }

      // 5) Start download
      const dl = e.target.closest(".mdl-dl");
      if (dl) {
        if (dl.dataset.state === "busy") return; // already running
        const tag = dl.getAttribute("data-tag");
        if (tag) startPull(tag, dl);
        return;
      }
    });
  }

  // Copy command to the clipboard + brief "Copied ✓" feedback (2 s).
  function copyCommand(btn) {
    const cmd = btn.getAttribute("data-copy") || "";
    const label = btn.querySelector(".mdl-copy-label");
    const done = function () {
      btn.classList.add("is-copied");
      if (label) label.textContent = t("copied");
      if (btn._copyTimer) clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(function () {
        btn.classList.remove("is-copied");
        if (label) label.textContent = t("copy");
      }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(done, function () { fallbackCopy(cmd, done); });
    } else {
      fallbackCopy(cmd, done);
    }
  }

  // Fallback without the Clipboard API (e.g. file:// in older browsers).
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (err) { /* fail silently */ }
  }

  // --- Start -------------------------------------------------------------------
  async function init() {
    buildShell();
    wireGridClicks();
    renderGrid();          // render immediately (even without Ollama)
    await loadInstalled(); // load installed status live
    renderGrid();          // re-render with installed markers
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
