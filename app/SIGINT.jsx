import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { LAND } from "./world.js";
import bootstrap from "./bootstrap.json";

// ════════════════════════════════════════════════════════════════════════════
// DATA
// The full archive (data/files.json) can run to tens of thousands of records, so
// it is served statically and fetched at runtime. A small curated bootstrap is
// bundled for instant, offline-capable first paint; the full set swaps in once
// fetched. Override DATA_URL to point at a hosted files.json instead.
// ════════════════════════════════════════════════════════════════════════════
const BASE = (import.meta && import.meta.env && import.meta.env.BASE_URL) || "/";
const DATA_URL = BASE + "files.json";
// Cap the O(n²) connection engine to the most notable records so it stays fast
// no matter how large the archive grows. Every record still renders + is searchable.
const WORK_CAP = 1400;

// ════════════════════════════════════════════════════════════════════════════
// PALETTE
// ════════════════════════════════════════════════════════════════════════════
const AGENCY_COL = {
  CENTCOM: "#fb923c", INDOPACOM: "#fbbf24", NORAD: "#f87171", Army: "#a3e635",
  Navy: "#38bdf8", AirForce: "#7dd3fc", FBI: "#c084fc", CIA: "#a78bfa",
  NSA: "#818cf8", NASA: "#f472b6", NARA: "#2dd4bf", NUFORC: "#94a3b8",
  DoD: "#fb923c", AARO: "#22d3ee", State: "#34d399", Other: "#7c8aa0",
};
const TC = { proximity: "#38bdf8", temporal: "#fbbf24", shape: "#c084fc", pattern: "#fb923c", other: "#7c8aa0" };
const BRIDGE_COL = "#fb7185"; // bridges — the cross-space/time/agency links
const SEL_COL = "#34d399";
const HUD = "#22d3ee";
const IC = { disc: "◉", triangle: "△", orb: "●", cigar: "▬", chevron: "⟨⟩", diamond: "◇", boomerang: "⌒", other: "✦", unknown: "?" };

const agencyColor = (s) => AGENCY_COL[s && s.source && s.source.agency] || "#7c8aa0";
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
// generic tags that carry no real "signature" — excluded from bridge matching
const STOP_TAGS = new Set(["historical", "PURSUE", "NUFORC", "civilian", "disc", "triangle", "orb", "cigar", "chevron", "boomerang", "diamond", "other", "unknown"]);
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
  if (a.shape === b.shape && a.shape !== "other" && a.shape !== "unknown") {
    // distinctive craft shapes are meaningful links; ubiquitous "orb" is weak
    const distinctive = a.shape !== "orb";
    f.push({ t: "shape", s: distinctive ? 0.6 : 0.36, concept: distinctive, r: "Both " + a.shape });
  }
  if (ANG.has(a.shape) && ANG.has(b.shape) && a.shape !== b.shape) f.push({ t: "shape", s: 0.45, concept: true, r: "Angular family (" + a.shape + "/" + b.shape + ")" });
  if (a.theater && b.theater && a.theater === b.theater && a.theater !== "US-Domestic") f.push({ t: "pattern", s: 0.5, concept: true, r: "Same theater: " + a.theater });
  const sa = a.source && a.source.agency, sb = b.source && b.source.agency;
  if (sa && sb && sa === sb && sa !== "Other" && sa !== "NUFORC") f.push({ t: "pattern", s: 0.3, concept: false, r: "Same agency: " + sa });
  if (a.tags && b.tags) {
    const sh = a.tags.filter((t) => b.tags.includes(t) && !STOP_TAGS.has(t));
    if (sh.length) f.push({ t: "pattern", s: 0.3 + sh.length * 0.12, concept: true, r: "Shared signature: " + sh.slice(0, 3).join(", ") });
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

// Local "wave" finder — proximity/temporal clusters across the FULL dataset.
// Sorting by date lets us slide a short time window, so this stays near-linear
// even at thousands of records (vs the O(n²) bridge pass on the notable set).
function buildClusters(db, max) {
  const s = [...db].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length && j < i + 1600; j++) {
      if (dDays(s[i].date, s[j].date) > 21) break;       // window closed
      if (hav(s[i], s[j]) > 160) continue;               // not local
      const r = scorePair(s[i], s[j]);
      if (r && !r.bridge && r.strength > 0.6) out.push({ from: s[i].id, to: s[j].id, ...r });
    }
  }
  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, max || 200);
}

