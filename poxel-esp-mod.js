// ==UserScript==
// @name         Poxel.io Box ESP
// @match        *://poxel.io/*
// @match        *://*.poxel.io/*
// @match        *://*.crazygames.com/*
// @require      https://raw.githubusercontent.com/Recte-Development/rectehoststuff/refs/heads/main/m39rectescriptloaderplsdontfailme
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  var canvas, ctx2d, ctx;
  var localPlayerPtr = null;
  var playerMap = {};
  var _bufs = {};
  var charcamPtr = null;   // CharacterCamera.Update hook (V4 hooks.js:93-98)
  var mcPtr = null;        // MovementController.Update hook (V4 hooks.js:319-326)
  var selfTrPtr = null;    // local player transform (cached)
  var capTopY = 0;         // capsule top height above root (motor, resolved once)
  var mouseDown = {};
  var keysDown = {};

  // ---------- Settings (persisted to localStorage) ----------
  var DEFAULTS = {
    visuals: {
      esp: true,
      boxes: true, boxColor: "#ff0000", boxThickness: 2, boxType: "Corner", heightAdj: 0,
      skeleton: true, skeletonColor: "#00ffff", skeletonThickness: 1,
      names: true, nameColor: "#9a95b9", nametagsHealth: true,
      distance: true,
      tracers: true, tracerColor: "#8a2be2", tracerThickness: 2,
      bulletTracers: true, bulletTracerStartColor: "#ff0000", bulletTracerEndColor: "#0000ff",
      bulletTracerThickness: 5, bulletTracerLifetime: 1500,
      offscreenarrows: true, arrowdist: 200, arrowcolor: "#2600ff", arrowsize: 1
    },
    aimbot: {
      aimbot: true,
      aimbotType: "Silent",
      aimBone: "Neck",
      aimSpeed: 1,
      aimKey: "RightMouse",
      teamCheck: true
    },
    gun: {
      fastSwitch: true,
      noRecoil: false,
      infAmmo: false,
      customFireRate: false,
      fireRate: 60,
      noGun: false,
      noHands: false
    },
    exploit: {
      killAll: false,
      oneShot: false,
      randomHit: false
    },
    settings: {
      menuKey: "ShiftRight"
    }
  };
  var config = JSON.parse(JSON.stringify(DEFAULTS));
  var menuOpen = false;
  var keybindTarget = null;
  var _saveTimer = null;
  var bullets = [];
  var currentMode = null;
  var ignoreNextShoot = false;

  function deepMerge(t, s) {
    for (var k in s) {
      if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) {
        if (!t[k] || typeof t[k] !== "object") t[k] = {};
        deepMerge(t[k], s[k]);
      } else t[k] = s[k];
    }
    return t;
  }
  function saveConfig() {
    try { localStorage.setItem("poxel_mod_config", JSON.stringify(config)); } catch(e) {}
  }
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveConfig, 250);
  }
  function loadConfig() {
    try {
      var s = localStorage.getItem("poxel_mod_config");
      if (s) deepMerge(config, JSON.parse(s));
    } catch(e) {}
  }

  // V4 humanbodybones.js
  var BONES = {
    Neck: "Global/Root/gfx/Animated/poxel_rig_4/Armature.001/Rig1/Spine1/Spine2/Neck1",
    Chest: "Global/Root/gfx/Animated/poxel_rig_4/Armature.001/Rig1/Spine1/Spine2",
    Hips: "Global/Root/gfx/Animated/poxel_rig_4/Armature.001/Rig1"
  };

  // V4 humanbodybones.js boneLinks — 10 effective links (V4's hand/foot links
  // duplicate their joint paths and would draw zero-length lines)
  var RP = "Global/Root/gfx/Animated/poxel_rig_4/Armature.001/Rig1/";
  var BONE_LINKS = [
    [RP + "Spine1", RP + "Spine1/Spine2"],
    [RP + "Spine1/Spine2", RP + "Spine1/Spine2/Neck1"],
    [RP + "Spine1/Spine2", RP + "Spine1/Spine2/ArmR1"],
    [RP + "Spine1/Spine2/ArmR1", RP + "Spine1/Spine2/ArmR1/ArmR2"],
    [RP + "Spine1/Spine2", RP + "Spine1/Spine2/ArmL1"],
    [RP + "Spine1/Spine2/ArmL1", RP + "Spine1/Spine2/ArmL1/ArmL2"],
    [RP + "Spine1", RP + "LegR1"],
    [RP + "LegR1", RP + "LegR1/LegR2"],
    [RP + "Spine1", RP + "LegL1"],
    [RP + "LegL1", RP + "LegL1/LegL2"]
  ];

  function getBuf(id, size) {
    if (!_bufs[id]) _bufs[id] = ctx.malloc(size);
    return _bufs[id];
  }

  function readVec3(buf) {
    return {
      x: buf.readField(0x0, "f32").val(),
      y: buf.readField(0x4, "f32").val(),
      z: buf.readField(0x8, "f32").val()
    };
  }

  function writeVec3(buf, v) {
    buf.writeField(0x0, "f32", v.x);
    buf.writeField(0x4, "f32", v.y);
    buf.writeField(0x8, "f32", v.z);
  }

  // V4 creates a fresh mstr on every call (structs.js:809). il2cpp_string_new
  // results are NOT rooted — caching them lets Unity's GC free them, after
  // which Find silently fails on the dangling string. Never cache mstrs.
  function getMstr(path) {
    return ctx.createMstr(path);
  }

  // Bone transform per player per path — Find runs once, cached in data.boneTrs.
  // Entries expire: nulls retry after 1s (spawn timing), live pointers refresh
  // after 3s — the rig/gfx is re-created on respawn without OnDisable firing,
  // which would otherwise leave dead pointers cached forever.
  function boneTrCached(data, tr, path) {
    if (!data.boneTrs) data.boneTrs = {};
    var e = data.boneTrs[path];
    var now = Date.now();
    if (e !== undefined &&
        ((e.t === null && now - e.ts < 1000) || (e.t !== null && now - e.ts < 3000))) {
      return e.t;
    }
    var t = null;
    try {
      var r = ctx.call("UnityEngine.Transform", "Find", [tr, getMstr(path)]);
      if (r && r.val() !== 0) t = r;
    } catch(e2) {}
    data.boneTrs[path] = { t: t, ts: now };
    return t;
  }

  // Bone world position (JS copy). Drops the cache entry when the pointer is
  // dead so the next call re-Finds a live transform.
  function bonePosV(data, tr, path) {
    var bt = boneTrCached(data, tr, path);
    if (!bt) return null;
    var pb = getTransformPosBuf(bt);
    if (!pb) { delete data.boneTrs[path]; return null; }
    return readVec3(pb);
  }

  // Buildnow.gg(current mod).js:304 worldToScreen — single WorldToScreenPoint,
  // y-flip, null on throw. No viewport, no fallback, no state.
  function worldToScreen(posBuf, camPtr) {
    var scrBuf = getBuf("w2s", 0x1C);
    try {
      scrBuf.writeField(0x0, "f32", NaN);
      ctx.call("UnityEngine.Camera", "WorldToScreenPoint_1962", [scrBuf, camPtr, posBuf]);
      var sx = scrBuf.readField(0x0, "f32").val();
      if (sx !== sx) return null;
      var sy = scrBuf.readField(0x4, "f32").val();
      var z = scrBuf.readField(0x8, "f32").val();
      return { x: sx, y: canvas.height - sy, z: z };
    } catch(e) {
      return null;
    }
  }

  function getTransformPosBuf(transformPtr) {
    var posBuf = getBuf("tpos", 0x1C);
    // Sentinel: a silent native failure (destroyed rig after death) leaves the
    // buffer unwritten — detect it instead of returning stale coordinates
    // from a previous call (shared buffer = positions from other players).
    posBuf.writeField(0x0, "f32", NaN);
    try {
      ctx.call("UnityEngine.Transform", "get_position", [posBuf, transformPtr]);
    } catch(e) {
      return null;
    }
    var x = posBuf.readField(0x0, "f32").val();
    if (x !== x) return null;
    return posBuf;
  }

  // PoxelV4 render.js:429-463 — tracer fade color (verbatim)
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hexToRgb(color) {
    const rgba = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgba) return [+rgba[1], +rgba[2], +rgba[3]];
    let hex = color.replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (hex.length === 8) hex = hex.slice(0, 6);
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  function lerpHexColor(hex1, hex2, t) {
    const c1 = hexToRgb(hex1);
    const c2 = hexToRgb(hex2);
    return rgbToHex(
      Math.round(lerp(c1[0], c2[0], t)),
      Math.round(lerp(c1[1], c2[1], t)),
      Math.round(lerp(c1[2], c2[2], t))
    );
  }

  // PoxelV4 render.js:468 ESPThings — verbatim port (box code copied as-is)
  class ESPThings {
    constructor(ctx, feetpos, headpos) {
      this.feetpos = feetpos;
      this.headpos = headpos;
      this.ctx = ctx;
    }

    DrawBox(thickness, color) {
      const height = this.feetpos.y - this.headpos.y;
      const width = height * 0.6;
      const x = this.headpos.x - width / 2;
      const y = this.headpos.y;

      this.ctx.beginPath();
      this.ctx.rect(x, y, width, height);
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = thickness;
      this.ctx.stroke();
    }

    DrawCornerBox(color, thickness = 2, outline = false) {
      const height = this.feetpos.y - this.headpos.y;
      const width = height * 0.6;
      const x = this.headpos.x - width / 2;
      const y = this.headpos.y;

      const segmentW = width / 4;
      const segmentH = segmentW;

      const drawEdge = (x1, y1, x2, y2, strokeStyle, lineWidth) => {
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.strokeStyle = strokeStyle;
        this.ctx.lineWidth = lineWidth;
        this.ctx.stroke();
      };

      if (outline) {
        const outlineColor = "black";
        const outlineThickness = thickness + 2;

        // Top Left
        drawEdge(
          x - 1,
          y - 1,
          x - 1,
          y + segmentH + 1,
          outlineColor,
          outlineThickness,
        ); // vertical
        drawEdge(
          x - 1,
          y - 1,
          x + segmentW + 1,
          y - 1,
          outlineColor,
          outlineThickness,
        ); // horizontal

        // Top Right
        drawEdge(
          x + width + 1,
          y - 1,
          x + width + 1,
          y + segmentH + 1,
          outlineColor,
          outlineThickness,
        );
        drawEdge(
          x + width - segmentW - 1,
          y - 1,
          x + width + 1,
          y - 1,
          outlineColor,
          outlineThickness,
        );

        // Bottom Left
        drawEdge(
          x - 1,
          y + height - segmentH - 1,
          x - 1,
          y + height + 1,
          outlineColor,
          outlineThickness,
        );
        drawEdge(
          x - 1,
          y + height + 1,
          x + segmentW + 1,
          y + height + 1,
          outlineColor,
          outlineThickness,
        );

        // Bottom Right
        drawEdge(
          x + width + 1,
          y + height - segmentH - 1,
          x + width + 1,
          y + height + 1,
          outlineColor,
          outlineThickness,
        );
        drawEdge(
          x + width - segmentW - 1,
          y + height + 1,
          x + width + 1,
          y + height + 1,
          outlineColor,
          outlineThickness,
        );
      }

      // Colored main box lines

      // Top Left
      drawEdge(x, y, x, y + segmentH, color, thickness); // vertical
      drawEdge(x, y, x + segmentW, y, color, thickness); // horizontal

      // Top Right
      drawEdge(x + width, y, x + width - segmentW, y, color, thickness);
      drawEdge(x + width, y, x + width, y + segmentH, color, thickness);

      // Bottom Left
      drawEdge(x, y + height, x + segmentW, y + height, color, thickness);
      drawEdge(x, y + height, x, y + height - segmentH, color, thickness);

      // Bottom Right
      drawEdge(
        x + width,
        y + height,
        x + width - segmentW,
        y + height,
        color,
        thickness,
      );
      drawEdge(
        x + width,
        y + height,
        x + width,
        y + height - segmentH,
        color,
        thickness,
      );
    }

    DrawText(text, x, y, size = 16, color = "white") {
      this.ctx.font = `${size}px "Fredoka", sans-serif`;
      this.ctx.fillStyle = color;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(text, x, y);
    }

    DrawLine(from, to, color = "red", lineWidth = 2) {
      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(to.x, to.y);
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = lineWidth;
      this.ctx.stroke();
    }

    // V4 render.js:669 verbatim — vertical bar left of the box, fills bottom-up
    DrawHealthBar(health, maxHealth = 150, barWidth = 4, color, shield) {
      const height = this.feetpos.y - this.headpos.y;
      const boxwidth = height * 0.6;
      const x = this.headpos.x - boxwidth / 2 - barWidth + (shield ? -5 : -10);
      const y = this.headpos.y;

      health = Math.max(0, Math.min(health, maxHealth));
      const healthRatio = health / maxHealth;
      const filledHeight = height * healthRatio;

      this.ctx.beginPath();
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      this.ctx.fillRect(x, y, barWidth, height);

      this.ctx.beginPath();
      if (!shield)
        this.ctx.fillStyle =
          health > 60 ? color : health > 30 ? "#ffff00" : "#ff0000";
      else this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y + (height - filledHeight), barWidth, filledHeight);
    }
  }

  function ensureCanvas() {
    if (canvas && canvas.parentElement) return;
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999999;";
    document.body.appendChild(canvas);
    ctx2d = canvas.getContext("2d");
  }

  // ============================================================
  // AIMBOT — ported from PoxelV4 assets/aimbot.js
  // ============================================================
  window.addEventListener("mousedown", function(e) { mouseDown[e.button] = true; }, true);
  window.addEventListener("mouseup", function(e) { mouseDown[e.button] = false; }, true);
  window.addEventListener("keydown", function(e) { keysDown[e.code] = true; }, true);
  window.addEventListener("keyup", function(e) { keysDown[e.code] = false; }, true);

  function aimKeyHeld() {
    var k = config.aimbot.aimKey;
    if (k === "RightMouse") return !!mouseDown[2];
    if (k === "LeftMouse") return !!mouseDown[0];
    if (k === "MiddleMouse") return !!mouseDown[1];
    return !!keysDown[k];
  }

  // V4 render.js, verbatim
  function normalizeAngle(a) {
    a %= 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    return a;
  }
  function lerpAngle(a, b, t) {
    var delta = normalizeAngle(b - a);
    return normalizeAngle(a + delta * t);
  }

  // V4 render.js:160 isTeam — normalized team compare, FFA-style modes never team
  var TEAM_MODES = ["FFA", "Megaheads", "Gun Gamble", "Rocket Arena"];
  function playerTeam(ptr) {
    try {
      var psW = ctx.call("ColyBehaviour", "get_playerState", [ptr]);
      if (!psW || psW.val() === 0) return null;
      var t = psW.readField(0x3F, "i32").val(); // Player.team
      if (t >= 511) t -= 511;
      if (t >= 256) t -= 256;
      return t;
    } catch(e) { return null; }
  }
  function isTeamTarget(ptr) {
    if (!localPlayerPtr) return true;
    if (currentMode !== null && TEAM_MODES.indexOf(currentMode) !== -1) return false;
    var them = playerTeam(ptr);
    var me = playerTeam(localPlayerPtr);
    if (them === null || me === null) return true;
    return me === them;
  }

  // V4 getTargets() + main(): pick closest-to-center, aim by type.
  // frame[] is built by renderLoop ({data, tr, posV}) — no re-fetch per player.
  // Bone transforms cached per player per path (data.boneTrs), Find once only.
  function runAimbot(camPtr, cx, cy, frame) {
    if (!localPlayerPtr || !frame || frame.length === 0) return;
    var bonePath = BONES[config.aimbot.aimBone] || BONES.Neck;

    var entries = [];
    for (var i = 0; i < frame.length; i++) {
      var t = frame[i];
      try {
        var data = t.data;
        if (config.aimbot.teamCheck && isTeamTarget(data.ptr)) continue;
        // V4 aimbot.js:51 — skip dead players (transform can still resolve on corpses)
        try {
          var hpW = ctx.call("ColyBehaviour", "get_playerState", [data.ptr]);
          if (!hpW || hpW.val() === 0 || hpW.readField(0x38, "i32").val() < 1) continue;
        } catch(eH) { continue; }
        var bwp = bonePosV(data, t.tr, bonePath);
        if (!bwp) continue;
        var abuf = getBuf("aimW", 0x1C);
        writeVec3(abuf, bwp);
        var sp = worldToScreen(abuf, camPtr);
        if (!sp || sp.z < 0.01) continue;
        entries.push({ t: t, bwp: bwp, screen: sp, screenDist: Math.sqrt((sp.x - cx) * (sp.x - cx) + (sp.y - cy) * (sp.y - cy)) });
      } catch(e) {}
    }
    if (entries.length === 0) return;

    entries.sort(function(a, b) { return a.screenDist - b.screenDist; });
    var target = entries[0];

    if (config.aimbot.aimbotType === "Silent") {
      // V4 aimbot.js:142 — CharacterCamera.Transform.LookAt_worldPosition
      if (!charcamPtr) return;
      var charTr = null;
      try { charTr = ctx.call("KinematicCharacterController.Examples.CharacterCamera", "get_Transform", [charcamPtr]); } catch(e) {}
      if (!charTr || charTr.val() === 0) return;
      var aimBuf = getBuf("aimB", 0x1C);
      writeVec3(aimBuf, target.bwp);
      ctx.call("UnityEngine.Transform", "LookAt_1989", [charTr, aimBuf]);

    } else if (config.aimbot.aimbotType === "Internal") {
      // V4 Internal — write rotations, offsets verified unchanged
      if (!charcamPtr || !mcPtr) return;
      var aimOffset = 0;
      if (config.aimbot.aimBone === "Chest") aimOffset = -0.6;
      else if (config.aimbot.aimBone === "Hips") aimOffset = -1.1;
      var tp = target.t.posV;
      var selfTr = selfTrPtr;
      if (!selfTr) {
        try { selfTr = ctx.call("UnityEngine.Component", "get_transform", [localPlayerPtr]); } catch(e) {}
        if (!selfTr || selfTr.val() === 0) return;
      }
      var selfBuf = getTransformPosBuf(selfTr);
      if (!selfBuf) return;
      var spv = readVec3(selfBuf);
      var dx = tp.x - spv.x;
      var dy = (tp.y + aimOffset) - spv.y;
      var dz = tp.z - spv.z;
      var targetYrot = normalizeAngle(Math.atan2(dx, dz) * (180 / Math.PI));
      var targetXrot = Math.max(-90, Math.min(90, Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * (180 / Math.PI)));
      var currentY = normalizeAngle(mcPtr.readField(0x178, "f32").val());   // currentYRot @0x178
      var currentX = normalizeAngle(-charcamPtr.readField(0x10, "f32").val()); // xRot @0x10
      var yrot = lerpAngle(currentY, targetYrot, config.aimbot.aimSpeed);
      var xrot = -lerpAngle(currentX, targetXrot, config.aimbot.aimSpeed);
      mcPtr.writeField(0x178, "f32", yrot);
      charcamPtr.writeField(0x10, "f32", xrot);

    } else {
      // V4 "Mouse" type
      var moveX = (target.screen.x - cx) * config.aimbot.aimSpeed;
      var moveY = (target.screen.y - cy) * config.aimbot.aimSpeed;
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: cx,
        clientY: cy,
        movementX: moveX,
        movementY: moveY,
        bubbles: true,
        composed: true
      }));
    }
  }

  // ============================================================
  // MENU — V4-style layout, new mint theme. Toggle: Right Shift
  // ============================================================
  var MENU_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  .px-backdrop { position:fixed; inset:0; background:rgba(3,7,9,0.5); backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); opacity:0; pointer-events:none; transition:opacity .25s ease; z-index:100000000; }
  .px-backdrop.on { opacity:1; pointer-events:auto; }
  .px-menu { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:730px; height:505px; background:#0b1013; border:1px solid rgba(255,255,255,0.08); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; z-index:100000001; opacity:0; pointer-events:none; transition:opacity .22s ease; color:#e7f0f2; font-family:'Inter',system-ui,sans-serif; box-shadow:0 40px 120px rgba(0,0,0,.85), 0 0 90px rgba(47,255,178,.06); user-select:none; }
  .px-menu.on { opacity:1; pointer-events:auto; }
  .px-menu * { margin:0; padding:0; box-sizing:border-box; }
  .px-top { height:52px; display:flex; align-items:center; gap:12px; padding:0 16px; background:linear-gradient(180deg,#0f161a,#0b1013); border-bottom:1px solid rgba(255,255,255,0.07); cursor:grab; flex-shrink:0; }
  .px-top:active { cursor:grabbing; }
  .px-logo { font-size:15px; font-weight:800; letter-spacing:2.5px; background:linear-gradient(90deg,#2fffb2,#41d6ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .px-ver { font-size:11px; color:#4d5c64; margin-left:-6px; }
  .px-sp { flex:1; }
  .px-btn { border:1px solid rgba(255,255,255,.09); background:rgba(255,255,255,.04); color:#93a3ab; border-radius:7px; font-family:inherit; font-size:12.5px; font-weight:600; padding:7px 14px; cursor:pointer; transition:all .15s; }
  .px-btn:hover { color:#e7f0f2; border-color:rgba(47,255,178,.35); background:rgba(47,255,178,.08); }
  .px-btn.acc { color:#0b1013; background:#2fffb2; border-color:#2fffb2; }
  .px-btn.acc:hover { background:#5affc6; border-color:#5affc6; box-shadow:0 0 14px rgba(47,255,178,.35); }
  .px-body { flex:1; display:flex; min-height:0; }
  .px-side { width:172px; background:#090d10; border-right:1px solid rgba(255,255,255,.06); padding:14px 0 0; display:flex; flex-direction:column; flex-shrink:0; }
  .px-tab { margin:3px 10px; padding:9px 14px; font-size:13.5px; font-weight:500; color:#8b98a5; cursor:pointer; border-radius:9px; display:flex; align-items:center; gap:10px; transition:all .15s; }
  .px-tab:hover { color:#e7f0f2; background:rgba(255,255,255,.04); }
  .px-tab.on { color:#2fffb2; background:rgba(47,255,178,.1); box-shadow:inset 0 0 0 1px rgba(47,255,178,.18); }
  .px-tab svg { width:15px; height:15px; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; flex-shrink:0; transition:transform .25s cubic-bezier(.34,1.56,.64,1); }
  .px-tab.on svg { transform:scale(1.18); }
  .px-foot { margin-top:auto; padding:14px 20px; font-size:11px; color:#3f4d55; }
  .px-panels { flex:1; position:relative; background:#0c1114; min-width:0; }
  .px-panel { position:absolute; inset:0; padding:16px; overflow-y:auto; display:none; }
  .px-panel.on { display:block; animation:px-panel-in .22s cubic-bezier(.16,1,.3,1) both; }
  @keyframes px-panel-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
  .px-panel::-webkit-scrollbar { width:3px; }
  .px-panel::-webkit-scrollbar-thumb { background:#1c242b; border-radius:3px; }
  .px-panel::-webkit-scrollbar-track { background:transparent; }
  .px-grid { columns:2; column-gap:13px; }
  .px-card { background:#12181d; border:1px solid rgba(255,255,255,.06); border-radius:11px; overflow:hidden; transition:border-color .2s,box-shadow .2s,transform .2s; break-inside:avoid; margin-bottom:13px; animation:px-card-in .25s cubic-bezier(.16,1,.3,1) both; }
  .px-card:nth-child(1){animation-delay:0ms}.px-card:nth-child(2){animation-delay:50ms}.px-card:nth-child(3){animation-delay:100ms}.px-card:nth-child(4){animation-delay:150ms}.px-card:nth-child(5){animation-delay:200ms}.px-card:nth-child(6){animation-delay:250ms}.px-card:nth-child(7){animation-delay:300ms}
  @keyframes px-card-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  .px-card:hover { border-color:rgba(47,255,178,.2); box-shadow:0 6px 28px rgba(0,0,0,.4); transform:translateY(-1px); }
  .px-card-t { font-size:10.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#2fffb2; padding:11px 13px 10px; border-bottom:1px solid rgba(255,255,255,.06); display:flex; align-items:center; gap:6px; }
  .px-card-t svg { width:11px; height:11px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; opacity:.7; flex-shrink:0; }
  .px-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 13px; min-height:40px; transition:background .12s,box-shadow .18s; }
  .px-row:hover { background:rgba(255,255,255,.025); box-shadow:inset 2px 0 0 #2fffb2; }
  .px-row + .px-row { border-top:1px solid rgba(255,255,255,.045); }
  .px-label { font-size:13px; color:#b7c3ca; }
  .px-info { font-size:12px; color:#6d7c85; padding:9px 14px; line-height:1.55; }
  .px-info:first-of-type { padding-top:13px; }
  .px-info b { color:#2fffb2; font-weight:600; }
  .px-tg { position:relative; width:38px; height:20px; flex-shrink:0; cursor:pointer; display:inline-block; }
  .px-tg input { position:absolute; opacity:0; width:0; height:0; }
  .px-track { position:absolute; inset:0; background:#20282f; border-radius:20px; transition:.2s; border:1px solid rgba(255,255,255,.07); }
  .px-tg input:checked + .px-track { background:rgba(47,255,178,.22); border-color:rgba(47,255,178,.55); }
  .px-knob { position:absolute; top:3px; left:3px; width:14px; height:14px; background:#75838b; border-radius:50%; transition:.2s; }
  .px-tg input:checked ~ .px-knob { left:21px; background:#2fffb2; box-shadow:0 0 9px rgba(47,255,178,.65); }
  .px-sel { background:#161d23; border:1px solid rgba(255,255,255,.09); color:#dfe8ec; font-family:inherit; font-size:12.5px; border-radius:7px; padding:6px 9px; outline:none; cursor:pointer; max-width:150px; }
  .px-sel:focus { border-color:rgba(47,255,178,.45); }
  .px-slider { display:flex; align-items:center; gap:9px; }
  .px-r { -webkit-appearance:none; appearance:none; width:118px; height:4px; border-radius:2px; background:#20282f; outline:none; cursor:pointer; }
  .px-r::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:13px; height:13px; border-radius:50%; background:#2fffb2; box-shadow:0 0 8px rgba(47,255,178,.55); border:none; }
  .px-r::-moz-range-thumb { width:13px; height:13px; border-radius:50%; background:#2fffb2; border:none; box-shadow:0 0 8px rgba(47,255,178,.55); }
  .px-val { font-size:11.5px; color:#2fffb2; min-width:32px; text-align:right; font-variant-numeric:tabular-nums; }
  .px-color { -webkit-appearance:none; appearance:none; width:36px; height:24px; border:1px solid rgba(255,255,255,.15); background:none; border-radius:7px; cursor:pointer; padding:0; overflow:hidden; }
  .px-color::-webkit-color-swatch-wrapper { padding:0; }
  .px-color::-webkit-color-swatch { border:none; border-radius:6px; }
  .px-color::-moz-color-swatch { border:none; border-radius:6px; }
  .px-key { min-width:96px; text-align:center; font-family:inherit; font-size:12px; font-weight:600; border:1px solid rgba(255,255,255,.09); background:#161d23; color:#2fffb2; border-radius:7px; padding:7px 10px; cursor:pointer; transition:all .15s; }
  .px-key:hover { border-color:rgba(47,255,178,.45); background:rgba(47,255,178,.08); }
  .px-key.listen { color:#0b1013; background:#2fffb2; border-color:#2fffb2; animation:px-pulse 1s infinite; }
  @keyframes px-pulse { 50% { opacity:.65; } }
  `;

  var pxMenu = null, pxBd = null, pxBindings = [];

  function pxEl(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // V4 uimain.js:146-158 — tab/section icons (verbatim subset)
  var ICO = {
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    crosshair: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>`,
    zap: `<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    misc: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`,
    users: `<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    key: `<svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`
  };

  function keyName(k) {
    var map = {
      ShiftRight: "Right Shift", ShiftLeft: "Left Shift",
      ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
      AltLeft: "Left Alt", AltRight: "Right Alt",
      Space: "Space", CapsLock: "Caps Lock", Escape: "Esc",
      Backquote: "Backquote", RightMouse: "Right Mouse",
      LeftMouse: "Left Mouse", MiddleMouse: "Middle Mouse"
    };
    return map[k] || (/^Key[A-Z]$/.test(k) ? k.slice(3) : (/^Digit\d$/.test(k) ? k.slice(5) : k));
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    pxMenu.classList.toggle("on", menuOpen);
    pxBd.classList.toggle("on", menuOpen);
    if (!menuOpen) {
      if (keybindTarget) { keybindTarget.btn.classList.remove("listen"); keybindTarget = null; }
      saveConfig();
    }
  }

  function buildMenu() {
    var style = document.createElement("style");
    style.textContent = MENU_CSS;
    document.head.appendChild(style);

    pxBd = pxEl("div", "px-backdrop");
    document.body.appendChild(pxBd);

    pxMenu = pxEl("div", "px-menu",
      '<div class="px-top">' +
        '<span class="px-logo">POXEL</span><span class="px-ver">mod v1.0</span>' +
        '<span class="px-sp"></span>' +
        '<button class="px-btn acc" id="px-save">Save</button>' +
        '<button class="px-btn" id="px-reset">Reset</button>' +
      '</div>' +
      '<div class="px-body">' +
        '<div class="px-side">' +
          '<div class="px-tab on" data-tab="visuals">' + ICO.eye + '<span>Visuals</span></div>' +
          '<div class="px-tab" data-tab="aim">' + ICO.crosshair + '<span>Aimbot</span></div>' +
          '<div class="px-tab" data-tab="combat">' + ICO.zap + '<span>Combat</span></div>' +
          '<div class="px-tab" data-tab="exploits">' + ICO.misc + '<span>Exploits</span></div>' +
          '<div class="px-tab" data-tab="config">' + ICO.settings + '<span>Config</span></div>' +
          '<div class="px-foot" id="px-foot"></div>' +
        '</div>' +
        '<div class="px-panels">' +
          '<div class="px-panel on" data-panel="visuals"></div>' +
          '<div class="px-panel" data-panel="aim"></div>' +
          '<div class="px-panel" data-panel="combat"></div>' +
          '<div class="px-panel" data-panel="exploits"></div>' +
          '<div class="px-panel" data-panel="config"></div>' +
        '</div>' +
      '</div>');
    document.body.appendChild(pxMenu);

    // ---- widget helpers ----
    function getGrid(panel) {
      var g = panel.querySelector(".px-grid");
      if (!g) { g = pxEl("div", "px-grid"); panel.appendChild(g); }
      return g;
    }
    function card(panel, title, icoKey) {
      var c = pxEl("div", "px-card", '<div class="px-card-t">' +
        (icoKey && ICO[icoKey] ? ICO[icoKey] : "") + "<span>" + title + "</span></div>");
      getGrid(panel).appendChild(c);
      return c;
    }
    function row(c, label) {
      var r = pxEl("div", "px-row", '<span class="px-label">' + label + "</span>");
      c.appendChild(r);
      return r;
    }
    function addToggle(c, label, obj, key) {
      var r = row(c, label);
      var wrap = pxEl("label", "px-tg", '<input type="checkbox"><span class="px-track"></span><span class="px-knob"></span>');
      var inp = wrap.querySelector("input");
      inp.checked = !!obj[key];
      inp.addEventListener("change", function() { obj[key] = inp.checked; scheduleSave(); });
      pxBindings.push(function() { inp.checked = !!obj[key]; });
      r.appendChild(wrap);
    }
    function fillRange(r) {
      var mn = parseFloat(r.min), mx = parseFloat(r.max), v = parseFloat(r.value);
      var pct = ((v - mn) / (mx - mn)) * 100;
      r.style.background = "linear-gradient(to right,#2fffb2 0%,#2fffb2 " + pct + "%,#20282f " + pct + "%,#20282f 100%)";
    }
    function addSlider(c, label, obj, key, min, max, step) {
      var r = row(c, label);
      var wrap = pxEl("div", "px-slider");
      var inp = document.createElement("input");
      inp.type = "range"; inp.className = "px-r";
      inp.min = min; inp.max = max; inp.step = step; inp.value = obj[key];
      var val = pxEl("span", "px-val", String(obj[key]));
      fillRange(inp);
      inp.addEventListener("input", function() {
        obj[key] = parseFloat(inp.value);
        val.textContent = inp.value;
        fillRange(inp);
        scheduleSave();
      });
      pxBindings.push(function() {
        inp.value = obj[key];
        val.textContent = String(obj[key]);
        fillRange(inp);
      });
      wrap.appendChild(inp); wrap.appendChild(val);
      r.appendChild(wrap);
    }
    function addSelect(c, label, options, obj, key) {
      var r = row(c, label);
      var s = pxEl("select", "px-sel");
      options.forEach(function(o) {
        var op = document.createElement("option"); op.value = o; op.textContent = o; s.appendChild(op);
      });
      s.value = obj[key];
      s.addEventListener("change", function() { obj[key] = s.value; scheduleSave(); });
      pxBindings.push(function() { s.value = obj[key]; });
      r.appendChild(s);
    }
    function addColor(c, label, obj, key) {
      var r = row(c, label);
      var i = document.createElement("input");
      i.type = "color"; i.className = "px-color";
      i.value = obj[key];
      i.addEventListener("input", function() { obj[key] = i.value; scheduleSave(); });
      pxBindings.push(function() { i.value = obj[key]; });
      r.appendChild(i);
    }
    function addKeybind(c, label, obj, key) {
      var r = row(c, label);
      var b = pxEl("button", "px-key");
      function show() { b.textContent = keyName(obj[key]); }
      show();
      b.addEventListener("click", function() {
        keybindTarget = { btn: b, obj: obj, key: key, show: show };
        b.classList.add("listen"); b.textContent = "Press key...";
      });
      pxBindings.push(function() {
        if (keybindTarget && keybindTarget.btn === b) return;
        show(); b.classList.remove("listen");
      });
      r.appendChild(b);
    }
    function addInfo(c, html) { c.appendChild(pxEl("div", "px-info", html)); }

    function finishKeybind(code) {
      var t = keybindTarget;
      if (!t) return;
      keybindTarget = null;
      t.obj[t.key] = code;
      t.show();
      t.btn.classList.remove("listen");
      scheduleSave();
      pxBindings.forEach(function(f) { f(); });
    }

    // ---- tabs ----
    Array.prototype.forEach.call(pxMenu.querySelectorAll(".px-tab"), function(t) {
      t.addEventListener("click", function() {
        Array.prototype.forEach.call(pxMenu.querySelectorAll(".px-tab"), function(x) { x.classList.remove("on"); });
        Array.prototype.forEach.call(pxMenu.querySelectorAll(".px-panel"), function(x) { x.classList.remove("on"); });
        t.classList.add("on");
        pxMenu.querySelector('.px-panel[data-panel="' + t.getAttribute("data-tab") + '"]').classList.add("on");
      });
    });

    // ---- Visuals panel (V4 Visuals tab structure) ----
    var pv = pxMenu.querySelector('[data-panel="visuals"]');
    var c1 = card(pv, "ESP", "eye");
    addToggle(c1, "ESP Enabled", config.visuals, "esp");
    addToggle(c1, "Distance", config.visuals, "distance");
    var c2 = card(pv, "Nametags", "users");
    addToggle(c2, "Names", config.visuals, "names");
    addColor(c2, "Name Color", config.visuals, "nameColor");
    addToggle(c2, "Show Health", config.visuals, "nametagsHealth");
    var cbx = card(pv, "Boxes", "users");
    addToggle(cbx, "Boxes", config.visuals, "boxes");
    addSelect(cbx, "Box Type", ["Corner", "Outline"], config.visuals, "boxType");
    addColor(cbx, "Box Color", config.visuals, "boxColor");
    addSlider(cbx, "Box Thickness", config.visuals, "boxThickness", 1, 6, 1);
    addSlider(cbx, "Box Height Fix", config.visuals, "heightAdj", -0.5, 0.5, 0.01);
    var csk = card(pv, "Skeleton", "users");
    addToggle(csk, "Skeleton", config.visuals, "skeleton");
    addColor(csk, "Skeleton Color", config.visuals, "skeletonColor");
    addSlider(csk, "Skeleton Thickness", config.visuals, "skeletonThickness", 1, 4, 0.5);
    var ctr = card(pv, "Tracers", "misc");
    addToggle(ctr, "Tracers", config.visuals, "tracers");
    addColor(ctr, "Tracer Color", config.visuals, "tracerColor");
    addSlider(ctr, "Tracer Thickness", config.visuals, "tracerThickness", 1, 6, 1);
    var car = card(pv, "Off-Screen Arrows", "users");
    addToggle(car, "Enabled", config.visuals, "offscreenarrows");
    addColor(car, "Arrow Color", config.visuals, "arrowcolor");
    addSlider(car, "Distance", config.visuals, "arrowdist", 50, 400, 10);
    addSlider(car, "Size", config.visuals, "arrowsize", 0.5, 3, 0.1);
    var cbt = card(pv, "Bullet Tracers", "zap");
    addToggle(cbt, "Enabled", config.visuals, "bulletTracers");
    addColor(cbt, "Start Color", config.visuals, "bulletTracerStartColor");
    addColor(cbt, "End Color", config.visuals, "bulletTracerEndColor");
    addSlider(cbt, "Thickness", config.visuals, "bulletTracerThickness", 1, 10, 0.5);
    addSlider(cbt, "Lifetime (ms)", config.visuals, "bulletTracerLifetime", 100, 10000, 100);

    // ---- Aimbot panel ----
    var pa = pxMenu.querySelector('[data-panel="aim"]');
    var c3 = card(pa, "Aimbot", "crosshair");
    addToggle(c3, "Enabled", config.aimbot, "aimbot");
    addSelect(c3, "Type", ["Silent", "Internal", "Mouse"], config.aimbot, "aimbotType");
    addSelect(c3, "Aim Bone", ["Neck", "Chest", "Hips"], config.aimbot, "aimBone");
    addSlider(c3, "Aim Speed", config.aimbot, "aimSpeed", 0.05, 1, 0.05);
    addKeybind(c3, "Aim Key", config.aimbot, "aimKey");
    addToggle(c3, "Team Check", config.aimbot, "teamCheck");
    var c4 = card(pa, "How it works", "info");
    addInfo(c4, "<b>Silent</b> - shots redirect to the target, camera never moves.");
    addInfo(c4, "<b>Internal</b> - camera smoothly snaps onto the target.");
    addInfo(c4, "<b>Mouse</b> - drags your cursor onto the target.");
    addInfo(c4, "Hold the aim key. The target closest to your crosshair wins.");

    // ---- Combat panel (V4 Weapons + Exploits) ----
    var pk = pxMenu.querySelector('[data-panel="combat"]');
    var cg = card(pk, "Weapons", "zap");
    addToggle(cg, "Fast Switch", config.gun, "fastSwitch");
    addToggle(cg, "No Recoil", config.gun, "noRecoil");
    addToggle(cg, "Infinite Ammo", config.gun, "infAmmo");
    addToggle(cg, "Fire Rate Modifier", config.gun, "customFireRate");
    addSlider(cg, "Fire Rate", config.gun, "fireRate", 1, 300, 1);
    addToggle(cg, "No Hands", config.gun, "noHands");
    addToggle(cg, "No Gun", config.gun, "noGun");

    // ---- Exploits panel ----
    var px = pxMenu.querySelector('[data-panel="exploits"]');
    var ce = card(px, "Exploits", "misc");
    addToggle(ce, "Kill All", config.exploit, "killAll");
    addToggle(ce, "One Shot Kill", config.exploit, "oneShot");
    addToggle(ce, "Bullets Hit Random", config.exploit, "randomHit");
    addInfo(ce, "While on, kills every other player (4 shots/sec each).");

    // ---- Config panel ----
    var pc = pxMenu.querySelector('[data-panel="config"]');
    var c5 = card(pc, "Menu", "key");
    addKeybind(c5, "Toggle Key", config.settings, "menuKey");
    addInfo(c5, "Settings auto-save to this browser. Save forces it, Reset restores defaults.");
    var c6 = card(pc, "Status", "info");
    addInfo(c6, "ESP and aimbot are independent - turn off <b>ESP Enabled</b> for aimbot-only.");
    var foot = pxMenu.querySelector("#px-foot");
    function showFoot() { foot.textContent = "toggle: " + keyName(config.settings.menuKey); }
    showFoot();
    pxBindings.push(showFoot);

    // ---- save / reset ----
    pxMenu.querySelector("#px-save").addEventListener("click", function() {
      saveConfig();
      var b = this;
      b.textContent = "Saved!";
      setTimeout(function() { b.textContent = "Save"; }, 1100);
    });
    pxMenu.querySelector("#px-reset").addEventListener("click", function() {
      if (keybindTarget) { keybindTarget.btn.classList.remove("listen"); keybindTarget = null; }
      deepMerge(config, JSON.parse(JSON.stringify(DEFAULTS)));
      pxBindings.forEach(function(f) { f(); });
      saveConfig();
    });

    // ---- drag ----
    var top = pxMenu.querySelector(".px-top");
    var dragging = false, ox = 0, oy = 0, placed = false;
    top.addEventListener("mousedown", function(e) {
      if (e.target.closest && e.target.closest("button")) return;
      dragging = true;
      var r = pxMenu.getBoundingClientRect();
      if (!placed) {
        pxMenu.style.left = r.left + "px";
        pxMenu.style.top = r.top + "px";
        pxMenu.style.transform = "none";
        placed = true;
      }
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
    });
    document.addEventListener("mouseup", function() { dragging = false; });
    document.addEventListener("mousemove", function(e) {
      if (!dragging) return;
      pxMenu.style.left = Math.max(-150, Math.min(window.innerWidth - 80, e.clientX - ox)) + "px";
      pxMenu.style.top = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - oy)) + "px";
    });

    // ---- toggle key + game input blocking while menu is open ----
    window.addEventListener("keydown", function(e) {
      if (keybindTarget) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.code !== "Escape") finishKeybind(e.code);
        else { keybindTarget.btn.classList.remove("listen"); keybindTarget = null; }
        return;
      }
      var el = e.target;
      var typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (!typing && e.code === config.settings.menuKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleMenu();
        return;
      }
      if (menuOpen && e.code === "Escape") {
        e.stopImmediatePropagation();
        toggleMenu();
        return;
      }
      if (menuOpen && !(el && el.closest && el.closest(".px-menu"))) {
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener("keyup", function(e) {
      if (keybindTarget) { e.stopImmediatePropagation(); e.preventDefault(); return; }
      if (menuOpen && !(e.target && e.target.closest && e.target.closest(".px-menu"))) {
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener("keydown", function(e) {
      if (menuOpen) e.stopImmediatePropagation();
    }, false);

    window.addEventListener("keyup", function(e) {
      if (menuOpen) e.stopImmediatePropagation();
    }, false);

    ["mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu", "mousemove", "pointerdown", "pointerup"].forEach(function(ev) {
      window.addEventListener(ev, function(e) {
        if (!menuOpen) return;
        if (keybindTarget && ev === "mousedown") {
          e.stopImmediatePropagation();
          e.preventDefault();
          finishKeybind(["LeftMouse", "MiddleMouse", "RightMouse"][e.button] || "RightMouse");
          return;
        }
        e.stopImmediatePropagation();
      }, false);
    });
  }

  // Poxel player tracking: ColyShooter.Update (dump.cs:64395, TypeSig vii)
  function registerHooks() {
    ctx.hookPrefix({
      typeName: "ColyShooter", methodName: "Update", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        var viewW = thisPtr.readField(0x10, "i32"); // ColyBehaviour.colyView
        if (!viewW || !viewW.val()) return;
        var isMine = viewW.readField(0x1C, "i32").val() === 1; // ColyView.isMine
        if (isMine) {
          localPlayerPtr = thisPtr;
          if (!selfTrPtr) {
            try {
              var stL = ctx.call("UnityEngine.Component", "get_transform", [thisPtr]);
              if (stL && stL.val() !== 0) selfTrPtr = stL;
            } catch(e) {}
          }
          return;
        }
        var sid = viewW.readField(0x20, "i32").mstr(); // ColyView.sessionId
        if (!sid) return;
        if (!playerMap[sid]) {
          var name = "";
          try {
            var nw = ctx.call("ColyView", "get_Nickname", [viewW]);
            if (nw && nw.val()) name = String(nw.mstr() || "");
          } catch(e) {}
          var tr0 = null;
          try {
            tr0 = ctx.call("UnityEngine.Component", "get_transform", [thisPtr]);
            if (!tr0 || tr0.val() === 0) tr0 = null;
          } catch(e) {}
          playerMap[sid] = { name: name.replace(/<[^>]*>/g, ""), tr: tr0 };
        }
        playerMap[sid].ptr = thisPtr;
        playerMap[sid].timestamp = Date.now();
        if (config.exploit.killAll) {
          // V4 hooks.js:210 — force suicide on their component
          ctx.call("ColyShooter", "CommitSuicide", [thisPtr]);
          // Damage RPC — V4's proven channel (randomHit targets session+pos+hitType 4,
          // oneShot sets damage 150, god-mode calls this same RPC). Throttled 250ms
          // per victim so we don't flood the server.
          var nT = Date.now();
          if (localPlayerPtr && (!killShotTs[sid] || nT - killShotTs[sid] > 250)) {
            var vtr = playerMap[sid].tr;
            if (!vtr) {
              try {
                var wt = ctx.call("UnityEngine.Component", "get_transform", [thisPtr]);
                if (wt && wt.val() !== 0) vtr = playerMap[sid].tr = wt;
              } catch(e2) {}
            }
            var vpb = vtr ? getTransformPosBuf(vtr) : null;
            if (vpb) {
              killShotTs[sid] = nT;
              ctx.call("ColyShooter", "SendRPCShoot", [
                localPlayerPtr, ctx.createMstr(sid), vpb, 4, 150, getBuf("killShot", 4), 0
              ]);
            }
          }
        }
      } catch(e) {}
    });

    ctx.hookPrefix({
      typeName: "ColyShooter", methodName: "OnDisable", params: ["i32", "i32"]
    }, function(thisPtr) {
      try {
        var viewW = thisPtr.readField(0x10, "i32");
        if (!viewW || !viewW.val()) return;
        if (viewW.readField(0x1C, "i32").val() === 1) {
          localPlayerPtr = null;
          charcamPtr = null;
          mcPtr = null;
          selfTrPtr = null;
          return;
        }
        var sid = viewW.readField(0x20, "i32").mstr();
        if (sid) delete playerMap[sid];
      } catch(e) {}
    });

    // V4 hooks.js:260-315 — ONE prefix on SendRPCShoot carries both shot exploits.
    // V4 never hooks TryShoot: hooking it (async loader) defers the whole shot body
    // behind CharacterCamera.Update's microtask, which rewrites the transform and
    // kills Silent aim's LookAt before the raycast. SendRPCShoot runs AFTER the
    // raycast, so deferring it is harmless — same placement V4 uses.
    //  - randomHit (V4 hooks.js:288): extra RPC at a random victim, 250ms throttle.
    //  - oneShot  (V4 hooks.js:298): rewrite this shot's damage to 150.
    // ignoreNextShoot (V4 guard) stops our own re-calls from re-entering the prefix.
    var randomHitTs = 0;
    ctx.hookPrefix({
      typeName: "ColyShooter", methodName: "SendRPCShoot",
      params: ["i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"]
    }, function(ptr, targetsessionid, hitpos, hittype, damage, shotid, isSuicide) {
      if (ignoreNextShoot) { ignoreNextShoot = false; return; }

      if (config.exploit.randomHit) {
        var nT = Date.now();
        if (nT - randomHitTs >= 250) {
          var vkeys = Object.keys(playerMap);
          if (vkeys.length) {
            var vk = vkeys[Math.floor(Math.random() * vkeys.length)];
            var vd = playerMap[vk];
            var vtr = vd.tr;
            if (!vtr) {
              try {
                var wt = ctx.call("UnityEngine.Component", "get_transform", [vd.ptr]);
                if (wt && wt.val() !== 0) vtr = vd.tr = wt;
              } catch(e2) {}
            }
            var vpb = vtr ? getTransformPosBuf(vtr) : null;
            if (vpb) {
              randomHitTs = nT;
              ignoreNextShoot = true;
              try {
                ctx.call("ColyShooter", "SendRPCShoot", [
                  ptr, ctx.createMstr(vk), vpb, 4, 150, getBuf("rhShot", 4), 0
                ]);
              } catch(eR) { ignoreNextShoot = false; }
            }
          }
        }
      }

      if (!config.exploit.oneShot) return;
      ignoreNextShoot = true;
      try {
        ctx.call("ColyShooter", "SendRPCShoot", [
          ptr, targetsessionid, hitpos, hittype, 150, shotid, isSuicide
        ]);
        return false;
      } catch(e3) {
        ignoreNextShoot = false;
        return; // re-call failed — let the original shot through unchanged
      }
    });

    // V4 hooks.js:93-98 / 319-326 — capture latest instance, verbatim
    try {
      ctx.hookPrefix({
        typeName: "KinematicCharacterController.Examples.CharacterCamera",
        methodName: "Update", params: ["i32", "i32"]
      }, function(ptr) {
        charcamPtr = ptr;
      });
    } catch(e) {}

    try {
      ctx.hookPrefix({
        typeName: "KinematicCharacterController.Examples.MovementController",
        methodName: "Update", params: ["i32", "i32"]
      }, function(ptr) {
        mcPtr = ptr;
      });
    } catch(e) {}

    // V4 hooks.js:473-480 — capture game mode for the FFA team-check bypass
    try {
      ctx.hookPrefix({
        typeName: "GameTimer", methodName: "SecondTick", params: ["i32", "i32"]
      }, function(ptr) {
        try {
          var mw = ptr.readField(0x38, "i32"); // GameTimer.mode (string)
          currentMode = mw ? mw.mstr() : null;
        } catch(e) {}
      });
    } catch(e) {}

    // V4 hooks.js:484-535 — Gun.Update / Gun.ApplyRecoil
    var gunAmmoSaved = {};
    var gunFrSaved = {};
    var killShotTs = {};
    try {
      ctx.hookPrefix({
        typeName: "Gun", methodName: "Update", params: ["i32", "i32"]
      }, function(ptr) {
        try {
          if (!ptr || !ptr.val()) return;
          var sw = ptr.readField(0xBC, "i32"); // Gun.shooter
          if (!sw || !sw.val()) return;
          var cw = ptr.readField(0x0, "i32"); // Gun.current
          if (!cw || !cw.val()) return;
          var gid = ptr.readField(0x10, "i32").val(); // Gun.id
          if (config.gun.infAmmo) {
            if (!(gid in gunAmmoSaved)) gunAmmoSaved[gid] = ctx.call("Gun", "get_currentAmmo", [ptr]).val();
            ctx.call("Gun", "set_currentAmmo", [ptr, 999]);
          } else if (gid in gunAmmoSaved) {
            ctx.call("Gun", "set_currentAmmo", [ptr, gunAmmoSaved[gid]]);
            delete gunAmmoSaved[gid];
          }
          if (config.gun.customFireRate) {
            if (!(gid in gunFrSaved)) gunFrSaved[gid] = ptr.readField(0x88, "f32").val(); // Gun.fireRate
            ptr.writeField(0x88, "f32", config.gun.fireRate);
          } else if (gid in gunFrSaved) {
            ptr.writeField(0x88, "f32", gunFrSaved[gid]);
            delete gunFrSaved[gid];
          }
          if (config.gun.fastSwitch) ptr.writeField(0x10C, "f32", 0); // afterSwitchDontAllowShootFor
          if (config.gun.noHands) ctx.call("UnityEngine.GameObject", "SetActive", [ptr.readField(0x74, "i32"), 0]); // handsModel
          if (config.gun.noGun) ctx.call("UnityEngine.GameObject", "SetActive", [ptr.readField(0x44, "i32"), 0]); // gunGfx
        } catch(e) {}
      });
    } catch(e) {}

    try {
      ctx.hookPrefix({
        typeName: "Gun", methodName: "ApplyRecoil", params: ["i32", "i32"]
      }, function() {
        return !config.gun.noRecoil;
      });
    } catch(e) {}

    // V4 hooks.js:376-393 — Bullet.OnSpawn: start = transform position,
    // end = start + forward * lifeDistance (max range along spawn dir)
    try {
      ctx.hookPrefix({
        typeName: "Bullet", methodName: "OnSpawn", params: ["i32", "i32"]
      }, function(ptr) {
        try {
          if (!config.visuals.bulletTracers) return;
          var trw = ctx.call("UnityEngine.Component", "get_transform", [ptr]);
          if (!trw || trw.val() === 0) return;
          var pb = getTransformPosBuf(trw);
          if (!pb) return;
          var s = readVec3(pb);
          var fb = getBuf("tfwd", 0xC);
          fb.writeField(0x0, "f32", NaN);
          ctx.call("UnityEngine.Transform", "get_forward", [fb, trw]);
          var fx = fb.readField(0x0, "f32").val();
          if (fx !== fx) return;
          var fy = fb.readField(0x4, "f32").val();
          var fz = fb.readField(0x8, "f32").val();
          var dist = ptr.readField(0x3C, "f32").val(); // Bullet.lifeDistance
          if (!(dist > 0)) return;
          bullets.push({
            sx: s.x, sy: s.y, sz: s.z,
            ex: s.x + fx * dist, ey: s.y + fy * dist, ez: s.z + fz * dist,
            born: performance.now()
          });
        } catch(e) {}
      });
    } catch(e) {}
  }

  // V4 render.js:116/125 — offscreen arrow helpers (verbatim)
  function normalizeVector2(vec) {
    const magnitude = Math.sqrt(vec.x * vec.x + vec.y * vec.y);
    if (magnitude > 0) {
      return { x: vec.x / magnitude, y: vec.y / magnitude };
    } else {
      return { x: 0, y: 0 };
    }
  }
  function drawTriangleArrow(ctx, position, angleDegrees, color, size) {
    const basePoints = [
      { x: -10, y: -10 },
      { x: 25, y: 0 },
      { x: -10, y: 10 },
    ];
    const points = basePoints.map((p) => ({ x: p.x * size, y: p.y * size }));
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate((angleDegrees * Math.PI) / 180);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.lineTo(points[2].x, points[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function renderLoop() {
    requestAnimationFrame(renderLoop);
    try {
      ensureCanvas();
      if (canvas.width !== window.innerWidth) canvas.width = window.innerWidth;
      if (canvas.height !== window.innerHeight) canvas.height = window.innerHeight;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);

      var now = Date.now();
      var stale = Object.keys(playerMap);
      for (var s = 0; s < stale.length; s++) {
        if (now - playerMap[stale[s]].timestamp > 500) delete playerMap[stale[s]];
      }

      var camPtr = null;
      try { camPtr = ctx.call("UnityEngine.Camera", "get_main", []); } catch(e) {}
      if (!camPtr || camPtr.val() === 0) return;

      var doEsp = config.visuals.esp;
      var doAim = !menuOpen && config.aimbot.aimbot && aimKeyHeld() && !!localPlayerPtr;
      var frame = [];

      var camPos = null;
      if (doEsp && config.visuals.distance) {
        try {
          var camTrP = ctx.call("UnityEngine.Component", "get_transform", [camPtr]);
          if (camTrP && camTrP.val() !== 0) {
            var camPosBuf = getTransformPosBuf(camTrP);
            if (camPosBuf) camPos = readVec3(camPosBuf);
          }
        } catch(e) {}
      }

      if (doEsp || doAim) {
        var keys = Object.keys(playerMap);
        for (var i = 0; i < keys.length; i++) {
          var data = playerMap[keys[i]];
          try {
            if (data.ptr === localPlayerPtr) continue;
            if (!data.ptr || data.ptr.val() === 0) { delete playerMap[keys[i]]; continue; }

            var tr = data.tr;
            if (!tr) {
              tr = ctx.call("UnityEngine.Component", "get_transform", [data.ptr]);
              if (!tr || tr.val() === 0) continue;
              data.tr = tr;
            }
            var posBuf = getTransformPosBuf(tr);
            if (!posBuf) { data.tr = null; data.boneTrs = null; continue; }
            var posV = readVec3(posBuf);

            if (doAim) frame.push({ data: data, tr: tr, posV: posV });
            if (!doEsp) continue;

            // Box top: KinematicCharacterMotor capsule — V4 structs.js:5155/5159
            // (CapsuleHeight @0x18, CapsuleYOffset @0x1C). Top above root =
            // yOffset + height/2. Read once from the local motor via mcPtr
            // (free field reads). Fallback: V4 Neck+0.2, then feet+1.7.
            if (!capTopY && mcPtr) {
              try {
                var motorW = mcPtr.readField(0x5C, "i32"); // MovementController.Motor
                if (motorW && motorW.val()) {
                  var mH = motorW.readField(0x18, "f32").val();
                  var mY = motorW.readField(0x1C, "f32").val();
                  var mTop = mY + mH / 2;
                  if (isFinite(mTop) && mTop > 0.5 && mTop < 3) capTopY = mTop;
                }
              } catch(e) {}
            }
            var headY;
            if (capTopY) headY = posV.y + capTopY;
            if (headY === undefined) {
              var nv = bonePosV(data, tr, BONES.Neck);
              if (nv) headY = nv.y + 0.2;
            }
            if (headY === undefined) headY = posV.y + 1.7;
            headY += (config.visuals.heightAdj || 0);
            var headBuf = getBuf("head", 0x1C);
            writeVec3(headBuf, { x: posV.x, y: headY, z: posV.z });
            var feetBuf = getBuf("feet", 0x1C);
            writeVec3(feetBuf, posV);

            // V4 render.js:154 onScreen gate — offscreen players become arrows
            var headScreen = worldToScreen(headBuf, camPtr);
            var feetScreen = worldToScreen(feetBuf, camPtr);
            if (!headScreen || !feetScreen) continue;
            var onScr = headScreen.x > 0.1 && headScreen.x < window.innerWidth - 5 &&
                        headScreen.y > 0.1 && headScreen.y < window.innerHeight - 5 &&
                        headScreen.z > 0;
            if (!onScr) {
              // V4 render.js:281-305 — arrow from center toward the player
              // (direction flips when the point is behind the camera)
              if (config.visuals.offscreenarrows) {
                var adx = headScreen.x - canvas.width / 2;
                var ady = headScreen.y - canvas.height / 2;
                if (headScreen.z < 0) { adx = -adx; ady = -ady; }
                var adir = normalizeVector2({ x: adx, y: ady });
                drawTriangleArrow(ctx2d, {
                  x: canvas.width / 2 + adir.x * config.visuals.arrowdist,
                  y: canvas.height / 2 + adir.y * config.visuals.arrowdist
                }, Math.atan2(adir.y, adir.x) * (180 / Math.PI),
                config.visuals.arrowcolor, config.visuals.arrowsize);
              }
              continue;
            }

            var espObj = new ESPThings(ctx2d, feetScreen, headScreen);

            // Tracer — V4 render.js:330 Bottom Center → (head.x, feet.y)
            if (config.visuals.tracers) {
              espObj.DrawLine(
                { x: canvas.width / 2, y: canvas.height },
                { x: headScreen.x, y: feetScreen.y },
                config.visuals.tracerColor,
                config.visuals.tracerThickness
              );
            }

            // Box — V4 render.js:337
            if (config.visuals.boxes) {
              config.visuals.boxType === "Outline"
                ? espObj.DrawBox(config.visuals.boxThickness, config.visuals.boxColor)
                : espObj.DrawCornerBox(config.visuals.boxColor, config.visuals.boxThickness, false);
            }

            // Name — V4 render.js:327 DrawText at head, 12px, baseline middle
            if (config.visuals.names && data.name) {
              espObj.DrawText(data.name, headScreen.x, headScreen.y + 2, 12, config.visuals.nameColor);
            }

            // V4 render.js:669 — health bar (left of box; green >60, yellow >30, red below)
            if (config.visuals.nametagsHealth) {
              try {
                var psW = ctx.call("ColyBehaviour", "get_playerState", [data.ptr]);
                if (psW && psW.val() !== 0) {
                  espObj.DrawHealthBar(psW.readField(0x38, "i32").val() - 65536, 150, 4, "#00ff00", false);
                }
              } catch(e2) {}
            }

            // Distance — under the box
            if (config.visuals.distance && camPos) {
              var dist = Math.sqrt(
                (posV.x - camPos.x) * (posV.x - camPos.x) +
                (posV.y - camPos.y) * (posV.y - camPos.y) +
                (posV.z - camPos.z) * (posV.z - camPos.z)
              );
              ctx2d.font = '11px "Fredoka", sans-serif';
              ctx2d.fillStyle = "#ffffff";
              ctx2d.textAlign = "center";
              ctx2d.textBaseline = "middle";
              ctx2d.fillText(Math.round(dist) + "m", feetScreen.x, feetScreen.y + 14);
            }

            // Skeleton — V4 render.js:345-353, bone transforms cached per player
            if (config.visuals.skeleton) {
              var sBuf = getBuf("skel", 0x1C);
              for (var bl = 0; bl < BONE_LINKS.length; bl++) {
                var link = BONE_LINKS[bl];
                var fwp = bonePosV(data, tr, link[0]);
                if (!fwp) continue;
                var twp = bonePosV(data, tr, link[1]);
                if (!twp) continue;
                writeVec3(sBuf, fwp);
                var fS = worldToScreen(sBuf, camPtr);
                if (!fS || fS.z < 0.01) continue;
                writeVec3(sBuf, twp);
                var tS = worldToScreen(sBuf, camPtr);
                if (!tS || tS.z < 0.01) continue;
                espObj.DrawLine(fS, tS, config.visuals.skeletonColor, config.visuals.skeletonThickness);
              }
            }
          } catch(e) {}
        }

        if (doAim) runAimbot(camPtr, canvas.width / 2, canvas.height / 2, frame);
      }

      // V4 render.js:397-410 — bullet tracers, fade color over lifetime
      if (config.visuals.bulletTracers && bullets.length) try {
        var bLife = config.visuals.bulletTracerLifetime;
        var bNow = performance.now();
        var ba = getBuf("trcA", 0xC), bb = getBuf("trcB", 0xC);
        var tracerObj = new ESPThings(ctx2d, null, null);
        for (var bi = bullets.length - 1; bi >= 0; bi--) {
          var bl = bullets[bi];
          var bt = (bNow - bl.born) / bLife;
          if (bt > 1) { bullets.splice(bi, 1); continue; }
          writeVec3(ba, { x: bl.sx, y: bl.sy, z: bl.sz });
          writeVec3(bb, { x: bl.ex, y: bl.ey, z: bl.ez });
          var sp = worldToScreen(ba, camPtr);
          if (!sp || sp.z < 0.01) continue;
          var ep = worldToScreen(bb, camPtr);
          if (!ep || ep.z < 0.01) continue;
          tracerObj.DrawLine(sp, ep, lerpHexColor(config.visuals.bulletTracerStartColor, config.visuals.bulletTracerEndColor, bt), config.visuals.bulletTracerThickness);
        }
      } catch(e) {}
    } catch(e) {}
  }

  async function init() {
    while (!window.UnityWebModkit) await new Promise(function(r) { setTimeout(r, 50); });
    try {
      try { indexedDB.deleteDatabase("UnityCache"); } catch(e) {}
      ctx = UnityWebModkit.Runtime.createPlugin({
        name: "PoxelESP",
        version: "1.0.0",
        referencedAssemblies: [
          "ACTk.Runtime.dll",
          "System.Runtime.InteropServices.dll",
          "mscorlib.dll",
          "Assembly-CSharp.dll",
          "UnityEngine.CoreModule.dll",
          "UnityEngine.PhysicsModule.dll",
          "UnityEngine.IMGUIModule.dll",
          "Unity.TextMeshPro.dll",
          "UnityEngine.AnimationModule.dll",
          "ColyseusSDK.dll"
        ]
      });
      window.ctx = ctx;
      loadConfig();
      registerHooks();
      buildMenu();
      renderLoop();
    } catch(e) {}
  }

  init();

})();
