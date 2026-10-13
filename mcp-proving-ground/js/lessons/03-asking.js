/* Track 3 — Asking the client: Multi Round-Trip Requests, elicitation,
 * and the deprecated server-to-client features. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  const CONFIRM_SCHEMA = {
    type: "object",
    properties: {
      confirm: { type: "boolean", title: "Roll back checkout-api to 2.13.2 in production?" },
      reason: { type: "string", title: "Reason (goes in the change log)", minLength: 5 },
    },
    required: ["confirm", "reason"],
  };

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Multi Round-Trip Requests
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "mrtr",
    track: "asking",
    title: "Multi Round-Trip Requests: ask, then retry",
    short: "MRTR",
    thesis: "A server that needs something mid-call doesn't call the client back. It ends the request with resultType \"input_required\", listing what it needs and an opaque requestState. The client gathers the answers and sends the same request again, with a new id.",
    refs: "Spec 2026-07-28 · Base protocol › Patterns › Multi Round-Trip Requests · Changelog items 7, 8 (SEP-2322)",
    brief: `
      <h2>The shape</h2>
      <p>Every result now has <code>resultType</code>: <code>"complete"</code> or <code>"input_required"</code> (a missing field, from an old server, means complete). An <strong>InputRequiredResult</strong> carries:</p>
      <ul>
        <li><code>inputRequests</code>: a map from server-chosen keys to requests, each one of <code>elicitation/create</code>, <code>sampling/createMessage</code> or <code>roots/list</code>.</li>
        <li><code>requestState</code>: an opaque string the client echoes back exactly. At least one of the two is present.</li>
      </ul>
      <p>The client answers by <strong>retrying the original request</strong> with a <strong>new JSON-RPC id</strong>, the same params, plus <code>inputResponses</code> (same keys) and the <code>requestState</code>. Each attempt is a complete, independent request, so the retry can reach a different replica.</p>
      <p>Only <code>tools/call</code>, <code>resources/read</code> and <code>prompts/get</code> may answer <code>input_required</code>.</p>
      <div class="note spec"><span class="note-label">Spec · requestState</span>It travels through the client, so the server MUST treat it as attacker-controlled. If it affects authorization or business logic, protect its integrity (HMAC or AEAD) and reject anything that fails. It SHOULD bind the caller, a short expiry and a digest of the original request. That still isn't single-use: enforce one-time actions server-side.</div>
      <div class="note"><span class="note-label">Rules for clients</span>Never parse or change <code>requestState</code>. Don't send one if none was given. Use the inputs only for this retry. If the server didn't ask for inputs (only <code>requestState</code>), it may simply want you to come back: retry immediately.</div>
      <div class="note"><span class="note-label">Legacy era</span>Before 2026-07-28, the server sent <code>elicitation/create</code> as a JSON-RPC <em>request</em> on the open stream and waited, holding state in memory on one replica. MRTR replaced that.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Roll back with a confirmation", "Lab · input_required · inputResponses · requestState");
      let mode = "ok";
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "You", sub: "alice", x: 12, y: 18 },
          { id: "client", role: "client", label: "Host + client", sub: "ops-console", x: 14, y: 72, glyph: "H" },
          { id: "ra", role: "server", label: "replica A", sub: "", x: 84, y: 22 },
          { id: "rb", role: "server", label: "replica B", sub: "", x: 84, y: 78 },
        ],
        links: [["user", "client"], ["client", "ra"], ["client", "rb"]],
      });
      const wire = PG.wire(a.body);
      const steps = PG.steps(a.body, [
        "tools/call id 1 → replica A",
        "replica A answers <code>input_required</code> with a form and a signed requestState",
        "the host shows you the form; you answer",
        "tools/call id 2 → replica B, with inputResponses + requestState",
        "replica B verifies the state, then completes",
      ]);
      const verdict = h("div", { class: "result", text: "Pick how the client behaves on the retry, then run." });
      const args = { service: "checkout-api", to_version: "2.13.2" };
      const run = h("button", { class: "btn primary", type: "button", text: "Run" });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([
          { v: "ok", label: "Correct client" }, { v: "edit", label: "Client edits requestState" },
          { v: "args", label: "Retry with other arguments" }, { v: "bob", label: "Bob replays it" }, { v: "late", label: "Retry 20 min later" },
        ], "ok", function (v) { mode = v; }, "Retry behaviour"), run), verdict), stage.el);
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); steps.reset();
        steps.mark(0, "run");
        const req1 = SPEC.rpc("tools/call", { name: "rollback_release", arguments: args }, 1);
        if (!(await stage.send("client", "ra", "tools/call id 1"))) return;
        wire.add({ actor: "client", label: "tools/call · id 1 · rollback_release", http: SPEC.post("tools/call", "rollback_release"), body: req1 });
        steps.mark(0, "pass"); steps.mark(1, "run");
        const state = SPEC.requestState({ sub: "alice", exp: "+5m", req: "tools/call:rollback_release:" + PG.hex(4) });
        const irr = SPEC.ok(1, { resultType: "input_required", inputRequests: { confirm_rollback: { method: "elicitation/create", params: { mode: "form", message: "Production rollback needs a confirmation.", requestedSchema: CONFIRM_SCHEMA } } }, requestState: state });
        await stage.send("ra", "client", "input_required", { tone: "proxy" });
        wire.add({ kind: "in", actor: "server", label: "input_required · confirm_rollback", status: "input_required", http: SPEC.res(200), body: irr, hl: ["resultType", "inputRequests", "requestState"], open: true,
          note: "Request 1 is <b>finished</b>. Replica A keeps nothing in memory: everything it needs later is inside requestState, signed." });
        steps.mark(1, "pass"); steps.mark(2, "run");
        await stage.send("client", "user", "confirm?");
        stage.badge("user", "✓ reason: error rate 4.7%");
        await PG.sleep(600);
        await stage.send("user", "client", "accept");
        stage.badge("user", null);
        steps.mark(2, "pass"); steps.mark(3, "run");
        const resp = { confirm_rollback: { action: "accept", content: { confirm: true, reason: "error rate 4.7% after 2.14.0" } } };
        let sent = state, sendArgs = args, who = "alice";
        if (mode === "edit") sent = "TAMPERED" + state.slice(8);
        if (mode === "args") sendArgs = { service: "checkout-api", to_version: "2.10.0" };
        if (mode === "bob") who = "bob";
        const req2 = SPEC.rpc("tools/call", { name: "rollback_release", arguments: sendArgs, inputResponses: resp, requestState: sent }, 2);
        if (!(await stage.send("client", "rb", "tools/call id 2"))) return;
        wire.add({ actor: "client", label: "tools/call · id 2 · retry" + (who === "bob" ? " (Bob's token)" : ""), http: SPEC.post("tools/call", "rollback_release", { Authorization: "Bearer <" + who + "'s token>" }), body: req2, hl: ["inputResponses", "requestState", "arguments"] });
        steps.mark(3, "pass"); steps.mark(4, "run");
        await PG.sleep(300);
        const fail = { edit: "requestState failed integrity check", args: "requestState was issued for different arguments", bob: "requestState was issued to a different principal", late: "requestState expired" }[mode];
        if (fail) {
          await stage.send("rb", "client", "-32602", { tone: "err" });
          wire.add({ kind: "in", actor: "server", label: "-32602 " + fail, status: "-32602", http: SPEC.res(200), body: SPEC.err(2, -32602, "Invalid params: " + fail), open: true });
          steps.mark(4, "fail");
          PG.setResult(verdict, "ok", {
            edit: "Rejected. The MAC no longer matched, so the server can't trust anything in the state.",
            args: "Rejected. The state carried a digest of the original call; replaying your confirmation for a <b>different</b> version doesn't match.",
            bob: "Rejected. The state was bound to Alice; Bob can't reuse her confirmation even if he got hold of it.",
            late: "Rejected. The state had a 5-minute expiry. The client should start the call over, without a requestState, and ask again.",
          }[mode] + " This is the server doing its job.");
        } else {
          await stage.send("rb", "client", "complete");
          wire.add({ kind: "in", actor: "server", label: "complete · rolled back", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { content: [{ type: "text", text: "checkout-api rolled back to 2.13.2. Change log: error rate 4.7% after 2.14.0" }], isError: false }), hl: ["resultType"] });
          steps.mark(4, "pass");
          PG.setResult(verdict, "ok", "Two independent requests, two different replicas, and no server memory in between. Replica B had never seen request 1.");
        }
        run.disabled = false;
      });

      const b = PG.lab(bench, "The client didn't declare elicitation", "Lab · capabilities per request · -32021");
      let caps = false;
      const bw = PG.wire(b.body, { title: "Wire" });
      const bout = h("div", { class: "result", text: "Capabilities are per request now. Toggle elicitation and call the tool." });
      b.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" },
        PG.switch("mrtr-caps", "clientCapabilities.elicitation", false, function (v) { caps = v; }),
        h("button", { class: "btn primary", type: "button", text: "tools/call rollback_release", onclick: function () {
          const c = caps ? { elicitation: { form: {} } } : {};
          bw.add({ actor: "client", label: "tools/call · caps " + JSON.stringify(c), http: SPEC.post("tools/call", "rollback_release"), body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: args }, 7, { caps: c }), hl: [SPEC.K.caps] });
          if (!caps) {
            bw.add({ kind: "in", actor: "server", label: "-32021 MissingRequiredClientCapability", status: "-32021", http: SPEC.res(400), body: SPEC.err(7, -32021, "Missing required client capability", { requiredCapabilities: { elicitation: { form: {} } } }), open: true });
            PG.setResult(bout, "warn", "The server MUST NOT send an elicitation request the client can't handle. It can't proceed without a confirmation, so it says which capability it needs.");
          } else {
            bw.add({ kind: "in", actor: "server", label: "input_required · confirm_rollback", status: "input_required", http: SPEC.res(200), body: SPEC.ok(7, { resultType: "input_required", inputRequests: { confirm_rollback: { method: "elicitation/create", params: { mode: "form", message: "Production rollback needs a confirmation.", requestedSchema: CONFIRM_SCHEMA } } }, requestState: SPEC.requestState({ sub: "alice" }) }) });
            PG.setResult(bout, "ok", "Declared, so the server may ask.");
          }
        } })), bout), bw.el);
    },
    quiz: [
      { q: "How does the client answer an InputRequiredResult?",
        opts: ["It sends an elicitation/result notification", "It retries the original request with a new id, adding inputResponses and the unchanged requestState", "It reuses the same id so the server can match it", "It opens a GET stream"],
        a: 1, why: "A retry is a new, independent request: new id, same params, plus inputResponses and requestState." },
      { q: "Which requests may answer input_required?",
        opts: ["Any request", "tools/call, resources/read and prompts/get", "Only tools/call", "tools/list and tools/call"],
        a: 1, why: "Those three. Servers MUST NOT return InputRequiredResult for any other request." },
      { q: "What should a server put inside requestState when it gates a destructive action?",
        opts: ["Nothing: it's the client's data", "The caller's identity, an expiry and a digest of the original request, integrity-protected", "The user's password", "The JSON-RPC id"],
        a: 1, why: "requestState is attacker-controlled input; bind it to principal, time and request, and verify it." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Elicitation
   * ════════════════════════════════════════════════════════════════════ */
  function renderForm(schema, onSubmit) {
    const box = h("div", { class: "stack" });
    const vals = {};
    Object.keys(schema.properties).forEach(function (k) {
      const p = schema.properties[k];
      let input;
      if (p.type === "boolean") { input = h("input", { type: "checkbox", id: "el-" + k }); input.checked = !!p.default; vals[k] = function () { return input.checked; }; }
      else if (p.oneOf || p.enum) {
        const opts = p.oneOf ? p.oneOf.map(function (o) { return { v: o.const, label: o.title }; }) : p.enum.map(function (e) { return { v: e, label: e }; });
        input = PG.select("el-" + k, opts, p.default || opts[0].v, function () {});
        vals[k] = function () { return input.value; };
      } else if (p.type === "array") {
        const opts = (p.items.anyOf || p.items.enum.map(function (e) { return { const: e, title: e }; }));
        const checks = opts.map(function (o) { const c = h("input", { type: "checkbox", id: "el-" + k + "-" + o.const }); c.checked = (p.default || []).indexOf(o.const) >= 0; return { c: c, v: o.const, t: o.title }; });
        input = h("div", { class: "row" }, checks.map(function (x) { return h("label", { class: "switch", for: x.c.id }, x.c, x.t); }));
        vals[k] = function () { return checks.filter(function (x) { return x.c.checked; }).map(function (x) { return x.v; }); };
      } else {
        input = h("input", { class: "inline", id: "el-" + k, type: p.format === "email" ? "email" : p.type === "number" || p.type === "integer" ? "number" : p.format === "date" ? "date" : "text", style: { width: "220px" } });
        if (p.default !== undefined) input.value = p.default;
        vals[k] = function () { return p.type === "number" || p.type === "integer" ? Number(input.value) : input.value; };
      }
      box.appendChild(h("label", { class: "field", for: "el-" + k }, h("span", { text: (p.title || k) + ((schema.required || []).indexOf(k) >= 0 ? " *" : "") + (p.format ? " (" + p.format + ")" : "") }), input));
    });
    const collect = function () { const o = {}; Object.keys(vals).forEach(function (k) { o[k] = vals[k](); }); return o; };
    box.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", type: "button", text: "Accept", onclick: function () { onSubmit({ action: "accept", content: collect() }); } }),
      h("button", { class: "btn", type: "button", text: "Decline", onclick: function () { onSubmit({ action: "decline" }); } }),
      h("button", { class: "btn", type: "button", text: "Cancel", onclick: function () { onSubmit({ action: "cancel" }); } })));
    return box;
  }

  PG.lesson({
    id: "elicitation",
    track: "asking",
    title: "Elicitation: a form, or a link",
    short: "Elicitation",
    thesis: "Elicitation is how a server asks the user for something. Form mode sends a small flat schema the host renders as a form; URL mode sends a link the user opens outside the client, for anything sensitive. Either way the host shows who is asking and the user can say no.",
    refs: "Spec 2026-07-28 · Client features › Elicitation · MRTR",
    brief: `
      <h2>Form mode</h2>
      <p><code>elicitation/create</code> with <code>mode: "form"</code> (or no mode), a <code>message</code>, and a <code>requestedSchema</code>: a flat object whose properties are only primitives: strings (formats <code>email</code>, <code>uri</code>, <code>date</code>, <code>date-time</code>), numbers, booleans, single-select enums (optionally with titles via <code>oneOf</code>/<code>const</code>/<code>title</code>) and multi-select arrays. Defaults are allowed.</p>
      <p>The answer is <code>{action: "accept", content}</code>, <code>{action: "decline"}</code> or <code>{action: "cancel"}</code> (dismissed without choosing). Servers must handle all three.</p>
      <div class="note trap"><span class="note-label">Never in a form</span>Servers MUST NOT use form mode for passwords, API keys, tokens or payment details. The answer would pass through the client and the model's context.</div>
      <h2>URL mode</h2>
      <p><code>mode: "url"</code>, a <code>message</code> and a <code>url</code>. The user opens it in a browser and deals with the server (or a third party) directly. <code>accept</code> only means "I agreed to open it"; the client learns the outcome by retrying the original request.</p>
      <ul>
        <li>Use it for secrets, payments, and authorizing the server to a <em>third-party</em> API. Never to authorize the client to the MCP server itself: that's MCP authorization.</li>
        <li>Clients MUST show the full URL, MUST NOT prefetch or open it without consent, and SHOULD highlight the domain.</li>
        <li>Servers MUST NOT put user data or pre-authenticated links in the URL, and MUST check that whoever opens the link is the user who was asked.</li>
      </ul>
      <p>Capability: <code>elicitation: {form: {}, url: {}}</code>; an empty <code>elicitation: {}</code> means form only.</p>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Be the host: render what the server asks", "Lab · form · decline · cancel · sensitive data");
      const cases = {
        rollback: { message: "Production rollback needs a confirmation.", requestedSchema: CONFIRM_SCHEMA },
        window: { message: "When should the rollout run?", requestedSchema: { type: "object", properties: {
          date: { type: "string", format: "date", title: "Day" },
          window: { type: "string", title: "Window", oneOf: [{ const: "night", title: "Night (01–05 UTC)" }, { const: "day", title: "Business hours" }], default: "night" },
          regions: { type: "array", title: "Regions", items: { anyOf: [{ const: "eu-west1", title: "EU" }, { const: "us-east1", title: "US" }, { const: "ap-south1", title: "Asia" }] }, default: ["eu-west1"] },
          notify: { type: "string", format: "email", title: "Notify" },
        }, required: ["date", "window"] } },
        secret: { message: "Paste your deploy API key to continue.", requestedSchema: { type: "object", properties: { api_key: { type: "string", title: "Deploy API key" } }, required: ["api_key"] } },
      };
      let which = "rollback";
      const panel = h("div", { class: "stack" });
      const wire = PG.wire(a.body);
      const verdict = h("div", { class: "result", text: "Pick what the server asks for." });
      function show() {
        panel.innerHTML = "";
        wire.clear();
        const c = cases[which];
        const ir = SPEC.ok(1, { resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: Object.assign({ mode: "form" }, c) } }, requestState: SPEC.requestState({ sub: "alice" }) });
        wire.add({ kind: "in", actor: "server", label: "input_required · elicitation/create (form)", status: "input_required", http: SPEC.res(200), body: ir, hl: ["requestedSchema"] });
        const looksSecret = /key|password|token|secret|card/i.test(JSON.stringify(c.requestedSchema));
        const card = h("div", { class: "bubble gate" },
          h("b", { text: "release-tools (release-tools.internal) asks:" }),
          h("div", { text: c.message }));
        if (looksSecret) {
          card.appendChild(h("div", { class: "result err", html: "This form asks for a credential. Servers must not request secrets in form mode; this host refuses to show the field." }));
          card.appendChild(h("div", { class: "row" }, h("button", { class: "btn", type: "button", text: "Decline", onclick: function () { answer({ action: "decline" }); } })));
          PG.setResult(verdict, "warn", "A careful host notices a field that looks like a secret and declines. The right way is URL mode: the key goes straight to the server's own page.");
        } else {
          card.appendChild(renderForm(c.requestedSchema, answer));
          PG.setResult(verdict, "", "The host names the server and shows the message. Answer, decline or cancel.");
        }
        panel.appendChild(card);
      }
      function answer(r) {
        wire.add({ actor: "client", label: "tools/call retry · " + r.action, http: SPEC.post("tools/call", "rollback_release"), body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" }, inputResponses: { q: r }, requestState: "<echoed unchanged>" }, 2), hl: ["inputResponses"], open: true });
        const req = cases[which].requestedSchema.required || [];
        const missing = r.action === "accept" ? req.filter(function (k) { const v = r.content[k]; return v === "" || v === undefined || (k === "confirm" && v === false); }) : [];
        if (r.action === "accept" && missing.length) {
          wire.add({ kind: "in", actor: "server", label: "input_required again · missing " + missing.join(", "), status: "input_required", http: SPEC.res(200), body: SPEC.ok(2, { resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: Object.assign({ mode: "form" }, cases[which]) } }, requestState: SPEC.requestState({ sub: "alice", n: 2 }) }) });
          PG.setResult(verdict, "warn", "Required answers were missing, so the server asked again with a new input_required, rather than failing.");
        } else if (r.action === "accept") {
          wire.add({ kind: "in", actor: "server", label: "complete", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { content: [{ type: "text", text: "Done with: " + JSON.stringify(r.content) }], isError: false }) });
          PG.setResult(verdict, "ok", "Accepted. Content matched the schema; the server validated it again on its side.");
        } else {
          wire.add({ kind: "in", actor: "server", label: "complete · isError: user " + r.action + "d", status: "isError", tone: "warn", http: SPEC.res(200), body: SPEC.ok(2, { content: [{ type: "text", text: "Rollback not performed: the user " + (r.action === "decline" ? "declined" : "dismissed the request") + "." }], isError: true }) });
          PG.setResult(verdict, "info", r.action === "decline" ? "<b>decline</b>: the user said no. The server stops and says so; the model can explain." : "<b>cancel</b>: the user closed the dialog without deciding. Treat it like no, but you might ask again later.");
        }
      }
      a.body.insertBefore(h("div", { class: "stack" }, PG.seg([{ v: "rollback", label: "Confirm a rollback" }, { v: "window", label: "Pick a rollout window" }, { v: "secret", label: "Ask for an API key (wrong)" }], "rollback", function (v) { which = v; show(); }, "Request"), panel, verdict), wire.el);
      show();

      const b = PG.lab(bench, "URL mode: connect the deploy API", "Lab · out-of-band · consent · phishing");
      let fwd = false;
      const stage = PG.stage(b.body, {
        actors: [
          { id: "user", role: "user", label: "Alice", sub: "browser", x: 12, y: 20 },
          { id: "client", role: "client", label: "Host + client", sub: "", x: 12, y: 80, glyph: "H" },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 56, y: 80 },
          { id: "third", role: "auth", label: "Deploy API login", sub: "third party", x: 88, y: 20 },
          { id: "mallory", role: "attacker", label: "Mallory", sub: "", x: 56, y: 20 },
        ],
        links: [["user", "client"], ["client", "server"], ["user", "server"], ["server", "third"], ["user", "third"], ["mallory", "user"]],
      });
      const bwire = PG.wire(b.body, { title: "Wire" });
      const bres = h("div", { class: "result", text: "release-tools needs its own access to the deploy API on Alice's behalf." });
      const consent = h("div", { class: "stack" });
      async function go() {
        bwire.clear(); consent.innerHTML = "";
        const url = "https://release-tools.internal/connect/deploy-api?req=" + PG.hex(6);
        await stage.send("client", "server", "tools/call");
        await stage.send("server", "client", "input_required (url)", { tone: "proxy" });
        bwire.add({ kind: "in", actor: "server", label: "input_required · elicitation/create (url)", status: "input_required", http: SPEC.res(200),
          body: SPEC.ok(1, { resultType: "input_required", inputRequests: { connect: { method: "elicitation/create", params: { mode: "url", message: "Connect release-tools to the deploy API.", url: url } } }, requestState: SPEC.requestState({ sub: "alice", connect: true }) }), hl: ["url", "mode"] });
        const u = new URL(url);
        consent.appendChild(h("div", { class: "bubble gate" },
          h("b", { text: "release-tools wants you to open a link" }),
          h("div", { class: "mono small", html: u.protocol + "//<b style='font-size:1.15em'>" + u.hostname + "</b>" + PG.esc(u.pathname + u.search) }),
          h("div", { class: "small", text: "Not opened yet. Nothing was prefetched." }),
          h("div", { class: "row" },
            h("button", { class: "btn primary", type: "button", text: "Open in browser", onclick: async function () {
              consent.innerHTML = "";
              const opener = fwd ? "mallory" : "user";
              if (fwd) { await stage.send("user", "mallory", "link (phished)", { tone: "err" }); }
              await stage.send(opener, "server", "GET " + u.pathname, { tone: fwd ? "err" : "user" });
              if (fwd) {
                bwire.add({ kind: "note", label: "Mallory opened Alice's link while signed in as Mallory. The server's page checks: the signed-in user is not the user the elicitation was created for → refused." });
                PG.setResult(bres, "ok", "The server MUST verify that whoever completes the URL flow is the user who was asked. Otherwise Mallory's deploy-API account gets bound to Alice's server identity.");
                return;
              }
              await stage.send("server", "user", "redirect to login");
              await stage.send("user", "third", "sign in + consent");
              await stage.send("third", "server", "code → token (kept by server)");
              stage.badge("server", "deploy-API token stored for alice");
              await stage.send("client", "server", "retry + requestState");
              await stage.send("server", "client", "complete");
              bwire.add({ actor: "client", label: "tools/call retry · inputResponses.connect = accept", http: SPEC.post("tools/call", "rollback_release"), body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" }, inputResponses: { connect: { action: "accept" } }, requestState: "<echoed unchanged>" }, 2), hl: ["inputResponses"] });
              bwire.add({ kind: "in", actor: "server", label: "complete", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { content: [{ type: "text", text: "checkout-api rolled back to 2.13.2" }], isError: false }) });
              PG.setResult(bres, "ok", "The deploy-API token went from the third party to the server and stayed there. The client and the model never saw it, and the client's own MCP token was not used for the deploy API.");
            } }),
            h("button", { class: "btn", type: "button", text: "Decline", onclick: function () { consent.innerHTML = ""; PG.setResult(bres, "info", "Declined: nothing opened, nothing sent."); } }))));
      }
      b.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", text: "Call the tool", onclick: go }),
        PG.switch("el-phish", "Alice forwards the link to “IT support” (Mallory)", false, function (v) { fwd = v; })), consent, bres), stage.el);
    },
    quiz: [
      { q: "A server needs the user's deploy API key. Which mode?",
        opts: ["Form mode with a password field", "URL mode: the user enters it on the server's own page", "Sampling", "Put it in requestState"],
        a: 1, why: "Secrets must not go through form mode. URL mode keeps them out of the client and the model." },
      { q: "The user closes the dialog without choosing. What action does the client send?",
        opts: ["decline", "cancel", "reject", "Nothing"],
        a: 1, why: "cancel = dismissed without an explicit choice; decline = explicitly said no." },
      { q: "In URL mode, what does <code>action: \"accept\"</code> tell the server?",
        opts: ["The flow completed successfully", "The user consented to open the URL; the outcome is checked when the client retries", "The user typed the value", "The URL was prefetched"],
        a: 1, why: "accept means consent to the out-of-band interaction, not its completion." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Deprecated — sampling, roots, logging
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "deprecated",
    track: "asking",
    title: "Sampling, roots and logging: still here, on the way out",
    short: "Deprecated features",
    thesis: "Sampling (the server borrows the client's model), roots (the client tells the server its folders) and logging (the server streams log lines) are deprecated in 2026-07-28. They still work for at least twelve months; new code should use the replacements.",
    refs: "Spec 2026-07-28 · Deprecated features registry · Client › Sampling · Roots · Server utilities › Logging (SEP-2577, SEP-2596)",
    brief: `
      <h2>What each one did, and what to use now</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Feature</th><th>How it travels now</th><th>Use instead</th></tr></thead><tbody>
        <tr><td><strong>Sampling</strong>: server asks the client's model for a completion</td><td><code>sampling/createMessage</code> inside <code>inputRequests</code>; client capability <code>sampling</code> (<code>sampling.tools</code> for tool use)</td><td>Call an LLM provider API directly from the server</td></tr>
        <tr><td><strong>Roots</strong>: client lists the folders the server should focus on</td><td><code>roots/list</code> inside <code>inputRequests</code>; capability <code>roots</code>. <code>notifications/roots/list_changed</code> is removed</td><td>Pass paths as tool arguments, resource URIs or server configuration</td></tr>
        <tr><td><strong>Logging</strong>: server sends log lines to the client</td><td><code>notifications/message</code> on the response stream, only for requests whose <code>_meta</code> sets <code>io.modelcontextprotocol/logLevel</code>. <code>logging/setLevel</code> is removed</td><td>stderr on stdio; OpenTelemetry for remote servers</td></tr>
      </tbody></table></div>
      <div class="note spec"><span class="note-label">Spec</span>Deprecated means: still part of the spec, still working, removed no sooner than twelve months after this revision. New implementations SHOULD NOT adopt them. Also deprecated: <code>includeContext</code> values <code>thisServer</code>/<code>allServers</code>, the old HTTP+SSE transport, and Dynamic Client Registration.</div>
      <p>Sampling deserves a human in the loop: the host SHOULD let the user see and edit the prompt and review the completion, because the server is spending the user's model on its own text. Roots were never access control: the protocol doesn't enforce them.</p>
      <p>Log levels follow syslog: debug, info, notice, warning, error, critical, alert, emergency. Log lines MUST NOT contain secrets or personal data.</p>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "The same request, three ways a server can ask", "Lab · sampling · roots · logLevel");
      let which = "sampling";
      const wire = PG.wire(a.body);
      const verdict = h("div", { class: "result" });
      const cases = {
        sampling: {
          caps: { sampling: {} },
          ir: { summary: { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Summarise these 400 log lines in 3 bullets: …" } }], maxTokens: 200, modelPreferences: { intelligencePriority: 0.3, speedPriority: 0.8 } } } },
          resp: { summary: { role: "assistant", content: { type: "text", text: "• payment timeouts from 10:02 • retries near budget • no data loss" }, model: "host-default-model", stopReason: "endTurn" } },
          note: "The server borrowed your model to summarise. Today it should call a model API itself; the host shouldn't have to pay for, and review, the server's prompts.",
        },
        roots: {
          caps: { roots: {} },
          ir: { where: { method: "roots/list" } },
          resp: { where: { roots: [{ uri: "file:///home/alice/src/checkout-api", name: "checkout-api" }] } },
          note: "The server asked which folders to look at. Today the tool would take <code>repo_path</code> as an argument, or be configured with it.",
        },
        logging: { caps: {}, note: "Log lines arrive only because this request set <code>logLevel</code> in <code>_meta</code>, and only on this request's own response stream. Today: stderr or OpenTelemetry." },
      };
      function run() {
        wire.clear();
        const c = cases[which];
        if (which === "logging") {
          wire.add({ actor: "client", label: "tools/call · logLevel: info", http: SPEC.post("tools/call", "check_release_readiness"), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, 1, { log: "info" }), hl: [SPEC.K.log] });
          wire.add({ kind: "in", actor: "server", label: "200 · text/event-stream", status: "200", http: SPEC.res(200, "sse"), sse: [
            SPEC.notif("notifications/message", { level: "info", logger: "readiness", data: { step: "ci", ok: true } }),
            SPEC.notif("notifications/message", { level: "warning", logger: "readiness", data: { step: "changelog", note: "entry is short" } }),
            SPEC.ok(1, { content: [{ type: "text", text: "{\"ready\":true}" }], structuredContent: { ready: true, checks: ["ci", "changelog"], blockers: [] }, isError: false }),
          ] });
          PG.setResult(verdict, "info", c.note);
          return;
        }
        const id1 = 1;
        wire.add({ actor: "client", label: "tools/call · caps " + JSON.stringify(c.caps), http: SPEC.post("tools/call", "check_release_readiness"), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, id1, { caps: c.caps }), hl: [SPEC.K.caps] });
        wire.add({ kind: "in", actor: "server", label: "input_required · " + Object.values(c.ir)[0].method, status: "input_required", http: SPEC.res(200), body: SPEC.ok(id1, { resultType: "input_required", inputRequests: c.ir, requestState: SPEC.requestState({ n: 1 }) }), hl: ["inputRequests"] });
        wire.add({ actor: "client", label: "tools/call retry · inputResponses", http: SPEC.post("tools/call", "check_release_readiness"), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" }, inputResponses: c.resp, requestState: "<echoed unchanged>" }, 2, { caps: c.caps }), hl: ["inputResponses"] });
        wire.add({ kind: "in", actor: "server", label: "complete", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { content: [{ type: "text", text: "ready" }], isError: false }) });
        PG.setResult(verdict, "warn", c.note);
      }
      a.body.insertBefore(h("div", { class: "stack" }, PG.seg([{ v: "sampling", label: "Sampling" }, { v: "roots", label: "Roots" }, { v: "logging", label: "Logging" }], "sampling", function (v) { which = v; run(); }, "Feature"), verdict), wire.el);
      run();

      const b = PG.lab(bench, "Legacy era: the server called the client", "Lab · what MRTR replaced");
      const bw = PG.wire(b.body, { title: "Wire · 2025-11-25" });
      bw.add({ actor: "client", label: "POST tools/call (id 1), Mcp-Session-Id: sess-41c2", http: SPEC.post(null, null, { "Mcp-Session-Id": "sess-41c2" }, { legacy: true }), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, 1, { noMeta: true }) });
      bw.add({ kind: "evt", actor: "server", label: "SSE: server REQUEST sampling/createMessage (id 90)", http: SPEC.res(200, "sse"), sse: [{ jsonrpc: "2.0", id: 90, method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Summarise…" } }], maxTokens: 200 } }] });
      bw.add({ actor: "client", label: "POST response to id 90 (must reach the same replica)", http: SPEC.post(null, null, { "Mcp-Session-Id": "sess-41c2" }, { legacy: true }), body: { jsonrpc: "2.0", id: 90, result: { role: "assistant", content: { type: "text", text: "…" }, model: "m" } } });
      bw.add({ kind: "evt", actor: "server", label: "SSE: result for id 1", sse: [SPEC.ok(1, { content: [{ type: "text", text: "ready" }] }, { legacy: true })] });
      b.body.appendChild(h("div", { class: "result info", html: "The server held request 1 open in memory while it waited for the answer to its own request 90. If the client's answer reached another replica, or the stream dropped, the work was lost. MRTR turns this into two independent requests." }));
    },
    quiz: [
      { q: "A new server needs an LLM summary of logs. What should it do in 2026-07-28?",
        opts: ["Use sampling/createMessage", "Call an LLM provider API itself", "Send logging notifications", "Ask for roots"],
        a: 1, why: "Sampling is deprecated; the suggested migration is to integrate with model APIs directly." },
      { q: "When may a server send notifications/message?",
        opts: ["Any time on the subscription stream", "Only on the response stream of a request whose _meta set io.modelcontextprotocol/logLevel", "After logging/setLevel", "Never"],
        a: 1, why: "Logging is per request now; logging/setLevel is gone and log lines never go on subscriptions/listen." },
      { q: "Are roots an access-control mechanism?",
        opts: ["Yes: servers can't leave them", "No: they're guidance the protocol doesn't enforce", "Only on stdio", "Only with OAuth"],
        a: 1, why: "Roots are informational. Enforce access on the server." },
    ],
  });
})();
