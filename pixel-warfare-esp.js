// ==UserScript==
// @name        PW Box ESP
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
  var nameCache = {};     // actorNr → resolved nickname (Photon NickName, once per actor)
  var _reusableBufs = {};
  var _spanDebugOnce = false;
  var localGcPtr = null;       // gc pointer for the local (IsMine) player
  var mouseLookFr = null;      // fr (mouseLook) for Direct aim — yaw @0x1C, pitch @0x20
  var mouseLookFs = null;      // fs (mouseLook) for Direct aim — pitch @0x2C (if separate)
  var mouseLookStamp = 0;      // timestamp: detect stale pointers
  var _frDebugOnce = false;

  // ============================================================
  // CONFIG
  // ============================================================
  var espConfig = {
    enabled: true,
    toggleKey: "Insert",
    box: true,
    boxThickness: 2,
    boxColor: "#ff0000",
    boxWidth: 0.6,        // box width as fraction of height (blocky models: 0.6)
    boxHeight: 1.8,       // fallback height when hitboxes can't be read
    boxAutoHeight: true,  // resolve exact top/bottom from the real hitbox colliders
    heightAdj: 0,         // meters added to the resolved top for fine tuning
    tracer: true,         // line from screen bottom-center to each player's feet
    tracerThickness: 1.5,
    tracerColor: "#ff00ff",
    name: true,           // nickname above/below each box (Photon NickName)
    nameSize: 13,
    nameColor: "#ffffff",
    debug: false          // true → one-shot console diagnostic on hitbox resolution
  };

  // ============================================================
  // AIMBOT — dual-method, adapted from Buildnow.gg + Poxel V4.
  //   "Direct" — writes yaw/pitch to the fr/fs mouseLook component
  //              fields via dump.cs offsets (most reliable).
  //   "Mouse"  — synthetic mousemove deltas (Poxel V4 fallback).
  // Target selection = closest projected head point to the crosshair.
  // ============================================================
  var aimConfig = {
    enabled: false,           // toggled with "O" key
    toggleKey: "o",
    key: "Right Click",       // Right Click | Left Click | Middle Click | Side1 | Side2
    aimType: "Direct",        // Direct | Mouse
    aimBone: "Head",          // Head | Chest
    headOffset: 0.15,         // meters below the box top where the head center sits
    speed: 0.55,              // fraction of the remaining gap applied per frame (1 = snap)
    fovcircle: true,          // draw the activation radius while aiming
    fovsize: 220              // px; targets farther than this are ignored
  };

  var mouseDown = { 0: false, 1: false, 2: false, 3: false, 4: false };
  window.addEventListener("mousedown", function(e) { mouseDown[e.button] = true; }, true);
  window.addEventListener("mouseup",   function(e) { mouseDown[e.button] = false; }, true);
  window.addEventListener("contextmenu", function(e) { e.preventDefault(); }, true);

  function isAimKeyHeld() {
    var k = aimConfig.key;
    if (k === "Right Click")  return mouseDown[2];
    if (k === "Left Click")   return mouseDown[0];
    if (k === "Middle Click") return mouseDown[1];
    if (k === "Side1")        return mouseDown[3];
    if (k === "Side2")        return mouseDown[4];
    return false;
  }

  window.addEventListener("keydown", function(e) {
    if (e.key === espConfig.toggleKey || e.code === espConfig.toggleKey) {
      espConfig.enabled = !espConfig.enabled;
      console.log("[PW ESP] " + (espConfig.enabled ? "ON" : "OFF"));
    }
    if (e.key === aimConfig.toggleKey || e.code === ("Key" + aimConfig.toggleKey.toUpperCase())) {
      aimConfig.enabled = !aimConfig.enabled;
      console.log("[PW AIM] " + (aimConfig.enabled ? "ON" : "OFF"));
    }
  }, true);

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
  // Memory / Unity helpers — Buildnow.gg shapes
  // ============================================================
  function getBuf(id, size) {
    if (!_reusableBufs[id]) _reusableBufs[id] = ctx.malloc(size);
    return _reusableBufs[id];
  }

  // Transform.get_position(ret*=buffer-first, this) — Vector3 return uses a
  // hidden ret buffer as the first wasm arg (script.json TypeSignature iiii).
  // Sentinel: a silent native failure leaves the SHARED buffer unwritten —
  // detect NaN instead of returning stale coords from the previous player.
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

  // ============================================================
  // WorldToScreenPoint — BY ADDRESS, never by the _Injected variant.
  //
  // script.json / dump.cs (Pixel Warfare):
  //   92905  Camera$$WorldToScreenPoint  (Vector3, MonoOrStereoscopicEye) — iiiii
  //   92908  Camera$$WorldToScreenPoint  (Vector3)                       — iiii  <-- we use this
  //   92997  Camera$$WorldToScreenPoint_Injected                          — viiiii
  //
  // The runtime's scriptData renames overloaded methods to Method_<tableIndex>
  // when names collide, where <tableIndex> === the Address in script.json.
  // The wasm ABI of 92908 is (ret*, this, position): buffer-first, then camera,
  // then the Vector3 — exactly what Buildnow.gg passes for its own 9204.
  // WorldToScreenPoint_Injected (92997) has a DIFFERENT ABI: (self, position,
  // eye, ret) — calling it with our buffer-first shape jumbles the args
  // (camera ptr in as position, no ret buffer) and just throws or garbage.
  // ============================================================
  function worldToScreen(posBuf, camPtr) {
    var scrBuf = getBuf("w2s", 0x1C);
    scrBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Camera", "WorldToScreenPoint_92908", [scrBuf, camPtr, posBuf]);
      var sx = scrBuf.readField(0x0, "f32").val();
      if (sx !== sx) return null; // NaN => call failed
      var sy = scrBuf.readField(0x4, "f32").val();
      var z = scrBuf.readField(0x8, "f32").val();
      return { x: sx, y: canvas.height - sy, z: z };
    } catch(e) {
      return null;
    }
  }

  // ============================================================
  // EXACT box height — Pixel Warfare's KinematicCharacterMotor-equivalent.
  // Poxel reads a KinematicCharacterMotor capsule (CapsuleHeight/@0x18,
  // CapsuleYOffset/@0x1C); Pixel Warfare instead stores the REAL shootable
  // hitboxes on gc itself, so we read those:
  //
  //   gc.hitBoxes @0xE8      → List<gc.HitBoxes>
  //     List._items @0x8     → gc.HitBoxes[]      (array)
  //     array length @0xC    → element count (klass 0x0, monitor 0x4,
  //                            bounds 0x8, length 0xC, data 0x10 — wasm32,
  //                            4-byte pointers; matches ArrayList @0x8/0xC)
  //     element i @0x10+4*i  → gc.HitBoxes { Collider box @0x8 }
  //
  //   Collider.get_bounds — script.json: unique key, Address 99839,
  //   TypeSignature "iii" = struct return → wasm ABI (ret*, this). Bounds
  //   layout: { center Vector3 @0x0, extents Vector3 @0xC }.
  //   ⚠ Collider lives in UnityEngine.PhysicsModule.dll — the assembly MUST
  //   be in referencedAssemblies or scriptData has no Collider methods
  //   (ctx.call throws) and the hitbox chain silently no-ops.
  //
  // Each source is isolated in its own try/catch: a hitbox-list throw must
  // not prevent the ExplosionHit anchors from resolving.
  // ============================================================
  function getHitboxSpan(gcPtr, py, px, pz) {
    var top = -Infinity, bottom = Infinity, any = false;
    var hbDone = false, ehtUsed = false, ehbUsed = false;

    // 1) Real shootable hitboxes: gc.hitBoxes → Collider.get_bounds.
    //    Only accept colliders that sit INSIDE the live body band around
    //    the player root (py): vertical [py-1.0, py+2.6] and within ~1.5 m
    //    horizontally. The raw list can contain parked ragdoll / death /
    //    explosion colliders whose bounds lie meters away — those used to
    //    drag the union bottom ~10 m below the map and stretch the box.
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
              if (cx !== cx || cy !== cy || cz !== cz || ey !== ey) continue; // NaN sentinel
              var dx = cx - px, dz = cz - pz;
              if (cy < py - 1.0 || cy > py + 2.6) continue;                       // vertical band
              if (dx * dx + dz * dz > 2.25) continue;                            // horizontal band
              var t = cy + ey, b = cy - ey;
              if (isFinite(t) && isFinite(b)) {
                any = true; hbDone = true;
                if (t > top) top = t;
                if (b < bottom) bottom = b;
              }
            }
          }
        }
      }
    } catch(e) { /* Collider scriptData/key issue — anchors below still run */ }

    // 2) ExplosionHitTop (gc @0x2C) / ExplosionHitBottom (gc @0x34) — live
    //    child Transforms marking head-top / lower body for grenade math.
    //    World Y read via Transform.get_position, same as the root. Union
    //    them so the box hugs the FULL silhouette even where hitbox
    //    colliders undershoot (or don't exist on remote players).
    try {
      var ehtW = gcPtr.readField(0x2C, "i32");
      if (ehtW && ehtW.val() !== 0) {
        var ep = getTransformPosBuf(ehtW);
        if (ep) {
          var ehY = ep.readField(0x4, "f32").val();
          if (isFinite(ehY) && ehY >= py && ehY <= py + 2.6) {
            var et = ehY + 0.1; // small pad: include the head block above the anchor
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

    return any ? { top: top, bottom: bottom, hb: hbDone, eht: ehtUsed, ehb: ehbUsed } : null;
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
  // INIT — Buildnow.gg init shape
  // ============================================================
  async function init() {
    while (!window.UnityWebModkit) await new Promise(function(r) { setTimeout(r, 50); });
    console.log("[PW ESP] UnityWebModkit loaded");

    var pluginCtx = UnityWebModkit.Runtime.createPlugin({
      name: "PW_ESP",
      version: "1.0.0",
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

    // BNGG sets these to Module._malloc; the loader's own malloc already
    // returns a ValueWrapper, so only override when the unity globals exist
    // (referencing an undefined global here would kill init silently).
    // The loader's internal call path uses `window.unityInstance || game` —
    // alias whichever global the CrazyGames gameframe actually defined.
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
    // gc.Update — track players (Buildnow.gg Character.Update slot)
    //
    // gc = Pixel Warfare player class (dump.cs):
    //   SpawnID @0x24, iszomby @0x3C, currentHp @0xEC, PlayerIsDead @0x134
    //   gc : MonoBehaviourPunCallbacks : MonoBehaviourPun (has photonView)
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
        if (isMine) { localGcPtr = thisPtr; return; }
        var actorNr = ctx.call("Photon.Pun.PhotonView", "get_ControllerActorNr", [pvPtr]).val();

        // NickName — resolved once per actor (cached), Buildnow.gg pattern:
        //   PhotonView.get_Owner → Photon.Realtime.Player.get_NickName → mstr()
        //   (PhotonRealtime.dll MUST be in referencedAssemblies for the key
        //    to exist, same rule as UnityEngine.PhysicsModule.dll.)
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

    // gc has no OnDisable — stale entries fall out via the 500ms timestamp
    // sweep in the render loop (also covers respawns/leaves).

    // ============================================================
    // fr.Update + fs.Update — capture the local player's mouseLook
    // pointers for "Direct" aim.
    //
    // Chain: fr.kan / fs.kas @0x30 → hr (weapon manager)
    //        hr.motor @0x98        → fp (FPS controller)
    //        fp.jzz @0xD4          → gc (player class)
    //        gc === localGcPtr     → belongs to us
    //
    // fr fields: kak @0x1C (yaw), kal @0x20 (pitch, clamped by minimumY/maximumY)
    // fs fields: kar @0x2C (pitch, clamped) — used if pitch is on a separate component
    // ============================================================
    function isLocalMouseLook(thisPtr) {
      if (!localGcPtr || localGcPtr.val() === 0) return false;
      var hrW = thisPtr.readField(0x30, "i32");
      if (!hrW || hrW.val() === 0) return false;
      var fpW = hrW.readField(0x98, "i32");
      if (!fpW || fpW.val() === 0) return false;
      var gcW = fpW.readField(0xD4, "i32");
      if (!gcW || gcW.val() === 0) return false;
      return gcW.val() === localGcPtr.val();
    }

    try {
      ctx.hookPrefix({
        typeName: "fr", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try {
          if (isLocalMouseLook(thisPtr)) {
            mouseLookFr = thisPtr;
            mouseLookStamp = Date.now();
            if (!_frDebugOnce) {
              _frDebugOnce = true;
              var ax = thisPtr.readField(0x10, "i32").val();
              console.log("[PW AIM] fr captured (axes=" + ax + ", ptr=" + thisPtr.val() + ")");
            }
          }
        } catch(e) {}
      });
    } catch(e) { console.log("[PW AIM] fr hook fail: " + (e && e.message ? e.message : e)); }

    try {
      ctx.hookPrefix({
        typeName: "fs", methodName: "Update", params: ["i32", "i32"]
      }, function(thisPtr) {
        try {
          if (isLocalMouseLook(thisPtr)) {
            mouseLookFs = thisPtr;
            mouseLookStamp = Date.now();
          }
        } catch(e) {}
      });
    } catch(e) { console.log("[PW AIM] fs hook fail: " + (e && e.message ? e.message : e)); }

    console.log("[PW ESP] Hooks registered");

    // ============================================================
    // RENDER LOOP — box ESP only
    // ============================================================
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      try {
        // Idle until Unity actually exists in this frame (wrapper pages stay quiet)
        if (!window.unityInstance) return;

        ensureCanvas();
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);

        if (!espConfig.enabled) return;

        var now = Date.now();
        var staleKeys = Object.keys(playerMap);
        for (var s = 0; s < staleKeys.length; s++) {
          if (now - playerMap[staleKeys[s]].timestamp > 500) delete playerMap[staleKeys[s]];
        }

        var camPtr = null;
        try { camPtr = ctx.call("UnityEngine.Camera", "get_main", []); } catch(e) {}
        if (!camPtr || camPtr.val() === 0) return;

        // Aim bookkeeping (BNGG shape): crosshair center, activation state,
        // FOV circle, and the running best candidate.
        var aimActive = aimConfig.enabled && isAimKeyHeld();
        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;
        var bestAimD = Infinity, bestAimX = 0, bestAimY = 0;
        var bestTargetWorld = null; // { x, y, z } for Direct aim type
        if (aimActive && aimConfig.fovcircle) {
          ctx2d.beginPath();
          ctx2d.arc(cx, cy, aimConfig.fovsize, 0, Math.PI * 2);
          ctx2d.strokeStyle = "#ff4444";
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }

        var keys = Object.keys(playerMap);
        for (var i = 0; i < keys.length; i++) {
          var data = playerMap[keys[i]];
          try {
            if (!data.ptr || data.ptr.val() === 0) { delete playerMap[keys[i]]; continue; }

            // gc.PlayerIsDead (dump.cs @0x134)
            var deadW = data.ptr.readField(0x134, "i32");
            if (deadW && (deadW.val() & 0xff)) continue;

            var trPtr = ctx.call("UnityEngine.Component", "get_transform", [data.ptr]);
            if (!trPtr || trPtr.val() === 0) continue;
            var posBuf = getTransformPosBuf(trPtr);
            if (!posBuf) continue;
            var px = posBuf.readField(0x0, "f32").val();
            var py = posBuf.readField(0x4, "f32").val();
            var pz = posBuf.readField(0x8, "f32").val();

            // Exact box: top (and feet, when colliders dip below root)
            // come from the hitbox unit; fallback keeps the old fixed box.
            var topY = null, feetY = py;
            if (espConfig.boxAutoHeight) {
              var span = getHitboxSpan(data.ptr, py, px, pz);
              if (span && span.top > span.bottom) {
                var rel = span.top - py;
                if (rel > 0.3 && rel < 3.2) {
                  topY = span.top + (espConfig.heightAdj || 0);
                  // Feet: only accept a hitbox bottom that is a small dip
                  // below the root — anything far below is a stray collider.
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
                : span ? "top=" + span.top.toFixed(2) + " [" + via + "] (rejected by sanity guard → fallback)"
                  : "NOT RESOLVED → fallback fixed height"));
            }

            var headBuf = getBuf("head", 0x1C);
            headBuf.writeField(0x0, "f32", px);
            headBuf.writeField(0x4, "f32", topY);
            headBuf.writeField(0x8, "f32", pz);
            var feetBuf = getBuf("feet", 0x1C);
            feetBuf.writeField(0x0, "f32", px);
            feetBuf.writeField(0x4, "f32", feetY);
            feetBuf.writeField(0x8, "f32", pz);

            var headScreen = worldToScreen(headBuf, camPtr);
            var feetScreen = worldToScreen(feetBuf, camPtr);
            if (!headScreen || !feetScreen) continue;
            if (headScreen.z < 0.01 || feetScreen.z < 0.01) continue;

            if (espConfig.box) {
              drawCornerBox(headScreen.x, headScreen.y, feetScreen.x, feetScreen.y, espConfig.boxColor, espConfig.boxThickness, espConfig.boxWidth);
            }

            var midX = (headScreen.x + feetScreen.x) / 2;

            // Tracer — from screen bottom-center to the player's feet
            // (Buildnow.gg draw shape, without its visibility split).
            if (espConfig.tracer) {
              ctx2d.strokeStyle = espConfig.tracerColor;
              ctx2d.lineWidth = espConfig.tracerThickness;
              ctx2d.beginPath();
              ctx2d.moveTo(window.innerWidth / 2, window.innerHeight);
              ctx2d.lineTo(feetScreen.x, feetScreen.y);
              ctx2d.stroke();
            }

            // Nickname — below the feet, box-centered (BNGG placement).
            if (espConfig.name) {
              ctx2d.font = "bold " + espConfig.nameSize + "px sans-serif";
              ctx2d.fillStyle = espConfig.nameColor;
              ctx2d.textAlign = "center";
              ctx2d.fillText(String(data.name || ("Player " + data.actorNr)), midX, feetScreen.y + 18);
            }

            // Aim candidate — projected head/chest point, scored against the
            // crosshair (BNGG "Closest" scoring; Poxel V4 getTargets shape).
            if (aimActive) {
              var asx, asy;
              if (aimConfig.aimBone === "Chest") {
                asx = midX;
                asy = (headScreen.y + feetScreen.y) / 2;
              } else {
                // px-per-meter of this player's on-screen box → place the aim
                // point just under the box top (head center).
                var mH = topY - feetY;
                if (mH > 0.01) {
                  var pxPerM = (feetScreen.y - headScreen.y) / mH;
                  asx = midX;
                  asy = headScreen.y + aimConfig.headOffset * pxPerM;
                }
              }
              if (isFinite(asx)) {
                var dsc = Math.sqrt((asx - cx) * (asx - cx) + (asy - cy) * (asy - cy));
                if ((!aimConfig.fovcircle || dsc <= aimConfig.fovsize) && dsc < bestAimD) {
                  bestAimD = dsc;
                  bestAimX = asx;
                  bestAimY = asy;
                  bestTargetWorld = aimConfig.aimBone === "Chest"
                    ? { x: px, y: (topY + feetY) / 2, z: pz }
                    : { x: px, y: topY - aimConfig.headOffset, z: pz };
                }
              }
            }
          } catch(e) {}
        }

        // ============================================================
        // Apply aim — "Direct" writes yaw/pitch to the fr/fs mouseLook
        // fields; "Mouse" dispatches synthetic mouse deltas as fallback.
        // ============================================================
        if (aimActive && bestAimD < Infinity) {
          var appliedDirect = false;

          // Direct — calculate world-space angles and write to fr/fs fields
          if (aimConfig.aimType === "Direct" && mouseLookFr && bestTargetWorld
              && (Date.now() - mouseLookStamp) < 1000) {
            try {
              var camTrA = ctx.call("UnityEngine.Component", "get_transform", [camPtr]);
              if (camTrA && camTrA.val() !== 0) {
                var cpB = getTransformPosBuf(camTrA);
                if (cpB) {
                  var cpx = cpB.readField(0x0, "f32").val();
                  var cpy = cpB.readField(0x4, "f32").val();
                  var cpz = cpB.readField(0x8, "f32").val();
                  var adx = bestTargetWorld.x - cpx;
                  var ady = bestTargetWorld.y - cpy;
                  var adz = bestTargetWorld.z - cpz;

                  var tYaw = Math.atan2(adx, adz) * (180 / Math.PI);
                  var hDst = Math.sqrt(adx * adx + adz * adz);
                  var tPitch = Math.max(-86, Math.min(86,
                    Math.atan2(ady, hDst) * (180 / Math.PI)));

                  var sp = aimConfig.speed;
                  // fr: kak @0x1C = yaw, kal @0x20 = pitch
                  var cYaw  = mouseLookFr.readField(0x1C, "f32").val();
                  var cPitch = mouseLookFr.readField(0x20, "f32").val();
                  // normalize yaw delta to [-180,180] so the lerp takes the short path
                  var dYaw = tYaw - cYaw;
                  dYaw = dYaw - Math.round(dYaw / 360) * 360;
                  var nYaw  = sp >= 1 ? tYaw   : cYaw + dYaw * sp;
                  var nPitch = sp >= 1 ? tPitch : cPitch + (tPitch - cPitch) * sp;

                  mouseLookFr.writeField(0x1C, "f32", nYaw);
                  mouseLookFr.writeField(0x20, "f32", nPitch);

                  // fs: kar @0x2C = pitch (if pitch lives on a separate component)
                  if (mouseLookFs) {
                    try {
                      var cP2 = mouseLookFs.readField(0x2C, "f32").val();
                      mouseLookFs.writeField(0x2C, "f32",
                        sp >= 1 ? tPitch : cP2 + (tPitch - cP2) * sp);
                    } catch(e2) {}
                  }
                  appliedDirect = true;
                }
              }
            } catch(e) {}
          }

          // Mouse fallback — synthetic movementX/Y (Poxel V4 shape)
          if (!appliedDirect) {
            var moveX = (bestAimX - cx) * aimConfig.speed;
            var moveY = (bestAimY - cy) * aimConfig.speed;
            var evTarget = document.pointerLockElement
              || document.querySelector("canvas") || document;
            evTarget.dispatchEvent(new MouseEvent("mousemove", {
              clientX: cx,
              clientY: cy,
              movementX: moveX,
              movementY: moveY,
              bubbles: true,
              composed: true
            }));
          }
        }
      } catch(e) {}
    }
    requestAnimationFrame(renderLoop);
    console.log("[PW ESP] Render started");
  }

  init().catch(function(e) {
    console.log("[PW ESP] init failed: " + (e && e.message ? e.message : e));
  });
})();
