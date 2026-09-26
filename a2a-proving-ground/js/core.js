/* A2A Proving Ground — core
 *
 * A tiny, dependency-free framework: hash router, lesson registry, progress,
 * and the three reusable pieces every lab is built from:
 *   PG.stage()  animated actors + packets (colour = actor)
 *   PG.wire()   wire inspector: every exchange with HTTP start line, headers, body
 *   PG.quiz()   check-your-understanding questions
 *
 * Classic script (no modules) so the site also works from file://.
 */
(function () {
  "use strict";

  const PG = (window.PG = window.PG || {});
  PG.tracks = [];
  PG.lessons = [];
  PG.byId = {};
  PG.speed = 1;
  PG.session = 0;
  PG.reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ── registry ────────────────────────────────────────────────────────── */
  PG.track = function (id, title, blurb) {
    PG.tracks.push({ id: id, title: title, blurb: blurb });
  };
  PG.lesson = function (def) {
    PG.lessons.push(def);
    PG.byId[def.id] = def;
  };
  PG.trackOf = function (def) {
    return PG.tracks.find(function (t) { return t.id === def.track; }) || { title: "" };
  };

  /* ── DOM helpers ─────────────────────────────────────────────────────── */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  PG.h = h;
  PG.esc = function (s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  PG.clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  /* ── time ────────────────────────────────────────────────────────────── */
  PG.sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, Math.max(0, ms / PG.speed)); });
  };
  PG.alive = function (tok) { return tok === PG.session; };

  /* ── ids & encodings ─────────────────────────────────────────────────── */
  PG.hex = function (n) {
    const a = new Uint8Array(n);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.from(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  };
  PG.uuid = function () {
    const x = PG.hex(16);
    return x.slice(0, 8) + "-" + x.slice(8, 12) + "-4" + x.slice(13, 16) + "-a" + x.slice(17, 20) + "-" + x.slice(20, 32);
  };
  PG.b64url = function (input) {
    let bytes;
    if (typeof input === "string") bytes = new TextEncoder().encode(input);
    else bytes = new Uint8Array(input);
    let s = "";
    bytes.forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  PG.b64urlDecode = function (s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return new TextDecoder().decode(Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }));
  };
  /* A structurally real JWT with a fake signature — for teaching, never for use. */
  PG.fakeJwt = function (claims) {
    return PG.b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "auth-2026-09" })) + "." +
      PG.b64url(JSON.stringify(claims)) + "." + PG.b64url(PG.hex(24));
  };

  /* ── JSON → highlighted HTML ─────────────────────────────────────────── */
  function jstr(s) { return '<span class="j-str">' + PG.esc(JSON.stringify(s)) + "</span>"; }
  function jval(v, hl, ind) {
    const pad = "  ".repeat(ind);
    if (v === null) return '<span class="j-null">null</span>';
    if (typeof v === "boolean") return '<span class="j-bool">' + v + "</span>";
    if (typeof v === "number") return '<span class="j-num">' + v + "</span>";
    if (typeof v === "string") return jstr(v);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      const flat = v.every(function (x) { return x === null || typeof x !== "object"; });
      if (flat && JSON.stringify(v).length < 64) return "[" + v.map(function (x) { return jval(x, hl, 0); }).join(", ") + "]";
      return "[\n" + v.map(function (x) { return pad + "  " + jval(x, hl, ind + 1); }).join(",\n") + "\n" + pad + "]";
    }
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return "{\n" + keys.map(function (k) {
      const line = '<span class="j-key">' + PG.esc(JSON.stringify(k)) + "</span>: " + jval(v[k], hl, ind + 1);
      return pad + "  " + (hl && hl.indexOf(k) >= 0 ? '<span class="j-hl">' + line + "</span>" : line);
    }).join(",\n") + "\n" + pad + "}";
  }
  PG.jsonHTML = function (v, highlightKeys) { return jval(v, highlightKeys || null, 0); };

  /* HTTP message → highlighted HTML. body may be an object, a string, or an
   * array of SSE event objects ({sse:[...]}) which renders as `data:` lines. */
  PG.httpHTML = function (msg, hl) {
    let out = "";
    if (msg.start) out += '<span class="http-start">' + PG.esc(msg.start) + "</span>\n";
    if (msg.headers) {
      Object.keys(msg.headers).forEach(function (k) {
        out += '<span class="http-h">' + PG.esc(k) + ":</span> " + PG.esc(msg.headers[k]) + "\n";
      });
    }
    if (msg.body !== undefined || msg.sse) out += "\n";
    if (msg.sse) {
      out += msg.sse.map(function (e) {
        return '<span class="http-h">data:</span> ' + PG.jsonHTML(e, hl).replace(/\n\s*/g, " ");
      }).join("\n\n");
    } else if (typeof msg.body === "string") out += PG.esc(msg.body);
    else if (msg.body !== undefined) out += PG.jsonHTML(msg.body, hl);
    return out;
  };

  /* ── progress (localStorage, optional) ───────────────────────────────── */
  const KEY = "a2a-proving-ground:v1";
  PG.progress = { seen: {}, done: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) PG.progress = Object.assign(PG.progress, JSON.parse(raw));
  } catch (e) { /* storage blocked — progress lasts this visit only */ }
  function saveProgress() {
    try { localStorage.setItem(KEY, JSON.stringify(PG.progress)); } catch (e) { /* ignore */ }
    paintProgress();
  }
  PG.markSeen = function (id) { if (!PG.progress.seen[id]) { PG.progress.seen[id] = true; saveProgress(); } };
  PG.markDone = function (id) { PG.progress.seen[id] = true; PG.progress.done[id] = true; saveProgress(); };
  PG.resetProgress = function () { PG.progress = { seen: {}, done: {} }; saveProgress(); };
  function paintProgress() {
    const total = PG.lessons.length;
    const done = PG.lessons.filter(function (l) { return PG.progress.done[l.id]; }).length;
    const m = document.getElementById("pg-progress");
    if (m) {
      m.querySelector("i").style.width = (total ? (100 * done) / total : 0) + "%";
      m.querySelector("span").textContent = done + " / " + total + " passed";
    }
    document.querySelectorAll("[data-dot]").forEach(function (d) {
      const id = d.getAttribute("data-dot");
      d.className = "dot" + (PG.progress.done[id] ? " done" : PG.progress.seen[id] ? " seen" : "");
    });
  }
  PG.paintProgress = paintProgress;

  /* ── toast ───────────────────────────────────────────────────────────── */
  PG.toast = function (text, tone) {
    let t = document.getElementById("pg-toast");
    if (!t) {
      t = h("div", {
        id: "pg-toast", role: "status",
        style: {
          position: "fixed", left: "50%", bottom: "calc(18px + env(safe-area-inset-bottom, 0px))",
          transform: "translateX(-50%)", zIndex: 60, padding: "9px 14px", borderRadius: "7px",
          fontSize: "13.5px", fontWeight: 600, boxShadow: "var(--shadow)", maxWidth: "calc(100vw - 32px)",
        },
      });
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.background = tone === "err" ? "var(--err)" : "var(--ink)";
    t.style.color = "var(--paper)";
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.hidden = true; }, 2600);
  };

  /* ── small controls ──────────────────────────────────────────────────── */
  PG.seg = function (options, value, onChange, label) {
    const el = h("div", { class: "seg", role: "group", "aria-label": label || "Choose" });
    function paint() {
      el.querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.v === String(value) ? "true" : "false");
      });
    }
    options.forEach(function (o) {
      el.appendChild(h("button", {
        type: "button", "data-v": String(o.v), text: o.label,
        onclick: function () { value = o.v; paint(); onChange(o.v); },
      }));
    });
    paint();
    el.set = function (v) { value = v; paint(); };
    return el;
  };
  PG.switch = function (id, label, checked, onChange) {
    const input = h("input", { type: "checkbox", id: id, role: "switch" });
    input.checked = !!checked;
    input.addEventListener("change", function () { onChange(input.checked); });
    const el = h("label", { class: "switch", for: id }, input, label);
    el.input = input;
    return el;
  };
  PG.select = function (id, options, value, onChange) {
    const s = h("select", { id: id, class: "inline" });
    options.forEach(function (o) {
      const opt = h("option", { value: String(o.v), text: o.label });
      if (String(o.v) === String(value)) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener("change", function () { onChange(s.value); });
    return s;
  };
  PG.lab = function (parent, title, kicker) {
    const head = h("div", { class: "lab-head" }, kicker ? h("div", { class: "lab-kicker", text: kicker }) : null, h("h3", { text: title }));
    const body = h("div", { class: "lab-body" });
    const el = h("section", { class: "lab" }, head, body);
    parent.appendChild(el);
    return { el: el, head: head, body: body };
  };
  PG.stateChip = function (state) {
    const s = String(state).replace("TASK_STATE_", "");
    return h("span", { class: "state s-" + s, text: s });
  };

  /* ── stage: actors + animated packets ────────────────────────────────── */
  const GLYPH = { client: "C", server: "A", proxy: "G", auth: "Z", registry: "R", user: "U", attacker: "!" };
  PG.stage = function (parent, cfg) {
    const el = h("div", { class: "stage" + (cfg.size ? " " + cfg.size : "") });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "links");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    el.appendChild(svg);
    const caption = h("div", { class: "stage-caption", "aria-live": "polite" });
    const actors = {};
    const lines = {};

    (cfg.actors || []).forEach(function (a) {
      const badge = h("div", { class: "a-badge" });
      const node = h("div", {
        class: "actor r-" + a.role + (a.locked ? " locked" : "") + (a.dim ? " dim" : ""),
        style: { left: a.x + "%", top: a.y + "%" },
      },
        h("div", { class: "glyph", text: a.glyph || GLYPH[a.role] || "•", "aria-hidden": "true" }),
        h("div", { class: "a-label", text: a.label }),
        a.sub ? h("div", { class: "a-sub", text: a.sub }) : null,
        badge);
      el.appendChild(node);
      actors[a.id] = { def: a, node: node, badge: badge };
    });
    (cfg.links || []).forEach(function (pair) { link(pair[0], pair[1], pair[2]); });
    parent.appendChild(el);
    parent.appendChild(caption);

    function link(a, b, cls) {
      const A = actors[a].def, B = actors[b].def;
      const key = a + "|" + b;
      let ln = lines[key];
      if (!ln) {
        ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        svg.appendChild(ln);
        lines[key] = ln;
      }
      ln.setAttribute("x1", A.x); ln.setAttribute("y1", A.y);
      ln.setAttribute("x2", B.x); ln.setAttribute("y2", B.y);
      ln.setAttribute("class", cls || "");
      return ln;
    }

    const tok = PG.session;
    const api = {
      el: el,
      captionEl: caption,
      actors: actors,
      link: link,
      caption: function (text) { caption.innerHTML = text || ""; },
      badge: function (id, content) {
        const b = actors[id].badge;
        b.innerHTML = "";
        if (content) append(b, typeof content === "string" ? h("span", { class: "chip", html: content }) : content);
      },
      set: function (id, opts) {
        const a = actors[id];
        if (opts.dim !== undefined) a.node.classList.toggle("dim", !!opts.dim);
        if (opts.locked !== undefined) a.node.classList.toggle("locked", !!opts.locked);
        if (opts.label) a.node.querySelector(".a-label").textContent = opts.label;
      },
      flash: function (id) {
        const n = actors[id].node;
        n.classList.add("flash");
        setTimeout(function () { n.classList.remove("flash"); }, 450);
      },
      /* Move a labelled packet from one actor to another. Resolves false if
       * the user navigated away mid-flight, so flows can stop cleanly. */
      send: function (from, to, label, opts) {
        opts = opts || {};
        if (!PG.alive(tok)) return Promise.resolve(false);
        const A = actors[from].def, B = actors[to].def;
        const tone = opts.tone || actors[from].def.role;
        const p = h("div", { class: "packet t-" + tone, text: label });
        el.appendChild(p);
        const dur = PG.reducedMotion ? 1 : (opts.dur || 900) / PG.speed;
        let anim;
        try {
          anim = p.animate(
            [{ left: A.x + "%", top: A.y + "%", opacity: 0.2 }, { left: A.x + "%", top: A.y + "%", opacity: 1, offset: 0.08 },
             { left: B.x + "%", top: B.y + "%", opacity: 1 }],
            { duration: dur, easing: "cubic-bezier(.45,.05,.35,1)", fill: "forwards" });
        } catch (e) { anim = null; }
        const done = anim ? anim.finished : PG.sleep(dur);
        return done.then(function () {
          if (opts.stay) setTimeout(function () { p.remove(); }, opts.stay / PG.speed);
          else p.remove();
          if (!PG.alive(tok)) return false;
          api.flash(to);
          return true;
        }, function () { p.remove(); return false; });
      },
      clearPackets: function () { el.querySelectorAll(".packet").forEach(function (p) { p.remove(); }); },
    };
    return api;
  };

  /* ── wire inspector ──────────────────────────────────────────────────── */
  const TAGS = { out: "REQ", in: "RES", evt: "EVENT", note: "NOTE", hook: "WEBHOOK" };
  PG.wire = function (parent, opts) {
    opts = opts || {};
    const list = h("div", { class: "wire-list" });
    const empty = h("div", { class: "wire-empty", text: opts.empty || "Nothing on the wire yet. Run the lab to watch requests and responses appear here." });
    list.appendChild(empty);
    const clearBtn = h("button", { class: "btn small", type: "button", text: "Clear", onclick: function () { api.clear(); } });
    const count = h("span", { class: "chip mono", text: "0" });
    const el = h("div", { class: "wire" },
      h("div", { class: "wire-head" }, h("b", { text: opts.title || "Wire inspector" }), count, h("span", { style: { flex: 1 } }), clearBtn),
      list);
    parent.appendChild(el);
    let n = 0;

    const api = {
      el: el,
      add: function (e) {
        if (empty.parentNode) empty.remove();
        n++;
        count.textContent = String(n);
        const kind = e.kind || "out";
        const color = "var(--" + (e.actor || "client") + ")";
        const status = e.status ? h("span", { class: "chip " + (e.tone || statusTone(e.status)), text: e.status }) : h("span");
        const row = h("button", { class: "wire-row" + (kind === "note" ? " note" : ""), type: "button", "aria-expanded": "false" },
          h("span", { class: "dir", style: { color: color }, text: e.tag || TAGS[kind] || "REQ" }),
          h("span", { class: "lbl", text: e.label || "" }),
          status);
        const detail = h("div", { class: "wire-detail", hidden: true });
        if (e.note) detail.appendChild(h("div", { class: "note-line", html: e.note }));
        if (e.http || e.body !== undefined || e.sse) {
          const msg = e.http ? Object.assign({}, e.http) : {};
          if (e.body !== undefined) msg.body = e.body;
          if (e.sse) msg.sse = e.sse;
          detail.appendChild(h("pre", { class: "code", html: PG.httpHTML(msg, e.hl) }));
        }
        const hasDetail = detail.childNodes.length > 0;
        if (hasDetail) {
          row.addEventListener("click", function () {
            detail.hidden = !detail.hidden;
            row.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
          });
        } else row.style.cursor = "default";
        list.appendChild(row);
        list.appendChild(detail);
        if (e.open && hasDetail) { detail.hidden = false; row.setAttribute("aria-expanded", "true"); }
        list.scrollTop = list.scrollHeight;
        return row;
      },
      clear: function () {
        list.innerHTML = "";
        list.appendChild(empty);
        n = 0;
        count.textContent = "0";
      },
    };
    return api;
  };
  function statusTone(s) {
    s = String(s);
    if (/^2|ok|allow|✓|cached|valid/i.test(s)) return "ok";
    if (/^30/.test(s)) return "info";
    if (/^4|^5|-32|deny|denied|✗|fail|block|reject|error/i.test(s)) return "err";
    return "info";
  }

  /* ── quiz ────────────────────────────────────────────────────────────── */
  PG.quiz = function (parent, lessonId, questions) {
    const wrap = h("div", { class: "quiz" });
    const answers = {};
    questions.forEach(function (q, qi) {
      const name = "q-" + lessonId + "-" + qi;
      const opts = h("div", { class: "q-opts", role: "radiogroup" });
      const why = h("div", { class: "q-why", hidden: true, html: q.why });
      q.opts.forEach(function (o, oi) {
        const input = h("input", { type: "radio", name: name, id: name + "-" + oi, value: String(oi) });
        input.addEventListener("change", function () { answers[qi] = oi; });
        opts.appendChild(h("label", { class: "q-opt", for: name + "-" + oi }, input, h("span", { html: o })));
      });
      wrap.appendChild(h("div", { class: "q", "data-q": qi }, h("div", { class: "q-text", html: (qi + 1) + ". " + q.q }), opts, why));
    });
    const result = h("div", { class: "result", hidden: true, role: "status" });
    const btn = h("button", {
      class: "btn primary", type: "button", text: "Check answers",
      onclick: function () {
        let right = 0;
        questions.forEach(function (q, qi) {
          const box = wrap.querySelector('[data-q="' + qi + '"]');
          box.querySelectorAll(".q-opt").forEach(function (lab, oi) {
            lab.classList.remove("right", "wrong");
            if (oi === q.a) lab.classList.add("right");
            else if (answers[qi] === oi) lab.classList.add("wrong");
          });
          box.querySelector(".q-why").hidden = false;
          if (answers[qi] === q.a) right++;
        });
        result.hidden = false;
        if (right === questions.length) {
          result.className = "result ok";
          result.textContent = "All " + right + " correct. Lesson marked as passed.";
          PG.markDone(lessonId);
        } else {
          result.className = "result warn";
          result.textContent = right + " of " + questions.length + " correct. Read the explanations, then try again.";
        }
      },
    });
    wrap.appendChild(h("div", { class: "row" }, btn, result));
    parent.appendChild(wrap);
    return wrap;
  };

  /* ── rendering ───────────────────────────────────────────────────────── */
  function railHTML(target) {
    PG.tracks.forEach(function (t) {
      const box = h("div", { class: "track" }, h("div", { class: "track-title", text: t.title }));
      PG.lessons.filter(function (l) { return l.track === t.id; }).forEach(function (l) {
        box.appendChild(h("a", { class: "lesson-link", href: "#" + l.id, "data-link": l.id },
          h("span", { class: "dot", "data-dot": l.id, "aria-hidden": "true" }),
          h("span", { text: l.short || l.title })));
      });
      target.appendChild(box);
    });
  }

  function renderLesson(def, main) {
    const idx = PG.lessons.indexOf(def);
    const tr = PG.trackOf(def);
    main.appendChild(h("header", { class: "lesson-head" },
      h("p", { class: "eyebrow", text: tr.title + " · Lesson " + (idx + 1) + " of " + PG.lessons.length }),
      h("h1", { text: def.title }),
      h("p", { class: "thesis", html: def.thesis }),
      def.refs ? h("p", { class: "spec-refs", text: def.refs }) : null));

    const brief = h("article", { class: "brief", html: def.brief || "" });
    const bench = h("div", { class: "bench" });
    main.appendChild(h("div", { class: "lesson-grid" }, brief, bench));

    const api = { tok: PG.session, alive: function () { return PG.alive(api.tok); } };
    try { def.lab(bench, api); } catch (err) {
      console.error(err);
      bench.appendChild(h("div", { class: "result err", text: "This lab failed to load: " + err.message }));
    }

    if (def.quiz && def.quiz.length) {
      const check = h("section", { class: "check" }, h("p", { class: "eyebrow", text: "Check your understanding" }));
      main.appendChild(check);
      PG.quiz(check, def.id, def.quiz);
    }

    const prev = PG.lessons[idx - 1], next = PG.lessons[idx + 1];
    main.appendChild(h("nav", { class: "pager", "aria-label": "Lesson navigation" },
      prev ? h("a", { href: "#" + prev.id }, h("span", { text: "Previous" }), h("b", { text: prev.title })) : h("a", { href: "#home" }, h("span", { text: "Back to" }), h("b", { text: "Overview" })),
      next ? h("a", { class: "next", href: "#" + next.id }, h("span", { text: "Next" }), h("b", { text: next.title })) : null));
  }

  function route() {
    const id = (location.hash || "").replace(/^#/, "") || "home";
    const def = PG.byId[id];
    const main = document.getElementById("pg-main");
    PG.session++;
    main.innerHTML = "";
    const mobile = h("div", { class: "rail-mobile" });
    const det = h("details", {}, h("summary", { text: def ? "Syllabus · " + (def.short || def.title) : "Syllabus" }));
    const inner = h("div", { class: "rail-inner" });
    railHTML(inner);
    det.appendChild(inner);
    mobile.appendChild(det);
    main.appendChild(mobile);

    if (def) { renderLesson(def, main); PG.markSeen(def.id); }
    else if (PG.renderHome) PG.renderHome(main);

    document.querySelectorAll("[data-link]").forEach(function (a) {
      if (a.getAttribute("data-link") === (def ? def.id : "")) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    paintProgress();
    window.scrollTo(0, 0);
  }

  PG.start = function () {
    const rail = document.getElementById("pg-rail");
    if (rail) railHTML(rail);
    const speed = document.getElementById("pg-speed");
    if (speed) {
      speed.appendChild(PG.seg([{ v: 0.5, label: "0.5×" }, { v: 1, label: "1×" }, { v: 2, label: "2×" }], 1,
        function (v) { PG.speed = Number(v); }, "Animation speed"));
    }
    window.addEventListener("hashchange", route);
    route();
  };
})();
