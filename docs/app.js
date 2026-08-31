/* ECHO — cross-app-read relay board. Reads echo's global state — and the
   beacon's — from the TestNet indexer once appId > 0 in deploy.json. Live
   first; on feed failure falls back to the last good snapshot (STALE)
   rather than guessing. TestNet only. Read-only. No wallet. No keys. */
(() => {
  const INDEXER = "https://testnet-idx.algonode.cloud";
  const ALGOD = "https://testnet-api.algonode.cloud";
  const EXPLORER = "https://testnet.explorer.perawallet.app/application/";
  const CONTRACT_SRC =
    "https://github.com/corvid-agent/echo/blob/main/smart_contracts/echo/contract.py";
  const DEFAULT_KEEPER = 769891898;
  const DEFAULT_BEACON = 770742777;
  const REFRESH_MS = 30000;
  const SNAPSHOT_KEY = "echo:snapshot";

  function b64utf8(b64) {
    try { return atob(b64); } catch { return ""; }
  }

  function b64ToHex(b64) {
    try {
      const bin = atob(b64);
      let hex = "";
      for (let i = 0; i < bin.length; i++) {
        hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
      }
      return hex;
    } catch {
      return "";
    }
  }

  function readGlobal(state, name) {
    if (!Array.isArray(state)) return null;
    for (const kv of state) {
      if (b64utf8(kv.key) !== name) continue;
      if (kv.value && kv.value.type === 2) return { kind: "uint", v: kv.value.uint };
      if (kv.value && kv.value.type === 1) return { kind: "bytes", v: kv.value.bytes };
      return null;
    }
    return null;
  }

  async function fetchJson(url, noStore) {
    const opts = { headers: { Accept: "application/json" } };
    if (noStore) opts.cache = "no-store";
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  function flaps(el, text) {
    el.replaceChildren();
    for (const ch of String(text)) {
      const d = document.createElement("span");
      d.className = "flap" + (ch === " " ? " blank" : "");
      d.textContent = ch === " " ? " " : ch;
      el.appendChild(d);
    }
  }

  function setStatus(word, cls, subHtml) {
    const el = document.getElementById("status");
    el.className = "flaps big " + cls;
    flaps(el, word.toUpperCase());
    document.getElementById("subhead").innerHTML = subHtml;
    document.title = "ECHO — " + word.toUpperCase();
  }

  const STAT_IDS = [
    "stat-seen", "stat-seed", "stat-relays", "stat-beacon",
    "stat-lag", "stat-target", "stat-round", "stat-keeper",
  ];

  function fillStats(map) {
    for (const id of STAT_IDS) {
      flaps(document.getElementById(id), map[id] || "—");
    }
  }

  function shortHex(hex) {
    if (!hex) return "—";
    return hex.length > 18 ? hex.slice(0, 8) + "…" + hex.slice(-8) : hex;
  }

  function saveSnapshot(snap) {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch { /* storage unavailable; live-only then */ }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function renderSnapshot(snap) {
    const ageMin = Math.max(0, Math.round((Date.now() - snap.ts) / 60000));
    setStatus("STALE", "gate",
      "feed unreachable · last good read " + ageMin + " min ago: " +
      snap.word + (snap.subText ? " · " + snap.subText : ""));
    fillStats(snap.stats || {});
  }

  let cfgPromise = null;
  function loadConfig() {
    if (!cfgPromise) {
      cfgPromise = fetchJson("./deploy.json", true).then((c) => ({
        appId: Number(c.appId) || 0,
        keeper: Number(c.keeperAppId) || DEFAULT_KEEPER,
        beacon: Number(c.beaconAppId) || DEFAULT_BEACON,
        network: c.network || "testnet",
        notes: c.notes || "",
      }));
    }
    return cfgPromise;
  }

  async function tick() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      setStatus("FEED DOWN", "down",
        "deploy.json unreadable · showing nothing rather than guessing");
      fillStats({});
      return;
    }
    document.getElementById("keeper-meta").textContent =
      cfg.network + " · Arcron keeper " + cfg.keeper;

    const beaconLink =
      'beacon <a href="' + EXPLORER + cfg.beacon + '">' + cfg.beacon + "</a>";

    if (cfg.appId <= 0) {
      setStatus("NOT DEPLOYED", "gate",
        'contract exists as <a href="' + CONTRACT_SRC + '">source</a> only' +
        " · lights up after TestNet deploy + set_keeper + set_target + Arcron registration" +
        " · will read " + beaconLink);
      fillStats({ "stat-keeper": String(cfg.keeper), "stat-target": String(cfg.beacon) });
      return;
    }

    let round, gs, bgs;
    try {
      const status = await fetchJson(ALGOD + "/v2/status");
      round = status["last-round"];
      const app = await fetchJson(INDEXER + "/v2/applications/" + cfg.appId);
      const params = (app.application && app.application.params) || app.params || {};
      gs = params["global-state"];
      // The beacon is read too, so the board can show echo's lag against
      // the source it mirrors. A beacon read failure is not fatal: the
      // lag cell just goes blank.
      try {
        const beacon = await fetchJson(INDEXER + "/v2/applications/" + cfg.beacon);
        const bparams = (beacon.application && beacon.application.params) || beacon.params || {};
        bgs = bparams["global-state"];
      } catch {
        bgs = null;
      }
    } catch (e) {
      const snap = loadSnapshot();
      if (snap && snap.appId === cfg.appId) {
        renderSnapshot(snap);
      } else {
        setStatus("FEED DOWN", "down",
          "indexer unreachable · no prior snapshot · showing nothing rather than guessing");
        fillStats({ "stat-keeper": String(cfg.keeper) });
      }
      return;
    }

    const keeperApp = readGlobal(gs, "keeper_app");
    const targetApp = readGlobal(gs, "target_app");
    const lastSeen = readGlobal(gs, "last_seen_round");
    const relays = readGlobal(gs, "relays");
    const lastSeed = readGlobal(gs, "last_seed");

    const nSeen = lastSeen && lastSeen.kind === "uint" ? lastSeen.v : 0;
    const nRelays = relays && relays.kind === "uint" ? relays.v : 0;
    const seedHex = lastSeed && lastSeed.kind === "bytes" ? b64ToHex(lastSeed.v) : "";

    const beaconRound = readGlobal(bgs, "revealed_round");
    const nBeacon = beaconRound && beaconRound.kind === "uint" ? beaconRound.v : null;
    const lag = nBeacon === null ? null : Math.max(0, nBeacon - nSeen);

    const stats = {
      "stat-seen": nSeen > 0 ? String(nSeen) : "—",
      "stat-seed": seedHex ? shortHex(seedHex) : "—",
      "stat-relays": String(nRelays),
      "stat-beacon": nBeacon !== null && nBeacon > 0 ? String(nBeacon) : "—",
      "stat-lag": lag === null ? "—" : String(lag),
      "stat-target": targetApp ? String(targetApp.v) : "—",
      "stat-round": String(round),
      "stat-keeper": keeperApp ? String(keeperApp.v) : "—",
    };
    fillStats(stats);

    const appLink = 'app <a href="' + EXPLORER + cfg.appId + '">' + cfg.appId + "</a>";
    let word, cls, subText;
    if (!keeperApp || keeperApp.v === 0) {
      word = "NO KEEPER"; cls = "gate";
      subText = appLink + " is live but set_keeper has not run yet";
    } else if (!targetApp || targetApp.v === 0) {
      word = "NO TARGET"; cls = "gate";
      subText = appLink + " keeper wired · set_target has not named the beacon yet";
    } else if (nRelays === 0) {
      word = "LISTENING"; cls = "gate";
      subText = appLink + " reading " + beaconLink +
        " · nothing fresh relayed yet";
    } else if (lag !== null && lag > 0) {
      word = "BEHIND"; cls = "down";
      subText = appLink + " holds round " + nSeen + " · " + beaconLink +
        " is at " + nBeacon + " · the next keeper call relays it";
    } else {
      word = "ECHOING"; cls = "live";
      subText = appLink + " mirrors " + beaconLink +
        " · round " + nSeen + " · " + nRelays + " relay" + (nRelays === 1 ? "" : "s");
    }
    setStatus(word, cls, subText);

    saveSnapshot({
      appId: cfg.appId,
      ts: Date.now(),
      word: word,
      subText: subText.replace(/<[^>]*>/g, ""),
      stats: stats,
    });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