// notability score — used to pick the working set the connection engine runs on
const DISTINCT = new Set(["disc", "triangle", "cigar", "chevron", "boomerang", "diamond"]);
const notability = (r) => {
  let s = 0;
  const ag = r.source && r.source.agency;
  if (ag && ag !== "NUFORC" && ag !== "Other") s += 1000;
  if (r.designator) s += 200;
  if (DISTINCT.has(r.shape)) s += 60;
  s += Math.min(60, Math.log10((r.witnesses || 1) + 1) * 24);
  s += Math.min(40, (r.description || "").length / 12);
  return s;
};

// ════════════════════════════════════════════════════════════════════════════
// MAP — a tactical, pan/pinch-zoomable world canvas with ballistic arcs
// ════════════════════════════════════════════════════════════════════════════
const glowCache = {};
function glowSprite(col) {
  if (glowCache[col]) return glowCache[col];
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const x = c.getContext("2d");
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, col); gr.addColorStop(0.35, col + "88"); gr.addColorStop(1, "transparent");
  x.fillStyle = gr; x.beginPath(); x.arc(32, 32, 32, 0, 7); x.fill();
  glowCache[col] = c; return c;
}

function MapCanvas({ db, cn, sel, onSel, focus, showBridges }) {
  const cRef = useRef(null), boxRef = useRef(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });

  // mutable refs so pan/zoom + animation never trigger React re-renders
  const view = useRef({ s: 1, tx: 0, ty: 0 });
  const target = useRef(null);
  const dataRef = useRef(db), connRef = useRef(cn), selRef = useRef(sel), brRef = useRef(showBridges);
  dataRef.current = db; connRef.current = cn; selRef.current = sel; brRef.current = showBridges;
  const recMap = useMemo(() => { const m = {}; for (const d of db) m[d.id] = d; return m; }, [db]);
  const recMapRef = useRef(recMap); recMapRef.current = recMap;
  // precomputed geometry (normalized coords + color) so the per-frame node loop
  // does no allocation or string work — essential at thousands of nodes
  const geom = useMemo(() => {
    const n = db.length, nx = new Float64Array(n), ny = new Float64Array(n), col = new Array(n);
    for (let i = 0; i < n; i++) { const d = db[i]; nx[i] = (d.lng + 180) / 360; ny[i] = (90 - d.lat) / 180; col[i] = agencyColor(d); }
    return { nx, ny, col, ids: db.map((d) => d.id) };
  }, [db]);
  const geomRef = useRef(geom); geomRef.current = geom;
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

  useEffect(() => {
    if (sz.w && initedFor.current !== sz.w + sz.h) {
      view.current = clamp(fit()); target.current = null; initedFor.current = sz.w + sz.h;
    }
  }, [sz, fit, clamp]);

  useEffect(() => {
    if (!focus || !sz.w) return;
    const r = dataRef.current.find((d) => d.id === focus.id);
    if (!r) return;
    const s = Math.max(view.current.s, 3.4);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = sz.w * dpr; cv.height = sz.h * dpr;
    let raf;
    const sgc = document.createElement("canvas"); sgc.width = cv.width; sgc.height = cv.height;
    const sgx = sgc.getContext("2d");
    let lastSig = "";

    const bez = (a, c, b, t) => {
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
    };
    const ctrl = (a, b) => {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (ny > 0) { nx = -nx; ny = -ny; } // always bulge upward
      const bulge = Math.min(len * 0.26, 130);
      return { x: mx + nx * bulge, y: my + ny * bulge };
    };

    // static map layer (bg + graticule + coastlines) — repainted only when the
    // view changes, then blitted each frame so animation stays cheap at any scale
    const paintStatic = (c, v, W, H) => {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const bg = c.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.9);
      bg.addColorStop(0, "#0a1320"); bg.addColorStop(0.6, "#070d17"); bg.addColorStop(1, "#04070e");
      c.fillStyle = bg; c.fillRect(0, 0, W, H);
      const P = (lng, lat) => project(lng, lat, v);
      c.lineWidth = 0.5; c.setLineDash([1, 5]); c.lineCap = "round";
      for (let lng = -180; lng <= 180; lng += 30) {
        const a = P(lng, 88), b = P(lng, -88);
        c.strokeStyle = "rgba(56,189,248,.07)";
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const a = P(-180, lat), b = P(180, lat);
        c.strokeStyle = lat === 0 ? "rgba(56,189,248,.16)" : "rgba(56,189,248,.07)";
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
      c.setLineDash([]);
      for (const poly of LAND) {
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        c.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const p = P(poly[i][0], poly[i][1]);
          if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (maxX < -5 || minX > W + 5 || maxY < -5 || minY > H + 5) continue;
        c.closePath();
        const lg = c.createLinearGradient(0, minY, 0, maxY || minY + 1);
        lg.addColorStop(0, "#13283a"); lg.addColorStop(1, "#0c1a28");
        c.fillStyle = lg; c.fill();
        c.lineJoin = "round";
        c.shadowBlur = 6; c.shadowColor = "rgba(45,212,191,.5)";
        c.strokeStyle = "rgba(94,234,212,.55)"; c.lineWidth = 0.9; c.stroke();
        c.shadowBlur = 0;
      }
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
      const sig = v.s.toFixed(3) + "|" + v.tx.toFixed(1) + "|" + v.ty.toFixed(1);
      if (sig !== lastSig) { paintStatic(sgx, v, W, H); lastSig = sig; }
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(sgc, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const P = (lng, lat) => project(lng, lat, v);

      const data = dataRef.current, conns = connRef.current, s = selRef.current, onlyBr = brRef.current;
      const rm = recMapRef.current;
      const pos = (id) => { const d = rm[id]; return d ? P(d.lng, d.lat) : null; };

      // faint static web of every link
      for (const c of conns) {
        if (onlyBr && !c.bridge) continue;
        const a = pos(c.from), b = pos(c.to); if (!a || !b) continue;
        if (s === c.from || s === c.to) continue;
        const cc = ctrl(a, b);
        g.strokeStyle = c.bridge ? "rgba(251,113,133,.22)" : "rgba(125,211,252,.08)";
        g.lineWidth = c.bridge ? 0.9 : 0.6;
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(cc.x, cc.y, b.x, b.y); g.stroke();
      }

      // animated ballistic arcs: every bridge + all links touching the selection
      g.lineCap = "round";
      for (const c of conns) {
        const hot = s === c.from || s === c.to;
        if (!(c.bridge || hot)) continue;
        if (onlyBr && !c.bridge && !hot) continue;
        const a = pos(c.from), b = pos(c.to); if (!a || !b) continue;
        const cc = ctrl(a, b);
        const col = hot ? SEL_COL : c.bridge ? BRIDGE_COL : (TC[c.type] || TC.other);
        // arc body (glow comes from the travelling comet head — cheaper than shadowBlur)
        g.strokeStyle = hot ? col : col + "77";
        g.lineWidth = hot ? 1.7 : 1.1;
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(cc.x, cc.y, b.x, b.y); g.stroke();
        // comet tracer travelling along the arc
        const seed = ((c.from.length * 7 + c.to.length * 13) % 100) / 100;
        const speed = hot ? 0.42 : 0.26;
        const head = (t * speed + seed) % 1;
        const TRAIL = 9;
        for (let k = TRAIL; k >= 0; k--) {
          const tt = head - k * 0.022; if (tt < 0) continue;
          const p = bez(a, cc, b, tt);
          const f = 1 - k / TRAIL;
          g.globalAlpha = f * f * (hot ? 0.95 : 0.8);
          g.fillStyle = col;
          g.beginPath(); g.arc(p.x, p.y, (hot ? 2.6 : 2.0) * f + 0.4, 0, 7); g.fill();
        }
        g.globalAlpha = 1;
        const hp = bez(a, cc, b, head);
        const hr = hot ? 12 : 9;
        g.globalAlpha = 0.9; g.drawImage(glowSprite(col), hp.x - hr, hp.y - hr, hr * 2, hr * 2); g.globalAlpha = 1;
      }

      // which nodes get the expensive rich treatment
      const hiSet = new Set(); if (s) hiSet.add(s);
      for (const c of conns) { if (c.bridge || s === c.from || s === c.to) { hiSet.add(c.from); hiSet.add(c.to); } }

      const drawRich = (d, p) => {
        const isSel = s === d.id;
        const col = isSel ? SEL_COL : agencyColor(d);
        const pulse = 0.75 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.0 + (d.lat + d.lng)));
        const r = isSel ? 5.5 : 3.0;
        const gr = (isSel ? 26 : 16) * pulse;
        g.globalAlpha = isSel ? 0.9 : 0.55;
        g.drawImage(glowSprite(col), p.x - gr, p.y - gr, gr * 2, gr * 2);
        g.globalAlpha = 1;
        g.strokeStyle = col; g.lineWidth = 1; g.globalAlpha = 0.7;
        g.beginPath(); g.arc(p.x, p.y, r + 1.5, 0, 7); g.stroke(); g.globalAlpha = 1;
        g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill();
        g.fillStyle = "rgba(255,255,255,.92)"; g.beginPath(); g.arc(p.x, p.y, r * 0.42, 0, 7); g.fill();
        if (isSel) {
          const rr = r + 7 + 4 * (1 + Math.sin(t * 3));
          g.strokeStyle = SEL_COL; g.lineWidth = 1.1; g.globalAlpha = 0.5 + 0.4 * Math.sin(t * 3);
          g.beginPath(); g.arc(p.x, p.y, rr, 0, 7); g.stroke();
          g.beginPath();
          g.moveTo(p.x - rr - 4, p.y); g.lineTo(p.x - rr + 2, p.y);
          g.moveTo(p.x + rr - 2, p.y); g.lineTo(p.x + rr + 4, p.y);
          g.moveTo(p.x, p.y - rr - 4); g.lineTo(p.x, p.y - rr + 2);
          g.moveTo(p.x, p.y + rr - 2); g.lineTo(p.x, p.y + rr + 4);
          g.stroke(); g.globalAlpha = 1;
          const label = shortLoc(d.location).toUpperCase();
          g.font = "600 10px 'DM Mono', monospace";
          const tw = g.measureText(label).width;
          const right = p.x > W - tw - 30;
          const lx = right ? p.x - 16 - tw - 10 : p.x + 16;
          const ly = p.y - 8;
          g.fillStyle = "rgba(4,8,14,.78)"; g.fillRect(lx - 5, ly - 11, tw + 10, 16);
          g.fillStyle = SEL_COL; g.textAlign = "left"; g.textBaseline = "middle";
          g.fillText(label, lx, ly - 3 + 0.5);
        }
      };

      // nodes — rich for small sets; at scale, cheap color-batched dots + rich only for highlights
      if (data.length <= 1200) {
        for (const d of data) {
          const p = P(d.lng, d.lat);
          if (p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30) continue;
          drawRich(d, p);
        }
      } else {
        // cheap color-batched dots via precomputed geometry (no per-node allocation)
        const gm = geomRef.current, n = gm.ids.length;
        const worldW = W * v.s, worldH = worldW / 2, ox = v.tx, oy = v.ty;
        const groups = new Map();
        for (let i = 0; i < n; i++) {
          if (hiSet.has(gm.ids[i])) continue;
          const x = ox + gm.nx[i] * worldW; if (x < -4 || x > W + 4) continue;
          const y = oy + gm.ny[i] * worldH; if (y < -4 || y > H + 4) continue;
          let arr = groups.get(gm.col[i]); if (!arr) { arr = []; groups.set(gm.col[i], arr); }
          arr.push(x, y);
        }
        g.globalAlpha = 0.9;
        for (const [col, arr] of groups) {
          g.fillStyle = col;
          for (let i = 0; i < arr.length; i += 2) g.fillRect(arr[i] - 0.9, arr[i + 1] - 0.9, 1.9, 1.9);
        }
        g.globalAlpha = 1;
        for (const id of hiSet) { const d = rm[id]; if (!d) continue; drawRich(d, P(d.lng, d.lat)); }
        if (s && rm[s]) drawRich(rm[s], P(rm[s].lng, rm[s].lat)); // ensure selected on top
      }

      // corner targeting brackets
      const m = 10, L = 16;
      g.strokeStyle = "rgba(34,211,238,.4)"; g.lineWidth = 1.2; g.beginPath();
      g.moveTo(m, m + L); g.lineTo(m, m); g.lineTo(m + L, m);
      g.moveTo(W - m - L, m); g.lineTo(W - m, m); g.lineTo(W - m, m + L);
      g.moveTo(m, H - m - L); g.lineTo(m, H - m); g.lineTo(m + L, H - m);
      g.moveTo(W - m - L, H - m); g.lineTo(W - m, H - m); g.lineTo(W - m, H - m - L);
      g.stroke();

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
      const vv = view.current; vv.tx += x - prev.x; vv.ty += y - prev.y; clamp(vv); target.current = null;
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

  const btn = { width: 36, height: 36, borderRadius: 10, background: "rgba(7,13,23,.72)", border: "1px solid rgba(34,211,238,.28)", color: HUD, fontSize: 17, fontFamily: "var(--f)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 10px rgba(0,0,0,.4)" };

  return (
    <div ref={boxRef} style={{ position: "relative", width: "100%", height: "48vh", maxHeight: 540, minHeight: 300, background: "#04070e", borderBottom: "1px solid #10202e", overflow: "hidden" }}>
      <canvas
        ref={cRef}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "grab" }}
      />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,.16) 3px)", opacity: 0.5 }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 90px rgba(2,4,8,.85)" }} />
      <div style={{ position: "absolute", top: 16, left: 20, pointerEvents: "none", display: "flex", alignItems: "center", gap: 6, fontSize: 8.5, letterSpacing: "0.22em", color: HUD }}>
        <span style={{ width: 5, height: 5, borderRadius: 3, background: HUD, boxShadow: "0 0 6px " + HUD, animation: "blink 1.6s infinite" }} /> GLOBAL UAP GRID
      </div>
      <div style={{ position: "absolute", top: 16, right: 20, pointerEvents: "none", fontSize: 8.5, lineHeight: 1.5, letterSpacing: "0.1em", color: "#5b7186", textAlign: "right" }}>
        <span style={{ color: "#cbd5e1" }}>{db.length}</span> CONTACTS<br />
        <span style={{ color: showBridges ? BRIDGE_COL : "#cbd5e1" }}>{showBridges ? cn.filter((c) => c.bridge).length : cn.length}</span> {showBridges ? "BRIDGES" : "LINKS"}
      </div>
      <div style={{ position: "absolute", left: 20, bottom: 14, pointerEvents: "none", fontSize: 7.5, letterSpacing: "0.18em", color: "#44566e" }}>EQUIRECTANGULAR · DRAG / PINCH</div>
      <div style={{ position: "absolute", right: 12, bottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <button style={btn} onClick={() => zoomAround(1.5, sz.w / 2, sz.h / 2)} aria-label="Zoom in">+</button>
        <button style={btn} onClick={() => zoomAround(0.66, sz.w / 2, sz.h / 2)} aria-label="Zoom out">{"−"}</button>
        <button style={{ ...btn, fontSize: 14 }} onClick={recenter} aria-label="Recenter">{"⌖"}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LIST ROWS
// ════════════════════════════════════════════════════════════════════════════
function Token({ col, glyph }) {
  return (
    <span style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: col, background: col + "14", border: "1px solid " + col + "33", boxShadow: "0 0 10px " + col + "1f inset" }}>{glyph}</span>
  );
}

