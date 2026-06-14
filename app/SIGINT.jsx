import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { LAND } from "./world.js";
import snapshot from "../data/files.json";

// ════════════════════════════════════════════════════════════════════════════
// DATA
// The dataset is produced by the scraper pipeline (data/files.json) and bundled
// at build time as the offline snapshot. Set DATA_URL to a hosted files.json to
// fetch the latest on load (falls back to the bundled snapshot on failure).
// ════════════════════════════════════════════════════════════════════════════
const DATA_URL = null; // e.g. "https://raw.githubusercontent.com/YOU/uap-files/main/data/files.json"

// ════════════════════════════════════════════════════════════════════════════
// PALETTE
// ════════════════════════════════════════════════════════════════════════════
const AGENCY_COL = {
  CENTCOM: "#f97316", INDOPACOM: "#f59e0b", NORAD: "#ef4444", Army: "#84cc16",
  Navy: "#0ea5e9", AirForce: "#38bdf8", FBI: "#a855f7", CIA: "#8b5cf6",
  NSA: "#6366f1", NASA: "#ec4899", NARA: "#14b8a6", NUFORC: "#64748b",
  DoD: "#f97316", AARO: "#22d3ee", State: "#10b981", Other: "#64748b",
};
const TC = { proximity: "#0ea5e9", temporal: "#eab308", shape: "#a855f7", pattern: "#f97316", other: "#64748b" };
const BRIDGE_COL = "#fb7185"; // bridges — the cross-space/time/agency links
const SEL_COL = "#34d399";
const IC = { disc: "◉", triangle: "△", orb: "●", cigar: "▬", chevron: "⟨⟩", diamond: "◇", boomerang: "⌒", other: "✦", unknown: "?" };

const agencyColor = (s) => AGENCY_COL[s && s.source && s.source.agency] || "#64748b";
const shortLoc = (s) => (s ? s.split("(")[0].split(",")[0].trim() : "");

