// In-page renderer for a plan document. Reads #plan-doc and #plan-view and
// draws the standard layout. No dependencies, no network.
//
// One canvas holds everything about structure: modules as cards laid out as
// a graph (springs along dependencies, repulsion between cards), contracts
// and stored data as rows that expand in place, types that open as cards
// where they are defined and wire back to every visible use. Changes are
// shown on the node they affect. Everything starts collapsed. Context
// (phases, questions, decisions) sits below in collapsible sections; the
// sidebar is only for the conversation.
(() => {
  "use strict";
  const doc = JSON.parse(document.getElementById("plan-doc").textContent);
  const view = JSON.parse(document.getElementById("plan-view").textContent);
  const TAGS = ["breaking", "migration", "additive", "internal"];
  const NOTES_KEY = `plan-notes:${doc.title}`;

  const state = {
    tab: view.proposed ? "change" : "current",
    open: new Set(),
    selected: null,
    phase: null,
    hover: null,
    notes: loadNotes(),
    draft: "",
    pos: loadPos(),            // module id -> card centre, in canvas units
    view: { x: 0, y: 0, k: 1 }, // pan and zoom of the canvas
    fitted: false,
    ctxOpen: new Set(["questions"]), // which context sections below the canvas are open
    only: null,                // show only changes with this tag
  };
  const GLOSSARY = doc.glossary || [];

  // ---- DOM helpers ------------------------------------------------------------
  const SVG = "http://www.w3.org/2000/svg";
  const h = (tag, attrs, ...kids) => fill(document.createElement(tag), attrs, kids);
  const s = (tag, attrs, ...kids) => fill(document.createElementNS(SVG, tag), attrs, kids);
  function fill(el, attrs, kids) {
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  const cls = (...xs) => xs.filter(Boolean).join(" ");

  // ---- tree lookups -----------------------------------------------------------
  const tree = () => (state.tab === "current" ? view.current : view.proposed);

  // Every module in the tree, sub-modules included.
  const everyModule = (ms) => ms.flatMap((m) => [m, ...everyModule(m.modules)]);

  function allIds(t) {
    const out = new Set();
    for (const m of everyModule(t.modules)) {
      out.add(m.id);
      for (const c of m.contracts) {
        out.add(c.id);
        for (const x of [...c.operations, ...c.events, ...c.types]) out.add(x.id);
      }
      for (const e of m.entities) out.add(e.id);
      for (const a of m.aggregates) out.add(a.id);
      for (const st of m.stores) { out.add(st.id); for (const tb of st.tables) out.add(tb.id); }
      for (const ep of m.endpoints) out.add(ep.id);
      for (const x of [...m.ports, ...m.signals, ...m.tests]) out.add(x.id);
    }
    return out;
  }

  // A change is shown on the deepest node that exists in the tree being drawn.
  function placeOf(change, ids) {
    let id = change.node;
    while (id && !ids.has(id)) id = id.includes("/") ? id.slice(0, id.lastIndexOf("/")).replace(/\/(contract|entity|type|aggregate|store|endpoint)$/, "") : null;
    return id || change.module;
  }

  const under = (id, n) => id === n || id.startsWith(n + "/");
  const phaseNodes = () => (state.phase == null ? null : doc.slices[state.phase].nodes);
  const changeInPhase = (c, nodes) => nodes.some((n) => under(c.node, n) || c.module === n);
  const nodeInPhase = (id) => {
    const nodes = phaseNodes();
    return !nodes || nodes.some((n) => under(id, n) || under(n, id));
  };

  function changesByPlace() {
    const map = new Map();
    if (state.tab !== "change") return map;
    const ids = allIds(tree());
    const nodes = phaseNodes();
    for (const c of view.changes) {
      if (nodes && !changeInPhase(c, nodes)) continue;
      if (c.tag === "internal") continue; // drawn as new wires instead
      if (state.only && c.tag !== state.only) continue;
      const p = placeOf(c, ids);
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(c);
    }
    return map;
  }
  const worst = (cs) => TAGS.find((t) => cs.some((c) => c.tag === t));

  // In the change view, everything a change touches starts open.
  function openChanged() {
    const ids = allIds(view.proposed);
    for (const c of view.changes) {
      const p = placeOf(c, ids);
      const parts = p.split("/");
      for (let i = 2; i <= parts.length; i++) state.open.add(parts.slice(0, i).join("/"));
    }
  }

  // ---- interactions -------------------------------------------------------------
  function select(id) {
    state.selected = state.selected === id ? null : id;
    render();
  }
  function toggle(id) {
    state.open.has(id) ? state.open.delete(id) : state.open.add(id);
    state.selected = id;
    render();
  }
  // Open a referenced type or table where it is defined, then point at it.
  function reveal(ref) {
    const typeAt = ref.indexOf("/type/");
    if (typeAt >= 0) state.open.add(ref.slice(0, typeAt));
    const parts = ref.split("/");
    for (let i = 2; i <= parts.length; i++) state.open.add(parts.slice(0, i).join("/"));
    // A table opens inside its store; an endpoint may sit past the fold.
    const store = ref.match(/^(.*\/store\/[^/]+)\//);
    if (store) state.open.add(store[1]);
    if (ref.includes("/endpoint/")) state.open.add(ref.split("/endpoint/")[0] + "/endpoints");
    state.open.add(ref);
    state.selected = ref;
    render();
    const el = document.querySelector(`[data-node-id="${CSS.escape(ref)}"]`);
    if (el) {
      centerOn(el);
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 900);
    }
  }
  function hover(ref) {
    state.hover = ref;
    document.querySelectorAll(".hot-type").forEach((el) => el.classList.remove("hot-type"));
    if (ref) document.querySelectorAll(`[data-ref="${CSS.escape(ref)}"], [data-node-id="${CSS.escape(ref)}"]`).forEach((el) => el.classList.add("hot-type"));
    drawWires();
  }
  // "Orders/contract/Orders/CancelOrder" reads as "Orders › CancelOrder".
  const pretty = (id) => id.split(/\/(?:contract|entity|type|aggregate|store|endpoint)\/|\//)
    .filter((p, i, xs) => p !== xs[i - 1]).join(" › ").replace(/\u2215/g, "/");

  // When something is selected, the cards it has nothing to do with step back.
  function focusSet() {
    const sel = state.selected;
    if (!sel) return null;
    const top = (id) => id.split("/")[0];
    const out = new Set([top(sel)]);
    for (const e of tree().edges) {
      if (under(e.from, sel) || under(e.to, sel) || under(sel, e.to)) { out.add(top(e.from)); out.add(top(e.to)); }
    }
    return out;
  }
  const filteredOut = (id, ctx) => state.tab === "change" && state.only && !allChangesIn(id, ctx).length;

  // ---- canvas -------------------------------------------------------------------
  function canvas() {
    const t = tree();
    const ctx = { placed: changesByPlace(), focus: focusSet() };
    const tool = (label, title, fn) => h("button", { class: "tool", title, "aria-label": title, onclick: fn }, label);
    const legend = h("div", { class: "legend" },
      h("span", { class: "lg-call" }, "calls"), h("span", { class: "lg-event" }, "reacts to event"),
      h("span", { class: "lg-type" }, "uses type"),
      h("span", { class: "lg-route" }, "endpoint calls (on hover)"),
      state.tab === "change" ? h("span", { class: "lg-new" }, "new dependency") : null,
      state.tab === "change" ? TAGS.slice(0, 3).map((x) => h("span", { class: `lg-tag ${x}` }, x)) : null,
      h("span", { class: "hint" }, h("kbd", {}, "/"), " search ", h("kbd", {}, "esc"), " clear ", h("kbd", {}, "f"), " fit ",
        doc.slices.length ? [h("kbd", {}, `1–${doc.slices.length}`), " phases "] : null, "· drag to pan · ctrl + scroll to zoom"));
    const viewport = h("div", { class: "viewport", id: "viewport" },
      h("div", { class: "layer", id: "layer", style: layerTransform() },
        // Dependencies run under the cards; type links run over them, since
        // they start inside a card.
        s("svg", { class: "wires under", id: "wires", width: 1, height: 1, "aria-hidden": "true" }),
        t.modules.map((m) => moduleCard(m, ctx)),
        s("svg", { class: "wires over", id: "type-wires", width: 1, height: 1, "aria-hidden": "true" })),
      h("div", { class: "tools" },
        tool("Fit", "Fit everything in view", fit),
        tool("+", "Zoom in", () => zoomAt(1.25)),
        tool("−", "Zoom out", () => zoomAt(0.8)),
        state.tab === "change" ? tool("Open changes", "Open everything the change touches", () => { openChanged(); render(); }) : null,
        tool("Collapse", "Collapse everything", () => { state.open.clear(); render(); }),
        tool("Re-arrange", "Lay the graph out again", () => { state.pos = new Map(); savePos(); state.fitted = false; render(); })));
    panZoom(viewport);
    return h("div", { class: "canvas-wrap" }, viewport, legend);
  }

  // ---- graph layout ---------------------------------------------------------------
  // Modules are placed by a small force simulation: springs along every
  // relationship (calls, events, shared types), repulsion between all cards,
  // and overlap removal using each card's real size. Cards a person dragged
  // stay where they were put. Expanding a card re-runs a short, gentle pass so
  // its neighbours make room without the whole graph moving.
  function links(t) {
    const out = new Map();
    const add = (a, b, w) => {
      if (!a || !b || a === b) return;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      out.set(k, { a, b, w: Math.max(out.get(k)?.w || 0, w) });
    };
    const mod = (id) => id.split("/")[0];
    for (const e of t.edges) add(mod(e.from), mod(e.to), 1);
    for (const m of everyModule(t.modules)) {
      const refs = [];
      for (const c of m.contracts) {
        for (const o of c.operations) refs.push(...o.input.flatMap((f) => f.type), ...(o.output || []));
        for (const e of c.events) refs.push(...e.payload.flatMap((f) => f.type));
        for (const ty of c.types) refs.push(...(ty.fields || []).flatMap((f) => f.type));
      }
      for (const e of m.entities) refs.push(...e.fields.flatMap((f) => f.type));
      for (const r of refs) if (r.ref) add(mod(m.id), mod(r.ref), 0.5);
    }
    return [...out.values()];
  }

  function layoutGraph() {
    const layer = document.getElementById("layer");
    if (!layer) return;
    const t = tree();
    const els = [...layer.querySelectorAll(":scope > .card")];
    const nodes = els.map((el) => ({ id: el.getAttribute("data-node-id"), el, w: el.offsetWidth, h: el.offsetHeight }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ls = links(t).filter((l) => byId.has(l.a) && byId.has(l.b));
    const fresh = nodes.filter((n) => !state.pos.has(n.id));
    const placedBefore = nodes.length - fresh.length;
    // New cards start near what they connect to, or on a ring.
    fresh.forEach((n, i) => {
      const near = ls.filter((l) => l.a === n.id || l.b === n.id).map((l) => state.pos.get(l.a === n.id ? l.b : l.a)).filter(Boolean);
      if (near.length) {
        const cx = near.reduce((a, p) => a + p.x, 0) / near.length, cy = near.reduce((a, p) => a + p.y, 0) / near.length;
        state.pos.set(n.id, { x: cx + 200 * Math.cos(i * 2.4), y: cy + 200 * Math.sin(i * 2.4) });
      } else {
        const a = (i / Math.max(1, fresh.length)) * Math.PI * 2;
        const r = 260 + 40 * fresh.length;
        state.pos.set(n.id, { x: r * Math.cos(a), y: r * Math.sin(a) * 0.7 });
      }
    });
    for (const n of nodes) Object.assign(n, state.pos.get(n.id));
    const focus = new Set(view.changes.map((c) => c.module));
    const full = placedBefore === 0;
    simulate(nodes, ls, full ? 500 : 80, full ? 1 : 0.15, focus);
    for (const n of nodes) {
      state.pos.set(n.id, { x: n.x, y: n.y, pinned: state.pos.get(n.id)?.pinned });
      place(n);
    }
    savePos();
  }

  function simulate(nodes, ls, iterations, strength, focus) {
    const PAD = 36;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pinned = (n) => state.pos.get(n.id)?.pinned;
    for (let i = 0; i < iterations; i++) {
      const alpha = strength * (1 - i / iterations);
      for (const n of nodes) { n.vx = 0; n.vy = 0; }
      for (const l of ls) {
        const a = byId.get(l.a), b = byId.get(l.b);
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const rest = (a.w + b.w) / 2 + 140;
        const f = (d - rest) * 0.04 * l.w * alpha;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (let p = 0; p < nodes.length; p++) {
        for (let q = p + 1; q < nodes.length; q++) {
          const a = nodes[p], b = nodes[q];
          const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy + 1, d = Math.sqrt(d2);
          const f = (120000 / d2) * alpha;
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
          b.vx += (dx / d) * f; b.vy += (dy / d) * f;
        }
      }
      for (const n of nodes) {
        const g = (focus.has(n.id.split("/")[0]) ? 0.02 : 0.006) * alpha;
        n.vx -= n.x * g; n.vy -= n.y * g * 1.6;
        if (!pinned(n)) { n.x += clamp(n.vx, 60); n.y += clamp(n.vy, 60); }
      }
      // Overlap removal runs at full strength every step: cards never overlap.
      for (let p = 0; p < nodes.length; p++) {
        for (let q = p + 1; q < nodes.length; q++) {
          const a = nodes[p], b = nodes[q];
          const ox = (a.w + b.w) / 2 + PAD - Math.abs(b.x - a.x);
          const oy = (a.h + b.h) / 2 + PAD - Math.abs(b.y - a.y);
          if (ox <= 0 || oy <= 0) continue;
          const pa = pinned(a) ? 0 : pinned(b) ? 1 : 0.5, pb = 1 - pa;
          if (ox < oy) {
            const sx = Math.sign(b.x - a.x) || 1;
            a.x -= sx * ox * pa; b.x += sx * ox * pb;
          } else {
            const sy = Math.sign(b.y - a.y) || 1;
            a.y -= sy * oy * pa; b.y += sy * oy * pb;
          }
        }
      }
    }
  }
  // Sources and notes stay one or two lines until clicked, so real code with
  // long paths does not push a card's contracts off screen.
  function srcLine(list) {
    if (!list.length) return null;
    if (list.length === 1) return h("p", { class: "src" }, list[0]);
    return h("details", { class: "src", onclick: (ev) => ev.stopPropagation() },
      h("summary", {}, `${list[0]} +${list.length - 1}`),
      ...list.slice(1).map((x) => h("div", {}, x)));
  }
  function noteLine(text) {
    if (!text) return null;
    return h("p", { class: "note clamp", title: "Click to read all",
      onclick: (ev) => { ev.stopPropagation(); ev.currentTarget.classList.toggle("clamp"); drawWires(); } }, text);
  }

  const clamp = (v, m) => Math.max(-m, Math.min(m, v));
  function place(n) {
    n.el.style.left = `${n.x - n.w / 2}px`;
    n.el.style.top = `${n.y - n.h / 2}px`;
    n.el.style.visibility = "visible";
  }

  // ---- pan, zoom, drag ----------------------------------------------------------------
  const layerTransform = () => `transform: translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
  function applyView() {
    const layer = document.getElementById("layer");
    if (layer) layer.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
  }
  function zoomAt(f, cx, cy) {
    const vp = document.getElementById("viewport");
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    const k = Math.max(0.25, Math.min(2.5, state.view.k * f));
    state.view.x = px - ((px - state.view.x) * k) / state.view.k;
    state.view.y = py - ((py - state.view.y) * k) / state.view.k;
    state.view.k = k;
    applyView();
  }
  function fit() {
    const vp = document.getElementById("viewport");
    const cards = [...document.querySelectorAll("#layer > .card")];
    if (!vp || !cards.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cards) {
      const l = parseFloat(c.style.left), t = parseFloat(c.style.top);
      x0 = Math.min(x0, l); y0 = Math.min(y0, t);
      x1 = Math.max(x1, l + c.offsetWidth); y1 = Math.max(y1, t + c.offsetHeight);
    }
    const W = vp.clientWidth, H = vp.clientHeight, M = 32;
    const k = Math.max(0.3, Math.min(1, (W - 2 * M) / (x1 - x0), (H - 2 * M) / (y1 - y0)));
    state.view = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
    applyView();
  }
  function centerOn(el) {
    const vp = document.getElementById("viewport");
    if (!vp) return;
    const v = vp.getBoundingClientRect(), r = el.getBoundingClientRect();
    const inside = r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom;
    if (inside) return;
    state.view.x += v.left + v.width / 2 - (r.left + r.width / 2);
    state.view.y += v.top + Math.min(v.height / 2, r.height / 2 + 40) - r.top;
    applyView();
  }

  function panZoom(vp) {
    let drag = null;
    vp.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.target.closest("button, .tools")) return;
      const head = ev.target.closest(".card-head");
      const card = ev.target.closest(".card");
      if (card && !head) return; // clicks inside a card body stay clicks
      drag = { x: ev.clientX, y: ev.clientY, moved: false, card: head ? card : null, start: { ...state.view } };
      if (drag.card) drag.pos = { ...state.pos.get(card.getAttribute("data-node-id")) };
      drag.pointer = ev.pointerId;
    });
    vp.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) vp.setPointerCapture(drag.pointer); // only once it is a drag, so plain clicks still land
      drag.moved = true;
      vp.classList.add("dragging");
      if (drag.card) {
        const id = drag.card.getAttribute("data-node-id");
        const p = { x: drag.pos.x + dx / state.view.k, y: drag.pos.y + dy / state.view.k, pinned: true };
        state.pos.set(id, p);
        place({ el: drag.card, x: p.x, y: p.y, w: drag.card.offsetWidth, h: drag.card.offsetHeight });
      } else {
        state.view.x = drag.start.x + dx;
        state.view.y = drag.start.y + dy;
        applyView();
      }
      drawWires();
    });
    const end = () => {
      if (drag?.moved) {
        if (drag.card) { layoutGraph(); drawWires(); } // neighbours make room around where it was dropped
        savePos();
        // Swallow the click that ends a drag so it doesn't select the card.
        vp.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
      }
      drag = null;
      vp.classList.remove("dragging");
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = vp.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top);
      else { state.view.x -= ev.deltaX; state.view.y -= ev.deltaY; applyView(); }
    }, { passive: false });
  }

  function loadPos() {
    try { return new Map(JSON.parse(localStorage.getItem(`plan-pos:${doc.title}`) || "[]")); } catch { return new Map(); }
  }
  function savePos() {
    try { localStorage.setItem(`plan-pos:${doc.title}`, JSON.stringify([...state.pos])); } catch { /* storage unavailable */ }
  }

  function changeList(cs) {
    if (!cs || !cs.length) return null;
    return h("ul", { class: "changes" }, [...cs].sort((a, b) => TAGS.indexOf(a.tag) - TAGS.indexOf(b.tag)).map((c) =>
      h("li", { class: c.tag }, h("span", { class: `tag ${c.tag}` }, c.tag), c.short || c.what)));
  }

  // "2 breaking · 1 migration", as coloured counts, for a card's header.
  function tally(cs) {
    const counts = TAGS.slice(0, 3).map((t) => [t, cs.filter((c) => c.tag === t).length]).filter(([, n]) => n);
    if (!counts.length) return null;
    return h("span", { class: "tally", title: counts.map(([t, n]) => `${n} ${t}`).join(", ") },
      counts.map(([t, n]) => h("span", { class: `dot ${t}` }, String(n))));
  }

  const facts = (id) => (doc.facts[id] || []).map((f) =>
    h("span", { class: "fact", title: f.detail || "" }, `${f.label} `, h("b", {}, String(f.value))));

  // A card is read top to bottom in the order a request travels: how you get
  // in (endpoints), what it promises (contracts), what it keeps (data), where
  // that lives (storage), then how it is built and run (wiring, signals,
  // tests), and what is inside it (sub-modules).
  function moduleCard(m, ctx, close) {
    const cs = ctx.placed.get(m.id);
    const all = state.tab === "change" ? allChangesIn(m.id, ctx) : [];
    const tagged = worst(all);
    const focus = ctx.focus;
    const loose = m.entities.filter((e) => !m.aggregates.some((a) => a.root === e.id || a.members.includes(e.id)));
    return h("article", {
      class: cls("card", m.depth === "stub" && "stub", tagged && tagged !== "internal" && `tag-${tagged}`,
        (!nodeInPhase(m.id) || filteredOut(m.id, ctx)) && "dim", !close && focus && !focus.has(m.id) && "unfocused",
        state.selected === m.id && "selected"),
      "data-node-id": m.id,
    },
      h("header", { class: "card-head", onclick: () => select(m.id) },
        h("div", { class: "title" },
          h("span", { class: "name" }, m.name),
          m.depth === "stub" ? h("span", { class: "badge" }, "not mapped") : null,
          tally(all),
          close ? h("button", { class: "x", "aria-label": `Close ${m.name}`, onclick: (ev) => { ev.stopPropagation(); close(); } }, "×") : null),
        h("p", { class: "purpose" }, terms(m.purpose)),
        facts(m.id).length ? h("div", { class: "facts" }, facts(m.id)) : null,
        noteLine(m.note),
        srcLine(m.sources),
        reactsTo(m),
        gapsLine(m),
        changeList(cs)),
      group("endpoints", "Endpoints", m.endpoints.length, endpointList(m, ctx)),
      group("contracts", "Contracts", m.contracts.length, m.contracts.map((c) => contractRow(m, c, ctx))),
      group("data", "Data", m.entities.length, m.aggregates.map((a) => aggregateBox(m, a, ctx)), loose.map((e) => entityRow(e, ctx))),
      group("storage", "Storage", m.stores.reduce((n, st) => n + st.tables.length, 0), m.stores.map((st) => storeBox(st, ctx))),
      group("wiring", "Wiring", m.ports.length, m.ports.map((pt) => portRow(m, pt, ctx))),
      group("signals", "Signals", m.signals.length, m.signals.map((sg) => signalRow(sg, ctx))),
      group("tests", "Tests", m.tests.length, testSummary(m), m.tests.map((tc) => testRow(tc, ctx))),
      group("inside", "Inside", m.modules.length, m.modules.map((sub) => subModule(sub, ctx))));
  }

  // A labelled band inside a card, coloured by the kind of thing it holds.
  function group(kind, label, count, ...rows) {
    if (!count) return null;
    return h("section", { class: `group k-${kind}` },
      h("div", { class: "group-label" }, h("span", {}, label), h("span", { class: "group-count" }, String(count))),
      rows);
  }

  // An aggregate is drawn as a boundary around the tables it holds, with the
  // root first. Its invariants open with it.
  function aggregateBox(m, a, ctx) {
    const open = state.open.has(a.id);
    const byId = new Map(m.entities.map((e) => [e.id, e]));
    return h("section", { class: cls("aggregate", open && "open", state.selected === a.id && "selected", (!nodeInPhase(a.id) || filteredOut(a.id, ctx)) && "dim"), "data-node-id": a.id },
      h("button", { class: "agg-head", "aria-expanded": String(open), onclick: () => toggle(a.id) },
        h("span", { class: "agg-label" }, `${a.name} aggregate`),
        a.invariants.length ? h("span", { class: "meta" }, `${a.invariants.length} rule${a.invariants.length === 1 ? "" : "s"}`) : null,
        h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      changeList(ctx.placed.get(a.id)),
      open && a.invariants.length ? h("ol", { class: "invariants" }, a.invariants.map((i) => h("li", {}, terms(i)))) : null,
      [a.root, ...a.members].map((id) => byId.get(id)).filter(Boolean).map((e) => entityRow(e, ctx, e.id === a.root)));
  }

  // A sub-module is a row until opened, then a card nested inside its parent.
  function subModule(sub, ctx) {
    const open = state.open.has(sub.id);
    if (open) return h("div", { class: "nested" }, moduleCard(sub, ctx, () => toggle(sub.id)));
    return h("section", { class: cls("row", "sub", state.selected === sub.id && "selected", (!nodeInPhase(sub.id) || filteredOut(sub.id, ctx)) && "dim"), "data-node-id": sub.id },
      rowHead(sub.id, boxIcon(), sub.name, sub.depth === "stub" ? "not mapped" : terms(sub.purpose), ctx, "sub-purpose"));
  }

  // Where the code reaches another module outside the model. Kept visible on
  // the card, since it is what the plan simplifies.
  function gapsLine(m) {
    if (!m.gaps.length) return null;
    return h("div", { class: "gaps" }, m.gaps.map((g) => h("div", { class: "gap", title: g.note },
      h("span", { class: "gap-label" }, "code also reaches"),
      g.ref ? h("button", { class: "linklike quiet", onclick: (ev) => { ev.stopPropagation(); reveal(g.ref); } }, g.module) : g.module,
      h("span", { class: "gap-note" }, g.note))));
  }

  // Events are the one relationship a wire can't label legibly, so the
  // subscriber says what it listens for.
  function reactsTo(m) {
    const evs = tree().edges.filter((e) => e.kind === "event" && e.to === m.id);
    if (!evs.length) return null;
    return h("div", { class: "listens" }, h("span", { class: "listens-label" }, "reacts to"),
      evs.map((e) => [h("button", { class: "linklike quiet", onclick: (ev) => { ev.stopPropagation(); reveal(e.from); } }, e.from.split("/").pop()),
        e.label.split(", ").map((x) => h("span", { class: "ev" }, x))]));
  }

  function allChangesIn(id, ctx) {
    const out = [];
    for (const [p, cs] of ctx.placed) if (under(p, id)) out.push(...cs);
    return out;
  }

  function rowHead(id, icon, label, meta, ctx, metaClass) {
    const t = state.tab === "change" ? worst(allChangesIn(id, ctx)) : null;
    return h("button", {
      class: cls("row-head", t && t !== "internal" && `mark-${t}`), "aria-expanded": String(state.open.has(id)),
      onclick: () => toggle(id),
    }, icon, h("span", { class: "row-name" }, label), meta ? h("span", { class: cls("meta", metaClass) }, meta) : null,
    (doc.facts[id] || []).length ? h("span", { class: "has-facts", title: doc.facts[id].map((f) => `${f.label}: ${f.value}`).join("\n") }, "#") : null,
    h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }
  const rowClass = (id, ctx, open, ...more) =>
    cls("row", open && "open", (!nodeInPhase(id) || filteredOut(id, ctx)) && "dim", state.selected === id && "selected", ...more);

  function contractRow(m, c, ctx) {
    const open = state.open.has(c.id) && m.depth === "mapped";
    const n = c.operations.length + c.events.length;
    return h("section", { class: rowClass(c.id, ctx, open), "data-node-id": c.id },
      rowHead(c.id, hex(), c.name, m.depth === "stub" ? "not mapped" : `${c.operations.length} op${c.operations.length === 1 ? "" : "s"}${c.events.length ? ` · ${c.events.length} event${c.events.length === 1 ? "" : "s"}` : ""}`, ctx),
      changeList(ctx.placed.get(c.id)),
      open ? h("div", { class: "row-body" },
        facts(c.id).length ? h("div", { class: "facts" }, facts(c.id)) : null,
        noteLine(c.note),
        srcLine(c.sources),
        c.operations.map((o) => member(o.id, h("span", { class: `mode ${o.mode}` }, o.mode === "command" ? "cmd" : "query"),
          [h("span", { class: "mname" }, o.name), "(", fieldsInline(o.input), ")", h("span", { class: "arrow" }, " → "), o.output ? tokens(o.output) : h("span", { class: "muted" }, "void")],
          [o.errors.length ? h("div", { class: "errs" }, o.errors.map((e) => h("span", { class: "err" }, e))) : null, callers(o.id), testedBy(m, o.id, o.mode)], ctx)),
        c.events.map((e) => member(e.id, h("span", { class: "mode event" }, "event"),
          [h("span", { class: "mname" }, e.name), " { ", fieldsInline(e.payload), " }"], null, ctx)),
        typeShelf(c, ctx)) : null);
  }

  // Which endpoints reach an operation, so a reader sees how it is called.
  function callers(opId) {
    const eps = tree().edges.filter((e) => e.kind === "route" && e.to === opId);
    if (!eps.length) return null;
    return h("div", { class: "callers" }, h("span", { class: "muted" }, "called by "), eps.map((e) =>
      h("button", { class: "ep-chip", onclick: (ev) => { ev.stopPropagation(); reveal(e.from); },
        onmouseenter: () => hover(e.from), onmouseleave: () => hover(null) }, endpointLabel(e.from))));
  }
  const endpointLabel = (id) => id.split("/endpoint/")[1].replace(/∕/g, "/");

  function member(id, badge, sig, extra, ctx) {
    return h("div", { class: cls("member", state.selected === id && "selected", (!nodeInPhase(id) || filteredOut(id, ctx)) && "dim"), "data-node-id": id,
      onclick: (ev) => { if (!ev.target.closest(".chip, .ep-chip")) select(id); } },
    h("div", { class: "sig" }, badge, " ", sig), extra, changeList(ctx.placed.get(id)));
  }

  // Types live under the contract that defines them: open ones as cards,
  // the rest as chips that open them.
  function typeShelf(c, ctx) {
    if (!c.types.length) return null;
    const closed = c.types.filter((t) => !state.open.has(t.id));
    return h("div", { class: "types" },
      c.types.filter((t) => state.open.has(t.id)).map((t) => typeCard(t, ctx)),
      closed.length ? h("div", { class: "type-chips" }, h("span", { class: "muted" }, "types "), closed.map((t) => chip({ s: t.name, ref: t.id }, ctx))) : null);
  }

  function typeCard(t, ctx) {
    return h("div", { class: cls("typecard", state.selected === t.id && "selected", (!nodeInPhase(t.id) || filteredOut(t.id, ctx)) && "dim"), "data-node-id": t.id },
      h("div", { class: "type-head" },
        h("button", { class: "type-name", onclick: () => select(t.id) }, t.name, h("span", { class: "muted" }, t.kind === "enum" ? " one of" : "")),
        h("button", { class: "x", "aria-label": `Close ${t.name}`, onclick: () => { state.open.delete(t.id); render(); } }, "×")),
      t.kind === "enum"
        ? h("div", { class: "values" }, t.values.map((v) => h("span", { class: "value" }, v)))
        : h("div", { class: "fields" }, t.fields.map((f) => h("div", {}, h("span", { class: "fname" }, f.name), ": ", tokens(f.type)))),
      changeList(ctx.placed.get(t.id)));
  }

  function entityRow(e, ctx, root) {
    const open = state.open.has(e.id);
    return h("section", { class: rowClass(e.id, ctx, open), "data-node-id": e.id },
      rowHead(e.id, cyl(), e.name, [root ? h("span", { class: "root" }, "root") : null, `${e.fields.length} fields`], ctx),
      changeList(ctx.placed.get(e.id)),
      open ? h("div", { class: "row-body" },
        facts(e.id).length ? h("div", { class: "facts" }, facts(e.id)) : null,
        noteLine(e.note),
        srcLine(e.sources),
        h("div", { class: "fields" }, e.fields.map((f) =>
          h("div", {}, h("span", { class: "fname" }, f.name), ": ", tokens(f.type), f.key ? h("span", { class: "key" }, "key") : null))),
        e.access.length ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "read by "), e.access.map((a) => h("span", { class: "pill" }, a))) : null,
        e.stored
          ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "stored in "),
            h("button", { class: "store-link", onclick: (ev) => { ev.stopPropagation(); reveal(e.stored.id); } },
              engineBadge(e.stored.engine), ` ${e.stored.table}`))
          : e.indexes.length ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "indexed on "), e.indexes.join("; ")) : null) : null);
  }

  // ---- endpoints ----------------------------------------------------------------
  // The first few are listed; the rest fold away, except ones the change touches.
  function endpointList(m, ctx) {
    if (!m.endpoints.length) return null;
    const LIMIT = 5;
    const key = `${m.id}/endpoints`;
    const touched = (ep) => allChangesIn(ep.id, ctx).length > 0;
    const sorted = [...m.endpoints].sort((a, b) => Number(touched(b)) - Number(touched(a)));
    const all = state.open.has(key) || sorted.length <= LIMIT + 1;
    const shown = all ? sorted : sorted.filter((ep, i) => i < LIMIT || touched(ep));
    return [
      shown.map((ep) => endpointRow(ep, ctx)),
      sorted.length > shown.length || (state.open.has(key) && sorted.length > LIMIT + 1)
        ? h("button", { class: "more", onclick: () => toggle(key) }, all ? "Show fewer" : `+ ${sorted.length - shown.length} more`)
        : null,
    ];
  }

  function endpointRow(ep, ctx) {
    const open = state.open.has(ep.id);
    const t = state.tab === "change" ? worst(allChangesIn(ep.id, ctx)) : null;
    return h("section", { class: rowClass(ep.id, ctx, open, "endpoint"), "data-node-id": ep.id,
      onmouseenter: () => hover(ep.id), onmouseleave: () => hover(null) },
      h("button", { class: cls("row-head", t && t !== "internal" && `mark-${t}`), "aria-expanded": String(open), onclick: () => toggle(ep.id) },
        h("span", { class: `verb v-${(ep.method || ep.protocol).toLowerCase()}` }, ep.method || ep.protocol),
        h("span", { class: "path" }, pathTokens(ep.path)),
        h("span", { class: cls("aud", `a-${ep.audience}`), title: `${ep.audience} · auth: ${ep.auth}` }, lock()),
        h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      changeList(ctx.placed.get(ep.id)),
      open ? h("div", { class: "row-body" },
        h("p", { class: "aux" }, h("span", { class: "aux-label" }, "calls "), ep.calls.map((c) => h("button", {
          class: "op-chip", onclick: (ev) => { ev.stopPropagation(); if (c.ref) reveal(c.ref); },
          onmouseenter: () => hover(ep.id), onmouseleave: () => hover(null) }, c.label))),
        h("p", { class: "aux" }, h("span", { class: "aux-label" }, "audience "), ep.audience, " · ", h("span", { class: "aux-label" }, "auth "), ep.auth),
        noteLine(ep.note), srcLine(ep.sources)) : null);
  }
  // Path parameters stand out from the fixed parts.
  const pathTokens = (p) => p.split(/(\{[^}]+\}|:\w+)/).filter(Boolean).map((x) =>
    /^(\{|:)/.test(x) ? h("span", { class: "param" }, x) : x.split(/(?<=[/.])/).map((part, i) => [i ? h("wbr", {}) : null, part]));

  // ---- wiring, signals, tests ---------------------------------------------------
  const linkChip = (l, cls_ = "run-chip") => l.ref
    ? h("button", { class: cls_, onclick: (ev) => { ev.stopPropagation(); reveal(l.ref); }, onmouseenter: () => hover(l.ref), onmouseleave: () => hover(null) }, l.label)
    : h("span", { class: cls_ }, l.label);
  const ENVS = ["prod", "local", "test"];

  // A port: what the module needs from outside, and what plugs into it where.
  function portRow(m, pt, ctx) {
    const open = state.open.has(pt.id);
    const fakedBy = m.tests.filter((tc) => tc.fakes.some((f) => f.ref === pt.id));
    return h("section", { class: rowClass(pt.id, ctx, open, "port"), "data-node-id": pt.id },
      rowHead(pt.id, plug(), pt.name, [
        pt.injected ? null : h("span", { class: "warn-pill", title: "Imported directly, so tests can't swap it" }, "hard-wired"),
        ENVS.filter((env) => pt.adapters.some((a) => a.env === env)).map((env) =>
          h("span", { class: `env env-${env}`, title: pt.adapters.filter((a) => a.env === env).map((a) => a.name).join(", ") }, env)),
      ], ctx),
      changeList(ctx.placed.get(pt.id)),
      open ? h("div", { class: "row-body" },
        h("p", { class: "purpose-line" }, terms(pt.purpose)),
        pt.methods.length ? h("div", { class: "fields" }, pt.methods.map((x) => h("div", { class: "mono" }, x))) : null,
        h("div", { class: "adapters" }, ENVS.flatMap((env) => pt.adapters.filter((a) => a.env === env).map((a) =>
          h("div", {}, h("span", { class: `env env-${env}` }, env), " ", h("span", { class: "mono" }, a.name))))),
        fakedBy.length ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "faked in "), fakedBy.map((tc) => linkChip({ label: tc.name, ref: tc.id }, "run-chip prose"))) : null,
        noteLine(pt.note), srcLine(pt.sources)) : null);
  }

  const SIGNAL_ICON = { log: "≡", metric: "▲", trace: "⇢", audit: "✎" };
  function signalRow(sg, ctx) {
    const open = state.open.has(sg.id);
    return h("section", { class: rowClass(sg.id, ctx, open, "signal"), "data-node-id": sg.id },
      rowHead(sg.id, h("span", { class: `sig-type st-${sg.type}`, title: sg.type }, sg.type), h("span", { class: "mono" }, sg.name),
        [sg.alert ? h("span", { class: "alert", title: `Alert: ${sg.alert}` }, bell()) : null], ctx),
      changeList(ctx.placed.get(sg.id)),
      open ? h("div", { class: "row-body" },
        h("p", { class: "aux" }, h("span", { class: "aux-label" }, "on "), linkChip(sg.on)),
        sg.fields.length ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, sg.type === "metric" ? "labels " : "fields "),
          sg.fields.map((f) => h("span", { class: "pill mono" }, f))) : null,
        sg.alert ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "alert "), sg.alert) : null,
        noteLine(sg.note), srcLine(sg.sources)) : null);
  }

  // Counts per level first, so the shape of the strategy reads at a glance.
  const LEVELS = ["unit", "integration", "contract", "e2e"];
  function testSummary(m) {
    if (!m.tests.length) return null;
    const planned = m.tests.filter((tc) => !tc.exists).length;
    return h("div", { class: "test-summary" },
      LEVELS.map((l) => [l, m.tests.filter((tc) => tc.level === l).length]).filter(([, n]) => n).map(([l, n]) =>
        h("span", { class: `lvl lvl-${l}` }, `${n} ${l}`)),
      planned ? h("span", { class: "muted" }, `${planned} to write`) : null);
  }

  function testRow(tc, ctx) {
    const open = state.open.has(tc.id);
    return h("section", { class: rowClass(tc.id, ctx, open, "test"), "data-node-id": tc.id },
      rowHead(tc.id, h("span", { class: cls("tstate", tc.exists ? "exists" : "planned"), title: tc.exists ? "already in the repo" : "to write" }, tc.exists ? "✓" : "○"),
        tc.name, h("span", { class: `lvl lvl-${tc.level}` }, tc.level), ctx, "test-meta"),
      changeList(ctx.placed.get(tc.id)),
      open ? h("div", { class: "row-body" },
        h("p", { class: "aux" }, h("span", { class: "aux-label" }, "proves "), tc.covers.map((c) => linkChip(c))),
        tc.fakes.length ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "fakes "), tc.fakes.map((c) => linkChip(c))) : null,
        noteLine(tc.note), srcLine(tc.sources)) : null);
  }

  // Under an operation: which tests prove it. A command nothing tests says so,
  // once the module has a testing strategy at all.
  function testedBy(m, opId, mode) {
    if (!m.tests.length) return null;
    const ts = m.tests.filter((tc) => tc.covers.some((c) => c.ref === opId));
    if (!ts.length) return mode === "command" ? h("div", { class: "callers" }, h("span", { class: "untested" }, "no test yet")) : null;
    return h("div", { class: "callers" }, h("span", { class: "muted" }, "tested by "), ts.map((tc) =>
      h("button", { class: "run-chip prose", onclick: (ev) => { ev.stopPropagation(); reveal(tc.id); } }, tc.name)));
  }

  const plug = () => s("svg", { class: "icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("path", { d: "M5.5,1.5 v3.5 M10.5,1.5 v3.5 M3.5,5 h9 v3 a4.5,4.5 0 0 1 -9,0 z M8,12.5 v2.5" }));
  const bell = () => s("svg", { class: "icon bell", viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": "true" },
    s("path", { d: "M4,11 v-4 a4,4 0 0 1 8,0 v4 l1.5,1.5 h-11 z M6.5,14 a1.5,1.5 0 0 0 3,0" }));

  // ---- storage ------------------------------------------------------------------
  const ENGINES = { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", dynamodb: "DynamoDB", redis: "Redis", s3: "S3", other: "Store" };
  const engineBadge = (engine) => h("span", { class: `engine e-${engine}` }, ENGINES[engine] || engine);

  function storeBox(st, ctx) {
    const open = state.open.has(st.id);
    const scans = st.tables.reduce((n, tb) => n + tb.scans.length, 0);
    return h("section", { class: cls("store", open && "open", state.selected === st.id && "selected", (!nodeInPhase(st.id) || filteredOut(st.id, ctx)) && "dim"), "data-node-id": st.id },
      h("button", { class: "store-head", "aria-expanded": String(open), onclick: () => toggle(st.id) },
        engineBadge(st.engine), h("span", { class: "store-name" }, st.name),
        scans ? h("span", { class: "scan-count", title: "Lookups with no index" }, `${scans} scan${scans === 1 ? "" : "s"}`) : null,
        h("span", { class: "meta" }, `${st.tables.length} table${st.tables.length === 1 ? "" : "s"}`),
        h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      changeList(ctx.placed.get(st.id)),
      open ? [noteLine(st.note), st.tables.map((tb) => tableRow(tb, ctx))] : null);
  }

  function tableRow(tb, ctx) {
    const open = state.open.has(tb.id);
    const meta = tb.relational
      ? `${tb.columns.length} cols · ${tb.indexes.length} idx`
      : `${tb.gsis.length} index${tb.gsis.length === 1 ? "" : "es"}`;
    return h("section", { class: rowClass(tb.id, ctx, open, "table"), "data-node-id": tb.id },
      h("button", { class: cls("row-head", (() => { const t = state.tab === "change" ? worst(allChangesIn(tb.id, ctx)) : null; return t && t !== "internal" && `mark-${t}`; })()),
        "aria-expanded": String(open), onclick: () => toggle(tb.id) },
        tableIcon(), h("span", { class: "row-name mono" }, tb.table),
        tb.scans.length ? h("span", { class: "scan-count" }, "scan") : null,
        h("span", { class: "meta" }, meta), h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      changeList(ctx.placed.get(tb.id)),
      open ? h("div", { class: "row-body" },
        h("p", { class: "aux" }, h("span", { class: "aux-label" }, "holds "), chip({ s: tb.entityName, ref: tb.entity }, ctx)),
        tb.relational ? relationalBody(tb) : keyValueBody(tb),
        tb.scans.length ? h("div", { class: "scans" }, tb.scans.map((x) => h("div", {}, h("span", { class: "scan-count" }, "scan"), " ", x, h("span", { class: "muted" }, " · no index serves this")))) : null) : null);
  }

  function relationalBody(tb) {
    return [
      h("table", { class: "cols" }, h("tbody", {}, tb.columns.map((c) => h("tr", {},
        h("td", { class: "mono" }, c.key ? h("span", { class: "pk", title: "primary key" }, "PK") : null, c.name),
        h("td", { class: "mono ctype" }, c.type),
        h("td", { class: "muted" }, c.nullable ? "null" : ""))))),
      tb.keyServes.length ? servesLine("primary key", tb.keyServes) : null,
      tb.indexes.map((i) => h("div", { class: "index" },
        h("div", { class: "mono" }, h("span", { class: "idx-kind" }, i.unique ? "unique" : i.using || "index"), ` (${i.on.join(", ")})`, h("span", { class: "muted" }, ` ${i.name}`)),
        i.serves.length ? servesLine(null, i.serves) : null)),
    ];
  }

  function keyValueBody(tb) {
    const key = (label, pk, sk, serves) => h("div", { class: "index" },
      h("div", { class: "kv" }, h("span", { class: "idx-kind" }, label),
        h("span", { class: "mono" }, h("span", { class: "muted" }, "PK "), keyTpl(pk)),
        sk ? h("span", { class: "mono" }, h("span", { class: "muted" }, "SK "), keyTpl(sk)) : null),
      serves.length ? servesLine(null, serves) : null);
    return [
      key("table", tb.pk, tb.sk, tb.keyServes),
      tb.gsis.map((g) => key(g.name, g.pk, g.sk, g.serves)),
      tb.ttl ? h("p", { class: "aux" }, h("span", { class: "aux-label" }, "expires by "), tb.ttl) : null,
    ];
  }
  const keyTpl = (t) => t.split(/(\{\w+\})/).filter(Boolean).map((x) => (x.startsWith("{") ? h("span", { class: "param" }, x) : x));
  const servesLine = (label, xs) => h("div", { class: "serves" }, label ? h("span", { class: "idx-kind" }, label) : null,
    h("span", { class: "tick", "aria-hidden": "true" }, "✓"), xs.join(" · "));

  const fieldsInline = (fs) => fs.map((f, i) => [i ? ", " : "", h("span", { class: "fname" }, f.name), ": ", tokens(f.type)]);
  const tokens = (ts) => ts.map((t) => (t.ref ? chip(t) : h("span", { class: "prim" }, t.s)));
  const chip = (t) => h("button", {
    class: cls("chip", state.open.has(t.ref) && "linked"), "data-ref": t.ref,
    onclick: (ev) => { ev.stopPropagation(); reveal(t.ref); },
    onmouseenter: () => hover(t.ref), onmouseleave: () => hover(null),
  }, t.s);

  const hex = () => s("svg", { class: "icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("polygon", { points: "15,8 11.5,14.1 4.5,14.1 1,8 4.5,1.9 11.5,1.9" }));
  const boxIcon = () => s("svg", { class: "icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), s("path", { d: "M1.5,6 h13" }));
  const cyl = () => s("svg", { class: "icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("ellipse", { cx: 8, cy: 4, rx: 6, ry: 2.4 }), s("path", { d: "M2,4 v8 a6,2.4 0 0 0 12,0 v-8" }));

  const tableIcon = () => s("svg", { class: "icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }), s("path", { d: "M1.5,6.5 h13 M1.5,10 h13 M6,6.5 v7" }));
  const lock = () => s("svg", { class: "icon lock", viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": "true" },
    s("rect", { x: 3, y: 7, width: 10, height: 7, rx: 1.5 }), s("path", { d: "M5.5,7 v-2 a2.5,2.5 0 0 1 5,0 v2" }));

  // ---- domain words -------------------------------------------------------------
  // Glossary terms are underlined wherever prose mentions them; hovering one
  // shows what it means here. One floating tip serves the whole page.
  const termRe = GLOSSARY.length
    ? new RegExp(`\\b(${GLOSSARY.map((g) => g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})(s|es)?\\b`, "gi")
    : null;
  const termOf = (word) => GLOSSARY.find((g) => g.term.toLowerCase() === word.toLowerCase());
  function terms(text) {
    if (!termRe || !text) return text;
    const out = [];
    let last = 0;
    for (const m of text.matchAll(termRe)) {
      const g = termOf(m[1]);
      if (!g) continue;
      out.push(text.slice(last, m.index), h("span", { class: "term", tabindex: "0", "data-tip": g.meaning, "data-term": g.term }, m[0]));
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }
  function tipFor(el) {
    const tip = document.getElementById("tip");
    if (!tip) return;
    if (!el) { tip.hidden = true; return; }
    tip.replaceChildren(h("b", {}, el.getAttribute("data-term")), " ", el.getAttribute("data-tip"));
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left))}px`;
    const below = r.bottom + 8 + tip.offsetHeight < window.innerHeight;
    tip.style.top = `${below ? r.bottom + 6 : r.top - tip.offsetHeight - 6}px`;
  }
  document.addEventListener("mouseover", (ev) => { const t = ev.target.closest?.(".term"); tipFor(t || null); });
  document.addEventListener("focusin", (ev) => { if (ev.target.classList?.contains("term")) tipFor(ev.target); });
  document.addEventListener("focusout", () => tipFor(null));

  // ---- wires --------------------------------------------------------------------
  function drawWires() {
    const layer = document.getElementById("layer"), svg = document.getElementById("wires"), over = document.getElementById("type-wires");
    if (!layer || !svg || !over) return;
    over.replaceChildren();
    const base = layer.getBoundingClientRect(), k = state.view.k;
    // Positions in canvas units, whatever the current pan and zoom.
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return {
        l: (r.left - base.left) / k, r: (r.right - base.left) / k, t: (r.top - base.top) / k, b: (r.bottom - base.top) / k,
        cx: (r.left + r.width / 2 - base.left) / k, cy: (r.top + r.height / 2 - base.top) / k,
      };
    };
    svg.replaceChildren(s("defs", {},
      s("marker", { id: "ah", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        s("path", { d: "M0,0 L10,5 L0,10 z", class: "ah" })),
      s("marker", { id: "ah-hot", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        s("path", { d: "M0,0 L10,5 L0,10 z", class: "ah hot" })),
      s("marker", { id: "ah-route", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        s("path", { d: "M0,0 L10,5 L0,10 z", class: "ah route" }))));
    // The element for a node, or for its nearest ancestor that is on screen
    // (a contract inside a closed sub-module is drawn at the sub-module).
    const find = (id) => {
      for (let x = id; x; x = x.includes("/") ? x.slice(0, x.lastIndexOf("/")) : null) {
        const el = layer.querySelector(`[data-node-id="${CSS.escape(x)}"]`);
        if (el) return el;
      }
      return null;
    };
    // Where a wire may attach. A card offers the middle of all four sides; a
    // row offers the card's left and right edges at the row's height.
    const sides = (el) => {
      if (el.matches(".card")) {
        const b = box(el);
        return [
          { x: b.cx, y: b.t, nx: 0, ny: -1 }, { x: b.cx, y: b.b, nx: 0, ny: 1 },
          { x: b.l, y: b.cy, nx: -1, ny: 0 }, { x: b.r, y: b.cy, nx: 1, ny: 0 },
        ];
      }
      const card = box(el.closest(".card")), row = box(el.querySelector(":scope > .row-head, :scope > .agg-head") || el);
      return [{ x: card.l, y: row.cy, nx: -1, ny: 0 }, { x: card.r, y: row.cy, nx: 1, ny: 0 }];
    };
    // Pick the pair of attachment points that face each other most directly.
    // `shift` slides both ends along their side, so a call and the events
    // coming back between the same two nodes don't sit on one line.
    const link = (fromEl, toEl, shift = 0) => {
      let best = null;
      for (const a of sides(fromEl)) for (const b of sides(toEl)) {
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        // Prefer sides that point towards the other end.
        const facing = (a.nx * dx + a.ny * dy) / d - (b.nx * dx + b.ny * dy) / d;
        const score = d - facing * 120;
        if (!best || score < best.score) best = { a, b, d, score };
      }
      const { d } = best, k = Math.max(30, Math.min(160, d * 0.4));
      const a = { ...best.a, x: best.a.x + best.a.ny * shift, y: best.a.y + best.a.nx * shift };
      const b = { ...best.b, x: best.b.x + best.b.ny * shift, y: best.b.y + best.b.nx * shift };
      return `M${a.x},${a.y} C${a.x + a.nx * k},${a.y + a.ny * k} ${b.x + b.nx * k},${b.y + b.ny * k} ${b.x},${b.y}`;
    };
    const sel = state.selected;
    const before = new Set(view.current.edges.map((e) => `${e.kind} ${e.from} ${e.to}`));

    for (const e of tree().edges) {
      const call = e.kind === "call";
      // Endpoint -> operation links are many; they appear only for the
      // endpoint or operation being looked at.
      if (e.kind === "route") {
        const live = [sel, state.hover].some((x) => x && (under(e.from, x) || under(e.to, x) || x === e.from));
        if (!live) continue;
        const from = layer.querySelector(`[data-node-id="${CSS.escape(e.from)}"]`), to = find(e.to);
        if (!from || !to || from.closest(".card") === to.closest(".card")) continue;
        svg.append(s("path", { d: link(from, to), class: "wire route hot", "marker-end": "url(#ah-route)" }));
        continue;
      }
      const from = find(e.from), to = find(e.to);
      // A module and what sits inside it are already related by nesting.
      if (!from || !to || from === to || from.contains(to) || to.contains(from)) continue;
      const hot = sel && (under(e.from, sel) || under(e.to, sel) || under(sel, e.to));
      const fresh = state.tab === "change" && !before.has(`${e.kind} ${e.from} ${e.to}`);
      svg.append(s("path", {
        d: link(from, to, call ? 0 : 10),
        class: cls("wire", call ? "call" : "event", fresh && "new", hot && "hot", sel && !hot && "faded"),
        "marker-end": `url(#${hot ? "ah-hot" : "ah"})`,
      }));
    }

    // Type wires: from each visible use of an open type to its card, when the
    // two are in different cards (inside one card, hover highlighting is enough).
    const chipSides = (el) => {
      const b = box(el);
      return [{ x: b.l, y: b.cy, nx: -1, ny: 0 }, { x: b.r, y: b.cy, nx: 1, ny: 0 }];
    };
    for (const target of layer.querySelectorAll(".typecard, .row.open[data-node-id*='/entity/']")) {
      const id = target.getAttribute("data-node-id");
      const head = target.querySelector(".type-head, .row-head");
      const home = target.closest(".card");
      for (const c of layer.querySelectorAll(`.chip[data-ref="${CSS.escape(id)}"]`)) {
        if (c.closest(".card") === home || c.closest(".type-chips")) continue;
        const hot = state.hover === id || sel === id;
        let best = null;
        for (const a of chipSides(c)) for (const b of chipSides(head)) {
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (!best || d < best.d) best = { a, b, d };
        }
        const { a, b, d } = best, k = Math.max(30, Math.min(140, d * 0.4));
        over.append(s("path", {
          d: `M${a.x},${a.y} C${a.x + a.nx * k},${a.y} ${b.x + b.nx * k},${b.y} ${b.x},${b.y}`,
          class: cls("wire", "type", hot && "hot"),
        }));
      }
    }
  }

  // ---- below the canvas: context ---------------------------------------------------
  // Open questions come first and start open: they are what the reader owes.
  function context() {
    const parts = [];
    const section = (key, title, count, extra, ...body) => h("details", {
      class: cls("ctx", extra), open: state.ctxOpen.has(key), id: `ctx-${key}`,
      ontoggle: (ev) => { ev.target.open ? state.ctxOpen.add(key) : state.ctxOpen.delete(key); },
    }, h("summary", {}, h("h2", {}, title, h("span", { class: "count" }, String(count)))), body);
    const nodeLink = (id) => h("button", { class: "node-link", onclick: () => reveal(id) }, pretty(id));
    if (doc.questions.length) {
      parts.push(section("questions", "Needs your call", doc.questions.length, "asks", h("ol", { class: "qs" }, doc.questions.map((q) => h("li", {},
        h("div", { class: "q" }, terms(q.text)),
        q.options ? h("div", { class: "options" }, q.options.map((o) => h("span", { class: "option" }, o))) : null,
        q.node ? nodeLink(q.node) : null)))));
    }
    if (view.changes.length && doc.slices.length) {
      const ids = allIds(view.proposed);
      const taken = new Set();
      const phaseCards = h("div", { class: "phases" }, doc.slices.map((sl, i) => {
        const cs = view.changes.filter((c) => !taken.has(c) && changeInPhase(c, sl.nodes));
        cs.forEach((c) => taken.add(c));
        return h("div", { class: cls("phase", state.phase === i && "active") },
          h("h3", {}, h("span", { class: "step" }, String(i + 1)), sl.name, tally(cs)),
          h("p", {}, terms(sl.goal)),
          sl.notes ? h("p", { class: "muted" }, terms(sl.notes)) : null,
          h("button", { class: "linklike", onclick: () => showPhase(i) }, state.phase === i ? "Showing on the map" : "Show on the map"));
      }));
      const rest = view.changes.filter((c) => !taken.has(c) && c.tag !== "internal");
      parts.push(section("phases", "Phases", doc.slices.length, null, phaseCards,
        rest.length ? h("p", { class: "muted" }, `${rest.length} change(s) not in a phase yet: `,
          rest.map((c, i) => [i ? ", " : "", h("button", { class: "linklike", onclick: () => reveal(placeOf(c, ids)) }, c.what)])) : null));
    }
    if (doc.decisions.length) {
      parts.push(section("decisions", "Decisions", doc.decisions.length, null, h("ul", { class: "ds" }, doc.decisions.map((d) => h("li", {},
        h("div", { class: "d" }, terms(d.text)), h("div", { class: "why" }, h("span", { class: "why-label" }, "why "), terms(d.why)),
        d.node ? nodeLink(d.node) : null)))));
    }
    const diags = tree().diagnostics;
    if (diags.length) {
      parts.push(section("checks", "Check results", diags.length, null, diags.map((d) =>
        h("div", { class: `diag ${d.level}` }, h("strong", {}, d.level), " ", h("code", {}, d.at), h("div", {}, d.message)))));
    }
    if (GLOSSARY.length) {
      parts.push(section("glossary", "Domain words", GLOSSARY.length, null, h("dl", { class: "glossary" }, GLOSSARY.map((g) => [
        h("dt", {}, g.node ? h("button", { class: "linklike", onclick: () => reveal(g.node) }, g.term) : g.term),
        h("dd", {}, g.meaning)]))));
    }
    return parts.length ? h("section", { class: "context" }, parts) : null;
  }

  function openSection(key) {
    state.ctxOpen.add(key);
    render();
    document.getElementById(`ctx-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- briefing: the page in ten seconds ----------------------------------------------
  // What was asked, what it costs, what needs an answer, and the order to
  // read it in. Each tile is also a filter or a shortcut.
  function briefing() {
    const t = tree();
    const tile = (cls_, n, label, onclick, active, title) => h("button", {
      class: cls("tile", cls_, active && "active", !n && "zero"), onclick, title, "aria-pressed": active ? "true" : "false", disabled: !n,
    }, h("span", { class: "n" }, String(n)), h("span", { class: "l" }, label));
    const count = (tag) => view.changes.filter((c) => c.tag === tag && (state.phase == null || changeInPhase(c, doc.slices[state.phase].nodes))).length;
    const only = (tag) => () => { state.tab = "change"; state.only = state.only === tag ? null : tag; render(); };
    const ms = everyModule(t.modules);
    const warnings = t.diagnostics.length;
    const tiles = view.proposed
      ? [
        tile("breaking", count("breaking"), "breaking", only("breaking"), state.only === "breaking", "Consumers must change. Click to show only these."),
        tile("migration", count("migration"), "migrations", only("migration"), state.only === "migration", "Stored data must change. Click to show only these."),
        tile("additive", count("additive"), "additive", only("additive"), state.only === "additive", "Nothing existing changes. Click to show only these."),
      ]
      : [
        tile("plain", ms.filter((m) => m.depth === "mapped").length, "modules mapped"),
        tile("plain", ms.reduce((n, m) => n + m.contracts.length, 0), "contracts"),
        tile("plain", ms.reduce((n, m) => n + m.entities.length, 0), "tables"),
        tile("plain", ms.reduce((n, m) => n + m.endpoints.length, 0), "endpoints"),
      ];
    tiles.push(tile("asks", doc.questions.length, doc.questions.length === 1 ? "question for you" : "questions for you", () => openSection("questions")));
    if (warnings) tiles.push(tile("checks", warnings, warnings === 1 ? "check finding" : "check findings", () => openSection("checks")));
    const steps = doc.slices.length && view.proposed
      ? h("ol", { class: "stepper", "aria-label": "Phases" },
        h("li", {}, h("button", { "aria-pressed": String(state.phase == null), onclick: () => { state.phase = null; render(); } }, "All")),
        doc.slices.map((sl, i) => h("li", {}, h("button", {
          "aria-pressed": String(state.phase === i), title: sl.goal,
          onclick: () => { state.tab = "change"; state.phase = state.phase === i ? null : i; render(); },
        }, h("span", { class: "step" }, String(i + 1)), sl.name))))
      : null;
    return h("section", { class: "briefing" },
      h("div", { class: "ask" }, h("div", { class: "eyebrow" }, doc.mode === "learn" ? "What we're learning" : "The change"), h("p", {}, terms(doc.intent))),
      h("div", { class: "tiles" }, tiles),
      steps,
      GLOSSARY.length ? h("div", { class: "words" }, h("span", { class: "eyebrow" }, "Domain words"),
        GLOSSARY.map((g) => h("button", { class: "term word", "data-tip": g.meaning, "data-term": g.term, onclick: () => g.node && reveal(g.node) }, g.term))) : null);
  }

  // ---- search: jump to anything ------------------------------------------------------
  function searchIndex() {
    const out = [];
    for (const m of everyModule(tree().modules)) {
      out.push({ id: m.id, label: m.name, kind: "module", hint: m.purpose });
      for (const ep of m.endpoints) out.push({ id: ep.id, label: `${ep.method || ep.protocol} ${ep.path}`, kind: "endpoint", hint: ep.calls.map((c) => c.label).join(", ") });
      for (const c of m.contracts) {
        out.push({ id: c.id, label: c.name, kind: "contract", hint: m.name });
        for (const o of c.operations) out.push({ id: o.id, label: `${c.name}.${o.name}`, kind: "operation", hint: o.mode });
        for (const e of c.events) out.push({ id: e.id, label: `${c.name}.${e.name}`, kind: "event", hint: "event" });
        for (const ty of c.types) out.push({ id: ty.id, label: ty.name, kind: "type", hint: c.name });
      }
      for (const e of m.entities) out.push({ id: e.id, label: e.name, kind: "data", hint: m.name });
      for (const st of m.stores) for (const tb of st.tables) out.push({ id: tb.id, label: tb.table, kind: "storage", hint: `${ENGINES[st.engine] || st.engine} · ${st.name}` });
      for (const pt of m.ports) out.push({ id: pt.id, label: pt.name, kind: "port", hint: pt.purpose });
      for (const sg of m.signals) out.push({ id: sg.id, label: sg.name, kind: "signal", hint: `${sg.type} on ${sg.on.label}` });
      for (const tc of m.tests) out.push({ id: tc.id, label: tc.name, kind: "test", hint: `${tc.level} test` });
    }
    for (const g of GLOSSARY) out.push({ id: g.node, label: g.term, kind: "word", hint: g.meaning });
    return out;
  }
  function search() {
    let hits = [], at = 0;
    const list = h("ul", { class: "hits", role: "listbox", hidden: true });
    const go = (hit) => { input.value = ""; list.hidden = true; input.blur(); if (hit?.id) reveal(hit.id); };
    const draw = () => {
      list.replaceChildren(...hits.map((x, i) => h("li", { role: "option", class: cls(i === at && "on"), "aria-selected": String(i === at),
        onmousedown: (ev) => { ev.preventDefault(); go(x); } },
      h("span", { class: `kind k-${x.kind}` }, x.kind), h("span", { class: "hit-label" }, x.label), h("span", { class: "hit-hint" }, x.hint))));
      list.hidden = !hits.length;
    };
    const input = h("input", {
      type: "search", id: "search", placeholder: "Jump to…  /", "aria-label": "Jump to a module, endpoint, table or word", autocomplete: "off",
      oninput: () => {
        const q = input.value.trim().toLowerCase();
        const idx = searchIndex();
        hits = q ? idx.filter((x) => x.label.toLowerCase().includes(q) || (x.kind === "word" && x.hint.toLowerCase().includes(q)))
          .sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q))).slice(0, 8) : [];
        at = 0; draw();
      },
      onkeydown: (ev) => {
        if (ev.key === "ArrowDown") { at = Math.min(hits.length - 1, at + 1); draw(); ev.preventDefault(); }
        else if (ev.key === "ArrowUp") { at = Math.max(0, at - 1); draw(); ev.preventDefault(); }
        else if (ev.key === "Enter") go(hits[at]);
        else if (ev.key === "Escape") { input.value = ""; hits = []; draw(); input.blur(); }
      },
      onblur: () => setTimeout(() => { list.hidden = true; }, 100),
    });
    return h("div", { class: "search" }, input, list);
  }

  // Keys for working quickly: / search, esc clear, f fit, 0-9 phases.
  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest?.("input, textarea") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "/") { ev.preventDefault(); document.getElementById("search")?.focus(); }
    else if (ev.key === "Escape") {
      if (state.selected || state.only || state.phase != null) { state.selected = null; state.only = null; state.phase = null; render(); }
    } else if (ev.key === "f") fit();
    else if (/^[0-9]$/.test(ev.key) && view.proposed) {
      const i = Number(ev.key) - 1;
      if (i < doc.slices.length) { state.tab = "change"; state.phase = i < 0 ? null : i; render(); }
    }
  });

  function showPhase(i) {
    state.tab = "change";
    state.phase = state.phase === i ? null : i;
    render();
    document.getElementById("viewport")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- sidebar: the conversation ----------------------------------------------------
  function sidebar() {
    const anchor = state.selected;
    const copy = () => {
      const text = [`Notes on the plan "${doc.title}":`, ...state.notes.map((n) => `- [${n.anchor || "general"}] ${n.text}`)].join("\n");
      navigator.clipboard?.writeText(text).then(() => flashButton("copy", "Copied"), () => flashButton("copy", "Copy failed"));
    };
    const queue = () => {
      const text = state.draft.trim();
      if (!text) return;
      state.notes.push({ anchor, text });
      state.draft = "";
      saveNotes();
      render();
    };
    return h("aside", { class: "chat", "aria-label": "Conversation" },
      h("div", { class: "chat-head" }, "Conversation"),
      h("div", { class: "msgs" },
        state.notes.length ? null : h("p", { class: "empty" }, "Notes you add land here. Click anything on the map first to pin a note to it, then copy them all as one prompt for the agent."),
        state.notes.map((n, i) => h("div", { class: "msg you queued" },
          h("div", { class: "who" }, n.anchor ? h("button", { class: "linklike", onclick: () => reveal(n.anchor) }, pretty(n.anchor)) : "General",
            h("button", { class: "x", "aria-label": "Remove note", onclick: () => { state.notes.splice(i, 1); saveNotes(); render(); } }, "×")),
          n.text))),
      h("div", { class: "composer" },
        h("div", { class: "about" }, anchor
          ? ["About ", h("b", {}, pretty(anchor)), h("button", { class: "x", "aria-label": "Clear", onclick: () => select(anchor) }, "×")]
          : h("span", { class: "muted" }, "Click anything on the map to attach a note to it.")),
        h("textarea", {
          rows: 3, placeholder: "Write a note…", "aria-label": "Note",
          oninput: (ev) => { state.draft = ev.target.value; },
          onkeydown: (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); queue(); } },
        }, state.draft),
        h("div", { class: "actions" },
          h("button", { class: "btn", onclick: queue }, "Add note"),
          h("button", { class: "btn quiet", id: "copy", disabled: !state.notes.length, onclick: copy },
            state.notes.length ? `Copy ${state.notes.length} as prompt` : "Copy as prompt"))));
  }
  function flashButton(id, text) {
    const b = document.getElementById(id);
    if (!b) return;
    const was = b.textContent;
    b.textContent = text;
    setTimeout(() => { b.textContent = was; }, 1200);
  }
  function loadNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "[]"); } catch { return []; }
  }
  function saveNotes() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes)); } catch { /* storage unavailable */ }
  }

  // ---- page ---------------------------------------------------------------------------
  function render() {
    const tabs = view.proposed
      ? h("div", { class: "tabs", role: "group", "aria-label": "Which tree" },
        [["current", "Before"], ["proposed", "After"], ["change", "Change"]].map(([k, label]) =>
          h("button", { "aria-pressed": String(state.tab === k), onclick: () => { state.tab = k; if (k !== "change") state.only = null; render(); } }, label)))
      : null;
    const filters = [
      state.only ? h("button", { class: `filter-chip ${state.only}`, onclick: () => { state.only = null; render(); } }, `only ${state.only}`, h("span", { "aria-hidden": "true" }, " ×")) : null,
      state.selected ? h("button", { class: "filter-chip", onclick: () => { state.selected = null; render(); } }, `focus: ${pretty(state.selected)}`, h("span", { "aria-hidden": "true" }, " ×")) : null,
    ];
    const textarea = document.activeElement?.tagName === "TEXTAREA";
    document.getElementById("app").replaceChildren(h("div", { class: "shell" },
      h("main", { class: "main" },
        h("header", { class: "top" },
          h("div", { class: "heading" }, h("h1", {}, doc.title), h("span", { class: "badge" }, doc.mode === "learn" ? "learning" : "plan")),
          h("div", { class: "controls" }, search(), tabs)),
        briefing(),
        filters.some(Boolean) ? h("div", { class: "filters" }, filters) : null,
        canvas(),
        context()),
      sidebar()),
    h("div", { id: "tip", class: "tip", role: "tooltip", hidden: true }));
    if (textarea) document.querySelector(".composer textarea")?.focus();
    layoutGraph();
    if (!state.fitted) { fit(); state.fitted = true; }
    drawWires();
  }

  window.addEventListener("resize", () => requestAnimationFrame(drawWires));
  render();
})();
