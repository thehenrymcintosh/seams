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
    ctxOpen: new Set(),        // which context sections below the canvas are open
  };

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
    }
    return out;
  }

  // A change is shown on the deepest node that exists in the tree being drawn.
  function placeOf(change, ids) {
    let id = change.node;
    while (id && !ids.has(id)) id = id.includes("/") ? id.slice(0, id.lastIndexOf("/")).replace(/\/(contract|entity|type|aggregate)$/, "") : null;
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
  const pretty = (id) => id.split(/\/(?:contract|entity|type|aggregate)\/|\//)
    .filter((p, i, xs) => p !== xs[i - 1]).join(" › ");

  // ---- canvas -------------------------------------------------------------------
  function canvas() {
    const t = tree();
    const ctx = { placed: changesByPlace() };
    const tool = (label, title, fn) => h("button", { class: "tool", title, "aria-label": title, onclick: fn }, label);
    const legend = h("div", { class: "legend" },
      h("span", { class: "lg-call" }, "calls"), h("span", { class: "lg-event" }, "reacts to event"),
      h("span", { class: "lg-type" }, "uses type"),
      state.tab === "change" ? h("span", { class: "lg-new" }, "new dependency") : null,
      state.tab === "change" ? TAGS.slice(0, 3).map((x) => h("span", { class: `lg-tag ${x}` }, x)) : null,
      h("span", { class: "hint" }, "drag cards · drag the background to pan · ctrl + scroll to zoom"));
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

  const facts = (id) => (doc.facts[id] || []).map((f) =>
    h("span", { class: "fact", title: f.detail || "" }, `${f.label} `, h("b", {}, String(f.value))));

  function moduleCard(m, ctx, close) {
    const cs = ctx.placed.get(m.id);
    const tagged = state.tab === "change" ? worst(allChangesIn(m.id, ctx)) : null;
    return h("article", {
      class: cls("card", m.depth === "stub" && "stub", tagged && tagged !== "internal" && `tag-${tagged}`,
        !nodeInPhase(m.id) && "dim", state.selected === m.id && "selected"),
      "data-node-id": m.id,
    },
      h("header", { class: "card-head", onclick: () => select(m.id) },
        h("div", { class: "title" }, h("span", { class: "name" }, m.name), m.depth === "stub" ? h("span", { class: "badge" }, "not mapped") : null, facts(m.id),
          close ? h("button", { class: "x", "aria-label": `Close ${m.name}`, onclick: (ev) => { ev.stopPropagation(); close(); } }, "×") : null),
        h("p", { class: "purpose" }, m.purpose),
        m.sources.length ? h("p", { class: "src" }, m.sources.join(" · ")) : null,
        m.note ? h("p", { class: "note" }, m.note) : null,
        reactsTo(m),
        changeList(cs)),
      m.contracts.map((c) => contractRow(m, c, ctx)),
      m.aggregates.map((a) => aggregateBox(m, a, ctx)),
      m.entities.filter((e) => !m.aggregates.some((a) => a.root === e.id || a.members.includes(e.id))).map((e) => entityRow(e, ctx)),
      m.modules.map((sub) => subModule(sub, ctx)));
  }

  // An aggregate is drawn as a boundary around the tables it holds, with the
  // root first. Its invariants open with it.
  function aggregateBox(m, a, ctx) {
    const open = state.open.has(a.id);
    const byId = new Map(m.entities.map((e) => [e.id, e]));
    return h("section", { class: cls("aggregate", open && "open", state.selected === a.id && "selected", !nodeInPhase(a.id) && "dim"), "data-node-id": a.id },
      h("button", { class: "agg-head", "aria-expanded": String(open), onclick: () => toggle(a.id) },
        h("span", { class: "agg-label" }, `${a.name} aggregate`),
        a.invariants.length ? h("span", { class: "meta" }, `${a.invariants.length} invariant${a.invariants.length === 1 ? "" : "s"}`) : null,
        h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      changeList(ctx.placed.get(a.id)),
      open && a.invariants.length ? h("ul", { class: "invariants" }, a.invariants.map((i) => h("li", {}, i))) : null,
      [a.root, ...a.members].map((id) => byId.get(id)).filter(Boolean).map((e) => entityRow(e, ctx, e.id === a.root)));
  }

  // A sub-module is a row until opened, then a card nested inside its parent.
  function subModule(sub, ctx) {
    const open = state.open.has(sub.id);
    if (open) return h("div", { class: "nested" }, moduleCard(sub, ctx, () => toggle(sub.id)));
    const t = state.tab === "change" ? worst(allChangesIn(sub.id, ctx)) : null;
    return h("section", { class: cls("row", "sub", state.selected === sub.id && "selected", !nodeInPhase(sub.id) && "dim"), "data-node-id": sub.id },
      h("button", { class: cls("row-head", t && t !== "internal" && `mark-${t}`), "aria-expanded": "false", onclick: () => toggle(sub.id) },
        boxIcon(), h("span", { class: "row-name" }, sub.name), h("span", { class: "meta" }, "inside"), facts(sub.id),
        h("span", { class: "chev", "aria-hidden": "true" }, "›")));
  }

  // Events are the one relationship a wire can't label legibly, so the
  // subscriber says what it listens for.
  function reactsTo(m) {
    const evs = tree().edges.filter((e) => e.kind === "event" && e.to === m.id);
    if (!evs.length) return null;
    return h("p", { class: "listens" }, "on ", evs.map((e, i) => [i ? "; " : "", h("button", {
      class: "linklike quiet", onclick: (ev) => { ev.stopPropagation(); reveal(e.from); } }, e.from.split("/").pop()), " ", e.label]));
  }

  function allChangesIn(id, ctx) {
    const out = [];
    for (const [p, cs] of ctx.placed) if (under(p, id)) out.push(...cs);
    return out;
  }

  function rowHead(id, icon, label, meta, ctx) {
    const t = state.tab === "change" ? worst(allChangesIn(id, ctx)) : null;
    return h("button", {
      class: cls("row-head", t && t !== "internal" && `mark-${t}`), "aria-expanded": String(state.open.has(id)),
      onclick: () => toggle(id),
    }, icon, h("span", { class: "row-name" }, label), meta ? h("span", { class: "meta" }, meta) : null, facts(id),
    h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }

  function contractRow(m, c, ctx) {
    const open = state.open.has(c.id) && m.depth === "mapped";
    const n = c.operations.length + c.events.length;
    return h("section", { class: cls("row", open && "open", !nodeInPhase(c.id) && "dim", state.selected === c.id && "selected"), "data-node-id": c.id },
      rowHead(c.id, hex(), c.name, m.depth === "stub" ? "not mapped" : `${n} member${n === 1 ? "" : "s"}`, ctx),
      changeList(ctx.placed.get(c.id)),
      open ? h("div", { class: "row-body" },
        c.note ? h("p", { class: "note" }, c.note) : null,
        c.sources.length ? h("p", { class: "src" }, c.sources.join(" · ")) : null,
        c.operations.map((o) => member(o.id, h("span", { class: `mode ${o.mode}` }, o.mode === "command" ? "cmd" : "query"),
          [h("span", { class: "mname" }, o.name), "(", fieldsInline(o.input), ")", " → ", o.output ? tokens(o.output) : h("span", { class: "muted" }, "void")],
          o.errors.length ? h("div", { class: "errs" }, "fails with ", o.errors.join(", ")) : null, ctx)),
        c.events.map((e) => member(e.id, h("span", { class: "mode event" }, "event"),
          [h("span", { class: "mname" }, e.name), " { ", fieldsInline(e.payload), " }"], null, ctx)),
        typeShelf(c, ctx)) : null);
  }

  function member(id, badge, sig, extra, ctx) {
    return h("div", { class: cls("member", state.selected === id && "selected", !nodeInPhase(id) && "dim"), "data-node-id": id,
      onclick: (ev) => { if (!ev.target.closest(".chip")) select(id); } },
    h("div", { class: "sig" }, badge, " ", sig), extra, changeList(ctx.placed.get(id)));
  }

  // Types live under the contract that defines them: open ones as cards,
  // the rest as chips that open them.
  function typeShelf(c, ctx) {
    if (!c.types.length) return null;
    const closed = c.types.filter((t) => !state.open.has(t.id));
    return h("div", { class: "types" },
      c.types.filter((t) => state.open.has(t.id)).map((t) => typeCard(t, ctx)),
      closed.length ? h("div", { class: "type-chips" }, h("span", { class: "muted" }, "types "), closed.map((t) => chip({ s: t.name, ref: t.id }))) : null);
  }

  function typeCard(t, ctx) {
    return h("div", { class: cls("typecard", state.selected === t.id && "selected", !nodeInPhase(t.id) && "dim"), "data-node-id": t.id },
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
    return h("section", { class: cls("row", open && "open", !nodeInPhase(e.id) && "dim", state.selected === e.id && "selected"), "data-node-id": e.id },
      rowHead(e.id, cyl(), e.name, `${root ? "root · " : ""}${e.fields.length} fields`, ctx),
      changeList(ctx.placed.get(e.id)),
      open ? h("div", { class: "row-body" },
        e.note ? h("p", { class: "note" }, e.note) : null,
        e.sources.length ? h("p", { class: "src" }, e.sources.join(" · ")) : null,
        h("div", { class: "fields" }, e.fields.map((f) =>
          h("div", {}, h("span", { class: "fname" }, f.name), ": ", tokens(f.type), f.key ? h("span", { class: "key" }, "key") : null))),
        e.indexes.length ? h("p", { class: "aux" }, "indexed on ", e.indexes.join("; ")) : null,
        e.access.length ? h("p", { class: "aux" }, "accessed by ", e.access.join(", ")) : null) : null);
  }

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
        s("path", { d: "M0,0 L10,5 L0,10 z", class: "ah hot" }))));
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
      const from = find(e.from), to = find(e.to);
      // A module and what sits inside it are already related by nesting.
      if (!from || !to || from === to || from.contains(to) || to.contains(from)) continue;
      const hot = sel && (under(sel, e.from) || under(sel, e.to));
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
  function context() {
    const parts = [];
    const section = (key, title, count, ...body) => h("details", {
      class: "ctx", open: state.ctxOpen.has(key),
      ontoggle: (ev) => { ev.target.open ? state.ctxOpen.add(key) : state.ctxOpen.delete(key); },
    }, h("summary", {}, h("h2", {}, title, h("span", { class: "count" }, String(count)))), body);
    if (view.changes.length && doc.slices.length) {
      const ids = allIds(view.proposed);
      const taken = new Set();
      const phaseCards = h("div", { class: "phases" }, doc.slices.map((sl, i) => {
        const cs = view.changes.filter((c) => !taken.has(c) && changeInPhase(c, sl.nodes));
        cs.forEach((c) => taken.add(c));
        const counts = TAGS.map((t) => [t, cs.filter((c) => c.tag === t).length]).filter(([, n]) => n);
        return h("div", { class: cls("phase", state.phase === i && "active") },
          h("h3", {}, h("span", { class: "muted" }, `Phase ${i + 1} `), sl.name),
          h("p", {}, sl.goal),
          sl.notes ? h("p", { class: "muted" }, sl.notes) : null,
          h("p", { class: "counts" }, counts.map(([t, n]) => h("span", { class: `tag ${t}` }, `${n} ${t}`))),
          h("button", { class: "linklike", onclick: () => showPhase(i) }, state.phase === i ? "Showing on the map" : "Show on the map"));
      }));
      const rest = view.changes.filter((c) => !taken.has(c) && c.tag !== "internal");
      parts.push(section("phases", "Phases", doc.slices.length, phaseCards,
        rest.length ? h("p", { class: "muted" }, `${rest.length} change(s) not in a phase yet: `,
          rest.map((c, i) => [i ? ", " : "", h("button", { class: "linklike", onclick: () => reveal(placeOf(c, ids)) }, c.what)])) : null));
    }
    if (doc.questions.length) {
      parts.push(section("questions", "Open questions", doc.questions.length, h("ol", { class: "qs" }, doc.questions.map((q) => h("li", {},
        q.text, q.node ? [" ", h("button", { class: "linklike", onclick: () => reveal(q.node) }, pretty(q.node))] : null,
        q.options ? h("div", { class: "muted" }, q.options.join(" · ")) : null)))));
    }
    if (doc.decisions.length) {
      parts.push(section("decisions", "Decisions", doc.decisions.length, h("ul", { class: "ds" }, doc.decisions.map((d) => h("li", {},
        h("strong", {}, d.text), d.node ? [" ", h("button", { class: "linklike", onclick: () => reveal(d.node) }, pretty(d.node))] : null,
        h("div", { class: "muted" }, d.why))))));
    }
    const diags = tree().diagnostics;
    if (diags.length) {
      state.ctxOpen.add("checks");
      parts.push(section("checks", "Check results", diags.length, diags.map((d) =>
        h("div", { class: `diag ${d.level}` }, h("strong", {}, d.level), " ", h("code", {}, d.at), " ", d.message))));
    }
    return parts.length ? h("section", { class: "context" }, parts) : null;
  }

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
        h("div", { class: "msg you" }, h("div", { class: "who" }, "Intent"), doc.intent),
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
        [["current", "Current"], ["proposed", "Proposed"], ["change", "Change"]].map(([k, label]) =>
          h("button", { "aria-pressed": String(state.tab === k), onclick: () => { state.tab = k; render(); } }, label)))
      : null;
    const phases = state.tab === "change" && doc.slices.length
      ? h("div", { class: "phase-strip", role: "group", "aria-label": "Phase" },
        h("button", { "aria-pressed": String(state.phase == null), onclick: () => { state.phase = null; render(); } }, "All changes"),
        doc.slices.map((sl, i) => h("button", { "aria-pressed": String(state.phase === i), onclick: () => { state.phase = i; render(); } }, `${i + 1} · ${sl.name}`)))
      : null;
    const textarea = document.activeElement?.tagName === "TEXTAREA";
    document.getElementById("app").replaceChildren(h("div", { class: "shell" },
      h("main", { class: "main" },
        h("header", { class: "top" },
          h("div", { class: "heading" }, h("h1", {}, doc.title), h("span", { class: "badge" }, doc.mode === "learn" ? "learning" : "plan")),
          h("div", { class: "controls" }, tabs, phases)),
        canvas(),
        context()),
      sidebar()));
    if (textarea) document.querySelector(".composer textarea")?.focus();
    layoutGraph();
    if (!state.fitted) { fit(); state.fitted = true; }
    drawWires();
  }

  window.addEventListener("resize", () => requestAnimationFrame(drawWires));
  render();
})();