// ════════════════════════════════════════════════════════════════════════════
// CONNECTION ENGINE — scores every pair; flags the non-obvious "bridges"
// A bridge links events you would never file together: far apart in space, time,
// or agency, yet sharing a craft taxonomy, operational pattern, or tag fingerprint.
// Those are the "new connections before-thought-of locations" this app exists for.
// ════════════════════════════════════════════════════════════════════════════
const hav = (a, b) => {
  const R = 6371, r = (d) => (d * Math.PI) / 180;
  const dL = r(b.lat - a.lat), dG = r(b.lng - a.lng);
  const x = Math.sin(dL / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
const dDays = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
const ANG = new Set(["triangle", "chevron", "boomerang", "diamond"]);
const fmtKm = (km) => (km >= 1000 ? (km / 1000).toFixed(1) + "Mm" : Math.round(km) + "km");
const fmtSpan = (d) => (d >= 365 ? (d / 365).toFixed(d >= 3650 ? 0 : 1) + "yr" : Math.round(d) + "d");

function scorePair(a, b) {
  const f = [];
  const km = hav(a, b);
  const days = dDays(a.date, b.date);
  if (km < 80) f.push({ t: "proximity", s: 0.95, concept: false, r: Math.round(km) + "km apart" });
  else if (km < 400) f.push({ t: "proximity", s: Math.max(0.25, 0.65 - (km - 80) * 0.001), concept: false, r: Math.round(km) + "km, same region" });
  if (days < 7) f.push({ t: "temporal", s: 0.92, concept: false, r: Math.round(days) + "d apart, same wave" });
  else if (days < 60) f.push({ t: "temporal", s: 0.55, concept: false, r: Math.round(days) + " days apart" });
  if (a.shape === b.shape && a.shape !== "other" && a.shape !== "unknown") f.push({ t: "shape", s: 0.6, concept: true, r: "Both " + a.shape });
  if (ANG.has(a.shape) && ANG.has(b.shape) && a.shape !== b.shape) f.push({ t: "shape", s: 0.45, concept: true, r: "Angular family (" + a.shape + "/" + b.shape + ")" });
  if (a.theater && b.theater && a.theater === b.theater) f.push({ t: "pattern", s: 0.5, concept: true, r: "Same theater: " + a.theater });
  const sa = a.source && a.source.agency, sb = b.source && b.source.agency;
  if (sa && sb && sa === sb && sa !== "Other") f.push({ t: "pattern", s: 0.3, concept: false, r: "Same agency: " + sa });
  if (a.tags && b.tags) {
    const sh = a.tags.filter((t) => b.tags.includes(t) && t !== "historical" && t !== "PURSUE");
    if (sh.length) f.push({ t: "pattern", s: 0.3 + sh.length * 0.1, concept: true, r: "Shared signature: " + sh.slice(0, 3).join(", ") });
  }
  if (!f.length) return null;

  const sc = Math.min(1, f.reduce((s, x) => s + x.s, 0) / f.length + f.length * 0.05);
  f.sort((x, y) => y.s - x.s);

  // A bridge: a conceptual link that leaps across space / time / agency lines.
  const hasConcept = f.some((x) => x.concept);
  const crossAgency = sa && sb && sa !== sb && sa !== "Other" && sb !== "Other";
  const crossTheater = a.theater && b.theater && a.theater !== b.theater;
  const farSpace = km > 1500;
  const farTime = days > 365;
  const bridge = hasConcept && (farSpace || farTime || crossAgency || crossTheater);

  const leaps = [];
  if (km > 400) leaps.push(fmtKm(km));
  if (days > 60) leaps.push(fmtSpan(days) + " apart");
  if (crossAgency) leaps.push("cross-agency");
  else if (crossTheater) leaps.push("cross-theater");
  const note = f.slice(0, 3).map((x) => x.r).join(". ") + ".";

  return { type: f[0].t, strength: +sc.toFixed(2), bridge, km, days, span: leaps.join(" · "), note };
}

function buildConnections(db, max) {
  const out = [];
  for (let i = 0; i < db.length; i++)
    for (let j = i + 1; j < db.length; j++) {
      const r = scorePair(db[i], db[j]);
      // keep strong links, and keep bridges at a lower bar so non-obvious ones surface
      if (r && (r.strength > 0.55 || (r.bridge && r.strength > 0.42)))
        out.push({ from: db[i].id, to: db[j].id, ...r });
    }
  // nudge bridges up the ranking so the headline feature is never buried
  out.sort((a, b) => (b.bridge - a.bridge) * 0.15 + (b.strength - a.strength));
  return out.slice(0, max || 120).map((c, i) => ({ ...c, id: "auto" + i }));
}

// ════════════════════════════════════════════════════════════════════════════
// MAP — a tactical, pan/pinch-zoomable world canvas with ballistic arcs
// ════════════════════════════════════════════════════════════════════════════
function MapCanvas({ db, cn, sel, onSel, focus, showBridges }) {
  const cRef = useRef(null), boxRef = useRef(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });

  // mutable refs so pan/zoom + animation never trigger React re-renders
  const view = useRef({ s: 1, tx: 0, ty: 0 });
  const target = useRef(null);
  const dataRef = useRef(db), connRef = useRef(cn), selRef = useRef(sel), brRef = useRef(showBridges);
  dataRef.current = db; connRef.current = cn; selRef.current = sel; brRef.current = showBridges;
  const ptrs = useRef(new Map());
  const drag = useRef(null);
  const initedFor = useRef(0);

  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const ro = new ResizeObserver(([v]) => setSz({ w: Math.round(v.contentRect.width), h: Math.round(v.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const { w, h } = sz; if (!w) return { s: 1, tx: 0, ty: 0 };
    const worldH = w / 2;
    return { s: 1, tx: 0, ty: (h - worldH) / 2 };
  }, [sz]);

  const clamp = useCallback((v) => {
    const { w, h } = sz; const worldW = w * v.s, worldH = worldW / 2;
    v.s = Math.max(1, Math.min(14, v.s));
    v.tx = worldW <= w ? (w - worldW) / 2 : Math.min(0, Math.max(w - worldW, v.tx));
    v.ty = worldH <= h ? (h - worldH) / 2 : Math.min(0, Math.max(h - worldH, v.ty));
    return v;
  }, [sz]);

  const project = useCallback((lng, lat, v) => {
    const worldW = sz.w * v.s, worldH = worldW / 2;
    return { x: v.tx + ((lng + 180) / 360) * worldW, y: v.ty + ((90 - lat) / 180) * worldH };
  }, [sz]);

  // initialise / re-fit when the container is first measured or resized
  useEffect(() => {
    if (sz.w && initedFor.current !== sz.w + sz.h) {
      view.current = clamp(fit()); target.current = null; initedFor.current = sz.w + sz.h;
    }
  }, [sz, fit, clamp]);

  // imperative focus: tween the view to center & zoom a record
  useEffect(() => {
    if (!focus || !sz.w) return;
    const r = dataRef.current.find((d) => d.id === focus.id);
    if (!r) return;
    const s = Math.max(view.current.s, 3.2);
    const worldW = sz.w * s, worldH = worldW / 2;
    target.current = clamp({
      s,
      tx: sz.w / 2 - ((r.lng + 180) / 360) * worldW,
      ty: sz.h / 2 - ((90 - r.lat) / 180) * worldH,
    });
  }, [focus, sz, clamp]);

  const zoomAround = useCallback((factor, fx, fy) => {
    const v = view.current; const ns = Math.max(1, Math.min(14, v.s * factor)); const k = ns / v.s;
    v.tx = fx - (fx - v.tx) * k; v.ty = fy - (fy - v.ty) * k; v.s = ns;
    clamp(v); target.current = null;
  }, [clamp]);

  // main render loop
  useEffect(() => {
    const cv = cRef.current; if (!cv || !sz.w) return;
    const g = cv.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = sz.w * dpr; cv.height = sz.h * dpr;
    let raf;

    const bez = (a, c, b, t) => {
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
    };
    const ctrl = (a, b) => {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (ny > 0) { nx = -nx; ny = -ny; } // always bulge upward
      const bulge = Math.min(len * 0.24, 120);
      return { x: mx + nx * bulge, y: my + ny * bulge };
    };

    const draw = (now) => {
      const t = now / 1000;
      const v = view.current;
      if (target.current) {
        const tg = target.current, e = 0.16;
        v.s += (tg.s - v.s) * e; v.tx += (tg.tx - v.tx) * e; v.ty += (tg.ty - v.ty) * e;
        if (Math.abs(tg.s - v.s) < 0.002 && Math.abs(tg.tx - v.tx) < 0.5 && Math.abs(tg.ty - v.ty) < 0.5) {
          view.current = tg; target.current = null;
        }
      }
      const W = sz.w, H = sz.h;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const bg = g.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.85);
      bg.addColorStop(0, "#0a0f1a"); bg.addColorStop(1, "#04060c");
      g.fillStyle = bg; g.fillRect(0, 0, W, H);

      const P = (lng, lat) => project(lng, lat, v);

      // graticule
      g.strokeStyle = "rgba(56,189,248,.05)"; g.lineWidth = 0.5;
      for (let lng = -180; lng <= 180; lng += 30) {
        const a = P(lng, 85), b = P(lng, -85);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const a = P(-180, lat), b = P(180, lat);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }

      // landmasses
      g.lineWidth = 0.7; g.lineJoin = "round";
      for (const poly of LAND) {
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        g.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const p = P(poly[i][0], poly[i][1]);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (maxX < 0 || minX > W || maxY < 0 || minY > H) continue; // cull
        g.closePath();
        g.fillStyle = "#0e1b26"; g.fill();
        g.strokeStyle = "rgba(45,212,191,.22)"; g.stroke();
      }

      const data = dataRef.current, conns = connRef.current, s = selRef.current, onlyBr = brRef.current;
      const pm = {}; for (const d of data) pm[d.id] = P(d.lng, d.lat);

      // faint static web of every link
      for (const c of conns) {
        if (onlyBr && !c.bridge) continue;
        const a = pm[c.from], b = pm[c.to]; if (!a || !b) continue;
        if (s === c.from || s === c.to) continue; // hot links drawn animated below
        const cc = ctrl(a, b);
        g.strokeStyle = c.bridge ? "rgba(251,113,133,.16)" : "rgba(148,163,184,.06)";
        g.lineWidth = c.bridge ? 0.8 : 0.5;
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(cc.x, cc.y, b.x, b.y); g.stroke();
      }

      // animated arcs: every bridge, plus all links touching the selection
      g.lineCap = "round";
      for (const c of conns) {
        const hot = s === c.from || s === c.to;
        if (!(c.bridge || hot)) continue;
        if (onlyBr && !c.bridge && !hot) continue;
        const a = pm[c.from], b = pm[c.to]; if (!a || !b) continue;
        const cc = ctrl(a, b);
        const col = hot ? SEL_COL : c.bridge ? BRIDGE_COL : (TC[c.type] || TC.other);
        g.shadowBlur = hot ? 8 : 4; g.shadowColor = col;
        g.strokeStyle = hot ? col : col + "66";
        g.lineWidth = hot ? 1.6 : 1.0;
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(cc.x, cc.y, b.x, b.y); g.stroke();
        g.shadowBlur = 0;
        // ballistic tracer
        const seed = ((c.from.length * 7 + c.to.length * 13) % 100) / 100;
        const speed = hot ? 0.5 : 0.28;
        for (let k = 0; k < (hot ? 2 : 1); k++) {
          const tt = (t * speed + seed + k * 0.5) % 1;
          const p = bez(a, cc, b, tt);
          const tg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, hot ? 6 : 4);
          tg.addColorStop(0, col); tg.addColorStop(1, "transparent");
          g.fillStyle = tg; g.beginPath(); g.arc(p.x, p.y, hot ? 6 : 4, 0, 7); g.fill();
        }
      }

      // nodes
      for (const d of data) {
        const p = pm[d.id]; if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
        const isSel = s === d.id;
        const col = isSel ? SEL_COL : agencyColor(d);
        const pulse = 1 + 0.35 * Math.sin(t * 2.2 + (d.lat + d.lng));
        const r = isSel ? 5.5 : 2.6;
        const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4 * pulse);
        halo.addColorStop(0, col + (isSel ? "55" : "33")); halo.addColorStop(1, "transparent");
        g.fillStyle = halo; g.beginPath(); g.arc(p.x, p.y, r * 3.4 * pulse, 0, 7); g.fill();
        g.fillStyle = col; g.shadowBlur = isSel ? 10 : 0; g.shadowColor = col;
        g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill(); g.shadowBlur = 0;
        if (isSel) {
          g.strokeStyle = SEL_COL; g.lineWidth = 1; g.globalAlpha = 0.6 + 0.4 * Math.sin(t * 3);
          g.beginPath(); g.arc(p.x, p.y, r + 4 + 3 * (1 + Math.sin(t * 3)), 0, 7); g.stroke();
          g.globalAlpha = 1;
          g.font = "600 10px 'DM Mono', monospace"; g.fillStyle = SEL_COL;
          g.textAlign = p.x > W - 90 ? "right" : "left";
          const lx = p.x > W - 90 ? p.x - 10 : p.x + 10;
          g.fillText(shortLoc(d.location).toUpperCase(), lx, p.y - 8);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sz, project]);

  // ── gestures ────────────────────────────────────────────────────────────
  const localXY = (e) => { const r = cRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pickNode = (x, y) => {
    const v = view.current; let best = null, bd = 24;
    for (const d of dataRef.current) {
      const p = project(d.lng, d.lat, v); const dd = Math.hypot(p.x - x, p.y - y);
      if (dd < bd) { bd = dd; best = d.id; }
    }
    return best;
  };
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = localXY(e);
    ptrs.current.set(e.pointerId, { x, y });
    drag.current = { id: e.pointerId, moved: 0, sx: x, sy: y, pinch: 0 };
  };
  const onPointerMove = (e) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const { x, y } = localXY(e);
    const prev = ptrs.current.get(e.pointerId);
    ptrs.current.set(e.pointerId, { x, y });
    if (ptrs.current.size >= 2) {
      const pts = [...ptrs.current.values()]; const a = pts[0], b = pts[1];
      const distNow = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (drag.current && drag.current.pinch) zoomAround(distNow / drag.current.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      drag.current = { ...(drag.current || {}), pinch: distNow, moved: 99 };
      return;
    }
    if (drag.current && drag.current.id === e.pointerId) {
      const v = view.current; v.tx += x - prev.x; v.ty += y - prev.y; clamp(v); target.current = null;
      drag.current.moved += Math.abs(x - prev.x) + Math.abs(y - prev.y);
    }
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    ptrs.current.delete(e.pointerId);
    if (d && d.id === e.pointerId && d.moved < 8 && ptrs.current.size === 0) {
      const id = pickNode(d.sx, d.sy); onSel(id === selRef.current ? null : id);
    }
    if (ptrs.current.size === 0) drag.current = null;
  };
  const onWheel = (e) => { e.preventDefault(); const { x, y } = localXY(e); zoomAround(e.deltaY < 0 ? 1.18 : 0.85, x, y); };
  const recenter = () => { target.current = clamp(fit()); };

  const btn = { width: 34, height: 34, borderRadius: 9, background: "rgba(8,11,18,.82)", border: "1px solid #1b2433", color: "#7dd3fc", fontSize: 16, fontFamily: "var(--f)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center" };

  return (
    <div ref={boxRef} style={{ position: "relative", width: "100%", height: "44vh", maxHeight: 460, minHeight: 280, background: "#04060c", borderBottom: "1px solid #0f1420", overflow: "hidden" }}>
      <canvas
        ref={cRef}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "grab" }}
      />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,.18) 4px)", opacity: 0.35 }} />
      <div style={{ position: "absolute", top: 10, left: 12, pointerEvents: "none", fontSize: 8, letterSpacing: "0.18em", color: "#2dd4bf", opacity: 0.7 }}>{"◉"} GLOBAL UAP GRID</div>
      <div style={{ position: "absolute", top: 10, right: 12, pointerEvents: "none", fontSize: 8, letterSpacing: "0.1em", color: "#475569", textAlign: "right" }}>
        {db.length} CONTACTS<br />{(showBridges ? cn.filter((c) => c.bridge).length : cn.length)} {showBridges ? "BRIDGES" : "LINKS"}
      </div>
      <div style={{ position: "absolute", right: 10, bottom: 12, display: "flex", flexDirection: "column", gap: 7 }}>
        <button style={btn} onClick={() => zoomAround(1.5, sz.w / 2, sz.h / 2)} aria-label="Zoom in">+</button>
        <button style={btn} onClick={() => zoomAround(0.66, sz.w / 2, sz.h / 2)} aria-label="Zoom out">{"−"}</button>
        <button style={{ ...btn, fontSize: 13 }} onClick={recenter} aria-label="Recenter">{"⌖"}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LIST ROWS
// ════════════════════════════════════════════════════════════════════════════
function SRow({ s, sel, onTap, cc, bc }) {
  const col = agencyColor(s);
  return (
    <div onClick={() => onTap(s.id)} style={{ padding: "12px 14px", borderBottom: "1px solid #0c1018", background: sel ? "rgba(52,211,153,.04)" : "transparent", borderLeft: "2px solid " + (sel ? SEL_COL : "transparent"), cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ color: col, fontSize: 13, width: 16, textAlign: "center", flexShrink: 0 }}>{IC[s.shape] || "✦"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: sel ? SEL_COL : "#d1d5db", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.location}</div>
          <div style={{ fontSize: 9.5, color: "#3a455c", marginTop: 2 }}>{s.date}{s.designator ? " · " + s.designator : ""}{s.witnesses > 1 ? " · " + s.witnesses + "w" : ""}</div>
        </div>
        {s.source && s.source.agency !== "Other" && <span style={{ fontSize: 7.5, padding: "2px 5px", borderRadius: 3, background: col + "1a", color: col, flexShrink: 0 }}>{s.source.agency}</span>}
        {bc > 0 && <span style={{ fontSize: 7.5, padding: "2px 5px", borderRadius: 3, background: BRIDGE_COL + "1a", color: BRIDGE_COL, flexShrink: 0 }} title="bridge links">{"✧"}{bc}</span>}
        {cc > 0 && <span style={{ fontSize: 7.5, padding: "2px 5px", borderRadius: 3, background: "#f9731614", color: "#f97316", flexShrink: 0 }} title="total links">{cc}</span>}
      </div>
      {sel && (
        <div style={{ paddingLeft: 25, marginTop: 10 }}>
          <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.65, fontFamily: "var(--s)", margin: 0 }}>{s.description}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
            {(s.evidence || []).map((e) => <span key={e} style={{ fontSize: 7.5, padding: "2px 6px", borderRadius: 3, background: "#0e1521", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>{e}</span>)}
            {s.status && <span style={{ fontSize: 7.5, padding: "2px 6px", borderRadius: 3, background: "#0e1521", color: "#7dd3fc", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.status}</span>}
          </div>
          {s.source && s.source.url && <a href={s.source.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-block", marginTop: 9, fontSize: 9.5, color: SEL_COL, textDecoration: "none" }}>{"↗ "}{s.source.collection} source</a>}
        </div>
      )}
    </div>
  );
}

function CRow({ c, byId, hi, onTap }) {
  const a = byId[c.from], b = byId[c.to]; if (!a || !b) return null;
  const col = c.bridge ? BRIDGE_COL : (TC[c.type] || TC.other);
  return (
    <div onClick={() => onTap && onTap(c.from)} style={{ padding: "12px 14px", borderBottom: "1px solid #0c1018", background: hi ? col + "10" : "transparent", borderLeft: "2px solid " + (hi ? col : "transparent"), cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {c.bridge && <span style={{ fontSize: 9, color: BRIDGE_COL }}>{"✧"}</span>}
        <span style={{ fontSize: 11.5, color: "#f1f5f9" }}>{shortLoc(a.location)}</span>
        <span style={{ fontSize: 9, color: "#334155" }}>{"↔"}</span>
        <span style={{ fontSize: 11.5, color: "#f1f5f9" }}>{shortLoc(b.location)}</span>
        <span style={{ marginLeft: "auto", fontSize: 7, padding: "2px 6px", borderRadius: 3, background: col + "1c", color: col, textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.bridge ? "bridge" : c.type}</span>
      </div>
      {c.span && <div style={{ fontSize: 8.5, color: BRIDGE_COL, marginTop: 5, letterSpacing: "0.04em" }}>{c.span}</div>}
      <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "6px 0 0", lineHeight: 1.6, fontFamily: "var(--s)" }}>{c.note}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8 }}>
        <div style={{ flex: 1, height: 2, background: "#111622", borderRadius: 1 }}>
          <div style={{ width: (c.strength * 100) + "%", height: "100%", background: col, borderRadius: 1 }} />
        </div>
        <span style={{ fontSize: 7.5, color: col }}>{(c.strength * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// APP
// ════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [data, setData] = useState([]);
  const [meta, setMeta] = useState(null);
  const [live, setLive] = useState(false);
  const [sel, setSel] = useState(null);
  const [focus, setFocus] = useState(null);
  const [tab, setTab] = useState("files");
  const [search, setSearch] = useState("");
  const [agency, setAgency] = useState("all");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (DATA_URL) {
        try {
          const r = await fetch(DATA_URL); const j = await r.json();
          setData(j.records || j); setMeta({ generated_at: j.generated_at, count: j.count }); setLive(true); setReady(true); return;
        } catch (e) { /* fall back to bundled snapshot */ }
      }
      const recs = snapshot.records || snapshot;
      setData(recs); setMeta({ generated_at: snapshot.generated_at, count: recs.length }); setReady(true);
    })();
  }, []);

  const conns = useMemo(() => buildConnections(data, 130), [data]);
  const byId = useMemo(() => { const m = {}; data.forEach((s) => { m[s.id] = s; }); return m; }, [data]);
  const linkCount = useMemo(() => { const m = {}; conns.forEach((c) => { m[c.from] = (m[c.from] || 0) + 1; m[c.to] = (m[c.to] || 0) + 1; }); return m; }, [conns]);
  const bridgeCount = useMemo(() => { const m = {}; conns.forEach((c) => { if (c.bridge) { m[c.from] = (m[c.from] || 0) + 1; m[c.to] = (m[c.to] || 0) + 1; } }); return m; }, [conns]);
  const bridges = useMemo(() => conns.filter((c) => c.bridge), [conns]);
  const agencies = useMemo(() => { const s = new Set(data.map((d) => d.source && d.source.agency).filter((a) => a && a !== "Other")); return ["all", ...Array.from(s).sort()]; }, [data]);

  const filtered = useMemo(() => {
    let r = data;
    if (agency !== "all") r = r.filter((s) => s.source && s.source.agency === agency);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter((s) => s.location.toLowerCase().includes(q) || s.date.includes(q) || s.shape.includes(q) || (s.designator || "").toLowerCase().includes(q) || (s.tags || []).some((t) => t.includes(q)) || s.description.toLowerCase().includes(q));
    }
    return r;
  }, [data, search, agency]);

  const visibleIds = useMemo(() => new Set(filtered.map((s) => s.id)), [filtered]);
  const mapConns = useMemo(() => conns.filter((c) => visibleIds.has(c.from) && visibleIds.has(c.to)), [conns, visibleIds]);

  const select = useCallback((id) => { setSel(id); }, []);
  const locate = useCallback((id) => { setSel(id); if (id) setFocus({ id, n: Date.now() }); }, []);

  if (!ready) return <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#04060c", color: SEL_COL, fontFamily: "monospace", fontSize: 11, letterSpacing: "0.2em" }}>ACQUIRING SIGNAL{"…"}</div>;

  const showBridges = tab === "bridges";
  const tabs = [["files", filtered.length], ["connections", conns.length], ["bridges", bridges.length]];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Newsreader:ital,wght@0,300;0,400;1,300&display=swap');
        :root { --f: 'DM Mono', monospace; --s: 'Newsreader', Georgia, serif; }
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        html, body { background: #04060c; overscroll-behavior: none; }
        ::-webkit-scrollbar { width: 0; height: 0; }
        button { cursor: pointer; }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
      `}</style>
      <div style={{ minHeight: "100dvh", maxWidth: 520, margin: "0 auto", background: "#080b12", color: "#d1d5db", fontFamily: "var(--f)", fontSize: 12 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderBottom: "1px solid #0f1420", position: "sticky", top: 0, zIndex: 50, background: "rgba(8,11,18,.95)", backdropFilter: "blur(12px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ fontSize: 19, color: SEL_COL }}>{"◎"}</span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: SEL_COL, letterSpacing: "0.14em" }}>SIGINT</div>
              <div style={{ fontSize: 6.5, color: "#3a455c", letterSpacing: "0.18em" }}>{data.length} FILES · {agencies.length - 1} AGENCIES · {bridges.length} BRIDGES</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 7.5, letterSpacing: "0.12em", color: live ? SEL_COL : "#475569" }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: live ? SEL_COL : "#475569", animation: live ? "blink 1.6s infinite" : "none" }} />
            {live ? "LIVE" : "SNAPSHOT"}
          </div>
        </header>

        {data.length > 0 && <MapCanvas db={filtered} cn={mapConns} sel={sel} onSel={select} focus={focus} showBridges={showBridges} />}

        <div style={{ padding: "9px 14px", borderBottom: "1px solid #0f1420" }}>
          <input placeholder="Search files, designators, locations, tags…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", padding: "10px 12px", fontSize: 13, fontFamily: "var(--f)", background: "#060810", border: "1px solid #111822", borderRadius: 9, color: "#d1d5db", outline: "none" }} />
        </div>

        <div style={{ padding: "0 14px 9px", borderBottom: "1px solid #0f1420", display: "flex", gap: 6, overflowX: "auto", whiteSpace: "nowrap" }}>
          {agencies.map((a) => (
            <button key={a} onClick={() => setAgency(a)} style={{ flexShrink: 0, padding: "6px 11px", fontSize: 9, borderRadius: 7, fontFamily: "var(--f)", textTransform: "uppercase", letterSpacing: "0.05em", background: agency === a ? "rgba(52,211,153,.12)" : "transparent", border: "1px solid " + (agency === a ? "rgba(52,211,153,.3)" : "#151c2a"), color: agency === a ? SEL_COL : "#64748b" }}>{a}</button>
          ))}
        </div>

        <nav style={{ display: "flex", position: "sticky", top: 47, zIndex: 40, background: "rgba(8,11,18,.95)", backdropFilter: "blur(12px)", borderBottom: "1px solid #0f1420" }}>
          {tabs.map(([t, n]) => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "12px 0", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", background: "transparent", border: "none", fontFamily: "var(--f)", borderBottom: "2px solid " + (tab === t ? (t === "bridges" ? BRIDGE_COL : SEL_COL) : "transparent"), color: tab === t ? (t === "bridges" ? BRIDGE_COL : SEL_COL) : "#3a455c" }}>{t} ({n})</button>
          ))}
        </nav>

        {tab === "bridges" && (
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #0f1420", background: "rgba(251,113,133,.04)", fontSize: 11, color: "#94a3b8", lineHeight: 1.6, fontFamily: "var(--s)" }}>
            <span style={{ color: BRIDGE_COL }}>{"✧"} Bridges</span> are non-obvious links — events separated by thousands of km, decades, or agency silos, yet sharing a craft taxonomy, theater, or signature. The connections nobody filed together.
          </div>
        )}

        <div style={{ paddingBottom: "calc(40px + env(safe-area-inset-bottom))" }}>
          {tab === "files" && filtered.map((s) => <SRow key={s.id} s={s} sel={sel === s.id} onTap={locate} cc={linkCount[s.id] || 0} bc={bridgeCount[s.id] || 0} />)}
          {tab === "files" && filtered.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#334155", fontSize: 11 }}>No matches.</div>}
          {tab === "connections" && conns.map((c) => <CRow key={c.id} c={c} byId={byId} hi={sel === c.from || sel === c.to} onTap={locate} />)}
          {tab === "bridges" && bridges.map((c) => <CRow key={c.id} c={c} byId={byId} hi={sel === c.from || sel === c.to} onTap={locate} />)}
          {tab === "bridges" && bridges.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#334155", fontSize: 11 }}>No bridges in current view.</div>}
        </div>

        <footer style={{ padding: "11px 14px", borderTop: "1px solid #0f1420", fontSize: 7, color: "#3a455c", letterSpacing: "0.1em", textAlign: "center" }}>
          {meta && meta.generated_at ? "DATA " + meta.generated_at.slice(0, 10) : ""} · ALGORITHM-COMPUTED LINKS · {conns.length} LINKS / {bridges.length} BRIDGES
        </footer>
      </div>
    </>
  );
}
