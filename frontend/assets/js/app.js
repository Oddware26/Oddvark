/* Oddvark – personal, local AI assistant (assistant persona / wake word: "Jarvis").
   Backend: local Ollama (http://localhost:11434). Speech: Web Speech API (STT + TTS). */
(function () {
  "use strict";

  // i18n: English is the default UI language, German the switchable 2nd version (assets/js/i18n.js).
  const tr = (window.JV_I18N && window.JV_I18N.t) || function (k) { return k; };

  const OLLAMA = "http://localhost:11434";
  const ZIMAGE = "http://localhost:7861"; // local Z-Image-Turbo image server (tools/zimage-server.py)
  const TTSAPI = "http://localhost:7862"; // local XTTS-v2 TTS server (tools/tts-server.py)
  const ACTIONS = "http://127.0.0.1:7864"; // local action server (PC/file/website/vision, tools/action-server.py)
  const STT_URL = "http://127.0.0.1:7865"; // local Whisper STT server (tools/stt-server.py)
  const LS_MODEL = "jarvis.model";
  const LS_VOICE = "jarvis.voiceOut";
  const LS_LANG = "jarvis.lang";
  const LS_EFFORT = "jarvis.effort";
  const LS_PROFILE = "jarvis.profile";
  // Effort levels 0..5 -> tr("effort.N") (level 5 "Ultracode" = purple special state).
  const LS_MODE = "jarvis.mode";
  // Mode options for the "Auto" button (labels via tr("mode.<value>") / tr("mode.<value>.short")).
  const MODES = [
    { value: "accept" },
    { value: "plan" },
    { value: "auto_run" },   // autonomous: run risky actions without asking
    { value: "auto" },       // default – sits at the very bottom
  ];
  // Text AND background color of the mode button per mode: green = accept, blue = plan, red = auto_run, yellow = auto.
  const MODE_COLORS = { accept: "var(--extended-green)", plan: "hsl(var(--accent-100))", auto_run: "var(--core-red)", auto: "var(--extended-yellow)" };
  const MODE_BG = { accept: "var(--extended-10-green)", plan: "hsl(var(--accent-100) / 0.14)", auto_run: "var(--core-10-red)", auto: "var(--extended-10-yellow)" };
  // Languages for the language switcher: display, BCP-47 (STT/TTS), and answer language for the system prompt.
  const LANGS = [
    { code: "de", label: "Deutsch", bcp: "de-DE", answer: "German" },
    { code: "en", label: "English", bcp: "en-US", answer: "English" },
    { code: "fr", label: "Français", bcp: "fr-FR", answer: "French" },
    { code: "es", label: "Español", bcp: "es-ES", answer: "Spanish" },
    { code: "it", label: "Italiano", bcp: "it-IT", answer: "Italian" },
  ];
  function langCfg() { return LANGS.find(function (l) { return l.code === lang; }) || LANGS[0]; }

  // ---------- Profile / memory ("About you") ----------
  const PROFILE_DEFAULTS = {
    name: "", about: "", tone: "locker", address: "", length: "knapp",
    humor: false, instructions: "", memories: [],
    voiceURI: "", rate: 1, volume: 1, wakeWord: "Jarvis", wakeEnabled: true,
    engine: "local", voiceLocal: "", // TTS: "local" (XTTS) | "elevenlabs" | "browser"; voiceLocal = XTTS speaker
    elevenKey: "", elevenVoice: "", elevenModel: "eleven_multilingual_v2", // ElevenLabs (own API key)
    tools: true, // allow tools (tool calling via Ollama)
    rag: false, embedModel: "nomic-embed-text", // knowledge base (RAG)
  };
  function loadProfile() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(LS_PROFILE) || "{}") || {}; } catch (e) { p = {}; }
    const out = Object.assign({}, PROFILE_DEFAULTS, p);
    if (!Array.isArray(out.memories)) out.memories = [];
    // One-time: turn the wake word on by default ("Hey Jarvis" -> mic activates immediately).
    // Existing profiles have wakeEnabled:false stored; after this the user's choice applies again.
    if (!p.wakeDefaultOn) { out.wakeEnabled = true; out.wakeDefaultOn = true; }
    return out;
  }
  let profile = loadProfile();
  let syncProfileUI = null; // set by the Customize overlay to re-render fields from `profile`
  function saveProfile() {
    try { localStorage.setItem(LS_PROFILE, JSON.stringify(profile)); } catch (e) {}
    if (syncProfileUI) try { syncProfileUI(); } catch (e) {}
  }
  // "Remember that ..." -> fact to remember (or null). Triggers the memory without a model call.
  function parseRemember(t) {
    if (!t) return null;
    const m = t.match(/^\s*(?:merke?\s+dir|notiere?(?:\s+dir)?|behalte|remember)\b[\s,:]*(?:dass\s+|that\s+)?([\s\S]+)/i);
    if (!m) return null;
    const fact = m[1].trim().replace(/[.!\s]+$/, "");
    return fact || null;
  }

  // Assemble personality/profile/memory instructions for the system prompt.
  function profilePromptParts() {
    const p = profile, parts = [];
    const who = [];
    if (p.name) who.push(tr("sys.who.name", { name: p.name }));
    if (p.address) who.push(tr("sys.who.address", { address: p.address }));
    if (p.about) who.push(tr("sys.who.about", { about: p.about }));
    if (who.length) parts.push(who.join(" "));

    const style = [];
    if (p.tone === "förmlich") style.push(tr("sys.tone.formal"));
    else if (p.tone === "locker") style.push(tr("sys.tone.loose"));
    if (p.length === "knapp") style.push(tr("sys.len.short"));
    else if (p.length === "ausführlich") style.push(tr("sys.len.long"));
    if (p.humor) style.push(tr("sys.humor"));
    if (style.length) parts.push(style.join(" "));

    if (p.instructions) parts.push(tr("sys.instructions", { x: p.instructions }));
    if (p.memories.length) parts.push(tr("sys.memories", { x: p.memories.join("\n- ") }));
    return parts;
  }
  function systemPrompt() {
    const extra = profilePromptParts();
    let s = tr("sys.base") + " " + tr("sys.env");
    if (profile.tools !== false) s += " " + tr("sys.agent"); // tool guide only when tools are enabled
    if (extra.length) s += " " + extra.join(" ");
    s += " " + tr("sys.answer_in", { lang: tr("langname." + langCfg().code) });
    return s;
  }

  // ---------- Anchors in the scaffold ----------
  const input = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
  const scrollC = document.querySelector("[data-epitaxy-transcript-region] .overflow-y-auto");
  const sendBtn = document.getElementById("jv-send-btn") || document.querySelector('button[aria-label="Send"]') || document.querySelector('button[aria-label="Senden"]');
  // Microphone: stable scaffold ID first; aria-label fallbacks (EN default + DE) only as a safety net.
  const micBtn =
    document.getElementById("base-ui-_r_kq_") ||
    document.querySelector('button[aria-label="Press and hold to record"]') ||
    document.querySelector('button[aria-label="Drücken und halten zum Aufnehmen"]') ||
    document.querySelector('[role="group"][aria-label="Dictate"] button') ||
    document.querySelector('[role="group"][aria-label="Diktieren"] button');

  if (!input || !scrollC) {
    console.warn("[Oddvark] Input field or transcript region not found – aborting.");
    return;
  }

  // Dynamic greeting: name from the profile (Customize); otherwise the salutation; otherwise just "Welcome back".
  const welcomeH1 = document.querySelector("h1.text-title");
  const welcomeWrap = welcomeH1 && welcomeH1.closest("header");
  if (welcomeWrap) welcomeWrap.classList.add("jv-welcome"); // enables the fade-out/in transition
  let welcomeGone = false;
  function updateWelcome() {
    if (!welcomeH1) return;
    const nm = (profile.name || "").trim() || (profile.address || "").trim();
    welcomeH1.textContent = nm ? tr("header.welcome_name", { name: nm }) : tr("header.welcome_plain");
  }
  // Fade the greeting out with animation when the chat starts (once).
  // The scaffold puts a fade-in ANIMATION on the header that beats normal inline styles; the Web Animations API
  // (fill:forwards) overrides it deterministically, then onfinish locks the end state via !important.
  function hideWelcome() {
    if (welcomeGone || !welcomeWrap) return;
    welcomeGone = true;
    const el = welcomeWrap;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.style.setProperty("animation", "none", "important"); // disable the scaffold's fade-in animation
    const cs = getComputedStyle(el);
    const h0 = el.offsetHeight;
    const lock = function () {
      const st = el.style;
      st.setProperty("max-height", "0px", "important");
      st.setProperty("opacity", "0", "important");
      st.setProperty("padding-top", "0px", "important");
      st.setProperty("padding-bottom", "0px", "important");
      st.setProperty("margin-top", "0px", "important");
      st.setProperty("margin-bottom", "0px", "important");
      st.setProperty("overflow", "hidden", "important");
      st.setProperty("pointer-events", "none", "important");
    };
    if (!el.animate) { lock(); return; } // WAAPI unavailable -> hide without animation
    const anim = el.animate(
      [
        { opacity: 1, maxHeight: h0 + "px", paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, transform: "translateY(0)" },
        { opacity: 0, maxHeight: "0px", paddingTop: "0px", paddingBottom: "0px", transform: reduce ? "translateY(0)" : "translateY(-10px)" },
      ],
      { duration: reduce ? 160 : 340, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" }
    );
    anim.onfinish = lock;
  }
  // Fade the greeting back in (on "New session"). Removes the locks set by hideWelcome().
  function showWelcome() {
    welcomeGone = false;
    if (!welcomeWrap) return;
    try { welcomeWrap.getAnimations().forEach(function (a) { a.cancel(); }); } catch (e) {}
    ["animation", "max-height", "opacity", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "overflow", "pointer-events"]
      .forEach(function (p) { welcomeWrap.style.removeProperty(p); });
    updateWelcome();
  }

  // ---------- State ----------
  const messages = []; // {role, content, images?}
  let attachments = []; // attached files: {name, kind:'image'|'text'|'other', dataUrl?, b64?, text?, note?}
  let model = localStorage.getItem(LS_MODEL) || "";
  if (model === "auto") model = ""; // migration: discard the removed auto-router's sentinel
  const ctxLen = {}; // context window per model (from /api/show, cached); guards against silent context loss
  const modelCaps = {}; // capabilities per model (from /api/show, e.g. "thinking") – for the effort slider
  let voiceOut = localStorage.getItem(LS_VOICE) !== "0";
  let ttsBtn = null; // speaker toggle in the bottom bar (next to the microphone)
  let activeSpeakBtn = null; // the toolbar button currently reading aloud (shows ⏸); only ever one
  let lang = localStorage.getItem(LS_LANG) === "de" ? "de" : "en"; // default/main language: English
  let busy = false;
  // Only ONE dropdown should be open at a time: this holds the close() function
  // of the currently open popup. Each open() closes the previous one first.
  let closeOpenMenu = null;
  // Effort: 0..5, default 3 ("Extra"). Read by ask() and translated into the /api/chat body.
  let effort = clampEffort(parseInt(localStorage.getItem(LS_EFFORT), 10));

  // ---------- Branding ---------- (the "ODDVARK" wordmark is directly in the HTML; assistant persona stays "Jarvis")
  document.title = "Oddvark";

  // ---------- Build the chat interface ----------
  scrollC.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.id = "jarvis-wrap";
  wrap.className = "epitaxy-composer-width";
  scrollC.appendChild(wrap);

  // Connection-status pill removed – the state (Ready/Thinking/Error …) is mirrored in the
  // identity chip in the sidebar (setAssistant), chat errors in the transcript.
  const promptBox = input.closest(".epitaxy-prompt"); // still needed for the attachment row

  // ---------- Voice-output toggle (speaker icon next to the microphone) ----------
  // Outline style (fill:none + stroke) and viewBox 0 0 12 12 like the mic icon beside it -> same
  // render size (both width:var(--class-small-icon)) AND same glyph fill weight.
  const SPK_ON = HI("speakerOn", { style: "width:18px;height:18px" });
  const SPK_OFF = HI("speakerOff", { style: "width:18px;height:18px" });

  if (micBtn) {
    const micGroup = micBtn.closest('[role="group"]') || micBtn.parentElement;
    ttsBtn = document.createElement("button");
    ttsBtn.type = "button";
    // Same look as the other bottom-bar icon buttons (e.g. "+") – own class (chat.css/app.css).
    ttsBtn.className = "jarvis-tts-btn";
    ttsBtn.setAttribute("aria-label", tr("aria.voice_output"));
    ttsBtn.innerHTML = '<span class="jarvis-tts-ico"></span>';
    ttsBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      voiceOut = !voiceOut;
      localStorage.setItem(LS_VOICE, voiceOut ? "1" : "0");
      if (!voiceOut) stopSpeak();
      renderVoiceTgl();
      if (idChip) idChip.syncSettings(); // keep the switch in the settings popover in sync
    }, true);
    if (micGroup && micGroup.parentNode) {
      micGroup.parentNode.insertBefore(ttsBtn, micGroup.nextSibling);
    }
  }
  // Adjust the speaker icon + state to voiceOut (replaces the former status pill).
  function renderVoiceTgl() {
    if (!ttsBtn) return;
    ttsBtn.setAttribute("aria-pressed", String(voiceOut));
    ttsBtn.title = voiceOut ? tr("tts.on") : tr("tts.off");
    const ico = ttsBtn.querySelector(".jarvis-tts-ico");
    if (ico) ico.innerHTML = voiceOut ? SPK_ON : SPK_OFF;
  }
  renderVoiceTgl();

  // Remove the arrow/chevron next to the microphone ("Dictation settings") – unused in Oddvark.
  const micChevron =
    document.getElementById("base-ui-_r_ks_") ||
    document.querySelector('button[aria-label="Dictation settings"]') ||
    document.querySelector('button[aria-label="Diktat-Einstellungen"]');
  if (micChevron) micChevron.remove();

  // ---------- File attachments ("+" button → attach files) ----------
  const ATT_FILE_SVG = HI("file", { size: 14 });
  const ATT_X_SVG = HI("x", { size: 12 });
  const ATT_TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|scss|less|js|mjs|cjs|ts|jsx|tsx|vue|svelte|py|java|kt|c|h|hpp|cpp|cc|cs|go|rs|rb|php|swift|sh|bash|zsh|bat|ps1|sql|ini|toml|cfg|conf|env|gradle|dockerfile|gitignore|r|lua|pl)$/i;
  const ATT_MAX_TEXT = 200 * 1024; // 200 KB per text file

  const addBtn =
    document.getElementById("base-ui-_r_ki_") ||
    document.querySelector('button[aria-label="Add"]') ||
    document.querySelector('button[aria-label="Hinzufügen"]');
  // The scaffold already has a hidden file input – reuse it, otherwise create a new one.
  let fileInput = document.getElementById("chat-input-file-upload-epitaxy");
  if (!fileInput) {
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);
  }
  fileInput.setAttribute(
    "accept",
    "image/*,text/*,.md,.json,.csv,.log,.js,.ts,.jsx,.tsx,.py,.html,.css,.yaml,.yml,.xml,.sql,.sh,.toml,.ini"
  );

  // Attachment card INSIDE the prompt box: the scaffold has an expandable grid slot for it
  // (grid-template-rows 0fr->1fr animates the height). We insert the card there so the box
  // grows upward. Fallback: a loose bar above the box.
  const attachRow = el("div", "jarvis-attach");
  const attachSlot = promptBox ? promptBox.querySelector('div.grid[style*="grid-template-rows"]') : null;
  const attachSlotInner = attachSlot ? attachSlot.firstElementChild : null;
  let collapseTimer = null; // delays clearing until after the collapse animation
  if (attachSlotInner) {
    attachSlotInner.appendChild(attachRow);
  } else if (promptBox && promptBox.parentNode) {
    attachRow.setAttribute("hidden", "");
    promptBox.parentNode.insertBefore(attachRow, promptBox);
  } else {
    wrap.appendChild(attachRow);
  }

  if (addBtn) {
    addBtn.setAttribute("aria-haspopup", "menu");
    buildPlusMenu(addBtn); // "+" opens a menu (image/web search/attach) instead of the file dialog directly
  }
  fileInput.addEventListener("change", function () {
    Array.prototype.slice.call(fileInput.files || []).forEach(readAttachment);
  });

  function attIsText(file) {
    return (
      (file.type && (file.type.indexOf("text/") === 0 || file.type === "application/json" || file.type === "application/xml")) ||
      ATT_TEXT_EXT.test(file.name)
    );
  }
  function readAttachment(file) {
    if (file.type && file.type.indexOf("image/") === 0) {
      const r = new FileReader();
      r.onload = function () {
        const url = String(r.result);
        attachments.push({ name: file.name, kind: "image", dataUrl: url, b64: url.split(",")[1] || "" });
        renderAttachments();
      };
      r.readAsDataURL(file);
    } else if (attIsText(file)) {
      if (file.size > ATT_MAX_TEXT) {
        attachments.push({ name: file.name, kind: "other", note: tr("att.toolarge", { n: Math.round(file.size / 1024) }) });
        renderAttachments();
        return;
      }
      const r = new FileReader();
      r.onload = function () {
        attachments.push({ name: file.name, kind: "text", text: String(r.result) });
        renderAttachments();
      };
      r.readAsText(file);
    } else {
      attachments.push({ name: file.name, kind: "other", note: "not readable" });
      renderAttachments();
    }
  }
  function renderAttachments() {
    const has = attachments.length > 0;
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    if (!has) {
      // Collapse WITH animation: leave existing cards in place, animate the slot to 0fr, and
      // clear the content only AFTER the transition (otherwise the cards would vanish instantly).
      if (attachSlot) {
        attachSlot.style.gridTemplateRows = "0fr";
        collapseTimer = setTimeout(function () {
          collapseTimer = null;
          if (attachments.length === 0) attachRow.innerHTML = "";
        }, 240);
      } else {
        attachRow.innerHTML = "";
        attachRow.setAttribute("hidden", "");
      }
      return;
    }
    // There are attachments -> build cards and expand the slot.
    attachRow.innerHTML = "";
    if (attachSlot) attachSlot.style.gridTemplateRows = "1fr";
    else attachRow.removeAttribute("hidden");
    attachments.forEach(function (a, i) {
      const chip = el("div", "jarvis-chip");
      // Thumbnail (image) or file icon
      if (a.kind === "image") {
        const im = document.createElement("img");
        im.className = "jarvis-chip-thumb";
        im.src = a.dataUrl;
        im.alt = a.name;
        chip.appendChild(im);
      } else {
        const ic = el("span", "jarvis-chip-ico");
        ic.innerHTML = ATT_FILE_SVG;
        chip.appendChild(ic);
      }
      // Name + subtitle (type/note)
      const meta = el("div", "jarvis-chip-meta");
      const nm = el("div", "jarvis-chip-name", a.name);
      nm.title = a.name;
      const sub = el("div", "jarvis-chip-sub", a.kind === "image" ? tr("att.image") : (a.note || tr("att.file")));
      meta.append(nm, sub);
      chip.appendChild(meta);
      // Remove
      const x = el("button", "jarvis-chip-x");
      x.type = "button";
      x.setAttribute("aria-label", tr("aria.remove_attachment"));
      x.innerHTML = ATT_X_SVG;
      x.addEventListener("click", function () { attachments.splice(i, 1); renderAttachments(); });
      chip.appendChild(x);
      attachRow.appendChild(chip);
    });
  }

  // Capture the bottom model button as the trigger (placeholder label "Modell" in the HTML).
  const modelBtn = document.getElementById("base-ui-_r_l4_");
  let modelLabelSpan = null;
  if (modelBtn) {
    Array.prototype.forEach.call(modelBtn.querySelectorAll("span"), function (n) {
      if (!modelLabelSpan && n.childElementCount === 0 && n.textContent.trim() === "Modell") modelLabelSpan = n;
    });
  }
  const modelMenu = buildModelMenu(modelBtn, function (v) {
    model = v;
    localStorage.setItem(LS_MODEL, model);
    updateModelLabel();
    modelMenu.setSelected(v);
  }, function () { window.location.href = "models.html"; });

  // Capture the bottom "Extra" button (effort) as the trigger – analogous to modelBtn/modelLabelSpan.
  let effortBtn = document.getElementById("base-ui-_r_la_");
  let effortLabelSpan = null;
  if (effortBtn) {
    // The leaf <span> in the button whose text is currently "Extra".
    Array.prototype.forEach.call(effortBtn.querySelectorAll("span"), function (n) {
      if (!effortLabelSpan && n.childElementCount === 0 && n.textContent.trim() === "Extra") {
        effortLabelSpan = n;
      }
    });
  }
  if (!effortLabelSpan) {
    // Fallback: any leaf <span> with text "Extra" whose button anchor we take over.
    document.querySelectorAll("span").forEach(function (n) {
      if (!effortLabelSpan && n.childElementCount === 0 && n.textContent.trim() === "Extra") {
        effortLabelSpan = n;
        if (!effortBtn) effortBtn = n.closest("button");
      }
    });
  }
  const effortMenu = buildEffortMenu(effortBtn, function (v) {
    effort = clampEffort(v);
    localStorage.setItem(LS_EFFORT, String(effort));
    updateEffortLabel(true);
  });
  // Mirror the initial value in the trigger label and popup.
  updateEffortLabel();
  effortMenu.setValue(effort);

  // Capture the bottom "Auto" button (mode) as the trigger.
  const modeBtn = document.getElementById("base-ui-_r_ka_");
  let modeLabelSpan = null;
  if (modeBtn) {
    Array.prototype.forEach.call(modeBtn.querySelectorAll("span"), function (n) {
      if (!modeLabelSpan && n.childElementCount === 0 && n.textContent.trim() === "Auto") modeLabelSpan = n;
    });
  }
  let mode = localStorage.getItem(LS_MODE) || "auto";
  const modeMenu = buildModeMenu(modeBtn, function (v) {
    mode = v;
    localStorage.setItem(LS_MODE, mode);
    updateModeLabel(true);
  });
  updateModeLabel();

  // Set the composer icons as HugeIcons (instead of static placeholders) – consistent with the rest of the UI.
  // Mic, "+" and the speaker (TTS) use the same default icon size (--class-small-icon) -> equal size.
  (function setComposerIcons() {
    const put = function (el, name, opts) { if (el) el.innerHTML = HI(name, opts); };
    put(sendBtn, "send", { size: 18 });
    put(document.getElementById("base-ui-_r_ki_"), "plus", { size: 18 });          // Attach (+)
    put(micBtn, "mic", { size: 18 });                                              // microphone = speaker = +
    put(document.getElementById("base-ui-_r_ks_"), "chevDown", { size: 14 });      // dictation settings (small caret)
  })();
  modeMenu.setSelected(mode);

  // Oddvark identity in the sidebar footer (replaces the old account menu).
  // Shows presence + live status (Ready/Listening/Thinking/Speaking); click opens settings.
  const idChip = buildIdentityChip();
  function setAssistant(s) { if (idChip) idChip.setState(s); }


  // ---------- Helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // `cmdText`: the original input including the slash command (for /web the bubble shows only the question) –
  // Edit/rewind work with it, so the command really gets re-run.
  function addBubble(role, text, cmdText) {
    hideWelcome();
    const row = el("div", "jarvis-msg " + role);
    const b = el("div", "b");
    b.textContent = text || "";
    if (role === "user") {
      row.classList.add("group/msg"); // enables the hover toolbar (like on answers)
      row.appendChild(userCol(row, b, text || "", cmdText || text || ""));
    } else {
      row.appendChild(b);
    }
    wrap.appendChild(row);
    scrollToEnd();
    return b;
  }
  // Column for the user bubble: bubble + hover actions below
  // (copy, edit, rewind the chat to here and resend).
  function userCol(row, b, copyText, restartText) {
    const histIdx = messages.length; // history state BEFORE this prompt (push happens after addBubble)
    const col = el("div", "jarvis-user-col");
    col.appendChild(b);
    const tools = el("div",
      "jarvis-turn-toolbar flex gap-g2 opacity-0 pointer-events-none group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto");
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", tr("aria.prompt_actions"));
    tools.append(
      turnToolBtn(TB_COPY, "Copy prompt", function () {
        try { if (navigator.clipboard) navigator.clipboard.writeText(copyText); } catch (e) {}
      }),
      turnToolBtn(TB_EDIT, "Edit prompt", function () {
        setInputText(restartText);
        focusInputEnd();
      }),
      turnToolBtn(TB_RESTART, tr("tt.restart"), function () {
        restartChatFrom(row, histIdx, restartText);
      })
    );
    col.appendChild(tools);
    return col;
  }
  // Rewind the chat to this prompt: everything BEFORE stays, this prompt and everything after
  // are removed (history + transcript), then the prompt is sent fresh.
  function restartChatFrom(row, histIdx, text) {
    if (busy || !text) return; // do not pull the rug out from under a running answer
    try { stopSpeak(); } catch (e) {}
    messages.length = Math.min(messages.length, histIdx);
    let n = row;
    const gone = [];
    while (n) {
      if (n.classList && (n.classList.contains("jarvis-msg") || n.classList.contains("jarvis-turn"))) gone.push(n);
      n = n.nextElementSibling;
    }
    gone.forEach(function (x) { x.remove(); });
    setInputText(text);
    submit();
  }

  // ---------- Markdown -> HTML (compact; enough for LLM answers) ----------
  function mdEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Inline markdown: code, images, links, autolinks, bold/italic/strikethrough. Already-parked
  // fragments (placeholder index) are restored at the end so that, e.g., a URL in an href
  // is not autolinked a second time.
  function mdInline(s) {
    const stash = [];
    const keep = function (h) { stash.push(h); return "" + (stash.length - 1) + ""; };
    s = s.replace(/`([^`]+)`/g, function (_, c) { return keep('<code data-epitaxy-inline-code="">' + c + "</code>"); });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, alt, url) { return keep('<img class="jv-md-img" src="' + url + '" alt="' + alt + '" loading="lazy">'); });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (_, txt, url) { return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>"); });
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?])/g, function (_, pre, url) {
      const href = /^www\./i.test(url) ? "http://" + url : url;
      return pre + keep('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
    s = s.replace(/(\d+)/g, function (_, n) { return stash[+n]; });
    return s;
  }
  // Render a list item (possibly a task list "[ ]"/"[x]") as <li>.
  function mdListItem(text) {
    const tl = text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (tl) return '<li class="jv-md-task"><input type="checkbox" disabled' + (/[xX]/.test(tl[1]) ? " checked" : "") + "> " + mdInline(tl[2]) + "</li>";
    return "<li>" + mdInline(text) + "</li>";
  }
  function mdToHtml(md) {
    const lines = mdEsc(md).split(/\r?\n/);
    let html = "", i = 0;
    const isTableSep = function (l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l); };
    // Note: mdEsc() already ran -> "> quote" is present as "&gt; quote".
    const isBlock = function (l) {
      return /^```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^&gt;\s?/.test(l) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
    };
    const splitRow = function (l) { return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); }); };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        i++; const code = [];
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        html += "<pre><code>" + code.join("\n") + "</code></pre>";
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += "<hr>"; i++; continue; }
      // Table: header row, then separator "|---|---|"
      if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const headCells = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() && !isBlock(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        let t = '<table class="jv-md-table"><thead><tr>';
        headCells.forEach(function (c) { t += "<th>" + mdInline(c) + "</th>"; });
        t += "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>";
          for (let k = 0; k < headCells.length; k++) t += "<td>" + mdInline(r[k] || "") + "</td>";
          t += "</tr>";
        });
        html += t + "</tbody></table>";
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const lvl = h[1].length; html += "<h" + lvl + ">" + mdInline(h[2]) + "</h" + lvl + ">"; i++; continue; }
      if (/^&gt;\s?/.test(line)) {
        // Lines are already escaped -> render with mdInline (NOT mdToHtml, which would double-escape).
        const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
        html += "<blockquote>" + mdInline(q.join(" ")) + "</blockquote>";
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const it = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
        html += "<ul>" + it.map(mdListItem).join("") + "</ul>";
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const it = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        html += "<ol>" + it.map(function (t) { return "<li>" + mdInline(t) + "</li>"; }).join("") + "</ol>";
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlock(lines[i]) && !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) { para.push(lines[i]); i++; }
      html += "<p>" + mdInline(para.join(" ")) + "</p>";
    }
    return html;
  }

  // ================= Code artifacts: card in the answer + side code panel =================
  // Large code blocks in the answer become a compact card; clicking opens a panel with a
  // Code/Preview toggle, line numbers, syntax highlighting, and refresh/copy/export.
  let ART_ID = 0;
  const ART_STORE = {};   // id -> { id, title, lang, code }

  function artNormLang(info) {
    let l = String(info || "").trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9+#]/g, "");
    const map = { javascript: "js", mjs: "js", cjs: "js", node: "js", typescript: "ts", htm: "html", svg: "xml", vue: "html", svelte: "html", scss: "css", less: "css", python: "py", rb: "py", ruby: "py", bash: "sh", zsh: "sh", shell: "sh", console: "sh", yml: "yaml", markdown: "md" };
    return map[l] || l || "text";
  }
  function artExt(lang) { return ({ js: "js", jsx: "jsx", ts: "ts", tsx: "tsx", json: "json", html: "html", xml: "xml", css: "css", py: "py", sh: "sh", yaml: "yaml", md: "md", text: "txt" })[lang] || "txt"; }
  function artPretty(lang) { return ({ js: "JavaScript", jsx: "React", ts: "TypeScript", tsx: "React TSX", json: "JSON", html: "HTML", xml: "XML", css: "CSS", py: "Python", sh: "Shell", yaml: "YAML", md: "Markdown", text: "Text" })[lang] || lang.toUpperCase(); }

  // ---- Syntax highlighting (vanilla, offline; returns escaped HTML with <span class="tk-…">) ----
  function hlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function hlSpan(cls, text) { return '<span class="tk-' + cls + '">' + hlEsc(text) + "</span>"; }
  const JS_KW = { const: 1, let: 1, var: 1, function: 1, return: 1, if: 1, else: 1, for: 1, while: 1, do: 1, switch: 1, case: 1, break: 1, continue: 1, new: 1, class: 1, extends: 1, super: 1, this: 1, import: 1, from: 1, export: 1, default: 1, async: 1, await: 1, yield: 1, try: 1, catch: 1, finally: 1, throw: 1, typeof: 1, instanceof: 1, in: 1, of: 1, delete: 1, void: 1, null: 1, undefined: 1, true: 1, false: 1, NaN: 1, Infinity: 1, static: 1, get: 1, set: 1, public: 1, private: 1, protected: 1, readonly: 1, interface: 1, type: 1, enum: 1, implements: 1, as: 1, keyof: 1, namespace: 1, declare: 1 };
  function hlJS(code) {
    let out = "", i = 0; const n = code.length;
    const isIdStart = function (c) { return /[A-Za-z_$]/.test(c); };
    const isId = function (c) { return /[A-Za-z0-9_$]/.test(c); };
    while (i < n) {
      const c = code[i];
      if (c === "/" && code[i + 1] === "/") { let j = i; while (i < n && code[i] !== "\n") i++; out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "/" && code[i + 1] === "*") { let j = i; i += 2; while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++; i = Math.min(n, i + 2); out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "'" || c === '"' || c === "`") { const q = c; let j = i; i++; while (i < n) { if (code[i] === "\\") { i += 2; continue; } if (code[i] === q) { i++; break; } i++; } out += hlSpan("str", code.slice(j, i)); continue; }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] || ""))) { let j = i; while (i < n && /[0-9a-fA-FxXoObBeE._]/.test(code[i])) i++; out += hlSpan("num", code.slice(j, i)); continue; }
      if (isIdStart(c)) {
        let j = i; i++; while (i < n && isId(code[i])) i++; const word = code.slice(j, i);
        if (JS_KW[word]) { out += hlSpan("kw", word); }
        else { let k = i; while (k < n && /\s/.test(code[k])) k++; if (code[k] === "(") out += hlSpan("fn", word); else if (/^[A-Z]/.test(word)) out += hlSpan("cls", word); else out += hlEsc(word); }
        continue;
      }
      out += hlEsc(c); i++;
    }
    return out;
  }
  function hlHTML(code) {
    let out = "", i = 0; const n = code.length;
    while (i < n) {
      const c = code[i];
      if (c === "<" && code.slice(i, i + 4) === "<!--") { let j = i; i += 4; while (i < n && code.slice(i, i + 3) !== "-->") i++; i = Math.min(n, i + 3); out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "<") {
        out += hlEsc("<"); i++;
        if (code[i] === "/") { out += hlEsc("/"); i++; }
        let t = i; while (i < n && /[A-Za-z0-9-]/.test(code[i])) i++; if (i > t) out += hlSpan("tag", code.slice(t, i));
        while (i < n && code[i] !== ">") {
          if (code[i] === '"' || code[i] === "'") { const q = code[i]; let s = i; i++; while (i < n && code[i] !== q) i++; i = Math.min(n, i + 1); out += hlSpan("str", code.slice(s, i)); continue; }
          if (/[A-Za-z_:-]/.test(code[i])) { let a = i; while (i < n && /[A-Za-z0-9_:-]/.test(code[i])) i++; out += hlSpan("attr", code.slice(a, i)); continue; }
          out += hlEsc(code[i]); i++;
        }
        if (code[i] === ">") { out += hlEsc(">"); i++; }
        continue;
      }
      let s = i; while (i < n && code[i] !== "<") i++; out += hlEsc(code.slice(s, i));
    }
    return out;
  }
  function hlGeneric(code, hashComment) {
    let out = "", i = 0; const n = code.length;
    while (i < n) {
      const c = code[i];
      if (hashComment && c === "#") { let j = i; while (i < n && code[i] !== "\n") i++; out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "/" && code[i + 1] === "/") { let j = i; while (i < n && code[i] !== "\n") i++; out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "/" && code[i + 1] === "*") { let j = i; i += 2; while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++; i = Math.min(n, i + 2); out += hlSpan("com", code.slice(j, i)); continue; }
      if (c === "'" || c === '"' || c === "`") { const q = c; let j = i; i++; while (i < n) { if (code[i] === "\\") { i += 2; continue; } if (code[i] === q) { i++; break; } i++; } out += hlSpan("str", code.slice(j, i)); continue; }
      if (/[0-9]/.test(c)) { let j = i; while (i < n && /[0-9a-fA-Fx._%#]/.test(code[i])) i++; out += hlSpan("num", code.slice(j, i)); continue; }
      out += hlEsc(c); i++;
    }
    return out;
  }
  function highlightCode(code, lang) {
    if (lang === "js" || lang === "jsx" || lang === "ts" || lang === "tsx" || lang === "json") return hlJS(code);
    if (lang === "html" || lang === "xml") return hlHTML(code);
    if (lang === "py" || lang === "sh" || lang === "yaml") return hlGeneric(code, true);
    if (lang === "css") return hlGeneric(code, false);
    return hlEsc(code);
  }

  // ---- Extract the artifacts from an answer; large code blocks -> cards, small ones stay inline ----
  function artTitleFrom(before, code, lang) {
    const h = String(before || "").match(/(?:^|\n)#{1,6}\s+([^\n]+?)\s*$/);
    if (h) return h[1].replace(/[*_`#]+/g, "").trim();
    const cm = String(code).split("\n").slice(0, 3).join("\n").match(/(?:\/\/|#|<!--|\/\*)\s*([A-Za-z][^\n*<>]{2,58})/);
    if (cm) return cm[1].trim();
    const fn = String(code).match(/(?:function|const|class|def)\s+([A-Za-z_$][\w$]*)/);
    if (fn) return fn[1];
    return artPretty(lang);
  }
  function artQualifies(code) { return code.replace(/\s+$/, "").split("\n").length >= 5 || code.length >= 180; }
  // Artifact glyph – shared by the card and the panel header.
  const ART_GLYPH = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.25781 1.94746C8.37347 0.729082 11.0535 1.53497 12.5107 3.57051C12.9081 4.12616 12.6733 4.83755 12.1543 5.13692L10.585 6.04121H13.6201C14.2116 6.04121 14.6911 6.52105 14.6914 7.1125V12.9758C14.6912 13.5673 14.2117 14.0471 13.6201 14.0471H9.44629C8.85475 14.047 8.3752 13.5673 8.375 12.9758V7.31367L6.3877 8.45821C6.96126 9.05227 7.31436 9.86033 7.31445 10.7512C7.31439 12.5754 5.83494 14.0549 4.01074 14.0549C2.18685 14.0545 0.708072 12.5751 0.708008 10.7512C0.708192 8.92732 2.18692 7.4488 4.01074 7.44844C4.09475 7.44844 4.17831 7.45204 4.26074 7.45821C3.64258 5.34694 4.35849 3.04139 6.25781 1.94746ZM4.01074 8.69844C2.87728 8.6988 1.95819 9.61767 1.95801 10.7512C1.95807 11.8848 2.87721 12.8045 4.01074 12.8049C5.14458 12.8049 6.06439 11.885 6.06445 10.7512C6.06427 9.61745 5.14451 8.69844 4.01074 8.69844ZM9.625 12.7971H13.4414V7.29121H9.625V12.7971ZM11.377 4.1418C10.2115 2.6588 8.29686 2.21574 6.88184 3.03047C5.46682 3.84544 4.88807 5.72438 5.58594 7.47676L11.377 4.1418Z" fill="currentColor"></path></svg>';
  function artCardInner(title, writing) {
    return '<span class="jv-artifact-glyph" aria-hidden="true">' + ART_GLYPH + "</span>"
      + '<div class="jv-artifact-info"><div class="jv-artifact-title">' + hlEsc(title) + "</div>"
      + '<div class="jv-artifact-sub">' + hlEsc(tr(writing ? "art.writing" : "art.subtitle")) + "</div></div>"
      + '<div class="jv-artifact-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>';
  }
  function artCardHtml(id, title, writing) {
    return '<div class="jv-artifact-card' + (writing ? " is-writing" : "") + '" role="button" tabindex="0" data-aid="' + id + '" aria-label="' + hlEsc(tr("art.open")) + '">' + artCardInner(title, writing) + "</div>";
  }
  // Card as a DOM element (for appending later with tool-generated code) – shares the open logic.
  function makeArtifactCard(id, title) {
    const card = el("div", "jv-artifact-card");
    card.setAttribute("role", "button"); card.setAttribute("tabindex", "0");
    card.setAttribute("data-aid", id); card.setAttribute("aria-label", tr("art.open"));
    card.innerHTML = artCardInner(title);
    const open = function () { openArtifactById(id, card); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return card;
  }
  function openArtifactById(id, card) { const a = ART_STORE[id]; if (a) openArtifact(a, card); }

  // An artifact can have multiple files (website: index.html + style.css + script.js).
  function artFileLang(name) { return artNormLang(String(name || "").split(".").pop()); }
  function artAutoPreview(code, lang) {
    if (lang === "html" || lang === "xml" || /<!doctype html|<html[\s>]|<body[\s>]|<svg[\s>]/i.test(code)) return makeWebsitePreview(code);
    return null;
  }
  // Merge HTML/CSS/JS into ONE standalone preview document (linked .css/.js are inlined).
  function makeWebsitePreview(html, css, js) {
    let doc = String(html || "");
    if (css) {
      if (/<link\b[^>]*\.css[^>]*>/i.test(doc)) doc = doc.replace(/<link\b[^>]*\.css[^>]*>/i, "<style>" + css + "</style>");
      else if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, "<style>" + css + "</style></head>");
      else doc = "<style>" + css + "</style>" + doc;
    }
    if (js) {
      if (/<script\b[^>]*\.js[^>]*>\s*<\/script>/i.test(doc)) doc = doc.replace(/<script\b[^>]*\.js[^>]*>\s*<\/script>/i, "<script>" + js + "</script>");
      else if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, "<script>" + js + "</script></body>");
      else doc = doc + "<script>" + js + "</script>";
    }
    if (!/<!doctype|<html\b/i.test(doc)) doc = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + doc;
    return doc;
  }
  function registerArtifact(obj) {
    const id = ART_ID++;
    const files = (obj.files && obj.files.length) ? obj.files : [{ name: "", lang: obj.lang || "text", code: obj.code || "" }];
    ART_STORE[id] = { id: id, title: obj.title || artPretty(files[0].lang), files: files, previewDoc: (obj.previewDoc != null ? obj.previewDoc : artAutoPreview(files[0].code, files[0].lang)) };
    return id;
  }
  // Append the card below the current answer (for tool-generated code: website/file).
  function appendArtifactCard(id) {
    const a = ART_STORE[id]; if (!a) return;
    const host = activeTurn && activeTurn.body; if (!host) return;
    host.appendChild(makeArtifactCard(id, a.title));
    scrollToEnd();
  }

  // Artifacts created during streaming, keyed by the code-block ordinal of the current turn.
  // renderAnswerHtml reuses them when finalizing -> no duplicate artifacts,
  // card and panel show the same object. Reset: start of chatStreamOnce / end of ask().
  let streamArts = [];
  function renderAnswerHtml(acc) {
    const src = String(acc || ""); let out = "", last = 0; const arts = [];
    const re = /```([^\n]*)\n([\s\S]*?)```/g; let m; let ord = 0;
    while ((m = re.exec(src))) {
      const before = src.slice(last, m.index);
      const lang = artNormLang(m[1]);
      const code = m[2].replace(/\n$/, "");
      last = re.lastIndex;
      out += mdToHtml(before);
      if (artQualifies(code)) {
        const title = artTitleFrom(before, code, lang);
        const ent = streamArts[ord];
        let id;
        if (ent) { // update the live-streamed artifact with the final state
          id = ent.id;
          const a = ART_STORE[id];
          a.title = title;
          a.files = [{ name: "", lang: lang, code: code }];
          a.previewDoc = artAutoPreview(code, lang);
        } else {
          id = registerArtifact({ title: title, files: [{ name: "", lang: lang, code: code }] });
        }
        arts.push(id);
        out += artCardHtml(id, title);
      } else {
        out += mdToHtml("```" + m[1] + "\n" + code + "\n```");
      }
      ord++;
    }
    out += mdToHtml(src.slice(last));
    return { html: out, artifacts: arts };
  }
  // Replaces md.innerHTML = mdToHtml(acc): renders the answer AND wires up the artifact cards.
  function renderAnswer(mdEl, acc) {
    mdEl.innerHTML = renderAnswerHtml(acc).html;
    wireArtifactCards(mdEl);
  }
  function wireArtifactCards(mdEl) {
    mdEl.querySelectorAll(".jv-artifact-card").forEach(function (card) {
      const id = card.getAttribute("data-aid");
      const open = function () { openArtifactById(id, card); };
      card.addEventListener("click", open);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  // ---- Live rendering during streaming: text into the bubble, code into the panel ----------
  // The bubble shows ONLY text; qualifying code blocks (artQualifies, also applied to the
  // partial state) appear as a "Writing …" card, their content streams
  // character by character into the right panel (which opens automatically on the first block). Still-small,
  // open blocks stay invisible until they qualify or close small (then inline).
  function renderStreaming(out, acc) {
    const src = String(acc || "");
    const re = /```([^\n]*)\n([\s\S]*?)(```|$)/g;
    let html = "", last = 0, m, ord = 0;
    while ((m = re.exec(src))) {
      const before = src.slice(last, m.index);
      const lang = artNormLang(m[1]);
      const closed = m[3] === "```";
      const code = closed ? m[2].replace(/\n$/, "") : m[2];
      last = re.lastIndex;
      html += mdToHtml(before);
      if (artQualifies(code)) {
        let ent = streamArts[ord];
        if (!ent) {
          const id = registerArtifact({ title: artTitleFrom(before, code, lang), files: [{ name: "", lang: lang, code: code }] });
          ent = streamArts[ord] = { id: id, opened: false };
        }
        const a = ART_STORE[ent.id];
        a.files[0].code = code;
        a.files[0].lang = lang;
        if (closed) a.previewDoc = artAutoPreview(code, lang);
        html += artCardHtml(ent.id, a.title, !closed);
        if (!ent.opened) { ent.opened = true; openArtifact(a, null); }
        else if (artPanel) artPanel.streamTo(a);
      } else if (closed) {
        html += mdToHtml("```" + m[1] + "\n" + code + "\n```");
      }
      ord++;
    }
    html += mdToHtml(src.slice(last));
    out.innerHTML = html;
    wireArtifactCards(out);
  }

  // ---- Panel (singleton, lazy) ----
  let artPanel = null;
  function openArtifact(a, card) {
    if (!artPanel) artPanel = buildArtifactPanel();
    document.querySelectorAll(".jv-artifact-card.is-active").forEach(function (c) { c.classList.remove("is-active"); });
    if (card) card.classList.add("is-active");
    artPanel.open(a);
  }
  function buildArtifactPanel() {
    const root = el("aside", "jv-art");
    root.setAttribute("data-open", "false");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("role", "complementary");
    // Header
    // Header: glyph + title + byline on the left; Code/Preview + Refresh + Close on the right.
    const head = el("div", "jv-art-head");
    const idwrap = el("div", "jv-art-id");
    const glyph = el("span", "jv-art-glyph"); glyph.setAttribute("aria-hidden", "true"); glyph.innerHTML = ART_GLYPH;
    const name = el("span", "jv-art-name");
    const sub = el("span", "jv-art-sub"); sub.textContent = tr("art.byline");
    idwrap.append(glyph, name, sub);
    const tabs = el("div", "jv-art-tabs"); tabs.setAttribute("role", "tablist");
    const ind = el("span", "jv-art-tab-ind"); ind.setAttribute("aria-hidden", "true");
    const tabCode = el("button", "jv-art-tab is-on", tr("art.tab_code")); tabCode.type = "button"; tabCode.dataset.tab = "code"; tabCode.setAttribute("role", "tab");
    const tabPrev = el("button", "jv-art-tab", tr("art.tab_preview")); tabPrev.type = "button"; tabPrev.dataset.tab = "preview"; tabPrev.setAttribute("role", "tab");
    tabs.append(ind, tabCode, tabPrev);
    const refreshBtn = el("button", "jv-art-ico jv-art-refresh"); refreshBtn.type = "button"; refreshBtn.setAttribute("aria-label", tr("art.refresh")); refreshBtn.title = tr("art.refresh"); refreshBtn.innerHTML = HI("restart", { size: 15 });
    const closeBtn = el("button", "jv-art-ico"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", tr("art.collapse")); closeBtn.title = tr("art.collapse"); closeBtn.innerHTML = HI("x", { size: 15 });
    const headRight = el("div", "jv-art-headright"); headRight.append(tabs, refreshBtn, closeBtn);
    head.append(idwrap, headRight);
    // File bar (visible only with multiple files, e.g. website: index.html · style.css · script.js)
    const fileBar = el("div", "jv-art-files"); fileBar.setAttribute("hidden", "");
    // Body
    const scroll = el("div", "jv-art-scroll");
    const codeView = el("div", "jv-art-view jv-art-code");
    const gutter = el("div", "jv-art-gutter"); gutter.setAttribute("aria-hidden", "true");
    const pre = el("pre", "jv-art-pre"); const codeEl = document.createElement("code"); pre.appendChild(codeEl);
    codeView.append(gutter, pre);
    const prevView = el("div", "jv-art-view jv-art-preview"); prevView.setAttribute("hidden", "");
    scroll.append(codeView, prevView);
    root.append(head, fileBar, scroll);
    document.body.appendChild(root);

    let current = null, activeFile = 0, tab = "code", previewDirty = true, copyT = 0;
    function curFile() { return current && current.files[activeFile]; }
    function positionInd() {
      const on = tabs.querySelector(".jv-art-tab.is-on");
      if (!on) return;
      ind.style.width = on.offsetWidth + "px";
      ind.style.transform = "translateX(" + (on.offsetLeft - tabCode.offsetLeft) + "px)";
    }
    function renderFiles() {
      fileBar.innerHTML = "";
      if (!current || current.files.length <= 1) { fileBar.setAttribute("hidden", ""); return; }
      fileBar.removeAttribute("hidden");
      current.files.forEach(function (f, idx) {
        const b = el("button", "jv-art-file" + (idx === activeFile ? " is-on" : ""), f.name || artPretty(f.lang));
        b.type = "button";
        b.addEventListener("click", function () { if (idx === activeFile) return; activeFile = idx; renderFiles(); renderCode(); });
        fileBar.appendChild(b);
      });
    }
    function renderCode() {
      const f = curFile(); if (!f) return;
      const body = String(f.code).replace(/\n$/, "");
      const lines = body.split("\n");
      const w = Math.max(2, String(lines.length).length);
      gutter.textContent = lines.map(function (_, k) { return String(k + 1).padStart(w, "0"); }).join("\n");
      codeEl.innerHTML = highlightCode(body, f.lang);
    }
    function renderPreview() {
      prevView.innerHTML = "";
      if (current && current.previewDoc) {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("title", "preview");
        frame.srcdoc = current.previewDoc;
        prevView.appendChild(frame);
      } else {
        const f = curFile();
        const box = el("div", "jv-art-empty");
        const ic = el("div", ""); ic.innerHTML = HI("terminal", { size: 30 });
        box.append(ic, el("div", "jv-art-empty-t", tr("art.no_preview", { lang: artPretty(f ? f.lang : "text") })), el("div", "jv-art-empty-s", tr("art.no_preview_hint")));
        prevView.appendChild(box);
      }
      previewDirty = false;
    }
    function setTab(t) {
      tab = t;
      tabCode.classList.toggle("is-on", t === "code");
      tabPrev.classList.toggle("is-on", t === "preview");
      tabCode.setAttribute("aria-selected", String(t === "code"));
      tabPrev.setAttribute("aria-selected", String(t === "preview"));
      positionInd();
      if (t === "preview") { if (previewDirty) renderPreview(); prevView.removeAttribute("hidden"); codeView.setAttribute("hidden", ""); }
      else { codeView.removeAttribute("hidden"); prevView.setAttribute("hidden", ""); }
    }
    function open(a) {
      current = a; activeFile = 0; previewDirty = true;
      name.textContent = a.title;
      void root.offsetWidth; // force reflow -> the slide-in also animates on the first (lazy) open
      root.setAttribute("data-open", "true"); root.setAttribute("aria-hidden", "false");
      document.documentElement.classList.add("jv-artifact-open");
      renderFiles();
      renderCode();
      setTab("code");
      // After it becomes visible, position the pill exactly (offsetWidth is only correct then).
      requestAnimationFrame(positionInd);
    }
    function close() {
      root.setAttribute("data-open", "false"); root.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("jv-artifact-open");
      document.querySelectorAll(".jv-artifact-card.is-active").forEach(function (c) { c.classList.remove("is-active"); });
    }
    closeBtn.addEventListener("click", close);
    tabCode.addEventListener("click", function () { setTab("code"); });
    tabPrev.addEventListener("click", function () { setTab("preview"); });
    refreshBtn.addEventListener("click", function () {
      if (!current) return;
      renderCode(); previewDirty = true; if (tab === "preview") renderPreview();
      refreshBtn.classList.remove("is-spin"); void refreshBtn.offsetWidth; refreshBtn.classList.add("is-spin");
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && root.getAttribute("data-open") === "true") close(); });
    window.addEventListener("resize", function () { if (root.getAttribute("data-open") === "true") positionInd(); });
    // Live streaming: redraw the code of the currently open artifact and scroll along —
    // but only if the user is "stuck" at the bottom anyway (otherwise don't yank them out of reading).
    function streamTo(a) {
      if (current !== a) return;
      const nearBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 48;
      renderCode();
      previewDirty = true;
      if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    }
    return { root: root, open: open, close: close, streamTo: streamTo };
  }

  // ---------- AI answer as a transcript entry (NO card; like the original) ----------
  const TB_COPY = HI("copy", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  const TB_PIN = HI("pin", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  const TB_EDIT = HI("edit", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  const TB_RESTART = HI("restart", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  const TB_SPEAK = HI("play", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  // Pause icon (two bars) – the read-aloud button switches to it while speaking.
  const TB_PAUSE = HI("pause", { style: "width:var(--class-small-icon);height:var(--class-small-icon)" });
  // Background span of the icon buttons (hover/active), shared by turnToolBtn + icon swap.
  const TB_SQUISH = '<span aria-hidden="true" class="btn-squish"></span>';
  // Relative time ("now" / "X minutes ago"), updates itself; tooltip = absolute date.
  const relTimes = [];
  let relTimer = 0;
  function fmtRel(date) {
    const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    const de = lang === "de";
    if (s < 60) return de ? "jetzt" : "now";
    const m = Math.floor(s / 60);
    if (m < 60) return de ? ("vor " + m + (m === 1 ? " Minute" : " Minuten")) : (m + " min ago");
    const h = Math.floor(m / 60);
    if (h < 24) return de ? ("vor " + h + (h === 1 ? " Stunde" : " Stunden")) : (h + (h === 1 ? " hr ago" : " hrs ago"));
    const d = Math.floor(h / 24);
    return de ? ("vor " + d + (d === 1 ? " Tag" : " Tagen")) : (d + (d === 1 ? " day ago" : " days ago"));
  }
  function registerRelTime(elm) {
    const date = new Date();
    try {
      elm.setAttribute("datetime", date.toISOString());
      elm.title = date.toLocaleString(lang === "de" ? "de-DE" : "en-US", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    } catch (e) {}
    elm.textContent = fmtRel(date);
    relTimes.push({ el: elm, date: date });
    if (!relTimer) {
      relTimer = setInterval(function () {
        for (let k = 0; k < relTimes.length; k++) {
          if (relTimes[k].el.isConnected) relTimes[k].el.textContent = fmtRel(relTimes[k].date);
        }
      }, 30000);
    }
  }

  function turnToolBtn(svg, label, onClick) {
    const b = el("button", "jarvis-turn-btn");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.innerHTML = TB_SQUISH + svg;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  // Toggle the read-aloud button between play (▷) and pause (⏸).
  function setSpeakBtnState(btn, playing) {
    if (!btn) return;
    btn.innerHTML = TB_SQUISH + (playing ? TB_PAUSE : TB_SPEAK);
    btn.classList.toggle("jarvis-speaking", playing); // keeps the hover look until done
    btn.setAttribute("aria-label", playing ? tr("read.stop") : tr("read.aloud"));
    btn.setAttribute("aria-pressed", playing ? "true" : "false");
  }
  // Reset the currently active read-aloud button (if any) back to play.
  function resetSpeakBtn() {
    if (activeSpeakBtn) { setSpeakBtnState(activeSpeakBtn, false); activeSpeakBtn = null; }
  }
  // Assistant entry. Footer: while thinking "✳ Ns" (live), afterwards toolbar (hover) + relative time.
  function addAssistantTurn() {
    hideWelcome();
    const article = el("div", "jarvis-turn pb-[var(--chat-turn-gap)]");
    article.setAttribute("role", "article");
    const msg = el("div", "group/msg relative flex flex-col w-full");
    const h2 = el("h2", "sr-only select-none", tr("turn.answered"));
    const contentWrap = el("div", "flex flex-col gap-[var(--chat-item-gap)] select-text");
    const body = el("div", "");
    contentWrap.appendChild(body);

    const foot = el("div", "jarvis-turn-foot flex items-center gap-g2 pt-[4px]");
    foot.dataset.state = "done";
    const thinking = el("span", "jarvis-thinking");
    thinking.innerHTML = '<span class="jarvis-thinking-t">0s</span>';
    const tools = el("div",
      "jarvis-turn-toolbar flex gap-g2 opacity-0 pointer-events-none group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto");
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", tr("aria.msg_actions"));
    const speakBtn = turnToolBtn(TB_SPEAK, tr("read.aloud"), function (e) {
      const b = e.currentTarget;
      if (activeSpeakBtn === b) { stopSpeak(); return; } // currently running → stop
      const t = body.textContent || "";
      if (t) speak(t, b);
    });
    tools.append(
      turnToolBtn(TB_COPY, "Copy message", function () {
        try { if (navigator.clipboard) navigator.clipboard.writeText(body.textContent || ""); } catch (e) {}
      }),
      turnToolBtn(TB_PIN, "Pin as chapter", function (e) {
        const b = e.currentTarget;
        b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
      }),
      speakBtn
    );
    const time = el("time", "jarvis-rel text-footnote text-t6 tabular-nums self-center pl-p1");
    tools.appendChild(time); // time is part of the hover toolbar (like the original)
    foot.append(thinking, tools);
    msg.append(h2, contentWrap, foot);
    article.appendChild(msg);
    wrap.appendChild(article);
    scrollToEnd();

    let t0 = 0, timer = 0;
    function startThinking() {
      foot.dataset.state = "thinking";
      t0 = Date.now();
      const tick = function () {
        thinking.querySelector(".jarvis-thinking-t").textContent = Math.round((Date.now() - t0) / 1000) + "s";
      };
      tick();
      timer = setInterval(tick, 1000);
    }
    function finish() {
      if (timer) { clearInterval(timer); timer = 0; }
      foot.dataset.state = "done";
      registerRelTime(time);
    }
    return { article: article, body: body, h2: h2, speakBtn: speakBtn, startThinking: startThinking, finish: finish };
  }
  // Simple assistant text entry (no streaming) – for notices.
  function addAssistantText(text) {
    const turn = addAssistantTurn();
    const md = el("div", "epitaxy-markdown");
    renderAnswer(md, text);
    turn.body.appendChild(md);
    turn.h2.textContent = tr("turn.jarvis") + text;
    turn.finish();
    return turn;
  }
  function scrollToEnd() { scrollC.scrollTop = scrollC.scrollHeight; }
  // Status pill removed: the identity chip shows the state (setAssistant); errors appear in the transcript.
  // The function stays as a no-op (many callers); error texts go to the log for diagnostics.
  function setStatus(state, text) {
    if (state === "error" && text) { try { console.warn("[Oddvark]", text); } catch (e) {} }
  }
  // Place a menu (position:fixed in the body) flush above the anchor – ZOOM-SAFE.
  // Trap under html{zoom:1.25}: getBoundingClientRect()/innerWidth return VISUAL px
  // (=layout×zoom), but style.left/top get scaled by ×zoom again on render. So
  // use ONLY left/top (purely anchor-rect based, ÷zoom) instead of bottom/right with viewport
  // math (which is unreliable under zoom → shifted dropdowns). Menu size via
  // offsetWidth/Height (layout px, independent of zoom AND the fade-in transform).
  function placeFixedMenu(menu, anchor, align) {
    if (!anchor) return;
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.right = menu.style.bottom = "";
    let left = (align === "right") ? (r.right / z - w) : (r.left / z);
    let top = (r.top / z) - h - 6; // 6px layout gap above the trigger
    left = Math.max(8, Math.min(left, window.innerWidth / z - w - 8)); // keep within the viewport
    top = Math.max(8, top);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function getInputText() {
    let t;
    if (input.querySelector("[data-cmd]")) {
      // Command chips (plus menu) carry the slash command in data-cmd – the label doesn't count.
      const c = input.cloneNode(true);
      c.querySelectorAll("[data-cmd]").forEach(function (n) {
        n.replaceWith(document.createTextNode(n.getAttribute("data-cmd") + " "));
      });
      t = c.textContent || "";
    } else {
      t = input.textContent || "";
    }
    return t.replace(/ /g, " ").trim();
  }
  function inputPlaceholder() { return tr("composer.placeholder_jarvis"); }
  function clearInput() {
    input.innerHTML =
      '<p class="is-empty is-editor-empty" data-placeholder="' + inputPlaceholder() + '"><br class="ProseMirror-trailingBreak"></p>';
    updateSendBtn();
  }
  function setInputText(t) {
    input.innerHTML = "<p>" + escapeHtml(t) + "</p>";
    updateSendBtn();
  }
  // Put the slash command into the input field as a colored chip card (plus menu: image/web search).
  // contenteditable=false -> Backspace deletes the card as a whole. Label without "/";
  // getInputText() translates the card back into the slash command via data-cmd.
  const CMD_CHIPS = {
    "/bild": { ico: "image", cls: "is-bild", key: "cmd.image" },
    "/web": { ico: "globe", cls: "is-web", key: "cmd.web" },
  };
  // Remove an existing command chip (+ the following space). Returns data-cmd (or "").
  function removeCmdChip() {
    const chip = input.querySelector(".jarvis-cmd-chip[data-cmd]");
    if (!chip) return "";
    const was = chip.getAttribute("data-cmd");
    const nx = chip.nextSibling;
    if (nx && nx.nodeType === 3 && /^[\s ]*$/.test(nx.textContent || "")) nx.remove();
    chip.remove();
    return was;
  }
  function prefillCommand(cmd) {
    const c = CMD_CHIPS[cmd] || { ico: "terminal", cls: "", key: "" };
    // Toggle: same command already active -> remove (text stays). Different -> swap.
    const prev = removeCmdChip();
    if (prev === cmd) { syncInputEmpty(); focusInputEnd(); return; }
    // Do NOT delete existing text: insert it into the existing paragraph.
    let p = input.querySelector("p");
    if (!p) { input.innerHTML = "<p></p>"; p = input.querySelector("p"); }
    p.classList.remove("is-empty", "is-editor-empty");
    const br = p.querySelector("br.ProseMirror-trailingBreak");
    if (br) br.remove();
    const chip = el("span", "jarvis-cmd-chip" + (c.cls ? " " + c.cls : ""));
    chip.setAttribute("contenteditable", "false");
    chip.setAttribute("data-cmd", cmd);
    const rmLbl = tr("cmd.remove").replace(/"/g, "&quot;");
    chip.innerHTML = HI(c.ico, { size: 13 }) + "<span>" + (c.key ? tr(c.key) : cmd.slice(1)) + "</span>" +
      '<span class="jarvis-cmd-x" role="button" tabindex="-1" aria-label="' + rmLbl + '" title="' + rmLbl + '">' + HI("x", { size: 11 }) + "</span>";
    // Chip at the START of the paragraph, followed by a space; existing text follows.
    p.insertBefore(document.createTextNode(" "), p.firstChild);
    p.insertBefore(chip, p.firstChild);
    updateSendBtn();
    focusInputEnd();
  }
  // Hover-X on the command chip: removes the /bild or /web chip again (then NO
  // web search/image generation is applied). mousedown + preventDefault so focus/selection
  // in the contenteditable aren't disturbed.
  input.addEventListener("mousedown", function (e) {
    const x = e.target.closest && e.target.closest(".jarvis-cmd-x");
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    const chip = x.closest(".jarvis-cmd-chip");
    if (!chip) return;
    const next = chip.nextSibling;
    if (next && next.nodeType === 3 && /^[\s ]*$/.test(next.textContent || "")) next.remove(); // space after the chip
    chip.remove();
    syncInputEmpty();
    focusInputEnd();
  });
  // Focus the input field, put the cursor at the end.
  function focusInputEnd() {
    input.focus();
    const sel = window.getSelection();
    if (sel) {
      const rng = document.createRange();
      rng.selectNodeContents(input);
      rng.collapse(false);
      sel.removeAllRanges();
      sel.addRange(rng);
    }
  }
  // Send arrow: bright + clickable ONLY when there is text in the field (the scaffold starts it `disabled`).
  // Removing disabled → Tailwind switches from text-uncontained-disabled (dark) to -default (bright);
  // the click handler (submit) then fires again too.
  function updateSendBtn() {
    if (!sendBtn) return;
    const has = !!getInputText();
    sendBtn.disabled = !has;
    sendBtn.style.cursor = has ? "pointer" : "";
  }
  // Scaffold without a React/ProseMirror runtime: nothing removes the
  // `is-editor-empty` class while typing → the placeholder (CSS `p.is-editor-empty:first-child::before`)
  // would remain. So toggle it ourselves, depending on the content.
  function syncInputEmpty() {
    const empty = !getInputText();
    updateSendBtn();
    let p = input.querySelector("p");
    if (empty) {
      if (!p) { clearInput(); return; } // structure collapsed (everything deleted) → restore
      p.classList.add("is-empty", "is-editor-empty");
      p.setAttribute("data-placeholder", inputPlaceholder());
    } else {
      input.querySelectorAll("p.is-empty, p.is-editor-empty").forEach(function (el) {
        el.classList.remove("is-empty", "is-editor-empty");
      });
    }
  }
  function updateModelLabel() {
    if (modelLabelSpan) modelLabelSpan.textContent = model || "Ollama";
  }
  // Clamp the effort value to the valid range 0..5, invalid -> default 3 ("Extra").
  function clampEffort(v) {
    if (!Number.isFinite(v)) return 3;
    return Math.max(0, Math.min(5, Math.round(v)));
  }
  // Short "pop" animation (fade + blur + slight lift) for the level words.
  function popAnim(elm) {
    if (!elm) return;
    try {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      elm.animate(
        [
          { opacity: 0, filter: "blur(4px)", transform: "translateY(3px)" },
          { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" },
        ],
        { duration: 260, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
      );
    } catch (e) {}
  }
  // Set the text of the bottom "Extra" button to the current level (purple for Ultracode).
  function updateEffortLabel(animate) {
    if (!effortLabelSpan) return;
    const t = tr("effort." + effort);
    const changed = effortLabelSpan.textContent !== t;
    effortLabelSpan.textContent = t;
    effortLabelSpan.style.color = effort === 5 ? "var(--extended-purple)" : "";
    if (animate && changed) popAnim(effortLabelSpan);
  }
  // Set the text of the "Auto" button to the short text of the active mode (+ color via MODE_COLORS).
  function updateModeLabel(animate) {
    if (!modeLabelSpan) return;
    const m = MODES.find(function (x) { return x.value === mode; }) || MODES.find(function (x) { return x.value === "auto"; });
    const shortLabel = tr("mode." + m.value + ".short");
    const changed = modeLabelSpan.textContent !== shortLabel;
    modeLabelSpan.textContent = shortLabel;
    modeLabelSpan.style.color = MODE_COLORS[m.value] || "";
    if (modeBtn) modeBtn.style.backgroundColor = MODE_BG[m.value] || ""; // tint the background area too
    if (animate && changed) popAnim(modeLabelSpan);
  }

  // ---------- Mode menu (app-style popup on the "Auto" button, left-aligned upward) ----------
  function buildModeMenu(btn, onPick) {
    const CHECK = HI("check", { size: 16 });

    const menu = el("div", "jv-modelmenu jv-mm-left");
    menu.setAttribute("role", "menu");
    menu.setAttribute("tabindex", "-1");
    menu.setAttribute("data-open", "false");
    const surface = el("div", "jv-mm-surface bg-surface-popover");
    surface.setAttribute("aria-hidden", "true");
    const scroll = el("div", "jv-mm-scroll");
    const head = el("div", "jv-mm-head", tr("menu.mode"));
    const list = el("div", "jv-mm-list");
    scroll.append(head, list);
    menu.append(surface, scroll);
    document.body.appendChild(menu);

    let selected = "auto", activeIdx = -1;
    const items = MODES.map(function (m, i) {
      const it = el("div", "jv-mm-item");
      it.setAttribute("role", "menuitemradio");
      it.dataset.value = m.value;
      it.innerHTML =
        '<span class="jv-mm-name"></span>' +
        '<span class="jv-mm-check">' + CHECK + "</span>";
      it.querySelector(".jv-mm-name").textContent = tr("mode." + m.value);
      it.addEventListener("click", function () { choose(m.value); });
      it.addEventListener("mousemove", function () { setActive(i); });
      list.appendChild(it);
      return it;
    });

    function setActive(i) {
      activeIdx = (i + items.length) % items.length;
      items.forEach(function (e, k) { e.classList.toggle("is-active", k === activeIdx); });
      items[activeIdx].scrollIntoView({ block: "nearest" });
    }
    function setSelected(v) {
      selected = v;
      items.forEach(function (it) { it.setAttribute("aria-checked", String(it.dataset.value === v)); });
    }
    function choose(v) { setSelected(v); close(); if (btn) btn.focus(); if (onPick) onPick(v); }
    function isOpen() { return menu.getAttribute("data-open") === "true"; }
    function place() {
      placeFixedMenu(menu, btn, "left");
    }
    function open() {
      if (isOpen()) return;
      if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu();
      closeOpenMenu = close;
      place();
      menu.setAttribute("data-open", "true");
      if (btn) btn.setAttribute("aria-expanded", "true");
      const s = MODES.findIndex(function (m) { return m.value === selected; });
      setActive(s >= 0 ? s : 0);
      menu.focus();
    }
    function close() {
      if (!isOpen()) return;
      menu.setAttribute("data-open", "false");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
    if (btn) {
      btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open(); }, true);
    }
    menu.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(activeIdx + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0) choose(MODES[activeIdx].value);
      } else if (e.key === "Escape") {
        e.preventDefault(); close(); if (btn) btn.focus();
      } else if (/^[1-3]$/.test(e.key)) {
        e.preventDefault(); choose(MODES[parseInt(e.key, 10) - 1].value);
      }
    });
    document.addEventListener("click", function (e) {
      if (isOpen() && !menu.contains(e.target) && !(btn && btn.contains(e.target))) close();
    });
    menu.addEventListener("mouseleave", function () {
      activeIdx = -1;
      items.forEach(function (e) { e.classList.remove("is-active"); });
    });
    window.addEventListener("resize", function () { if (isOpen()) place(); });

    return { setSelected: setSelected };
  }

  // ---------- Plus menu (app-style popup on the "+" button, same style as the mode menu) ----------
  // Actions instead of a selection: create image (/bild), web search (/web), attach photos & files (upload).
  function buildPlusMenu(btn) {
    const ACTIONS = [
      { label: tr("plus.image"), ico: "image", run: function () { prefillCommand("/bild"); } },
      { label: tr("plus.websearch"), ico: "globe", run: function () { prefillCommand("/web"); } },
      { label: tr("plus.attach"), ico: "file", run: function () { fileInput.value = ""; fileInput.click(); } },
    ];
    const menu = el("div", "jv-modelmenu jv-mm-left");
    menu.setAttribute("role", "menu");
    menu.setAttribute("tabindex", "-1");
    menu.setAttribute("data-open", "false");
    menu.setAttribute("aria-label", tr("aria.add"));
    const surface = el("div", "jv-mm-surface bg-surface-popover");
    surface.setAttribute("aria-hidden", "true");
    const scroll = el("div", "jv-mm-scroll");
    const list = el("div", "jv-mm-list");
    scroll.append(list);
    menu.append(surface, scroll);
    document.body.appendChild(menu);

    let activeIdx = -1;
    const items = ACTIONS.map(function (a, i) {
      const it = el("div", "jv-mm-item");
      it.setAttribute("role", "menuitem");
      it.innerHTML =
        '<span class="jv-mm-ico">' + HI(a.ico, { size: 16 }) + "</span>" +
        '<span class="jv-mm-name"></span>';
      it.querySelector(".jv-mm-name").textContent = a.label;
      it.addEventListener("click", function () { choose(i); });
      it.addEventListener("mousemove", function () { setActive(i); });
      list.appendChild(it);
      return it;
    });

    function setActive(i) {
      activeIdx = (i + items.length) % items.length;
      items.forEach(function (e, k) { e.classList.toggle("is-active", k === activeIdx); });
    }
    function choose(i) { close(); ACTIONS[i].run(); }
    function isOpen() { return menu.getAttribute("data-open") === "true"; }
    function place() { placeFixedMenu(menu, btn, "left"); }
    function open() {
      if (isOpen()) return;
      if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu();
      closeOpenMenu = close;
      place();
      menu.setAttribute("data-open", "true");
      btn.setAttribute("aria-expanded", "true");
      setActive(0);
      menu.focus();
    }
    function close() {
      if (!isOpen()) return;
      menu.setAttribute("data-open", "false");
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open(); }, true);
    menu.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(activeIdx + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0) choose(activeIdx);
      } else if (e.key === "Escape") {
        e.preventDefault(); close(); btn.focus();
      } else if (/^[1-3]$/.test(e.key)) {
        e.preventDefault(); choose(parseInt(e.key, 10) - 1);
      }
    });
    document.addEventListener("click", function (e) {
      if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close();
    });
    menu.addEventListener("mouseleave", function () {
      activeIdx = -1;
      items.forEach(function (e) { e.classList.remove("is-active"); });
    });
    window.addEventListener("resize", function () { if (isOpen()) place(); });
  }

  // ---------- Oddvark identity (footer): orb + name + live status, click -> settings ----------
  function buildIdentityChip() {
    const ARROW = HI("chevRight", { size: 16 });
    // Oddvark logo as the brand avatar (viewBox centered on the content; IDs namespaced).
    const LOGO =
      '<svg viewBox="88 45 300 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      "<defs>" +
      '<linearGradient id="jvl-main" x1="124" y1="103" x2="330" y2="305" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#20242c"/><stop offset="0.55" stop-color="#1a1e26"/><stop offset="1" stop-color="#171b22"/></linearGradient>' +
      '<linearGradient id="jvl-blue" x1="96" y1="260" x2="156" y2="320" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#5d83ff"/><stop offset="1" stop-color="#4169f4"/></linearGradient>' +
      '<linearGradient id="jvl-blue2" x1="303" y1="69" x2="345" y2="111" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#5c82ff"/><stop offset="1" stop-color="#4169f4"/></linearGradient>' +
      "</defs>" +
      '<rect x="96" y="260" width="60" height="61" rx="10" fill="url(#jvl-blue)"/>' +
      '<path fill="url(#jvl-main)" fill-rule="evenodd" d="M 257 103 C 262 103 264 106 264 112 L 264 131 C 264 144 271 151 284 151 L 313 151 C 322 151 327 157 327 166 L 327 247 C 327 279 303 301 276 301 L 180 301 C 174 301 170 297 170 291 L 170 273 C 170 265 165 260 157 260 L 140 260 C 132 260 127 254 127 246 L 127 193 C 127 143 166 103 216 103 Z M 198 153 C 184 153 176 162 176 176 L 176 226 C 176 240 184 249 198 249 L 249 249 C 263 249 271 240 271 226 L 271 176 C 271 162 263 153 249 153 Z"/>' +
      '<rect x="303" y="69" width="42" height="42" rx="8" fill="url(#jvl-blue2)"/>' +
      '<rect x="345" y="119" width="35" height="36" rx="6.5" fill="url(#jvl-main)"/>' +
      "</svg>";

    // Build the chip and replace the account button.
    const chip = el("button", "jv-id");
    chip.type = "button";
    chip.setAttribute("aria-haspopup", "dialog");
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-label", tr("aria.jarvis_status"));
    chip.dataset.state = "connecting";
    const logo = el("span", "jv-id-logo");
    logo.setAttribute("aria-hidden", "true");
    logo.innerHTML = LOGO;
    const name = el("span", "jv-id-name", "Oddvark");
    const statusWrap = el("span", "jv-id-status");
    const sdot = el("span", "jv-id-dot");
    sdot.setAttribute("aria-hidden", "true");
    const sstate = el("span", "jv-id-state", tr("state.connecting"));
    statusWrap.append(sdot, sstate);
    chip.append(logo, name, statusWrap);

    const acct =
      document.getElementById("base-ui-_r_f5_") ||
      document.querySelector('[data-testid="user-menu-button"]');
    if (acct) acct.replaceWith(chip);
    else return { setState: function () {}, syncSettings: function () {} };

    // Settings popover – same style as the other dropdowns, left-aligned upward.
    const menu = el("div", "jv-modelmenu jv-mm-left jv-settings");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", tr("menu.settings"));
    menu.setAttribute("tabindex", "-1");
    menu.setAttribute("data-open", "false");
    const surface = el("div", "jv-mm-surface bg-surface-popover");
    surface.setAttribute("aria-hidden", "true");
    const scroll = el("div", "jv-mm-scroll");
    const head = el("div", "jv-mm-head", "Oddvark");
    const list = el("div", "jv-mm-list");
    scroll.append(head, list);
    menu.append(surface, scroll);
    document.body.appendChild(menu);

    const voiceItem = el("div", "jv-mm-item");
    voiceItem.setAttribute("role", "menuitemcheckbox");
    voiceItem.innerHTML =
      '<span class="jv-mm-name"></span>' +
      '<span class="jv-switch" aria-hidden="true"><span class="jv-switch-knob"></span></span>';
    const voiceSwitch = voiceItem.querySelector(".jv-switch");
    const voiceName = voiceItem.querySelector(".jv-mm-name");

    const langItem = el("div", "jv-mm-item");
    langItem.setAttribute("role", "menuitem");
    langItem.setAttribute("aria-haspopup", "menu");
    langItem.setAttribute("aria-expanded", "false");
    langItem.innerHTML =
      '<span class="jv-mm-name"></span><span class="jv-mm-val"></span>' +
      '<span class="jv-mm-caret">' + ARROW + "</span>";
    const langVal = langItem.querySelector(".jv-mm-val");
    const langName = langItem.querySelector(".jv-mm-name");

    const sep = el("div", "jv-mm-sep");
    sep.setAttribute("role", "separator");

    const modelsItem = el("div", "jv-mm-item jv-mm-add");
    modelsItem.setAttribute("role", "menuitem");
    modelsItem.innerHTML =
      '<span class="jv-mm-name"></span><span class="jv-mm-ico">' + ARROW + "</span>";
    const modelsName = modelsItem.querySelector(".jv-mm-name");

    list.append(voiceItem, langItem, sep, modelsItem);

    // Language submenu (flyout to the right of the "Language" row; stays open while the
    // settings popover is open – so NOT via closeOpenMenu, but tied to its lifetime).
    const CHECK = HI("check", { size: 16 });
    const langMenu = el("div", "jv-modelmenu jv-submenu");
    langMenu.setAttribute("role", "menu");
    langMenu.setAttribute("tabindex", "-1");
    langMenu.setAttribute("data-open", "false");
    const lmSurface = el("div", "jv-mm-surface bg-surface-popover");
    lmSurface.setAttribute("aria-hidden", "true");
    const lmScroll = el("div", "jv-mm-scroll");
    const lmList = el("div", "jv-mm-list");
    lmScroll.appendChild(lmList);
    langMenu.append(lmSurface, lmScroll);
    // Append into the popover (same zoom context) and place it via position:absolute relative to
    // the row -> no zoom-dependent viewport math needed.
    menu.appendChild(langMenu);

    const langOptEls = LANGS.map(function (l) {
      const it = el("div", "jv-mm-item");
      it.setAttribute("role", "menuitemradio");
      it.dataset.code = l.code;
      it.innerHTML = '<span class="jv-mm-name"></span><span class="jv-mm-check">' + CHECK + "</span>";
      it.querySelector(".jv-mm-name").textContent = tr("lang." + l.code);
      it.addEventListener("click", function (e) { e.stopPropagation(); chooseLang(l.code); });
      it.addEventListener("mousemove", function () {
        langOptEls.forEach(function (x) { x.classList.remove("is-active"); });
        it.classList.add("is-active");
      });
      lmList.appendChild(it);
      return it;
    });
    langMenu.addEventListener("mouseleave", function () {
      langOptEls.forEach(function (x) { x.classList.remove("is-active"); });
    });

    function markLang() {
      langOptEls.forEach(function (it) { it.setAttribute("aria-checked", String(it.dataset.code === lang)); });
    }
    function langOpen() { return langMenu.getAttribute("data-open") === "true"; }
    function placeLang() {
      // Relative to the popover (offsetParent): left:100% via CSS, align the bottom edge with the "Language"
      // row and grow upward. All in the same zoom context -> no scaling math.
      langMenu.style.left = "";
      langMenu.style.bottom = "";
      const top = langItem.offsetTop + langItem.offsetHeight - langMenu.offsetHeight;
      langMenu.style.top = Math.round(top) + "px";
    }
    function openLang() {
      if (langOpen()) return;
      markLang();
      placeLang();
      langMenu.setAttribute("data-open", "true");
      langItem.setAttribute("aria-expanded", "true");
      langItem.classList.add("is-active");
    }
    function closeLang() {
      if (!langOpen()) return;
      langMenu.setAttribute("data-open", "false");
      langItem.setAttribute("aria-expanded", "false");
    }
    function chooseLang(code) {
      lang = code;
      localStorage.setItem(LS_LANG, lang);
      syncVoiceToLang();   // adjust the selected voice to the new language if needed (overlay dropdown filters on open)
      if (window.JV_I18N) JV_I18N.setLang(lang); // switch the UI language (en/de)
      refresh();
      closeLang();
    }

    function refresh() {
      voiceSwitch.classList.toggle("is-on", voiceOut);
      voiceItem.setAttribute("aria-checked", String(voiceOut));
      menu.setAttribute("aria-label", tr("menu.settings"));
      voiceName.textContent = tr("menu.voice");
      langName.textContent = tr("menu.language");
      modelsName.textContent = tr("menu.manage_models");
      langVal.textContent = tr("lang." + lang);
      langOptEls.forEach(function (it) { it.querySelector(".jv-mm-name").textContent = tr("lang." + it.dataset.code); });
    }

    voiceItem.addEventListener("click", function () {
      voiceOut = !voiceOut;
      localStorage.setItem(LS_VOICE, voiceOut ? "1" : "0");
      if (!voiceOut) stopSpeak();
      renderVoiceTgl();
      refresh();
    });
    langItem.addEventListener("click", function (e) {
      e.stopPropagation();
      langOpen() ? closeLang() : openLang();
    });
    modelsItem.addEventListener("click", function () { close(); window.location.href = "models.html"; });

    const rows = [voiceItem, langItem, modelsItem];
    rows.forEach(function (it) {
      it.addEventListener("mousemove", function () {
        rows.forEach(function (e) { e.classList.remove("is-active"); });
        it.classList.add("is-active");
      });
    });
    menu.addEventListener("mouseleave", function () {
      rows.forEach(function (e) { e.classList.remove("is-active"); });
    });

    function isOpen() { return menu.getAttribute("data-open") === "true"; }
    function place() {
      placeFixedMenu(menu, chip, "left");
    }
    function open() {
      if (isOpen()) return;
      if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu();
      closeOpenMenu = close;
      refresh();
      place();
      menu.setAttribute("data-open", "true");
      chip.setAttribute("aria-expanded", "true");
      menu.focus();
    }
    function close() {
      if (!isOpen()) return;
      closeLang();
      menu.setAttribute("data-open", "false");
      chip.setAttribute("aria-expanded", "false");
    }
    chip.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open();
    }, true);
    menu.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (langOpen()) { closeLang(); menu.focus(); }
        else { close(); chip.focus(); }
      }
    });
    document.addEventListener("click", function (e) {
      // Close the language submenu when clicking outside it AND outside the "Language" row.
      if (langOpen() && !langMenu.contains(e.target) && !langItem.contains(e.target)) closeLang();
      // Close the settings popover when clicking outside the popover, chip, and submenu.
      if (isOpen() && !menu.contains(e.target) && !chip.contains(e.target) && !langMenu.contains(e.target)) close();
    });
    window.addEventListener("resize", function () { if (isOpen()) place(); if (langOpen()) placeLang(); });

    function setState(s) {
      chip.dataset.state = s;
      sstate.textContent = tr("state." + s);
    }
    // On UI language change: relabel the current status + aria-label.
    function relabel() { chip.setAttribute("aria-label", tr("aria.jarvis_status")); setState(chip.dataset.state || "connecting"); refresh(); }

    refresh();
    return { setState: setState, syncSettings: refresh, relabel: relabel };
  }

  // ---------- Model menu (app-style popup on the bottom button) ----------
  function buildModelMenu(btn, onPick, onAdd) {
    const CHECK = HI("check", { size: 16 });
    const PLUS = HI("plus", { size: 16 });
    const MAX = 4;

    const menu = el("div", "jv-modelmenu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("tabindex", "-1");
    menu.setAttribute("data-open", "false");
    const surface = el("div", "jv-mm-surface bg-surface-popover");
    surface.setAttribute("aria-hidden", "true");
    const scroll = el("div", "jv-mm-scroll");
    const head = el("div", "jv-mm-head", tr("menu.models"));
    const list = el("div", "jv-mm-list");
    scroll.append(head, list);
    menu.append(surface, scroll);
    document.body.appendChild(menu);

    let selected = null, opts = [], activeIdx = -1;

    function items() { return Array.prototype.slice.call(list.querySelectorAll(".jv-mm-item")); }
    function setActive(i) {
      const els = items();
      if (!els.length) return;
      activeIdx = (i + els.length) % els.length;
      els.forEach((e, k) => e.classList.toggle("is-active", k === activeIdx));
      els[activeIdx].scrollIntoView({ block: "nearest" });
    }
    function setOptions(names) {
      opts = names.slice(); // show ALL installed models (the list is scrollable)
      list.innerHTML = "";
      opts.forEach((n, i) => {
        const it = el("div", "jv-mm-item");
        it.setAttribute("role", "menuitemradio");
        it.dataset.value = n;
        it.innerHTML =
          '<span class="jv-mm-name"></span>' +
          '<span class="jv-mm-check">' + CHECK + "</span>";
        it.querySelector(".jv-mm-name").textContent = n;
        it.addEventListener("click", () => choose(n));
        it.addEventListener("mousemove", () => setActive(items().indexOf(it)));
        list.appendChild(it);
      });
      // Separator
      const sep = el("div", "jv-mm-sep");
      sep.setAttribute("role", "separator");
      list.appendChild(sep);
      // "Add model" (label via i18n)
      const add = el("div", "jv-mm-item jv-mm-add");
      add.setAttribute("role", "menuitem");
      add.dataset.action = "add";
      add.innerHTML =
        '<span class="jv-mm-name"></span>' +
        '<span class="jv-mm-ico">' + PLUS + "</span>";
      add.querySelector(".jv-mm-name").textContent = tr("menu.add_model");
      add.addEventListener("click", () => activate(add));
      add.addEventListener("mousemove", () => setActive(items().indexOf(add)));
      list.appendChild(add);
      setSelected(selected);
    }
    function setSelected(v) {
      selected = v;
      items().forEach((it) => {
        if (it.dataset.action !== "add") it.setAttribute("aria-checked", String(it.dataset.value === v));
      });
    }
    function choose(n) { close(); if (onPick) onPick(n); }
    function activate(elm) {
      if (!elm) return;
      if (elm.dataset.action === "add") { close(); if (onAdd) onAdd(); }
      else choose(elm.dataset.value);
    }
    function isOpen() { return menu.getAttribute("data-open") === "true"; }
    function place() {
      placeFixedMenu(menu, btn, "right");
    }
    function open() {
      if (isOpen() || !opts.length) return;
      if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu();
      closeOpenMenu = close;
      place();
      menu.setAttribute("data-open", "true");
      if (btn) btn.setAttribute("aria-expanded", "true");
      // Highlight the selected entry (by data-value, robust against the extra "Auto" entry)
      const els = items();
      let sel = -1;
      els.forEach((e2, k) => { if (e2.dataset.value === selected) sel = k; });
      setActive(sel >= 0 ? sel : 0);
      menu.focus();
    }
    function close() {
      if (!isOpen()) return;
      menu.setAttribute("data-open", "false");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }

    if (btn) {
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open(); }, true);
    }
    menu.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(activeIdx + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const els = items();
        if (activeIdx >= 0 && els[activeIdx]) activate(els[activeIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault(); close(); if (btn) btn.focus();
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < opts.length) { e.preventDefault(); choose(opts[idx]); }
      }
    });
    document.addEventListener("click", (e) => {
      if (isOpen() && !menu.contains(e.target) && !(btn && btn.contains(e.target))) close();
    });
    // When the mouse leaves the menu, remove the (mouse) highlight again
    menu.addEventListener("mouseleave", () => {
      activeIdx = -1;
      items().forEach((e) => e.classList.remove("is-active"));
    });
    window.addEventListener("resize", () => { if (isOpen()) place(); });

    return { setOptions: setOptions, setSelected: setSelected };
  }

  // ---------- Energy animation: gray grid everywhere + scattered, blurred purple cells ----------
  // Runs in the fill of the effort slider, but only at Ultracode. Encapsulated: start/stop/resize.
  function createEnergyAnimation(cv) {
    const ctx = cv.getContext("2d");
    const config = { cellSize: 2.5, gap: 1.5 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0, height = 0, raf = 0, running = false, ro = null;

    // Adjust the backing store to the LAYOUT size (clientWidth is transform-independent).
    function fit() {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (w <= 0 || h <= 0) return false;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
      width = w; height = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }
    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

    function draw(time) {
      // dark background
      const bg = ctx.createLinearGradient(0, 0, width, 0);
      bg.addColorStop(0, "#272929"); bg.addColorStop(0.4, "#242525"); bg.addColorStop(1, "#1f1f24");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      const pitch = config.cellSize + config.gap;
      const size = config.cellSize;
      // Gray/purple cells everywhere, each cell its own phase + several directions -> no leftward drift; blurred.
      for (let y = pitch / 2; y < height + pitch; y += pitch) {
        for (let x = pitch / 2; x < width + pitch; x += pitch) {
          const ci = Math.round(x / pitch), cj = Math.round(y / pitch);
          const seed = Math.sin(ci * 12.9898 + cj * 78.233) * 43758.5453;
          const cellPhase = (seed - Math.floor(seed)) * Math.PI * 2;
          const n =
            Math.sin(x * 0.10 + time * 1.0) +
            Math.sin(y * 0.45 - time * 0.8) +
            Math.sin((x + y) * 0.07 + time * 1.5) +
            Math.sin((x - y) * 0.06 - time * 1.2) +
            Math.sin(cellPhase + time * 2.0) * 1.5;
          let p = (n / 5.5) * 0.5 + 0.5;          // 0..1
          p = clamp((p - 0.34) / 0.5, 0, 1);       // contrast: many gray, some purple
          const r = Math.round(88 + (150 - 88) * p);
          const g = Math.round(87 + (120 - 87) * p);
          const b = Math.round(100 + (245 - 100) * p);
          const alpha = 0.3 + p * 0.55;            // gray visible, purple brighter
          ctx.fillStyle = "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
    function frame(ms) {
      if (!running) return;
      draw(ms / 1000);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      if (!fit()) return;
      if (!ro && typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(function () { fit(); }); ro.observe(cv); }
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    return { start: start, stop: stop, resize: fit };
  }

  // ---------- Effort menu (app-style popup on the bottom "Extra" button) ----------
  function buildEffortMenu(btn, onChange) {
    const MIN = 0, MAX = 5, TOP = 5; // TOP = Ultracode (purple special state)
    const INFO = HI("info", { size: 14 });

    let value = 3; // overwritten via setValue()
    let lastLevel = null; // for the word animation on level change

    // --- Build (el() helper, append to document.body) ---
    const menu = el("div", "jv-effort");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Effort");
    menu.setAttribute("tabindex", "-1");
    menu.setAttribute("data-open", "false");

    const surface = el("div", "jv-ef-surface bg-surface-popover");
    surface.setAttribute("aria-hidden", "true");

    const body = el("div", "jv-ef-body");

    // Header: title + level label (+ decorative info button)
    const head = el("div", "jv-ef-head");
    const title = el("h2", "jv-ef-title", tr("menu.effort"));
    const levelLabel = el("span", "jv-ef-level");
    const info = el("button", "jv-ef-info");
    info.type = "button";
    info.tabIndex = -1;
    info.setAttribute("aria-hidden", "true");
    info.innerHTML = INFO;
    head.append(title, levelLabel, info);

    // End labels: "Faster" on the left, "Smarter" on the right
    const ends = el("div", "jv-ef-ends");
    ends.append(el("span", "jv-ef-end", tr("effort.faster")), el("span", "jv-ef-end", tr("effort.smarter")));

    // Slider: track + fill + 6 dots + handle + hidden <input type=range> (a11y/keyboard)
    const track = el("div", "jv-ef-track");
    const fill = el("div", "jv-ef-fill");
    // Energy animation in the fill – runs only at Ultracode (see syncEnergy()).
    const energyCanvas = el("canvas", "jv-ef-energy");
    fill.appendChild(energyCanvas);
    const energy = createEnergyAnimation(energyCanvas);
    const handle = el("div", "jv-ef-handle");
    const dots = [];
    for (let i = MIN; i <= MAX; i++) {
      const d = el("span", "jv-ef-dot");
      d.dataset.step = String(i);
      dots.push(d);
    }
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(MIN);
    range.max = String(MAX);
    range.step = "1";
    range.className = "jv-ef-range";
    range.setAttribute("aria-label", tr("menu.effort"));
    track.append(fill, range);
    dots.forEach((d) => track.appendChild(d));
    track.appendChild(handle);

    body.append(head, ends, track);
    menu.append(surface, body);
    document.body.appendChild(menu);

    // --- Adjust the presentation to the value (fill, handle, dots, labels, persistence) ---
    // Position within the inset area (14px margin) – congruent with the dots,
    // so the handle sits exactly on the dot at every level (including "Low" = first dot).
    const INSET = 14;
    const HANDLE_W = 14;
    function posExpr(v) { return "calc(" + INSET + "px + (100% - " + (2 * INSET) + "px) * " + (v / MAX) + ")"; }
    function paint() {
      const ultra = value === TOP;
      // While dragging, fill/handle follow the pointer 1:1 (paintDrag) – don't touch the position here.
      // Ultracode: pill flush to the right edge (fill full); otherwise exactly on the dot (inset).
      if (!dragging) {
        if (ultra) {
          fill.style.width = "100%";
          handle.style.left = "calc(100% - " + (HANDLE_W / 2) + "px)";
        } else {
          const p = posExpr(value);
          fill.style.width = p;
          handle.style.left = p;
        }
      }
      dots.forEach((d, i) => d.classList.toggle("is-on", i <= value));
      const label = tr("effort." + value);
      levelLabel.textContent = label;
      if (label !== lastLevel) {
        if (lastLevel !== null) popAnim(levelLabel);
        lastLevel = label;
      }
      // Ultracode: purple special state via data-top-stop on the slider root.
      if (ultra) menu.setAttribute("data-top-stop", "");
      else menu.removeAttribute("data-top-stop");
      levelLabel.classList.toggle("is-top", ultra);
      // Keep range/a11y in sync.
      range.value = String(value);
      range.setAttribute("aria-valuetext", label);
      syncEnergy();
    }
    // Run the energy animation only at Ultracode AND when the popup is open (otherwise save CPU).
    function syncEnergy() {
      if (value === TOP && isOpen()) {
        energyCanvas.style.display = "block";
        energy.resize();
        energy.start();
      } else {
        energy.stop();
        energyCanvas.style.display = "none";
      }
    }
    // Set the value, optionally report the change (persistence + trigger label via onChange).
    function set(v, emit) {
      v = Math.max(MIN, Math.min(MAX, Math.round(v)));
      const changed = v !== value;
      value = v;
      paint();
      if (emit && changed && onChange) onChange(value);
    }
    // Initial value without onChange (prevents writing during setup).
    function setValue(v) { set(Number(v), false); }

    // Pixel position -> ratio 0..1 within the inset area (continuous, for smooth dragging).
    function ratioFromClientX(clientX) {
      const r = track.getBoundingClientRect();
      const usable = r.width - 2 * INSET;
      if (usable <= 0) return value / MAX;
      return Math.max(0, Math.min(1, (clientX - r.left - INSET) / usable));
    }
    // Pixel position -> nearest level (snapping).
    function stepFromClientX(clientX) { return Math.round(ratioFromClientX(clientX) * MAX); }

    // --- Interaction ---
    // Dragging: fill/handle follow the pointer 1:1 (transitions off via [data-dragging]), only
    // label/dots/value snap live to the nearest level. On release the handle glides
    // smoothly to the level position with the normal CSS transition.
    let dragging = false, pendingDrag = false;
    function paintDrag(ratio) {
      const p = "calc(" + INSET + "px + (100% - " + (2 * INSET) + "px) * " + ratio + ")";
      fill.style.width = p;
      handle.style.left = p;
    }
    function moveDrag(e) {
      if (pendingDrag && !dragging) { dragging = true; menu.setAttribute("data-dragging", ""); } // a track click only becomes a drag on movement
      if (!dragging) return;
      const ratio = ratioFromClientX(e.clientX);
      paintDrag(ratio);
      set(Math.round(ratio * MAX), true);
    }
    function endDrag(e) {
      pendingDrag = false;
      if (!dragging) return;
      dragging = false;
      menu.removeAttribute("data-dragging");
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
      paint(); // glide smoothly to the level position
    }
    // Click on the track (or a dot) -> set the level (glides thanks to the transition); movement afterwards keeps dragging.
    track.addEventListener("pointerdown", (e) => {
      if (e.target === handle) return; // the handle has its own drag handling
      e.preventDefault();
      set(stepFromClientX(e.clientX), true);
      pendingDrag = true;
      try { track.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      menu.setAttribute("data-dragging", "");
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener("pointermove", moveDrag);
    track.addEventListener("pointermove", moveDrag);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);

    // Range input (arrow keys/keyboard) changes the value.
    range.addEventListener("input", () => set(Number(range.value), true));

    // --- Open/close (mirrored from buildModelMenu) ---
    function isOpen() { return menu.getAttribute("data-open") === "true"; }
    function place() {
      placeFixedMenu(menu, btn, "right");
    }
    function open() {
      if (isOpen()) return;
      if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu();
      closeOpenMenu = close;
      place();
      paint(); // compute layout-dependent positions only after place()
      menu.setAttribute("data-open", "true");
      if (btn) btn.setAttribute("aria-expanded", "true");
      // Focus the range input so arrow keys work immediately (Escape bubbles up to the menu).
      range.focus();
      syncEnergy(); // start the energy if applicable (isOpen() is now true)
    }
    function close() {
      if (!isOpen()) return;
      menu.setAttribute("data-open", "false");
      if (btn) btn.setAttribute("aria-expanded", "false");
      syncEnergy(); // stop the energy
    }

    if (btn) {
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open(); }, true);
    }
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); if (btn) btn.focus(); }
    });
    document.addEventListener("click", (e) => {
      if (isOpen() && !menu.contains(e.target) && !(btn && btn.contains(e.target))) close();
    });
    window.addEventListener("resize", () => { if (isOpen()) place(); });

    paint();
    return { setValue: setValue };
  }

  // ---------- Ollama ----------
  // Best available chat model as the default (instead of just the first): larger + capable family
  // + coder bonus (good for creating code/websites); local before cloud; vision/embed not as the chat default.
  function modelScore(name) {
    const n = String(name).toLowerCase();
    const m = n.match(/(\d+(?:\.\d+)?)\s*b\b/);
    let score = m ? parseFloat(m[1]) : 4;
    if (/qwen|llama|gemma|mistral|command|deepseek|phi|yi\b/.test(n)) score += 3;
    if (/coder|code/.test(n)) score += 2;
    if (/instruct|-it\b|chat/.test(n)) score += 1;
    if (/cloud/.test(n)) score -= 1000;
    if (/vl|vision|llava|embed|minilm|bge/.test(n)) score -= 100;
    return score;
  }
  function pickBestModel(list) {
    let best = list[0], bs = -Infinity;
    list.forEach(function (x) { const s = modelScore(x); if (s > bs) { bs = s; best = x; } });
    return best;
  }

  // ---------- Context-window protection: request num_ctx explicitly (no silent truncation) ----------
  const CTX_CAP = 65536;      // cap against absurd KV-cache allocations for huge windows
  const CTX_FALLBACK = 8192;  // conservative when /api/show returns nothing
  // Context window of a model (POST /api/show, cached once per model). Never throws.
  async function contextLength(name) {
    if (ctxLen[name]) return ctxLen[name];
    let v = 0;
    try {
      const r = await fetch(OLLAMA + "/api/show", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name }),
      });
      const j = await r.json();
      const info = (j && j.model_info) || {};
      for (const k in info) { if (/\.context_length$/.test(k)) { v = +info[k] || 0; break; } }
      if (j && Array.isArray(j.capabilities)) modelCaps[name] = j.capabilities; // e.g. ["completion","tools","thinking"]
    } catch (e) {}
    ctxLen[name] = v || CTX_FALLBACK;
    return ctxLen[name];
  }
  // Rough token estimate of the full chat payload (system prompt + RAG + the ENTIRE history).
  // chars/4 + a flat per-image amount, safety factor 1.15 — deliberately conservative (rather overestimate).
  function estimateChatTokens() {
    let chars = 0, images = 0;
    try { chars += systemPrompt().length; } catch (e) {}
    if (ragContext) chars += String(ragContext).length;
    messages.forEach(function (m) {
      chars += String(m.content || "").length + 8;
      if (m.images) images += m.images.length;
    });
    return Math.ceil((chars / 4 + images * 1100) * 1.15);
  }
  let connectRetry = 0; // timer of a scheduled reconnect attempt (max. one at a time)
  async function connect() {
    if (connectRetry) { clearTimeout(connectRetry); connectRetry = 0; }
    setStatus("busy", tr("status.connecting_ollama"));
    setAssistant("connecting");
    try {
      // Timeout: without it "Connecting …" would hang forever if no connection slot frees up
      // (e.g. the browser's limit of 6 connections per host due to downloads in other tabs).
      const r = await fetch(OLLAMA + "/api/tags", { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const names = (j.models || []).map((m) => m.name);
      if (!names.length) {
        setStatus("error", tr("status.no_model"));
        setAssistant("error");
        return;
      }
      // Exclude embed models (can't chat) from the chat model selection.
      const chatNames = names.filter((n) => !/embed|bge-|minilm|arctic/i.test(n));
      const list = chatNames.length ? chatNames : names;
      modelMenu.setOptions(list);
      if (!model || !list.includes(model)) model = pickBestModel(list);   // strongest local model as the default
      localStorage.setItem(LS_MODEL, model);
      modelMenu.setSelected(model);
      updateModelLabel();
      setStatus("ok", tr("status.connected"));
      setAssistant("ready");
    } catch (e) {
      setStatus("error", tr("status.ollama_down"));
      setAssistant("error");
      // Self-healing: retry every 8 s (Ollama still starting / slots free again).
      if (!connectRetry) connectRetry = setTimeout(function () { connectRetry = 0; connect(); }, 8000);
    }
  }

  // Effort -> Ollama options: higher level = smarter (lower temperature,
  // more tokens). temperature linear from 0.9 (Low) to 0.2 (Ultracode).
  // ---------- Notes & reminders ----------
  const LS_NOTES = "jarvis.notes";
  const LS_REMINDERS = "jarvis.reminders";
  function loadJSONArr(k) { try { const a = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  let notes = loadJSONArr(LS_NOTES);
  let reminders = loadJSONArr(LS_REMINDERS);
  const notesRenderers = []; // overlays (Customize + Notes) register their render function here
  function notifyNotes() { notesRenderers.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function saveNotes() { try { localStorage.setItem(LS_NOTES, JSON.stringify(notes)); } catch (e) {} notifyNotes(); }
  function saveReminders() { try { localStorage.setItem(LS_REMINDERS, JSON.stringify(reminders)); } catch (e) {} notifyNotes(); }
  function addNote(text) { const t = (text || "").trim(); if (!t) return false; notes.unshift({ t: t, ts: Date.now() }); saveNotes(); return true; }
  function addReminder(text, dueTs) { const t = (text || "").trim(); if (!t || !dueTs) return false; reminders.push({ t: t, at: dueTs }); saveReminders(); return true; }
  function checkReminders() {
    if (busy || currentUtter || currentAudio) return; // don't barge into a running generation/speech
    const now = Date.now(); const due = reminders.filter(function (r) { return r.at <= now; });
    if (!due.length) return;
    reminders = reminders.filter(function (r) { return r.at > now; });
    saveReminders();
    const texts = due.map(function (r) { return r.t; });
    const turn = addAssistantText(texts.length > 1 ? "**" + tr("notes.reminders_head") + "**\n- " + texts.join("\n- ") : "**" + tr("notes.reminder_head") + "** " + texts[0]);
    if (voiceOut) speak(tr("notes.reminder_head") + " " + texts.join(". "), turn && turn.speakBtn); // ONE speech for all due ones
    try { if (window.Notification && Notification.permission === "granted") texts.forEach(function (t) { new Notification(tr("notif.reminder"), { body: t }); }); } catch (e) {}
  }

  // ---------- Tools (tool calling via Ollama) ----------
  const TOOL_DEFS = [
    { type: "function", function: { name: "get_datetime", description: "Current date and time.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "calculate", description: "Evaluates a mathematical expression (basic arithmetic, parentheses, %).", parameters: { type: "object", properties: { expression: { type: "string", description: "e.g. (23*19)+5" } }, required: ["expression"] } } },
    { type: "function", function: { name: "web_search", description: "Searches the web for current information (local DuckDuckGo search, Wikipedia fallback).", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "get_weather", description: "Current weather for a location.", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } } },
    { type: "function", function: { name: "add_note", description: "Saves a note for the user.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
    { type: "function", function: { name: "add_reminder", description: "Creates a reminder in N minutes.", parameters: { type: "object", properties: { text: { type: "string" }, in_minutes: { type: "number" } }, required: ["text", "in_minutes"] } } },
  ];
  // ---------- Local capabilities (action server 7864) as further tools ----------
  function tdef(name, desc, props, req) { return { type: "function", function: { name: name, description: desc, parameters: { type: "object", properties: props, required: req || [] } } }; }
  TOOL_DEFS.push(
    tdef("open_website", "Opens a website/URL in the default browser.", { url: { type: "string" } }, ["url"]),
    tdef("open_app", "Opens a program on the PC (e.g. calculator, editor, explorer).", { name: { type: "string" } }, ["name"]),
    tdef("system_info", "Reads system state (CPU, RAM, battery, storage, time).", {}, []),
    tdef("see_screen", "Looks at the current screen and describes/answers.", { question: { type: "string" } }, []),
    tdef("set_volume", "Sets the system volume (0–100).", { level: { type: "number" } }, ["level"]),
    tdef("media_control", "Media control: playpause, next, prev, mute, volup, voldown.", { action: { type: "string" } }, ["action"]),
    tdef("power", "Power: lock, sleep, restart, shutdown (requires confirmation).", { action: { type: "string" } }, ["action"]),
    tdef("type_text", "Types text into the currently active application.", { text: { type: "string" } }, ["text"]),
    tdef("search_files", "Searches for files by name under a folder.", { query: { type: "string" }, root: { type: "string" } }, ["query"]),
    tdef("browse_page", "Reads the content of a web page and summarizes it.", { url: { type: "string" } }, ["url"]),
    tdef("send_email", "Sends an email (requires confirmation).", { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"]),
    tdef("run_computer_task", "Autonomously completes a multi-step PC task (sees the screen, controls mouse/keyboard). Requires confirmation.", { goal: { type: "string" } }, ["goal"]),
    tdef("create_website", "Creates a real website as files in the workspace folder and opens it in the browser. Provide the COMPLETE HTML code (and optionally CSS/JS).", { name: { type: "string", description: "folder/project name, e.g. 'cats-page'" }, html: { type: "string", description: "complete content of index.html" }, css: { type: "string" }, js: { type: "string" } }, ["name", "html"]),
    tdef("create_file", "Creates a file with arbitrary content in the workspace folder (e.g. a script or text document).", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    tdef("run_command", "Runs a shell command on the PC (requires confirmation) and returns the output.", { command: { type: "string" } }, ["command"]),
    tdef("open_path", "Opens a file or folder in the default program/explorer.", { path: { type: "string" } }, ["path"]),
    tdef("remember", "Permanently remembers an important fact about the user (name, preferences, context) – across sessions.", { fact: { type: "string" } }, ["fact"])
  );
  function safeCalc(expr) {
    const s = String(expr || "").replace(/,/g, ".");
    if (!/^[0-9+\-*/().%\seE]+$/.test(s)) throw new Error("invalid expression");
    const v = Function('"use strict";return (' + s + ")")(); // only numbers/operators allowed (validated above)
    if (typeof v !== "number" || !isFinite(v)) throw new Error("no result");
    return v;
  }
  // Real web search via the local search server (DuckDuckGo, tools/search-server.py, port 7863);
  // fallback: Wikipedia if the server isn't running. Returns [{title,url,snippet}].
  const SEARCH = "http://127.0.0.1:7863";
  let webSources = []; // sources for this turn – ask() shows them as a card below the answer
  async function searchWeb(query) {
    try {
      const r = await fetch(SEARCH + "/search?q=" + encodeURIComponent(query) + "&n=8");
      if (r.ok) {
        const j = await r.json();
        if (j.results && j.results.length) return j.results;
      }
    } catch (e) {} // search server not started -> Wikipedia
    const wiki = langCfg().code; // Wikipedia language follows the selected language
    const u = "https://" + wiki + ".wikipedia.org/w/api.php?action=query&list=search&srlimit=6&format=json&origin=*&srsearch=" + encodeURIComponent(query);
    const j = await (await fetch(u)).json();
    return ((j.query && j.query.search) || []).map(function (h) {
      return {
        title: h.title,
        url: "https://" + wiki + ".wikipedia.org/wiki/" + encodeURIComponent(String(h.title).replace(/ /g, "_")),
        snippet: String(h.snippet || "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " "),
      };
    });
  }
  async function toolWeb(query) {
    const res = await searchWeb(query);
    if (!res.length) return "No matches.";
    webSources.push.apply(webSources, res);
    return res.map(function (r, i) { return "[" + (i + 1) + "] " + r.title + " – " + r.url + "\n" + r.snippet; }).join("\n\n");
  }
  // Sources card below the answer (like Perplexity): favicon stack + "N sources",
  // clicking expands the list with clickable links.
  function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }
  function favImg(u) {
    const img = document.createElement("img");
    img.className = "jarvis-src-fav";
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = "https://icons.duckduckgo.com/ip3/" + domainOf(u) + ".ico";
    img.addEventListener("error", function () { img.style.visibility = "hidden"; });
    return img;
  }
  function renderSources(turn, sources) {
    const seen = {};
    const list = sources.filter(function (s) { if (!s.url || seen[s.url]) return false; seen[s.url] = 1; return true; });
    if (!list.length) return;
    // The pill sits in the footer toolbar between the read-aloud button and the time; the toolbar is
    // shown permanently for source turns (otherwise the sources would only be visible on hover).
    const tools = turn.speakBtn.parentNode;
    const time = tools.querySelector("time");
    tools.classList.add("jarvis-has-src");
    const pill = el("button", "jarvis-src-pill");
    pill.type = "button";
    pill.setAttribute("aria-expanded", "false");
    const icons = el("span", "jarvis-src-icons");
    list.slice(0, 3).forEach(function (s) { icons.appendChild(favImg(s.url)); });
    pill.appendChild(icons);
    pill.appendChild(el("span", "jarvis-src-count", list.length + " " + (list.length === 1 ? tr("src.one") : tr("src.many"))));
    tools.insertBefore(pill, time || null);
    // The list expands BELOW the footer (closed until the pill is clicked).
    const panel = el("div", "jarvis-src-list");
    panel.setAttribute("hidden", "");
    list.forEach(function (s, i) {
      const a = document.createElement("a");
      a.className = "jarvis-src-item";
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.style.animationDelay = Math.min(i * 30, 240) + "ms"; // short cascading entrance
      a.appendChild(favImg(s.url));
      const tw = el("span", "jarvis-src-text");
      const t = el("span", "jarvis-src-title"); t.textContent = s.title || s.url;
      const d = el("span", "jarvis-src-domain"); d.textContent = domainOf(s.url);
      tw.append(t, d);
      a.appendChild(tw);
      panel.appendChild(a);
    });
    tools.parentNode.insertAdjacentElement("afterend", panel); // after the footer (foot)
    pill.addEventListener("click", function () {
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
      pill.setAttribute("aria-expanded", String(open));
    });
  }
  async function toolWeather(loc) {
    const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=de&format=json&name=" + encodeURIComponent(loc))).json();
    const p = g.results && g.results[0];
    if (!p) return "Location not found.";
    const w = await (await fetch("https://api.open-meteo.com/v1/forecast?current=temperature_2m,wind_speed_10m,relative_humidity_2m&timezone=auto&latitude=" + p.latitude + "&longitude=" + p.longitude)).json();
    const c = w.current || {};
    return p.name + (p.country ? ", " + p.country : "") + ": " + c.temperature_2m + "°C, wind " + c.wind_speed_10m + " km/h, humidity " + c.relative_humidity_2m + "%.";
  }
  // ---------- Action-server integration (chips + confirmation in the current answer turn) ----------
  // activeTurn is set in ask() once the turn exists: { body, md }. Chips/confirm appear
  // ABOVE the streaming markdown (md), in the context of exactly the answer they belong to.
  let activeTurn = null;
  let pendingConfirm = null; // running confirmation dialog (for stopEverything/cancel)
  function addActionChip(label, icon, kind) {
    if (!activeTurn) return null;
    if (!activeTurn.chips) {
      activeTurn.chips = el("div", "jarvis-act-chips");
      activeTurn.body.insertBefore(activeTurn.chips, activeTurn.md); // above the answer
    }
    const c = el("span", "jarvis-act-chip");
    if (kind) c.setAttribute("data-kind", kind);
    c.innerHTML = HI(icon || "sparkle", { size: 14 });
    const sp = el("span", "", label || "");
    c.appendChild(sp);
    activeTurn.chips.appendChild(c);
    scrollToEnd();
    return c;
  }
  function setActionChip(c, label, kind) {
    if (!c) return;
    if (kind) c.setAttribute("data-kind", kind);
    if (label != null) { const s = c.querySelector("span"); if (s) s.textContent = label; }
  }
  // Confirmation dialog in the current turn (above the answer). Returns Promise<boolean>.
  function showConfirm(summary) {
    return new Promise(function (resolve) {
      const host = (activeTurn && activeTurn.body) || wrap;
      const box = el("div", "jarvis-act-confirm");
      box.appendChild(el("div", "jarvis-act-confirm-q", (summary || tr("act.default")) + tr("act.run_q")));
      const acts = el("div", "jarvis-act-confirm-actions");
      const yes = el("button", "jarvis-act-cbtn is-yes", tr("act.confirm")); yes.type = "button";
      const no = el("button", "jarvis-act-cbtn is-no", tr("act.cancel")); no.type = "button";
      acts.append(yes, no); box.appendChild(acts);
      if (activeTurn && activeTurn.md && activeTurn.md.parentNode === host) host.insertBefore(box, activeTurn.md);
      else host.appendChild(box);
      scrollToEnd();
      function done(ok) { pendingConfirm = null; try { box.remove(); } catch (e) {} resolve(ok); }
      yes.addEventListener("click", function () { done(true); });
      no.addEventListener("click", function () { done(false); });
      pendingConfirm = { yes: function () { done(true); }, no: function () { done(false); } };
    });
  }
  // Calls an action-server endpoint; handles {needs_confirm} transparently via showConfirm.
  function callAction(path, body, method) {
    let url = ACTIONS + path;
    const opt = { method: method || "POST", headers: { "Content-Type": "application/json" } };
    if (opt.method !== "GET") opt.body = JSON.stringify(body || {});
    else if (body) { const qs = Object.keys(body).map(function (k) { return k + "=" + encodeURIComponent(body[k]); }).join("&"); url += (url.indexOf("?") < 0 ? "?" : "&") + qs; }
    return fetch(url, opt).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.needs_confirm) {
        const proceed = function () {
          const b2 = Object.assign({}, body || {}, { confirm: true, token: j.token });
          return fetch(ACTIONS + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b2) }).then(function (r) { return r.json(); });
        };
        if (mode === "auto_run") return proceed(); // autonomous mode: run without asking
        return showConfirm(j.summary || ("Action “" + (j.action || path) + "”.")).then(function (ok) {
          if (!ok) return { _refused: true };
          return proceed();
        });
      }
      return j;
    });
  }
  // Runs an action, shows a chip (pending→done/error), and returns a short text for the model.
  async function actionCall(chipLabel, icon, fn) {
    const chip = addActionChip(chipLabel, icon, "pending");
    try {
      const res = await fn();
      if (res && res._refused) { setActionChip(chip, tr("act.cancelled"), "error"); return "Cancelled by the user."; }
      if (res && res.error) { setActionChip(chip, tr("act.error"), "error"); return "Error: " + res.error; }
      setActionChip(chip, null, "done");
      return typeof res === "string" ? res : (res && res.result != null ? String(res.result) : JSON.stringify(res));
    } catch (e) {
      setActionChip(chip, tr("act.server_offline"), "error");
      return "Action server not reachable (" + (e && e.message || e) + "). Is action-server.py running on 7864?";
    }
  }
  function fmtOk(msg) { return function (res) { if (res && res._refused) return { _refused: true }; if (res && res.error) return res; return msg; }; }
  function sysToText(j) {
    if (!j || j.error) return "System info not available.";
    const p = [];
    if (j.cpu_percent != null) p.push("CPU " + j.cpu_percent + "%");
    if (j.ram) p.push("RAM " + j.ram.used_gb + "/" + j.ram.total_gb + " GB");
    if (j.battery && j.battery.percent != null) p.push("Battery " + j.battery.percent + "%" + (j.battery.charging ? " (charging)" : ""));
    if (j.disk) p.push("Storage " + j.disk.free_gb + " GB free");
    return p.join(", ") + ".";
  }

  async function runTool(name, args) {
    args = args || {};
    if (name === "get_datetime") return new Date().toLocaleString(langCfg().bcp, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (name === "calculate") return String(safeCalc(args.expression));
    if (name === "web_search") return await toolWeb(args.query || "");
    if (name === "get_weather") return await toolWeather(args.location || "");
    if (name === "add_note") { addNote(args.text || ""); return "Note saved."; }
    if (name === "add_reminder") { const m = Number(args.in_minutes) || 0; if (m <= 0) return "Time missing."; addReminder(args.text || "", Date.now() + m * 60000); return "Reminder set in " + m + " minutes."; }
    // ----- Local capabilities via the action server (chip label via tr, tool result in English for the model) -----
    if (name === "open_website") return actionCall(tr("act.open_website"), "globe", function () { return callAction("/open_url", { url: args.url }).then(fmtOk("Opened: " + args.url)); });
    if (name === "open_app") return actionCall(tr("act.open_app"), "terminal", function () { return callAction("/open_app", { name: args.name }).then(fmtOk("Opened: " + args.name)); });
    if (name === "system_info") return actionCall(tr("act.system_info"), "info", function () { return callAction("/system_info", null, "GET").then(sysToText); });
    if (name === "see_screen") return actionCall(tr("act.see_screen"), "image", function () { return callAction("/see_screen", { question: args.question || "What is on the screen?" }).then(function (j) { return j.description || j.result || j.text || "No result."; }); });
    if (name === "set_volume") return actionCall(tr("act.volume"), "speakerOn", function () { return callAction("/set_volume", { level: args.level }).then(fmtOk("Volume set.")); });
    if (name === "media_control") return actionCall(tr("act.media"), "play", function () { return callAction("/media_key", { key: args.action }).then(fmtOk("OK.")); });
    if (name === "power") return actionCall(tr("act.power"), "zap", function () { return callAction("/power", { action: args.action }).then(fmtOk("Executed: " + args.action)); });
    if (name === "type_text") return actionCall(tr("act.type"), "edit", function () { return callAction("/type", { text: args.text }).then(fmtOk("Typed.")); });
    if (name === "search_files") return actionCall(tr("act.file_search"), "search", function () { return callAction("/search_files", { query: args.query, root: args.root || "", limit: 20 }, "GET").then(function (j) { return (j.results || j.files || []).join("\n") || "No matches."; }); });
    if (name === "browse_page") return actionCall(tr("act.read_page"), "book", function () { return callAction("/browse_page", { url: args.url }).then(function (j) { return j.title ? (j.title + "\n\n" + (j.text || "")) : (j.error || "No content."); }); });
    if (name === "send_email") return actionCall(tr("act.email"), "send", function () { return callAction("/send_email", { to: args.to, subject: args.subject, body: args.body }).then(fmtOk("Sent to " + args.to)); });
    if (name === "run_computer_task") return actionCall(tr("act.pc_task"), "sparkle", function () { return callAction("/agent_task", { goal: args.goal, max_steps: 6 }).then(function (j) { if (j && (j._refused || j.error)) return j; return j.summary || j.result || (j.steps ? j.steps.length + " steps executed." : "Done."); }); });
    // create_website / create_file: NO action chip – the artifact card (code + preview) is the representation.
    if (name === "create_website") {
      const files = [{ path: "index.html", content: args.html || ("<!doctype html><meta charset=utf-8><title>" + (args.name || "Website") + "</title><h1>" + (args.name || "Website") + "</h1>") }];
      if (args.css) files.push({ path: "style.css", content: args.css });
      if (args.js) files.push({ path: "script.js", content: args.js });
      return callAction("/create_project", { name: args.name || "website", files: files, open: true }).then(function (j) {
        if (j && j._refused) return "Cancelled by the user.";
        if (j && j.error) return "Error: " + j.error;
        try {
          const af = [{ name: "index.html", lang: "html", code: args.html || "" }];
          if (args.css) af.push({ name: "style.css", lang: "css", code: args.css });
          if (args.js) af.push({ name: "script.js", lang: "js", code: args.js });
          appendArtifactCard(registerArtifact({ title: args.name || "Website", files: af, previewDoc: makeWebsitePreview(args.html, args.css, args.js) }));
        } catch (e) {}
        return "Website created and opened in the browser: " + (j.dir || j.open_path || j.open_url || "");
      }).catch(function (e) { return "Action server not reachable (" + (e && e.message || e) + "). Is action-server.py running on 7864?"; });
    }
    if (name === "create_file") {
      return callAction("/write_file", { path: args.path, content: args.content || "", overwrite: true }).then(function (j) {
        if (j && j._refused) return "Cancelled by the user.";
        if (j && j.error) return "Error: " + j.error;
        try { const base = String(args.path || "file").split(/[\\/]/).pop(); appendArtifactCard(registerArtifact({ title: base, files: [{ name: base, lang: artFileLang(base), code: args.content || "" }] })); } catch (e) {}
        return "File created: " + (j.path || args.path) + " (" + (j.bytes || 0) + " bytes)";
      }).catch(function (e) { return "Action server not reachable (" + (e && e.message || e) + "). Is action-server.py running on 7864?"; });
    }
    if (name === "run_command") return actionCall(tr("act.run_command"), "terminal", function () { return callAction("/run_command", { command: args.command }).then(function (j) { if (j && (j._refused || j.error)) return j; return "Exit " + (j.returncode != null ? j.returncode : "?") + "\n" + ((j.stdout || "") + (j.stderr ? "\n" + j.stderr : "")).slice(0, 1500); }); });
    if (name === "open_path") return actionCall(tr("act.open"), "file", function () { return callAction("/open_path", { path: args.path }).then(function (j) { if (j && (j._refused || j.error)) return j; return "Opened: " + (j.opened || args.path); }); });
    if (name === "remember") {
      const chip = addActionChip(tr("act.remembered"), "note", "pending");
      const f = (args.fact || "").trim();
      if (!f) { setActionChip(chip, tr("act.nothing"), "done"); return "Nothing to remember."; }
      if (profile.memories.indexOf(f) === -1) { profile.memories.push(f); saveProfile(); }
      setActionChip(chip, null, "done");
      return "Remembered permanently: " + f;
    }
    return "Unknown tool.";
  }
  // ---------- Knowledge base (RAG): IndexedDB vector store + Ollama embeddings ----------
  const RAG_DB = "jarvis-rag";
  let ragContext = "";   // set per turn (in submit), cleared in ask()
  let ragDB = null;
  function ragOpen() {
    return new Promise(function (resolve, reject) {
      if (ragDB) return resolve(ragDB);
      const req = indexedDB.open(RAG_DB, 1);
      req.onupgradeneeded = function () { const db = req.result; if (!db.objectStoreNames.contains("chunks")) { const s = db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true }); s.createIndex("doc", "doc", { unique: false }); } };
      req.onsuccess = function () { ragDB = req.result; resolve(ragDB); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function ragStore(mode) { const db = await ragOpen(); return db.transaction("chunks", mode).objectStore("chunks"); }
  function ragEmbedModel() { return profile.embedModel || "nomic-embed-text"; }
  async function ragEmbed(inputs) {
    const r = await fetch(OLLAMA + "/api/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: ragEmbedModel(), input: inputs }) });
    if (!r.ok) { let m = "Embed HTTP " + r.status; try { const j = JSON.parse(await r.text()); if (j.error) m = j.error; } catch (e) {} throw new Error(m); }
    return (await r.json()).embeddings || [];
  }
  function ragChunk(text, size, overlap) {
    size = size || 900; overlap = overlap || 150;
    const paras = String(text).replace(/\r/g, "").split(/\n\s*\n/);
    const chunks = []; let cur = "";
    paras.forEach(function (p) { p = p.trim(); if (!p) return; if (cur && (cur.length + p.length + 2) > size) { chunks.push(cur); cur = cur.slice(Math.max(0, cur.length - overlap)); } cur = cur ? cur + "\n\n" + p : p; });
    if (cur.trim()) chunks.push(cur);
    const out = []; chunks.forEach(function (c) { if (c.length <= size * 1.6) out.push(c); else for (let i = 0; i < c.length; i += size) out.push(c.slice(i, i + size)); });
    return out;
  }
  async function ragIngest(name, text) {
    const parts = ragChunk(text);
    if (!parts.length) return 0;
    const embs = await ragEmbed(parts);            // embed first, then store (atomic enough)
    const store = await ragStore("readwrite");
    for (let i = 0; i < parts.length; i++) store.add({ doc: name, text: parts[i], vec: embs[i] || [] });
    return new Promise(function (resolve, reject) { store.transaction.oncomplete = function () { resolve(parts.length); }; store.transaction.onerror = function () { reject(store.transaction.error); }; });
  }
  async function ragAll() {
    const store = await ragStore("readonly");
    return new Promise(function (resolve) { const all = []; const req = store.openCursor(); req.onsuccess = function () { const c = req.result; if (c) { all.push(c.value); c.continue(); } else resolve(all); }; req.onerror = function () { resolve(all); }; });
  }
  async function ragDocList() { const all = await ragAll(); const m = {}; all.forEach(function (x) { m[x.doc] = (m[x.doc] || 0) + 1; }); return Object.keys(m).map(function (d) { return { doc: d, chunks: m[d] }; }); }
  async function ragDeleteDoc(name) {
    const store = await ragStore("readwrite"); const idx = store.index("doc");
    return new Promise(function (resolve) { const req = idx.openCursor(IDBKeyRange.only(name)); req.onsuccess = function () { const c = req.result; if (c) { c.delete(); c.continue(); } else resolve(); }; req.onerror = function () { resolve(); }; });
  }
  function cosineSim(a, b) { let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); }
  async function ragBuildContext(query) {
    try {
      const all = await ragAll(); if (!all.length) return "";
      const qv = (await ragEmbed([query]))[0]; if (!qv) return "";
      const scored = all.map(function (x) { return { s: cosineSim(qv, x.vec || []), x: x }; }).sort(function (a, b) { return b.s - a.s; });
      const top = scored.slice(0, 4).filter(function (z) { return z.s > 0.2; });
      if (!top.length) return "";
      const ctx = top.map(function (z, i) { return "[" + (i + 1) + "] (" + z.x.doc + ")\n" + z.x.text; }).join("\n\n");
      return "Excerpts from the user's knowledge base (use them if relevant to the question, otherwise ignore them):\n\n" + ctx;
    } catch (e) { return ""; }
  }

  function effortOptions() {
    // No token limits (num_predict:-1 = unlimited). Temperature drops with the effort
    // (0.9 Low -> 0.2 Genius); the noticeable levers are effortStyle() + the thinking toggle.
    const temperature = +(0.9 - (0.7 * effort) / 5).toFixed(2);
    return { temperature: temperature, num_predict: -1 };
  }
  // Effort -> noticeable answer behavior (appended to the system prompt):
  // 0-1 = brief & direct (done fast), 2-3 = neutral, 4-5 = thorough & self-checking.
  function effortStyle() {
    if (effort <= 1) return "\n\nRespond as briefly and directly as possible. No preamble, no filler, no unnecessary caveats. Keep code examples minimal.";
    if (effort >= 4) return "\n\nReason carefully and thoroughly before answering. Double-check facts, logic and code for errors. Prefer correctness and completeness over brevity.";
    return "";
  }
  // Thinking models (qwen3, deepseek-r1, gpt-oss, …): effort toggles the reasoning.
  // 0-2 off (noticeably faster answers), 3 = model default, 4-5 on (smarter answers).
  // gpt-oss can't be turned off, only levels low/medium/high.
  function effortThink() {
    const caps = modelCaps[model];
    if (!caps || caps.indexOf("thinking") < 0) return undefined;
    if (/gpt-oss/i.test(model)) return effort <= 2 ? "low" : effort >= 4 ? "high" : "medium";
    if (effort <= 2) return false;
    if (effort >= 4) return true;
    return undefined;
  }

  // Sporadic Ollama errors that a retry usually fixes: the gemma4 output parser
  // ("does not match the expected … format") or an aborted llama runner. NOT retryable
  // are real errors like "unable to load model" or "model not found".
  function isTransientOllamaError(msg) {
    const m = String(msg || "").toLowerCase();
    if (/unable to load model|not found|no such model|kein modell/.test(m)) return false;
    return /does not match the expected|server_error|llama-server chat error|llama runner|runner process|chat error/.test(m);
  }

  // A single /api/chat attempt: streams (as rendered markdown) into the container, returns the
  // raw text, throws on error. `out` is the .epitaxy-markdown container.
  // `optOverride`: overrides individual effortOptions() values (e.g. num_predict:-1 on the retry
  // after an answer that was cut off at the token limit).
  async function chatStreamOnce(out, useTools, optOverride) {
    let acc = "", doneReason = "";
    const toolCalls = [];
    streamArts = []; // discard the previous pass's streaming artifacts (new ordinal space)
    const sys = [{ role: "system", content: systemPrompt() + effortStyle() }];
    if (ragContext) sys.push({ role: "system", content: ragContext }); // knowledge-base excerpts (per turn, not in history)
    const opt = Object.assign(effortOptions(), optOverride || {});
    // Request the context window explicitly: without num_ctx, Ollama uses the model default (~4k) and
    // truncates long histories SILENTLY server-side. Need*1.3, capped to the model window.
    const win = Math.min(ctxLen[model] || CTX_FALLBACK, CTX_CAP);
    opt.num_ctx = Math.min(win, Math.max(4096, Math.ceil(estimateChatTokens() * 1.3)));
    const body = {
      model: model,
      stream: true,
      messages: sys.concat(messages),
      options: opt,
    };
    const think = effortThink();
    if (think !== undefined) body.think = think;
    if (useTools) body.tools = TOOL_DEFS;
    let res = await fetch(OLLAMA + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "Ollama HTTP " + res.status;
      try {
        const b = await res.text();
        try { const j = JSON.parse(b); if (j && j.error) msg = j.error; }
        catch (e) { if (b) msg = b.slice(0, 300); }
      } catch (e) {}
      // Some models reject the thinking toggle -> retry once without "think".
      if (body.think !== undefined && /think/i.test(msg)) {
        delete body.think;
        res = await fetch(OLLAMA + "/api/chat", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(msg);
      } else {
        throw new Error(msg);
      }
    }
    if (!res.body) throw new Error("Ollama responded without a data stream.");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (obj.error) throw new Error(obj.error);
        if (obj.done) doneReason = obj.done_reason || "";
        const m = obj.message;
        if (m) {
          if (m.tool_calls && m.tool_calls.length) toolCalls.push.apply(toolCalls, m.tool_calls);
          if (m.content) { acc += m.content; renderStreaming(out, acc); scrollToEnd(); }
        }
      }
    }
    return { content: acc, tool_calls: toolCalls, doneReason: doneReason };
  }

  async function ask() {
    busy = true;
    setStatus("busy", tr("status.thinking"));
    setAssistant("thinking");
    const turn = addAssistantTurn();
    const md = el("div", "epitaxy-markdown");
    turn.body.appendChild(md);
    activeTurn = { body: turn.body, md: md, chips: null }; // target for this turn's action chips/confirmation
    turn.article.classList.add("jarvis-streaming");
    turn.startThinking();
    const MAX_TRIES = 3;
    let acc = "";
    const msgsBase = messages.length; // rollback point: discard an incomplete tool exchange on error/fallback
    try {
      if (!model) await connect();
      if (!model) throw new Error("No model available.");
      await contextLength(model); // cache the window -> num_ctx correct in the request

      let useTools = profile.tools !== false;   // a model without tool support falls back automatically
      let round = 0;                              // tool rounds (bounded against infinite loops)
      while (true) {
        md.innerHTML = "";
        let r;
        for (let attempt = 1; ; attempt++) {
          try { r = await chatStreamOnce(md, useTools); break; }
          catch (e) {
            // Model doesn't support tools -> retry without tools.
            if (useTools && /tool|function.?call/i.test(e.message) && /support|registry|unknown|invalid/i.test(e.message)) {
              useTools = false; round = 0; messages.length = msgsBase; // discard the partial tool exchange, cleanly retry without tools
              continue;
            }
            if (attempt < MAX_TRIES && isTransientOllamaError(e.message)) { setStatus("busy", "Retrying …"); continue; }
            if (/unable to load model/i.test(e.message)) {
              throw new Error("Model could not be loaded – your Ollama version may not support this architecture. Update Ollama or choose another model.");
            }
            throw e;
          }
        }
        // Execute tool calls and feed the results back, then let it answer again.
        if (useTools && r.tool_calls && r.tool_calls.length && round < 5) {
          setStatus("busy", tr("status.using_tools"));
          messages.push({ role: "assistant", content: r.content || "", tool_calls: r.tool_calls });
          for (let k = 0; k < r.tool_calls.length; k++) {
            const tc = r.tool_calls[k] || {}; const nm = (tc.function && tc.function.name) || "";
            if (!nm) { messages.push({ role: "tool", tool_name: "", content: "(invalid tool call)" }); continue; } // keep the cycle balanced
            let a = tc.function && tc.function.arguments; if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = {}; } }
            let outp; try { outp = await runTool(nm, a || {}); } catch (e) { outp = "Error: " + e.message; }
            messages.push({ role: "tool", tool_name: nm, content: String(outp) });
          }
          round++;
          continue; // next round: the model phrases the answer using the tool results
        }
        acc = r.content;
        // The effort limit (num_predict) stopped mid-sentence (done_reason "length"): regenerate once
        // completely without a token limit -> a natural ending guaranteed. (A prefill continuation would be
        // cheaper, but is the model's template concern: gemma4 then returns empty, others start over.)
        if (r.doneReason === "length") {
          setStatus("busy", tr("status.answer_truncated"));
          md.innerHTML = "";
          try {
            const r2 = await chatStreamOnce(md, false, { num_predict: -1 });
            if (r2.content) acc = r2.content;
            else renderAnswer(md, acc); // empty retry -> keep the truncated answer
          } catch (e) { renderAnswer(md, acc); } // retry failed -> keep the truncated answer
        }
        break;
      }

      turn.article.classList.remove("jarvis-streaming");
      if (!acc) {
        // No text from the model. If the turn already produced something (artifact card / action chip),
        // it stands on its own -> don't show a placeholder. Otherwise a short localized message.
        const produced = !!(activeTurn && activeTurn.body && (activeTurn.body.querySelector(".jv-artifact-card") || activeTurn.chips));
        acc = produced ? "" : tr("chat.empty_answer");
      }
      renderAnswer(md, acc);
      turn.h2.textContent = tr("turn.answered") + acc;
      turn.finish();
      if (webSources.length) renderSources(turn, webSources); // sources pill in the footer + list below
      messages.push({ role: "assistant", content: acc });
      setStatus("ok", "Connected");
      setAssistant("ready");
      if (voiceOut) speak(acc, turn.speakBtn);
    } catch (err) {
      messages.length = msgsBase; // discard this round's incomplete tool exchange -> history stays valid
      turn.article.classList.remove("jarvis-streaming");
      turn.body.innerHTML = "";
      const p = el("p", "jarvis-turn-error", tr("turn.error") + err.message);
      turn.body.appendChild(p);
      turn.finish();
      setStatus("error", err.message);
      setAssistant("error");
    } finally {
      busy = false;
      activeTurn = null; // action chips/confirmation only for this turn
      ragContext = ""; // knowledge-base context only for this turn
      webSources = []; // web-search sources only for this turn
      streamArts = []; // streaming artifacts are finalized -> don't leak into other renders
      try { window.dispatchEvent(new Event("jv-turn-done")); } catch (e) {} // persist the chat + update recents
    }
  }

  // Detects an image-editing intent (DE/EN). Only applies when an image is attached.
  function isEditIntent(t) {
    return /\b(bearbeite\w*|bearbeitung|ändere|ändern|ändre|tausche?|tauschen|austausch\w*|ersetze?|ersetzen|entferne?|entfernen|verwandle\w*|wandle|edit|replace|swap|remove)\b/i.test(t) ||
      /\bfüge\b[\s\S]*\bhinzu\b/i.test(t) ||
      /\bmach(e|s)?\b[\s\S]*\b(zu|draus)\b/i.test(t) ||
      /\bturn\b[\s\S]*\binto\b/i.test(t);
  }

  // ---------- Send ----------
  async function submit() {
    if (busy) return;
    const text = getInputText();

    // Image command: /bild | /image | /img <description>  -> text-to-image (Z-Image).
    const img = text.match(/^\/(?:bild|image|img)(?:\s+([\s\S]+))?$/i);
    if (img) {
      clearInput();
      const prompt = (img[1] || "").trim();
      addBubble("user", prompt || text, text); // bubble without the "/bild" prefix; resend with the command
      if (!prompt) {
        addAssistantText("Usage: /bild <description> – e.g. /bild a red fox in the snow, watercolor");
        return;
      }
      await generateImage(prompt);
      return;
    }

    // Note command: /notiz|/note <text>
    const noteCmd = text.match(/^\/(?:notiz|note)\s+([\s\S]+)/i);
    if (noteCmd) { clearInput(); addBubble("user", text); addNote(noteCmd[1].trim()); addAssistantText(tr("chat.note_saved", { x: noteCmd[1].trim() })); return; }
    // Reminder: "erinnere mich / remind me in N min/hours [an] …"
    const remCmd = text.match(/^(?:erinnere mich|remind me)\s+in\s+(\d+)\s*(min\w*|std\w*|stunden?|hours?|h)\b\s*(?:an\s+|to\s+|,\s*)?([\s\S]+)/i);
    if (remCmd) {
      clearInput(); addBubble("user", text);
      const n = parseInt(remCmd[1], 10); const isH = /std|stund|hour|^h$/i.test(remCmd[2]);
      addReminder(remCmd[3].trim(), Date.now() + n * (isH ? 60 : 1) * 60000);
      addAssistantText(tr("chat.reminder_set", { n: n, u: isH ? tr("time.hours") : tr("time.minutes"), x: remCmd[3].trim() }));
      return;
    }

    // Web search: /web <question> – Wikipedia hits as context for this turn, then the model answers with them.
    const webCmd = text.match(/^\/(?:web|websuche)(?:\s+([\s\S]+))?$/i);
    if (webCmd) {
      clearInput();
      const q = (webCmd[1] || "").trim();
      addBubble("user", q || text, text); // bubble without the "/web" prefix; resend with the command
      if (!q) {
        addAssistantText(tr("chat.web_usage"));
        return;
      }
      setStatus("busy", tr("status.websearch"));
      let hits = "";
      try { hits = await toolWeb(q); } catch (e) { hits = ""; }
      ragContext = (hits && hits !== "No matches.")
        ? "Results of a web search for the question “" + q + "” – use them for your answer:\n\n" + hits
        : "The web search for the question “" + q + "” returned no results. Be honest if you are not sure of the answer.";
      messages.push({ role: "user", content: q });
      await ask();
      return;
    }

    if (!text && !attachments.length) return;

    // Memory: "Remember that …" -> store the fact locally, short confirmation, no model call.
    if (!attachments.length) {
      const fact = parseRemember(text);
      if (fact) {
        clearInput();
        addBubble("user", text);
        if (profile.memories.indexOf(fact) === -1) { profile.memories.push(fact); saveProfile(); }
        addAssistantText("Got it – I've remembered: " + fact);
        return;
      }
    }

    const atts = attachments.slice();
    const imgAtts = atts.filter(function (a) { return a.kind === "image"; });

    // Image editing: image attached + editing intent -> img2img (Z-Image), no Ollama chat.
    if (imgAtts.length && text && isEditIntent(text)) {
      clearInput();
      addUserBubble(text, atts);
      attachments = [];
      renderAttachments();
      await editImage(text, imgAtts[0].dataUrl);
      return;
    }

    // otherwise: (vision) chat – images to the model, embed text files into the content.
    const imgB64 = imgAtts.map(function (a) { return a.b64; });
    let content = "";
    atts.forEach(function (a) {
      if (a.kind === "text") content += "File “" + a.name + "”:\n```\n" + a.text + "\n```\n\n";
    });
    const skipped = atts.filter(function (a) { return a.kind === "other"; });
    if (skipped.length) content += "(Attached, not read: " + skipped.map(function (a) { return a.name; }).join(", ") + ")\n\n";
    content = (content + text).trim();
    if (!content) content = imgB64.length ? "What is in the image?" : "";
    if (!content) return;

    const userMsg = { role: "user", content: content };
    if (imgB64.length) userMsg.images = imgB64;

    clearInput();
    addUserBubble(text, atts);
    messages.push(userMsg);
    attachments = [];
    renderAttachments();
    if (profile.rag && content) { setStatus("busy", tr("status.searching_kb")); try { ragContext = await ragBuildContext(content); } catch (e) { ragContext = ""; } }
    await ask();
  }

  // User bubble with optional attachments (image thumbnails / file pills) + text.
  function addUserBubble(text, atts) {
    hideWelcome();
    const row = el("div", "jarvis-msg user");
    const b = el("div", "b");
    if (atts && atts.length) {
      const w = el("div", "jarvis-msg-atts");
      atts.forEach(function (a) {
        if (a.kind === "image") {
          const im = document.createElement("img");
          im.className = "jarvis-msg-thumb";
          im.src = a.dataUrl;
          im.alt = a.name;
          w.appendChild(im);
        } else {
          const f = el("span", "jarvis-msg-file");
          f.innerHTML = ATT_FILE_SVG + "<span></span>";
          f.querySelector("span").textContent = a.name;
          w.appendChild(f);
        }
      });
      b.appendChild(w);
    }
    if (text) {
      const t = el("div", "jarvis-msg-text");
      t.textContent = text;
      b.appendChild(t);
    }
    row.classList.add("group/msg");
    row.appendChild(userCol(row, b, text || "", text || ""));
    wrap.appendChild(row);
    scrollToEnd();
    return b;
  }

  // Image job (generate OR edit) via the local Z-Image server, result as a transcript entry.
  async function runImageJob(endpoint, payload, loadingText) {
    busy = true;
    setStatus("busy", loadingText);
    setAssistant("thinking");
    const turn = addAssistantTurn();
    turn.startThinking();
    // Skeleton placeholder (shimmer) until the image is here.
    const skel = el("div", "jarvis-img-skel");
    const cap = el("div", "jarvis-img-loading", loadingText);
    turn.body.append(skel, cap);
    scrollToEnd();
    try {
      const res = await fetch(ZIMAGE + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = "Image server HTTP " + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const j = await res.json();
      if (!j.image) throw new Error("No image data received.");
      turn.body.innerHTML = "";
      const fig = document.createElement("figure");
      fig.className = "jarvis-img";
      const im = document.createElement("img");
      im.src = j.image;
      im.alt = payload.prompt || "";
      im.loading = "lazy";
      fig.append(im, el("figcaption", "jarvis-img-cap", payload.prompt || ""));
      turn.body.appendChild(fig);
      turn.h2.textContent = tr("turn.made_image") + (payload.prompt || "");
      turn.finish();
      scrollToEnd();
      setStatus("ok", tr("status.connected"));
      setAssistant("ready");
    } catch (err) {
      turn.body.innerHTML = "";
      const p = el("p", "jarvis-turn-error", /failed to fetch|networkerror|load failed/i.test(err.message)
        ? tr("img.server_down")
        : tr("img.error", { x: err.message }));
      turn.body.appendChild(p);
      turn.finish();
      setStatus("error", tr("status.image_server_down"));
      setAssistant("error");
    } finally {
      busy = false;
    }
  }

  // Text -> image
  function generateImage(prompt) {
    return runImageJob("/generate", { prompt: prompt, steps: 9, width: 1024, height: 1024 }, tr("status.gen_image"));
  }

  // Image + instruction -> edited image (img2img)
  function editImage(prompt, dataUrl) {
    return runImageJob("/edit", { prompt: prompt, image: dataUrl, strength: 0.72, steps: 12 }, tr("status.edit_image"));
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", syncInputEmpty); // update the placeholder while typing/deleting
  if (sendBtn) sendBtn.addEventListener("click", (e) => { e.preventDefault(); submit(); }, true);

  // ---------- Speech output (TTS) ----------
  let voices = [];
  function loadVoices() { try { voices = speechSynthesis.getVoices() || []; } catch (e) {} }
  loadVoices();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.onvoiceschanged = loadVoices;

  // Status of the local XTTS server (hyper-realistic voices). Fallback: Web Speech.
  const ttsLocal = { ready: false, voices: [], languages: [] };
  async function ttsHealth() {
    try {
      const r = await fetch(TTSAPI + "/health", { cache: "no-store" });
      if (!r.ok) throw 0;
      const h = await r.json();
      ttsLocal.ready = !!h.ready;
      if (h.ready && !ttsLocal.voices.length) {
        try { const v = await (await fetch(TTSAPI + "/voices")).json(); ttsLocal.voices = v.voices || []; ttsLocal.languages = v.languages || []; } catch (e) {}
      }
    } catch (e) { ttsLocal.ready = false; }
    return ttsLocal.ready;
  }
  function localTtsActive() { return profile.engine !== "browser" && ttsLocal.ready; }

  function pickVoice() {
    if (profile.voiceURI) { const chosen = voices.find((v) => v.voiceURI === profile.voiceURI); if (chosen) return chosen; }
    const pref = langCfg().code;
    return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(pref)) || voices[0] || null;
  }

  let currentUtter = null;   // active Web Speech utterance
  let currentAudio = null;   // active <audio> (local XTTS)
  let speakSeq = 0;          // invalidates superseded/cancelled requests
  function stopPlayback() {
    speakSeq++;
    try { speechSynthesis.cancel(); } catch (e) {}
    currentUtter = null;
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
  }
  // Cancel reading aloud + button back to ▷
  function stopSpeak() {
    const was = !!currentUtter || !!currentAudio;
    stopPlayback();
    resetSpeakBtn();
    if (was && !busy) setAssistant("ready");
  }
  // Dispatcher: local XTTS server preferred, otherwise Web Speech.
  // ---------- TTS text preparation (numbers -> words, strip emojis/unknown chars/URLs) ----------
  function _enU20(n) { return ["null", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"][n]; }
  function _enTens(n) { return ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"][n]; }
  function _enU100(n) { if (n < 20) return n === 0 ? "" : _enU20(n); var t = _enTens(Math.floor(n / 10)), o = n % 10; return o ? t + "-" + _enU20(o) : t; }
  function _enU1000(n) { var h = Math.floor(n / 100), r = n % 100, s = ""; if (h) s = _enU20(h) + " hundred"; if (r) s += (s ? " " : "") + _enU100(r); return s; }
  function _enInt(n) { if (n === 0) return "zero"; var g = ["", " thousand", " million", " billion", " trillion"], p = [], gi = 0; while (n > 0 && gi < g.length) { var c = n % 1000; if (c) p.unshift(_enU1000(c) + g[gi]); n = Math.floor(n / 1000); gi++; } return p.join(" ").trim(); }
  function _deU20(n) { return ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"][n]; }
  function _deTens(n) { return ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"][n]; }
  function _deU100(n) { if (n < 20) return n === 0 ? "" : _deU20(n); var t = _deTens(Math.floor(n / 10)), o = n % 10; if (!o) return t; return (o === 1 ? "einund" : _deU20(o) + "und") + t; }
  function _deU1000(n) { var h = Math.floor(n / 100), r = n % 100, s = ""; if (h) s = (h === 1 ? "ein" : _deU20(h)) + "hundert"; if (r) s += _deU100(r); return s; }
  function _deInt(n) { if (n === 0) return "null"; var out = "", rem = n; [[1000000000000, "Billion", "Billionen"], [1000000000, "Milliarde", "Milliarden"], [1000000, "Million", "Millionen"], [1000, "tausend", "tausend"]].forEach(function (sc) { var q = Math.floor(rem / sc[0]); if (q > 0) { rem = rem % sc[0]; if (sc[0] === 1000) out += (q === 1 ? "ein" : _deU1000(q)) + "tausend"; else out += (q === 1 ? "eine " : _deU1000(q) + " ") + (q === 1 ? sc[1] : sc[2]) + " "; } }); if (rem > 0) out += _deU1000(rem); return out.replace(/\s+/g, " ").trim(); }
  function ttsNumberToWords(numStr, lc) {
    var toInt = lc === "de" ? _deInt : _enInt, s = numStr;
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");   // remove thousands separators
    var m = s.match(/^(\d+)(?:[.,](\d+))?$/); if (!m) return numStr;
    var whole = parseInt(m[1], 10), frac = m[2];
    if (whole > 999999999999) return m[1].split("").map(function (d) { return toInt(+d); }).join(" ");
    var res = toInt(whole);
    if (frac) res += (lc === "de" ? " Komma " : " point ") + frac.split("").map(function (d) { return toInt(+d); }).join(" ");
    return res;
  }
  function normalizeForTts(text, lc) {
    var t = String(text || "");
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, " "); // emojis/symbols
    t = t.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\b[\w.-]+\.(?:com|net|org|de|io|ai|dev|co|gov|edu|info)\b\S*/gi, " "); // URLs/domains
    t = t.replace(/[*_`#>|~]+/g, " ");                                   // leftover markdown
    if (lc === "de" || lc === "en") t = t.replace(/\d[\d.,]*\d|\d/g, function (m) { return " " + ttsNumberToWords(m, lc) + " "; }); // numbers -> words
    t = t.replace(/[^\p{L}\s.,!?;:'"()\-–—]/gu, " ");                    // strip unknown/non-speakable characters
    t = t.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1");          // normalize spaces, reattach orphaned punctuation
    return t.trim();
  }
  // Split text into sentences (for sentence-by-sentence reading; split very long sentences at commas too).
  function splitSentences(text) {
    var raw = text.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [text], out = [];
    raw.forEach(function (p) { p = p.trim(); if (!p) return; if (out.length && (p.length < 4 || /^[.,;:!?…]/.test(p))) out[out.length - 1] += " " + p; else out.push(p); });
    var fin = [];
    out.forEach(function (s) {
      if (s.length <= 240) { fin.push(s); return; }
      var sub = s.match(/[^,;:]+[,;:]+|\S[^,;:]*$/g) || [s], buf = "";
      sub.forEach(function (c) { if ((buf + c).length > 240 && buf) { fin.push(buf.trim()); buf = c; } else buf += c; });
      if (buf.trim()) fin.push(buf.trim());
    });
    return fin.length ? fin : [text];
  }
  // Synthesize + play sentences one after another; the next sentence is already fetched while the
  // current one plays (earlier speaking start, low latency). synth(sentence) -> Promise<Blob>.
  function speakBlobQueue(sentences, synth, btn, fallback) {
    var my = ++speakSeq;
    if (btn) { activeSpeakBtn = btn; setSpeakBtnState(btn, true); }
    var i = 0;
    var nextP = synth(sentences[0]).catch(function () { return null; });
    function step() {
      if (my !== speakSeq) return;
      if (i >= sentences.length) { resetSpeakBtn(); if (!busy) setAssistant("ready"); return; }
      var curP = nextP;
      nextP = (i + 1 < sentences.length) ? synth(sentences[i + 1]).catch(function () { return null; }) : Promise.resolve(null);
      curP.then(function (blob) {
        if (my !== speakSeq) return;
        if (!blob) { if (i === 0 && fallback) { fallback(); return; } i++; step(); return; }
        var url = URL.createObjectURL(blob), audio = new Audio(url);
        audio.volume = ttsVolume(); currentAudio = audio;
        audio.onplay = function () { if (currentAudio === audio && !busy) setAssistant("speaking"); };
        var finp = function () { if (currentAudio === audio) currentAudio = null; try { URL.revokeObjectURL(url); } catch (e) {} if (my === speakSeq) { i++; step(); } };
        audio.onended = finp; audio.onerror = finp;
        audio.play().catch(function () { finp(); });
      });
    }
    step();
  }
  function speak(text, btn) {
    if (!text) return;
    resetSpeakBtn();
    stopPlayback();
    var norm = normalizeForTts(text, langCfg().code);
    if (!norm) { if (!busy) setAssistant("ready"); return; }
    var sentences = splitSentences(norm);
    if (profile.engine === "elevenlabs" && profile.elevenKey && profile.elevenVoice) speakEleven(sentences, btn);
    else if (profile.engine === "local" && ttsLocal.ready) speakLocal(sentences, btn);
    else speakBrowser(sentences, btn);
  }
  // Play an audio blob (from local XTTS or ElevenLabs) + manage the button/orb.
  // Speech-output volume (0..1, clamped) – applies to XTTS/ElevenLabs (<audio>) AND browser (utterance).
  function ttsVolume() { let v = parseFloat(profile.volume); if (isNaN(v)) v = 1; return v < 0 ? 0 : v > 1 ? 1 : v; }
  function playTtsBlob(blob, btn, my) {
    if (my !== speakSeq) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = ttsVolume();
    currentAudio = audio;
    const fin = function () { if (currentAudio === audio) { currentAudio = null; try { URL.revokeObjectURL(url); } catch (e) {} resetSpeakBtn(); if (!busy) setAssistant("ready"); } };
    audio.onplay = function () { if (currentAudio === audio && !busy) setAssistant("speaking"); };
    audio.onended = fin; audio.onerror = fin;
    audio.play().catch(function () { fin(); });
  }
  // ---------- ElevenLabs (own API key; previewing via preview_url = NO credits) ----------
  const EL_API = "https://api.elevenlabs.io/v1";
  const EL_V2_VOICES = "https://api.elevenlabs.io/v2/voices"; // paginated (next_page_token)
  let elevenVoices = [];                 // [{voice_id,name,language,preview_url}] – grows while loading
  const elPreview = {};                  // voice_id -> preview_url
  let previewAudio = null;               // previewing (samples) – separate from real speaking
  let elLoading = false, elError = "", elSeq = 0; // loading state for the voice list
  // Language name/locale -> 2-letter code (for filtering voices by language).
  function langNameToCode(s) {
    s = String(s || "").trim().toLowerCase(); if (!s) return "";
    if (/^[a-z]{2}$/.test(s)) return s;
    var map = { english: "en", german: "de", deutsch: "de", french: "fr", "französisch": "fr", francais: "fr", "français": "fr", spanish: "es", spanisch: "es", espanol: "es", "español": "es", italian: "it", italienisch: "it", italiano: "it" };
    for (var k in map) { if (s.indexOf(k) !== -1) return map[k]; }
    return "";
  }
  // Language codes an ElevenLabs voice supports (empty = unknown -> treat as multilingual).
  function elVoiceLangs(v) {
    var set = {}, lab = v.labels || {};
    (v.verified_languages || []).forEach(function (x) { var c = String(x.language || x.locale || "").slice(0, 2).toLowerCase(); if (/^[a-z]{2}$/.test(c)) set[c] = 1; });
    [lab.language, lab.accent, lab.descriptive].forEach(function (s) { var c = langNameToCode(s); if (c) set[c] = 1; });
    return Object.keys(set);
  }
  // Should the voice appear in the selected language? Unknown or multilingual (>=3) -> everywhere.
  function voiceInLang(langs, sel) { return !langs || langs.length === 0 || langs.length >= 3 || langs.indexOf(sel) !== -1; }
  // When the language changes and the selected voice no longer fits: reset it sensibly.
  // XTTS speakers are multilingual (each speaks every language) -> no adjustment needed.
  function syncVoiceToLang() {
    var sel = langCfg().code;
    if (profile.engine === "browser" && profile.voiceURI) {
      var cur = voices.find(function (v) { return v.voiceURI === profile.voiceURI; });
      if (cur && cur.lang && cur.lang.slice(0, 2).toLowerCase() !== sel) { profile.voiceURI = ""; saveProfile(); }
    } else if (profile.engine === "elevenlabs" && profile.elevenVoice) {
      var ev = elevenVoices.find(function (v) { return v.voice_id === profile.elevenVoice; });
      if (ev && !voiceInLang(ev.langs, sel)) { var first = elevenVoices.find(function (v) { return voiceInLang(v.langs, sel); }); profile.elevenVoice = first ? first.voice_id : ""; saveProfile(); }
    }
  }
  function elMapVoice(v) {
    const lab = v.labels || {};
    if (v.preview_url) elPreview[v.voice_id] = v.preview_url;
    return { voice_id: v.voice_id, name: v.name, preview_url: v.preview_url || "", language: lab.language || lab.accent || lab.descriptive || "", langs: elVoiceLangs(v) };
  }
  // Clean the key of typical copy-paste errors: zero-width characters, surrounding quotes,
  // accidental "xi-api-key:"/"Authorization:"/"Bearer " prefix.
  function elCleanKey(k) {
    return String(k || "").replace(/[​-‍﻿]/g, "").trim()
      .replace(/^["']+|["']+$/g, "").replace(/^(xi-api-key|authorization)\s*[:=]\s*/i, "").replace(/^Bearer\s+/i, "").trim();
  }
  function elAuthMsg(status) { return status === 401 ? tr("el.key_invalid") : tr("el.access_denied", { s: status }); }
  async function elGet(url) { // GET with the key header; throws an Error with .status on !ok
    const r = await fetch(url, { headers: { "xi-api-key": elCleanKey(profile.elevenKey) } });
    if (!r.ok) { const err = new Error("HTTP " + r.status); err.status = r.status; throw err; }
    return r.json();
  }
  // Load voices PAGE BY PAGE; after each page onPage() → the dropdown shows what's already loaded immediately.
  async function elFetchVoices(onPage) {
    if (!elCleanKey(profile.elevenKey)) { elevenVoices = []; elError = ""; elLoading = false; return []; }
    const my = ++elSeq;                   // only the latest run may write (race protection while typing)
    elLoading = true; elError = ""; elevenVoices = [];
    if (typeof onPage === "function") onPage();
    try {
      let token = "", pages = 0;
      do {
        const j = await elGet(EL_V2_VOICES + "?page_size=10" + (token ? "&next_page_token=" + encodeURIComponent(token) : ""));
        if (my !== elSeq) return elevenVoices;        // superseded
        (j.voices || []).forEach(function (v) { elevenVoices.push(elMapVoice(v)); });
        if (typeof onPage === "function") onPage();    // show already-loaded voices immediately
        token = j.next_page_token || ""; pages++;
      } while (token && pages < 80);
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) {
        if (my === elSeq) elError = elAuthMsg(e.status);   // auth error: no v1 fallback (would return the same 401)
      } else {
        try { // fallback: v1 (all at once) – only for network/other errors
          const j = await elGet(EL_API + "/voices");
          if (my !== elSeq) return elevenVoices;
          elevenVoices = (j.voices || []).map(elMapVoice);
        } catch (e2) {
          if (my === elSeq) elError = (e2 && (e2.status === 401 || e2.status === 403)) ? elAuthMsg(e2.status) : "Network error";
        }
      }
    }
    if (my === elSeq) {
      elLoading = false;
      // sensible default: preselect the first voice (without preview/credits) if none is chosen yet
      if (!profile.elevenVoice && elevenVoices.length) { profile.elevenVoice = elevenVoices[0].voice_id; saveProfile(); }
      if (typeof onPage === "function") onPage();
    }
    return elevenVoices;
  }
  function elPlayPreview(voiceId) { // plays the sample provided by ElevenLabs (no credits)
    const u = elPreview[voiceId]; if (!u) return;
    try { if (previewAudio) previewAudio.pause(); } catch (e) {}
    previewAudio = new Audio(u); previewAudio.volume = ttsVolume(); previewAudio.play().catch(function () {});
  }
  // Real TTS via ElevenLabs (consumes credits) – sentence by sentence, with prefetch. Fallback to browser.
  function speakEleven(sentences, btn) {
    speakBlobQueue(sentences, function (s) {
      return fetch(EL_API + "/text-to-speech/" + encodeURIComponent(profile.elevenVoice), {
        method: "POST",
        headers: { "xi-api-key": elCleanKey(profile.elevenKey), "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: s, model_id: profile.elevenModel || "eleven_multilingual_v2" }),
      }).then(function (r) { if (!r.ok) throw new Error("ElevenLabs " + r.status); return r.blob(); });
    }, btn, function () { resetSpeakBtn(); speakBrowser(sentences, btn); });
  }
  // Local (XTTS): fetch WAV from the server and play it as <audio> – sentence by sentence, with prefetch.
  function speakLocal(sentences, btn) {
    speakBlobQueue(sentences, function (s) {
      return fetch(TTSAPI + "/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: s, voice: profile.voiceLocal || "", language: langCfg().code, speed: profile.rate || 1 }),
      }).then(function (r) { if (!r.ok) throw new Error("TTS " + r.status); return r.blob(); });
    }, btn, function () { resetSpeakBtn(); speakBrowser(sentences, btn); }); // fallback to Web Speech
  }
  // Browser (Web Speech) – race-safe; one utterance per sentence (speechSynthesis queues them).
  function speakBrowser(sentences, btn) {
    if (typeof speechSynthesis === "undefined") { resetSpeakBtn(); return; }
    var my = ++speakSeq;
    if (btn) { activeSpeakBtn = btn; setSpeakBtnState(btn, true); }
    var v = pickVoice(), last = sentences.length - 1;
    try {
      sentences.forEach(function (s, idx) {
        var u = new SpeechSynthesisUtterance(s);
        u.lang = langCfg().bcp; u.rate = profile.rate || 1; u.volume = ttsVolume(); if (v) u.voice = v;
        if (idx === 0) u.onstart = function () { if (my === speakSeq && !busy) setAssistant("speaking"); };
        if (idx === last) { currentUtter = u; var done = function () { if (my === speakSeq && currentUtter === u) { currentUtter = null; resetSpeakBtn(); if (!busy) setAssistant("ready"); } }; u.onend = done; u.onerror = done; }
        speechSynthesis.speak(u);
      });
    } catch (e) { currentUtter = null; resetSpeakBtn(); }
  }

  // ---------- Microphone (STT) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null, listening = false, finalText = "";
  // Local Whisper STT (offline, more accurate) with a Web Speech fallback. Only for dictating the question;
  // the wake word stays on Web Speech.
  let whisperReady = false, whisperRec = null, whisperAC = null;
  // Get microphone permission ONCE per session. getUserMedia sets the "microphone" permission
  // to "granted" session-wide -> the SpeechRecognition started afterwards does NOT ask again.
  // Fixes the constant file:// popup (which otherwise reappears on every recognition start).
  let micState = "idle", micPromise = null; // idle | granted | denied
  function ensureMic() {
    if (micState === "granted") return Promise.resolve(true);
    if (micState === "denied") return Promise.resolve(false);
    if (micPromise) return micPromise;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { micState = "granted"; return Promise.resolve(true); }
    micPromise = navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (s) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} micState = "granted"; return true; })
      .catch(function () { micState = "denied"; return false; });
    return micPromise;
  }
  function startDictation() {
    recog = new SR();
    recog.lang = langCfg().bcp;
    recog.interimResults = true;
    recog.continuous = false;
    finalText = "";
    recog.onstart = () => { listening = true; if (micBtn) micBtn.classList.add("jarvis-listening"); setStatus("busy", tr("status.listening")); setAssistant("listening"); };
    recog.onresult = (e) => {
      let interim = ""; finalText = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      setInputText(finalText || interim);
    };
    recog.onerror = (e) => { setStatus("error", "Microphone: " + e.error); setAssistant("error"); };
    recog.onend = () => {
      listening = false;
      if (micBtn) micBtn.classList.remove("jarvis-listening");
      if (finalText.trim()) submit(); else { setStatus("ok", "Connected"); setAssistant("ready"); }
      if (profile.wakeEnabled) setTimeout(startWakeWord, 600); // reactivate the wake word after dictation
    };
    try { recog.start(); } catch (e) { if (profile.wakeEnabled) setTimeout(startWakeWord, 300); } // start failed -> let the wake word take over again (otherwise a dead state)
  }

  // ----- Local Whisper STT: WAV recording + own speech-pause detection (VAD) -----
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buf);
    function ws(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    ws(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ws(36, "data"); view.setUint32(40, samples.length * 2, true);
    let o = 44; for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([view], { type: "audio/wav" });
  }
  function downsample(input, inRate, outRate) {
    if (outRate >= inRate) return input;
    const ratio = inRate / outRate, outLen = Math.round(input.length / ratio), out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  }
  function blobToB64(blob) { return new Promise(function (res) { const r = new FileReader(); r.onload = function () { res(String(r.result).split(",")[1] || ""); }; r.readAsDataURL(blob); }); }
  // Records (its own getUserMedia stream) until a speech pause and transcribes via Whisper.
  // cbs.onText(text) at the end (empty text = nothing recognized); cbs.onFail() = Whisper unusable.
  function recordWhisper(cbs) {
    let cancelled = false, stopped = false, node = null, source = null, sink = null, stream = null, sr = 16000;
    const chunks = []; let started = false, silence = 0, elapsed = 0;
    const START = 0.012, END = 0.008;
    function cleanup() {
      try { if (node) node.disconnect(); } catch (e) {}
      try { if (sink) sink.disconnect(); } catch (e) {}
      try { if (source) source.disconnect(); } catch (e) {}
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      node = source = sink = stream = null;
    }
    function finish() {
      if (stopped || cancelled) return; stopped = true; cleanup();
      if (!started || !chunks.length) { cbs.onText && cbs.onText(""); return; }
      let total = 0; chunks.forEach(function (c) { total += c.length; });
      const merged = new Float32Array(total); let off = 0;
      chunks.forEach(function (c) { merged.set(c, off); off += c.length; });
      const wav = encodeWav(downsample(merged, sr, 16000), 16000);
      blobToB64(wav).then(function (b64) {
        return fetch(STT_URL + "/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio_base64: b64, mime: "audio/wav", language: null }) }).then(function (r) { return r.json(); });
      }).then(function (j) {
        if (j && j.error) { whisperReady = false; cbs.onFail && cbs.onFail(); return; }
        cbs.onText && cbs.onText(((j && j.text) || "").trim());
      }).catch(function () { whisperReady = false; cbs.onFail && cbs.onFail(); });
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      if (cancelled) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
      stream = s;
      try { if (!whisperAC) whisperAC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { whisperAC = null; }
      const ac = whisperAC;
      if (!ac || !ac.createScriptProcessor) { cleanup(); cbs.onFail && cbs.onFail(); return; }
      if (ac.state === "suspended") { try { ac.resume(); } catch (e) {} }
      sr = ac.sampleRate;
      source = ac.createMediaStreamSource(s);
      node = ac.createScriptProcessor(4096, 1, 1);
      sink = ac.createGain(); sink.gain.value = 0;
      source.connect(node); node.connect(sink); sink.connect(ac.destination);
      node.onaudioprocess = function (e) {
        if (stopped || cancelled) return;
        const d = e.inputBuffer.getChannelData(0), c = new Float32Array(d.length); c.set(d); chunks.push(c);
        let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        const dt = d.length / sr; elapsed += dt;
        if (rms > START) started = true;
        if (started) silence = rms < END ? silence + dt : 0;
        if ((started && silence > 0.9) || elapsed > 15 || (!started && elapsed > 6)) finish();
      };
    }).catch(function () { cbs.onFail && cbs.onFail(); });
    return { cancel: function () { if (stopped) return; cancelled = true; cleanup(); } };
  }
  // Dictation via Whisper: sets the same mic state as startDictation and feeds the text via submit().
  function startWhisperDictation() {
    finalText = "";
    listening = true;
    if (micBtn) micBtn.classList.add("jarvis-listening");
    setStatus("busy", tr("status.listening"));
    setAssistant("listening");
    whisperRec = recordWhisper({
      onText: function (t) {
        whisperRec = null; listening = false;
        if (micBtn) micBtn.classList.remove("jarvis-listening");
        const text = (t || "").trim();
        if (text) { setInputText(text); submit(); }
        else { setStatus("ok", "Connected"); setAssistant("ready"); }
        if (profile.wakeEnabled) setTimeout(startWakeWord, 600); // reactivate the wake word after dictation
      },
      onFail: function () {
        whisperReady = false; whisperRec = null; listening = false;
        if (micBtn) micBtn.classList.remove("jarvis-listening");
        if (SR) startDictation(); // this round via Web Speech (sets the state + wake word itself)
        else { setStatus("ok", "Connected"); setAssistant("ready"); if (profile.wakeEnabled) setTimeout(startWakeWord, 600); }
      }
    });
  }
  // Health/warmup at startup: detect Whisper and (if present) preload the model.
  function whisperHealth() {
    fetch(STT_URL + "/health").then(function (r) { return r.json(); }).then(function (j) {
      whisperReady = !!(j && j.available);
      if (whisperReady) { try { fetch(STT_URL + "/warmup", { method: "POST" }); } catch (e) {} }
    }).catch(function () { whisperReady = false; });
  }

  function toggleMic() {
    // Cancel a running dictation (Whisper or Web Speech).
    if (listening) {
      if (whisperRec) {
        try { whisperRec.cancel(); } catch (e) {}
        whisperRec = null; listening = false;
        if (micBtn) micBtn.classList.remove("jarvis-listening");
        setStatus("ok", "Connected"); setAssistant("ready");
        if (profile.wakeEnabled) setTimeout(startWakeWord, 400);
        return;
      }
      try { if (recog) recog.stop(); } catch (e) {}
      return;
    }
    // Prefer local Whisper (offline, more accurate); otherwise Web Speech.
    if (whisperReady) {
      stopWakeWord(); // wake word and dictation share the microphone
      ensureMic().then(function (ok) {
        if (!ok) { setStatus("error", tr("status.no_mic")); setAssistant("error"); if (profile.wakeEnabled) setTimeout(startWakeWord, 400); return; }
        startWhisperDictation();
      });
      return;
    }
    if (!SR) { setStatus("error", tr("status.stt_unavailable")); return; }
    ensureMic().then(function (ok) {
      if (!ok) { setStatus("error", tr("status.no_mic")); setAssistant("error"); return; }
      startDictation();
    });
  }
  if (micBtn) micBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleMic(); }, true);

  // Custom dropdown (replaces the native <select> – project-wide only custom dropdowns/popups).
  // getOpts: array [{value,label}] OR a function returning such an array (for dynamic lists).
  function jvSelect(getOpts, getValue, onChange) {
    function options() { return typeof getOpts === "function" ? (getOpts() || []) : (getOpts || []); }
    const trig = el("button", "jv-sel"); trig.type = "button";
    trig.setAttribute("aria-haspopup", "listbox"); trig.setAttribute("aria-expanded", "false");
    const lab = el("span", "jv-sel-label"); trig.appendChild(lab);
    const car = el("span", "jv-sel-caret");
    car.innerHTML = HI("chevDown", { size: 12 });
    trig.appendChild(car);
    let panel = null, list = null, isOpen = false;
    function labelFor(v) { const o = options().find(function (x) { return x.value === v; }); return o ? o.label : ""; }
    function render() { lab.textContent = labelFor(getValue()); }
    function onDoc(e) { if (!panel) return; if (panel.contains(e.target) || trig.contains(e.target)) return; close(); }
    function close() { if (panel) panel.setAttribute("data-open", "false"); isOpen = false; trig.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", onDoc, true); }
    function build() {
      panel = el("div", "jv-modelmenu jv-sel-menu");
      panel.appendChild(el("div", "jv-mm-surface bg-surface-popover"));
      const scroll = el("div", "jv-mm-scroll"); list = el("div", "jv-mm-list");
      scroll.appendChild(list); panel.appendChild(scroll);
      document.body.appendChild(panel);
    }
    function populate() {
      const prev = list.childElementCount;     // entries already shown → only newly added ones fade in
      list.innerHTML = "";
      options().forEach(function (o, idx) {
        const it = el("div", "jv-mm-item" + (prev && idx >= prev ? " jv-mm-new" : "") + (o.disabled ? " jv-mm-disabled" : "")); it.setAttribute("role", "menuitemradio");
        it.appendChild(el("span", "jv-mm-name", o.label));
        const chk = el("span", "jv-mm-check");
        chk.innerHTML = HI("check", { size: 14 });
        it.appendChild(chk); it._value = o.value;
        it.setAttribute("aria-checked", String(!o.disabled && o.value === getValue()));
        if (o.disabled) { it.setAttribute("aria-disabled", "true"); }
        else { it.addEventListener("click", function () { onChange(o.value); render(); close(); }); }
        list.appendChild(it);
      });
    }
    function position() {
      const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const r = trig.getBoundingClientRect();
      panel.style.left = (r.left / z) + "px";
      panel.style.top = ((r.bottom + 4) / z) + "px";
      panel.style.minWidth = (r.width / z) + "px";
    }
    function open() {
      if (!panel) build();
      populate(); position();
      panel.setAttribute("data-open", "true"); isOpen = true; trig.setAttribute("aria-expanded", "true");
      setTimeout(function () { document.addEventListener("mousedown", onDoc, true); }, 0);
    }
    trig.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); isOpen ? close() : open(); });
    // refresh: update the label AND – if open – repopulate the list (for incremental loading)
    function refresh() { render(); if (isOpen && panel) { populate(); position(); } }
    render();
    return { el: trig, refresh: refresh, close: close };
  }

  // ---------- Customize hub (overlay): About you · Personality · Memory · Instructions · Voice · Activation ----------
  function buildAnpassen() {
    const backdrop = el("div", "jv-an-backdrop");
    const modal = el("div", "jv-an");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", tr("an.title"));
    backdrop.appendChild(modal);
    const head = el("div", "jv-an-head");
    head.appendChild(el("h2", "jv-an-title", tr("an.title")));
    const closeBtn = el("button", "jv-an-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", tr("an.close"));
    closeBtn.innerHTML = HI("x", { size: 14 });
    head.appendChild(closeBtn);
    const body = el("div", "jv-an-body");
    modal.append(head, body);
    document.body.appendChild(backdrop);

    function section(title, hint) {
      const s = el("div", "jv-an-sec");
      s.appendChild(el("div", "jv-an-sec-h", title));
      if (hint) s.appendChild(el("div", "jv-an-hint", hint));
      body.appendChild(s);
      return s;
    }
    function input(val, ph) { const i = document.createElement("input"); i.type = "text"; i.className = "jv-an-input"; i.value = val || ""; if (ph) i.placeholder = ph; return i; }
    function textarea(val, ph) { const t = document.createElement("textarea"); t.className = "jv-an-textarea"; t.value = val || ""; if (ph) t.placeholder = ph; return t; }
    function field(labelText, control) { const f = el("div", "jv-an-field"); if (labelText) f.appendChild(el("label", "jv-an-label", labelText)); f.appendChild(control); return f; }
    function row(labelText, control) { const r = el("div", "jv-an-row"); r.appendChild(el("span", "jv-an-row-label", labelText)); r.appendChild(control); return r; }
    function segmented(opts, get, set) {
      const w = el("div", "jv-an-seg"); const items = [];
      opts.forEach(function (o) { const b = el("button", "jv-an-seg-btn", o.label); b.type = "button"; b.addEventListener("click", function () { set(o.v); sync(); }); items.push({ b: b, v: o.v }); w.appendChild(b); });
      function sync() { const cur = get(); items.forEach(function (x) { x.b.classList.toggle("is-on", x.v === cur); }); }
      w._sync = sync; sync(); return w;
    }
    function switchEl(get, set) {
      const sw = el("div", "jv-switch"); sw.appendChild(el("span", "jv-switch-knob"));
      sw.setAttribute("role", "switch"); sw.tabIndex = 0;
      function sync() { const v = !!get(); sw.classList.toggle("is-on", v); sw.setAttribute("aria-checked", String(v)); }
      function toggle() { set(!get()); sync(); }
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
      sw._sync = sync; sync(); return sw;
    }

    // 1) About you
    const s1 = section(tr("an.about_you"));
    const nameIn = input(profile.name, tr("an.name_ph"));
    nameIn.addEventListener("input", function () { profile.name = nameIn.value.trim(); saveProfile(); updateWelcome(); });
    s1.appendChild(field(tr("an.name_label"), nameIn));
    const aboutTa = textarea(profile.about, tr("an.about_ph"));
    aboutTa.addEventListener("input", function () { profile.about = aboutTa.value.trim(); saveProfile(); });
    s1.appendChild(field(tr("an.profile_short"), aboutTa));

    // 2) Personality
    const s2 = section(tr("an.personality"));
    s2.appendChild(row(tr("an.tone"), segmented([{ v: "locker", label: tr("an.tone.loose") }, { v: "neutral", label: tr("an.tone.neutral") }, { v: "förmlich", label: tr("an.tone.formal") }], function () { return profile.tone; }, function (v) { profile.tone = v; saveProfile(); })));
    const addrIn = input(profile.address, tr("an.address_ph"));
    addrIn.addEventListener("input", function () { profile.address = addrIn.value.trim(); saveProfile(); updateWelcome(); });
    s2.appendChild(row(tr("an.address"), addrIn));
    s2.appendChild(row(tr("an.length"), segmented([{ v: "knapp", label: tr("an.length.short") }, { v: "normal", label: tr("an.length.normal") }, { v: "ausführlich", label: tr("an.length.long") }], function () { return profile.length; }, function (v) { profile.length = v; saveProfile(); })));
    s2.appendChild(row(tr("an.humor"), switchEl(function () { return profile.humor; }, function (v) { profile.humor = v; saveProfile(); })));

    // 3) Memory
    const s3 = section(tr("an.memory"), tr("an.memory_hint"));
    const memList = el("div", "jv-an-mem"); s3.appendChild(memList);
    const memAddWrap = el("div", "jv-an-mem-add");
    const memIn = input("", tr("an.new_fact_ph"));
    const memBtn = el("button", "jv-an-btn", tr("an.remember_btn")); memBtn.type = "button";
    memAddWrap.append(memIn, memBtn); s3.appendChild(memAddWrap);
    function renderMem() {
      memList.innerHTML = "";
      if (!profile.memories.length) { memList.appendChild(el("div", "jv-an-mem-empty", tr("an.mem_empty"))); return; }
      profile.memories.forEach(function (fact, idx) {
        const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", fact));
        const del = el("button", "jv-an-mem-del"); del.type = "button"; del.setAttribute("aria-label", tr("an.remove"));
        del.innerHTML = HI("x", { size: 13 });
        del.addEventListener("click", function () { profile.memories.splice(idx, 1); saveProfile(); renderMem(); });
        it.appendChild(del); memList.appendChild(it);
      });
    }
    function addMem() { const v = memIn.value.trim(); if (!v) return; if (profile.memories.indexOf(v) === -1) { profile.memories.push(v); saveProfile(); } memIn.value = ""; renderMem(); }
    memBtn.addEventListener("click", addMem);
    memIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addMem(); } });
    renderMem();

    // 4) Custom instructions
    const s4 = section(tr("an.instructions"), tr("an.instructions_hint"));
    const instrTa = textarea(profile.instructions, tr("an.instructions_ph"));
    instrTa.addEventListener("input", function () { profile.instructions = instrTa.value.trim(); saveProfile(); });
    s4.appendChild(instrTa);

    // 4b) Tools & notes
    const sT = section(tr("an.tools_notes"), tr("an.tools_notes_hint"));
    sT.appendChild(row(tr("an.use_tools"), switchEl(function () { return profile.tools !== false; }, function (v) { profile.tools = v; saveProfile(); })));
    const noteList = el("div", "jv-an-mem"); sT.appendChild(noteList);
    const noteAddWrap = el("div", "jv-an-mem-add");
    const noteIn = input("", tr("an.new_note_ph"));
    const noteBtn = el("button", "jv-an-btn", tr("an.note")); noteBtn.type = "button";
    noteAddWrap.append(noteIn, noteBtn); sT.appendChild(noteAddWrap);
    function renderNotes() {
      noteList.innerHTML = "";
      if (!notes.length) { noteList.appendChild(el("div", "jv-an-mem-empty", tr("notes.none"))); }
      else notes.forEach(function (nt, idx) {
        const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", nt.t));
        const del = el("button", "jv-an-mem-del"); del.type = "button"; del.setAttribute("aria-label", tr("an.delete"));
        del.innerHTML = HI("x", { size: 13 });
        del.addEventListener("click", function () { notes.splice(idx, 1); saveNotes(); renderNotes(); });
        it.appendChild(del); noteList.appendChild(it);
      });
      if (reminders.length) noteList.appendChild(el("div", "jv-an-hint", tr("an.reminders_pending", { n: reminders.length })));
    }
    function addNoteUI() { const v = noteIn.value.trim(); if (!v) return; addNote(v); noteIn.value = ""; renderNotes(); }
    noteBtn.addEventListener("click", addNoteUI);
    noteIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addNoteUI(); } });
    renderNotes();
    notesRenderers.push(renderNotes);

    // 4c) Knowledge base (RAG)
    const sR = section(tr("an.kb"), tr("an.kb_hint", { m: ragEmbedModel() }));
    sR.appendChild(row(tr("an.use_kb"), switchEl(function () { return !!profile.rag; }, function (v) { profile.rag = v; saveProfile(); })));
    const pasteTa = textarea("", tr("an.paste_ph"));
    sR.appendChild(field(tr("an.add_text"), pasteTa));
    const ragBtns = el("div", "jv-an-mem-add");
    const fileBtn = el("button", "jv-an-btn", tr("an.file")); fileBtn.type = "button";
    const addBtn = el("button", "jv-an-btn is-accent", tr("an.add")); addBtn.type = "button";
    const fileIn = document.createElement("input"); fileIn.type = "file"; fileIn.accept = ".txt,.md,.csv,.json,.log,text/*"; fileIn.style.display = "none";
    ragBtns.append(fileBtn, addBtn);
    const ragStatus = el("div", "jv-an-hint", "");
    const ragDocsEl = el("div", "jv-an-mem");
    sR.append(ragBtns, ragStatus, fileIn, ragDocsEl);
    async function renderRagDocs() {
      let docs = []; try { docs = await ragDocList(); } catch (e) {}
      ragDocsEl.innerHTML = ""; // clear only AFTER the await -> no duplicate entries on parallel calls
      if (!docs.length) { ragDocsEl.appendChild(el("div", "jv-an-mem-empty", tr("kb.none"))); return; }
      docs.forEach(function (d) {
        const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", d.doc + " (" + tr("an.sections_n", { n: d.chunks }) + ")"));
        const del = el("button", "jv-an-mem-del"); del.type = "button"; del.setAttribute("aria-label", tr("an.delete"));
        del.innerHTML = HI("x", { size: 13 });
        del.addEventListener("click", async function () { await ragDeleteDoc(d.doc); renderRagDocs(); });
        it.appendChild(del); ragDocsEl.appendChild(it);
      });
    }
    async function ragIngestUI(name, text) {
      if (!text || !text.trim()) { ragStatus.textContent = tr("an.pick"); return; }
      ragStatus.textContent = tr("kb.indexing");
      try { const n = await ragIngest(name, text); ragStatus.textContent = tr("kb.indexed", { name: name, n: n }); if (!profile.rag) { profile.rag = true; saveProfile(); body.querySelectorAll(".jv-switch").forEach(function (x) { if (x._sync) x._sync(); }); } renderRagDocs(); }
      catch (e) { ragStatus.textContent = tr("kb.error", { msg: e.message }); }
    }
    addBtn.addEventListener("click", function () { const t = pasteTa.value.trim(); if (!t) { ragStatus.textContent = tr("an.pick"); return; } pasteTa.value = ""; ragIngestUI(tr("an.pasted", { t: new Date().toLocaleString(langCfg().bcp, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }), t); });
    fileBtn.addEventListener("click", function () { fileIn.click(); });
    fileIn.addEventListener("change", function () { const f = fileIn.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = function () { ragIngestUI(f.name, String(rd.result || "")); }; rd.readAsText(f); fileIn.value = ""; });
    renderRagDocs();

    // 5) Voice & language (custom dropdowns instead of native <select>)
    const s5 = section(tr("an.voice_lang"), tr("an.hint.voice"));
    const engineDd = jvSelect(
      function () { return [
        { value: "local", label: ttsLocal.ready ? tr("eng.local_ready") : tr("eng.local_off") },
        { value: "elevenlabs", label: profile.elevenKey ? tr("eng.eleven_cloud") : tr("eng.eleven_needkey") },
        { value: "browser", label: tr("eng.browser") },
      ]; },
      function () { return profile.engine || "local"; },
      function (v) { profile.engine = v; saveProfile(); syncEngineUI(); voiceDd.refresh(); if (v === "elevenlabs" && profile.elevenKey) elFetchVoices(function () { voiceDd.refresh(); }); }
    );
    s5.appendChild(field(tr("an.engine"), engineDd.el));
    // ElevenLabs API key (only visible when the engine is ElevenLabs). Stored locally in profile.
    const elKeyIn = document.createElement("input"); elKeyIn.type = "password"; elKeyIn.className = "jv-an-input"; elKeyIn.placeholder = tr("an.eleven_key_ph"); elKeyIn.value = profile.elevenKey || ""; elKeyIn.autocomplete = "off"; elKeyIn.spellcheck = false;
    let elKeyTimer = 0;
    elKeyIn.addEventListener("input", function () { profile.elevenKey = elCleanKey(elKeyIn.value); saveProfile(); engineDd.refresh(); clearTimeout(elKeyTimer); elKeyTimer = setTimeout(function () { elFetchVoices(function () { voiceDd.refresh(); }).then(function () { engineDd.refresh(); }); }, 600); });
    const elKeyField = field(tr("an.eleven_key_label"), elKeyIn); s5.appendChild(elKeyField);
    const voiceDd = jvSelect(
      function () {
        const sel = langCfg().code;
        if (profile.engine === "elevenlabs") {
          // filter by language; multilingual/unknown voices appear in all languages
          const list = elevenVoices.filter(function (v) { return voiceInLang(v.langs, sel); }).map(function (v) { return { value: v.voice_id, label: v.name + (v.language ? " – " + v.language : "") }; });
          if (list.length) return elLoading ? list.concat([{ value: "", label: tr("an.voice_more_loading"), disabled: true }]) : list;
          if (elevenVoices.length) return [{ value: "", label: tr("an.voice_none_lang"), disabled: true }];
          return [{ value: "", label: !profile.elevenKey ? tr("an.voice_key_needed") : (elError ? tr("an.voice_error", { x: elError }) : tr("an.voice_loading")), disabled: true }];
        }
        if (profile.engine !== "browser") {
          // XTTS speakers are multilingual -> show all (language controls the pronunciation separately)
          const list = (ttsLocal.voices || []).map(function (n) { return { value: n, label: n }; });
          return list.length ? list : [{ value: "", label: tr("an.voice_tts_needed"), disabled: true }];
        }
        // Browser voices are monolingual -> only those of the selected language; “Automatic” always stays
        return [{ value: "", label: tr("an.voice_auto") }].concat((voices || []).filter(function (v) { return v.lang && v.lang.slice(0, 2).toLowerCase() === sel; }).map(function (v) { return { value: v.voiceURI, label: v.name + " (" + v.lang + ")" }; }));
      },
      function () { return profile.engine === "elevenlabs" ? (profile.elevenVoice || "") : (profile.engine !== "browser" ? (profile.voiceLocal || "") : (profile.voiceURI || "")); },
      function (v) {
        if (profile.engine === "elevenlabs") { if (!v) return; profile.elevenVoice = v; saveProfile(); elPlayPreview(v); } // ignore the empty placeholder; listening to the sample = no credits
        else if (profile.engine !== "browser") { profile.voiceLocal = v; saveProfile(); }
        else { profile.voiceURI = v; saveProfile(); }
      }
    );
    s5.appendChild(field(tr("an.voice"), voiceDd.el));
    const rateRow = el("div", "jv-an-row"); rateRow.appendChild(el("span", "jv-an-row-label", tr("an.rate")));
    const rate = document.createElement("input"); rate.type = "range"; rate.className = "jv-an-range"; rate.min = "0.6"; rate.max = "1.4"; rate.step = "0.05"; rate.value = String(profile.rate || 1);
    rate.addEventListener("input", function () { profile.rate = parseFloat(rate.value) || 1; saveProfile(); });
    const preview = el("button", "jv-an-btn", tr("an.preview")); preview.type = "button";
    preview.addEventListener("click", function () { if (profile.engine === "elevenlabs") { if (profile.elevenVoice) elPlayPreview(profile.elevenVoice); } else speak(tr("an.preview_sentence")); });
    rateRow.append(rate, preview); s5.appendChild(rateRow);
    const volRow = el("div", "jv-an-row"); volRow.appendChild(el("span", "jv-an-row-label", tr("an.volume")));
    const vol = document.createElement("input"); vol.type = "range"; vol.className = "jv-an-range"; vol.min = "0"; vol.max = "1"; vol.step = "0.05"; vol.value = String(profile.volume != null ? profile.volume : 1);
    vol.addEventListener("input", function () { profile.volume = parseFloat(vol.value); saveProfile(); const v = ttsVolume(); if (currentAudio) currentAudio.volume = v; if (previewAudio) previewAudio.volume = v; }); // adjust ongoing playback immediately
    volRow.appendChild(vol); s5.appendChild(volRow);
    function syncEngineUI() { elKeyField.style.display = profile.engine === "elevenlabs" ? "" : "none"; }
    syncEngineUI();
    const langDd = jvSelect(
      LANGS.map(function (l) { return { value: l.code, label: l.label }; }),
      function () { return lang; },
      function (v) { lang = v; try { localStorage.setItem(LS_LANG, lang); } catch (e) {} syncVoiceToLang(); voiceDd.refresh(); if (window.JV_I18N) JV_I18N.setLang(lang); } // adjust the voice, filter the list, switch the UI language
    );
    s5.appendChild(field(tr("an.language"), langDd.el));

    // 6) Activation (wake word, experimental)
    const s6 = section(tr("an.activation"), tr("an.hint.activation"));
    s6.appendChild(row(tr("an.wake_on"), switchEl(function () { return profile.wakeEnabled; }, function (v) { profile.wakeEnabled = v; saveProfile(); applyWakeWord(); })));
    const wakeIn = input(profile.wakeWord, "Jarvis");
    wakeIn.addEventListener("input", function () { profile.wakeWord = wakeIn.value.trim() || "Jarvis"; saveProfile(); applyWakeWord(); });
    s6.appendChild(row(tr("an.wake_word"), wakeIn));

    // Reset the fields from `profile` (e.g. when "remember" in the chat changes the memory)
    function syncFromProfile() {
      nameIn.value = profile.name || ""; aboutTa.value = profile.about || "";
      addrIn.value = profile.address || ""; instrTa.value = profile.instructions || "";
      wakeIn.value = profile.wakeWord || ""; rate.value = String(profile.rate || 1); vol.value = String(profile.volume != null ? profile.volume : 1);
      body.querySelectorAll(".jv-an-seg").forEach(function (x) { if (x._sync) x._sync(); });
      body.querySelectorAll(".jv-switch").forEach(function (x) { if (x._sync) x._sync(); });
      elKeyIn.value = profile.elevenKey || ""; syncEngineUI();
      engineDd.refresh(); voiceDd.refresh(); langDd.refresh();
      renderMem(); renderNotes(); renderRagDocs();
    }
    syncProfileUI = syncFromProfile;

    function open(target) {
      syncFromProfile();
      ttsHealth().then(function () { engineDd.refresh(); voiceDd.refresh(); }); // refresh local voices/status
      if (profile.engine === "elevenlabs" && profile.elevenKey) elFetchVoices(function () { voiceDd.refresh(); }); // load cloud voices incrementally
      backdrop.setAttribute("data-open", "true");
      setTimeout(function () {
        if (target) { // scroll to a specific section (sidebar quick access)
          const secs = body.querySelectorAll(".jv-an-sec");
          for (let i = 0; i < secs.length; i++) { const h = secs[i].querySelector(".jv-an-sec-h"); if (h && h.textContent.indexOf(target) !== -1) { secs[i].scrollIntoView({ block: "start" }); return; } }
        }
        body.scrollTop = 0; try { nameIn.focus(); } catch (e) {}
      }, 80);
    }
    function close() { voiceDd.close(); langDd.close(); backdrop.setAttribute("data-open", "false"); }
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && backdrop.getAttribute("data-open") === "true") close(); });
    return { open: open, close: close };
  }

  // ---------- Reusable overlay (modal) + small UI helpers for custom popups ----------
  const X_SVG = HI("x", { size: 13 });
  function buildOverlay(opts) {
    const backdrop = el("div", "jv-an-backdrop" + (opts.cls ? " " + opts.cls : ""));
    const modal = el("div", "jv-an");
    if (opts.width) modal.style.width = "min(" + opts.width + "px, 100%)";
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", opts.title);
    const head = el("div", "jv-an-head");
    if (opts.icon) { const ic = el("span", "jv-ov-ico"); ic.innerHTML = opts.icon; head.appendChild(ic); }
    head.appendChild(el("h2", "jv-an-title", opts.title));
    const closeBtn = el("button", "jv-an-close"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", tr("an.close"));
    closeBtn.innerHTML = X_SVG;
    head.appendChild(closeBtn);
    const bodyEl = el("div", "jv-an-body");
    modal.append(head, bodyEl); backdrop.appendChild(modal); document.body.appendChild(backdrop);
    function open() { backdrop.setAttribute("data-open", "true"); bodyEl.scrollTop = 0; }
    function close() { backdrop.setAttribute("data-open", "false"); }
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && backdrop.getAttribute("data-open") === "true") close(); });
    return { open: open, close: close, body: bodyEl, head: head };
  }
  function ovInput(ph) { const i = document.createElement("input"); i.type = "text"; i.className = "jv-an-input"; if (ph) i.placeholder = ph; return i; }
  function ovTextarea(ph) { const t = document.createElement("textarea"); t.className = "jv-an-textarea"; if (ph) t.placeholder = ph; return t; }
  function ovSwitch(parent, label, get, set) {
    const r = el("div", "jv-an-row"); r.appendChild(el("span", "jv-an-row-label", label));
    const sw = el("div", "jv-switch"); sw.appendChild(el("span", "jv-switch-knob")); sw.setAttribute("role", "switch"); sw.tabIndex = 0;
    function sync() { const v = !!get(); sw.classList.toggle("is-on", v); sw.setAttribute("aria-checked", String(v)); }
    function toggle() { set(!get()); sync(); }
    sw.addEventListener("click", toggle); sw.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    sync(); r.appendChild(sw); parent.appendChild(r); return sync;
  }
  function ovDelBtn(onClick) { const d = el("button", "jv-an-mem-del"); d.type = "button"; d.setAttribute("aria-label", tr("an.delete")); d.innerHTML = X_SVG; d.addEventListener("click", onClick); return d; }

  // ---------- Notes & reminders (own popup, amber-colored, narrow) ----------
  function buildNotes() {
    const ov = buildOverlay({ title: tr("notes.title"), width: 460, cls: "jv-ov-notes",
      icon: HI("note", { size: 17 }) });
    const b = ov.body;
    const s1 = el("div", "jv-an-sec"); s1.appendChild(el("div", "jv-an-sec-h", tr("notes.notes"))); b.appendChild(s1);
    const list = el("div", "jv-an-mem"); s1.appendChild(list);
    const addRow = el("div", "jv-an-mem-add"); const inp = ovInput(tr("notes.new_ph")); const addB = el("button", "jv-an-btn is-accent", tr("notes.note")); addB.type = "button"; addRow.append(inp, addB); s1.appendChild(addRow);
    const s2 = el("div", "jv-an-sec"); s2.appendChild(el("div", "jv-an-sec-h", tr("notes.reminders"))); b.appendChild(s2);
    const rlist = el("div", "jv-an-mem"); s2.appendChild(rlist);
    const rRow = el("div", "jv-an-mem-add"); const rInp = ovInput(tr("notes.remind_ph")); const rMin = document.createElement("input"); rMin.type = "number"; rMin.min = "1"; rMin.value = "10"; rMin.className = "jv-an-input jv-ov-min"; const rBtn = el("button", "jv-an-btn is-accent", tr("notes.in_min")); rBtn.type = "button"; rRow.append(rInp, rMin, rBtn); s2.appendChild(rRow);
    function fmtRemain(at) { const m = Math.max(0, Math.round((at - Date.now()) / 60000)); return m < 60 ? tr("notes.in_min_s", { m: m }) : tr("notes.in_hour_s", { h: Math.round(m / 60) }); }
    function render() {
      list.innerHTML = "";
      if (!notes.length) list.appendChild(el("div", "jv-an-mem-empty", tr("notes.none")));
      else notes.forEach(function (nt, idx) { const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", nt.t)); it.appendChild(ovDelBtn(function () { notes.splice(idx, 1); saveNotes(); })); list.appendChild(it); });
      rlist.innerHTML = "";
      const rs = reminders.slice().sort(function (a, c) { return a.at - c.at; });
      if (!rs.length) rlist.appendChild(el("div", "jv-an-mem-empty", tr("notes.no_reminders")));
      else rs.forEach(function (r) { const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", r.t + " — " + fmtRemain(r.at))); it.appendChild(ovDelBtn(function () { const i = reminders.indexOf(r); if (i >= 0) { reminders.splice(i, 1); saveReminders(); } })); rlist.appendChild(it); });
    }
    function addNoteUI() { const v = inp.value.trim(); if (!v) return; addNote(v); inp.value = ""; }
    addB.addEventListener("click", addNoteUI); inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addNoteUI(); } });
    function addRemUI() { const v = rInp.value.trim(); const m = Math.max(1, parseInt(rMin.value, 10) || 0); if (!v) return; addReminder(v, Date.now() + m * 60000); rInp.value = ""; }
    rBtn.addEventListener("click", addRemUI); rInp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addRemUI(); } });
    notesRenderers.push(render);
    return { open: function () { render(); ov.open(); }, close: ov.close };
  }

  // ---------- Knowledge base (own popup, blue, wide, upload-focused) ----------
  function buildKnowledge() {
    const ov = buildOverlay({ title: tr("kb.title"), width: 620, cls: "jv-ov-wissen",
      icon: HI("book", { size: 17 }) });
    const sec = el("div", "jv-an-sec"); ov.body.appendChild(sec);
    sec.appendChild(el("div", "jv-an-hint", tr("an.kb_hint", { m: ragEmbedModel() })));
    const ragSync = ovSwitch(sec, tr("kb.use"), function () { return !!profile.rag; }, function (v) { profile.rag = v; saveProfile(); });
    const dz = el("div", "jv-ov-drop"); dz.innerHTML = '<div class="jv-ov-drop-t">' + tr("kb.drop") + '</div><div class="jv-ov-drop-s">.txt · .md · .csv · .json …</div>';
    const fileIn = document.createElement("input"); fileIn.type = "file"; fileIn.accept = ".txt,.md,.csv,.json,.log,text/*"; fileIn.style.display = "none";
    const ta = ovTextarea(tr("kb.or_paste")); const addB = el("button", "jv-an-btn is-accent", tr("kb.add_text")); addB.type = "button";
    const st = el("div", "jv-an-hint", ""); const docs = el("div", "jv-an-mem");
    sec.append(dz, fileIn, ta, addB, st, docs);
    async function renderDocs() { let d = []; try { d = await ragDocList(); } catch (e) {} docs.innerHTML = ""; if (!d.length) { docs.appendChild(el("div", "jv-an-mem-empty", tr("kb.none"))); return; } d.forEach(function (x) { const it = el("div", "jv-an-mem-item"); it.appendChild(el("span", "", x.doc + " (" + tr("an.sections_n", { n: x.chunks }) + ")")); it.appendChild(ovDelBtn(async function () { await ragDeleteDoc(x.doc); renderDocs(); })); docs.appendChild(it); }); }
    async function ingest(name, text) { if (!text || !text.trim()) { st.textContent = tr("kb.pick"); return; } st.textContent = tr("kb.indexing"); try { const n = await ragIngest(name, text); st.textContent = tr("kb.indexed", { name: name, n: n }); if (!profile.rag) { profile.rag = true; saveProfile(); ragSync(); } renderDocs(); } catch (e) { st.textContent = tr("kb.error", { msg: e.message }); } }
    dz.addEventListener("click", function () { fileIn.click(); });
    fileIn.addEventListener("change", function () { const f = fileIn.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = function () { ingest(f.name, String(rd.result || "")); }; rd.readAsText(f); fileIn.value = ""; });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("is-over"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("is-over"); });
    dz.addEventListener("drop", function (e) { e.preventDefault(); dz.classList.remove("is-over"); const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = function () { ingest(f.name, String(rd.result || "")); }; rd.readAsText(f); });
    addB.addEventListener("click", function () { const t = ta.value.trim(); if (!t) { st.textContent = tr("kb.pick"); return; } ta.value = ""; ingest(tr("an.pasted", { t: new Date().toLocaleString(langCfg().bcp, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }), t); });
    return { open: function () { ragSync(); renderDocs(); ov.open(); }, close: ov.close };
  }

  // ---------- Wake word (opt-in): continuous recognition triggers the microphone ----------
  // Hardened: double-start guard, robust auto-restart with backoff, clean stopping,
  // no infinite restart when the microphone is denied, zombie guard (only the current instance restarts).
  let wakeRecog = null, wakeActive = false, wakeStarting = false, wakeRestartTimer = 0, wakeErrors = 0;
  let wakeBlocked = false; // mic denied this session -> no restart loop; the setting stays on
  function wakeIndicator(on) { if (micBtn) micBtn.classList.toggle("jarvis-wake", !!on); }
  function applyWakeWord() { if (profile.wakeEnabled && SR) { wakeBlocked = false; startWakeWord(); } else stopWakeWord(); }
  function startWakeWord() {
    if (!SR || !profile.wakeEnabled || wakeBlocked || wakeActive || wakeStarting || listening) return;
    wakeStarting = true;
    ensureMic().then(function (granted) {
      if (!granted) { wakeStarting = false; wakeBlocked = true; return; } // no wake word without a mic (this session only, the setting stays on)
      if (!profile.wakeEnabled || wakeActive || listening) { wakeStarting = false; return; } // state changed while waiting
      try {
      const rec = new SR();
      wakeRecog = rec;
      rec.lang = langCfg().bcp;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onstart = function () { wakeStarting = false; wakeActive = true; wakeErrors = 0; wakeIndicator(true); };
      rec.onresult = function (e) {
        const word = (profile.wakeWord || "Jarvis").toLowerCase().trim();
        if (!word) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = (e.results[i][0].transcript || "").toLowerCase();
          if (!listening && (t.indexOf(word) !== -1 || t.indexOf("hey " + word) !== -1)) {
            stopWakeWord();
            toggleMic(); // triggers dictation
            return;
          }
        }
      };
      rec.onerror = function (ev) {
        wakeActive = false; wakeStarting = false; wakeIndicator(false);
        if (ev && (ev.error === "not-allowed" || ev.error === "service-not-allowed")) { wakeBlocked = true; return; } // mic denied -> don't restart endlessly (the setting stays on)
        wakeErrors++;
      };
      rec.onend = function () {
        wakeActive = false; wakeStarting = false; wakeIndicator(false);
        if (wakeRecog !== rec) return; // was replaced/stopped
        if (profile.wakeEnabled && !listening) {
          const delay = Math.min(400 * Math.max(1, wakeErrors), 4000); // backoff on repeated errors
          clearTimeout(wakeRestartTimer); wakeRestartTimer = setTimeout(startWakeWord, delay);
        }
      };
      rec.start();
      } catch (e) { wakeStarting = false; wakeActive = false; }
    });
  }
  function stopWakeWord() {
    clearTimeout(wakeRestartTimer);
    const rec = wakeRecog; wakeRecog = null; wakeActive = false; wakeStarting = false; wakeIndicator(false);
    if (rec) { try { rec.onend = rec.onerror = rec.onresult = null; rec.stop(); } catch (e) {} try { if (rec.abort) rec.abort(); } catch (e) {} }
  }

  // ---------- Start ----------
  const anpassen = buildAnpassen();
  // The sidebar "Customize" button opens the hub.
  // Found language-independently via the data-i18n label; text fallback for both languages.
  let anpassenBtn = null;
  const _custLbl = document.querySelector('[data-i18n="nav.customize"]');
  if (_custLbl && _custLbl.closest) anpassenBtn = _custLbl.closest("button");
  if (!anpassenBtn) anpassenBtn = Array.prototype.filter.call(document.querySelectorAll("button[data-row], aside button, nav button"), function (b) { const t = b.textContent; return t.indexOf("Customize") !== -1 || t.indexOf("Anpassen") !== -1; })[0];
  if (anpassenBtn) anpassenBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); anpassen.open(); }, true);
  // Custom popups for Knowledge & Notes (look different from the Customize hub).
  const knowledgeUI = buildKnowledge();
  const notesUI = buildNotes();
  // Extend the sidebar with quick-access entries (clone of the Customize button -> same style, own icon, own popup).
  function addSidebarEntry(label, onOpen, svg, after) {
    if (!anpassenBtn || !anpassenBtn.parentNode) return after;
    const b = anpassenBtn.cloneNode(true);
    b.removeAttribute("data-selected"); b.removeAttribute("aria-current");
    // Remove i18n markers from the clone, otherwise applyStatic (DOMContentLoaded) would overwrite the custom label again.
    ["data-i18n", "data-i18n-aria", "data-i18n-ph", "data-i18n-title"].forEach(function (a) {
      if (b.hasAttribute(a)) b.removeAttribute(a);
      b.querySelectorAll("[" + a + "]").forEach(function (x) { x.removeAttribute(a); });
    });
    const lab = b.querySelector(".truncate") || b.querySelector("span.min-w-0");
    if (lab) lab.textContent = label;
    const ic = b.querySelector('[data-cds="Icon"]') || (b.querySelector(".df-leading-slot") && b.querySelector(".df-leading-slot").querySelector("span"));
    if (ic) { ic.textContent = ""; ic.style.fontFamily = ""; ic.innerHTML = svg; }
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onOpen(); }, true);
    after.parentNode.insertBefore(b, after.nextSibling);
    return b;
  }
  const ICON_WISSEN = HI("book", { size: 16 });
  const ICON_NOTIZ = HI("note", { size: 16 });
  const wissenEntry = addSidebarEntry(tr("sidebar.knowledge"), function () { knowledgeUI.open(); }, ICON_WISSEN, anpassenBtn);
  // "Notes" removed as a sidebar entry (notes remain reachable via Customize → "Tools & notes").
  // Remove the "More" and "Routines" entries from the sidebar (not needed). Language-independent via data-i18n or text.
  Array.prototype.forEach.call(document.querySelectorAll("button span"), function (s) {
    const i18n = s.getAttribute("data-i18n"), txt = s.textContent.trim();
    if (i18n === "nav.more" || i18n === "nav.routines" || txt === "Mehr" || txt === "More" || txt === "Routinen" || txt === "Routines") { const b = s.closest("button"); if (b) b.remove(); }
  });
  // ================= Chat sessions: save history + "Recently used" (survives restart) =========
  // Chats live in localStorage (jarvis.chats). Images are stripped before saving so
  // the 5 MB limit doesn't overflow; the running session keeps its images in memory.
  const LS_CHATS = "jarvis.chats";
  const LS_RECSORT = "jarvis.recentsSort";
  let chats = (function () { try { const a = JSON.parse(localStorage.getItem(LS_CHATS) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
  let currentChatId = null;
  let recentsSort = localStorage.getItem(LS_RECSORT) === "alpha" ? "alpha" : "recent";
  let recentsBox = null;

  function persistChats() {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const slim = chats.slice(0, 40).map(function (c) {
          return {
            id: c.id, title: c.title, ts: c.ts,
            msgs: (c.msgs || []).map(function (m) {
              const o = { role: m.role, content: String(m.content || "") };
              if (m.tool_calls) o.tool_calls = m.tool_calls;
              if (m.tool_name) o.tool_name = m.tool_name;
              return o;
            }),
          };
        });
        localStorage.setItem(LS_CHATS, JSON.stringify(slim));
        return;
      } catch (e) { if (chats.length > 4) chats = chats.slice(0, Math.max(4, Math.floor(chats.length / 2))); else return; }
    }
  }
  function chatTitleFrom(msgs) {
    const u = (msgs || []).find(function (m) { return m.role === "user" && m.content && String(m.content).trim(); });
    const t = (u ? String(u.content) : "").trim().replace(/\s+/g, " ");
    if (!t) return tr("chat.untitled");
    return t.length > 48 ? t.slice(0, 47) + "…" : t;
  }
  function saveCurrentChat() {
    const real = messages.some(function (m) { return m.role === "user" || m.role === "assistant"; });
    if (!real) return;
    if (!currentChatId) currentChatId = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    let c = chats.find(function (x) { return x.id === currentChatId; });
    if (!c) { c = { id: currentChatId }; }
    c.title = chatTitleFrom(messages);
    c.ts = Date.now();
    c.msgs = messages.map(function (m) { return m; });
    chats = [c].concat(chats.filter(function (x) { return x.id !== c.id; })); // move the current one to the front
    persistChats();
    renderRecents();
  }
  function clearTranscript() {
    wrap.innerHTML = "";
    if (artPanel) { try { artPanel.close(); } catch (e) {} }
  }
  function replayTranscript(msgs) {
    clearTranscript();
    (msgs || []).forEach(function (m) {
      if (m.role === "user") { welcomeGone = true; addUserBubble(String(m.content || ""), null); }
      else if (m.role === "assistant" && String(m.content || "").trim()) {
        welcomeGone = true;
        const turn = addAssistantTurn();
        const md = el("div", "epitaxy-markdown");
        renderAnswer(md, String(m.content));
        turn.body.appendChild(md);
        turn.finish();
      }
    });
    scrollToEnd();
  }
  function newSession() {
    if (busy) return;
    saveCurrentChat();
    messages.length = 0;
    currentChatId = null;
    clearTranscript();
    clearInput();
    showWelcome();
    renderRecents();
    try { input.focus(); } catch (e) {}
  }
  function loadChat(id) {
    if (busy) return;
    if (id === currentChatId) return;
    saveCurrentChat();
    const c = chats.find(function (x) { return x.id === id; });
    if (!c) return;
    currentChatId = id;
    messages.length = 0;
    (c.msgs || []).forEach(function (m) { messages.push(m); });
    replayTranscript(messages);
    renderRecents();
  }
  function deleteChat(id) {
    chats = chats.filter(function (x) { return x.id !== id; });
    persistChats();
    if (id === currentChatId) newSession(); else renderRecents();
  }
  // Save point: after each completed turn (see the ask() finally hook via a window event).
  window.addEventListener("jv-turn-done", saveCurrentChat);

  // ---- Build the "Recently used" list in the sidebar (replaces the scaffold placeholder) ----
  function buildRecentsBox() {
    const label = document.querySelector('[data-i18n="nav.recent"]');
    const scroll = document.querySelector(".dframe-nav-scroll");
    if (!scroll) return null;
    // Remove the scaffold placeholders (pinned/drag-to-pin/recents stub).
    scroll.querySelectorAll(".dframe-recents-by-mode").forEach(function (n) { n.remove(); });
    const sect = el("div", "jv-recents-sect");
    const head = el("div", "jv-recents-head");
    const title = el("span", "jv-recents-title", tr("nav.recent"));
    const sortBtn = el("button", "jv-recents-sort"); sortBtn.type = "button";
    sortBtn.setAttribute("aria-label", tr("recents.sort"));
    sortBtn.title = tr("recents.sort");
    sortBtn.innerHTML = HI("sorting", { size: 15 });
    sortBtn.addEventListener("click", function () {
      recentsSort = recentsSort === "recent" ? "alpha" : "recent";
      localStorage.setItem(LS_RECSORT, recentsSort);
      renderRecents();
    });
    head.append(title, sortBtn);
    const list = el("div", "jv-recents-list");
    sect.append(head, list);
    scroll.appendChild(sect);
    recentsBox = list;
    return list;
  }
  function renderRecents() {
    if (!recentsBox) return;
    let arr = chats.slice();
    if (recentsSort === "alpha") arr.sort(function (a, b) { return String(a.title || "").localeCompare(String(b.title || "")); });
    else arr.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    recentsBox.innerHTML = "";
    if (!arr.length) {
      recentsBox.appendChild(el("div", "jv-recents-empty", tr("recents.empty")));
      return;
    }
    arr.forEach(function (c) {
      const row = el("div", "jv-recents-row" + (c.id === currentChatId ? " is-active" : ""));
      row.setAttribute("role", "button"); row.setAttribute("tabindex", "0");
      const t = el("span", "jv-recents-label", c.title || tr("chat.untitled"));
      const del = el("button", "jv-recents-del"); del.type = "button";
      del.setAttribute("aria-label", tr("recents.delete")); del.title = tr("recents.delete");
      del.innerHTML = HI("x", { size: 13 });
      row.append(t, del);
      const go = function () { loadChat(c.id); };
      row.addEventListener("click", go);
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(c.id); });
      recentsBox.appendChild(row);
    });
  }

  // ---- Wire up the three chrome buttons of the sidebar: New session, Collapse, Search ----
  (function wireSidebarChrome() {
    // "New session" (top, Ctrl+Shift+O)
    const newBtn = document.querySelector('[data-i18n="nav.new"]');
    const newRow = newBtn && newBtn.closest("button");
    if (newRow) newRow.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); newSession(); }, true);
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "O" || e.key === "o")) { e.preventDefault(); newSession(); }
    });
    // Collapse-sidebar button (panel icon top right) + floating re-open button.
    const collapseBtn = document.getElementById("base-ui-_r_b8_") || document.querySelector('button[aria-label="Collapse sidebar"]');
    const expandBtn = el("button", "jv-sidebar-expand"); expandBtn.type = "button";
    expandBtn.setAttribute("aria-label", tr("sidebar.expand")); expandBtn.title = tr("sidebar.expand");
    expandBtn.innerHTML = HI("sidebar", { size: 18 });
    document.body.appendChild(expandBtn);
    function setCollapsed(on) {
      document.documentElement.classList.toggle("jv-sidebar-collapsed", on);
      if (collapseBtn) collapseBtn.setAttribute("aria-pressed", String(on));
    }
    if (collapseBtn) collapseBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); setCollapsed(true); }, true);
    expandBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); setCollapsed(false); });
    // Search button (magnifier) -> chat search
    const searchBtn = document.getElementById("base-ui-_r_ba_") || document.querySelector('button[aria-label="Search"]');
    if (searchBtn) searchBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openChatSearch(); }, true);
  })();

  // ---- Chat search (overlay): filters by title + message content, click loads the chat ----
  let searchUI = null;
  function buildChatSearch() {
    const ov = buildOverlay({ title: tr("search.title"), width: 560, icon: HI("search", { size: 18 }), cls: "jv-ov-search" });
    const inp = document.createElement("input");
    inp.type = "search"; inp.className = "jv-an-input jv-search-input";
    inp.placeholder = tr("search.ph"); inp.autocomplete = "off";
    const results = el("div", "jv-search-results");
    ov.body.append(inp, results);
    function render() {
      const q = inp.value.trim().toLowerCase();
      results.innerHTML = "";
      const hits = chats.filter(function (c) {
        if (!q) return true;
        if (String(c.title || "").toLowerCase().indexOf(q) >= 0) return true;
        return (c.msgs || []).some(function (m) { return String(m.content || "").toLowerCase().indexOf(q) >= 0; });
      }).slice(0, 30);
      if (!hits.length) { results.appendChild(el("div", "jv-search-empty", tr("search.none"))); return; }
      hits.forEach(function (c) {
        const row = el("div", "jv-search-row"); row.setAttribute("role", "button"); row.setAttribute("tabindex", "0");
        const d = new Date(c.ts || Date.now());
        row.innerHTML = '<span class="jv-search-t"></span><span class="jv-search-d">' + d.toLocaleDateString() + "</span>";
        row.querySelector(".jv-search-t").textContent = c.title || tr("chat.untitled");
        const go = function () { ov.close(); loadChat(c.id); };
        row.addEventListener("click", go);
        row.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
        results.appendChild(row);
      });
    }
    inp.addEventListener("input", render);
    return { open: function () { ov.open(); render(); setTimeout(function () { inp.focus(); }, 30); } };
  }
  function openChatSearch() { if (!searchUI) searchUI = buildChatSearch(); searchUI.open(); }

  // Set the sidebar icons as HugeIcons (our own markup provides empty slots).
  (function setSidebarIcons() {
    var cb = document.getElementById("base-ui-_r_b8_"); if (cb) cb.innerHTML = HI("sidebar", { size: 17 });
    var sb = document.getElementById("base-ui-_r_ba_"); if (sb) sb.innerHTML = HI("search", { size: 17 });
    var setRowIco = function (labelSel, icon) {
      var lbl = document.querySelector(labelSel), btn = lbl && lbl.closest("button");
      var slot = btn && btn.querySelector(".jv-sb-ico span");
      if (slot) slot.innerHTML = HI(icon, { size: 17 });
    };
    setRowIco('[data-i18n="nav.new"]', "plus");
    setRowIco('[data-i18n="nav.customize"]', "customize");
  })();

  buildRecentsBox();
  renderRecents();

  // On UI language change: relabel dynamically created, persistent UI (i18n.js handles the static strings).
  if (window.JV_I18N) JV_I18N.onChange(function () {
    try { if (idChip && idChip.relabel) idChip.relabel(); } catch (e) {}
    try { renderVoiceTgl(); } catch (e) {}
    try { updateModeLabel(false); updateEffortLabel(false); } catch (e) {}
    try { const pph = input.querySelector("p.is-empty"); if (pph) pph.setAttribute("data-placeholder", inputPlaceholder()); } catch (e) {}
    try { var lw = wissenEntry && (wissenEntry.querySelector(".truncate") || wissenEntry.querySelector("span.min-w-0")); if (lw) lw.textContent = tr("sidebar.knowledge"); } catch (e) {}
    try { updateWelcome(); } catch (e) {}
    try { const rt = document.querySelector(".jv-recents-title"); if (rt) rt.textContent = tr("nav.recent"); renderRecents(); } catch (e) {}
  });
  updateWelcome();
  applyWakeWord();
  ttsHealth(); // detect the local XTTS server (for hyper-realistic reading aloud)
  whisperHealth(); // detect the local Whisper STT server (offline dictation) + warm it up
  checkReminders();
  setInterval(checkReminders, 20000); // check for due reminders
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
  clearInput();
  connect();
  console.log("[Oddvark] ready.");
})();