function SRow({ s, sel, onTap, cc, bc }) {
  const col = agencyColor(s);
  return (
    <div onClick={() => onTap(s.id)} style={{ padding: "13px 16px", borderBottom: "1px solid #0b0f18", background: sel ? "linear-gradient(90deg, rgba(52,211,153,.06), transparent)" : "transparent", borderLeft: "2px solid " + (sel ? SEL_COL : "transparent"), cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <Token col={sel ? SEL_COL : col} glyph={IC[s.shape] || "✦"} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: sel ? SEL_COL : "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.location}</div>
          <div style={{ fontSize: 9.5, color: "#4a5a70", marginTop: 3, letterSpacing: "0.02em" }}>{s.date}{s.designator ? " · " + s.designator : ""}{s.witnesses > 1 ? " · " + s.witnesses.toLocaleString() + "w" : ""}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
          {s.source && s.source.agency !== "Other" && <span style={{ fontSize: 7.5, padding: "2px 6px", borderRadius: 4, background: col + "1a", color: col, letterSpacing: "0.05em" }}>{s.source.agency}</span>}
          <div style={{ display: "flex", gap: 4 }}>
            {bc > 0 && <span style={{ fontSize: 7.5, padding: "2px 5px", borderRadius: 4, background: BRIDGE_COL + "1a", color: BRIDGE_COL }} title="bridge links">{"✧"}{bc}</span>}
            {cc > 0 && <span style={{ fontSize: 7.5, padding: "2px 5px", borderRadius: 4, background: "#fb923c18", color: "#fb923c" }} title="total links">{"⌁"}{cc}</span>}
          </div>
        </div>
      </div>
      {sel && (
        <div style={{ paddingLeft: 41, marginTop: 11 }}>
          <p style={{ fontSize: 13.5, color: "#9fb0c4", lineHeight: 1.7, fontFamily: "var(--s)", margin: 0 }}>{s.description}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 11 }}>
            {(s.evidence || []).map((e) => <span key={e} style={{ fontSize: 7.5, padding: "3px 7px", borderRadius: 4, background: "#0d1623", color: "#7c8aa0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{e}</span>)}
            {s.status && <span style={{ fontSize: 7.5, padding: "3px 7px", borderRadius: 4, background: "#0d1623", color: HUD, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.status}</span>}
          </div>
          {s.source && s.source.url && <a href={s.source.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-block", marginTop: 11, fontSize: 9.5, color: SEL_COL, textDecoration: "none", letterSpacing: "0.04em" }}>{"↗ "}{s.source.collection} source</a>}
        </div>
      )}
    </div>
  );
}

function CRow({ c, byId, hi, onTap }) {
  const a = byId[c.from], b = byId[c.to]; if (!a || !b) return null;
  const col = c.bridge ? BRIDGE_COL : (TC[c.type] || TC.other);
  return (
    <div onClick={() => onTap && onTap(c.from)} style={{ padding: "13px 16px", borderBottom: "1px solid #0b0f18", background: hi ? "linear-gradient(90deg, " + col + "12, transparent)" : "transparent", borderLeft: "2px solid " + (hi ? col : "transparent"), cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        {c.bridge && <span style={{ fontSize: 10, color: BRIDGE_COL }}>{"✧"}</span>}
        <span style={{ fontSize: 12, color: "#e2e8f0" }}>{shortLoc(a.location)}</span>
        <span style={{ fontSize: 11, color: col }}>{"⟿"}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0" }}>{shortLoc(b.location)}</span>
        <span style={{ marginLeft: "auto", fontSize: 7, padding: "2px 7px", borderRadius: 4, background: col + "1f", color: col, textTransform: "uppercase", letterSpacing: "0.08em" }}>{c.bridge ? "bridge" : c.type}</span>
      </div>
      {c.span && <div style={{ fontSize: 8.5, color: c.bridge ? BRIDGE_COL : "#5b7186", marginTop: 6, letterSpacing: "0.05em" }}>{c.span}</div>}
      <p style={{ fontSize: 12.5, color: "#9fb0c4", margin: "7px 0 0", lineHeight: 1.6, fontFamily: "var(--s)" }}>{c.note}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
        <div style={{ flex: 1, height: 2.5, background: "#0e1622", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: (c.strength * 100) + "%", height: "100%", background: "linear-gradient(90deg, " + col + "55, " + col + ")", borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 7.5, color: col, width: 26, textAlign: "right" }}>{(c.strength * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function Stat({ n, label, col }) {
  return (
    <div style={{ flex: 1, textAlign: "center", padding: "8px 0" }}>
      <div style={{ fontSize: 17, fontWeight: 500, color: col, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 7, color: "#4a5a70", letterSpacing: "0.16em", marginTop: 4 }}>{label}</div>
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
    // instant first paint from the bundled bootstrap…
    const boot = bootstrap.records || bootstrap;
    setData(boot); setMeta({ generated_at: bootstrap.generated_at, count: bootstrap.total || boot.length }); setReady(true);
    // …then swap in the full archive once fetched
    (async () => {
      try {
        const r = await fetch(DATA_URL); const j = await r.json();
        const recs = j.records || j;
        if (recs && recs.length >= boot.length) { setData(recs); setMeta({ generated_at: j.generated_at, count: j.count || recs.length }); setLive(true); }
      } catch (e) { /* keep bootstrap */ }
    })();
  }, []);

  // run the O(n²) engine on the most notable working set so it stays fast at any scale
  const work = useMemo(() => {
    if (data.length <= WORK_CAP) return data;
    return [...data].sort((a, b) => notability(b) - notability(a)).slice(0, WORK_CAP);
  }, [data]);
  // bridges (cross-domain) come from the notable set; clusters (local waves) from
  // the full data. Merge, dedupe by pair, rank bridges up — distinct tabs, one map.
  const bridgeConns = useMemo(() => buildConnections(work, 200), [work]);
  const clusters = useMemo(() => buildClusters(data, 220), [data]);
  const conns = useMemo(() => {
    const seen = new Set(), all = [];
    for (const c of [...bridgeConns, ...clusters]) {
      const k = c.from < c.to ? c.from + "|" + c.to : c.to + "|" + c.from;
      if (seen.has(k)) continue; seen.add(k); all.push(c);
    }
    all.sort((a, b) => (b.bridge - a.bridge) * 0.12 + (b.strength - a.strength));
    return all.slice(0, 320).map((c, i) => ({ ...c, id: "c" + i }));
  }, [bridgeConns, clusters]);
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

  if (!ready) return <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#04070e", color: SEL_COL, fontFamily: "monospace", fontSize: 11, letterSpacing: "0.3em" }}>ACQUIRING SIGNAL{"…"}</div>;

  const showBridges = tab === "bridges";
  const tabs = [["files", filtered.length], ["connections", conns.length], ["bridges", bridges.length]];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Newsreader:ital,wght@0,300;0,400;1,300&display=swap');
        :root { --f: 'DM Mono', monospace; --s: 'Newsreader', Georgia, serif; }
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        html, body { background: #04070e; overscroll-behavior: none; }
        ::-webkit-scrollbar { width: 0; height: 0; }
        button { cursor: pointer; font-family: var(--f); }
        input::placeholder { color: #3a4a60; }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: .2; } }
      `}</style>
      <div style={{ minHeight: "100dvh", maxWidth: 520, margin: "0 auto", background: "#070b13", color: "#cbd5e1", fontFamily: "var(--f)", fontSize: 12, boxShadow: "0 0 60px rgba(0,0,0,.6)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #10202e", position: "sticky", top: 0, zIndex: 50, background: "rgba(7,11,19,.92)", backdropFilter: "blur(14px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20, color: SEL_COL, textShadow: "0 0 12px " + SEL_COL + "99" }}>{"◎"}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "#ecfeff", letterSpacing: "0.26em" }}>SIGINT</div>
              <div style={{ fontSize: 6.5, color: HUD, letterSpacing: "0.2em", marginTop: 1, opacity: 0.8 }}>UAP SIGNALS · PIPELINE-FED</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 8, letterSpacing: "0.14em", color: live ? SEL_COL : "#5b7186", padding: "5px 9px", borderRadius: 20, border: "1px solid " + (live ? "rgba(52,211,153,.3)" : "#1b2738"), background: live ? "rgba(52,211,153,.08)" : "transparent" }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: live ? SEL_COL : "#5b7186", boxShadow: live ? "0 0 6px " + SEL_COL : "none", animation: live ? "blink 1.6s infinite" : "none" }} />
            {live ? "LIVE" : "SNAPSHOT"}
          </div>
        </header>

        {data.length > 0 && <MapCanvas db={filtered} cn={mapConns} sel={sel} onSel={select} focus={focus} showBridges={showBridges} />}

        <div style={{ display: "flex", borderBottom: "1px solid #10202e", background: "linear-gradient(180deg, rgba(13,22,35,.5), transparent)" }}>
          <Stat n={data.length} label="FILES" col="#e2e8f0" />
          <div style={{ width: 1, background: "#10202e", margin: "8px 0" }} />
          <Stat n={agencies.length - 1} label="AGENCIES" col={HUD} />
          <div style={{ width: 1, background: "#10202e", margin: "8px 0" }} />
          <Stat n={conns.length} label="LINKS" col="#fb923c" />
          <div style={{ width: 1, background: "#10202e", margin: "8px 0" }} />
          <Stat n={bridges.length} label="BRIDGES" col={BRIDGE_COL} />
        </div>

        <div style={{ padding: "10px 16px", borderBottom: "1px solid #10202e" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 12px", background: "#05080f", border: "1px solid #14202f", borderRadius: 10 }}>
            <span style={{ color: "#3f5168", fontSize: 14 }}>{"⌕"}</span>
            <input placeholder="Search files, designators, locations, tags…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, padding: "11px 0", fontSize: 13, fontFamily: "var(--f)", background: "transparent", border: "none", color: "#e2e8f0", outline: "none" }} />
            {search && <span onClick={() => setSearch("")} style={{ color: "#3f5168", fontSize: 14, cursor: "pointer" }}>{"✕"}</span>}
          </div>
        </div>

        <div style={{ padding: "0 16px 10px", borderBottom: "1px solid #10202e", display: "flex", gap: 6, overflowX: "auto", whiteSpace: "nowrap" }}>
          {agencies.map((a) => {
            const on = agency === a;
            const c = a === "all" ? SEL_COL : (AGENCY_COL[a] || SEL_COL);
            return <button key={a} onClick={() => setAgency(a)} style={{ flexShrink: 0, padding: "6px 12px", fontSize: 9, borderRadius: 16, fontFamily: "var(--f)", textTransform: "uppercase", letterSpacing: "0.06em", background: on ? c + "1f" : "transparent", border: "1px solid " + (on ? c + "55" : "#172332"), color: on ? c : "#5b7186" }}>{a}</button>;
          })}
        </div>

        <nav style={{ display: "flex", position: "sticky", top: 49, zIndex: 40, background: "rgba(7,11,19,.92)", backdropFilter: "blur(14px)", borderBottom: "1px solid #10202e" }}>
          {tabs.map(([t, n]) => {
            const on = tab === t; const c = t === "bridges" ? BRIDGE_COL : SEL_COL;
            return <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "13px 0", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", background: "transparent", border: "none", fontFamily: "var(--f)", borderBottom: "2px solid " + (on ? c : "transparent"), color: on ? c : "#4a5a70", textShadow: on ? "0 0 10px " + c + "66" : "none" }}>{t} <span style={{ opacity: 0.6 }}>{n}</span></button>;
          })}
        </nav>

        {tab === "bridges" && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #10202e", background: "linear-gradient(180deg, rgba(251,113,133,.06), transparent)", fontSize: 11.5, color: "#9fb0c4", lineHeight: 1.65, fontFamily: "var(--s)" }}>
            <span style={{ color: BRIDGE_COL, fontFamily: "var(--f)", fontSize: 9, letterSpacing: "0.1em" }}>{"✧ BRIDGES"}</span> — non-obvious links between events separated by thousands of km, decades, or agency silos, yet sharing a craft taxonomy, theater, or signature. The connections nobody filed together.
          </div>
        )}

        <div style={{ paddingBottom: "calc(48px + env(safe-area-inset-bottom))" }}>
          {tab === "files" && filtered.slice(0, 400).map((s) => <SRow key={s.id} s={s} sel={sel === s.id} onTap={locate} cc={linkCount[s.id] || 0} bc={bridgeCount[s.id] || 0} />)}
          {tab === "files" && filtered.length > 400 && <div style={{ padding: "16px", textAlign: "center", color: "#5b7186", fontSize: 9.5, letterSpacing: "0.08em" }}>SHOWING 400 OF {filtered.length.toLocaleString()} · REFINE WITH SEARCH OR FILTERS</div>}
          {tab === "files" && filtered.length === 0 && <div style={{ padding: 48, textAlign: "center", color: "#3a4a60", fontSize: 11, letterSpacing: "0.1em" }}>NO MATCHES</div>}
          {tab === "connections" && conns.map((c) => <CRow key={c.id} c={c} byId={byId} hi={sel === c.from || sel === c.to} onTap={locate} />)}
          {tab === "bridges" && bridges.map((c) => <CRow key={c.id} c={c} byId={byId} hi={sel === c.from || sel === c.to} onTap={locate} />)}
          {tab === "bridges" && bridges.length === 0 && <div style={{ padding: 48, textAlign: "center", color: "#3a4a60", fontSize: 11 }}>No bridges in current view.</div>}
        </div>

        <footer style={{ padding: "12px 16px", borderTop: "1px solid #10202e", fontSize: 7, color: "#3a4a60", letterSpacing: "0.12em", textAlign: "center" }}>
          {meta && meta.generated_at ? "DATA " + meta.generated_at.slice(0, 10) : ""} · ALGORITHM-COMPUTED · {conns.length} LINKS / {bridges.length} BRIDGES
        </footer>
      </div>
    </>
  );
}
