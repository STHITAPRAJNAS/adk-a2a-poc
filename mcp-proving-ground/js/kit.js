/* MCP Proving Ground — small lab helpers shared by the lesson files. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h;

  PG.setResult = function (el, tone, html) { el.className = "result " + tone; el.innerHTML = html; };

  /* Classify cards: items [{t, a, why}], choices ["Tool", "Resource", …]. */
  PG.sorter = function (parent, items, choices, opts) {
    opts = opts || {};
    const grid = h("div", { class: "grid2" });
    let right = 0, answered = 0;
    const score = h("div", { class: "result", text: opts.prompt || "Classify each item." });
    items.forEach(function (it) {
      const why = h("div", { class: "s-why", hidden: true });
      const card = h("div", { class: "sort-card" }, h("div", { class: "s-text", html: it.t }));
      const btns = h("div", { class: "row" });
      choices.forEach(function (choice) {
        btns.appendChild(h("button", { class: "btn small", type: "button", text: choice, onclick: function () {
          if (card.dataset.done) return;
          card.dataset.done = "1";
          answered++;
          const ok = choice === it.a;
          if (ok) right++;
          card.classList.add(ok ? "good" : "bad");
          why.hidden = false;
          why.innerHTML = (ok ? "Right. " : "It's <b>" + it.a + "</b>. ") + it.why;
          score.className = "result " + (answered === items.length ? (right === items.length ? "ok" : "warn") : "");
          score.textContent = right + " of " + answered + " correct" + (answered === items.length ? "." : " so far.");
        } }));
      });
      card.append(btns, why);
      grid.appendChild(card);
    });
    parent.append(grid, score);
    return { grid: grid, score: score };
  };

  /* A numbered checklist whose rows can be marked run / pass / fail. */
  PG.steps = function (parent, texts) {
    const ol = h("ol", { class: "steps" });
    const lis = texts.map(function (t) { const li = h("li", { html: t }); ol.appendChild(li); return li; });
    parent.appendChild(ol);
    return {
      el: ol,
      reset: function () { lis.forEach(function (li) { li.className = ""; }); },
      mark: function (i, cls, html) { lis[i].className = cls || ""; if (html) lis[i].innerHTML = html; },
    };
  };

  /* A labelled key/value list. */
  PG.kv = function (pairs) {
    const dl = h("dl", { class: "kv" });
    pairs.forEach(function (p) { dl.append(h("dt", { text: p[0] }), h("dd", { html: p[1] })); });
    return dl;
  };

  /* A tiny JSON Schema check, enough for the labs' flat tool schemas:
   * type, required, enum, pattern, minimum/maximum, additionalProperties. */
  PG.validateArgs = function (schema, args) {
    const errs = [];
    if (!args || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
    const props = schema.properties || {};
    (schema.required || []).forEach(function (k) { if (!(k in args)) errs.push("missing required argument '" + k + "'"); });
    Object.keys(args).forEach(function (k) {
      const p = props[k], v = args[k];
      if (!p) { if (schema.additionalProperties === false) errs.push("unknown argument '" + k + "'"); return; }
      const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
      if (p.type === "integer" && !(typeof v === "number" && Number.isInteger(v))) errs.push("'" + k + "' must be an integer, got " + JSON.stringify(v));
      else if (p.type && p.type !== "integer" && p.type !== t) errs.push("'" + k + "' must be a " + p.type + ", got " + t);
      if (p.enum && p.enum.indexOf(v) < 0) errs.push("'" + k + "' must be one of " + p.enum.join(", "));
      if (p.pattern && typeof v === "string" && !new RegExp(p.pattern).test(v)) errs.push("'" + k + "' must match " + p.pattern + " (got \"" + v + "\")");
      if (typeof v === "number" && p.minimum !== undefined && v < p.minimum) errs.push("'" + k + "' must be ≥ " + p.minimum);
      if (typeof v === "number" && p.maximum !== undefined && v > p.maximum) errs.push("'" + k + "' must be ≤ " + p.maximum);
    });
    return errs;
  };

  /* Pretty JSON in a <pre>. */
  PG.pre = function (value, hl) {
    return h("pre", { class: "code", html: typeof value === "string" ? PG.esc(value) : PG.jsonHTML(value, hl) });
  };
})();
