// ==UserScript==
// @name        BNGG ESP v2
// @match       *://*buildnow-gg.game-files.crazygames.com/unity/unity2020/*
// @require     https://raw.githubusercontent.com/Recte-Development/rectehoststuff/refs/heads/main/m39rectescriptloaderplsdontfailme
// @run-at      document-idle
// @grant       none
// ==/UserScript==

(function() {
  var canvas, ctx2d, ctx;
  var localPlayerPtr = null;
  var localPlayerActorNr = -1;
  var playerMap = {};

  // ============================================================
  // CONFIG
  // ============================================================
  var espConfig = {
    enabled: true,
    toggleKey: "Insert",
    menuKey: "p",
    box: true,
    boxThickness: 2,
    boxColor: "#ff0000",
    tracer: true,
    tracerThickness: 1.5,
    tracerColor: "#ff00ff",
    invistracerColor: "#ff4444",
    name: true,
    nameSize: 13,
    nameColor: "#66ff00",
    distance: true,
    distanceSize: 11,
    distanceColor: "#ffffff"
  };

  var aimConfig = {
    aimbot: false,
    vischeck: false,
    aimType: "Closest to Centre Screen",
    aimKey: "Right Click",
    aimSpeed: 1.0,
    aimHeight: -0.2,
    fovcircle: false,
    fovsize: 120
  };

  var weaponConfig = {
    noRecoil: false,
    noRecoilKey: "n",
    noSpread: false,
    noSpreadKey: "m"
  };

  var miscConfig = {
    fly: false,
    flyKey: "v",
    flySpeed: 0.3,
    speed: false,
    speedKey: "f",
    speedMult: 2,
    killAll: false,
    killAllKey: "k",
    despawnAll: false,
    despawnAllKey: "j"
  };

  var _killCooldown = 0;

  function executeKillAll() {
    var now = Date.now();
    if (now - _killCooldown < 500) return;
    _killCooldown = now;
    var keys = Object.keys(playerMap);
    var count = 0;
    var errs = [];
    for (var i = 0; i < keys.length; i++) {
      var data = playerMap[keys[i]];
      try {
        if (!data.ptr || data.ptr.val() === 0) { errs.push("null_ptr"); continue; }
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [data.ptr]);
        if (!pvPtr || pvPtr.val() === 0) { errs.push("no_pv@" + keys[i]); continue; }
        ctx.call("Photon.Pun.PhotonNetwork", "Destroy", [pvPtr]);
        count++;
      } catch(e) { errs.push(e.message); }
    }
    console.log("[BNGG KILL] targets=" + keys.length + " killed=" + count + " errs=" + errs.join(","));
    showToast("Kill: " + count + "/" + keys.length + (errs.length ? " (" + errs[0] + ")" : ""));
  }

  function executeDespawnAll() {
    var now = Date.now();
    if (now - _killCooldown < 500) return;
    _killCooldown = now;
    try {
      var isMaster = ctx.call("Photon.Pun.PhotonNetwork", "get_IsMasterClient", []).val();
      console.log("[BNGG DESPAWN] isMaster=" + isMaster);
      if (!isMaster) {
        var lpPtr = ctx.call("Photon.Pun.PhotonNetwork", "get_LocalPlayer", []);
        if (lpPtr && lpPtr.val() !== 0) {
          ctx.call("Photon.Pun.PhotonNetwork", "SetMasterClient", [lpPtr]);
          console.log("[BNGG DESPAWN] SetMasterClient called");
        } else {
          showToast("No local player ptr");
          return;
        }
      }
      var keys = Object.keys(playerMap);
      var count = 0;
      var errs = [];
      for (var i = 0; i < keys.length; i++) {
        var data = playerMap[keys[i]];
        try {
          var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [data.ptr]);
          if (!pvPtr || pvPtr.val() === 0) { errs.push("no_pv@" + keys[i]); continue; }
          var ownerNr = ctx.call("Photon.Pun.PhotonView", "get_OwnerActorNr", [pvPtr]).val();
          if (ownerNr > 0) {
            ctx.call("Photon.Pun.PhotonNetwork", "DestroyPlayerObjects", [ownerNr]);
            count++;
          }
        } catch(e) { errs.push(e.message); }
      }
      console.log("[BNGG DESPAWN] destroyed=" + count + " errs=" + errs.join(","));
      showToast("Despawn: " + count + "/" + keys.length);
    } catch(e) {
      console.log("[BNGG DESPAWN] Error: " + e);
      showToast("Despawn Error: " + e.message);
    }
  }

  var CONFIG_KEY = "bngg_esp_v2_menu_config";

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ esp: espConfig, aim: aimConfig, weapon: weaponConfig, misc: miscConfig }));
    } catch(e) {}
  }

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (saved.esp)     for (var k in saved.esp)     if (k in espConfig)     espConfig[k]     = saved.esp[k];
      if (saved.aim)     for (var k in saved.aim)     if (k in aimConfig)     aimConfig[k]     = saved.aim[k];
      if (saved.weapon)  for (var k in saved.weapon)  if (k in weaponConfig)  weaponConfig[k]  = saved.weapon[k];
      if (saved.misc)    for (var k in saved.misc)    if (k in miscConfig)    miscConfig[k]    = saved.misc[k];
      return true;
    } catch(e) { return false; }
  }

  function resetConfig() {
    try { localStorage.removeItem(CONFIG_KEY); location.reload(); } catch(e) {}
  }

  loadConfig();

  // ============================================================
  // Fly state
  // ============================================================
  var flyPos = null;
  var NORMAL_GRAVITY = null;
  var origSpeedVals = null;
  var _reusableBufs = {};
  var _speedWriteTimer = 0;
  var _fixedFrameCount = 0;

  function floatToIntBits(f) {
    var buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = f;
    return new Int32Array(buf)[0];
  }

  function intBitsToFloat(i) {
    var buf = new ArrayBuffer(4);
    new Int32Array(buf)[0] = i;
    return new Float32Array(buf)[0];
  }

  function writeObscuredFloat(ptr, offset, value) {
    var key = ptr.readField(offset, "i32").val();
    var encoded = floatToIntBits(value) ^ key;
    ptr.writeField(offset, "i32", key);
    ptr.writeField(offset + 4, "i32", encoded);
  }

  function getBuf(id, size) {
    if (!_reusableBufs[id]) {
      _reusableBufs[id] = ctx.malloc(size);
    }
    return _reusableBufs[id];
  }

  function safeVal(ptr) {
    try { return ptr && ptr.val() !== 0 ? ptr.val() : 0; } catch(e) { return 0; }
  }

  // ============================================================
  // Input tracking
  // ============================================================
  var keysDown = {};
  var mouseDown = { 0: false, 1: false, 2: false, 3: false, 4: false };
  window.addEventListener("keydown", function(e) { keysDown[e.key] = true; keysDown[e.code] = true; }, true);
  window.addEventListener("keyup",   function(e) { keysDown[e.key] = false; keysDown[e.code] = false; }, true);
  window.addEventListener("mousedown", function(e) { mouseDown[e.button] = true; }, true);
  window.addEventListener("mouseup",   function(e) { mouseDown[e.button] = false; }, true);

  // Toggle hotkeys
  window.addEventListener("keydown", function(e) {
    if (e.key === espConfig.toggleKey || e.code === espConfig.toggleKey) {
      espConfig.enabled = !espConfig.enabled;
      console.log("[BNGG ESP] " + (espConfig.enabled ? "ON" : "OFF"));
    }
    if (e.key === "o" || e.code === "KeyO") {
      aimConfig.aimbot = !aimConfig.aimbot;
      console.log("[BNGG AIM] " + (aimConfig.aimbot ? "ON" : "OFF"));
    }
    if (e.key === miscConfig.flyKey || e.code === ("Key" + miscConfig.flyKey.toUpperCase())) {
      miscConfig.fly = !miscConfig.fly;
      flyPos = null;
      console.log("[BNGG FLY] " + (miscConfig.fly ? "ON" : "OFF"));
    }
    if (e.key === weaponConfig.noRecoilKey || e.code === ("Key" + weaponConfig.noRecoilKey.toUpperCase())) {
      weaponConfig.noRecoil = !weaponConfig.noRecoil;
      console.log("[BNGG NORECOIL] " + (weaponConfig.noRecoil ? "ON" : "OFF"));
    }
    if (e.key === weaponConfig.noSpreadKey || e.code === ("Key" + weaponConfig.noSpreadKey.toUpperCase())) {
      weaponConfig.noSpread = !weaponConfig.noSpread;
      console.log("[BNGG NOSPREAD] " + (weaponConfig.noSpread ? "ON" : "OFF"));
    }
    if (e.key === miscConfig.speedKey || e.code === ("Key" + miscConfig.speedKey.toUpperCase())) {
      miscConfig.speed = !miscConfig.speed;
      console.log("[BNGG SPEED] " + (miscConfig.speed ? "ON" : "OFF"));
    }
    if (e.key === miscConfig.killAllKey || e.code === ("Key" + miscConfig.killAllKey.toUpperCase())) {
      executeKillAll();
    }
    if (e.key === miscConfig.despawnAllKey || e.code === ("Key" + miscConfig.despawnAllKey.toUpperCase())) {
      executeDespawnAll();
    }
  }, true);

  window.addEventListener("beforeunload", function() {
    playerMap = {};
    localPlayerPtr = null;
  }, true);

  function isAimKeyHeld() {
    var k = aimConfig.aimKey;
    if (k === "Right Click")  return mouseDown[2];
    if (k === "Left Click")   return mouseDown[0];
    if (k === "Middle Click") return mouseDown[1];
    if (k === "Side1") return mouseDown[3];
    if (k === "Side2") return mouseDown[4];
    return keysDown[k] || keysDown[k.toLowerCase()] || keysDown["Key" + k] || false;
  }

  // ============================================================
  // Canvas overlay
  // ============================================================
  function ensureCanvas() {
    if (canvas && canvas.parentElement) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999999;";
    document.body.appendChild(canvas);
    ctx2d = canvas.getContext("2d");
  }

  // ============================================================
  // Memory / Unity helpers
  // ============================================================
  function readVector3(ptr) {
    return {
      x: ptr.readField(0, "f32").val(),
      y: ptr.readField(4, "f32").val(),
      z: ptr.readField(8, "f32").val()
    };
  }

  function writeVec3(ptr, offset, vec) {
    ptr.writeField(offset,     "f32", vec.x);
    ptr.writeField(offset + 4, "f32", vec.y);
    ptr.writeField(offset + 8, "f32", vec.z);
  }

  function readVec3(ptr, offset) {
    return {
      x: ptr.readField(offset,     "f32").val(),
      y: ptr.readField(offset + 4, "f32").val(),
      z: ptr.readField(offset + 8, "f32").val()
    };
  }

  function getTransformPosBuf(transformPtr) {
    var posBuf = getBuf("tpos", 0x1C);
    try {
      ctx.call("UnityEngine.Transform", "get_position", [posBuf, transformPtr]);
      return posBuf;
    } catch(e) {
      return null;
    }
  }

  function worldToScreen(posBuf, camPtr) {
    var scrBuf = getBuf("w2s", 0x1C);
    try {
      ctx.call("UnityEngine.Camera", "WorldToScreenPoint_9204", [scrBuf, camPtr, posBuf]);
      var sx = scrBuf.readField(0x0, "f32").val();
      var sy = scrBuf.readField(0x4, "f32").val();
      var z = scrBuf.readField(0x8, "f32").val();
      return { x: sx, y: canvas.height - sy, z: z };
    } catch(e) {
      return null;
    }
  }

  // ============================================================
  // Visibility check — Raycast from camera to player head.
  // If the ray hits the player's collider directly → visible.
  // If the ray hits something else first → behind wall → not visible.
  // LayerMask: -513 (~0x201) = all layers EXCEPT layers 0 and 9.
  // ============================================================
  var _visLogCount = 0;
  function isPlayerVisible(playerPtr, headWorldPos, camPosition, camPtrArg) {
    try {
      if (!camPosition) return true;
      if (!camPtrArg || camPtrArg.val() === 0) return true;

      // Get camera transform position as a fresh buffer (like old script)
      var camTrPtr = ctx.call("UnityEngine.Component", "get_transform", [camPtrArg]);
      if (!camTrPtr || camTrPtr.val() === 0) return true;
      var camPosBuf = ctx.malloc(0x1C);
      ctx.call("UnityEngine.Transform", "get_position", [camPosBuf, camTrPtr]);

      // Direction = headPos - camPos (unnormalized)
      var cx = camPosBuf.readField(0x0, "f32").val();
      var cy = camPosBuf.readField(0x4, "f32").val();
      var cz = camPosBuf.readField(0x8, "f32").val();
      var hx = headWorldPos.x;
      var hy = headWorldPos.y;
      var hz = headWorldPos.z;

      var dirBuf = ctx.malloc(0x1C);
      dirBuf.writeField(0x0, "f32", hx - cx);
      dirBuf.writeField(0x4, "f32", hy - cy);
      dirBuf.writeField(0x8, "f32", hz - cz);

      var maxDist = Math.sqrt((hx - cx) * (hx - cx) + (hy - cy) * (hy - cy) + (hz - cz) * (hz - cz));
      if (maxDist < 0.01) {
        try { unityGameInstance.Module._free(camPosBuf.val()); } catch(e) {}
        try { unityGameInstance.Module._free(dirBuf.val()); } catch(e) {}
        return true;
      }

      var hitInfo = ctx.malloc(0x48);
      var layerMask = -513;

      // Raycast(origin, direction, hitInfo, maxDistance, layerMask)
      var hit = ctx.call("UnityEngine.Physics", "Raycast_118104", [camPosBuf, dirBuf, hitInfo, maxDist, layerMask]);

      var visible = false;
      if (hit && hit.val() === 1) {
        var colliderPtr = ctx.call("UnityEngine.RaycastHit", "get_collider", [hitInfo]);
        if (colliderPtr && colliderPtr.val() !== 0) {
          var colTrPtr = ctx.call("UnityEngine.Component", "get_transform", [colliderPtr]);
          if (colTrPtr && colTrPtr.val() !== 0) {
            var colRootPtr = ctx.call("UnityEngine.Transform", "get_root", [colTrPtr]);
            var playerGoPtr = ctx.call("UnityEngine.Component", "get_gameObject", [playerPtr]);
            if (playerGoPtr && playerGoPtr.val() !== 0) {
              var playerTrPtr = ctx.call("UnityEngine.GameObject", "get_transform", [playerGoPtr]);
              if (playerTrPtr && playerTrPtr.val() !== 0) {
                var playerRootPtr = ctx.call("UnityEngine.Transform", "get_root", [playerTrPtr]);
                if (colRootPtr && playerRootPtr) {
                  visible = colRootPtr.val() === playerRootPtr.val();
                }
              }
            }
          }
        }
      }

      // Free ALL buffers (like old script does)
      try { unityGameInstance.Module._free(camPosBuf.val()); } catch(e) {}
      try { unityGameInstance.Module._free(dirBuf.val()); } catch(e) {}
      try { unityGameInstance.Module._free(hitInfo.val()); } catch(e) {}

      return visible;
    } catch(e) {
      if (_visLogCount < 5) {
        _visLogCount++;
        console.log("[BNGG VIS] Exception: " + e.message);
      }
      return true;
    }
  }

  function normalizeAngle(angle) {
    angle %= 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
  }

  function drawCornerBox(x1, y1, x2, y2, color, thickness) {
    var h = y2 - y1;
    var w = h / 2;
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
  // NO RECOIL / NO SPREAD — direct BNGG offsets from dump.cs
  // ============================================================
  var localWsPtr = null;

  var _patchLogged = {};
  function patchWeapon(gun) {
    if (!weaponConfig.noRecoil && !weaponConfig.noSpread) return;
    try {
      var wdObjRaw = gun.readField(0x10, "i32").val();
      if (!wdObjRaw) { if (!_patchLogged.wd) { console.log("[BNGG] NR/NS: weaponData null"); _patchLogged.wd = 1; } return; }
      var dataRaw = new UnityWebModkit.ValueWrapper(wdObjRaw).readField(0xC, "i32").val();
      if (!dataRaw) { if (!_patchLogged.data) { console.log("[BNGG] NR/NS: WeaponData null"); _patchLogged.data = 1; } return; }
      var data = new UnityWebModkit.ValueWrapper(dataRaw);

      if (weaponConfig.noSpread) {
        data.writeField(0xB8, "f32", 0);
        data.writeField(0xBC, "f32", 0);
        data.writeField(0x108, "f32", 0);
      }

      if (weaponConfig.noRecoil) {
        var recoilRaw = data.readField(0x1B0, "i32").val();
        if (recoilRaw) {
          var recoil = new UnityWebModkit.ValueWrapper(recoilRaw);
          recoil.writeField(0x08, "f32", 0);
          recoil.writeField(0x0C, "f32", 0);
          recoil.writeField(0x10, "f32", 0);
          recoil.writeField(0x58, "f32", 0);
          recoil.writeField(0x5C, "f32", 0);
        } else {
          if (!_patchLogged.recoil) { console.log("[BNGG] NR/NS: RecoilData ptr null @0x1B0"); _patchLogged.recoil = 1; }
        }
      }

      if (!_patchLogged.ok) {
        console.log("[BNGG] NR/NS: patched weapon " + gun.val());
        _patchLogged.ok = 1;
      }
    } catch(e) {
      if (!_patchLogged.err) { console.log("[BNGG] NR/NS: " + e.message); _patchLogged.err = 1; }
    }
  }

  function patchCharacterWeapon(charPtr) {
    if (!weaponConfig.noRecoil && !weaponConfig.noSpread) return;
    try {
      if (!localWsPtr || localWsPtr.val() === 0) return;
      var gunRaw = localWsPtr.readField(0x50, "i32").val();
      if (gunRaw) patchWeapon(new UnityWebModkit.ValueWrapper(gunRaw));
    } catch(e) {}
  }

  // ============================================================
  // MENU — toggled with Home key (recte style with tabs)
  // ============================================================
  var MENU_KEY = espConfig.menuKey;
  var menuOpen = false;
  var menuContainer = null;
  var activeTab = "Visuals";

  function cfgObj(cfg) {
    if (cfg === "aim") return aimConfig;
    if (cfg === "weapon") return weaponConfig;
    if (cfg === "misc") return miscConfig;
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
    var opts = options.map(function(o) { return '<option value="' + o + '" ' + (cfgObj(cfg)[key] === o ? "selected" : "") + '>' + o + '</option>'; }).join("");
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

  function createMenu() {
    if (menuContainer) return;

    var style = document.createElement("style");
    style.textContent = `
    .hm-wrap { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:999999999;
      font-family: 'Segoe UI', system-ui, sans-serif; display:none; user-select:none; }
    .hm-wrap.open { display:block; }
    .hm-box { width:420px; background:rgba(10,10,18,0.92); border:1px solid rgba(255,255,255,0.08);
      border-radius:10px; backdrop-filter:blur(20px); box-shadow:0 20px 60px rgba(0,0,0,0.7);
      overflow:hidden; display:flex; flex-direction:column; }
    .hm-titlebar { display:flex; align-items:center; padding:10px 14px; gap:8px;
      background:rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; }
    .hm-titlebar:active { cursor:grabbing; }
    .hm-logo { font-size:14px; font-weight:700; color:#e0e0e0; letter-spacing:1px; }
    .hm-logo span { color:#ff00ff; }
    .hm-ver { font-size:10px; color:rgba(255,255,255,0.3); margin-left:4px; }
    .hm-close { margin-left:auto; width:24px; height:24px; border:none; background:rgba(255,60,60,0.15);
      color:#ff4444; border-radius:4px; cursor:pointer; font-size:14px; display:flex;
      align-items:center; justify-content:center; transition:background 0.15s; }
    .hm-close:hover { background:rgba(255,60,60,0.3); }
    .hm-save-btn { margin-left:auto; padding:4px 10px; border:1px solid rgba(255,0,255,0.2);
      background:rgba(255,0,255,0.08); color:#ff00ff; border-radius:4px; cursor:pointer;
      font-size:11px; font-weight:600; font-family:inherit; transition:all 0.15s; }
    .hm-save-btn:hover { background:rgba(255,0,255,0.15); border-color:#ff00ff; }
    .hm-save-btn:active { transform:scale(0.96); }
    .hm-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
      background:rgba(10,10,18,0.9); border:1px solid rgba(255,0,255,0.3);
      color:#ff00ff; padding:8px 18px; border-radius:6px; font-size:12px;
      font-family:'Segoe UI',system-ui,sans-serif; z-index:999999999;
      animation: hm-toast-in 0.2s ease, hm-toast-out 0.3s ease 1.5s forwards; }
    @keyframes hm-toast-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
    @keyframes hm-toast-out { from { opacity:1; } to { opacity:0; transform:translateX(-50%) translateY(-10px); } }
    .hm-action-btn { padding:5px 12px; border:1px solid rgba(255,0,255,0.2);
      background:rgba(255,0,255,0.08); color:rgba(255,255,255,0.7); border-radius:4px;
      cursor:pointer; font-size:11px; font-weight:600; font-family:inherit; transition:all 0.15s; }
    .hm-action-btn:hover { background:rgba(255,0,255,0.15); color:#ff00ff; border-color:#ff00ff; }
    .hm-action-btn.danger { border-color:rgba(255,60,60,0.2); background:rgba(255,60,60,0.08); color:rgba(255,255,255,0.5); }
    .hm-action-btn.danger:hover { background:rgba(255,60,60,0.15); color:#ff4444; border-color:#ff4444; }
    .hm-tabs { display:flex; background:rgba(0,0,0,0.2); border-bottom:1px solid rgba(255,255,255,0.06); }
    .hm-tab { flex:1; padding:8px 0; text-align:center; font-size:12px; font-weight:600;
      color:rgba(255,255,255,0.4); cursor:pointer; transition:color 0.15s, background 0.15s;
      border-bottom:2px solid transparent; }
    .hm-tab:hover { color:rgba(255,255,255,0.7); background:rgba(255,255,255,0.03); }
    .hm-tab.active { color:#ff00ff; border-bottom-color:#ff00ff; background:rgba(255,0,255,0.05); }
    .hm-body { padding:12px 14px; max-height:340px; overflow-y:auto; }
    .hm-body::-webkit-scrollbar { width:4px; }
    .hm-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }
    .hm-group { margin-bottom:12px; }
    .hm-group-title { font-size:10px; font-weight:700; color:rgba(255,255,255,0.3);
      text-transform:uppercase; letter-spacing:1.2px; margin-bottom:6px; padding-left:2px; }
    .hm-row { display:flex; align-items:center; justify-content:space-between; padding:5px 8px;
      border-radius:5px; transition:background 0.12s; }
    .hm-row:hover { background:rgba(255,255,255,0.03); }
    .hm-label { font-size:12px; color:rgba(255,255,255,0.7); }
    .hm-toggle { position:relative; width:34px; height:18px; flex-shrink:0; }
    .hm-toggle input { opacity:0; width:0; height:0; }
    .hm-toggle .slider { position:absolute; inset:0; background:rgba(255,255,255,0.1);
      border:1px solid rgba(255,255,255,0.08); border-radius:18px; cursor:pointer; transition:0.2s; }
    .hm-toggle .slider::before { content:''; position:absolute; width:12px; height:12px;
      left:2px; top:2px; background:rgba(255,255,255,0.4); border-radius:50%; transition:0.2s; }
    .hm-toggle input:checked + .slider { background:rgba(255,0,255,0.3); border-color:rgba(255,0,255,0.4); }
    .hm-toggle input:checked + .slider::before { transform:translateX(16px); background:#ff00ff; }
    .hm-select { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
      border-radius:4px; color:rgba(255,255,255,0.8); font-size:11px; padding:3px 6px;
      font-family:inherit; cursor:pointer; outline:none; }
    .hm-select:focus { border-color:rgba(255,0,255,0.4); }
    .hm-select option { background:#1a1a2e; color:#e0e0e0; }
    .hm-slider-wrap { display:flex; align-items:center; gap:8px; }
    .hm-slider { width:80px; height:3px; -webkit-appearance:none; appearance:none;
      background:rgba(255,255,255,0.1); border-radius:2px; outline:none; cursor:pointer; }
    .hm-slider::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px;
      background:#ff00ff; border-radius:50%; cursor:pointer; }
    .hm-slider-val { font-size:10px; color:rgba(255,255,255,0.4); min-width:20px; text-align:right; }
    .hm-color { width:24px; height:18px; border:1px solid rgba(255,255,255,0.15);
      border-radius:3px; cursor:pointer; padding:0; background:none; }
    .hm-color::-webkit-color-swatch-wrapper { padding:0; }
    .hm-color::-webkit-color-swatch { border:none; border-radius:2px; }
    .hm-panel { display:none; }
    .hm-panel.active { display:block; }
    `;
    document.head.appendChild(style);

    var wrap = document.createElement("div");
    wrap.className = "hm-wrap";
    wrap.innerHTML =
      '<div class="hm-box">' +
        '<div class="hm-titlebar">' +
          '<div class="hm-logo">BNGG<span>.</span>MENU</div>' +
          '<div class="hm-ver">v2</div>' +
          '<button class="hm-save-btn" id="hm-save" title="Save Config">Save</button>' +
          '<button class="hm-close">&times;</button>' +
        '</div>' +
        '<div class="hm-tabs">' +
          '<div class="hm-tab active" data-tab="Visuals">Visuals</div>' +
          '<div class="hm-tab" data-tab="Aimbot">Aimbot</div>' +
          '<div class="hm-tab" data-tab="Weapon">Weapon</div>' +
          '<div class="hm-tab" data-tab="Misc">Misc</div>' +
        '</div>' +
        '<div class="hm-body" id="hm-body"></div>' +
      '</div>';
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

    var dragging = false, dx = 0, dy = 0;
    var titlebar = wrap.querySelector(".hm-titlebar");
    titlebar.addEventListener("mousedown", function(e) {
      dragging = true;
      var rect = wrap.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
    });
    window.addEventListener("mousemove", function(e) {
      if (!dragging) return;
      wrap.style.left = (e.clientX - dx) + "px";
      wrap.style.top = (e.clientY - dy) + "px";
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
          sliderRow("esp", "boxThickness", "Thickness", 1, 5, 1) +
          colorRow("esp", "boxColor", "Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Tracers</div>' +
          toggleRow("esp", "tracer", "Enable Tracers") +
          sliderRow("esp", "tracerThickness", "Thickness", 1, 5, 1) +
          colorRow("esp", "tracerColor", "Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Name</div>' +
          toggleRow("esp", "name", "Show Names") +
          sliderRow("esp", "nameSize", "Size", 8, 24, 1) +
          colorRow("esp", "nameColor", "Color") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Distance</div>' +
          toggleRow("esp", "distance", "Show Distance") +
          sliderRow("esp", "distanceSize", "Size", 8, 20, 1) +
          colorRow("esp", "distanceColor", "Color") +
        '</div>';
    } else if (activeTab === "Aimbot") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Aimbot</div>' +
          toggleRow("aim", "aimbot", "Aimbot") +
          toggleRow("aim", "vischeck", "Visible Check") +
          selectRow("aim", "aimType", "Aim Type", ["Closest to Centre Screen", "Closest"]) +
          aimKeyRow() +
          sliderRow("aim", "aimSpeed", "Aim Speed", 0.05, 1, 0.05) +
          sliderRow("aim", "aimHeight", "Aim Height", -0.3, 0.2, 0.05) +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">FOV</div>' +
          toggleRow("aim", "fovcircle", "FOV Circle") +
          sliderRow("aim", "fovsize", "FOV Size", 20, 300, 5) +
        '</div>';
    } else if (activeTab === "Weapon") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Recoil</div>' +
          toggleRow("weapon", "noRecoil", "No Recoil") +
          keyRow("weapon", "noRecoilKey", "Recoil Key") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Spread</div>' +
          toggleRow("weapon", "noSpread", "No Spread") +
          keyRow("weapon", "noSpreadKey", "Spread Key") +
        '</div>';
    } else if (activeTab === "Misc") {
      body.innerHTML =
        '<div class="hm-group">' +
          '<div class="hm-group-title">Fly</div>' +
          toggleRow("misc", "fly", "Fly Mode") +
          sliderRow("misc", "flySpeed", "Fly Speed", 0.05, 1, 0.05) +
          keyRow("misc", "flyKey", "Fly Key") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Speed</div>' +
          toggleRow("misc", "speed", "Speed Hack") +
          sliderRow("misc", "speedMult", "Speed Multiplier", 1, 10, 0.5) +
          keyRow("misc", "speedKey", "Speed Key") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Exploits</div>' +
          '<div class="hm-row"><span class="hm-label">Kill All</span><button class="hm-action-btn danger" id="hm-btn-killall">Execute</button></div>' +
          keyRow("misc", "killAllKey", "Kill All Key") +
          '<div class="hm-row"><span class="hm-label">Despawn All</span><button class="hm-action-btn danger" id="hm-btn-despawnall">Execute</button></div>' +
          keyRow("misc", "despawnAllKey", "Despawn Key") +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">General</div>' +
          keyRow("esp", "menuKey", "Menu Key") +
          selectRow("esp", "toggleKey", "ESP Toggle Key", ["Insert", "Delete", "End", "Home", "F1", "F2", "F3"]) +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Config</div>' +
          '<div class="hm-row"><span class="hm-label">Save Settings</span><button class="hm-action-btn" id="hm-btn-save">Save</button></div>' +
          '<div class="hm-row"><span class="hm-label">Reset to Defaults</span><button class="hm-action-btn danger" id="hm-btn-reset">Reset</button></div>' +
        '</div>' +
        '<div class="hm-group">' +
          '<div class="hm-group-title">Info</div>' +
          '<div class="hm-row"><span class="hm-label">Menu Key</span><span class="hm-label" style="color:rgba(255,255,255,0.4)">P</span></div>' +
          '<div class="hm-row"><span class="hm-label">Aim Key</span><span class="hm-label" style="color:rgba(255,255,255,0.4)">' + aimConfig.aimKey + '</span></div>' +
          '<div class="hm-row"><span class="hm-label">Players Tracked</span><span class="hm-label" id="hm-player-count" style="color:rgba(255,255,255,0.4)">0</span></div>' +
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
    var btnKill = body.querySelector("#hm-btn-killall");
    if (btnKill) btnKill.addEventListener("click", function() { executeKillAll(); });
    var btnDespawn = body.querySelector("#hm-btn-despawnall");
    if (btnDespawn) btnDespawn.addEventListener("click", function() { executeDespawnAll(); });
    var tbSave = menuContainer.querySelector("#hm-save");
    if (tbSave) tbSave.onclick = function() { saveConfig(); showToast("Config saved!"); };
  }

  function toggleMenu() {
    if (!menuContainer) createMenu();
    menuOpen = !menuOpen;
    menuContainer.classList.toggle("open", menuOpen);
    if (menuOpen) renderPanel();
  }

  function showToast(msg) {
    var existing = document.querySelector(".hm-toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "hm-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { if (toast.parentElement) toast.remove(); }, 2000);
  }

  window.addEventListener("keydown", function(e) {
    if (e.key === espConfig.menuKey || e.code === ("Key" + espConfig.menuKey.toUpperCase())) { e.preventDefault(); toggleMenu(); }
  });

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    while (!window.UnityWebModkit) await new Promise(function(r) { setTimeout(r, 50); });
    console.log("[BNGG] UnityWebModkit loaded");

    var pluginCtx = UnityWebModkit.Runtime.createPlugin({
      name: "BNGG_ESP",
      version: "2.0.0",
      referencedAssemblies: [
        'ACTK.Runtime.dll', 'GameAssembly.dll', 'System.Runtime.InteropServices.dll',
        'mscorlib.dll', "PhotonRealtime.dll", 'PhotonUnityNetworking.dll',
        'PhotonUnityNetworking.Utilities.dll', 'Assembly-CSharp.dll',
        'UnityEngine.CoreModule.dll', 'UnityEngine.PhysicsModule.dll',
        'StompyRobot.SRDebugger.dll', "UnityEngine.IMGUIModule.dll",
        "Photon3Unity3D.dll", 'Unity.TextMeshPro.dll',
        'UnityEngine.AnimationModule.dll',
      ]
    });
    ctx = pluginCtx;
    window.ctx = ctx;

    UnityWebModkit.Runtime.malloc = function(size) { return unityGameInstance.Module._malloc(size); };
    ctx.malloc = function(size) { return new UnityWebModkit.ValueWrapper(unityGameInstance.Module._malloc(size)); };

    // ============================================================
    // Capture CameraController for aimbot
    // ============================================================
    var camCtrlPtr = null;
    ctx.hookPrefix({
      typeName: "BattleLab.CameraSystem.CameraController", methodName: "Awake", params: ["i32", "i32"]
    }, function(thisPtr) { camCtrlPtr = thisPtr; });
    ctx.hookPrefix({
      typeName: "BattleLab.CameraSystem.CameraController", methodName: "OnDisable", params: ["i32", "i32"]
    }, function(thisPtr) { camCtrlPtr = null; });

    // NOTE: CameraController has no Update method in the new dump.
    // Camera recoil is now cleared in the render loop instead.

    // ============================================================
    // Character.FixedUpdate — fly + speed logic at physics rate
    // ============================================================
    ctx.hookPrefix({
      typeName: "ECM2.Characters.Character", methodName: "FixedUpdate", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        if (!window.unityGameInstance) return;
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [thisPtr]);
        if (!pvPtr || pvPtr.val() === 0) return;
        var isMine = ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pvPtr]).val() === 1;
        if (!isMine) return;

        localPlayerPtr = thisPtr;

        if (NORMAL_GRAVITY === null) {
          NORMAL_GRAVITY = readVec3(thisPtr, 0x6C);
        }

        if (miscConfig.fly) {
          try {
            writeVec3(thisPtr, 0x6C, { x: 0, y: 0, z: 0 });
            writeVec3(thisPtr, 0xCC, { x: 0, y: 0, z: 0 });

            var go = ctx.call("UnityEngine.Component", "get_gameObject", [thisPtr]);
            if (!go || go.val() === 0) return;
            var tr = ctx.call("UnityEngine.GameObject", "get_transform", [go]);
            if (!tr || tr.val() === 0) return;

            try {
              var charMovPtr = thisPtr.readField(0xB4, "ptr");
              if (charMovPtr && charMovPtr.val() !== 0) {
                var colPtr = charMovPtr.readField(0x118, "ptr");
                if (colPtr && colPtr.val() !== 0) {
                  ctx.call("UnityEngine.Behaviour", "set_enabled", [colPtr, 0]);
                }
              }
            } catch(e) {}

            if (flyPos === null) {
              var initBuf = getTransformPosBuf(tr);
              if (initBuf) {
                flyPos = readVector3(initBuf);
              }
            }

            if (flyPos) {
              var camPtr = ctx.call("UnityEngine.Camera", "get_main", []);
              if (camPtr && camPtr.val() !== 0) {
                var camTr = ctx.call("UnityEngine.Component", "get_transform", [camPtr]);
                if (camTr && camTr.val() !== 0) {
                  var fwdBuf = getBuf("fly_fwd", 0x1C);
                  ctx.call("UnityEngine.Transform", "get_forward", [fwdBuf, camTr]);
                  var fwd = readVector3(fwdBuf);

                  var rightBuf = getBuf("fly_right", 0x1C);
                  ctx.call("UnityEngine.Transform", "get_right", [rightBuf, camTr]);
                  var right = readVector3(rightBuf);

                  var dir = { x: 0, y: 0, z: 0 };
                  if (keysDown["w"] || keysDown["ArrowUp"])    { dir.x += fwd.x; dir.y += fwd.y; dir.z += fwd.z; }
                  if (keysDown["s"] || keysDown["ArrowDown"])   { dir.x -= fwd.x; dir.y -= fwd.y; dir.z -= fwd.z; }
                  if (keysDown["d"] || keysDown["ArrowRight"])  { dir.x += right.x; dir.y += right.y; dir.z += right.z; }
                  if (keysDown["a"] || keysDown["ArrowLeft"])   { dir.x -= right.x; dir.y -= right.y; dir.z -= right.z; }
                  if (keysDown[" "])                             { dir.y += 1; }
                  if (keysDown["Control"] || keysDown["c"])     { dir.y -= 1; }

                  var len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
                  if (len > 0) {
                    dir.x = dir.x / len * miscConfig.flySpeed;
                    dir.y = dir.y / len * miscConfig.flySpeed;
                    dir.z = dir.z / len * miscConfig.flySpeed;

                    flyPos.x += dir.x;
                    flyPos.y += dir.y;
                    flyPos.z += dir.z;
                  }

                  var newPos = getBuf("fly_newpos", 0x1C);
                  writeVec3(newPos, 0, flyPos);
                  ctx.call("UnityEngine.Transform", "set_position", [tr, newPos]);
                }
              }
            }
          } catch(e) {}
        } else {
          if (NORMAL_GRAVITY !== null) {
            var g = readVec3(thisPtr, 0x6C);
            if (g.x === 0 && g.y === 0 && g.z === 0) {
              writeVec3(thisPtr, 0x6C, NORMAL_GRAVITY);
            }
          }
        }

        if (miscConfig.speed && localPlayerPtr && localPlayerPtr.val() !== 0) {
          _fixedFrameCount++;
          if (_fixedFrameCount % 3 === 0) {
          try {
            if (!origSpeedVals) {
              origSpeedVals = {
                ground: intBitsToFloat(localPlayerPtr.readField(0x1D0, "i32").val() ^ localPlayerPtr.readField(0x1CC, "i32").val()),
                horiz: intBitsToFloat(localPlayerPtr.readField(0x1E8, "i32").val() ^ localPlayerPtr.readField(0x1E4, "i32").val()),
                air: intBitsToFloat(localPlayerPtr.readField(0x290, "i32").val() ^ localPlayerPtr.readField(0x28C, "i32").val()),
                sprint: intBitsToFloat(localPlayerPtr.readField(0x2C0, "i32").val() ^ localPlayerPtr.readField(0x2BC, "i32").val()),
                modifier: intBitsToFloat(localPlayerPtr.readField(0x2D8, "i32").val() ^ localPlayerPtr.readField(0x2D4, "i32").val())
              };
              console.log("[BNGG SPEED] Saved originals: ground=" + origSpeedVals.ground + " horiz=" + origSpeedVals.horiz + " mod=" + origSpeedVals.modifier);
            }
            var m = miscConfig.speedMult;
            writeObscuredFloat(localPlayerPtr, 0x1CC, origSpeedVals.ground * m);
            writeObscuredFloat(localPlayerPtr, 0x1E4, origSpeedVals.horiz * m);
            writeObscuredFloat(localPlayerPtr, 0x28C, origSpeedVals.air * m);
            writeObscuredFloat(localPlayerPtr, 0x2BC, origSpeedVals.sprint * m);
          } catch(e) {}
          }
        } else if (origSpeedVals && localPlayerPtr && localPlayerPtr.val() !== 0) {
          try {
            writeObscuredFloat(localPlayerPtr, 0x1CC, origSpeedVals.ground);
            writeObscuredFloat(localPlayerPtr, 0x1E4, origSpeedVals.horiz);
            writeObscuredFloat(localPlayerPtr, 0x28C, origSpeedVals.air);
            writeObscuredFloat(localPlayerPtr, 0x2BC, origSpeedVals.sprint);
            origSpeedVals = null;
            console.log("[BNGG SPEED] Restored defaults");
          } catch(e) {}
        }
      } catch(e) {}
    });

    // ============================================================
    // WeaponsSystem.Update — capture local player's system
    // ============================================================
    try {
      ctx.hookPrefix({
        typeName: "WeaponsSystem", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try {
          if (!localPlayerPtr || localPlayerPtr.val() === 0) return;
          var wsGo = ctx.call("UnityEngine.Component", "get_gameObject", [thisPtr]);
          if (!wsGo || wsGo.val() === 0) return;
          var lpGo = ctx.call("UnityEngine.Component", "get_gameObject", [localPlayerPtr]);
          if (wsGo && lpGo && wsGo.val() === lpGo.val() && wsGo.val() !== 0) {
            if (!localWsPtr || localWsPtr.val() !== thisPtr.val()) {
              localWsPtr = thisPtr;
              console.log("[BNGG] WeaponsSystem captured: " + thisPtr.val());
            }
          }
        } catch(e) {}
      });
    } catch(e) {}

    // ============================================================
    // Character.Update — track players + patch weapon
    // ============================================================
    ctx.hookPrefix({
      typeName: "ECM2.Characters.Character", methodName: "Update", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        window.unityInstance = window.unityGameInstance;
        if (!window.unityGameInstance) return;
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [thisPtr]);
        if (!pvPtr || pvPtr.val() === 0) return;
        var isMine = ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pvPtr]).val() === 1;
        var actorNr = ctx.call("Photon.Pun.PhotonView", "get_ControllerActorNr", [pvPtr]).val();

        if (isMine) {
          localPlayerPtr = thisPtr;
          localPlayerActorNr = actorNr;
          try {
            var alreadyMaster = ctx.call("Photon.Pun.PhotonNetwork", "get_IsMasterClient", []).val();
            if (!alreadyMaster) {
              var lpPtr = ctx.call("Photon.Pun.PhotonNetwork", "get_LocalPlayer", []);
              if (lpPtr && lpPtr.val() !== 0) ctx.call("Photon.Pun.PhotonNetwork", "SetMasterClient", [lpPtr]);
            }
          } catch(e) {}
          patchCharacterWeapon(thisPtr);
          return;
        }

        var playerName = "Player " + actorNr;
        try {
          var ownerPtr = ctx.call("Photon.Pun.PhotonView", "get_Owner", [pvPtr]);
          if (ownerPtr && ownerPtr.val() !== 0) {
            var namePtr = ctx.call("Photon.Realtime.Player", "get_NickName", [ownerPtr]);
            if (namePtr && namePtr.val() !== 0) {
              var rawName = namePtr.mstr();
              if (rawName && rawName.length > 0) playerName = rawName;
            }
          }
        } catch(e) {}

        playerMap[actorNr] = {
          ptr: thisPtr,
          name: playerName,
          actorNr: actorNr,
          timestamp: Date.now()
        };
      } catch(e) {}
    });

    ctx.hookPrefix({
      typeName: "ECM2.Characters.Character", methodName: "OnDisable", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [thisPtr]);
        if (!pvPtr || pvPtr.val() === 0) return;
        var isMine = ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pvPtr]).val() === 1;
        var actorNr = ctx.call("Photon.Pun.PhotonView", "get_ControllerActorNr", [pvPtr]).val();
        if (isMine) {
          localPlayerPtr = null;
          localPlayerActorNr = -1;
          flyPos = null;
        } else {
          delete playerMap[actorNr];
        }
      } catch(e) {}
    });

    ctx.hookPrefix({
      typeName: "BattleLab.PlayerHealth", methodName: "OnPlayerKillMe", params: ["i32", "i32", "i32"]
    }, function(thisPtr) {
      try {
        var pvPtr = ctx.call("Photon.Pun.MonoBehaviourPun", "get_photonView", [thisPtr]);
        if (!pvPtr || pvPtr.val() === 0) return;
        var isMine = ctx.call("Photon.Pun.PhotonView", "get_IsMine", [pvPtr]).val() === 1;
        var actorNr = ctx.call("Photon.Pun.PhotonView", "get_ControllerActorNr", [pvPtr]).val();
        if (isMine) {
          flyPos = null;
        } else {
          delete playerMap[actorNr];
        }
      } catch(e) {}
    });

    console.log("[BNGG] Hooks registered");

    // ============================================================
    // RENDER LOOP — ESP + Aimbot + FOV Circle + Status
    // ============================================================
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      try {
        ensureCanvas();
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);

        if (!window.unityGameInstance) return;

        var inRoom = false;
        try { inRoom = ctx.call("Photon.Pun.PhotonNetwork", "get_InRoom", []).val(); } catch(e) {}
        if (!inRoom) { playerMap = {}; return; }

        var now = Date.now();
        var staleKeys = Object.keys(playerMap);
        for (var s = 0; s < staleKeys.length; s++) {
          if (now - playerMap[staleKeys[s]].timestamp > 500) delete playerMap[staleKeys[s]];
        }

        var camPtr = null;
        try { camPtr = ctx.call("UnityEngine.Camera", "get_main", []); } catch(e) {}
        if (!camPtr || camPtr.val() === 0) return;

        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;

        var aimActive = aimConfig.aimbot && isAimKeyHeld() && !menuOpen;

        if (aimActive && aimConfig.fovcircle) {
          ctx2d.beginPath();
          ctx2d.arc(cx, cy, aimConfig.fovsize, 0, Math.PI * 2);
          ctx2d.strokeStyle = "#ff4444";
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }

        var camPos = null;
        try {
          var camTrP = ctx.call("UnityEngine.Component", "get_transform", [camPtr]);
          if (camTrP && camTrP.val() !== 0) {
            var camPosBuf = getTransformPosBuf(camTrP);
            if (camPosBuf) {
              camPos = readVector3(camPosBuf);
            }
          }
        } catch(e) {}

        var bestTargetVec = null;
        var bestScore = Infinity;

        var keys = Object.keys(playerMap);

        for (var i = 0; i < keys.length; i++) {
          var data = playerMap[keys[i]];
          try {
            if (data.ptr === localPlayerPtr) continue;
            if (!data.ptr || data.ptr.val() === 0) { delete playerMap[keys[i]]; continue; }

            var go2 = ctx.call("UnityEngine.Component", "get_gameObject", [data.ptr]);
            if (!go2 || go2.val() === 0) continue;
            var tr2 = ctx.call("UnityEngine.GameObject", "get_transform", [go2]);
            if (!tr2 || tr2.val() === 0) continue;
            var posBuf2 = getTransformPosBuf(tr2);
            if (!posBuf2) continue;
            var posV = readVector3(posBuf2);

            var headY = posV.y + 1.7;
            var feetY = posV.y;

            var playerVisible = isPlayerVisible(data.ptr, { x: posV.x, y: headY, z: posV.z }, camPos, camPtr);

            var headBuf = getBuf("head", 0x1C);
            writeVec3(headBuf, 0, { x: posV.x, y: headY, z: posV.z });

            var feetBuf = getBuf("feet", 0x1C);
            writeVec3(feetBuf, 0, { x: posV.x, y: feetY, z: posV.z });

            var headScreen = worldToScreen(headBuf, camPtr);
            var feetScreen = worldToScreen(feetBuf, camPtr);

            if (!headScreen || !feetScreen || headScreen.z < 0.01 || feetScreen.z < 0.01) continue;

            if (espConfig.enabled) {
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
                drawCornerBox(headScreen.x, headScreen.y, feetScreen.x, feetScreen.y, espConfig.boxColor, espConfig.boxThickness);
              }

              if (espConfig.name) {
                ctx2d.font = "bold " + espConfig.nameSize + "px sans-serif";
                ctx2d.fillStyle = espConfig.nameColor;
                ctx2d.textAlign = "center";
                ctx2d.fillText(data.name, midX, feetScreen.y + 18);
              }

              if (espConfig.distance && camPos) {
                var dist = Math.sqrt(
                  (posV.x - camPos.x) * (posV.x - camPos.x) +
                  (posV.y - camPos.y) * (posV.y - camPos.y) +
                  (posV.z - camPos.z) * (posV.z - camPos.z)
                );
                ctx2d.font = espConfig.distanceSize + "px sans-serif";
                ctx2d.fillStyle = espConfig.distanceColor;
                ctx2d.fillText(Math.round(dist) + "m", midX, feetScreen.y + 32);
              }
            }

            if (aimActive) {
              if (aimConfig.vischeck && !playerVisible) continue;
              var score;
              if (aimConfig.aimType === "Closest") {
                if (camPos) {
                  var ddx = posV.x - camPos.x, ddy = posV.y - camPos.y, ddz = posV.z - camPos.z;
                  score = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
                } else {
                  score = Infinity;
                }
              } else {
                var dxc = headScreen.x - cx, dyc = headScreen.y - cy;
                score = Math.sqrt(dxc * dxc + dyc * dyc);
              }
              if (aimConfig.fovcircle && score > aimConfig.fovsize) continue;
              if (score < bestScore) {
                bestScore = score;
                bestTargetVec = { x: posV.x, y: headY + aimConfig.aimHeight, z: posV.z };
              }
            }
          } catch(e) {}
        }

        if (aimActive && bestTargetVec && camCtrlPtr && camPos) {
          var dx = bestTargetVec.x - camPos.x;
          var dy = bestTargetVec.y - camPos.y;
          var dz = bestTargetVec.z - camPos.z;
          var targetYaw = normalizeAngle(Math.atan2(dx, dz) * (180 / Math.PI));
          var horizDist = Math.sqrt(dx * dx + dz * dz);
          var targetPitch = Math.max(-86, Math.min(86, Math.atan2(dy, horizDist) * (180 / Math.PI)));
          var speed = aimConfig.aimSpeed;
          try {
            if (speed >= 1) {
              camCtrlPtr.writeField(0x54, "f32", targetYaw);
              camCtrlPtr.writeField(0x58, "f32", -targetPitch);
            } else {
              var curYaw = camCtrlPtr.readField(0x54, "f32").val();
              var curPitch = camCtrlPtr.readField(0x58, "f32").val();
              camCtrlPtr.writeField(0x54, "f32", curYaw + normalizeAngle(targetYaw - curYaw) * speed);
              camCtrlPtr.writeField(0x58, "f32", curPitch + ((-targetPitch) - curPitch) * speed);
            }
          } catch(e) {}
        }

        if (weaponConfig.noRecoil && camCtrlPtr && camCtrlPtr.val() !== 0) {
          try {
            camCtrlPtr.writeField(0xC4, "f32", 0);
            camCtrlPtr.writeField(0xC8, "f32", 0);
            camCtrlPtr.writeField(0xCC, "f32", 0);
          } catch(e) {}
        }
      } catch(e) {}
    }
    requestAnimationFrame(renderLoop);
    console.log("[BNGG] Render started");

    setInterval(function() {
      var el = document.getElementById("hm-player-count");
      if (el) el.textContent = Object.keys(playerMap).length;
    }, 500);
  }

  createMenu();
  loadConfig();
  init();
})();