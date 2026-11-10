// ==UserScript==
// @name         Twitch Utils
// @namespace    nicolaspaillard.twitch.utils
// @version      5.0.2
// @description  Keybind-toggled utility HUD for Twitch, modified for VAFT support — Web Audio chain (gain to 500%, compressor, bass shelf, mono, loudness-derived auto gain), player-core stats and latency control, quality pinning, ad mute/blank, auto-claim, cast, screenshot, PiP.
// @author       Viper (original), nicolaspaillard
// @license      MIT
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/nicolaspaillard/Twitch-Utils/main/twitch-utils.user.js
// @downloadURL  https://raw.githubusercontent.com/nicolaspaillard/Twitch-Utils/main/twitch-utils.user.js
// ==/UserScript==

(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────────
     PATCH TABLE
     Twitch rotates class names on every deploy, so nothing here
     targets a class. These are data-attrs and aria-labels, which
     are far more stable — but they still drift a few times a year.
     When something stops working, it's almost certainly one of
     these strings. Fix it here, not in the logic below.
     ───────────────────────────────────────────────────────────── */
  /* Event names lifted from player-core-variant-a-*.js — the enum reads
     e.AD_BREAK_STARTED="PlayerAdBreakStarted" and so on. These are the real
     signals the player emits; everything we were doing with adMarkers was
     inferring them from CSS side-effects one tick late. */
  const EV = {
    adBreakStart: "PlayerAdBreakStarted",
    adBreakEnd: "PlayerAdBreakEnded",
    adTime: "PlayerAdTimeUpdate",
    qualityChanged: "PlayerQualityChanged",
    stateChanged: "PlayerStateChanged",
  };

  const SEL = {
    video: "video",
    playerRoot: '[data-a-target="video-player"]',
    videoRef: '[data-a-target="video-ref"]',
    claimBonus: 'button[aria-label="Claim Bonus"]',
    primeNag: '[data-a-target="prime-offers-icon"]',
    sidebarArrow: '[data-a-target="side-nav-arrow"]',
    chatCollapse: '[data-a-target="right-column__toggle-collapse-btn"]',
    // age gate wants a typed birth year, not a click
    ageGateForm: '[data-a-target="player-overlay-age-gate-form"]',
    ageGateYear: '[data-a-target="player-overlay-age-gate-year"]',
    ageGateSubmit: '[data-a-target="player-overlay-age-gate-submit"]',
    contentGate: '[data-a-target="player-overlay-content-gate"]',
    adMarkers: [
      '[data-a-target="video-ad-label"]',
      '[data-a-target="video-ad-countdown"]',
      '[data-a-target="ad-countdown-progress-bar"]',
      '[data-test-selector="sad-overlay"]',
    ],
    dismissText: ["start watching", "continue watching", "i'm still here", "accept"],
  };

  /* ─────────────────────────────────────────────────────────────
     CONFIG
     ───────────────────────────────────────────────────────────── */
  const STORE_KEY = "viper_tw_utils";
  const DEFAULTS = {
    menuKey: "²",
    folded: {}, // section slug -> true when collapsed
    panelX: 16,
    panelY: 72,
    // audio
    gain: 1.0, // 1.0 = 100%, ceiling 5.0
    autoGain: false,
    targetLufs: -16, // broadcast-ish target; Twitch streams sit well below this
    comp: false,
    compAmount: 50, // 0-100, maps to threshold + ratio + knee together
    bass: 0, // dB on the low shelf, -10 to +15
    mono: false,
    // ads
    adMute: true,
    adBlank: true,
    // automation
    pinned: null, // quality name to hold, or null for auto
    bgQuality: false, // drop to the bottom of the ladder while the tab is hidden
    autoClaim: true,
    autoDismiss: true,
    // points dashboard / lurk
    pointsChannels: "", // comma-separated logins — also the lurk list
    lurkScale: 18, // % — visual size of the lurk thumbnails
    lurkHidden: false, // collapse the strip (frames keep running)
    // vod
    loopA: null, // seconds, or null
    loopB: null,
    // display
    fitMode: "off", // off | fill (stretch) | cover (crop)
    vidSat: 100, // CSS filter on the video itself, 0-200
    statsOverlay: false,
    collapseChat: false,
    lowLatency: false,
    maxLatency: 0, // seconds; 0 = leave Twitch's default alone
    hidePrime: false,
    hideSidebar: false,
    birthYear: 1990,
  };

  let cfg;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch {
    cfg = { ...DEFAULTS };
  }
  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch {}
  };

  /* ─── HEADLESS (IFRAME) MODE ───────────────────────────────────
     Lurker scripts (e.g. Twitching Lurkist) open real twitch.tv channel pages
     in iframes to hold watch sessions open. Those are same-origin twitch.tv/*,
     so THIS script matches inside every one of them. That's half wanted and
     half a disaster:

       wanted   — the lurker has no claim logic at all, so our autoClaim in each
                  frame is the thing that actually collects the chests. Ditto
                  autoDismiss: an age gate blocks playback, and a frame that
                  never plays is a session that never earns.
       disaster — a HUD per frame, an AudioContext per frame, our quality
                  pinning fighting the lurker's 160p, ad-mute and stats and
                  latency reconciliation all running for nobody.

     So in a frame: claim and dismiss, nothing else. No UI, no audio graph, no
     player commands. Cross-origin window.top access throws — treat a throw as
     "framed", since the conservative answer is the safe one either way. */
  const inFrame = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  /* Frames WE spawned carry ?vtu=lurk. Ours get muted and pinned to the bottom
     of the ladder; a foreign lurker's frames get left alone (it sets its own
     quality and we'd only fight it). Same headless claim path either way. */
  const isOurLurk = inFrame && location.search.includes("vtu=lurk");

  const S = {
    claims: 0,
    adOn: false,
    lufs: null,
    adStart: 0,
    adLeft: null,
    adPod: null,
    adEvent: null,
  }; // adEvent null = no events yet, poll instead
  const $ = (s, r = document) => r.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* Recon caught this: a channel page mounts an outstream ad player alongside the
     stream, so a bare querySelector('video') can return the AD element — and then
     the gain chain and every stat read the wrong thing. Scope to the real player
     and only ever fall back to a loose match if the hooks have drifted. */
  const getVideo = () =>
    $(`${SEL.playerRoot} ${SEL.video}`) || $(`${SEL.videoRef} ${SEL.video}`) || $(SEL.video);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ─── PLAYER CORE ─────────────────────────────────────────────
     Twitch drives an Amazon IVS player (v1.54) and passes the instance around
     as a React prop named mediaPlayerInstance. Climb from <video> to a
     fiber-bearing ancestor, then walk up reading props until it turns up.

     This is why the script must stay @grant none: that keeps us in page
     context. Any @grant value moves us into Tampermonkey's sandbox, and on
     Firefox that means Xray vision — the __reactFiber$ keys go invisible and
     every call here silently degrades to the DOM fallback. */
  const fiberOf = (el) => {
    const k = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
    );
    return k ? el[k] : null;
  };

  let mpi = null,
    bound = null,
    adTimeLogged = false;

  /* Attach once per instance. Everything unbinds on channel change because the
     player gets rebuilt and the old instance goes stale. */
  function bindEvents(m) {
    if (bound === m) return;
    unbindEvents();
    const H = [];
    const on = (name, fn) => {
      try {
        m.addEventListener(name, fn);
        H.push([name, fn]);
      } catch {}
    };

    on(EV.adBreakStart, () => {
      S.adEvent = true;
      onAdStart();
    });
    on(EV.adBreakEnd, () => {
      S.adEvent = false;
      onAdEnd();
    });

    /* Captured payload, IVS 1.54.0-rc.3:
         { adBreakId: 'f2a12a5e…', assetId: 'TWITCH-e0a81584…_Creative',
           breakElapsed: 0.099999, breakDuration: 30,
           creativeElapsed: 0.099999, creativeDuration: 30.234,
           podIndex: 0, podLength: 1 }

       Fires ~10x/sec. The field names are not guessable: duration, adDuration,
       total, currentTime, position, elapsed and time are all absent.

       break* is the whole ad break; creative* is the current spot inside it.
       podIndex/podLength are which spot of how many. Break is what belongs on
       screen — "27s left" beats "8s left" followed by another ad. */
    on(EV.adTime, (e) => {
      if (!adTimeLogged) {
        adTimeLogged = true;
        console.log("%c[PlayerAdTimeUpdate] payload:", "color:#a970ff;font-weight:bold", e);
      }
      if (!e) return;
      if (typeof e.breakDuration === "number" && typeof e.breakElapsed === "number") {
        S.adLeft = Math.max(0, e.breakDuration - e.breakElapsed);
      }
      if (typeof e.podIndex === "number" && typeof e.podLength === "number") {
        S.adPod = [e.podIndex + 1, e.podLength]; // podIndex is 0-based
      }
    });

    /* A stream (re)load wipes worker-side state, so a setting that landed
       before it may not have survived. Only re-ask if we're actually playing
       and it's actually wrong — otherwise every buffering blip re-triggers. */
    on(EV.stateChanged, () => {
      try {
        if (m.getState() === "Playing" && m.isLiveLowLatency() !== !!cfg.lowLatency) {
          llAsked = null;
          llTries = 0;
        }
      } catch {}
    });

    on(EV.qualityChanged, () => {
      qCache = null;
      qPainted = false;
      /* If we're pinned and auto is still off, any change came from you — via
         Twitch's own menu or ours. Adopt it instead of reconciling it away,
         otherwise the pin makes Twitch's quality menu unusable. */
      if (bgSwitching) return; // our own background switch, not a user choice
      try {
        if (cfg.pinned && !m.isAutoQualityMode()) {
          const cur = m.getQuality();
          if (cur && cur.name && cur.name !== cfg.pinned) {
            cfg.pinned = cur.name;
            save();
          }
        }
      } catch {}
    });

    bound = m;
    bindEvents.handlers = H;
    console.log("%c[Twitch Utils] bound " + H.length + " player events", "color:#00e08a");
  }

  function unbindEvents() {
    const H = bindEvents.handlers;
    if (bound && H)
      for (const [n, fn] of H) {
        try {
          bound.removeEventListener(n, fn);
        } catch {}
      }
    bindEvents.handlers = null;
    bound = null;
  }

  function getMPI() {
    if (mpi) {
      try {
        mpi.getState();
        return mpi;
      } catch {
        mpi = null;
        unbindEvents();
      }
    }
    const v = getVideo();
    if (!v) return null;
    let el = v,
      f = null,
      hops = 0;
    while (el && hops < 30 && !(f = fiberOf(el))) {
      el = el.parentElement;
      hops++;
    }
    if (!f) return null;
    let d = 0;
    while (f && d < 80) {
      const p = f.memoizedProps;
      if (p && p.mediaPlayerInstance) {
        mpi = p.mediaPlayerInstance;
        window.__mpi = mpi; // always available in the console, survives reloads
        bindEvents(mpi);
        return mpi;
      }
      f = f.return;
      d++;
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     AUDIO CHAIN
       video → lowshelf → compressor → mono → makeup gain → out

     Web Audio has no bypass, and reconnecting a live graph to
     disable a node is where this normally gets buggy. So the graph
     is built exactly once and every node stays wired forever —
     the toggles only ever set neutral parameter values:
       compressor off → ratio 1:1 (no reduction, transparent)
       bass flat      → shelf gain 0 dB
       mono off       → channelCountMode 'max' (passthrough)
     Nothing is ever disconnected.

     Gain is LAST on purpose. Boosting before compression just gets
     squashed back down; boosting after is true makeup gain. And the
     element's own .volume is applied BEFORE the source node, so
     Twitch's slider keeps working and this multiplies on top.
     ───────────────────────────────────────────────────────────── */
  /* Routing the video into Web Audio has two hard preconditions.
     createMediaElementSource() is irreversible — an element cannot be
     un-routed — and a graph whose context is suspended never pulls, which
     stalls playback until reload.

       1. Require a real user gesture first. Autoplay policy means a fresh
          AudioContext is born suspended.
       2. Require a non-neutral setting. At gain 1.0 with no comp/bass/mono
          there is nothing to do, so stay out of the audio path rather than
          multiplying by one.

     A stalled player looks like this in the console — buffered but not
     advancing:
       jumping 0.1s gap, current position 2.2, new position 2.3
       Audio Buffer start: 0, end: 34 */
  let actx = null,
    nodes = null,
    hookedEl = null,
    gestured = false;

  const audioNeeded = () =>
    cfg.autoGain || cfg.comp || cfg.mono || cfg.gain !== 1 || cfg.bass !== 0;

  function buildChain(v) {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();

    const src = actx.createMediaElementSource(v);

    const bass = actx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 120;

    const comp = actx.createDynamicsCompressor();
    comp.attack.value = 0.005;
    comp.release.value = 0.15;

    // Forcing channelCount to 1 with an explicit count mode makes Web Audio
    // downmix using the 'speakers' rule — which for stereo is exactly
    // 0.5*(L+R). Connecting onward to a 2-channel destination upmixes it
    // back out to both sides. A real sum, not "left copied to both".
    const mono = actx.createGain();
    mono.channelInterpretation = "speakers";

    const out = actx.createGain();

    src.connect(bass).connect(comp).connect(mono).connect(out).connect(actx.destination);
    nodes = { src, bass, comp, mono, out };
    applyAudio();
  }

  function hookAudio() {
    if (!audioNeeded()) return; // nothing to do — stay out of the audio path
    if (!gestured) return; // never route into a context we can't resume
    const v = getVideo();
    if (!v || v === hookedEl) return;
    try {
      buildChain(v);
      hookedEl = v;
      resumeAudio();
    } catch {
      // createMediaElementSource throws if this element is already routed.
      // Harmless — means we're already hooked.
    }
  }

  /* Any real interaction anywhere on the page unlocks audio. Capture phase and
     passive so we never interfere with Twitch's own handlers. Deliberately not
     {once:true}: a context can be re-suspended by the browser (backgrounded
     tab, audio focus loss), and if that happens while we're hooked, playback
     stalls again. This has to stay live for the life of the page. */
  function armVisibility() {
    window.addEventListener("visibilitychange", () => bgApply(tabHidden()), true);
  }

  function armGesture() {
    const wake = () => {
      gestured = true;
      resumeAudio();
    };
    for (const e of ["pointerdown", "keydown", "touchstart"]) {
      window.addEventListener(e, wake, { capture: true, passive: true });
    }
  }

  /* Watchdog: hooked but the context isn't running is exactly the stall state.
     Shouldn't be reachable now, but if it ever is, say so loudly rather than
     letting someone spend an evening blaming Twitch. */
  function audioWatchdog() {
    if (!hookedEl || !actx) return;
    if (actx.state === "running") return;
    resumeAudio();
    if (actx.state !== "running" && !audioWatchdog.warned) {
      audioWatchdog.warned = true;
      console.warn(
        "%c[Twitch Utils] AudioContext is " +
          actx.state +
          " while hooked to the video — this stalls playback. Click the page.",
        "color:#ff4d5e;font-weight:bold",
      );
    }
  }

  function applyAudio() {
    if (!nodes) return;

    nodes.bass.gain.value = cfg.bass;

    if (cfg.comp) {
      const a = cfg.compAmount / 100;
      nodes.comp.threshold.value = -18 - a * 27; // -18 → -45 dBFS
      nodes.comp.ratio.value = 2 + a * 10; //   2 → 12 : 1
      nodes.comp.knee.value = 30 - a * 24; //  30 → 6  dB (softer → harder)
    } else {
      nodes.comp.threshold.value = 0;
      nodes.comp.ratio.value = 1; // 1:1 = transparent
      nodes.comp.knee.value = 0;
    }

    if (cfg.mono) {
      nodes.mono.channelCount = 1;
      nodes.mono.channelCountMode = "explicit";
    } else {
      nodes.mono.channelCountMode = "max"; // set mode first on the way back
      nodes.mono.channelCount = 2;
    }

    nodes.out.gain.value = cfg.gain;
  }

  /* Twitch measures every stream's integrated loudness and caches it under
     video_ads.stream_loudness — it's there so their ad insertion can match
     levels. It's a real LUFS figure, per channel, already computed. Which means
     the correct makeup gain is arithmetic, not guesswork:

       gain_dB     = target − measured
       gain_linear = 10 ^ (gain_dB / 20)

     A stream at -27.2 LUFS against a -16 target wants +11.2 dB ≈ 3.6×. That's
     why quiet streamers make you reach for the slider — and why the number the
     slider should show was sitting in localStorage the whole time. */
  function readLoudness() {
    try {
      const j = JSON.parse(localStorage.getItem("video_ads.stream_loudness") || "null");
      if (j && typeof j.loudness === "number" && isFinite(j.loudness)) return j.loudness;
    } catch {}
    return null;
  }

  function autoGain() {
    if (!cfg.autoGain) return;
    const lufs = readLoudness();
    if (lufs === null) return;
    S.lufs = lufs;
    const want = clamp(Math.pow(10, (cfg.targetLufs - lufs) / 20), 0.1, 5);
    if (Math.abs(want - cfg.gain) < 0.02) return; // don't thrash the node
    cfg.gain = want;
    applyAudio();
    save();
    const sl = root && $("#s-gain", root);
    if (sl) sl.value = want;
    paintAudio();
  }

  // Autoplay policy suspends the context until a user gesture.
  const resumeAudio = () => {
    if (actx && actx.state === "suspended") actx.resume();
  };

  /* Ambilight was removed and must not be re-added inside the player. A canvas
     mounted in [data-a-target="video-player"] behind the video is invisible on
     a 16:9 stream in a 16:9 player: the video covers the whole container, and
     the scale() spread meant to push the glow past the edges is clipped by the
     container's overflow. It only ever shows in letterbox bars. A working
     version must mount outside the player, which means fighting Twitch's grid,
     surviving theatre/fullscreen, and re-parenting on every SPA nav. */

  /* ─── POINTS DASHBOARD ─────────────────────────────────────────
     Reading a balance isn't gated on a watch session — only EARNING is. So one
     tab can show every channel's balance without a player running anywhere.
     That's the whole reason this is worth doing and the claim mutation isn't.

     Hashes are learned, not hardcoded. Twitch's own client calls
     ChannelPointsContext on every channel page load, so the current hash passes
     this hook seconds after boot; read off the wire it cannot go stale. The
     constant below is a cold-start fallback for a fresh profile's first few
     seconds and is overwritten as soon as traffic flows.

     Auth is lifted the same way — never read from storage, never persisted,
     never logged. The token is the account.

     (Hashes are NOT secret — they're public whitelist ids — so unlike the token
     they're safe to persist, which is what makes cold start work at all.) */
  const PQ_FALLBACK = "7fe050e3761eb2cf258d70ee1a21cbd76fa8cf3d7e7b12fc437e7029d446b5e3";
  const PQ_WANT = ["ChannelPointsContext", "ClaimCommunityPoints", "FollowingLive_CurrentUser"];
  const PQ_KEY = "viper_tw_pq";

  /* Learn the VARIABLE SHAPE as well as the hash, for every op we send.
     A learned hash paired with hardcoded variables is only half self-healing:
     it survives a hash rotation and rots on a schema change. Twitch added a
     required includeCostreaming argument at some point, which kills any caller
     still sending { limit: 50, includeIsDJ: false } with
        Variable "includeCostreaming" has invalid value null

     A learned hash paired with hardcoded variables is only half self-healing —
     it survives a hash rotation and rots on a schema change. Read both off the
     wire. Twitch sends whatever it currently requires; we echo it back and
     override only the fields we actually mean to change. */
  let pqHashes = {},
    pqVars = {};
  try {
    const j = JSON.parse(localStorage.getItem(PQ_KEY) || "{}");
    pqHashes = j.hashes || {};
    pqVars = j.vars || {};
  } catch {}
  const savePq = () => {
    try {
      localStorage.setItem(PQ_KEY, JSON.stringify({ hashes: pqHashes, vars: pqVars }));
    } catch {}
  };
  const PQ_VARS_WANT = ["ClaimCommunityPoints", "FollowingLive_CurrentUser"];
  const needHashes = () =>
    PQ_WANT.some((n) => !pqHashes[n]) || PQ_VARS_WANT.some((n) => !pqVars[n]);
  const pointsHash = () => pqHashes.ChannelPointsContext || PQ_FALLBACK;

  let gqlAuth = null,
    gqlCid = null;
  const origFetch = window.fetch;

  /* Request bodies can be strings, Blobs, or ReadableStreams depending on how
     fetch was called — new Response(x).text() normalises all of them. Learned
     this the hard way in the sniffer, where reading .body off a Request gave a
     stream, JSON.parse threw, and the catch ate it silently. */
  async function bodyOf(input, init) {
    if (init && init.body != null) {
      if (typeof init.body === "string") return init.body;
      try {
        return await new Response(init.body).text();
      } catch {
        return null;
      }
    }
    if (input && typeof input.clone === "function") {
      try {
        return await input.clone().text();
      } catch {
        return null;
      }
    }
    return null;
  }

  async function learnHashes(input, init) {
    const body = await bodyOf(input, init);
    if (!body) return;
    let reqs;
    try {
      reqs = JSON.parse(body);
    } catch {
      return;
    }
    const arr = Array.isArray(reqs) ? reqs : [reqs]; // Twitch batches constantly
    let changed = false;
    for (const q of arr) {
      const n = q && q.operationName;
      const h =
        q && q.extensions && q.extensions.persistedQuery && q.extensions.persistedQuery.sha256Hash;
      if (!n || !PQ_WANT.includes(n)) continue;
      if (h && pqHashes[n] !== h) {
        pqHashes[n] = h;
        changed = true;
        console.log(`%c[Twitch Utils] learned ${n} hash from live traffic`, "color:#00e08a");
      }
      if (PQ_VARS_WANT.includes(n) && q.variables && !pqVars[n]) {
        pqVars[n] = q.variables;
        changed = true;
        console.log(
          `%c[Twitch Utils] learned ${n} variable shape from live traffic`,
          "color:#00e08a;font-weight:bold",
          q.variables,
        );
      }
    }
    if (changed) savePq();
  }

  (function captureGqlAuth() {
    if (inFrame) return; // the dashboard is main-tab only; don't wrap fetch N times
    window.fetch = function (input, init) {
      try {
        const u =
          typeof input === "string"
            ? input
            : typeof URL !== "undefined" && input instanceof URL
              ? input.href
              : input && input.url;
        if (u && u.includes("gql.twitch.tv")) {
          const h = (init && init.headers) || (input && input.headers);
          const take = (k, v) => {
            if (!v) return;
            if (/^authorization$/i.test(k)) gqlAuth = v;
            if (/^client-id$/i.test(k)) gqlCid = v;
          };
          if (h) {
            if (typeof h.get === "function") {
              take("authorization", h.get("Authorization"));
              take("client-id", h.get("Client-Id"));
            } else if (Array.isArray(h)) for (const [k, v] of h) take(k, v);
            else for (const [k, v] of Object.entries(h)) take(k, v);
          }
          /* Stop parsing bodies the moment we have what we need — after the
             first channel page that's zero work per request, forever. */
          if (needHashes()) learnHashes(input, init);
        }
      } catch {}
      return origFetch.apply(this, arguments); // always pass through untouched
    };
  })();

  /* ─── ONE DOOR FOR EVERY GQL CALL ──────────────────────────────
     Three call sites had built this request by hand: same headers three times,
     three DIFFERENT 429 messages, and stale-hash eviction written out twice —
     so the schema-change path only existed for the two ops I happened to
     remember. Anything added later would have silently lacked it.

     Everything goes through here now: auth check, headers, batching, 429, and
     eviction keyed off whatever op actually failed rather than a hardcoded
     name. Add an op tomorrow and it inherits all of it. */
  async function gqlPost(ops) {
    if (!gqlAuth) throw new Error("no auth seen yet — browse for a second");
    const sent = Array.isArray(ops) ? ops : [ops];
    const res = await origFetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        "Client-Id": gqlCid || "kimne78kx3ncx6brgo4mv6wki5h1ko",
        Authorization: gqlAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sent),
    });
    if (res.status === 429) throw new Error("rate limited — wait a bit");
    if (!res.ok) throw new Error("HTTP " + res.status);

    const j = await res.json();
    const out = Array.isArray(j) ? j : [j];
    const errs = JSON.stringify(out.map((x) => x && x.errors));

    /* Evict by the op that failed, not by name. A stale value in localStorage
       must never be permanent — that's what makes "self-healing" true rather
       than a comment. */
    if (/PersistedQueryNotFound/i.test(errs)) {
      for (const o of sent) if (o.operationName) delete pqHashes[o.operationName];
      savePq();
      throw Object.assign(new Error("hash rotated — relearning"), { relearn: true });
    }
    if (/invalid value|of required type/i.test(errs)) {
      for (const o of sent) if (o.operationName) delete pqVars[o.operationName];
      savePq();
      throw Object.assign(new Error("schema changed — reopen that page to relearn"), {
        relearn: true,
      });
    }
    return out;
  }

  const channelList = () =>
    cfg.pointsChannels
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);

  let pts = [],
    ptsBusy = false,
    ptsErr = null;

  /* One POST carrying an array of operations — Twitch's own client batches like
     this constantly (32 requests carried 145 ops in the capture). Twelve
     separate POSTs would be twelve chances to get rate-limited. */
  async function refreshPoints() {
    const chans = channelList();
    if (!chans.length) {
      pts = [];
      ptsErr = null;
      return paintPoints();
    }
    if (ptsBusy) return;
    ptsBusy = true;
    ptsErr = null;
    paintPoints();

    try {
      const body = chans.map((login) => ({
        operationName: "ChannelPointsContext",
        variables: { channelLogin: login, includeGoalTypes: ["CREATOR", "BOOST"] },
        extensions: { persistedQuery: { version: 1, sha256Hash: pointsHash() } },
      }));
      const arr = await gqlPost(body);
      pts = chans.map((login, i) => {
        const d = arr[i];
        if (d && d.errors) return { login, err: (d.errors[0] && d.errors[0].message) || "error" };
        const cp =
          d &&
          d.data &&
          d.data.community &&
          d.data.community.channel &&
          d.data.community.channel.self &&
          d.data.community.channel.self.communityPoints;
        if (!cp) return { login, err: "no data" };
        const comm = d.data.community;
        return {
          login,
          bal: cp.balance,
          claim: !!cp.availableClaim,
          claimId: cp.availableClaim && cp.availableClaim.id,
          cid: comm && comm.id, // channel id — the mutation wants it
        };
      });
    } catch (e) {
      ptsErr = e.message.slice(0, 46);
      /* gqlPost already evicted the stale value; Twitch refires the op on any
         channel page, so one delayed retry usually lands. */
      if (e.relearn && !refreshPoints.retried) {
        refreshPoints.retried = true;
        ptsBusy = false;
        paintPoints();
        return setTimeout(() => {
          refreshPoints.retried = false;
          refreshPoints();
        }, 4000);
      }
    }
    ptsBusy = false;
    paintPoints();
  }

  /* Rebuild the learned claim request with different ids. We don't know where
     in the structure they sit — could be flat, could be under input{} — so walk
     the template and swap any key that looks like a claim/channel id, wherever
     it is. Learned shape, learned nesting, our values. */
  function retarget(tpl, claimId, cid) {
    if (Array.isArray(tpl)) return tpl.map((x) => retarget(x, claimId, cid));
    if (tpl && typeof tpl === "object") {
      const o = {};
      for (const [k, v] of Object.entries(tpl)) {
        if (/^claim_?id$/i.test(k)) o[k] = claimId;
        else if (/^channel_?id$/i.test(k)) o[k] = cid;
        else o[k] = retarget(v, claimId, cid);
      }
      return o;
    }
    return tpl;
  }

  async function claimAll() {
    const ready = pts.filter((p) => p.claim && p.claimId && p.cid);
    if (!ready.length) return note("No chests pending");
    const tpl = pqVars.ClaimCommunityPoints;
    const hash = pqHashes.ClaimCommunityPoints;
    if (!tpl || !hash) {
      return note("Click one chest by hand first — that teaches it the request");
    }

    try {
      const body = ready.map((p) => ({
        operationName: "ClaimCommunityPoints",
        variables: retarget(tpl, p.claimId, p.cid),
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }));
      const arr = await gqlPost(body);
      const bad = arr.filter((x) => x && x.errors).length;
      note(
        bad
          ? `Claimed ${ready.length - bad}/${ready.length} (${bad} failed)`
          : `Claimed ${ready.length} chest(s)`,
      );
      if (bad) console.warn("[claim] errors:", arr.map((x) => x && x.errors).filter(Boolean));
      setTimeout(refreshPoints, 1200); // let the server settle, then re-read
    } catch (e) {
      note("Claim failed: " + e.message.slice(0, 30));
    }
  }

  /* ─── FOLLOWED LIVE ────────────────────────────────────────────
     Twitch fires FollowingLive_CurrentUser whenever /directory/following
     renders, so the hash learns itself like the others. The response shape
     isn't a guess either — Twitching Lurkist parses it as
       obj[0].data.currentUser.followedLiveUsers.edges.map(x => x.node.login)
     with variables { limit: 50, includeIsDJ: false }. That's working code
     against the live API, so the shape is observed rather than assumed.

     Cold start needs one visit to /directory/following for the hash. After
     that it's cached and this works from anywhere. */
  let following = [],
    folBusy = false,
    folErr = null;

  async function refreshFollowing() {
    if (folBusy) return;
    const hash = pqHashes.FollowingLive_CurrentUser;
    const tpl = pqVars.FollowingLive_CurrentUser;
    if (!hash || !tpl) {
      folErr = "open twitch.tv/directory/following once — that teaches the request";
      return paintFollowing();
    }
    folBusy = true;
    folErr = null;
    paintFollowing();

    try {
      /* Twitch's own variables, plus a bigger limit. Spreading the template
         means any argument they add later rides along without us knowing it
         exists — which is the entire point. */
      const [d] = await gqlPost([
        {
          operationName: "FollowingLive_CurrentUser",
          variables: { ...tpl, limit: 50 },
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        },
      ]);
      if (d && d.errors) throw new Error((d.errors[0] && d.errors[0].message) || "error");
      const edges =
        d &&
        d.data &&
        d.data.currentUser &&
        d.data.currentUser.followedLiveUsers &&
        d.data.currentUser.followedLiveUsers.edges;
      if (!edges) throw new Error("unexpected shape — see console");
      following = edges
        .map((e) => {
          const n = e.node || {};
          return {
            login: (n.login || "").toLowerCase(),
            name: n.displayName || n.login,
            viewers: (n.stream && n.stream.viewersCount) || null, // best-effort
          };
        })
        .filter((x) => x.login);
    } catch (e) {
      folErr = e.message.slice(0, 50);
      following = [];
    }
    folBusy = false;
    paintFollowing();
  }

  function toggleChan(login) {
    const list = channelList();
    const next = list.includes(login) ? list.filter((x) => x !== login) : [...list, login];
    cfg.pointsChannels = next.join(", ");
    save();
    const inp = root && $("#s-pch", root);
    if (inp) inp.value = cfg.pointsChannels;
    paintFollowing();
  }

  /* ─── LURK ─────────────────────────────────────────────────────
     Points accrue from a real player holding a real session. Four tabs does
     that; this is four tabs folded into one page.

     The iframe is built at 1000x480 and CSS-scaled down, NOT built small.
     Twitch's layout is responsive — at thumbnail width it collapses and the
     player never initialises. The frame has to BELIEVE it's desktop-sized.
     (Lifted from Twitching Lurkist, which is the one thing that script does
     that isn't obvious.)

     Differences from that script, deliberately:
       - muted. It sets video-muted:false globally and you get four streams of
         audio at once. Nothing is watching these.
       - quality is pinned via the player API inside the frame, not by writing
         video-quality to localStorage. That key is shared with your real tabs
         — theirs leaves you at 160p everywhere afterward, which their own
         source flags as an unfinished TODO.
       - your page is left intact. Theirs runs clearChildren(document.body).
       - these frames actually claim, via headless mode. Theirs has no claim
         logic at all. */
  let lurkBox = null;
  const lurkFrames = () => (lurkBox ? [...lurkBox.querySelectorAll("iframe")] : []);

  function lurkStop() {
    if (lurkBox) {
      lurkBox.remove();
      lurkBox = null;
    }
    paintLurk();
    note("Lurk stopped");
  }

  function lurkStart() {
    const chans = channelList();
    if (!chans.length) return note("Add channels first");
    lurkStop();

    lurkBox = document.createElement("div");
    lurkBox.id = "vtu-lurk";

    for (const c of chans) {
      const cell = document.createElement("div");
      cell.className = "vtu-lcell";

      const f = document.createElement("iframe");
      f.src = `${location.origin}/${encodeURIComponent(c)}?vtu=lurk`;
      /* Same-origin frames inherit autoplay permission, but be explicit —
         without it a player that won't start is a session that never earns. */
      f.setAttribute("allow", "autoplay");
      f.className = "vtu-lframe";

      const tag = document.createElement("span");
      tag.className = "vtu-ltag";
      tag.textContent = c;

      cell.append(f, tag);
      lurkBox.append(cell);
    }

    document.body.append(lurkBox);
    paintLurk();
    note(`Lurking ${chans.length} channel(s)`);
  }

  function paintKey() {
    if (!root) return;
    const b = $("#b-key", root);
    if (b) b.textContent = capturingKey ? "press a key…" : keyLabel(cfg.menuKey);
    const f = $("#v-footkey", root);
    if (f) f.textContent = keyLabel(cfg.menuKey);
  }

  function paintLurk() {
    if (!root) return;
    const n = lurkFrames().length;
    const b = $("#v-lurk", root);
    if (b) b.textContent = n ? `${n} frame(s) running` : "not running";
    /* Do not add `.disabled = !n` here. It leaves the size slider dead until
       frames exist, so setting a size before starting reads as broken. The
       Disabling a control is only correct when something else genuinely owns
       its value (gain vs autoGain). Nothing owns this one — a feature being off
       is not a reason to make its settings unreachable. */
    $("#v-lscale", root).textContent = cfg.lurkScale + "%";
    if (!lurkBox) return;
    lurkBox.style.display = cfg.lurkHidden ? "none" : "flex";
    const sc = cfg.lurkScale / 100;
    for (const cell of lurkBox.querySelectorAll(".vtu-lcell")) {
      cell.style.width = Math.round(1000 * sc) + "px";
      cell.style.height = Math.round(480 * sc) + "px";
      const f = cell.querySelector("iframe");
      if (f) f.style.transform = `scale(${sc})`;
      const tag = cell.querySelector(".vtu-ltag");
      if (tag) tag.style.display = cfg.lurkScale < 8 ? "none" : ""; // no room for it
    }
  }

  /* ─── VOD TOOLS ────────────────────────────────────────────────
     Seeking goes through video.currentTime, NOT m.seekTo(). seekTo is in the
     probe's method list — so was setLiveMaxLatency, which throws
     UnboundTypeError because it takes a twitch::MediaTime that Embind never
     bound in this build. seekTo near-certainly takes the same type. currentTime
     does the identical job with no WASM boundary to be refused at.

     Live is Infinity, VOD is a real number — measured back when getDuration()
     during an ad came back Infinity, which is how we know it's a live/VOD
     discriminator and not just a quirk. */
  const isVod = () => {
    if (location.pathname.startsWith("/videos/")) return true;
    const m = getMPI();
    if (!m) return false;
    try {
      return isFinite(m.getDuration());
    } catch {
      return false;
    }
  };

  /* Frame-step and A/B loop only ever needed currentTime to be movable — which
     is true of a live stream WITH a DVR window too, not just a VOD. isVod() was
     the wrong gate; seekability is the right one. */
  const canSeek = () => isVod() || canRewind();

  /* ─── SEEKABLE WINDOW ──────────────────────────────────────────
     Whether a live stream can be rewound is not a matter of opinion —
     video.seekable IS the answer. HLS live carries a DVR window; how much of it
     the player keeps seekable is Twitch's call and varies by channel and by
     whether the broadcaster stores VODs.

     Everything below reads that range instead of assuming. If the window is
     real we can seek in it with currentTime (never seekTo — twitch::MediaTime
     is unbound, same as setLiveMaxLatency). If it isn't, no amount of code
     invents segments the player never fetched. */
  function seekWindow() {
    const v = getVideo();
    if (!v || !v.seekable || !v.seekable.length) return null;
    const i = v.seekable.length - 1;
    const start = v.seekable.start(i),
      end = v.seekable.end(i);
    if (!isFinite(start) || !isFinite(end)) return null;
    return { start, end, span: end - start, at: v.currentTime, behind: end - v.currentTime };
  }

  const canRewind = () => {
    const w = seekWindow();
    return !!(w && w.span > 10);
  };

  /* ─── WHY THE WINDOW IS YOUR SESSION, NOT THE BROADCAST ────────
     For an MSE source, seekable IS buffered — what the player fetched and still
     holds. Twitch's live playlist is a sliding window listing only recent
     segments, so anything from before you tuned in was never in a manifest your
     player saw. There is nothing to request. The window therefore starts at
     zero and grows with watch time, until the SourceBuffer evicts under memory
     pressure.

     MediaSource.setLiveSeekableRange() can DECLARE a wider range (IVS ships a
     wrapper for it — the string is in the wasm), but declaring it doesn't
     conjure segments: the seek would just fail against a playlist that never
     listed them. There is no client-side fix. The archive VOD is the only place
     the earlier part of the broadcast exists. */
  function watchFromStart() {
    const ch = location.pathname.split("/")[1];
    if (!ch || location.pathname.startsWith("/videos/")) return note("Not on a channel");
    /* Deliberately the archive LIST rather than a guessed /videos/<id>: the id
       needs an op we've never observed, and inventing one is how the last three
       bugs started. Newest archive = the broadcast in progress. */
    window.open(
      `${location.origin}/${encodeURIComponent(ch)}/videos?filter=archives&sort=time`,
      "_blank",
      "noopener",
    );
    note("Opened archives — newest is this broadcast");
  }

  function dumpSeek() {
    const v = getVideo();
    const m = getMPI();
    if (!v) return note("No video");
    const rows = { pathname: location.pathname };
    try {
      rows.duration = m ? m.getDuration() : v.duration;
    } catch {
      rows.duration = v.duration;
    }
    rows.live = !isFinite(rows.duration);
    rows.currentTime = +v.currentTime.toFixed(2);
    const rng = (tr) => {
      const out = [];
      for (let i = 0; i < tr.length; i++)
        out.push(`${tr.start(i).toFixed(1)}–${tr.end(i).toFixed(1)}`);
      return out.join("  ") || "(none)";
    };
    rows.seekable = rng(v.seekable);
    rows.buffered = rng(v.buffered);
    const w = seekWindow();
    rows.rewindWindow = w ? `${w.span.toFixed(1)}s (${(w.span / 60).toFixed(1)} min)` : "none";
    try {
      if (m) rows.getStartOffset = m.getStartOffset();
    } catch {}
    console.log(
      "%c[seek] what this stream will actually let you do",
      "color:#a970ff;font-weight:bold",
      rows,
    );
    if (!w || w.span <= 10) {
      console.log(
        "%c[seek] no usable window — the player is not holding past segments " +
          "seekable on this stream.",
        "color:#ffb44d",
      );
      return note("No rewind window on this stream");
    }
    note(`Rewind window: ${(w.span / 60).toFixed(1)} min`);
  }

  /* Seeking backwards on a live edge means we're no longer live; the player's
     own catch-up would drag us forward, so stand our latency cap down while
     the user is deliberately behind. */
  function seekBy(sec) {
    const v = getVideo();
    if (!v) return;
    const w = seekWindow();
    if (!w || w.span <= 10) return note("Nothing seekable on this stream");
    const t = clamp(v.currentTime + sec, w.start + 0.5, w.end - 0.1);
    v.currentTime = t;
    if (rateHeld) {
      v.playbackRate = 1;
      rateHeld = false;
    }
    const behind = w.end - t;
    note(behind < 2 ? "At live edge" : `-${behind.toFixed(0)}s behind live`);
  }

  function frameStep(dir) {
    const v = getVideo();
    if (!v) return;
    if (!canSeek()) return note("Nothing seekable here");
    const fps = ST.fps && ST.fps > 1 ? ST.fps : 30;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime + dir / fps);
    note(`${dir > 0 ? "+" : ""}${dir} frame @ ${fps.toFixed(0)}fps`);
  }

  const hms = (t) => {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600),
      m = Math.floor((t % 3600) / 60),
      s = t % 60;
    return (h ? h + "h" : "") + (h || m ? m + "m" : "") + s + "s";
  };

  function setLoop(which) {
    const v = getVideo();
    if (!v) return;
    if (!canSeek()) return note("Nothing seekable here");
    cfg[which] = v.currentTime;
    /* A after B is almost always a mis-click, and silently swapping is friendlier
       than an error nobody reads. */
    if (cfg.loopA !== null && cfg.loopB !== null && cfg.loopA > cfg.loopB) {
      const t = cfg.loopA;
      cfg.loopA = cfg.loopB;
      cfg.loopB = t;
    }
    save();
    paintVod();
    note(`${which === "loopA" ? "A" : "B"} = ${hms(v.currentTime)}`);
  }

  function clearLoop() {
    cfg.loopA = cfg.loopB = null;
    save();
    paintVod();
    note("Loop cleared");
  }

  function tickLoop() {
    if (cfg.loopA === null || cfg.loopB === null) return;
    const v = getVideo();
    if (!v || v.paused) return;
    if (v.currentTime >= cfg.loopB || v.currentTime < cfg.loopA - 1) v.currentTime = cfg.loopA;
  }

  function copyTimestamp() {
    const v = getVideo();
    if (!v) return;
    const url = location.origin + location.pathname + "?t=" + hms(v.currentTime);
    navigator.clipboard
      .writeText(url)
      .then(() => note("Timestamp copied"))
      .catch(() => {
        console.log(url);
        note("Clipboard blocked — see console");
      });
  }

  function applyVideoFilter() {
    const v = getVideo();
    if (!v) return;
    v.style.filter = cfg.vidSat === 100 ? "" : `saturate(${cfg.vidSat}%)`;
  }

  /* ─── ASPECT FIT ───────────────────────────────────────────────
     <video> defaults to object-fit: contain — fill the box, keep the aspect,
     bar the remainder. On a display that isn't the stream's aspect that's where
     the black bars come from; nobody added them, they're what's left over.

     Applied unconditionally rather than gated on fullscreen: in a box that
     already matches the video's aspect, object-fit does nothing at all, so
     there's nothing to gate. Windowed stays untouched for free.

     Nothing here can recover the bars — the pixels were never sent. fill
     distorts, cover crops. Pick your loss. */
  function applyFit() {
    const v = getVideo();
    if (!v) return;
    v.style.objectFit = cfg.fitMode === "off" ? "" : cfg.fitMode;
  }

  /* What the choice actually costs, measured off this display right now rather
     than described in the abstract. */
  function fitCost() {
    const v = getVideo();
    if (!v || !v.videoWidth) return null;
    const va = v.videoWidth / v.videoHeight;
    const box = v.getBoundingClientRect();
    const ba = box.width && box.height ? box.width / box.height : va;
    if (!isFinite(va) || !isFinite(ba) || ba <= 0) return null;
    const r = ba / va;
    return {
      video: va,
      box: ba,
      stretch:
        Math.abs(r - 1) < 0.01
          ? null
          : r > 1
            ? `${Math.round((r - 1) * 100)}% wider`
            : `${Math.round((1 / r - 1) * 100)}% taller`,
      crop:
        Math.abs(r - 1) < 0.01
          ? null
          : r > 1
            ? `${Math.round((1 - 1 / r) * 100)}% of height`
            : `${Math.round((1 - r) * 100)}% of width`,
    };
  }

  /* ─────────────────────────────────────────────────────────────
     STATS
     ───────────────────────────────────────────────────────────── */
  const ST = {
    fps: 0,
    dropped: 0,
    total: 0,
    buf: 0,
    res: "—",
    lat: null,
    bitrate: null,
    bw: null,
    lowLat: null,
    qname: null,
    auto: null,
  };
  let lastFrames = 0,
    lastStamp = 0;

  function resetStats() {
    lastFrames = 0;
    lastStamp = 0;
    ST.fps = 0;
  }

  function tickStats() {
    const v = getVideo();
    if (!v) return;

    /* The player knows all of this natively and more accurately than the video
       element does — real encoder framerate rather than a delta guess, actual
       bitrate, and latency for free. Fall back to the DOM only if the fiber
       walk came up empty. */
    const m = getMPI();
    if (m) {
      try {
        ST.lat = m.getLiveLatency();
        ST.buf = m.getBufferDuration();
        ST.fps = m.getVideoFrameRate();
        ST.dropped = m.getDroppedFrames();
        ST.total = m.getDecodedFrames();
        ST.bitrate = m.getVideoBitRate();
        ST.bw = m.getBandwidthEstimate();
        ST.res = `${m.getVideoWidth()}×${m.getVideoHeight()}`;
        ST.lowLat = m.isLiveLowLatency();
        const q = m.getQuality();
        ST.qname = q && q.name ? q.name : null;
        ST.auto = m.isAutoQualityMode();
        return;
      } catch {
        mpi = null;
      } // instance went stale, fall through
    }

    ST.res = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "—";

    if (v.buffered.length) {
      ST.buf = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime);
    }

    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    if (!q) return;
    ST.dropped = q.droppedVideoFrames;
    ST.total = q.totalVideoFrames;

    const now = performance.now();
    if (lastStamp && q.totalVideoFrames >= lastFrames) {
      const dt = (now - lastStamp) / 1000;
      if (dt > 0.3) ST.fps = (q.totalVideoFrames - lastFrames) / dt;
    }
    lastFrames = q.totalVideoFrames;
    lastStamp = now;
  }

  /* Latency comes from the player's own getLiveLatency(). Enabling Twitch's
     stats overlay, hiding it with CSS and scraping its rows also works, and is
     about 40 lines of wall-climbing for a value that's already exposed. */

  const dropPct = () => (ST.total ? (ST.dropped / ST.total) * 100 : 0);
  // .reduction is a live read-only float: current gain reduction in dB.
  const reduction = () => (nodes && cfg.comp ? Math.abs(nodes.comp.reduction) : 0);

  /* ─────────────────────────────────────────────────────────────
     FEATURE TICKS
     ───────────────────────────────────────────────────────────── */
  /* Ad muting has one invariant: never leave the stream muted. Being wrongly
     unmuted is a blip; being wrongly muted looks like a dead stream. Every
     ambiguous path therefore resolves toward sound.

     Four rules, each earned by a way this got stuck:
       - mutedByUs is tracked as its own fact, never inferred from priorMuted
         or cfg.adMute. Whether we muted it is history; the current toggle
         doesn't get a vote.
       - restoreAudio() runs BEFORE state is cleared, and its return value
         gates the clear. A failed restore must leave S.adOn set so the next
         tick retries.
       - the DOM keeps a vote even while player events drive. Events are
         faster, not infallible, and only they can fail silently.
       - a watchdog sweeps anything that still slips through. */
  let mutedByUs = false;
  let domClear = 0;
  /* Set when the watchdog force-ends a break. Without it the watchdog unmutes,
     then tickAds sees the still-stuck ad marker on the very next tick and
     re-mutes — the watchdog handing control straight back to the thing that
     was stuck. Stays set until the DOM actually goes clear, so a wedged marker
     can't hold you muted. */
  let adForced = false;

  function restoreAudio() {
    const v = getVideo();
    if (!v) return false; // caller must NOT clear state on false
    if (mutedByUs) {
      v.muted = priorMuted === true; // null/undefined -> unmuted, never stuck
      mutedByUs = false;
      priorMuted = null;
    }
    v.style.opacity = "";
    return true;
  }

  function onAdStart() {
    if (S.adOn) return;
    S.adOn = true;
    S.adStart = performance.now();
    const v = getVideo();
    if (!v) return;
    if (cfg.adMute && !mutedByUs) {
      priorMuted = v.muted;
      v.muted = true;
      mutedByUs = true;
    }
    if (cfg.adBlank) v.style.opacity = "0.02";
  }

  function onAdEnd() {
    if (!S.adOn) return;
    if (!restoreAudio()) return; // no video yet — keep S.adOn, retry next tick
    S.adOn = false;
    const secs = ((performance.now() - S.adStart) / 1000).toFixed(0);
    if (S.adPod)
      console.log(`%c[ad] break done — ${S.adPod[1]} spot(s), ${secs}s`, "color:#00e08a");
    S.adLeft = S.adPod = null;
    domClear = 0;
    llAsked = null; // the worker may have deferred a latency change through the break
    note(`Ad over (${secs}s)`);
  }

  let priorMuted = null;

  /* The DOM keeps a vote even when events are driving. If events say we're in a
     break but no ad marker has been on screen for 3 straight seconds, the end
     event was missed and the DOM wins. Events are faster; they are not
     infallible, and only one of the two can leave you silently muted. */
  function tickAds() {
    const domSays = SEL.adMarkers.some((s) => $(s));
    if (!domSays) adForced = false; // marker really cleared — arm again

    if (S.adEvent === null) {
      // no events bound — DOM drives outright
      if (domSays && !S.adOn && !adForced) onAdStart();
      else if (!domSays && S.adOn) onAdEnd();
      return;
    }

    if (S.adOn && !domSays) {
      if (++domClear >= 6) {
        // 6 x 500ms
        console.warn("[Twitch Utils] ad end event never fired — DOM says clear, unmuting");
        S.adEvent = false;
        onAdEnd();
      }
    } else {
      domClear = 0;
    }
  }

  /* Last line of defence. Muted with no ad running is always wrong, whatever
     path got us here. And no ad break runs three minutes — if one appears to,
     we lost the end event and the cross-check somehow missed it too. */
  /* MUTE AUDIT. Something is muting on load and I've guessed wrong at this class
     of bug enough times today. Log every transition of video.muted with our full
     state attached, so the next report says who did it instead of that it
     happened. mutedByUs=false on a transition to muted means it wasn't us —
     that's the whole question. */
  let lastMuted = null,
    lastVideo = null;
  function auditMute() {
    const v = getVideo();
    if (!v) return;
    if (v !== lastVideo) {
      lastVideo = v;
      lastMuted = null;
    }
    if (v.muted === lastMuted) return;
    const was = lastMuted;
    lastMuted = v.muted;
    if (was === null) return; // first read is a baseline, not a transition
    console.log(
      `%c[mute] ${was} -> ${v.muted}`,
      v.muted ? "color:#ffb44d;font-weight:bold" : "color:#00e08a;font-weight:bold",
      {
        byUs: mutedByUs,
        adOn: S.adOn,
        adEvent: S.adEvent,
        priorMuted,
        volume: +v.volume.toFixed(2),
        audioHooked: !!hookedEl,
        ctx: actx ? actx.state : "none",
        gain: cfg.gain,
        path: location.pathname,
      },
    );
  }

  function adWatchdog() {
    if (mutedByUs && !S.adOn) restoreAudio();
    if (S.adOn && performance.now() - S.adStart > 180000) {
      console.warn("[Twitch Utils] ad break over 3min — forcing end (stuck ad marker?)");
      S.adEvent = null;
      domClear = 0;
      adForced = true; // block the DOM from re-triggering it
      onAdEnd();
    }
  }

  function tickClaim() {
    if (!cfg.autoClaim) return;
    const b = $(SEL.claimBonus);
    if (b) {
      b.click();
      S.claims++;
      /* No HUD in a frame, so the console is the only feedback that the lurk
         frames are actually earning rather than just sitting there. */
      if (inFrame)
        console.log(
          `%c[Twitch Utils] claimed on ${location.pathname} (${S.claims})`,
          "color:#00e08a",
        );
    }
  }

  /* React tracks input values on its own internal node-value property. Setting
     .value directly updates the DOM but React never sees the change, so the
     submit button stays disabled. Going through the native setter and then
     firing a bubbled input event is what makes React actually register it. */
  function setReactValue(el, val) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, val) : (el.value = val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function tickDismiss() {
    if (!cfg.autoDismiss) return;

    // Age gate is a form, not a button — it wants a birth year typed in.
    if ($(SEL.ageGateForm)) {
      const y = $(SEL.ageGateYear);
      if (y && !y.value) {
        setReactValue(y, String(cfg.birthYear));
        await sleep(120);
        const sb = $(SEL.ageGateSubmit);
        if (sb && !sb.disabled) {
          sb.click();
          note("Age gate cleared");
        }
        return;
      }
    }

    // Content gate is an overlay wrapper; the button inside it is unlabelled.
    const gate = $(SEL.contentGate);
    if (gate) {
      const b = gate.querySelector("button");
      if (b) {
        b.click();
        return;
      }
    }

    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (SEL.dismissText.includes(t)) {
        b.click();
        return;
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ACTIONS
     ───────────────────────────────────────────────────────────── */
  /* Was: open gear, wait, click Quality, wait, click option 0, wait, close.
     Six lookups and three sleeps, fragile at every step. Now it's one call —
     and getQualities() hands back the real ladder with bitrates attached. */
  /* ─── WHY PINNING BEATS AUTO ───────────────────────────────────
     Symbols in amazon-ivs-wasmworker.wasm show the ABR filter chain that runs
     while isAutoQualityMode() is true — twitch::abr::{Bandwidth, Bitrate,
     Buffer, DroppedFrame, MaxBuffer, NetworkLink, Rebuffer, Replace,
     Resolution, SurfaceSize, Viewport}Filter, all feeding a FilterSet and then
     QualitySelector.

     DroppedFrameFilter is the nasty one. Drop a few frames and it concludes
     your hardware can't cope and downgrades you — which is a feedback loop
     nothing requests. SurfaceSizeFilter and ViewportFilter cap you to your
     window size for similar reasons.

     setAutoQualityMode(false) takes the whole chain out of the loop. No
     ceiling setters needed — you're not raising limits, you're removing the
     thing that applies them. This is the only real "force better quality"
     there is: you can never exceed what the streamer encodes, but you can
     stop the player second-guessing you down the ladder. */
  let qCache = null;

  /* `if (qCache) return qCache` looked fine and was fatal: [] is truthy. The
     player object exists well before the stream loads, so an early call got an
     empty ladder, cached it, and every call after that returned the cached []
     forever — dropdown never populated, nothing to pin. Same "object exists !=
     stream loaded" mistake as setLiveLowLatencyEnabled, in a new costume.
     Only ever cache a NON-EMPTY ladder; empty means ask again. */
  function qualities() {
    if (qCache && qCache.length) return qCache;
    const m = getMPI();
    if (!m) return [];
    try {
      const q = m.getQualities();
      if (q && q.length) qCache = q;
      return qCache && qCache.length ? qCache : [];
    } catch {
      return [];
    }
  }

  function pinQuality(q) {
    const m = getMPI();
    if (!m) return note("Player core unreachable — is @grant still none?");
    try {
      if (!q) {
        // back to auto: hand control to the FilterSet
        m.setAutoQualityMode(true);
        cfg.pinned = null;
        save();
        return note("Quality → auto");
      }
      m.setAutoQualityMode(false); // take the FilterSet out of the loop
      m.setQuality(q, true);
      cfg.pinned = q.name;
      save();
      note(`Pinned ${q.name} (${(q.bitrate / 1e6).toFixed(1)} Mbps)`);
    } catch (e) {
      note("setQuality failed: " + e.message.slice(0, 30));
    }
  }

  function lockSource() {
    const qs = qualities();
    if (!qs.length) return note("No qualities reported yet");
    pinQuality(qs[0]); // index 0 is always source
  }

  /* ─── RECONCILE, DON'T APPLY ───────────────────────────────────
     Settings are reconciled, never applied once on a timer. A one-shot
     setTimeout races page load: if the player core isn't up, getMPI() returns
     null, the call no-ops silently and nothing retries, so a saved pin simply
     never happens.

     Instead: every tick, read what the player IS doing and fix any drift from
     what cfg asks for. getQuality/isAutoQualityMode/isLiveLowLatency are all
     proven-readable, so there's no reason to guess. Idempotent, self-healing,
     no timers.

     It deliberately does NOT fight you. Reapplying the pin only happens when
     auto mode has come back on (which means the player was rebuilt and lost
     it). If you change quality yourself while pinned, the qualityChanged
     handler adopts your choice rather than snapping it back. */
  function reconcile() {
    const m = getMPI();
    if (!m) return;

    if (cfg.pinned && preBg === null) {
      // not while we're deliberately backgrounded
      try {
        // auto is on but we're pinned -> the player was rebuilt and dropped it
        if (m.isAutoQualityMode()) {
          const q = qualities().find((x) => x.name === cfg.pinned);
          if (q) {
            m.setAutoQualityMode(false);
            m.setQuality(q, true);
          }
        }
      } catch {}
    }

    applyLatencyMode(); // no-ops unless the request actually changed
  }

  /* ─── BACKGROUND QUALITY ───────────────────────────────────────
     A hidden tab still pulls source and runs a full decode — 8.5 Mbps and a
     decoder for a stream nobody can see. Four tabs is 34 Mbps of video you are
     definitionally not watching. Drop to the bottom of the ladder while hidden,
     put it back on return.

     bgSwitching guards a real conflict: the PlayerQualityChanged handler adopts
     external quality changes into cfg.pinned, on the theory that a change while
     auto is off must have come from you. These changes didn't — so without the
     flag, backgrounding a tab would silently rewrite your pin to 160p and leave
     it there when you came back. */
  let bgSwitching = false,
    preBg = null;
  const realHiddenGet = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")?.get;
  const tabHidden = () => {
    try {
      return realHiddenGet ? realHiddenGet.call(document) : document.hidden;
    } catch {
      return document.hidden;
    }
  };

  function bgApply(hidden) {
    if (!cfg.bgQuality) return;
    const m = getMPI();
    if (!m || !playerReady()) return; // a dropped call here strands you at 160p
    const qs = qualities();
    if (!qs.length) return;

    try {
      if (hidden && preBg === null) {
        const cur = m.getQuality();
        preBg = { name: cur && cur.name, auto: m.isAutoQualityMode() };
        bgSwitching = true;
        m.setAutoQualityMode(false);
        m.setQuality(qs[qs.length - 1], true); // ladder is high->low, so last is lowest
        bgSwitching = false;
      } else if (!hidden && preBg !== null) {
        bgSwitching = true;
        if (preBg.auto) m.setAutoQualityMode(true);
        else {
          const q = qs.find((x) => x.name === preBg.name);
          if (q) m.setQuality(q, true);
          else m.setAutoQualityMode(true); // ladder changed under us — auto is the safe out
        }
        bgSwitching = false;
        preBg = null;
      }
    } catch {
      bgSwitching = false;
    }
  }

  /* Diagnostic: the player keeps what it REFUSED to give you, and why. */
  function dumpFiltered() {
    const m = getMPI();
    if (!m) return note("Player core unreachable");
    let un = [];
    try {
      un = m.getUnavailableQualities() || [];
    } catch {
      return note("not available");
    }
    if (!un.length) return note("Nothing filtered — full ladder available");
    console.log("%c[quality] filtered out:", "color:#a970ff;font-weight:bold");
    for (const q of un) {
      console.log(
        `  ${(q.name || "?").padEnd(12)} ${q.width}x${q.height} @${q.framerate}  ` +
          `${(q.bitrate / 1e6).toFixed(1)}Mbps   reasons: ${(q.filterReasons || []).join(", ") || "(none given)"}`,
      );
    }
    note(`${un.length} variant(s) filtered — see console`);
  }

  /* ─── setLiveMaxLatency IS UNCALLABLE — do not put it back ───
     Do not call m.setLiveMaxLatency(seconds). It throws:

       UnboundTypeError: Cannot call MediaPlayer.setLiveMaxLatency
       due to unbound types: N6twitch9MediaTimeE

     N6twitch9MediaTimeE demangles to twitch::MediaTime. The method takes that
     C++ type, and Embind never registered it in this build — presumably
     tree-shaken, since Twitch's own UI never calls it. The method is still on
     the prototype (Embind installs a generic dispatcher), so `typeof
     m.setLiveMaxLatency === 'function'` is true and the mpi probe reported it
     as available. Prototype presence says nothing about whether the ARGUMENT
     types are bound. That only shows up when you call it.

     And the throw is unreachable from a try/catch: the stack goes
     t.onClientMessage -> Z.onmessage, i.e. it happens inside the worker's
     message dispatch, after our call already returned. Wrapping it does
     nothing. It also meant setLiveSpeedUpRate on the next line never ran, so
     the cap slider silently did nothing for five versions.

     So: cap it ourselves. getLiveLatency() works, and video.playbackRate goes
     nowhere near Embind. Same outcome, no WASM boundary. */
  /* ─── LOW LATENCY: INTENT != ACTUAL ────────────────────────────
     From player-core-variant-a:

       t.setLiveLowLatencyEnabled = function(e) {
         this.state.liveLowLatencyEnabled = e;               // intent
         this.postMessage("setLiveLowLatencyEnabled", [e]);  // -> worker
       }

     The setter only records intent and forwards to the worker. The worker
     decides whether to honour it, and the wasm carries the string:

       "deferring latency mode change during ad playback"

     There's also isLowLatencyCapable() (on the sink, not reachable from the
     MPI) and a "source low latency mode %s" log — not every stream can do it
     at all.

     isLiveLowLatency() reports ACTUAL. Comparing actual against desired and
     re-calling on mismatch therefore re-sends the message on every tick for as
     long as the worker declines it, and never settles.

     Rule: remember what was asked and ask once. Never during an ad. Re-ask
     after the break, and once per new player instance. If it still hasn't
     taken, report it rather than hammering. */
  /* Ask once per instance, and only when the request can land. getMPI()
     returning non-null means the player OBJECT exists, which is not the same
     as a stream being loaded — a request sent before that is dropped by the
     worker with no error. getState() === 'Playing' is the real gate.

     The asymmetry below is what makes it self-healing: every bail-out happens
     before the setter and leaves llAsked untouched, so reconcile() retries on
     the next tick. Only a request that actually went out records itself.
     Not-ready means "come back later", never "we tried". */
  let llAsked = null; // last value that actually reached the worker
  let llAt = 0; // when — so we can let it settle before judging
  let llTries = 0;
  let llWarned = false;

  const playerReady = () => {
    const m = getMPI();
    if (!m) return false;
    try {
      return m.getState() === "Playing";
    } catch {
      return false;
    }
  };

  function applyLatencyMode() {
    const m = getMPI();
    if (!m) return;
    if (S.adOn) return; // worker defers it mid-break
    if (!playerReady()) return; // no stream yet — retry next tick
    if (llAsked === cfg.lowLatency) return; // already landed — do not spam
    try {
      m.setLiveLowLatencyEnabled(!!cfg.lowLatency);
      llAsked = cfg.lowLatency;
      llAt = performance.now();
      llTries++;
      llWarned = false;
    } catch {}
  }

  /* Asked, playing, no ad, given 2.5s to settle, still wrong. Can't tell a
     dropped request from an incapable source, so retry a couple of times and
     only then say so — once. */
  function checkLatencyTook() {
    if (llAsked === null || S.adOn || llWarned) return;
    if (!playerReady()) return;
    if (performance.now() - llAt < 2500) return;
    const m = getMPI();
    if (!m) return;
    try {
      if (m.isLiveLowLatency() === !!cfg.lowLatency) {
        llTries = 0;
        return;
      } // took
      if (llTries < 3) {
        llAsked = null;
        return;
      } // retry
      llWarned = true;
      console.log(
        "%c[Twitch Utils] low latency requested " +
          llTries +
          "x but the " +
          "player still reports " +
          m.isLiveLowLatency() +
          " — this source is " +
          "probably not low-latency capable.",
        "color:#ffb44d",
      );
    } catch {}
  }

  let rateHeld = false;
  function tickLatencyCap() {
    const v = getVideo();
    if (!v) return;

    if (cfg.maxLatency <= 0) {
      if (rateHeld) {
        v.playbackRate = 1;
        rateHeld = false;
      }
      return;
    }
    const m = getMPI();
    if (!m) return;
    let lat;
    try {
      lat = m.getLiveLatency();
    } catch {
      return;
    }
    if (typeof lat !== "number" || !isFinite(lat)) return;

    /* Hysteresis: speed up past cap+0.3, settle back at or under cap. Without
       the gap it oscillates around the threshold and you hear it. 1.05 is the
       ceiling before the pitch shift becomes obvious. */
    if (lat > cfg.maxLatency + 0.3) {
      if (!rateHeld) {
        v.playbackRate = 1.05;
        rateHeld = true;
      }
    } else if (lat <= cfg.maxLatency && rateHeld) {
      v.playbackRate = 1;
      rateHeld = false;
    }
  }

  function jumpLive() {
    const v = getVideo();
    if (!v || !v.buffered.length) return;
    v.currentTime = v.buffered.end(v.buffered.length - 1) - 0.4;
    note("Jumped to live edge");
  }

  function screenshot() {
    const v = getVideo();
    if (!v || !v.videoWidth) return note("No video frame");
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      const ch = location.pathname.split("/")[1] || "twitch";
      a.download = `${ch}_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      note("Frame saved");
    });
  }

  async function pip() {
    const v = getVideo();
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      note("Picture-in-picture refused");
    }
  }

  /* skipAd() — TESTED AND DEAD, 2026-07-16, IVS 1.54.0-rc.3.
     Returns undefined. Position advanced 1.20s across a 1.20s window (i.e.
     plain 1x playback), latency held at 7.81 either side, ad stayed up. It is
     a no-op on a live edge, which is what SSAI predicts: the ad IS the stream
     at that moment, so there is no later content to seek to. Presumably real
     on VOD ad breaks. Don't re-add the button without a new measurement. */

  /* ─── CAST — CANNOT WORK IN THE BROWSER, AND HERE'S WHY ────────
     This cannot work in a browser, and the button only reports why.

     Twitch feeds the video element through MediaSource: currentSrc is a
     blob: URL. That blob exists only inside this tab — a Chromecast has no way
     to resolve it, so there is nothing to hand the device. Chrome reports
     remote playback permanently unavailable for MSE-backed media, so
     remote.prompt() never opens a picker. The same-origin property that makes
     Web Audio and canvas work on this element is exactly what makes it
     uncastable.

     m.startRemotePlayback() exists and has no Embind types to be unbound, which
     is true and irrelevant: it only posts to the worker. IVS ships it for
     native mobile shells where the SDK owns the session. On web it no-ops.

     Casting this stream needs something that can fetch the MANIFEST rather
     than the blob — i.e. the getPath() URL in a player that casts (VLC:
     Playback > Renderer). Copy stream URL already hands you that.

     So: probe the API, report exactly what it says, don't pretend. */
  async function cast() {
    const v = getVideo();
    if (!v) return note("No video");

    const d = {
      currentSrc: v.currentSrc.slice(0, 32) + "…",
      mse: v.currentSrc.startsWith("blob:"),
      remoteApi: !!(v.remote && typeof v.remote.prompt === "function"),
      disableRemotePlayback: !!v.disableRemotePlayback,
      remoteState: (v.remote && v.remote.state) || "n/a",
      mpiStartRemotePlayback: typeof (getMPI() || {}).startRemotePlayback === "function",
    };

    if (v.remote && typeof v.remote.watchAvailability === "function") {
      await new Promise((res) => {
        let done = false;
        const finish = (val) => {
          if (!done) {
            done = true;
            d.availability = val;
            res();
          }
        };
        try {
          v.remote
            .watchAvailability((a) => finish(a))
            .then((id) =>
              setTimeout(() => {
                try {
                  v.remote.cancelWatchAvailability(id);
                } catch {}
                finish("no callback in 800ms");
              }, 800),
            )
            .catch((e) => finish(`${e.name}: ${e.message.slice(0, 40)}`));
        } catch (e) {
          finish(`threw ${e.name}`);
        }
      });
    } else d.availability = "watchAvailability not available";

    console.log("%c[cast] diagnostics", "color:#a970ff;font-weight:bold", d);

    if (d.mse) {
      console.log(
        "%c[cast] MSE blob source — the browser cannot cast this. The device would " +
          'have to fetch the manifest itself. Use "Copy stream URL", then VLC > Playback > ' +
          "Renderer, or mpv.",
        "color:#ffb44d",
      );
      return note("Can't cast MSE — use Copy stream URL + VLC");
    }

    try {
      await v.remote.prompt();
      note("Cast: " + (v.remote.state || "prompted"));
    } catch (e) {
      if (e && e.name === "NotAllowedError") return; // you dismissed the picker
      note(`Cast: ${e.name || "failed"}`);
      console.log("[cast] prompt threw:", e);
    }
  }

  /* ─── STREAM URL ───────────────────────────────────────────────
     getPath() returns the live usher manifest the player is already pulling,
     auth params and all. Hand it to mpv or VLC and you get native decode
     instead of a browser tab — much lower CPU, proper scaling, your own
     filters. This is roughly what streamlink does.

     It is NOT an ad dodge: ads are spliced into this same manifest, so mpv
     plays them too. The URL is also session-scoped and expires.

     This is also the only real route to a TV: the browser can't cast an MSE
     blob, but VLC can take this URL and cast it (Playback > Renderer) because
     it hands the device a manifest the device can actually fetch. */
  function copyStreamURL() {
    const m = getMPI();
    if (!m) return note("Player core unreachable");
    let url;
    try {
      url = m.getPath();
    } catch {
      return note("getPath() failed");
    }
    if (!url || typeof url !== "string") return note("No manifest URL yet");
    const vod = isVod();
    navigator.clipboard
      .writeText(url)
      .then(() => {
        note(vod ? "VOD manifest copied" : "Live manifest copied");
        console.log(
          `%c[Twitch Utils] ${vod ? "VOD" : "live"} manifest copied`,
          "color:#a970ff;font-weight:bold",
        );
        console.log('  watch : mpv "<paste>"        # or vlc "<paste>"');
        if (vod) {
          console.log('  save  : yt-dlp "<paste>"     # handles the segments, remux and resume');
          console.log("          A browser cannot do this well — a 4h VOD is ~15GB of .ts");
          console.log("          segments that need remuxing. yt-dlp is the right tool.");
        }
        console.log("  Session-scoped and expires. Ads are stitched in — not a bypass.");
      })
      .catch(() => {
        console.log(url);
        note("Clipboard blocked — dumped to console");
      });
  }

  function exportCfg() {
    const json = JSON.stringify(cfg, null, 2);
    navigator.clipboard
      .writeText(json)
      .then(() => note("Settings copied to clipboard"))
      .catch(() => {
        console.log(json);
        note("Clipboard blocked — dumped to console");
      });
  }

  function importCfg() {
    const raw = prompt("Paste exported settings JSON:");
    if (!raw) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return note("Not valid JSON");
    }
    if (!obj || typeof obj !== "object") return note("Not valid settings");
    /* Only take keys we know. Pasting arbitrary JSON shouldn't be able to
       inject fields the rest of the script will later trust. */
    let n = 0;
    for (const k of Object.keys(DEFAULTS)) {
      if (k in obj && typeof obj[k] === typeof DEFAULTS[k]) {
        cfg[k] = obj[k];
        n++;
      }
    }
    save();
    note(`Imported ${n} setting(s) — reload to apply`);
  }

  function resetAll() {
    cfg = { ...DEFAULTS };
    save();
    note("Reset — reload the page");
  }

  /* ─────────────────────────────────────────────────────────────
     STYLES
     ───────────────────────────────────────────────────────────── */
  const CSS = `
  /* The frame is 1000x480 and scaled down; the cell is the scaled box that
     clips it. transform-origin 0 0 so it pulls toward the top-left corner. */
  #vtu-lurk {
    position: fixed; left: 8px; bottom: 8px; z-index: 2147483646;
    display: flex; gap: 4px; flex-wrap: wrap; max-width: 60vw;
    /* Setting this on the iframe alone is not enough — the container and cells
       still win the hit test — and this sits on top of Twitch's left sidebar at a
       z-index nothing beats. Clicking a channel hit the lurk strip instead of
       the link, so switching streams silently did nothing and only a refresh
       (which navigates by URL) worked.
       Nothing in here is interactive — the frames are display-only and every
       control lives in the HUD — so the whole subtree is click-through. */
    pointer-events: none;
  }
  .vtu-lcell {
    position: relative; overflow: hidden;
    border: 1px solid #2a2340; border-radius: 2px; background: #000;
    /* flex items default to min-width:auto and refuse to shrink below their
       content — and the content is a 1000px iframe, because transform is
       visual only and never changes layout size. Without these the cell would
       floor at 1000px wide no matter what the slider said. */
    flex: none; min-width: 0; min-height: 0;
  }
  .vtu-lframe {
    width: 1000px; height: 480px; border: 0;
    transform-origin: 0 0; pointer-events: none;
  }
  .vtu-ltag {
    position: absolute; left: 0; bottom: 0; z-index: 2;
    background: rgba(8,6,14,.85); color: #a970ff;
    font: 9px ui-monospace, Menlo, monospace; padding: 1px 4px;
    letter-spacing: .06em; pointer-events: none;
  }
  #vtu {
    position: fixed; top: 72px; left: 16px; z-index: 2147483647;
    width: 300px; background: #0d0b12; color: #ddd8e8;
    border: 1px solid #2a2340; border-radius: 3px;
    font: 11px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    box-shadow: 0 14px 44px rgba(0,0,0,.7);
    user-select: none; display: none;
  }
  #vtu.on { display: block; }
  @media (prefers-reduced-motion: no-preference) {
    #vtu.on { animation: vtuIn .09s ease-out; }
    @keyframes vtuIn { from { opacity: 0; transform: translateY(-3px); } }
  }
  #vtu-body {
    /* 100px leaves room for the titlebar plus whatever y the panel is dragged to.
       overscroll-behavior stops a flick at the end scrolling Twitch behind us. */
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  #vtu-body::-webkit-scrollbar { width: 5px; }
  #vtu-body::-webkit-scrollbar-track { background: transparent; }
  #vtu-body::-webkit-scrollbar-thumb { background: #2f2747; border-radius: 3px; }
  #vtu-body::-webkit-scrollbar-thumb:hover { background: #3b2668; }
  #vtu-body { scrollbar-width: thin; scrollbar-color: #2f2747 transparent; }
  #vtu-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; background: #161221;
    border-bottom: 1px solid #2a2340; cursor: grab;
  }
  #vtu-bar:active { cursor: grabbing; }
  #vtu-bar b {
    font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
    color: #a970ff; font-weight: 700;
  }
  #vtu-stat { margin-left: auto; display: flex; gap: 5px; align-items: center; }
  .vtu-pip {
    font-size: 9px; letter-spacing: .1em; padding: 1px 5px;
    border: 1px solid #2a2340; border-radius: 2px; color: #6f6a7d;
  }
  .vtu-pip.hot { color: #ff4d5e; border-color: #4a1f28; background: #1d1016; }
  .vtu-pip.good { color: #00e08a; border-color: #14402f; background: #0c1a15; }
  .vtu-sec {
    padding: 5px 9px; margin-top: 2px;
    font-size: 9px; letter-spacing: .16em; text-transform: uppercase;
    color: #57506b; border-bottom: 1px solid #191428;
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px;
    transition: color .1s;
  }
  .vtu-sec:hover { color: #a970ff; }
  .vtu-sec::before { content: '▾'; font-size: 7px; opacity: .7; }
  .vtu-sec.fold::before { content: '▸'; }
  .vtu-sec.fold { color: #4a4460; }
  .vtu-sec:focus-visible { outline: 1px solid #a970ff; outline-offset: -1px; }
  .vtu-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 9px; border-bottom: 1px solid #141020;
  }
  .vtu-row label { flex: 1; color: #b9b2ca; cursor: pointer; }
  .vtu-row .hint { display: block; font-size: 9px; color: #57506b; letter-spacing: .02em; }
  .vtu-sw {
    width: 28px; height: 15px; border-radius: 8px; background: #241d36;
    border: 1px solid #2f2747; position: relative; cursor: pointer; flex: none;
    transition: background .12s;
  }
  .vtu-sw::after {
    content: ''; position: absolute; top: 1px; left: 1px;
    width: 11px; height: 11px; border-radius: 50%; background: #6f6a7d;
    transition: transform .12s, background .12s;
  }
  .vtu-sw[data-on="1"] { background: #3b2668; border-color: #a970ff; }
  .vtu-sw[data-on="1"]::after { transform: translateX(13px); background: #a970ff; }
  .vtu-slide { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-bottom: 1px solid #141020; }
  .vtu-slide > span:first-child { width: 34px; color: #b9b2ca; flex: none; }
  .vtu-slide input[type=range] {
    flex: 1; height: 2px; -webkit-appearance: none; appearance: none;
    background: #2a2340; border-radius: 2px; cursor: pointer;
  }
  .vtu-slide input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%;
    background: #a970ff; cursor: pointer;
  }
  .vtu-slide input[type=range]:disabled { opacity: .3; cursor: default; }

  .vtu-val { width: 46px; text-align: right; color: #a970ff; font-variant-numeric: tabular-nums; flex: none; }
  .vtu-sel {
    flex: 1; background: #161221; color: #ddd8e8; border: 1px solid #2f2747;
    border-radius: 2px; font: inherit; font-size: 10px; padding: 2px 4px; cursor: pointer;
  }
  .vtu-sel:focus-visible { outline: 1px solid #a970ff; }
  .vtu-txt {
    flex: 1; background: #161221; color: #ddd8e8; border: 1px solid #2f2747;
    border-radius: 2px; font: inherit; font-size: 10px; padding: 3px 5px; min-width: 0;
  }
  .vtu-txt:focus-visible { outline: 1px solid #a970ff; }
  #vtu-pts { border-bottom: 1px solid #141020; }
  .vtu-pt {
    display: flex; align-items: center; gap: 8px; padding: 4px 9px;
    font-variant-numeric: tabular-nums;
  }
  .vtu-pt b { flex: 1; font-weight: 400; color: #b9b2ca; overflow: hidden; text-overflow: ellipsis; }
  .vtu-pt i { font-style: normal; color: #ddd8e8; }
  .vtu-pt .chest { color: #00e08a; font-size: 9px; }
  .vtu-pt .err { color: #ff4d5e; font-size: 9px; }
  #vtu-pts .msg { padding: 5px 9px; font-size: 9px; color: #57506b; }
  #vtu-fol { max-height: 168px; overflow-y: auto; border-bottom: 1px solid #141020; }
  #vtu-fol { scrollbar-width: thin; scrollbar-color: #2f2747 transparent; }
  #vtu-fol::-webkit-scrollbar { width: 5px; }
  #vtu-fol::-webkit-scrollbar-thumb { background: #2f2747; border-radius: 3px; }
  #vtu-fol .msg { padding: 5px 9px; font-size: 9px; color: #57506b; }
  .vtu-fol {
    display: flex; align-items: center; gap: 7px; padding: 4px 9px;
    cursor: pointer; border-bottom: 1px solid #141020; transition: background .1s;
  }
  .vtu-fol:hover { background: #161221; }
  .vtu-fol .box {
    width: 11px; height: 11px; flex: none; border: 1px solid #2f2747;
    border-radius: 2px; background: #241d36; position: relative;
  }
  .vtu-fol.on .box { background: #3b2668; border-color: #a970ff; }
  .vtu-fol.on .box::after {
    content: ''; position: absolute; inset: 2px; border-radius: 1px; background: #a970ff;
  }
  .vtu-fol b { flex: 1; font-weight: 400; color: #b9b2ca; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
  .vtu-fol.on b { color: #ddd8e8; }
  .vtu-fol i { font-style: normal; font-size: 9px; color: #57506b; font-variant-numeric: tabular-nums; }
  .vtu-val.warn { color: #ffb44d; }
  .vtu-gr {
    height: 3px; background: #1a1428; margin: 0 9px 7px; border-radius: 2px; overflow: hidden;
  }
  .vtu-gr i { display: block; height: 100%; width: 0; background: #a970ff; transition: width .1s linear; }
  .vtu-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
    background: #141020; border-bottom: 1px solid #141020;
  }
  .vtu-cell { background: #0d0b12; padding: 6px 9px; }
  .vtu-cell u { display: block; font-size: 9px; color: #57506b; text-decoration: none; letter-spacing: .1em; }
  .vtu-cell b { font-weight: 400; color: #ddd8e8; font-variant-numeric: tabular-nums; }
  .vtu-cell b.bad { color: #ff4d5e; }
  .vtu-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #1d1730; }
  .vtu-btns button {
    background: #120f1c; border: 0; color: #b9b2ca; padding: 8px 4px;
    font: inherit; font-size: 10px; cursor: pointer; transition: background .1s, color .1s;
  }
  .vtu-btns button:hover { background: #1c1630; color: #a970ff; }
  .vtu-btns button:focus-visible { outline: 1px solid #a970ff; outline-offset: -2px; }
  #vtu-foot { padding: 6px 9px; color: #4a4460; font-size: 9px; display: flex; }
  #vtu-foot a { color: #4a4460; margin-left: auto; cursor: pointer; text-decoration: underline; }
  #vtu-foot a:hover { color: #ff4d5e; }
  #vtu-note {
    position: fixed; z-index: 2147483647; left: 16px; top: 48px;
    background: #161221; border: 1px solid #a970ff; color: #ddd8e8;
    padding: 5px 9px; border-radius: 3px; font: 10px ui-monospace, Menlo, monospace;
    opacity: 0; pointer-events: none; transition: opacity .16s;
  }
  #vtu-note.show { opacity: 1; }
  #vtu-ov {
    position: absolute; top: 10px; right: 10px; z-index: 100;
    background: rgba(8,6,14,.82); border: 1px solid #2a2340; border-radius: 3px;
    padding: 5px 8px; pointer-events: none; display: none;
    font: 10px/1.45 ui-monospace, Menlo, Consolas, monospace; color: #b9b2ca;
    font-variant-numeric: tabular-nums; white-space: pre;
  }
  #vtu-ov .bad { color: #ff4d5e; }
  .vtu-keybtn {
    background: #161221; color: #a970ff; border: 1px solid #2f2747; border-radius: 2px;
    font: inherit; font-size: 10px; padding: 3px 8px; cursor: pointer; min-width: 64px;
  }
  .vtu-keybtn:hover { border-color: #a970ff; }
  .vtu-keybtn:focus-visible { outline: 1px solid #a970ff; }
  `;

  /* ─────────────────────────────────────────────────────────────
     UI
     ───────────────────────────────────────────────────────────── */
  let root, noteEl, ov, noteTimer;

  function note(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg;
    noteEl.classList.add("show");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => noteEl.classList.remove("show"), 1600);
  }

  function row(key, label, hint) {
    return `<div class="vtu-row">
      <label data-k="${key}">${label}${hint ? `<span class="hint">${hint}</span>` : ""}</label>
      <div class="vtu-sw" data-k="${key}" data-on="${cfg[key] ? 1 : 0}" role="switch"
           aria-checked="${!!cfg[key]}" tabindex="0"></div>
    </div>`;
  }

  /* The panel markup is flat — headers and their controls are siblings, not
     nested. So a section is "everything between this header and the next one".
     Cheaper than restructuring, and it means adding a row to a section needs no
     wiring at all. */
  function foldSection(hdr, on) {
    const sec = hdr.dataset.sec;
    cfg.folded[sec] = on;
    hdr.classList.toggle("fold", on);
    hdr.setAttribute("aria-expanded", String(!on));
    let el = hdr.nextElementSibling;
    while (el && !el.classList.contains("vtu-sec")) {
      el.style.display = on ? "none" : "";
      el = el.nextElementSibling;
    }
    save();
  }

  function applyFolds() {
    for (const hdr of root.querySelectorAll(".vtu-sec[data-sec]")) {
      hdr.setAttribute("role", "button");
      hdr.setAttribute("tabindex", "0");
      foldSection(hdr, !!cfg.folded[hdr.dataset.sec]);
    }
  }

  function build() {
    const style = document.createElement("style");
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    noteEl = document.createElement("div");
    noteEl.id = "vtu-note";
    document.body.appendChild(noteEl);

    ov = document.createElement("div");
    ov.id = "vtu-ov";

    root = document.createElement("div");
    root.id = "vtu";
    root.innerHTML = `
      <div id="vtu-bar">
        <b>Twitch Utils</b>
        <div id="vtu-stat">
          <span class="vtu-pip" id="vtu-ad">AD</span>
          <span class="vtu-pip good" id="vtu-claims">0 claimed</span>
        </div>
      </div>

      <div id="vtu-body">
      <div class="vtu-sec" data-sec="audio">Audio</div>
      <div class="vtu-slide">
        <span>Gain</span>
        <input type="range" id="s-gain" min="0.1" max="5" step="0.05" value="${cfg.gain}">
        <span class="vtu-val" id="v-gain">100%</span>
      </div>
      <div id="v-audiopend" style="display:none;padding:0 9px 7px;font-size:9px;color:#ffb44d">
        Saved audio settings apply on your first click — browser autoplay rule
      </div>
      ${row("autoGain", "Auto gain", "From Twitch's own loudness measurement")}
      <div class="vtu-slide">
        <span>Target</span>
        <input type="range" id="s-lufs" min="-24" max="-8" step="0.5" value="${cfg.targetLufs}">
        <span class="vtu-val" id="v-lufs">-16</span>
      </div>
      <div class="vtu-slide">
        <span>Bass</span>
        <input type="range" id="s-bass" min="-10" max="15" step="0.5" value="${cfg.bass}">
        <span class="vtu-val" id="v-bass">0.0 dB</span>
      </div>
      ${row("mono", "Mono downmix", "Sums L+R — for one earbud")}
      ${row("comp", "Leveling", "Tames loud streams, lifts quiet ones")}
      <div class="vtu-slide">
        <span>Amount</span>
        <input type="range" id="s-comp" min="0" max="100" step="1" value="${cfg.compAmount}">
        <span class="vtu-val" id="v-comp">50</span>
      </div>
      <div class="vtu-gr"><i id="v-gr"></i></div>

      <div class="vtu-sec" data-sec="stats">Playback stats</div>
      <div class="vtu-grid">
        <div class="vtu-cell"><u>RES</u><b id="v-res">—</b></div>
        <div class="vtu-cell"><u>FPS</u><b id="v-fps">—</b></div>
        <div class="vtu-cell"><u>DROPPED</u><b id="v-drop">—</b></div>
        <div class="vtu-cell"><u>BUFFER</u><b id="v-buf">—</b></div>
        <div class="vtu-cell"><u>LATENCY</u><b id="v-lat">—</b></div>
        <div class="vtu-cell"><u>STREAM LOUDNESS</u><b id="v-meas">—</b></div>
        <div class="vtu-cell"><u>BITRATE</u><b id="v-br">—</b></div>
        <div class="vtu-cell"><u>QUALITY</u><b id="v-q">—</b></div>
      </div>
      ${row("statsOverlay", "Pin stats to player", "Stays visible in fullscreen")}

      <div class="vtu-sec" data-sec="quality">Quality</div>
      <div class="vtu-slide">
        <span>Fit</span>
        <select id="s-fit" class="vtu-sel">
          <option value="off">off — keep bars</option>
          <option value="fill">stretch — fill, distorts</option>
          <option value="cover">crop — fill, cuts edges</option>
        </select>
      </div>
      <div id="v-fit" style="padding:0 9px 7px;font-size:9px;color:#57506b"></div>
      <div class="vtu-slide">
        <span>Sat</span>
        <input type="range" id="s-vsat" min="0" max="200" step="5" value="${cfg.vidSat}">
        <span class="vtu-val" id="v-vsat">100%</span>
      </div>
      <div class="vtu-slide">
        <span>Pin</span>
        <select id="s-q" class="vtu-sel"><option value="">auto (ABR decides)</option></select>
      </div>
      <div style="padding:0 9px 7px;font-size:9px;color:#57506b">
        Pinning removes the dropped-frame and viewport filters from the loop
      </div>
      ${row("bgQuality", "Low quality when hidden", "For running several tabs at once")}

      <div class="vtu-sec" data-sec="points">Points</div>
      <div class="vtu-slide">
        <span>Chans</span>
        <input type="text" id="s-pch" class="vtu-txt" placeholder="lacy, jasontheween, …"
               value="${cfg.pointsChannels.replace(/"/g, "&quot;")}">
      </div>
      <div id="vtu-pts"></div>
      <div class="vtu-btns">
        <button data-act="pts">Refresh</button>
        <button data-act="claim">Claim chests</button>
      </div>
      <div class="vtu-btns"><button data-act="fol" style="grid-column:1/3">Load my following</button></div>
      <div id="vtu-fol"></div>
      <div class="vtu-row">
        <label>Lurk<span class="hint" id="v-lurk">not running</span></label>
      </div>
      <div class="vtu-slide">
        <span>Size</span>
        <input type="range" id="s-lscale" min="3" max="50" step="1" value="${cfg.lurkScale}">
        <span class="vtu-val" id="v-lscale">18%</span>
      </div>
      ${row("lurkHidden", "Hide thumbnails", "Frames keep running")}
      <div class="vtu-btns">
        <button data-act="lurk">Start lurking</button>
        <button data-act="unlurk">Stop</button>
      </div>
      <div style="padding:0 9px 7px;font-size:9px;color:#57506b">
        Real players, muted, lowest quality. Points need a session — this is the session.
      </div>

      <div class="vtu-sec" data-sec="vod">VOD &amp; rewind</div>
      <div id="vtu-vodoff" style="padding:0 9px 7px;font-size:9px;color:#57506b"></div>
      <div class="vtu-btns">
        <button data-act="rw30">&#9664;&#9664; 30s</button>
        <button data-act="rw10">&#9664; 10s</button>
        <button data-act="fromstart" style="grid-column:1/3">Watch from start (archive)</button>
        <button data-act="seekdiag" style="grid-column:1/3">What can this stream seek?</button>
      </div>
      <div class="vtu-btns">
        <button data-act="fb">&#9664; frame</button>
        <button data-act="ff">frame &#9654;</button>
        <button data-act="la">Set A</button>
        <button data-act="lb">Set B</button>
        <button data-act="lc">Clear loop</button>
        <button data-act="ts">Copy timestamp</button>
      </div>
      <div class="vtu-row"><label>Loop<span class="hint" id="v-loop">not set</span></label></div>

      <div class="vtu-sec" data-sec="latency">Latency</div>
      ${row("lowLatency", "Low latency mode", "Twitch had this off — worth ~2-3s")}
      <div class="vtu-slide">
        <span>Cap</span>
        <input type="range" id="s-maxlat" min="0" max="15" step="0.5" value="${cfg.maxLatency}">
        <span class="vtu-val" id="v-maxlat">off</span>
      </div>
      <div style="padding:0 9px 7px;font-size:9px;color:#57506b">
        Speeds playback to 1.05x until under the cap
      </div>

      <div class="vtu-sec" data-sec="ads">Ads</div>
      ${row("adMute", "Mute during ads")}
      ${row("adBlank", "Blank the frame", "Ads are stitched in — this hides, not skips")}

      <div class="vtu-sec" data-sec="automation">Automation</div>
      ${row("autoClaim", "Claim channel points")}
      ${row("autoDismiss", "Dismiss gates + warnings")}

      <div class="vtu-sec" data-sec="layout">Layout</div>
      ${row("hidePrime", "Hide Prime crown")}
      ${row("hideSidebar", "Collapse left sidebar")}
      ${row("collapseChat", "Collapse chat")}
      <div class="vtu-row">
        <label>Menu key<span class="hint">Click, press the new key (Esc cancels)</span></label>
        <button id="b-key" class="vtu-keybtn" data-act="setkey"></button>
      </div>
      <div class="vtu-sec" data-sec="actions">Actions</div>
      <div class="vtu-btns">
        <button data-act="live">Jump to live</button>
        <button data-act="source">Force Source</button>
        <button data-act="shot">Save frame</button>
        <button data-act="pip">Picture-in-picture</button>
        <button data-act="filtered" style="grid-column:1/3">What's being filtered out?</button>
        <button data-act="cast">Why no cast?</button>
        <button data-act="url">Copy stream URL</button>
        <button data-act="export">Export settings</button>
        <button data-act="import">Import settings</button>
      </div>
      <div id="vtu-foot">
        <span>Press <span id="v-footkey">${keyLabel(cfg.menuKey)}</span> to close</span>
        <a data-act="reset">reset</a>
      </div>
      </div>
    `;
    /* Clamp on restore: a position saved on a wide monitor can land the panel
       off-screen on a laptop, and you'd never see it again. */
    root.style.left = clamp(cfg.panelX, 0, Math.max(0, innerWidth - 60)) + "px";
    root.style.top = clamp(cfg.panelY, 0, Math.max(0, innerHeight - 120)) + "px";
    document.body.appendChild(root);
    wire();
    applyFolds();
    paintAudio();
    paintAmb();
    paintVod();
    paintPoints();
    paintFollowing();
    paintLurk();
    paintKey();
    applyLayout();
  }

  function paintPoints() {
    if (!root) return;
    const box = $("#vtu-pts", root);
    if (!box) return;
    if (ptsErr) {
      box.innerHTML = `<div class="msg" style="color:#ff4d5e">${ptsErr}</div>`;
      return;
    }
    if (ptsBusy) {
      box.innerHTML = '<div class="msg">loading…</div>';
      return;
    }
    if (!pts.length) {
      box.innerHTML =
        '<div class="msg">Add channels above, then refresh. Reading a balance ' +
        "needs no player — earning does.</div>";
      return;
    }
    const pending = pts.filter((p) => p.claim).length;
    const taught = !!(pqVars.ClaimCommunityPoints && pqHashes.ClaimCommunityPoints);
    box.innerHTML =
      pts
        .map(
          (p) => `<div class="vtu-pt">
      <b>${p.login}</b>
      ${
        p.err
          ? `<span class="err">${p.err}</span>`
          : `${p.claim ? '<span class="chest">CHEST</span>' : ""}<i>${p.bal.toLocaleString()}</i>`
      }
    </div>`,
        )
        .join("") +
      (pending && !taught
        ? '<div class="msg" style="color:#ffb44d">Click one chest by hand once — that teaches ' +
          "the request shape, then this button works everywhere.</div>"
        : "");
  }

  function paintFollowing() {
    if (!root) return;
    const box = $("#vtu-fol", root);
    if (!box) return;
    if (folBusy) {
      box.innerHTML = '<div class="msg">loading…</div>';
      return;
    }
    if (folErr) {
      box.innerHTML = `<div class="msg" style="color:#ffb44d">${folErr}</div>`;
      return;
    }
    if (!following.length) {
      box.innerHTML = "";
      return;
    }
    const sel = channelList();
    box.innerHTML = following
      .map(
        (f) => `<div class="vtu-fol${sel.includes(f.login) ? " on" : ""}"
      data-chan="${f.login}"><span class="box"></span><b>${f.name}</b>${
        f.viewers ? `<i>${f.viewers.toLocaleString()}</i>` : ""
      }</div>`,
      )
      .join("");
  }

  function paintVod() {
    const w = seekWindow();
    const msg = $("#vtu-vodoff", root);
    if (isVod()) {
      msg.style.display = "none";
    } else {
      msg.style.display = "block";
      msg.innerHTML =
        w && w.span > 10
          ? `Live · ${(w.span / 60).toFixed(1)} min rewind` +
            (w.behind > 2 ? ` · ${w.behind.toFixed(0)}s behind` : " · at live edge") +
            `<br><span style="color:#57506b">Grows as you watch. Only covers this ` +
            `session — earlier isn't in the live playlist.</span>`
          : `Live · no rewind window yet<br><span style="color:#57506b">Builds up as ` +
            `the player buffers.</span>`;
      msg.style.color = w && w.span > 10 ? "#00e08a" : "#57506b";
    }
    const L = $("#v-loop", root);
    L.textContent =
      cfg.loopA === null && cfg.loopB === null
        ? "not set"
        : `A ${cfg.loopA === null ? "—" : hms(cfg.loopA)}   B ${cfg.loopB === null ? "—" : hms(cfg.loopB)}` +
          (cfg.loopA !== null && cfg.loopB !== null ? "   looping" : "");
  }

  function paintAmb() {
    const sv = $("#v-vsat", root);
    sv.textContent = cfg.vidSat + "%";
    sv.classList.toggle("warn", cfg.vidSat !== 100);

    const sel = $("#s-fit", root);
    if (sel && sel.value !== cfg.fitMode) sel.value = cfg.fitMode;
    const box = $("#v-fit", root);
    if (!box) return;
    const c = fitCost();
    if (!c) {
      box.textContent = "";
      return;
    }
    const ratio = (x) => x.toFixed(2) + ":1";
    if (!c.stretch) {
      box.textContent = `Player ${ratio(c.box)} matches the video — no bars to remove.`;
      box.style.color = "#57506b";
    } else {
      box.textContent =
        `Video ${ratio(c.video)} in a ${ratio(c.box)} player · ` +
        `stretch = ${c.stretch} · crop loses ${c.crop}`;
      box.style.color = cfg.fitMode === "off" ? "#57506b" : "#ffb44d";
    }
  }

  function paintAudio() {
    const g = $("#v-gain", root);
    g.textContent = Math.round(cfg.gain * 100) + "%";
    g.classList.toggle("warn", cfg.gain > 2); // past 200% you start clipping

    $("#v-bass", root).textContent = cfg.bass.toFixed(1) + " dB";
    $("#v-lufs", root).textContent = cfg.targetLufs.toFixed(1);
    $("#s-lufs", root).disabled = !cfg.autoGain;
    $("#s-gain", root).disabled = cfg.autoGain; // auto owns it now
    $("#v-meas", root).textContent = S.lufs === null ? "—" : S.lufs.toFixed(1) + " LUFS";
    /* audioNeeded() but not hooked yet == waiting on a gesture. Without this
       the gain slider reads 3.6x while nothing is actually boosted. */
    const pend = $("#v-audiopend", root);
    if (pend) pend.style.display = audioNeeded() && !hookedEl ? "block" : "none";
    $("#v-comp", root).textContent = cfg.compAmount;
    $("#s-comp", root).disabled = !cfg.comp;
  }

  let qPainted = false;
  function paintQualities() {
    const qs = qualities();
    if (!qs.length || qPainted) return;
    const sel = $("#s-q", root);
    if (!sel) return;
    sel.innerHTML =
      '<option value="">auto (ABR decides)</option>' +
      qs
        .map(
          (q) =>
            `<option value="${q.name}"${q.name === cfg.pinned ? " selected" : ""}>${
              q.name
            } — ${(q.bitrate / 1e6).toFixed(1)} Mbps</option>`,
        )
        .join("");
    qPainted = true;
  }

  function paintLive() {
    if (!root) return;
    paintQualities();
    paintVod();
    if (cfg.fitMode !== "off" || $("#v-fit", root)) paintAmb(); // box changes w/ fullscreen

    const A = $("#vtu-ad", root);
    A.className = "vtu-pip" + (S.adOn ? " hot" : "");
    A.textContent = !S.adOn
      ? "AD"
      : S.adLeft !== null
        ? `AD ${S.adLeft.toFixed(0)}s` +
          (S.adPod && S.adPod[1] > 1 ? ` ${S.adPod[0]}/${S.adPod[1]}` : "")
        : `AD ${((performance.now() - S.adStart) / 1000).toFixed(0)}s`;
    $("#vtu-claims", root).textContent = `${S.claims} claimed`;

    const dp = dropPct();
    $("#v-res", root).textContent = ST.res;
    $("#v-fps", root).textContent = ST.fps ? ST.fps.toFixed(1) : "—";
    const d = $("#v-drop", root);
    d.textContent = ST.total ? `${ST.dropped} (${dp.toFixed(2)}%)` : "—";
    d.classList.toggle("bad", dp > 1);
    $("#v-buf", root).textContent = ST.buf.toFixed(1) + "s";
    const L = $("#v-lat", root);
    L.textContent =
      ST.lat === null
        ? "—"
        : ST.lat.toFixed(2) + "s" + (ST.lowLat ? " LL" : "") + (rateHeld ? " ▸1.05x" : "");
    L.classList.toggle("bad", ST.lat !== null && ST.lat > 6);
    $("#v-br", root).textContent = ST.bitrate ? (ST.bitrate / 1e6).toFixed(1) + " Mbps" : "—";
    $("#v-q", root).textContent = ST.qname ? ST.qname + (ST.auto ? " auto" : "") : "—";
    $("#v-maxlat", root).textContent = cfg.maxLatency > 0 ? cfg.maxLatency.toFixed(1) + "s" : "off";

    // gain-reduction meter — 0 to 20 dB across the bar
    $("#v-gr", root).style.width = clamp((reduction() / 20) * 100, 0, 100) + "%";

    if (cfg.statsOverlay && ov) {
      ov.innerHTML =
        `${ST.res}  ${ST.fps ? ST.fps.toFixed(0) : "--"}fps  ${
          ST.bitrate ? (ST.bitrate / 1e6).toFixed(1) + "Mbps" : ""
        }\n` +
        `buf ${ST.buf.toFixed(1)}s  drop <span class="${dp > 1 ? "bad" : ""}">${dp.toFixed(2)}%</span>` +
        (ST.lat !== null ? `  lat ${ST.lat.toFixed(2)}s${ST.lowLat ? " LL" : ""}` : "") +
        (cfg.comp ? `  gr -${reduction().toFixed(1)}dB` : "");
    }
  }

  function mountOverlay() {
    if (!ov) return;
    const v = getVideo();
    if (!v) return;
    // Must live INSIDE the player subtree or it vanishes in fullscreen.
    const host = v.closest(SEL.playerRoot) || v.parentElement;
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    if (ov.parentElement !== host) host.appendChild(ov);
    ov.style.display = cfg.statsOverlay ? "block" : "none";
  }

  /* Twitch ships real collapse controls for both rails. Driving those beats
     display:none — the layout reflows properly instead of leaving a gap, and
     Twitch persists the state itself. We only click when it's actually wrong,
     otherwise we'd fight the user every tick. */
  function applyLayout() {
    const p = $(SEL.primeNag);
    if (p) p.style.display = cfg.hidePrime ? "none" : "";

    if (cfg.hideSidebar) {
      const a = $(SEL.sidebarArrow);
      if (a && $('[data-a-target="side-nav-header-expanded"]')) a.click();
    }
    if (cfg.collapseChat) {
      const c = $(SEL.chatCollapse);
      if (c && c.getAttribute("aria-label")?.toLowerCase().includes("collapse")) c.click();
    }
    /* Twitch's own stats panel is deliberately left alone — nothing here
       scrapes it, so there is no reason to fight the user over it. */
  }

  function toggle(k, el) {
    if (!el) return;
    cfg[k] = !cfg[k];
    el.dataset.on = cfg[k] ? 1 : 0;
    el.setAttribute("aria-checked", String(!!cfg[k]));
    save();

    if (k === "comp" || k === "mono") {
      resumeAudio();
      hookAudio();
      applyAudio();
      paintAudio();
    }
    if (k === "autoGain") {
      resumeAudio();
      hookAudio();
      autoGain();
      paintAudio();
    }
    if (k === "hidePrime" || k === "hideSidebar") applyLayout();
    if (k === "statsOverlay") mountOverlay();
    if (k === "bgQuality") {
      if (!cfg[k] && preBg !== null) bgApply(false);
      else bgApply(tabHidden());
    }
    if (k === "lurkHidden") paintLurk();
    if (k === "lowLatency") {
      llWarned = false;
      llTries = 0;
      applyLatencyMode();
    }
    if (k === "collapseChat" && !cfg[k]) {
      const c = $(SEL.chatCollapse);
      if (c) c.click();
    }
    if (k === "hideSidebar" && !cfg[k]) {
      const a = $(SEL.sidebarArrow);
      if (a) a.click();
    }
    if (k === "adBlank" && !cfg[k]) {
      const v = getVideo();
      if (v) v.style.opacity = "";
    }
    if (k === "adMute" && !cfg[k]) restoreAudio(); // don't strand a mute we own
  }

  function slider(id, key, after) {
    $(id, root).addEventListener("input", (e) => {
      resumeAudio();
      hookAudio();
      cfg[key] = parseFloat(e.target.value);
      applyAudio();
      save();
      if (after) after();
      paintAudio();
    });
  }

  function wire() {
    root.addEventListener("click", (e) => {
      resumeAudio();
      const hdr = e.target.closest(".vtu-sec[data-sec]");
      if (hdr) return foldSection(hdr, !hdr.classList.contains("fold"));
      const fol = e.target.closest(".vtu-fol[data-chan]");
      if (fol) return toggleChan(fol.dataset.chan);
      const sw = e.target.closest(".vtu-sw");
      if (sw) return toggle(sw.dataset.k, sw);
      const lb = e.target.closest("label[data-k]");
      if (lb) return toggle(lb.dataset.k, $(`.vtu-sw[data-k="${lb.dataset.k}"]`, root));
      const b = e.target.closest("[data-act]");
      if (!b) return;
      ({
        live: jumpLive,
        source: lockSource,
        shot: screenshot,
        pip,
        filtered: dumpFiltered,
        cast,
        url: copyStreamURL,
        fb: () => frameStep(-1),
        ff: () => frameStep(1),
        rw30: () => seekBy(-30),
        rw10: () => seekBy(-10),
        seekdiag: dumpSeek,
        fromstart: watchFromStart,
        la: () => setLoop("loopA"),
        lb: () => setLoop("loopB"),
        lc: clearLoop,
        ts: copyTimestamp,
        pts: refreshPoints,
        claim: claimAll,
        lurk: lurkStart,
        unlurk: lurkStop,
        fol: refreshFollowing,
        export: exportCfg,
        import: importCfg,
        reset: resetAll,
        setkey: () => {
          capturingKey = true;
          paintKey();
          $("#b-key", root).blur();
          note("Press the new key…");
        },
      })[b.dataset.act]();
    });

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const sw = e.target.closest(".vtu-sw");
      if (sw) {
        e.preventDefault();
        return toggle(sw.dataset.k, sw);
      }
      const hdr = e.target.closest(".vtu-sec[data-sec]");
      if (hdr) {
        e.preventDefault();
        foldSection(hdr, !hdr.classList.contains("fold"));
      }
    });

    /* 'change' not 'input' — refreshing per keystroke would fire a GQL request
       for every letter of a channel name. */
    $("#s-pch", root).addEventListener("change", (e) => {
      cfg.pointsChannels = e.target.value;
      save();
      paintFollowing(); // typing and clicking edit the same list
      refreshPoints();
    });

    $("#s-lscale", root).addEventListener("input", (e) => {
      cfg.lurkScale = parseFloat(e.target.value);
      save();
      paintLurk();
    });

    $("#s-vsat", root).addEventListener("input", (e) => {
      cfg.vidSat = parseFloat(e.target.value);
      save();
      applyVideoFilter();
      paintAmb();
    });

    slider("#s-gain", "gain");
    slider("#s-bass", "bass");
    slider("#s-comp", "compAmount");
    slider("#s-lufs", "targetLufs", autoGain);
    slider("#s-maxlat", "maxLatency", applyLatencyMode);

    $("#s-fit", root).addEventListener("change", (e) => {
      cfg.fitMode = e.target.value;
      save();
      applyFit();
      paintAmb();
    });

    $("#s-q", root).addEventListener("change", (e) => {
      const q = qualities().find((x) => x.name === e.target.value);
      pinQuality(q || null);
    });

    // drag by titlebar
    const bar = $("#vtu-bar", root);
    let dx = 0,
      dy = 0,
      dragging = false;
    bar.addEventListener("mousedown", (e) => {
      dragging = true;
      dx = e.clientX - root.offsetLeft;
      dy = e.clientY - root.offsetTop;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      root.style.left = clamp(e.clientX - dx, 0, innerWidth - 60) + "px";
      root.style.top = clamp(e.clientY - dy, 0, innerHeight - 30) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      cfg.panelX = root.offsetLeft;
      cfg.panelY = root.offsetTop;
      save();
    });
  }

  /* ─────────────────────────────────────────────────────────────
     KEYBIND — must not fire while typing in chat.
     ───────────────────────────────────────────────────────────── */
  let capturingKey = false;
  const keyLabel = (k) => (k === "`" ? "backtick" : k === " " ? "Space" : k);
  const typing = (el) =>
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

  /* Keybinds are main-tab only. In a frame root is never built, so the menu
     handler would throw on root.classList — and a hidden lurk frame taking
     keystrokes would be its own kind of wrong. */
  if (!inFrame) {
    window.addEventListener(
      "keydown",
      (e) => {
        if (!capturingKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key)) return;
        capturingKey = false;
        if (e.key === "Escape") {
          paintKey();
          return note("Menu key unchanged");
        }
        if (e.key === "," || e.key === ".") {
          paintKey();
          return note("Reserved for frame-step");
        }
        cfg.menuKey = e.key;
        save();
        paintKey();
        note("Menu key: " + keyLabel(cfg.menuKey));
      },
      true,
    );
    /* , and . are the conventional frame-step keys (mpv, Premiere, DaVinci).
     Same input guard as the menu key — Twitch chat is a contenteditable, and
     stepping frames every time you type a comma would be memorable. */
    window.addEventListener(
      "keydown",
      (e) => {
        if (typing(document.activeElement)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "," || e.key === ".") {
          if (!canSeek()) return;
          e.preventDefault();
          frameStep(e.key === "," ? -1 : 1);
        }
      },
      true,
    );

    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key.toLowerCase() !== cfg.menuKey.toLowerCase()) return;
        if (typing(document.activeElement)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        root.classList.toggle("on");
        if (root.classList.contains("on")) {
          resumeAudio();
          hookAudio();
          if (channelList().length && !pts.length) refreshPoints();
        }
      },
      true,
    );
  } // end !inFrame keybinds

  /* ─────────────────────────────────────────────────────────────
     BOOT
     ───────────────────────────────────────────────────────────── */
  let lastPath = location.pathname;

  function slow() {
    tickDismiss();
    reconcile();
    /* visibilitychange can land before playerReady(), and bgApply bails rather
       than fire a call that gets dropped. So converge here too — if the tab's
       state and preBg disagree, one of those bails needs retrying. */
    if (cfg.bgQuality && (tabHidden() ? preBg === null : preBg !== null)) {
      bgApply(tabHidden());
    }
    autoGain();
    hookAudio(); // re-hooks after Twitch swaps the video element
    audioWatchdog();
    mountOverlay();
    applyVideoFilter();
    applyFit(); // Twitch rebuilds the video element on nav; re-assert
    applyLayout();

    // SPA navigation — Twitch never reloads, so watch the path.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      hookedEl = null;
      nodes = null;
      unbindEvents();
      mpi = null; // new channel, new instance
      qCache = null;
      qPainted = false; // new ladder too
      llAsked = null;
      llWarned = false;
      llTries = 0; // new instance, ask again
      S.adEvent = null;
      adTimeLogged = false;
      if (mutedByUs) {
        mutedByUs = false;
        priorMuted = null;
      } // don't carry a mute across
      S.adOn = false;
      domClear = 0;
      ST.lat = null;
      resetStats();
    }
  }

  function fast() {
    tickAds();
    adWatchdog();
    auditMute();
    tickStats();
    tickLatencyCap();
    checkLatencyTook();
    tickLoop();
    paintLive();
  }

  /* Two jobs only. Deliberately does NOT touch the player: the lurker sets
     video-quality to 160p30 before the frame loads, and our reconciler would
     immediately pin it back to source — four hidden frames at 8.5 Mbps each,
     which is the exact opposite of the point. Leave its settings alone. */
  /* ─── SILENCE WITHOUT MUTING ───────────────────────────────────
     createMediaElementSource() reroutes an element's audio into the graph. End
     the graph in a gain of 0 and nothing reaches the output — while the element
     itself is never touched: muted stays false, volume stays 1, and Twitch's
     player sees a perfectly normal unmuted stream.

     The order below is not stylistic. Routing an element into a SUSPENDED
     context stalls playback, and createMediaElementSource is
     irreversible — you cannot un-route an element, so getting this wrong bricks
     the frame until reload. So: build the context, prove it reaches 'running',
     and only then route. If it won't resume we fall back to muting, because a
     muted frame still earns and a stalled one doesn't. */
  let lurkAudio = null,
    lurkSilenced = false;

  async function silenceLurk() {
    if (lurkSilenced) return;
    const v = getVideo();
    if (!v || v.readyState < 3 || v.paused) return; // wait for real playback

    try {
      lurkAudio = lurkAudio || new (window.AudioContext || window.webkitAudioContext)();
      if (lurkAudio.state !== "running") {
        try {
          await lurkAudio.resume();
        } catch {}
      }
      if (lurkAudio.state !== "running") {
        /* Same-origin frames inherit autoplay permission, so this should be
           rare — but never route into a context that isn't pulling. */
        if (!v.muted) {
          v.muted = true;
          console.warn(
            `[Twitch Utils] lurk: AudioContext ${lurkAudio.state} — ` +
              `muted instead of silencing (a stalled frame earns nothing)`,
          );
        }
        lurkSilenced = true;
        return;
      }
      const src = lurkAudio.createMediaElementSource(v);
      const g = lurkAudio.createGain();
      g.gain.value = 0;
      src.connect(g).connect(lurkAudio.destination);
      lurkSilenced = true;
      console.log(
        `%c[Twitch Utils] lurk: silenced via dead-end graph ` +
          `(muted=${v.muted}, volume=${v.volume})`,
        "color:#00e08a",
      );
    } catch (e) {
      /* Throws if the element is already routed — which means it's already
         silenced and there's nothing to do. */
      lurkSilenced = true;
    }
  }

  function bootHeadless() {
    if (!document.body) return setTimeout(bootHeadless, 50);
    setInterval(tickClaim, 12000); // chests drop ~every 15 min
    setInterval(tickDismiss, 1500); // an age gate = a frame that never plays = no points

    if (isOurLurk) {
      setInterval(silenceLurk, 1500);
      /* Ours to configure, so do it through the player rather than by writing
         video-quality to localStorage — that key is shared with your real tabs.
         Keep asking: the player rebuilds on nav, and a dropped call here means
         a frame quietly pulling 8.5 Mbps for nobody. */
      setInterval(() => {
        const m = getMPI();
        if (!m || !playerReady()) return;
        try {
          const qs = m.getQualities();
          if (!qs || !qs.length) return;
          const low = qs[qs.length - 1];
          const cur = m.getQuality();
          if (m.isAutoQualityMode() || !cur || cur.name !== low.name) {
            m.setAutoQualityMode(false);
            m.setQuality(low, true);
          }
        } catch {}
      }, 2000);
    }

    console.log(
      `%c[Twitch Utils v5.0] headless in frame (${location.pathname})` +
        `${isOurLurk ? " — lurk: muted, lowest quality, claiming" : " — claim + dismiss only"}`,
      "color:#a970ff",
    );
  }

  function boot() {
    if (inFrame) return bootHeadless();
    if (!document.body) return setTimeout(boot, 50);
    armGesture();
    armVisibility();
    build();
    setInterval(fast, 500);
    setInterval(slow, 1000);
    setInterval(tickClaim, 12000); // chests drop ~every 15 min; 12s is plenty

    console.log(
      "%c[Twitch Utils v5.0] loaded — press " + cfg.menuKey + " for the menu",
      "color:#a970ff;font-weight:bold",
    );
    /* This used to warn unconditionally. On /directory/* there IS no player, so
       it cried wolf on exactly the page the lurker runs from. Only complain when
       a video exists and we still can't reach its core — that's the real
       failure (sandboxed @grant, renamed React internals). */
    setTimeout(() => {
      if (getMPI()) {
        console.log(
          "%c[Twitch Utils] player core attached — window.__mpi is live",
          "color:#00e08a",
        );
      } else if (getVideo()) {
        console.log(
          "%c[Twitch Utils] video present but player core unreachable — " +
            "check that @grant is still none",
          "color:#ff4d5e",
        );
      } else {
        console.log(
          "%c[Twitch Utils] no player on this page (normal for /directory/*)",
          "color:#57506b",
        );
      }
    }, 3000);
  }

  boot();
})();
