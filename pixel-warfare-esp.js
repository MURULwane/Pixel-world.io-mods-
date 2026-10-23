// ==UserScript==
// @name        PW Box + Skeleton ESP + Aimlock + God Mode
// @version     2.3.0
// @match       *://pixelwarfare.io/*
// @match       *://www.pixelwarfare.io/*
// @match       *://games.crazygames.com/*/pixel-warfare/*
// @match       *://*.game-files.crazygames.com/*
// @require     https://raw.githubusercontent.com/Recte-Development/rectehoststuff/refs/heads/main/m39rectescriptloaderplsdontfailme
// @run-at      document-idle
// @grant       none
// ==/UserScript==

(function() {
  // The Unity game only lives inside the CrazyGames gameframe
  // (games.crazygames.com/.../pixel-warfare/index.html). pixelwarfare.io and
  // the crazygames.com browsing pages are React shells that never host
  // Unity — installing our plugin/hooks there only wastes timers and pokes
  // the host page (e.g. React hydration). Other portals that serve the game
  // from their own origin still get the mod.
  var hp = location.hostname;
  var knownGameFrame =
    hp === "games.crazygames.com" ||
    /(^|\.)game-files\.crazygames\.com$/.test(hp);
  var isHostileWrapper =
    /(^|\.)pixelwarfare\.io$/.test(hp) ||
    ((/(^|\.)crazygames\.com$/.test(hp)) && !knownGameFrame);
  if (isHostileWrapper) return;

  var canvas, ctx2d, ctx;
  var playerMap = {};
  var nameCache = {};          // actorNr -> resolved nickname (Photon NickName, once per actor)
  var teamCache = {};          // gcPtr raw -> { team: string, ts: number } from gd.playerTeam @0xC8
  var skelCache = {};          // gcPtr raw -> { nodes: Array, links: Array, ts: number } bone cache
  var _reusableBufs = {};
  var _spanDebugOnce = false;

  // ============================================================
  // Local player & MouseLook state (Pixel Warfare dump.cs)
  //
  // Hierarchy (FPS Kit 2.0):
  //   Player Root: gc (playerDamage), fp (FPScontroller), gd (PlayerNetwork),
  //                fr/fs with axes == 1 (MouseX -> rotates root Transform Y).
  //   Child lookObj (fp.lookObj @0x60):
  //                fr/fs with axes == 2 (MouseY -> pitch float @0x2C kam/kar,
  //                writes Transform.localEulerAngles.x = -kam).
  //   (Single-component setups use axes == 0 MouseXAndY on one Transform.)
  //
  // IMPORTANT: On both fr (TypeDefIndex 2801) and fs (TypeDefIndex 2803):
  //   @0x10 = axes (0 = MouseXAndY, 1 = MouseX, 2 = MouseY)
  //   @0x1C = sensitivityX (kak / sensitivityX) -- DO NOT OVERWRITE
  //   @0x20 = sensitivityY (kal / sensitivityY) -- DO NOT OVERWRITE
  //   @0x24 = minimumY (float)
  //   @0x28 = maximumY (float)
  //   @0x2C = rotationY pitch accumulator (kam in fr, kar in fs)
  //   @0x30 = hr weaponManager (kan in fr, kas in fs)
  // ============================================================
  var localGcPtr = null;       // gc pointer for the local (IsMine) player
  var localFpPtr = null;       // fp (FPScontroller) via gc.kdh @0x140
  var localRootTr = null;      // cached root Transform of localGcPtr
  var localStamp = 0;          // last gc.Update timestamp for IsMine player

  var mlXY = null, mlXYStamp = 0; // fr/fs with axes == 0 (MouseXAndY)
  var mlX  = null, mlXStamp  = 0; // fr/fs with axes == 1 (MouseX - horizontal yaw on Transform)
  var mlY  = null, mlYStamp  = 0; // fr/fs with axes == 2 (MouseY - vertical pitch @0x2C + Transform)
  var _mlOwnerCache = {};         // ptrVal -> boolean (Transform.get_root ownership cache)
  var pitchSign = 1;              // +1 when localEulerAngles.x == -kam (Unity MouseLook standard)
  var _mlDebugLogged = {};

  // God Mode state (gc.disableDamage @0x12C + 24-byte ObscuredFloat currentHp @0xEC snapshot)
  var _spawnHpGcVal = 0;
  var _spawnHpWords = null;       // 6 x i32 genuine ObscuredFloat snapshot from spawn/max HP
  var _spawnHpFake = 0;
  var _godAppliedGcVal = 0;

  // ============================================================
  // CONFIG (Buildnow.gg / Poxel structure + localStorage persistence)
  // ============================================================
  var espConfig = {
    enabled: true,
    toggleKey: "Insert",
    menuKey: "p",
    box: true,
    boxThickness: 2,
    boxColor: "#ff0000",
    boxWidth: 0.6,        // box width as fraction of height (blocky models: 0.6)
    boxHeight: 1.8,       // fallback height when hitboxes can't be read
    boxAutoHeight: true,  // resolve exact top/bottom from the real hitbox colliders
    heightAdj: 0,         // meters added to the resolved top for fine tuning
    skeleton: true,       // Poxel-style animated bone skeleton ESP
    skeletonThickness: 1.5,
    skeletonColor: "#00ffff",
    tracer: true,         // line from screen bottom-center to each player's feet
    tracerThickness: 1.5,
    tracerColor: "#ff00ff",
    invistracerColor: "#ff4444",
    name: true,           // nickname below each box (Photon NickName)
    nameSize: 13,
    nameColor: "#ffffff",
    distance: false,      // optional distance readout below name (BNGG style)
    distanceSize: 11,
    distanceColor: "#ffffff",
    debug: false          // true -> one-shot console diagnostic on hitbox resolution
  };

  var aimConfig = {
    aimbot: false,                         // toggled with "O" key or Menu
    toggleKey: "o",
    vischeck: false,                       // Raycast wall check from camera to target
    teamCheck: false,                      // skip teammates in TDM / Zombie modes
    aimType: "Closest to Centre Screen",   // "Closest to Centre Screen" | "Closest" (BNGG modes)
    aimBone: "Head",                       // "Head" | "Chest"
    aimKey: "Right Click",                 // mouse button or keyboard key (BNGG aimKeyRow)
    aimSpeed: 1.0,                         // 1.0 = instant lock (BNGG default), <1 = smooth lerp
    aimHeight: -0.2,                       // meters offset from resolved head top (BNGG default -0.2)
    fovcircle: false,                      // draw FOV circle & enforce radius (BNGG default false)
    fovsize: 150                           // px radius around crosshair
  };

  var exploitConfig = {
    godMode: false,                        // toggled with "G" key or Menu -> Player tab
    toggleKey: "g",
    antiInfect: true                       // block zombie infection RPC while in God Mode
  };

  var CONFIG_KEY = "pw_esp_v2_menu_config";

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        esp: espConfig,
        aim: aimConfig,
        exploit: exploitConfig
      }));
    } catch(e) {}
  }

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (saved.esp) for (var k in saved.esp) if (k in espConfig) espConfig[k] = saved.esp[k];
      if (saved.aim) for (var j in saved.aim) if (j in aimConfig) aimConfig[j] = saved.aim[j];
      if (saved.exploit) for (var m in saved.exploit) if (m in exploitConfig) exploitConfig[m] = saved.exploit[m];
      return true;
    } catch(e) { return false; }
  }

  function resetConfig() {
    try { localStorage.removeItem(CONFIG_KEY); location.reload(); } catch(e) {}
  }

  loadConfig();

  // ============================================================
  // Input tracking — Buildnow.gg shape (mouse + keyboard + blur reset)
  // ============================================================
  var keysDown = {};
  var mouseDown = { 0: false, 1: false, 2: false, 3: false, 4: false };
  var menuOpen = false;
  var menuContainer = null;
  var activeTab = "Visuals";

  function isInGameChatOpen() {
    try {
      if (!localGcPtr || localGcPtr.val() === 0) return false;
      var rmmW = localGcPtr.readField(0x138, "i32"); // gc.rmm -> iu
      if (!rmmW || rmmW.val() === 0) return false;
      return (rmmW.readField(0x2C4, "i32").val() & 0xff) !== 0; // iu.IsChat @0x2C4
    } catch(e) {
      return false;
    }
  }

  function isTypingInInput(e) {
    var el = e && e.target;
    if (el && el.tagName) {
      var tag = el.tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable) return true;
    }
    return isInGameChatOpen();
  }

  window.addEventListener("keydown", function(e) {
    keysDown[e.key] = true;
    keysDown[e.code] = true;
    if (e.repeat) return;
    if (isTypingInInput(e)) return;

    if (e.key === espConfig.menuKey || e.code === ("Key" + String(espConfig.menuKey).toUpperCase())) {
      e.preventDefault();
      toggleMenu();
      return;
    }
    if (e.key === espConfig.toggleKey || e.code === espConfig.toggleKey) {
      espConfig.enabled = !espConfig.enabled;
      saveConfig();
      console.log("[PW ESP] " + (espConfig.enabled ? "ON" : "OFF"));
      showToast("ESP: " + (espConfig.enabled ? "ON" : "OFF"));
      if (menuOpen) renderPanel();
    }
    if (e.key === aimConfig.toggleKey || e.code === ("Key" + String(aimConfig.toggleKey).toUpperCase())) {
      aimConfig.aimbot = !aimConfig.aimbot;
      saveConfig();
      console.log("[PW AIM] " + (aimConfig.aimbot ? "ON" : "OFF"));
      showToast("Aimbot: " + (aimConfig.aimbot ? "ON" : "OFF"));
      if (menuOpen) renderPanel();
    }
    if (e.key === exploitConfig.toggleKey || e.code === ("Key" + String(exploitConfig.toggleKey).toUpperCase())) {
      exploitConfig.godMode = !exploitConfig.godMode;
      saveConfig();
      console.log("[PW GOD] " + (exploitConfig.godMode ? "ON" : "OFF"));
      showToast("God Mode: " + (exploitConfig.godMode ? "ON" : "OFF"));
      if (menuOpen) renderPanel();
    }
  }, true);

  window.addEventListener("keyup", function(e) {
    keysDown[e.key] = false;
    keysDown[e.code] = false;
  }, true);

  window.addEventListener("mousedown", function(e) { mouseDown[e.button] = true; }, true);
  window.addEventListener("mouseup",   function(e) { mouseDown[e.button] = false; }, true);
  window.addEventListener("contextmenu", function(e) { e.preventDefault(); }, true);

  window.addEventListener("blur", function() {
    keysDown = {};
    mouseDown = { 0: false, 1: false, 2: false, 3: false, 4: false };
  }, true);

  window.addEventListener("beforeunload", function() {
    playerMap = {};
    localGcPtr = null;
    localFpPtr = null;
    localRootTr = null;
    mlXY = null; mlX = null; mlY = null;
  }, true);

  function isAimKeyHeld() {
    var k = aimConfig.aimKey;
    if (k === "Right Click")  return !!mouseDown[2];
    if (k === "Left Click")   return !!mouseDown[0];
    if (k === "Middle Click") return !!mouseDown[1];
    if (k === "Side1")        return !!mouseDown[3];
    if (k === "Side2")        return !!mouseDown[4];
    if (k === "Shift")        return !!(keysDown["Shift"] || keysDown["ShiftLeft"] || keysDown["ShiftRight"]);
    if (k === "Ctrl")         return !!(keysDown["Control"] || keysDown["ControlLeft"] || keysDown["ControlRight"]);
    if (k === "Alt")          return !!(keysDown["Alt"] || keysDown["AltLeft"] || keysDown["AltRight"]);
    if (k === "Space")        return !!(keysDown[" "] || keysDown["Space"]);
    return !!(keysDown[k] || keysDown[k.toLowerCase()] || keysDown["Key" + k.toUpperCase()]);
  }

  // ============================================================
  // MENU — Buildnow.gg style with Visuals / Aimbot / Settings tabs
  // ============================================================
  function cfgObj(cfg) {
    if (cfg === "aim") return aimConfig;
    if (cfg === "exploit") return exploitConfig;
    return espConfig;
  }

  function fmtVal(v) {
    if (Math.round(v) === v) return String(Math.round(v));
    return String(Math.round(v * 100) / 100);
  }

  function toggleRow(cfg, key, label) {
    var checked = cfgObj(cfg)[key] ? "checked" : "";
    return '<div class="hm-row"><span class="hm-label">' + label + '</span>' +
      '<label class="hm-toggle"><input type="checkbox" data-cfg="' + cfg + '" data-key="' + key + '" ' + checked + '><span class="slider"></span></label></div>';
  }

  function selectRow(cfg, key, label, options) {
    var opts = options.map(function(o) {
      return '<option value="' + o + '" ' + (cfgObj(cfg)[key] === o ? "selected" : "") + '>' + o + '</option>';
    }).join("");
    return '<div class="hm-row"><span class="hm-label">' + label + '</span><select class="hm-select" data-cfg="' + cfg + '" data-key="' + key + '">' + opts + '</select></div>';
  }

  function sliderRow(cfg, key, label, min, max, step) {
    var val = cfgObj(cfg)[key];
    return '<div class="hm-row"><span class="hm-label">' + label + '</span>' +
      '<div class="hm-slider-wrap"><input type="range" class="hm-slider" data-cfg="' + cfg + '" data-key="' + key + '"' +
      ' min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"><span class="hm-slider-val">' + fmtVal(val) + '</span></div></div>';
  }

  function colorRow(cfg, key, label) {
    var val = cfgObj(cfg)[key];
    var hexVal = val;
    if (hexVal.indexOf("rgba") === 0 || hexVal.indexOf("rgb") === 0) {
      var m = hexVal.match(/[\d.]+/g);
      if (m && m.length >= 3) {
        hexVal = "#" + [m[0], m[1], m[2]].map(function(x) { return Math.round(parseFloat(x)).toString(16).padStart(2, "0"); }).join("");
      }
    }
    return '<div class="hm-row"><span class="hm-label">' + label + '</span>' +
      '<input type="color" class="hm-color" data-cfg="' + cfg + '" data-key="' + key + '" value="' + hexVal + '"></div>';
  }

  function aimKeyRow() {
    var options = ["Right Click", "Left Click", "Middle Click", "Shift", "Ctrl", "Alt", "Space", "CapsLock", "Tab", "Insert", "Delete", "End", "Home", "F1", "F2", "F3", "F4", "Backquote", "Side1", "Side2"];
    var opts = options.map(function(o) { return '<option value="' + o + '" ' + (aimConfig.aimKey === o ? "selected" : "") + '>' + o + '</option>'; }).join("");
    return '<div class="hm-row"><span class="hm-label">Aim Key</span><select class="hm-select" data-cfg="aim" data-key="aimKey">' + opts + '</select></div>';
  }

  function keyRow(cfg, key, label) {
    var val = cfgObj(cfg)[key];
    var keys = ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z",
                "1","2","3","4","5","6","7","8","9","0",
                "Insert","Delete","End","Home","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
                "Tab","Space","Backquote","Backspace","Enter"];
    var opts = keys.map(function(k) { return '<option value="' + k + '" ' + (val === k ? "selected" : "") + '>' + k.toUpperCase() + '</option>'; }).join("");
    return '<div class="hm-row"><span class="hm-label">' + label + '</span><select class="hm-select" data-cfg="' + cfg + '" data-key="' + key + '">' + opts + '</select></div>';
  }

  function showToast(msg) {
    if (!document.body) return;
    var existing = document.querySelector(".hm-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "hm-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { if (toast.parentElement) toast.remove(); }, 2000);
  }

  function createMenu() {
    if (menuContainer || !document.body || !document.head) return;

    var style = document.createElement("style");
    style.textContent =
      ".hm-wrap { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:999999999;" +
      "  font-family: 'Segoe UI', system-ui, sans-serif; display:none; user-select:none; pointer-events:auto; }" +
      ".hm-wrap.open { display:block; }" +
      ".hm-box { width:420px; background:rgba(10,10,18,0.92); border:1px solid rgba(255,255,255,0.08);" +
      "  border-radius:10px; backdrop-filter:blur(20px); box-shadow:0 20px 60px rgba(0,0,0,0.7);" +
      "  overflow:hidden; display:flex; flex-direction:column; }" +
      ".hm-titlebar { display:flex; align-items:center; padding:10px 14px; gap:8px;" +
      "  background:rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; }" +
      ".hm-titlebar:active { cursor:grabbing; }" +
      ".hm-logo { font-size:14px; font-weight:700; color:#e0e0e0; letter-spacing:1px; }" +
      ".hm-logo span { color:#ff00ff; }" +
      ".hm-ver { font-size:10px; color:rgba(255,255,255,0.3); margin-left:4px; }" +
      ".hm-close { width:24px; height:24px; border:none; background:rgba(255,60,60,0.15);" +
      "  color:#ff4444; border-radius:4px; cursor:pointer; font-size:14px; display:flex;" +
      "  align-items:center; justify-content:center; transition:background 0.15s; }" +
      ".hm-close:hover { background:rgba(255,60,60,0.3); }" +
      ".hm-save-btn { margin-left:auto; padding:4px 10px; border:1px solid rgba(255,0,255,0.2);" +
      "  background:rgba(255,0,255,0.08); color:#ff00ff; border-radius:4px; cursor:pointer;" +
      "  font-size:11px; font-weight:600; font-family:inherit; transition:all 0.15s; }" +
      ".hm-save-btn:hover { background:rgba(255,0,255,0.15); border-color:#ff00ff; }" +
      ".hm-save-btn:active { transform:scale(0.96); }" +
      ".hm-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%);" +
      "  background:rgba(10,10,18,0.9); border:1px solid rgba(255,0,255,0.3);" +
      "  color:#ff00ff; padding:8px 18px; border-radius:6px; font-size:12px;" +
      "  font-family:'Segoe UI',system-ui,sans-serif; z-index:999999999; pointer-events:none;" +
      "  animation: hm-toast-in 0.2s ease, hm-toast-out 0.3s ease 1.5s forwards; }" +
      "@keyframes hm-toast-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }" +
      "@keyframes hm-toast-out { from { opacity:1; } to { opacity:0; transform:translateX(-50%) translateY(-10px); } }" +
      ".hm-action-btn { padding:5px 12px; border:1px solid rgba(255,0,255,0.2);" +
      "  background:rgba(255,0,255,0.08); color:rgba(255,255,255,0.7); border-radius:4px;" +
      "  cursor:pointer; font-size:11px; font-weight:600; font-family:inherit; transition:all 0.15s; }" +
      ".hm-action-btn:hover { background:rgba(255,0,255,0.15); color:#ff00ff; border-color:#ff00ff; }" +
      ".hm-action-btn.danger { border-color:rgba(255,60,60,0.2); background:rgba(255,60,60,0.08); color:rgba(255,255,255,0.5); }" +
      ".hm-action-btn.danger:hover { background:rgba(255,60,60,0.15); color:#ff4444; border-color:#ff4444; }" +
      ".hm-tabs { display:flex; background:rgba(0,0,0,0.2); border-bottom:1px solid rgba(255,255,255,0.06); }" +
      ".hm-tab { flex:1; padding:8px 0; text-align:center; font-size:12px; font-weight:600;" +
      "  color:rgba(255,255,255,0.4); cursor:pointer; transition:color 0.15s, background 0.15s;" +
      "  border-bottom:2px solid transparent; }" +
      ".hm-tab:hover { color:rgba(255,255,255,0.7); background:rgba(255,255,255,0.03); }" +
      ".hm-tab.active { color:#ff00ff; border-bottom-color:#ff00ff; background:rgba(255,0,255,0.05); }" +
      ".hm-body { padding:12px 14px; max-height:360px; overflow-y:auto; }" +
      ".hm-body::-webkit-scrollbar { width:4px; }" +
      ".hm-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }" +
      ".hm-group { margin-bottom:12px; }" +
      ".hm-group-title { font-size:10px; font-weight:700; color:rgba(255,255,255,0.3);" +
      "  text-transform:uppercase; letter-spacing:1.2px; margin-bottom:6px; padding-left:2px; }" +
      ".hm-row { display:flex; align-items:center; justify-content:space-between; padding:5px 8px;" +
      "  border-radius:5px; transition:background 0.12s; }" +
      ".hm-row:hover { background:rgba(255,255,255,0.03); }" +
      ".hm-label { font-size:12px; color:rgba(255,255,255,0.7); }" +
      ".hm-toggle { position:relative; width:34px; height:18px; flex-shrink:0; }" +
      ".hm-toggle input { opacity:0; width:0; height:0; }" +
      ".hm-toggle .slider { position:absolute; inset:0; background:rgba(255,255,255,0.1);" +
      "  border:1px solid rgba(255,255,255,0.08); border-radius:18px; cursor:pointer; transition:0.2s; }" +
      ".hm-toggle .slider::before { content:''; position:absolute; width:12px; height:12px;" +
      "  left:2px; top:2px; background:rgba(255,255,255,0.4); border-radius:50%; transition:0.2s; }" +
      ".hm-toggle input:checked + .slider { background:rgba(255,0,255,0.3); border-color:rgba(255,0,255,0.4); }" +
      ".hm-toggle input:checked + .slider::before { transform:translateX(16px); background:#ff00ff; }" +
      ".hm-select { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);" +
      "  border-radius:4px; color:rgba(255,255,255,0.8); font-size:11px; padding:3px 6px;" +
      "  font-family:inherit; cursor:pointer; outline:none; }" +
      ".hm-select:focus { border-color:rgba(255,0,255,0.4); }" +
      ".hm-select option { background:#1a1a2e; color:#e0e0e0; }" +
      ".hm-slider-wrap { display:flex; align-items:center; gap:8px; }" +
      ".hm-slider { width:80px; height:3px; -webkit-appearance:none; appearance:none;" +
      "  background:rgba(255,255,255,0.1); border-radius:2px; outline:none; cursor:pointer; }" +
      ".hm-slider::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px;" +
      "  background:#ff00ff; border-radius:50%; cursor:pointer; }" +
      ".hm-slider-val { font-size:10px; color:rgba(255,255,255,0.4); min-width:26px; text-align:right; }" +
      ".hm-color { width:24px; height:18px; border:1px solid rgba(255,255,255,0.15);" +
      "  border-radius:3px; cursor:pointer; padding:0; background:none; }" +
      ".hm-color::-webkit-color-swatch-wrapper { padding:0; }" +
      ".hm-color::-webkit-color-swatch { border:none; border-radius:2px; }";
    document.head.appendChild(style);

    var wrap = document.createElement("div");
    wrap.className = "hm-wrap";
    wrap.innerHTML =
      '<div class="hm-box">' +
        '<div class="hm-titlebar">' +
          '<div class="hm-logo">PW<span>.</span>MENU</div>' +
          '<div class="hm-ver">v2</div>' +
          '<button class="hm-save-btn" id="hm-save" title="Save Config">Save</button>' +
          '<button class="hm-close">&times;</button>' +
        '</div>' +
        '<div class="hm-tabs">' +
          '<div class="hm-tab active" data-tab="Visuals">Visuals</div>' +
          '<div class="hm-tab" data-tab="Aimbot">Aimbot</div>' +
          '<div class="hm-tab" data-tab="Player">Player</div>' +
          '<div class="hm-tab" data-tab="Settings">Settings</div>' +
        '</div>' +
        '<div class="hm-body" id="hm-body"></div>' +
      '</div>';

    // Stop pointer events inside the menu from reaching Unity's canvas
    ["mousedown", "mouseup", "click", "pointerdown", "pointerup", "wheel"].forEach(function(ev) {
      wrap.addEventListener(ev, function(e) { e.stopPropagation(); });
    });

    document.body.appendChild(wrap);
    menuContainer = wrap;

    wrap.querySelector(".hm-close").onclick = function() { toggleMenu(); };

    wrap.querySelectorAll(".hm-tab").forEach(function(tab) {
      tab.onclick = function() {
        wrap.querySelectorAll(".hm-tab").forEach(function(t) { t.classList.remove("active"); });
        tab.classList.add("active");
        activeTab = tab.dataset.tab;
        renderPanel();
      };
    });

    var dragging = false, ddx = 0, ddy = 0;
    var titlebar = wrap.querySelector(".hm-titlebar");
    titlebar.addEventListener("mousedown", function(e) {
      if (e.target && (e.target.tagName === "BUTTON")) return;
      dragging = true;
      var rect = wrap.getBoundingClientRect();
      ddx = e.clientX - rect.left;
      ddy = e.clientY - rect.top;
    });
    window.addEventListener("mousemove", function(e) {
      if (!dragging) return;
      wrap.style.left = (e.clientX - ddx) + "px";
      wrap.style.top = (e.clientY - ddy) + "px";
      wrap.style.transform = "none";
    });
    window.addEventListener("mouseup", function() { dragging = false; });

    renderPanel();
  }

  function renderPanel() {
    var body = document.getElementById("hm-body");
    if (!body) return;

    if (activeTab === "Visuals") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">ESP</div>' +
          toggleRow("esp", "enabled", "Enable ESP") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Box</div>' +
          toggleRow("esp", "box", "Enable Box") +
          toggleRow("esp", "boxAutoHeight", "Auto Hitbox Height") +
          sliderRow("esp", "boxThickness", "Thickness", 1, 5, 1) +
          sliderRow("esp", "heightAdj", "Height Adjust", -0.3, 0.3, 0.05) +
          colorRow("esp", "boxColor", "Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Skeleton</div>' +
          toggleRow("esp", "skeleton", "Enable Skeleton") +
          sliderRow("esp", "skeletonThickness", "Thickness", 0.5, 5, 0.5) +
          colorRow("esp", "skeletonColor", "Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Tracers</div>' +
          toggleRow("esp", "tracer", "Enable Tracers") +
          sliderRow("esp", "tracerThickness", "Thickness", 1, 5, 0.5) +
          colorRow("esp", "tracerColor", "Visible Color") +
          colorRow("esp", "invistracerColor", "Hidden Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Name &amp; Distance</div>' +
          toggleRow("esp", "name", "Show Names") +
          sliderRow("esp", "nameSize", "Name Size", 8, 24, 1) +
          colorRow("esp", "nameColor", "Name Color") +
          toggleRow("esp", "distance", "Show Distance") +
          sliderRow("esp", "distanceSize", "Distance Size", 8, 20, 1) +
          colorRow("esp", "distanceColor", "Distance Color") +
        '</div>';
    } else if (activeTab === "Aimbot") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Aimbot</div>' +
          toggleRow("aim", "aimbot", "Aimbot (O)") +
          toggleRow("aim", "vischeck", "Visible Check") +
          toggleRow("aim", "teamCheck", "Team Check") +
          selectRow("aim", "aimType", "Aim Type", ["Closest to Centre Screen", "Closest"]) +
          selectRow("aim", "aimBone", "Target Bone", ["Head", "Chest"]) +
          aimKeyRow() +
          sliderRow("aim", "aimSpeed", "Aim Speed", 0.05, 1, 0.05) +
          sliderRow("aim", "aimHeight", "Aim Height", -0.4, 0.2, 0.05) +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">FOV</div>' +
          toggleRow("aim", "fovcircle", "FOV Circle") +
          sliderRow("aim", "fovsize", "FOV Size", 20, 400, 5) +
        '</div>';
    } else if (activeTab === "Player") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Protection</div>' +
          toggleRow("exploit", "godMode", "God Mode (" + String(exploitConfig.toggleKey).toUpperCase() + ")") +
          toggleRow("exploit", "antiInfect", "Anti-Zombie Infect") +
        '</div>';
    } else if (activeTab === "Settings") {
      var mlStatus = (mlXY ? "XY " : "") + (mlX ? "X " : "") + (mlY ? "Y" : "");
      if (!mlStatus) mlStatus = localFpPtr ? "FP Fallback" : "Waiting...";
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Hotkeys</div>' +
          keyRow("esp", "menuKey", "Menu Key") +
          keyRow("aim", "toggleKey", "Aimbot Toggle Key") +
          keyRow("exploit", "toggleKey", "God Mode Toggle Key") +
          selectRow("esp", "toggleKey", "ESP Toggle Key", ["Insert", "Delete", "End", "Home", "F1", "F2", "F3"]) +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Config</div>' +
          '<div class="hm-row"><span class="hm-label">Save Settings</span><button class="hm-action-btn" id="hm-btn-save">Save</button></div>' +
          '<div class="hm-row"><span class="hm-label">Reset to Defaults</span><button class="hm-action-btn danger" id="hm-btn-reset">Reset</button></div>' +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Info</div>' +
          '<div class="hm-row"><span class="hm-label">Players Tracked</span><span class="hm-label" id="hm-player-count" style="color:rgba(255,255,255,0.4)">' + Object.keys(playerMap).length + '</span></div>' +
          '<div class="hm-row"><span class="hm-label">Aim Controller</span><span class="hm-label" id="hm-ml-status" style="color:rgba(255,255,255,0.4)">' + mlStatus + '</span></div>' +
          '<div class="hm-row"><span class="hm-label">God Mode</span><span class="hm-label" style="color:' + (exploitConfig.godMode ? '#52e078' : 'rgba(255,255,255,0.4)') + '">' + (exploitConfig.godMode ? 'ACTIVE' : 'OFF') + '</span></div>' +
        '</div>';
    }

    body.querySelectorAll(".hm-toggle input").forEach(function(input) {
      input.addEventListener("change", function() {
        cfgObj(input.dataset.cfg)[input.dataset.key] = input.checked;
        saveConfig();
      });
    });
    body.querySelectorAll(".hm-select").forEach(function(sel) {
      sel.addEventListener("change", function() {
        cfgObj(sel.dataset.cfg)[sel.dataset.key] = sel.value;
        saveConfig();
      });
    });
    body.querySelectorAll(".hm-slider").forEach(function(slider) {
      slider.addEventListener("input", function() {
        var val = parseFloat(slider.value);
        cfgObj(slider.dataset.cfg)[slider.dataset.key] = val;
        var valEl = slider.parentElement.querySelector(".hm-slider-val");
        if (valEl) valEl.textContent = fmtVal(val);
      });
      slider.addEventListener("change", function() { saveConfig(); });
    });
    body.querySelectorAll(".hm-color").forEach(function(input) {
      input.addEventListener("input", function() {
        cfgObj(input.dataset.cfg)[input.dataset.key] = input.value;
      });
      input.addEventListener("change", function() { saveConfig(); });
    });

    var btnSave = body.querySelector("#hm-btn-save");
    if (btnSave) btnSave.addEventListener("click", function() { saveConfig(); showToast("Config saved!"); renderPanel(); });
    var btnReset = body.querySelector("#hm-btn-reset");
    if (btnReset) btnReset.addEventListener("click", function() { if (confirm("Reset all settings to defaults?")) resetConfig(); });
    var tbSave = menuContainer.querySelector("#hm-save");
    if (tbSave) tbSave.onclick = function() { saveConfig(); showToast("Config saved!"); };
  }

  function toggleMenu() {
    if (!menuContainer) createMenu();
    if (!menuContainer) return;
    menuOpen = !menuOpen;
    menuContainer.classList.toggle("open", menuOpen);
    if (menuOpen) {
      if (document.pointerLockElement && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch(e) {}
      }
      renderPanel();
    }
  }

  // ============================================================
  // Canvas overlay
  // ============================================================
  function ensureCanvas() {
    if (canvas && canvas.parentElement) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999998;";
    document.body.appendChild(canvas);
    ctx2d = canvas.getContext("2d");
  }

  // ============================================================
  // Memory / Unity helpers — Buildnow.gg shapes + PW RVAs
  // ============================================================
  function getBuf(id, size) {
    if (!_reusableBufs[id]) _reusableBufs[id] = ctx.malloc(size);
    return _reusableBufs[id];
  }

  function normalizeAngle(angle) {
    angle %= 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
  }

  function readVector3(buf) {
    return {
      x: buf.readField(0x0, "f32").val(),
      y: buf.readField(0x4, "f32").val(),
      z: buf.readField(0x8, "f32").val()
    };
  }

  function writeVec3(buf, x, y, z) {
    buf.writeField(0x0, "f32", x);
    buf.writeField(0x4, "f32", y);
    buf.writeField(0x8, "f32", z);
  }

  // Transform.get_position(ret*=buffer-first, this)
  function getTransformPosBuf(transformPtr) {
    var posBuf = getBuf("tpos", 0x1C);
    posBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Transform", "get_position", [posBuf, transformPtr]);
    } catch(e) {
      return null;
    }
    var x = posBuf.readField(0x0, "f32").val();
    if (x !== x) return null; // NaN => call failed
    return posBuf;
  }

  function getTransformForward(transformPtr) {
    var fwdBuf = getBuf("tfwd", 0x1C);
    fwdBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Transform", "get_forward", [fwdBuf, transformPtr]);
    } catch(e) {
      return null;
    }
    var x = fwdBuf.readField(0x0, "f32").val();
    if (x !== x) return null;
    return readVector3(fwdBuf);
  }

  function getEulerAngles(transformPtr) {
    var eBuf = getBuf("teul", 0x1C);
    eBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Transform", "get_eulerAngles", [eBuf, transformPtr]);
    } catch(e) {
      return null;
    }
    var x = eBuf.readField(0x0, "f32").val();
    if (x !== x) return null;
    return readVector3(eBuf);
  }

  function setEulerAngles(transformPtr, x, y, z) {
    var eBuf = getBuf("seul", 0x1C);
    writeVec3(eBuf, x, y, z);
    ctx.call("UnityEngine.Transform", "set_eulerAngles", [transformPtr, eBuf]);
  }

  function getLocalEulerAngles(transformPtr) {
    var eBuf = getBuf("tleul", 0x1C);
    eBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Transform", "get_localEulerAngles", [eBuf, transformPtr]);
    } catch(e) {
      return null;
    }
    var x = eBuf.readField(0x0, "f32").val();
    if (x !== x) return null;
    return readVector3(eBuf);
  }

  function setLocalEulerAngles(transformPtr, x, y, z) {
    var eBuf = getBuf("sleul", 0x1C);
    writeVec3(eBuf, x, y, z);
    ctx.call("UnityEngine.Transform", "set_localEulerAngles", [transformPtr, eBuf]);
  }

  // ============================================================
  // WorldToScreenPoint — BY ADDRESS (dump.cs RVA 0x16AEC = 92908)
  // ============================================================
  function worldToScreen(posBuf, camPtr) {
    var scrBuf = getBuf("w2s", 0x1C);
    scrBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Camera", "WorldToScreenPoint_92908", [scrBuf, camPtr, posBuf]);
      var sx = scrBuf.readField(0x0, "f32").val();
      if (sx !== sx) return null;
      var sy = scrBuf.readField(0x4, "f32").val();
      var z = scrBuf.readField(0x8, "f32").val();
      return { x: sx, y: canvas.height - sy, z: z };
    } catch(e) {
      return null;
    }
  }

  // ============================================================
  // Visibility check — Buildnow.gg pattern adapted to Pixel Warfare RVAs
  //
  // dump.cs (UnityEngine.Physics):
  //   0x18619 (99865) Raycast(Vector3 origin, Vector3 direction, out RaycastHit hitInfo,
  //                           float maxDistance, int layerMask, QueryTriggerInteraction qti)
  //   0x1861A (99866) Raycast(Vector3 origin, Vector3 direction, out RaycastHit hitInfo,
  //                           float maxDistance, int layerMask)
  //
  // Starts 0.5m along the look ray to clear our own capsule collider and uses
  // QueryTriggerInteraction.Ignore (1) so map triggers never block line-of-sight.
  // ============================================================
  var _raycastMethod = "Raycast_99865";
  var _visLogCount = 0;

  function isPlayerVisible(targetGcPtr, targetWorldPos, camPos) {
    try {
      if (!camPos || !targetWorldPos || !targetGcPtr || targetGcPtr.val() === 0) return true;

      var dx = targetWorldPos.x - camPos.x;
      var dy = targetWorldPos.y - camPos.y;
      var dz = targetWorldPos.z - camPos.z;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.75) return true;

      var inv = 1 / dist;
      var nx = dx * inv, ny = dy * inv, nz = dz * inv;

      var origBuf = getBuf("vis_orig", 0x1C);
      writeVec3(origBuf, camPos.x + nx * 0.5, camPos.y + ny * 0.5, camPos.z + nz * 0.5);

      var dirBuf = getBuf("vis_dir", 0x1C);
      writeVec3(dirBuf, nx, ny, nz);

      var hitBoxed = getBuf("vis_hit", 0x58);
      var hitInfo = new UnityWebModkit.ValueWrapper(hitBoxed.val() + 0x8);
      hitInfo.writeField(0x1C, "f32", -1);
      hitInfo.writeField(0x28, "i32", 0);

      var checkDist = dist - 0.55;
      var layerMask = -5; // ~4: all layers except built-in Ignore Raycast (layer 2)

      var hit = null;
      if (_raycastMethod === "Raycast_99865") {
        try {
          hit = ctx.call("UnityEngine.Physics", "Raycast_99865", [origBuf, dirBuf, hitInfo, checkDist, layerMask, 1]);
        } catch(e1) {
          _raycastMethod = "Raycast_99866";
        }
      }
      if (_raycastMethod === "Raycast_99866") {
        hit = ctx.call("UnityEngine.Physics", "Raycast_99866", [origBuf, dirBuf, hitInfo, checkDist, layerMask]);
      }

      // Nothing obstructed the ray between camera and target head => visible
      if (!hit || hit.val() === 0) return true;

      // Resolve hit Collider via RaycastHit.m_Collider (@0x28 instanceID) ->
      // static UnityEngine.Object.FindObjectFromInstanceID (avoids struct-this
      // adjustor-thunk boxing), with boxed get_collider and m_Distance fallbacks.
      var colliderPtr = null;
      var colInstId = hitInfo.readField(0x28, "i32").val();
      if (colInstId !== 0) {
        try {
          colliderPtr = ctx.call("UnityEngine.Object", "FindObjectFromInstanceID", [colInstId]);
        } catch(eFind) {
          try {
            colliderPtr = ctx.call("UnityEngine.RaycastHit", "get_collider", [hitBoxed]);
          } catch(eCol) {}
        }
      }

      if (!colliderPtr || colliderPtr.val() === 0) {
        var hitDist = hitInfo.readField(0x1C, "f32").val();
        return hitDist >= 0 && hitDist >= checkDist - 0.45;
      }

      var colTr = ctx.call("UnityEngine.Component", "get_transform", [colliderPtr]);
      if (!colTr || colTr.val() === 0) return false;
      var colRoot = ctx.call("UnityEngine.Transform", "get_root", [colTr]);
      if (!colRoot || colRoot.val() === 0) return false;

      // Ignore accidental self-hit on local player root
      if (localRootTr && localRootTr.val() !== 0 && colRoot.val() === localRootTr.val()) return true;

      var targetTr = ctx.call("UnityEngine.Component", "get_transform", [targetGcPtr]);
      if (!targetTr || targetTr.val() === 0) return false;
      var targetRoot = ctx.call("UnityEngine.Transform", "get_root", [targetTr]);
      if (!targetRoot || targetRoot.val() === 0) return false;

      return colRoot.val() === targetRoot.val();
    } catch(e) {
      if (_visLogCount < 3) {
        _visLogCount++;
        console.log("[PW VIS] Exception: " + (e && e.message ? e.message : e));
      }
      return true;
    }
  }

  // ============================================================
  // Team / Zombie check (dump.cs: gc.iszomby @0x3C, gc.rmm @0x138 ->
  // iu.MyPlayerTeam @0x200 / iu.gameMode @0x374, gd.playerTeam @0xC8)
  // ============================================================
  function isTeammate(targetGcPtr) {
    try {
      if (!localGcPtr || localGcPtr.val() === 0 || !targetGcPtr || targetGcPtr.val() === 0) return false;

      var myZom = (localGcPtr.readField(0x3C, "i32").val() & 0xff) !== 0;
      var thZom = (targetGcPtr.readField(0x3C, "i32").val() & 0xff) !== 0;
      if (myZom !== thZom) return false; // zombie vs human => enemies
      if (myZom && thZom) return true;   // both zombies => same side

      var rmmW = localGcPtr.readField(0x138, "i32");
      var modeStr = "";
      var myTeam = "";
      if (rmmW && rmmW.val() !== 0) {
        try {
          var gmPtr = rmmW.readField(0x374, "i32");
          if (gmPtr && gmPtr.val() !== 0) modeStr = (gmPtr.mstr() || "").toUpperCase();
        } catch(e1) {}
        if (modeStr.indexOf("FFA") !== -1 || (modeStr.indexOf("DM") !== -1 && modeStr.indexOf("TDM") === -1 && modeStr.indexOf("TEAM") === -1)) {
          return false;
        }
        try {
          var mtPtr = rmmW.readField(0x200, "i32");
          if (mtPtr && mtPtr.val() !== 0) myTeam = mtPtr.mstr() || "";
        } catch(e2) {}
      }

      if (!myTeam && teamCache[localGcPtr.val()]) myTeam = teamCache[localGcPtr.val()].team;
      var thEntry = teamCache[targetGcPtr.val()];
      var thTeam = thEntry ? thEntry.team : "";
      if (!myTeam || !thTeam || myTeam === "0" || myTeam.toLowerCase() === "none") return false;
      return myTeam === thTeam;
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // EXACT box height + Head collider center (gc.hitBoxes @0xE8)
  // ============================================================
  function getHitboxSpan(gcPtr, py, px, pz) {
    var top = -Infinity, bottom = Infinity, any = false;
    var hbDone = false, ehtUsed = false, ehbUsed = false;
    var headX = px, headY = py, headZ = pz, hasHead = false;

    // 1) Real shootable hitboxes: gc.hitBoxes -> Collider.get_bounds
    try {
      var listW = gcPtr.readField(0xE8, "i32");
      if (listW && listW.val() !== 0) {
        var itemsW = listW.readField(0x8, "i32");
        if (itemsW && itemsW.val() !== 0) {
          var count = itemsW.readField(0xC, "i32").val();
          if (count > 0 && count <= 32) {
            var buf = getBuf("hb", 0x18);
            for (var i = 0; i < count; i++) {
              var hbW = itemsW.readField(0x10 + 4 * i, "i32");
              if (!hbW || hbW.val() === 0) continue;
              var colW = hbW.readField(0x8, "i32"); // gc.HitBoxes.box (Collider)
              if (!colW || colW.val() === 0) continue;
              ctx.call("UnityEngine.Collider", "get_bounds", [buf, colW]);
              var cx = buf.readField(0x0, "f32").val();
              var cy = buf.readField(0x4, "f32").val();
              var cz = buf.readField(0x8, "f32").val();
              var ey = buf.readField(0x10, "f32").val();
              if (cx !== cx || cy !== cy || cz !== cz || ey !== ey) continue;
              var dx = cx - px, dz = cz - pz;
              if (cy < py - 1.0 || cy > py + 2.6) continue;
              if (dx * dx + dz * dz > 2.25) continue;
              var t = cy + ey, b = cy - ey;
              if (isFinite(t) && isFinite(b)) {
                any = true; hbDone = true;
                if (t > top) {
                  top = t;
                  headX = cx; headY = cy; headZ = cz; hasHead = true;
                }
                if (b < bottom) bottom = b;
              }
            }
          }
        }
      }
    } catch(e) {}

    // 2) ExplosionHitTop (gc @0x2C) / ExplosionHitBottom (gc @0x34)
    try {
      var ehtW = gcPtr.readField(0x2C, "i32");
      if (ehtW && ehtW.val() !== 0) {
        var ep = getTransformPosBuf(ehtW);
        if (ep) {
          var ehX = ep.readField(0x0, "f32").val();
          var ehY = ep.readField(0x4, "f32").val();
          var ehZ = ep.readField(0x8, "f32").val();
          if (isFinite(ehY) && ehY >= py && ehY <= py + 2.6) {
            var et = ehY + 0.1;
            if (!hasHead) { headX = ehX; headY = ehY; headZ = ehZ; hasHead = true; }
            if (et > top) { top = et; any = true; ehtUsed = true; }
          }
        }
      }
    } catch(e) {}

    try {
      var ehbW = gcPtr.readField(0x34, "i32");
      if (ehbW && ehbW.val() !== 0) {
        var ehp = getTransformPosBuf(ehbW);
        if (ehp) {
          var ebY = ehp.readField(0x4, "f32").val();
          if (isFinite(ebY) && ebY >= py - 1.0 && ebY <= py + 1.0) {
            if (ebY < bottom) { bottom = ebY; any = true; ehbUsed = true; }
          }
        }
      }
    } catch(e) {}

    return any ? {
      top: top, bottom: bottom,
      headX: headX, headY: headY, headZ: headZ, hasHead: hasHead,
      hb: hbDone, eht: ehtUsed, ehb: ehbUsed
    } : null;
  }

  function drawCornerBox(x1, y1, x2, y2, color, thickness, widthFactor) {
    var h = y2 - y1;
    var w = h * (widthFactor || 0.6);
    var x = x1 - w / 2;
    var y = y1;
    var cl = w / 4;
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = thickness;
    ctx2d.beginPath(); ctx2d.moveTo(x, y); ctx2d.lineTo(x, y + cl); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x, y); ctx2d.lineTo(x + cl, y); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x + w, y); ctx2d.lineTo(x + w - cl, y); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x + w, y); ctx2d.lineTo(x + w, y + cl); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x, y + h); ctx2d.lineTo(x, y + h - cl); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x, y + h); ctx2d.lineTo(x + cl, y + h); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x + w, y + h); ctx2d.lineTo(x + w - cl, y + h); ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.moveTo(x + w, y + h); ctx2d.lineTo(x + w, y + h - cl); ctx2d.stroke();
  }

  // ============================================================
  // Skeleton ESP — Poxel BONE_LINKS + cached Transform pattern
  // adapted strictly to Pixel Warfare's gc rig in dump.cs:
  //   Tier 1: gc.DeadBody*Pos Transform fields (@0x40..0x68)
  //   Tier 2: gc.hitBoxes (@0xE8) Collider Transform hierarchy
  // ============================================================
  var PW_BONE_OFFSETS = [
    0x40, // 0: DeadBodyHeadPos       (Head)
    0x44, // 1: DeadBodyTopPos        (Spine2 / Upper Chest)
    0x48, // 2: DeadBodyBottomPos     (Spine1 / Pelvis)
    0x4C, // 3: DeadBodyLLegTopPos    (Left Hip)
    0x50, // 4: DeadBodyLLegBottomPos (Left Foot / Shin)
    0x54, // 5: DeadBodyRLegTopPos    (Right Hip)
    0x58, // 6: DeadBodyRLegBottomPos (Right Foot / Shin)
    0x5C, // 7: DeadBodyLArmTopPos    (Left Shoulder)
    0x60, // 8: DeadBodyLArmBottomPos (Left Hand / Forearm)
    0x64, // 9: DeadBodyRArmTopPos    (Right Shoulder)
    0x68  // 10: DeadBodyRArmBottomPos (Right Hand / Forearm)
  ];

  // Exact 10-link Poxel humanoid skeleton topology
  var PW_BONE_LINKS = [
    [2, 1],  // Spine1 -> Spine2
    [1, 0],  // Spine2 -> Head
    [1, 9],  // Spine2 -> RightShoulder
    [9, 10], // RightShoulder -> RightHand
    [1, 7],  // Spine2 -> LeftShoulder
    [7, 8],  // LeftShoulder -> LeftHand
    [2, 5],  // Spine1 -> RightHip
    [5, 6],  // RightHip -> RightFoot
    [2, 3],  // Spine1 -> LeftHip
    [3, 4]   // LeftHip -> LeftFoot
  ];

  var _skelDebugOnce = false;

  function readBonePosInBand(trW, px, py, pz) {
    if (!trW || trW.val() === 0) return null;
    var pb = getTransformPosBuf(trW);
    if (!pb) return null;
    var bx = pb.readField(0x0, "f32").val();
    var by = pb.readField(0x4, "f32").val();
    var bz = pb.readField(0x8, "f32").val();
    if (!isFinite(bx) || !isFinite(by) || !isFinite(bz)) return null;
    if (Math.abs(bx - px) > 2.0 || Math.abs(bz - pz) > 2.0) return null;
    if (by < py - 1.0 || by > py + 2.8) return null;
    return { x: bx, y: by, z: bz };
  }

  function resolveSkeleton(gcPtr, rootTrPtr, px, py, pz) {
    var gcRaw = gcPtr.val();
    var now = Date.now();
    var cached = skelCache[gcRaw];
    // Poxel caching pattern: 3000ms TTL when valid, 1000ms retry when empty
    if (cached) {
      var ttl = cached.links.length > 0 ? 3000 : 1000;
      if ((now - cached.ts) < ttl) return cached;
    }

    var rootAddr = (rootTrPtr && rootTrPtr.val) ? rootTrPtr.val() : 0;

    // --- Tier 1: Direct gc.DeadBody*Pos Transform fields (@0x40..0x68) ---
    try {
      var slots = new Array(11);
      var slotPos = new Array(11);
      var altOffsets = { 0: 0x2C, 1: 0x30, 2: 0x34 }; // ExplosionHitTop/Middle/Bottom fallbacks
      for (var s = 0; s < 11; s++) {
        var tw = gcPtr.readField(PW_BONE_OFFSETS[s], "i32");
        var tp = readBonePosInBand(tw, px, py, pz);
        if (!tp && (s in altOffsets)) {
          tw = gcPtr.readField(altOffsets[s], "i32");
          tp = readBonePosInBand(tw, px, py, pz);
        }
        if (tp) {
          slots[s] = tw;
          slotPos[s] = tp;
        } else {
          slots[s] = null;
          slotPos[s] = null;
        }
      }

      // If Pelvis (2) is missing on a skin but Upper Chest (1) exists, anchor hips to (1)
      var nodes = [];
      var slotToNode = {};
      var addrSeen = {};
      for (var s2 = 0; s2 < 11; s2++) {
        if (!slots[s2]) continue;
        var addr = slots[s2].val();
        if (addr in addrSeen) {
          slotToNode[s2] = addrSeen[addr];
        } else {
          var idx = nodes.length;
          nodes.push({ tr: slots[s2], col: null });
          addrSeen[addr] = idx;
          slotToNode[s2] = idx;
        }
      }

      if (nodes.length >= 5) {
        var links = [];
        var linkSeen = {};
        function addTier1Link(aSlot, bSlot) {
          if (!(aSlot in slotToNode) || !(bSlot in slotToNode)) return;
          var ia = slotToNode[aSlot], ib = slotToNode[bSlot];
          if (ia === ib) return;
          var pa = slotPos[aSlot], pb2 = slotPos[bSlot];
          var ddx = pa.x - pb2.x, ddy = pa.y - pb2.y, ddz = pa.z - pb2.z;
          var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < 0.0009 || d2 > 2.89) return; // 0.03m .. 1.7m sanity
          var key = ia < ib ? (ia + ":" + ib) : (ib + ":" + ia);
          if (linkSeen[key]) return;
          linkSeen[key] = true;
          links.push([ia, ib]);
        }

        for (var li = 0; li < PW_BONE_LINKS.length; li++) {
          var u = PW_BONE_LINKS[li][0], v = PW_BONE_LINKS[li][1];
          if (u === 2 && !(2 in slotToNode) && (1 in slotToNode) && v !== 1) u = 1;
          addTier1Link(u, v);
        }

        // Extend distal limb bones (4, 6, 8, 10) to GetChild(0) if rig uses 2-bone+tip chains
        var distalSlots = [4, 6, 8, 10];
        for (var di = 0; di < distalSlots.length; di++) {
          var ds = distalSlots[di];
          if (!(ds in slotToNode)) continue;
          try {
            var dTr = slots[ds];
            var cc = ctx.call("UnityEngine.Transform", "get_childCount", [dTr]);
            if (cc && cc.val() > 0) {
              var chTr = ctx.call("UnityEngine.Transform", "GetChild", [dTr, 0]);
              if (chTr && chTr.val() !== 0 && !(chTr.val() in addrSeen)) {
                var cp = readBonePosInBand(chTr, px, py, pz);
                if (cp) {
                  var dp = slotPos[ds];
                  var cdx = cp.x - dp.x, cdy = cp.y - dp.y, cdz = cp.z - dp.z;
                  var cd = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);
                  if (cd >= 0.12 && cd <= 0.60) {
                    var cIdx = nodes.length;
                    nodes.push({ tr: chTr, col: null });
                    addrSeen[chTr.val()] = cIdx;
                    links.push([slotToNode[ds], cIdx]);
                  }
                }
              }
            }
          } catch(eChild) {}
        }

        if (links.length >= 4) {
          if (espConfig.debug && !_skelDebugOnce) {
            _skelDebugOnce = true;
            console.log("[PW ESP] Skeleton resolved via Tier 1 (DeadBody*Pos): nodes=" + nodes.length + ", links=" + links.length);
          }
          skelCache[gcRaw] = { nodes: nodes, links: links, ts: now };
          return skelCache[gcRaw];
        }
      }
    } catch(e1) {}

    // --- Tier 2 Fallback: gc.hitBoxes (@0xE8) Collider Transform hierarchy ---
    try {
      var listW = gcPtr.readField(0xE8, "i32");
      if (listW && listW.val() !== 0) {
        var itemsW = listW.readField(0x8, "i32");
        var listSize = listW.readField(0xC, "i32").val();
        if (itemsW && itemsW.val() !== 0 && listSize > 0) {
          var cap = itemsW.readField(0xC, "i32").val();
          var count = Math.min(listSize, cap, 32);
          var t2Nodes = [];
          var t2Map = {};
          var t2Links = [];
          var t2EdgeSeen = {};

          function ensureNode(trW, colW) {
            var a = trW.val();
            if (a in t2Map) {
              var existing = t2Nodes[t2Map[a]];
              if (colW && !existing.col) existing.col = colW;
              return t2Map[a];
            }
            var ni = t2Nodes.length;
            t2Nodes.push({ tr: trW, col: colW || null });
            t2Map[a] = ni;
            return ni;
          }

          function addT2Edge(ia, ib) {
            if (ia === ib) return;
            var k = ia < ib ? (ia + ":" + ib) : (ib + ":" + ia);
            if (t2EdgeSeen[k]) return;
            t2EdgeSeen[k] = true;
            t2Links.push([ia, ib]);
          }

          var leafIndices = [];
          var hasChildFlag = {};

          for (var i = 0; i < count; i++) {
            var hbW = itemsW.readField(0x10 + 4 * i, "i32");
            if (!hbW || hbW.val() === 0) continue;
            var colW = hbW.readField(0x8, "i32");
            if (!colW || colW.val() === 0) continue;
            var bTr = ctx.call("UnityEngine.Component", "get_transform", [colW]);
            if (!bTr || bTr.val() === 0 || bTr.val() === rootAddr) continue;
            if (!readBonePosInBand(bTr, px, py, pz)) continue;

            var curIdx = ensureNode(bTr, colW);
            leafIndices.push(curIdx);

            // Walk Transform.get_parent up to rootTrPtr to connect limbs through spine/pelvis
            var curTr = bTr;
            var curNodeIdx = curIdx;
            for (var hop = 0; hop < 4; hop++) {
              var parTr = ctx.call("UnityEngine.Transform", "get_parent", [curTr]);
              if (!parTr || parTr.val() === 0 || parTr.val() === rootAddr) break;
              var parPos = readBonePosInBand(parTr, px, py, pz);
              if (!parPos) break;
              // Skip container transforms parked right on the root origin (feet) unless near pelvis
              if (Math.abs(parPos.y - py) < 0.08 && hop >= 1) break;
              var parIdx = ensureNode(parTr, null);
              addT2Edge(parIdx, curNodeIdx);
              hasChildFlag[parIdx] = true;
              curTr = parTr;
              curNodeIdx = parIdx;
            }
          }

          // Extend leaf hitbox bones to GetChild(0) if present, else mark offset-collider tip
          for (var li2 = 0; li2 < leafIndices.length; li2++) {
            var lIdx = leafIndices[li2];
            if (hasChildFlag[lIdx]) continue;
            var lNode = t2Nodes[lIdx];
            var extended = false;
            try {
              var lcc = ctx.call("UnityEngine.Transform", "get_childCount", [lNode.tr]);
              if (lcc && lcc.val() > 0) {
                var lch = ctx.call("UnityEngine.Transform", "GetChild", [lNode.tr, 0]);
                if (lch && lch.val() !== 0 && !(lch.val() in t2Map)) {
                  var lcp = readBonePosInBand(lch, px, py, pz);
                  var lpp = readBonePosInBand(lNode.tr, px, py, pz);
                  if (lcp && lpp) {
                    var ldx = lcp.x - lpp.x, ldy = lcp.y - lpp.y, ldz = lcp.z - lpp.z;
                    var ld = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz);
                    if (ld >= 0.12 && ld <= 0.65) {
                      var chIdx = ensureNode(lch, null);
                      addT2Edge(lIdx, chIdx);
                      extended = true;
                    }
                  }
                }
              }
            } catch(eLeaf) {}

            // Blocky limb collider whose pivot is at shoulder/hip and BoxCollider extends to hand/foot
            if (!extended && lNode.col) {
              lNode.useColTip = true;
            }
          }

          if (t2Links.length >= 2) {
            if (espConfig.debug && !_skelDebugOnce) {
              _skelDebugOnce = true;
              console.log("[PW ESP] Skeleton resolved via Tier 2 (hitBoxes): nodes=" + t2Nodes.length + ", links=" + t2Links.length);
            }
            skelCache[gcRaw] = { nodes: t2Nodes, links: t2Links, ts: now };
            return skelCache[gcRaw];
          }
        }
      }
    } catch(e2) {}

    skelCache[gcRaw] = { nodes: [], links: [], ts: now };
    return skelCache[gcRaw];
  }

  function drawSkeleton(gcPtr, rootTrPtr, px, py, pz, camPtr, color, thickness) {
    var gcRaw = gcPtr.val();
    var skel = resolveSkeleton(gcPtr, rootTrPtr, px, py, pz);
    if (!skel || !skel.links || skel.links.length === 0) return;

    var nLen = skel.nodes.length;
    var proj = new Array(nLen);
    var wBuf = getBuf("skel_w", 0x1C);
    var colBuf = null;

    for (var i = 0; i < nLen; i++) {
      var node = skel.nodes[i];
      if (!node.tr || node.tr.val() === 0) { delete skelCache[gcRaw]; return; }
      var pb = getTransformPosBuf(node.tr);
      // Poxel safety: NaN sentinel indicates destroyed Transform -> drop cache immediately
      if (!pb) { delete skelCache[gcRaw]; return; }
      var bx = pb.readField(0x0, "f32").val();
      var by = pb.readField(0x4, "f32").val();
      var bz = pb.readField(0x8, "f32").val();
      if (!isFinite(bx) || !isFinite(by) || !isFinite(bz) ||
          Math.abs(bx - px) > 2.0 || Math.abs(bz - pz) > 2.0 ||
          by < py - 1.0 || by > py + 2.8) {
        proj[i] = null;
        continue;
      }
      writeVec3(wBuf, bx, by, bz);
      var sc = worldToScreen(wBuf, camPtr);
      proj[i] = (sc && sc.z >= 0.05) ? { sx: sc.x, sy: sc.y, wx: bx, wy: by, wz: bz, node: node } : null;
    }

    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = thickness;
    ctx2d.lineCap = "round";
    ctx2d.beginPath();
    var anySeg = false;

    for (var k = 0; k < skel.links.length; k++) {
      var pa = proj[skel.links[k][0]];
      var pb2 = proj[skel.links[k][1]];
      if (!pa || !pb2) continue;
      ctx2d.moveTo(pa.sx, pa.sy);
      ctx2d.lineTo(pb2.sx, pb2.sy);
      anySeg = true;
    }

    // Optional blocky-limb collider tip extensions in Tier 2
    for (var m = 0; m < nLen; m++) {
      var pm = proj[m];
      if (!pm || !pm.node.useColTip || !pm.node.col) continue;
      try {
        if (!colBuf) colBuf = getBuf("skel_cb", 0x18);
        colBuf.writeField(0x0, "f32", NaN);
        ctx.call("UnityEngine.Collider", "get_bounds", [colBuf, pm.node.col]);
        var cx = colBuf.readField(0x0, "f32").val();
        if (cx !== cx) continue;
        var cy = colBuf.readField(0x4, "f32").val();
        var cz = colBuf.readField(0x8, "f32").val();
        var ox = cx - pm.wx, oy = cy - pm.wy, oz = cz - pm.wz;
        var od = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (od >= 0.10 && od <= 0.48) {
          writeVec3(wBuf, pm.wx + ox * 2, pm.wy + oy * 2, pm.wz + oz * 2);
          var tipSc = worldToScreen(wBuf, camPtr);
          if (tipSc && tipSc.z >= 0.05) {
            ctx2d.moveTo(pm.sx, pm.sy);
            ctx2d.lineTo(tipSc.x, tipSc.y);
            anySeg = true;
          }
        }
      } catch(eTip) {}
    }

    if (anySeg) ctx2d.stroke();
    ctx2d.lineCap = "butt";
  }

  // ============================================================
  // Apply Aimlock — Buildnow.gg camera-angle math mapped onto
  // Pixel Warfare's FPScontroller + fr/fs MouseLook architecture
  // ============================================================
  function readClampBounds(mlComp) {
    var minY = -85, maxY = 85;
    try {
      var mn = mlComp.readField(0x24, "f32").val();
      var mx = mlComp.readField(0x28, "f32").val();
      if (isFinite(mn) && isFinite(mx) && mn < mx && mn >= -90 && mx <= 90 && (mx - mn) > 10) {
        minY = mn;
        maxY = mx;
      }
    } catch(e) {}
    return { minY: minY, maxY: maxY };
  }

  function resolveYawTransform() {
    var now = Date.now();
    if (mlX && mlX.val() !== 0 && (now - mlXStamp) < 1500) {
      try {
        var t1 = ctx.call("UnityEngine.Component", "get_transform", [mlX]);
        if (t1 && t1.val() !== 0) return t1;
      } catch(e) {}
    }
    if (localFpPtr && localFpPtr.val() !== 0) {
      try {
        var fpTr = localFpPtr.readField(0xCC, "i32"); // fp.jzx cached Transform
        if (fpTr && fpTr.val() !== 0) return fpTr;
        var t2 = ctx.call("UnityEngine.Component", "get_transform", [localFpPtr]);
        if (t2 && t2.val() !== 0) return t2;
      } catch(e2) {}
    }
    if (localGcPtr && localGcPtr.val() !== 0) {
      try {
        var t3 = ctx.call("UnityEngine.Component", "get_transform", [localGcPtr]);
        if (t3 && t3.val() !== 0) return t3;
      } catch(e3) {}
    }
    return null;
  }

  function resolvePitchTransform(camTr) {
    var now = Date.now();
    if (mlY && mlY.val() !== 0 && (now - mlYStamp) < 1500) {
      try {
        var t1 = ctx.call("UnityEngine.Component", "get_transform", [mlY]);
        if (t1 && t1.val() !== 0) return t1;
      } catch(e) {}
    }
    if (localFpPtr && localFpPtr.val() !== 0) {
      try {
        var lookGo = localFpPtr.readField(0x60, "i32"); // fp.lookObj (GameObject)
        if (lookGo && lookGo.val() !== 0) {
          var t2 = ctx.call("UnityEngine.GameObject", "get_transform", [lookGo]);
          if (t2 && t2.val() !== 0) return t2;
        }
      } catch(e2) {}
    }
    return camTr;
  }

  function applyAimlock(bestTargetVec, camPos, camTr) {
    if (!bestTargetVec || !camPos || !camTr || camTr.val() === 0) return;

    var dx = bestTargetVec.x - camPos.x;
    var dy = bestTargetVec.y - camPos.y;
    var dz = bestTargetVec.z - camPos.z;
    var horizDist = Math.sqrt(dx * dx + dz * dz);
    if (horizDist < 0.001 && Math.abs(dy) < 0.001) return;

    // Target world yaw [-180, 180] and elevation pitch [-86, 86] (+ = looking UP)
    var targetYaw = normalizeAngle(Math.atan2(dx, dz) * (180 / Math.PI));
    var targetPitch = Math.max(-86, Math.min(86, Math.atan2(dy, horizDist) * (180 / Math.PI)));
    var speed = aimConfig.aimSpeed;

    // Measure angular error relative to the camera's live forward vector so any
    // parent transform offset or weapon recoil kick is automatically compensated.
    var stepYaw, stepPitch;
    var camFwd = getTransformForward(camTr);
    if (camFwd) {
      var curCamYaw = normalizeAngle(Math.atan2(camFwd.x, camFwd.z) * (180 / Math.PI));
      var curCamPitch = Math.atan2(camFwd.y, Math.sqrt(camFwd.x * camFwd.x + camFwd.z * camFwd.z)) * (180 / Math.PI);
      var dYaw = normalizeAngle(targetYaw - curCamYaw);
      var dPitch = targetPitch - curCamPitch;
      stepYaw = speed >= 1 ? dYaw : dYaw * speed;
      stepPitch = speed >= 1 ? dPitch : dPitch * speed;
    } else {
      stepYaw = null;
      stepPitch = null;
    }

    var now = Date.now();

    // Case 1: Single MouseXAndY (axes == 0) component active
    if (mlXY && mlXY.val() !== 0 && (now - mlXYStamp) < 1500) {
      try {
        var trXY = ctx.call("UnityEngine.Component", "get_transform", [mlXY]);
        if (trXY && trXY.val() !== 0) {
          var boundsXY = readClampBounds(mlXY);
          var rawKamXY = mlXY.readField(0x2C, "f32").val();
          var curPitchXY = pitchSign * rawKamXY;
          var nextPitchXY = stepPitch !== null
            ? curPitchXY + stepPitch
            : (speed >= 1 ? targetPitch : curPitchXY + (targetPitch - curPitchXY) * speed);
          var newKamXY = Math.max(boundsXY.minY, Math.min(boundsXY.maxY, pitchSign * nextPitchXY));
          mlXY.writeField(0x2C, "f32", newKamXY);

          var leXY = getLocalEulerAngles(trXY);
          var wEulerXY = getEulerAngles(trXY);
          if (leXY && wEulerXY) {
            var curWorldYaw = normalizeAngle(wEulerXY.y);
            var yawDelta = stepYaw !== null
              ? stepYaw
              : (speed >= 1 ? normalizeAngle(targetYaw - curWorldYaw) : normalizeAngle(targetYaw - curWorldYaw) * speed);
            setLocalEulerAngles(trXY, -pitchSign * newKamXY, leXY.y + yawDelta, 0);
            return;
          }
        }
      } catch(e) {}
    }

    // Case 2: Standard FPS Kit split setup — Yaw on Player Root Transform, Pitch on mlY (@0x2C) + lookObj
    var yawTr = resolveYawTransform();
    if (yawTr && yawTr.val() !== 0) {
      try {
        var rootEuler = getEulerAngles(yawTr);
        if (rootEuler) {
          var curRootYaw = normalizeAngle(rootEuler.y);
          var newRootYaw = stepYaw !== null
            ? curRootYaw + stepYaw
            : (speed >= 1 ? targetYaw : curRootYaw + normalizeAngle(targetYaw - curRootYaw) * speed);
          setEulerAngles(yawTr, 0, newRootYaw, 0);
        }
      } catch(eY) {}
    }

    if (mlY && mlY.val() !== 0 && (now - mlYStamp) < 1500) {
      try {
        var boundsY = readClampBounds(mlY);
        var rawKam = mlY.readField(0x2C, "f32").val();
        var curMlPitch = pitchSign * rawKam;
        var nextPitch = stepPitch !== null
          ? curMlPitch + stepPitch
          : (speed >= 1 ? targetPitch : curMlPitch + (targetPitch - curMlPitch) * speed);
        var newKam = Math.max(boundsY.minY, Math.min(boundsY.maxY, pitchSign * nextPitch));

        // Write pitch accumulator @0x2C (kam in fr / kar in fs) AND sync Transform immediately
        mlY.writeField(0x2C, "f32", newKam);

        var pTr = resolvePitchTransform(camTr);
        if (pTr && pTr.val() !== 0) {
          var leP = getLocalEulerAngles(pTr);
          setLocalEulerAngles(pTr, -pitchSign * newKam, leP ? leP.y : 0, 0);
        }
        return;
      } catch(eP) {}
    }

    // Fallback when mlY hasn't fired yet: write localEulerAngles on lookObj / camera Transform
    var fallbackPitchTr = resolvePitchTransform(camTr);
    if (fallbackPitchTr && fallbackPitchTr.val() !== 0) {
      try {
        var leFb = getLocalEulerAngles(fallbackPitchTr);
        if (leFb) {
          var curLocalX = normalizeAngle(leFb.x);
          var nextLocalX = stepPitch !== null
            ? Math.max(-85, Math.min(85, curLocalX - stepPitch))
            : Math.max(-85, Math.min(85, speed >= 1 ? -targetPitch : curLocalX + ((-targetPitch) - curLocalX) * speed));
          setLocalEulerAngles(fallbackPitchTr, nextLocalX, leFb.y, 0);
        }
      } catch(eF) {}
    }
  }

  // ============================================================
  // INIT — Buildnow.gg init shape
  // ============================================================
  async function init() {
    while (!window.UnityWebModkit) await new Promise(function(r) { setTimeout(r, 50); });
    console.log("[PW ESP] UnityWebModkit loaded");

    var pluginCtx = UnityWebModkit.Runtime.createPlugin({
      name: "PW_ESP",
      version: "2.0.0",
      referencedAssemblies: [
        "Assembly-CSharp.dll",
        "UnityEngine.CoreModule.dll",
        "UnityEngine.PhysicsModule.dll",
        "PhotonUnityNetworking.dll",
        "PhotonRealtime.dll",
        "mscorlib.dll"
      ]
    });
    ctx = pluginCtx;
    window.ctx = ctx;

    var unityGame = window.unityGameInstance || window.unityInstance;
    try {
      if (unityGame) window.unityInstance = unityGame;
      else if (typeof game !== "undefined") window.unityInstance = game;
    } catch(e) {}
    if (unityGame && unityGame.Module && unityGame.Module._malloc) {
      UnityWebModkit.Runtime.malloc = function(size) { return unityGame.Module._malloc(size); };
      ctx.malloc = function(size) { return new UnityWebModkit.ValueWrapper(unityGame.Module._malloc(size)); };
    }

    // ============================================================
    // Local ownership helpers (used by God Mode + Aimbot hooks)
    // ============================================================
    function isLocalGc(gcPtr) {
      if (!gcPtr || gcPtr.val() === 0) return false;
      if (localGcPtr && localGcPtr.val() !== 0) {
        return gcPtr.val() === localGcPtr.val();
      }
      try {
        var pv = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [gcPtr]);
        if (pv && pv.val() !== 0 && ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pv]).val() === 1) {
          localGcPtr = gcPtr;
          return true;
        }
      } catch(e) {}
      return false;
    }

    function isLocalGd(gdPtr) {
      if (!gdPtr || gdPtr.val() === 0) return false;
      try {
        if ((gdPtr.readField(0xC0, "i32").val() & 0xff) !== 0) return true; // gd.playerIsOurs @0xC0
        var gcW = gdPtr.readField(0xA8, "i32"); // gd.playerDamage @0xA8
        if (gcW && gcW.val() !== 0 && localGcPtr && gcW.val() === localGcPtr.val()) return true;
      } catch(e) {}
      return false;
    }

    // ============================================================
    // gc.Update — track remote players, capture local player, &
    // maintain God Mode (gc.disableDamage @0x12C + genuine 24-byte
    // ObscuredFloat currentHp @0xEC..0x100 snapshot restore)
    // ============================================================
    ctx.hookPrefix({
      typeName: "gc", methodName: "Update", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        if (window.unityGameInstance) window.unityInstance = window.unityGameInstance;
        if (!window.unityInstance) return;
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [thisPtr]);
        if (!pvPtr || pvPtr.val() === 0) return;
        var isMine = ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pvPtr]).val() === 1;
        if (isMine) {
          var myVal = thisPtr.val();
          if (!localGcPtr || localGcPtr.val() !== myVal) {
            localGcPtr = thisPtr;
            localFpPtr = null;
            localRootTr = null;
            mlXY = null; mlX = null; mlY = null;
            _mlOwnerCache = {};
          }
          localStamp = Date.now();
          try {
            var fpW = thisPtr.readField(0x140, "i32"); // gc.kdh -> fp (FPScontroller)
            if (fpW && fpW.val() !== 0) localFpPtr = fpW;
          } catch(eFp) {}

          // Snapshot genuine ObscuredFloat currentHp (@0xEC..0x100, 6 x i32) at spawn
          // so restoring it never trips ACTk ObscuredCheatingDetector.
          try {
            var deadNow = (thisPtr.readField(0x134, "i32").val() & 0xff) !== 0;
            if (!deadNow) {
              var hpInited = (thisPtr.readField(0xF8, "i32").val() & 0xff) !== 0; // 0xEC + 0x0C (inited)
              if (hpInited) {
                var fakeAct = (thisPtr.readField(0x100, "i32").val() & 0xff) !== 0; // 0xEC + 0x14
                var curFake = thisPtr.readField(0xFC, "f32").val();                 // 0xEC + 0x10
                if (_spawnHpGcVal !== myVal || !_spawnHpWords || (fakeAct && curFake > _spawnHpFake)) {
                  _spawnHpGcVal = myVal;
                  _spawnHpFake = fakeAct ? curFake : 100;
                  _spawnHpWords = [
                    thisPtr.readField(0xEC, "i32").val(),
                    thisPtr.readField(0xF0, "i32").val(),
                    thisPtr.readField(0xF4, "i32").val(),
                    thisPtr.readField(0xF8, "i32").val(),
                    thisPtr.readField(0xFC, "i32").val(),
                    thisPtr.readField(0x100, "i32").val()
                  ];
                }
              }

              if (exploitConfig.godMode) {
                var dd = thisPtr.readField(0x12C, "i32").val(); // gc.disableDamage @0x12C
                if ((dd & 0xff) !== 1) {
                  thisPtr.writeField(0x12C, "i32", (dd & ~0xff) | 1);
                }
                _godAppliedGcVal = myVal;

                if (_spawnHpGcVal === myVal && _spawnHpWords) {
                  if (thisPtr.readField(0xEC, "i32").val() !== _spawnHpWords[0] ||
                      thisPtr.readField(0xF0, "i32").val() !== _spawnHpWords[1]) {
                    thisPtr.writeField(0xEC, "i32", _spawnHpWords[0]);
                    thisPtr.writeField(0xF0, "i32", _spawnHpWords[1]);
                    thisPtr.writeField(0xF4, "i32", _spawnHpWords[2]);
                    thisPtr.writeField(0xF8, "i32", _spawnHpWords[3]);
                    thisPtr.writeField(0xFC, "i32", _spawnHpWords[4]);
                    thisPtr.writeField(0x100, "i32", _spawnHpWords[5]);
                  }
                }
              } else if (_godAppliedGcVal === myVal) {
                var ddOff = thisPtr.readField(0x12C, "i32").val();
                thisPtr.writeField(0x12C, "i32", ddOff & ~0xff);
                _godAppliedGcVal = 0;
              }
            }
          } catch(eGod) {}
          return;
        }

        var actorNr = ctx.call("Photon.Pun.PhotonView", "get_ControllerActorNr", [pvPtr]).val();

        var name = nameCache[actorNr];
        if (!name) {
          name = "Player " + actorNr;
          try {
            var ownerPtr = ctx.call("Photon.Pun.PhotonView", "get_Owner", [pvPtr]);
            if (ownerPtr && ownerPtr.val() !== 0) {
              var namePtr = ctx.call("Photon.Realtime.Player", "get_NickName", [ownerPtr]);
              if (namePtr && namePtr.val() !== 0) {
                var rawName = namePtr.mstr();
                if (rawName && rawName.length > 0) name = rawName;
              }
            }
          } catch(e) {}
          nameCache[actorNr] = name;
        }

        playerMap[actorNr] = {
          ptr: thisPtr,
          name: name,
          actorNr: actorNr,
          timestamp: Date.now()
        };
      } catch(e) {}
    });

    // ============================================================
    // GOD MODE TABLE HOOKS — installed directly on WebAssembly.Table
    // AFTER wasm instantiation so:
    //   1) wail never sees Cyrillic method names ("нараняване", "Проверка"),
    //      avoiding Latin-1 import truncation LinkErrors.
    //   2) Missing/renamed methods (idx <= 0) are safely skipped without
    //      ever calling WebAssembly.Table.get(-1).
    //   3) Only blocks calls targeting the LOCAL player (isLocalGc/isLocalGd),
    //      leaving damage dealt to enemies 100% untouched.
    // ============================================================
    function makeWasmTrampoline(params, results, jsImpl) {
      function wasmType(t) {
        if (t === "i32") return 0x7f;
        if (t === "i64") return 0x7e;
        if (t === "f32") return 0x7d;
        if (t === "f64") return 0x7c;
        throw new Error("Unsupported wasm type: " + t);
      }
      var pTypes = params.map(wasmType);
      var rTypes = results.map(wasmType);
      var typeVec = [0x60, pTypes.length].concat(pTypes, [rTypes.length], rTypes);
      var typeSec = [0x01, typeVec.length + 1, 0x01].concat(typeVec);
      var impEntry = [0x01, 0x65, 0x01, 0x66, 0x00, 0x00];
      var impSec = [0x02, impEntry.length + 1, 0x01].concat(impEntry);
      var expEntry = [0x01, 0x67, 0x00, 0x00];
      var expSec = [0x07, expEntry.length + 1, 0x01].concat(expEntry);
      var bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].concat(typeSec, impSec, expSec));
      var mod = new WebAssembly.Module(bytes);
      var inst = new WebAssembly.Instance(mod, { e: { f: jsImpl } });
      return inst.exports.g;
    }

    (function installGodModeTableHooks() {
      var attempts = 0;
      var timer = setInterval(function() {
        attempts++;
        if (attempts > 240) { clearInterval(timer); return; } // 60s timeout
        try {
          var ug = window.unityGameInstance || window.unityInstance || (typeof game !== "undefined" ? game : null);
          if (!ug || !ug.Module || !ug.Module.asm) return;
          var rt = ctx && ctx._runtime;
          if (!rt || !rt.il2CppContext || typeof rt.getTableIndex !== "function") return;

          var asm = ug.Module.asm;
          var tName = rt.tableName || (typeof rt.resolveTableName === "function" ? rt.resolveTableName(asm) : null);
          var table = tName ? asm[tName] : null;
          if (!table || typeof table.get !== "function") {
            var aKeys = Object.keys(asm);
            for (var k = 0; k < aKeys.length; k++) {
              if (typeof WebAssembly !== "undefined" && WebAssembly.Table && asm[aKeys[k]] instanceof WebAssembly.Table) {
                table = asm[aKeys[k]];
                break;
              }
            }
          }
          if (!table || typeof table.get !== "function" || typeof table.set !== "function") return;

          clearInterval(timer);

          function hookTableVoid(typeName, methodName, params, shouldBlockFn) {
            try {
              var idx = rt.getTableIndex(typeName, methodName);
              if (typeof idx !== "number" || !(idx > 0)) return false;
              var origFn = table.get(idx);
              if (typeof origFn !== "function") return false;
              var tramp = makeWasmTrampoline(params, [], function() {
                if (exploitConfig.godMode) {
                  try {
                    if (shouldBlockFn(arguments)) return;
                  } catch(e) {}
                }
                return origFn.apply(null, arguments);
              });
              table.set(idx, tramp);
              return true;
            } catch(e) {
              return false;
            }
          }

          var blockLocalGc = function(args) {
            return isLocalGc(new UnityWebModkit.ValueWrapper(args[0]));
          };

          var count = 0;
          // Only hook NON-OBFUSCATED [PunRPC] / public methods whose names and
          // signatures cannot be randomized across game builds:
          // 1) [PunRPC] gc.нараняване — incoming network weapon / headshot / blast damage
          if (hookTableVoid("gc", "нараняване", ["i32", "f32", "i32", "i32", "f32", "i32", "i32", "i32", "i32", "i32"], blockLocalGc)) count++;
          // 2) gc.Kill(int weaponid) — instant death (lava, void, drowning, traps)
          if (hookTableVoid("gc", "Kill", ["i32", "i32", "i32"], blockLocalGc)) count++;
          // 3) [PunRPC] gd.InfectPlayer(int spawnId) — zombie mode infection RPC
          if (hookTableVoid("gd", "InfectPlayer", ["i32", "i32", "i32"], function(args) {
            return exploitConfig.antiInfect && isLocalGd(new UnityWebModkit.ValueWrapper(args[0]));
          })) count++;
          // 4) [PunRPC] PhotonRPC_redirect.Проверка(Player, int) — incoming death-check report RPC
          if (hookTableVoid("PhotonRPC_redirect", "Проверка", ["i32", "i32", "i32", "i32"], function() {
            return true;
          })) count++;

          console.log("[PW GOD] Installed " + count + " WebAssembly.Table RPC/damage hooks");
        } catch(e) {}
      }, 250);
    })();

    // ============================================================
    // gd.Update — cache playerTeam @0xC8 per gc instance (for Team Check)
    // ============================================================
    try {
      ctx.hookPrefix({
        typeName: "gd", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try {
          if (!aimConfig.teamCheck) return;
          var gcW = thisPtr.readField(0xA8, "i32"); // gd.playerDamage -> gc
          if (!gcW || gcW.val() === 0) return;
          var gRaw = gcW.val();
          var now = Date.now();
          if (teamCache[gRaw] && (now - teamCache[gRaw].ts) < 1000) return;
          var tmPtr = thisPtr.readField(0xC8, "i32"); // gd.playerTeam -> string
          var tm = (tmPtr && tmPtr.val() !== 0) ? (tmPtr.mstr() || "") : "";
          teamCache[gRaw] = { team: tm, ts: now };
        } catch(e) {}
      });
    } catch(e) {}

    // ============================================================
    // fr.Update + fs.Update — capture local MouseLook instances by axes
    //   axes == 0 -> mlXY (MouseXAndY)
    //   axes == 1 -> mlX  (MouseX on Player Root)
    //   axes == 2 -> mlY  (MouseY on lookObj, pitch @0x2C)
    // ============================================================
    function isLocalMouseLook(thisPtr) {
      if (!localGcPtr || localGcPtr.val() === 0) return false;
      var raw = thisPtr.val();
      if (!raw) return false;

      // 1) Fast pointer chain: kan/kas @0x30 (hr) -> motor @0x98 (fp) -> jzz @0xD4 (gc)
      try {
        var hrW = thisPtr.readField(0x30, "i32");
        if (hrW && hrW.val() !== 0) {
          var fpW = hrW.readField(0x98, "i32");
          if (fpW && fpW.val() !== 0) {
            var gcW = fpW.readField(0xD4, "i32");
            if (gcW && gcW.val() !== 0) {
              return gcW.val() === localGcPtr.val();
            }
          }
        }
      } catch(e) {}

      // 2) Fallback: Transform.get_root match (cached once per component pointer)
      if (raw in _mlOwnerCache) return _mlOwnerCache[raw];
      try {
        if (!localRootTr || localRootTr.val() === 0) {
          var lTr = ctx.call("UnityEngine.Component", "get_transform", [localGcPtr]);
          if (lTr && lTr.val() !== 0) {
            localRootTr = ctx.call("UnityEngine.Transform", "get_root", [lTr]);
          }
        }
        if (localRootTr && localRootTr.val() !== 0) {
          var mTr = ctx.call("UnityEngine.Component", "get_transform", [thisPtr]);
          if (mTr && mTr.val() !== 0) {
            var mRoot = ctx.call("UnityEngine.Transform", "get_root", [mTr]);
            if (mRoot && mRoot.val() !== 0) {
              var match = mRoot.val() === localRootTr.val();
              _mlOwnerCache[raw] = match;
              return match;
            }
          }
        }
      } catch(e2) {}
      return false;
    }

    function onMouseLookUpdate(thisPtr, label) {
      if (!isLocalMouseLook(thisPtr)) return;
      var now = Date.now();
      var axes = thisPtr.readField(0x10, "i32").val();
      if (axes === 0)      { mlXY = thisPtr; mlXYStamp = now; }
      else if (axes === 1) { mlX  = thisPtr; mlXStamp  = now; }
      else if (axes === 2) { mlY  = thisPtr; mlYStamp  = now; }

      var logKey = label + ":" + axes;
      if (!_mlDebugLogged[logKey]) {
        _mlDebugLogged[logKey] = true;
        console.log("[PW AIM] Captured " + label + " (axes=" + axes + ", ptr=" + thisPtr.val() + ")");
      }

      // Passive sign calibration when not actively aiming: verify whether
      // localEulerAngles.x == -kam (+1, standard MouseLook) or +kam (-1).
      if ((axes === 0 || axes === 2) && !(aimConfig.aimbot && isAimKeyHeld())) {
        try {
          var kam = thisPtr.readField(0x2C, "f32").val();
          if (isFinite(kam) && Math.abs(kam) > 2.0) {
            var tr = ctx.call("UnityEngine.Component", "get_transform", [thisPtr]);
            if (tr && tr.val() !== 0) {
              var le = getLocalEulerAngles(tr);
              if (le) {
                var leX = normalizeAngle(le.x);
                if (Math.abs(leX) > 1.0) {
                  pitchSign = (kam * leX < 0) ? 1 : -1;
                }
              }
            }
          }
        } catch(eC) {}
      }
    }

    try {
      ctx.hookPrefix({
        typeName: "fr", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try { onMouseLookUpdate(thisPtr, "fr"); } catch(e) {}
      });
    } catch(e) { console.log("[PW AIM] fr hook fail: " + (e && e.message ? e.message : e)); }

    try {
      ctx.hookPrefix({
        typeName: "fs", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try { onMouseLookUpdate(thisPtr, "fs"); } catch(e) {}
      });
    } catch(e) { console.log("[PW AIM] fs hook fail: " + (e && e.message ? e.message : e)); }

    console.log("[PW ESP] Hooks registered");

    // ============================================================
    // RENDER LOOP — ESP + Buildnow.gg Aimlock + FOV Circle
    // ============================================================
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      try {
        if (!window.unityInstance) return;

        ensureCanvas();
        createMenu();
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);

        var inRoom = true;
        try { inRoom = ctx.call("Photon.Pun.PhotonNetwork", "get_InRoom", []).val() === 1; } catch(e) {}
        if (!inRoom) {
          playerMap = {};
          nameCache = {};
          teamCache = {};
          skelCache = {};
          return;
        }

        var now = Date.now();
        var staleKeys = Object.keys(playerMap);
        for (var s = 0; s < staleKeys.length; s++) {
          if (now - playerMap[staleKeys[s]].timestamp > 500) {
            var stPtr = playerMap[staleKeys[s]].ptr;
            if (stPtr && stPtr.val) delete skelCache[stPtr.val()];
            delete playerMap[staleKeys[s]];
          }
        }

        if (!espConfig.enabled && !aimConfig.aimbot) return;

        var camPtr = null;
        try { camPtr = ctx.call("UnityEngine.Camera", "get_main", []); } catch(e) {}
        if (!camPtr || camPtr.val() === 0) return;

        var camTr = null;
        var camPos = null;
        try {
          camTr = ctx.call("UnityEngine.Component", "get_transform", [camPtr]);
          if (camTr && camTr.val() !== 0) {
            var camPosBuf = getTransformPosBuf(camTr);
            if (camPosBuf) camPos = readVector3(camPosBuf);
          }
        } catch(e) {}

        var localAlive = localGcPtr && localGcPtr.val() !== 0 &&
                         (now - localStamp) < 1000 &&
                         !(localGcPtr.readField(0x134, "i32").val() & 0xff);

        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;
        var aimActive = aimConfig.aimbot && isAimKeyHeld() && !menuOpen && localAlive;

        if (aimActive && aimConfig.fovcircle) {
          ctx2d.beginPath();
          ctx2d.arc(cx, cy, aimConfig.fovsize, 0, Math.PI * 2);
          ctx2d.strokeStyle = "#ff4444";
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }

        var bestTargetVec = null;
        var bestScore = Infinity;

        var keys = Object.keys(playerMap);
        for (var i = 0; i < keys.length; i++) {
          var data = playerMap[keys[i]];
          try {
            if (!data.ptr || data.ptr.val() === 0) { delete playerMap[keys[i]]; continue; }
            if (localGcPtr && data.ptr.val() === localGcPtr.val()) continue;

            // gc.PlayerIsDead (dump.cs @0x134)
            var deadW = data.ptr.readField(0x134, "i32");
            if (deadW && (deadW.val() & 0xff)) {
              delete skelCache[data.ptr.val()];
              continue;
            }

            var trPtr = ctx.call("UnityEngine.Component", "get_transform", [data.ptr]);
            if (!trPtr || trPtr.val() === 0) continue;
            var posBuf = getTransformPosBuf(trPtr);
            if (!posBuf) continue;
            var px = posBuf.readField(0x0, "f32").val();
            var py = posBuf.readField(0x4, "f32").val();
            var pz = posBuf.readField(0x8, "f32").val();

            // Exact box span + head collider center
            var topY = null, feetY = py, span = null;
            if (espConfig.boxAutoHeight || aimActive) {
              span = getHitboxSpan(data.ptr, py, px, pz);
              if (span && span.top > span.bottom) {
                var rel = span.top - py;
                if (rel > 0.3 && rel < 3.2) {
                  topY = span.top + (espConfig.heightAdj || 0);
                  if (span.bottom < py && (py - span.bottom) < 0.35) feetY = span.bottom;
                }
              }
            }
            var spanResolved = topY !== null;
            if (topY === null) topY = py + espConfig.boxHeight;
            if (espConfig.debug && !_spanDebugOnce) {
              _spanDebugOnce = true;
              var via = span ? "hb=" + !!span.hb + ", eht=" + !!span.eht + ", ehb=" + !!span.ehb : "-";
              console.log("[PW ESP] span: " + (span && spanResolved
                ? "top=" + span.top.toFixed(2) + ", feet=" + feetY.toFixed(2) +
                  ", above root=" + (span.top - py).toFixed(2) + " [" + via + "] (USED)"
                : span ? "top=" + span.top.toFixed(2) + " [" + via + "] (rejected -> fallback)"
                  : "NOT RESOLVED -> fallback fixed height"));
            }

            // World aim point (Buildnow.gg headY + aimHeight pattern, using real head X/Z when resolved)
            var aimWorld;
            if (aimConfig.aimBone === "Chest") {
              aimWorld = { x: px, y: (topY + feetY) * 0.5 + (aimConfig.aimHeight + 0.2), z: pz };
            } else {
              var hx = (span && span.hasHead) ? span.headX : px;
              var hz = (span && span.hasHead) ? span.headZ : pz;
              aimWorld = { x: hx, y: topY + aimConfig.aimHeight, z: hz };
            }

            var headBuf = getBuf("head", 0x1C);
            writeVec3(headBuf, px, topY, pz);
            var feetBuf = getBuf("feet", 0x1C);
            writeVec3(feetBuf, px, feetY, pz);

            var headScreen = worldToScreen(headBuf, camPtr);
            var feetScreen = worldToScreen(feetBuf, camPtr);
            var onScreen = !!(headScreen && feetScreen && headScreen.z >= 0.01 && feetScreen.z >= 0.01);

            // Visibility check when needed for Aimbot or Tracer color
            var needVis = (aimActive && aimConfig.vischeck) || (onScreen && espConfig.enabled && espConfig.tracer && aimConfig.vischeck);
            var playerVisible = needVis ? isPlayerVisible(data.ptr, aimWorld, camPos) : true;

            // ESP drawing
            if (onScreen && espConfig.enabled) {
              var midX = (headScreen.x + feetScreen.x) / 2;

              if (espConfig.tracer) {
                ctx2d.strokeStyle = playerVisible ? espConfig.tracerColor : espConfig.invistracerColor;
                ctx2d.lineWidth = espConfig.tracerThickness;
                ctx2d.beginPath();
                ctx2d.moveTo(window.innerWidth / 2, window.innerHeight);
                ctx2d.lineTo(feetScreen.x, feetScreen.y);
                ctx2d.stroke();
              }

              if (espConfig.box) {
                drawCornerBox(headScreen.x, headScreen.y, feetScreen.x, feetScreen.y, espConfig.boxColor, espConfig.boxThickness, espConfig.boxWidth);
              }

              if (espConfig.skeleton) {
                drawSkeleton(data.ptr, trPtr, px, py, pz, camPtr, espConfig.skeletonColor, espConfig.skeletonThickness);
              }

              if (espConfig.name) {
                ctx2d.font = "bold " + espConfig.nameSize + "px sans-serif";
                ctx2d.fillStyle = espConfig.nameColor;
                ctx2d.textAlign = "center";
                ctx2d.fillText(String(data.name || ("Player " + data.actorNr)), midX, feetScreen.y + 18);
              }

              if (espConfig.distance && camPos) {
                var dist3d = Math.sqrt(
                  (px - camPos.x) * (px - camPos.x) +
                  (py - camPos.y) * (py - camPos.y) +
                  (pz - camPos.z) * (pz - camPos.z)
                );
                ctx2d.font = espConfig.distanceSize + "px sans-serif";
                ctx2d.fillStyle = espConfig.distanceColor;
                ctx2d.textAlign = "center";
                ctx2d.fillText(Math.round(dist3d) + "m", midX, feetScreen.y + (espConfig.name ? 32 : 18));
              }
            }

            // Aimbot candidate scoring (Buildnow.gg pattern)
            if (aimActive) {
              if (aimConfig.vischeck && !playerVisible) continue;
              if (aimConfig.teamCheck && isTeammate(data.ptr)) continue;

              var aimBuf = getBuf("aimp", 0x1C);
              writeVec3(aimBuf, aimWorld.x, aimWorld.y, aimWorld.z);
              var aimScreen = worldToScreen(aimBuf, camPtr);
              var aimOnScreen = !!(aimScreen && aimScreen.z >= 0.01);
              var screenDist = aimOnScreen
                ? Math.sqrt((aimScreen.x - cx) * (aimScreen.x - cx) + (aimScreen.y - cy) * (aimScreen.y - cy))
                : Infinity;

              if (aimConfig.fovcircle && (!aimOnScreen || screenDist > aimConfig.fovsize)) continue;

              var score;
              if (aimConfig.aimType === "Closest") {
                if (!camPos) continue;
                var ddx = aimWorld.x - camPos.x;
                var ddy = aimWorld.y - camPos.y;
                var ddz = aimWorld.z - camPos.z;
                score = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
              } else {
                if (!aimOnScreen) continue;
                score = screenDist;
              }

              if (score < bestScore) {
                bestScore = score;
                bestTargetVec = aimWorld;
              }
            }
          } catch(e) {}
        }

        // Apply Buildnow.gg-style direct aimlock
        if (aimActive && bestTargetVec && camPos && camTr) {
          applyAimlock(bestTargetVec, camPos, camTr);
        }
      } catch(e) {}
    }

    requestAnimationFrame(renderLoop);
    console.log("[PW ESP] Render started");

    setInterval(function() {
      var elCount = document.getElementById("hm-player-count");
      if (elCount) elCount.textContent = Object.keys(playerMap).length;
      var elMl = document.getElementById("hm-ml-status");
      if (elMl) {
        var st = (mlXY ? "XY " : "") + (mlX ? "X " : "") + (mlY ? "Y" : "");
        elMl.textContent = st || (localFpPtr ? "FP Fallback" : "Waiting...");
      }
    }, 500);
  }

  init().catch(function(e) {
    console.log("[PW ESP] init failed: " + (e && e.message ? e.message : e));
  });
})();
