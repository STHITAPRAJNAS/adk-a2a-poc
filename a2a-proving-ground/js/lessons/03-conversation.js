/* Track 3 — Conversation: skills, messages & artifacts, the task lifecycle,
 * and the three delivery mechanisms. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Skills
   * ════════════════════════════════════════════════════════════════════ */
  const PRESETS = [
    "Is checkout-api 2.14.0 ready for production?",
    "Run the compliance scan for billing-worker",
    "Deploy checkout-api 2.14.0 to production",
    "Deploy search-indexer 0.9.1 to staging",
    "What's the weather in Oslo tomorrow?",
  ];
  /* A deliberately simple stand-in for the agent's own reasoning. Real agents
   * use an LLM; the point is that this happens inside the agent, not on the wire. */
  function route(text) {
    const t = text.toLowerCase();
    const skills = PG.cards.release.skills;
    const scores = skills.map(function (s) {
      const words = (s.tags.join(" ") + " " + s.name + " " + s.id.replace(/_/g, " ")).toLowerCase().split(/\W+/).filter(function (w) { return w.length > 3; });
      let sc = 0;
      words.forEach(function (w) { if (t.indexOf(w) >= 0) sc += 1; });
      return { id: s.id, score: sc };
    });
    let plan = [];
    if (/deploy|roll ?out|release .* to/.test(t)) {
      plan = ["release_readiness", "compliance_scan"];
      if (/prod/.test(t)) plan.push("human_change_approval");
      plan.push("deployment_execution");
    } else if (/ready|readiness/.test(t)) plan = ["release_readiness"];
    else if (/scan|compliance|soc2|pci/.test(t)) plan = ["compliance_scan"];
    plan.forEach(function (id) { scores.find(function (s) { return s.id === id; }).score += 3; });
    const max = Math.max.apply(null, scores.map(function (s) { return s.score; }).concat([1]));
    return { plan: plan, scores: scores.map(function (s) { return { id: s.id, score: s.score, pct: Math.round((100 * s.score) / max) }; }) };
  }

  PG.lesson({
    id: "skills",
    track: "conversation",
    title: "Skills are a menu, not an API",
    short: "Skills",
    thesis: "A skill is advertised in the card so clients can decide whether an agent fits. It is not an endpoint. There is no invokeSkill method and no skillId field: the client sends a message, and the agent decides which of its skills apply.",
    refs: "Spec §4.4.5 AgentSkill · §4.1.4 Message · §7.5 authorization · topic: a2a-and-mcp",
    brief: `
      <h2>What a skill is</h2>
      <p><code>AgentSkill</code> has <code>id</code>, <code>name</code>, <code>description</code>, <code>tags</code> (all required), plus <code>examples</code>, <code>inputModes</code>, <code>outputModes</code> and per-skill <code>securityRequirements</code>. Registries index skills; LLM routers read descriptions and examples to pick an agent.</p>
      <h2>What a skill is not</h2>
      <p>Look at the wire. <code>SendMessageRequest</code> carries <code>message</code>, <code>configuration</code>, <code>metadata</code> and an optional <code>tenant</code>. <code>Message</code> carries <code>role</code>, <code>parts</code>, <code>messageId</code>, <code>contextId</code>, <code>taskId</code>, <code>referenceTaskIds</code>, <code>extensions</code>, <code>metadata</code>. <strong>Nothing names a skill.</strong></p>
      <p>Think of it as a restaurant: the skills list is the <em>menu</em>, the message is the <em>order</em> in plain words, and the agent is the <em>kitchen</em> that decides which dishes to cook. There is no per-dish API.</p>
      <div class="note spec"><span class="note-label">Spec</span>Servers MAY consider the “specific skills requested” when authorizing (§7.5). That means the skill the agent <em>infers</em> it will use. A skill can also carry its own <code>securityRequirements</code>, e.g. deploy needs <code>deploy:write</code>.</div>
      <h2>If you need typed operations</h2>
      <p>Named, schema-typed calls are what <strong>MCP tools</strong> are for. A2A deliberately keeps the agent boundary as message-in, task-out. A hint such as a preferred skill can ride in <code>metadata</code>, but only as an agreed convention, ideally a declared extension.</p>
      <div class="note ours"><span class="note-label">In this repo</span>The deployment agent advertises four skills, yet the concierge only ever sends “deploy checkout-api 2.14.0 to production”. The agent's LLM chooses to call readiness, then scan, then approval, then execution.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Order in plain words, watch the kitchen decide", "Lab · menu · order · kitchen");
      const menu = h("div", { class: "grid2" });
      const skillEls = {};
      PG.cards.release.skills.forEach(function (s) {
        const bar = h("i");
        const el = h("div", { class: "skill" }, h("span", { class: "skill-name", text: s.name }), h("span", { class: "skill-id", text: s.id }),
          h("span", { class: "skill-desc", text: s.description }), h("div", { class: "meter" }, bar));
        el.bar = bar;
        skillEls[s.id] = el;
        menu.appendChild(el);
      });
      const input = h("input", { class: "inline", id: "skill-input", type: "text", value: PRESETS[2], style: { flex: "1 1 260px" }, "aria-label": "Request" });
      const send = h("button", { class: "btn primary", type: "button", text: "Send message" });
      const verdict = h("div", { class: "result", text: "Send a request. The message will name no skill; see which ones the agent picks." });
      const wire = PG.wire(a.body);
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PRESETS.map(function (p) { return h("button", { class: "btn small", type: "button", text: p, onclick: function () { input.value = p; } }); })),
        h("div", { class: "row" }, input, send),
        h("p", { class: "eyebrow", text: "Menu · skills from the card" }), menu, verdict), wire.el);
      send.addEventListener("click", async function () {
        send.disabled = true;
        Object.keys(skillEls).forEach(function (k) { skillEls[k].classList.remove("lit"); skillEls[k].bar.style.width = "0"; });
        const msg = SPEC.msg("user", [input.value]);
        wire.add({ actor: "client", label: "SendMessage · “" + input.value.slice(0, 48) + "”", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: msg }),
          note: "Search the body: there is no <code>skillId</code>. The request is just a message.", open: true });
        const r = route(input.value);
        await PG.sleep(350);
        if (!api.alive()) return;
        r.scores.forEach(function (s) { skillEls[s.id].bar.style.width = s.pct + "%"; });
        for (const id of r.plan) {
          await PG.sleep(420);
          if (!api.alive()) return;
          skillEls[id].classList.add("lit");
        }
        const id = "task-" + PG.hex(3), ctx = "ctx-" + PG.hex(3);
        if (!r.plan.length) {
          wire.add({ kind: "in", actor: "server", label: "Task " + id + " · REJECTED", status: "200", http: SPEC.res(200),
            body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task(id, ctx, "REJECTED", { status: { state: "TASK_STATE_REJECTED", message: SPEC.msg("agent", ["I handle release operations only: readiness, compliance, approvals and deployments."]) } }) } } });
          verdict.className = "result warn";
          verdict.innerHTML = "No skill fits, so the agent <b>rejects</b> the task (<span class='mono'>TASK_STATE_REJECTED</span>) with a message explaining what it does handle. A router should have read the card and not sent this here.";
        } else {
          wire.add({ kind: "in", actor: "server", label: "Task " + id + " · WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task(id, ctx, "WORKING") } } });
          verdict.className = "result ok";
          verdict.innerHTML = "The agent inferred a plan of <b>" + r.plan.length + "</b> skill" + (r.plan.length > 1 ? "s" : "") + ": " + r.plan.map(function (p) { return "<span class='mono'>" + p + "</span>"; }).join(" → ") +
            ". None of this reasoning crossed the wire; the client only sees a Task."
            + (r.plan.indexOf("human_change_approval") >= 0 ? " Production triggered the approval skill." : "");
        }
        send.disabled = false;
      });

      /* Lab B: try to name a skill */
      const b = PG.lab(bench, "Try to call a skill directly", "Lab · what the wire allows");
      const out = h("div", { class: "stack" });
      function show(v) {
        out.innerHTML = "";
        const w = PG.wire(out, { title: "Wire" });
        if (v === "param") {
          const req = SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["checkout-api 2.14.0"]), skillId: "compliance_scan" });
          w.add({ actor: "client", label: "SendMessage with params.skillId", http: SPEC.post("/a2a/release"), body: req, hl: ["skillId"], open: true });
          w.add({ kind: "in", actor: "server", label: "Invalid params: unknown field skillId", status: "-32602", http: SPEC.res(200),
            body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid parameters", data: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "skillId", description: "unknown field" }] }] } },
            note: "A strict server rejects unknown fields. A lenient one silently ignores them, which is worse: you think you picked a skill and you didn't." });
        } else if (v === "meta") {
          const uri = "https://platform.example.com/ext/skill-hint/v1";
          const m = SPEC.msg("user", ["Scan checkout-api 2.14.0"], { extensions: [uri], metadata: {} });
          m.metadata[uri] = { preferredSkill: "compliance_scan" };
          w.add({ actor: "client", label: "SendMessage + skill hint in metadata (extension)", http: SPEC.post("/a2a/release", { "A2A-Extensions": uri }), body: SPEC.rpc("SendMessage", { message: m }), hl: ["metadata", "extensions"], open: true });
          w.add({ kind: "note", actor: "server", label: "Legal, but only meaningful if the agent declares this extension in capabilities.extensions. It is a hint, never a command: the agent still decides." });
        } else {
          w.add({ actor: "client", label: "SendMessage · “Run the compliance scan for checkout-api 2.14.0”", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Run the compliance scan for checkout-api 2.14.0"]) }), open: true });
          w.add({ kind: "in", actor: "server", label: "Task WORKING (agent picked compliance_scan)", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(3), "ctx-" + PG.hex(3), "WORKING") } } });
        }
      }
      b.body.append(PG.seg([{ v: "param", label: "Add params.skillId" }, { v: "meta", label: "Hint via extension metadata" }, { v: "words", label: "Just ask in words" }], "param", show, "Approach"), out);
      show("param");
    },
    quiz: [
      { q: "Which field of an A2A Message selects the skill to run?",
        opts: ["<code>skillId</code>", "<code>metadata.skill</code>", "None: there is no such field", "<code>parts[0].skill</code>"],
        a: 2, why: "Message has role, parts, messageId, contextId, taskId, referenceTaskIds, extensions and metadata. The agent infers the skill from the message." },
      { q: "What are skills in the Agent Card primarily for?",
        opts: ["Routing a request to a specific handler URL", "Discovery and selection: deciding whether an agent fits a goal", "Listing the agent's internal tools", "Rate limiting"],
        a: 1, why: "Skills describe capabilities for discovery and routing. They are not endpoints and not tools." },
      { q: "You need a strongly typed, named operation with a JSON schema. What fits best?",
        opts: ["An A2A skill", "An MCP tool", "A custom JSON-RPC method on the A2A endpoint", "A push notification"],
        a: 1, why: "MCP tools are named and schema-typed. A2A keeps the agent boundary as message-in, task-out." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Messages, Parts, Artifacts
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "messages",
    track: "conversation",
    title: "Messages, Parts and Artifacts",
    short: "Messages & artifacts",
    thesis: "A Message is one turn of conversation. An Artifact is a deliverable. Both are made of Parts, and a Part holds exactly one kind of content: text, raw bytes, a URL, or structured data.",
    refs: "Spec §3.7 · §4.1.4 Message · §4.1.6 Part · §4.1.7 Artifact · a2a.proto message Part",
    brief: `
      <h2>Message</h2>
      <p>One turn, with a <code>role</code> (<code>ROLE_USER</code> or <code>ROLE_AGENT</code>), a unique <code>messageId</code>, and one or more <code>parts</code>. Optional <code>taskId</code> continues an existing task; <code>contextId</code> groups turns; <code>referenceTaskIds</code> points at earlier tasks being refined.</p>
      <h2>Part</h2>
      <p>A Part holds exactly one of <code>text</code>, <code>raw</code> (base64 bytes), <code>url</code> or <code>data</code> (any JSON value). Every Part may also carry <code>mediaType</code>, <code>filename</code> and <code>metadata</code>. This one shape is what makes A2A modality-independent.</p>
      <div class="note spec"><span class="note-label">Spec</span>If a part's media type isn't accepted by the agent or the skill, the agent returns <code>ContentTypeNotSupportedError</code> (-32005). The card's <code>defaultInputModes</code> tells you what is accepted before you try.</div>
      <h2>Messages talk, Artifacts deliver</h2>
      <p>Messages SHOULD NOT carry task outputs. Clarifying questions, progress notes and your replies are Messages. Reports, files and results are <strong>Artifacts</strong>: <code>artifactId</code>, optional <code>name</code>, and parts. Artifacts can stream in chunks via <code>artifactUpdate</code> events with <code>append</code> and <code>lastChunk</code>.</p>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Build a message", "Lab · part builder");
      const accepted = ["text/plain", "application/json"];
      let parts = [{ kind: "text", value: "Deploy checkout-api 2.14.0 to production", mediaType: "text/plain" },
        { kind: "data", value: '{"service":"checkout-api","version":"2.14.0","environment":"production"}', mediaType: "application/json" }];
      const rows = h("div", { class: "stack" });
      const preview = h("pre", { class: "code" });
      const wire = PG.wire(a.body, { title: "Wire" });
      function toPart(p) {
        const o = {};
        if (p.kind === "text") o.text = p.value;
        else if (p.kind === "data") { try { o.data = JSON.parse(p.value); } catch (e) { o.data = p.value; } }
        else if (p.kind === "url") o.url = p.value;
        else o.raw = p.value;
        if (p.mediaType) o.mediaType = p.mediaType;
        if (p.filename) o.filename = p.filename;
        return o;
      }
      function paint() {
        rows.innerHTML = "";
        parts.forEach(function (p, i) {
          const val = h(p.kind === "data" ? "textarea" : "input", { class: "inline", id: "part-" + i, style: { flex: "1 1 240px", fontFamily: "var(--font-mono)", fontSize: "12px" }, "aria-label": "Part " + (i + 1) + " value" });
          val.value = p.value;
          if (p.kind === "raw") val.readOnly = true;
          val.addEventListener("input", function () { p.value = val.value; paintPreview(); });
          const mt = h("input", { class: "inline", id: "part-mt-" + i, style: { width: "150px", fontFamily: "var(--font-mono)", fontSize: "12px" }, value: p.mediaType || "", "aria-label": "mediaType" });
          mt.addEventListener("input", function () { p.mediaType = mt.value; paintPreview(); });
          rows.appendChild(h("div", { class: "row", style: { alignItems: "flex-start" } },
            h("span", { class: "chip mono", text: p.kind }), val, mt,
            h("button", { class: "btn small", type: "button", text: "Remove", "aria-label": "Remove part " + (i + 1), onclick: function () { parts.splice(i, 1); paint(); } })));
        });
        paintPreview();
      }
      function message() { return SPEC.msg("user", parts.map(toPart)); }
      function paintPreview() { preview.innerHTML = PG.jsonHTML(message()); }
      const file = h("input", { type: "file", id: "part-file", style: { maxWidth: "220px", fontSize: "12px" }, "aria-label": "Attach a file as a raw part" });
      file.addEventListener("change", function () {
        const f = file.files && file.files[0];
        if (!f) return;
        if (f.size > 48 * 1024) { PG.toast("Pick a file under 48 KB for this demo", "err"); return; }
        const rd = new FileReader();
        rd.onload = function () { parts.push({ kind: "raw", value: String(rd.result).split(",")[1] || "", mediaType: f.type || "application/octet-stream", filename: f.name }); paint(); };
        rd.readAsDataURL(f);
      });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          h("button", { class: "btn small", type: "button", text: "+ text", onclick: function () { parts.push({ kind: "text", value: "Also notify #releases", mediaType: "text/plain" }); paint(); } }),
          h("button", { class: "btn small", type: "button", text: "+ data", onclick: function () { parts.push({ kind: "data", value: '{"canary":{"steps":[10,50,100]}}', mediaType: "application/json" }); paint(); } }),
          h("button", { class: "btn small", type: "button", text: "+ url", onclick: function () { parts.push({ kind: "url", value: "https://ci.example.com/builds/8812/sbom.json", mediaType: "application/json" }); paint(); } }),
          h("button", { class: "btn small", type: "button", text: "+ raw PNG", onclick: function () { parts.push({ kind: "raw", value: "iVBORw0KGgo…(base64-encoded PNG bytes)", mediaType: "image/png", filename: "rollout.png" }); paint(); } }),
          file),
        rows,
        h("div", { class: "row" }, h("span", { class: "small muted", html: "Agent's <code>defaultInputModes</code>: " + accepted.join(", ") }), h("span", { style: { flex: 1 } }),
          h("button", { class: "btn primary", type: "button", text: "Send to agent", onclick: function () {
            const m = message();
            wire.add({ actor: "client", label: "SendMessage · " + m.parts.length + " part(s)", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: m }) });
            if (!m.parts.length) { wire.add({ kind: "in", actor: "server", label: "parts is required", status: "-32602", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid parameters: message.parts must not be empty" } } }); return; }
            const bad = m.parts.filter(function (p) { return p.mediaType && accepted.indexOf(p.mediaType) < 0; });
            if (bad.length) {
              wire.add({ kind: "in", actor: "server", label: "ContentTypeNotSupportedError · " + bad.map(function (p) { return p.mediaType; }).join(", "), status: "-32005", http: SPEC.res(200), body: SPEC.rpcErr("ContentTypeNotSupportedError", 1, "UNSUPPORTED_MEDIA_TYPE"), open: true });
            } else {
              wire.add({ kind: "in", actor: "server", label: "Task accepted · WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(3), "ctx-" + PG.hex(3), "WORKING") } } });
            }
          } })),
        h("p", { class: "eyebrow", text: "The Message on the wire (1.0 ProtoJSON)" }), preview), wire.el);
      paint();

      /* Lab B: classify */
      const b = PG.lab(bench, "Message or Artifact?", "Lab · sorting");
      const items = [
        { t: "“Which environment should I deploy to?”", a: "Message", why: "A clarifying question from the agent, sent with TASK_STATE_INPUT_REQUIRED." },
        { t: "deployment-report.json with canary metrics", a: "Artifact", why: "A deliverable the task produced." },
        { t: "“Compliance scan 60% complete”", a: "Message", why: "A progress note attached to a status update." },
        { t: "Generated release notes in Markdown", a: "Artifact", why: "Output of the work. Messages SHOULD NOT deliver outputs." },
        { t: "“Approved, ticket CHG-1234”, sent by the client", a: "Message", why: "The client's reply to an input request is a Message on the same task." },
        { t: "rollout.png chart of error rates", a: "Artifact", why: "A file result, carried as a raw or url Part inside an Artifact." },
      ];
      const grid = h("div", { class: "grid2" });
      let right = 0;
      const score = h("div", { class: "result", text: "Classify each item." });
      items.forEach(function (it, i) {
        const why = h("div", { class: "s-why", hidden: true, text: it.why });
        const card = h("div", { class: "sort-card" }, h("div", { class: "s-text", text: it.t }));
        const btns = h("div", { class: "row" });
        ["Message", "Artifact"].forEach(function (choice) {
          btns.appendChild(h("button", { class: "btn small", type: "button", text: choice, onclick: function () {
            if (card.dataset.done) return;
            card.dataset.done = "1";
            const ok = choice === it.a;
            if (ok) right++;
            card.classList.add(ok ? "good" : "bad");
            why.hidden = false;
            why.textContent = (ok ? "Right. " : "It's a " + it.a + ". ") + it.why;
            score.textContent = right + " correct so far.";
          } }));
        });
        card.append(btns, why);
        grid.appendChild(card);
      });
      b.body.append(grid, score);

      /* Lab C: artifact streaming */
      const c = PG.lab(bench, "Streaming an artifact in chunks", "Lab · artifactUpdate · append · lastChunk");
      const doc = h("pre", { class: "code wrap", style: { minHeight: "120px" } });
      const cw = PG.wire(c.body, { title: "SSE events" });
      const btn = h("button", { class: "btn primary", type: "button", text: "Stream the report" });
      c.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" }, btn), doc), cw.el);
      const chunks = ["# Release report: checkout-api 2.14.0\n\n", "- Readiness: ready (tier-1, risk high)\n", "- Compliance: 3/3 controls passed\n", "- Approval: CHG-1234 by alice\n", "- Canary: 10% → 50% → 100%, error rate 0.02%\n"];
      btn.addEventListener("click", async function () {
        btn.disabled = true; doc.textContent = ""; cw.clear();
        const id = "task-" + PG.hex(3), ctx = "ctx-" + PG.hex(3), art = "art-" + PG.hex(3);
        cw.add({ kind: "evt", actor: "server", label: "task · WORKING", sse: [{ task: SPEC.task(id, ctx, "WORKING") }] });
        for (let i = 0; i < chunks.length; i++) {
          await PG.sleep(550);
          if (!api.alive()) return;
          const ev = { artifactUpdate: { taskId: id, contextId: ctx, artifact: { artifactId: art, name: "release-report.md", parts: [{ text: chunks[i], mediaType: "text/markdown" }] }, append: i > 0, lastChunk: i === chunks.length - 1 } };
          cw.add({ kind: "evt", actor: "server", label: "artifactUpdate · chunk " + (i + 1) + (i > 0 ? " · append" : "") + (i === chunks.length - 1 ? " · lastChunk" : ""), sse: [ev], hl: ["append", "lastChunk"] });
          doc.textContent += chunks[i];
        }
        await PG.sleep(400);
        if (!api.alive()) return;
        cw.add({ kind: "evt", actor: "server", label: "statusUpdate · COMPLETED (stream closes)", status: "done", tone: "ok", sse: [SPEC.statusUpdate(id, ctx, "COMPLETED")] });
        btn.disabled = false;
      });
    },
    quiz: [
      { q: "How many content fields may a single Part set?",
        opts: ["Any number", "Exactly one of text, raw, url, data", "text is required, data optional", "Two: content and mediaType"],
        a: 1, why: "Part's content is a oneof. mediaType, filename and metadata are extra, not content." },
      { q: "The agent finishes a PDF report. How should it deliver it?",
        opts: ["In the final status Message", "As an Artifact on the task", "As a push notification header", "In the Agent Card"],
        a: 1, why: "Results go in Artifacts. Messages carry communication, not deliverables." },
      { q: "You send an image/png part to an agent whose defaultInputModes are text/plain and application/json. What should you expect?",
        opts: ["It is silently dropped", "ContentTypeNotSupportedError (-32005)", "TaskNotFoundError", "The agent converts it to text"],
        a: 1, why: "Unsupported media types are rejected with ContentTypeNotSupportedError." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Task lifecycle
   * ════════════════════════════════════════════════════════════════════ */
  const NODES = {
    SUBMITTED: [9, 50], WORKING: [33, 50], INPUT_REQUIRED: [57, 16], AUTH_REQUIRED: [57, 84],
    COMPLETED: [87, 12], FAILED: [87, 37], CANCELED: [87, 63], REJECTED: [87, 88],
  };
  const EDGES = [["SUBMITTED", "WORKING"], ["SUBMITTED", "REJECTED"], ["WORKING", "INPUT_REQUIRED"], ["INPUT_REQUIRED", "WORKING"],
    ["WORKING", "AUTH_REQUIRED"], ["AUTH_REQUIRED", "WORKING"], ["WORKING", "COMPLETED"], ["WORKING", "FAILED"], ["WORKING", "CANCELED"],
    ["WORKING", "REJECTED"], ["INPUT_REQUIRED", "CANCELED"], ["AUTH_REQUIRED", "CANCELED"]];
  const STATE_VAR = { SUBMITTED: "--st-submitted", WORKING: "--st-working", INPUT_REQUIRED: "--st-input", AUTH_REQUIRED: "--st-auth", COMPLETED: "--st-completed", FAILED: "--st-failed", CANCELED: "--st-canceled", REJECTED: "--st-rejected" };

  PG.lesson({
    id: "tasks",
    track: "conversation",
    title: "The life of a task",
    short: "Task lifecycle",
    thesis: "A Task is a stateful unit of work with an id and a lifecycle. It can pause for input or credentials, and once it reaches a terminal state it can never restart.",
    refs: "Spec §3.4 multi-turn · §4.1.1 Task · §4.1.3 TaskState · topic: life-of-a-task",
    brief: `
      <h2>Eight states, three kinds</h2>
      <dl class="terms">
        <dt>active</dt><dd><code>SUBMITTED</code>, <code>WORKING</code></dd>
        <dt>interrupted</dt><dd><code>INPUT_REQUIRED</code>, <code>AUTH_REQUIRED</code>: the agent waits for the client.</dd>
        <dt>terminal</dt><dd><code>COMPLETED</code>, <code>FAILED</code>, <code>CANCELED</code>, <code>REJECTED</code></dd>
      </dl>
      <p>On the wire they are ProtoJSON enum names: <code>TASK_STATE_WORKING</code> and so on.</p>
      <h2>Continuing, refining, immutability</h2>
      <ul>
        <li>To answer an interrupted task, send a Message with the <strong>same <code>taskId</code></strong>.</li>
        <li>A terminal task accepts nothing more: a message to it gets <code>UnsupportedOperationError</code> (-32004); cancelling it gets <code>TaskNotCancelableError</code> (-32002).</li>
        <li>To follow up on finished work, start a <strong>new task in the same <code>contextId</code></strong> and point at the old one with <code>referenceTaskIds</code>.</li>
      </ul>
      <h2>Message or Task?</h2>
      <p>An agent may answer with a bare Message (no lifecycle) or a Task. <em>Message-only</em> agents always reply with messages; <em>task-generating</em> agents always create tasks; <em>hybrid</em> agents negotiate with messages, then create a task once there is committed work.</p>
      <div class="note ours"><span class="note-label">In this repo</span>ADK's A2A server is task-generating: every call becomes a Task, which is why the approval pause has a <code>taskId</code> to resume. The resume uses a function-response DataPart, an ADK convention layered on <code>INPUT_REQUIRED</code>; in plain A2A, a text reply on the same task is enough.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Drive a task through its states", "Lab · state machine");
      const fsm = h("div", { class: "fsm" });
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
      const edgeEls = {};
      EDGES.forEach(function (e) {
        const A = NODES[e[0]], B = NODES[e[1]];
        const back = EDGES.some(function (x) { return x[0] === e[1] && x[1] === e[0]; });
        const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2 + (back ? (A[1] < B[1] ? -6 : 6) : 0);
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M" + A[0] + " " + A[1] + " Q " + mx + " " + my + " " + B[0] + " " + B[1]);
        svg.appendChild(p);
        edgeEls[e[0] + ">" + e[1]] = p;
      });
      fsm.appendChild(svg);
      const nodeEls = {};
      Object.keys(NODES).forEach(function (s) {
        const kind = SPEC.terminal.indexOf(s) >= 0 ? "terminal" : SPEC.interrupted.indexOf(s) >= 0 ? "interrupted" : "active";
        const n = h("div", { class: "node", style: { left: NODES[s][0] + "%", top: NODES[s][1] + "%" } }, s, h("small", { text: kind }));
        fsm.appendChild(n);
        nodeEls[s] = n;
      });
      const actions = h("div", { class: "row" });
      const ctxBox = h("div", { class: "stack" });
      const wire = PG.wire(a.body, { title: "Wire" });
      a.body.insertBefore(h("div", { class: "stack" }, fsm, actions, ctxBox), wire.el);

      let ctx, tasks, cur;
      function reset() {
        ctx = "ctx-" + PG.hex(3);
        tasks = [];
        newTask();
        wire.clear();
        wire.add({ actor: "client", label: "SendMessage (no taskId) → a new task", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Deploy checkout-api 2.14.0 to production"]) }) });
        paint(null);
      }
      function newTask(refs) {
        cur = { id: "task-" + PG.hex(3), state: "SUBMITTED", history: [{ s: "SUBMITTED", at: new Date() }], refs: refs };
        tasks.push(cur);
      }
      function go(state, prev) {
        cur.state = state;
        cur.history.push({ s: state, at: new Date() });
        paint(prev);
      }
      function paint(prev) {
        Object.keys(nodeEls).forEach(function (s) {
          const n = nodeEls[s];
          const on = s === cur.state;
          n.classList.toggle("cur", on);
          n.style.background = on ? "var(" + STATE_VAR[s] + ")" : "";
          n.style.borderColor = on ? "var(" + STATE_VAR[s] + ")" : "";
        });
        Object.keys(edgeEls).forEach(function (k) { edgeEls[k].classList.toggle("hot", !!prev && k === prev + ">" + cur.state); });
        const edge = prev && edgeEls[prev + ">" + cur.state];
        if (edge && !PG.reducedMotion && edge.getTotalLength) {
          const L = edge.getTotalLength(), dot = h("div", { class: "fsm-dot" }), fr = [];
          for (let i = 0; i <= 20; i++) { const pt = edge.getPointAtLength((L * i) / 20); fr.push({ left: pt.x + "%", top: pt.y + "%" }); }
          fsm.appendChild(dot);
          try { dot.animate(fr, { duration: 700 / PG.speed, easing: "cubic-bezier(.45,.05,.35,1)" }).finished.then(function () { dot.remove(); }, function () { dot.remove(); }); } catch (e) { dot.remove(); }
        }
        actions.innerHTML = "";
        const s = cur.state;
        function act(label, cls, fn) { actions.appendChild(h("button", { class: "btn small " + (cls || ""), type: "button", text: label, onclick: fn })); }
        function ev(state, text) {
          const p = cur.state;
          wire.add({ kind: "evt", actor: "server", label: "statusUpdate · " + state + (text ? " · “" + text + "”" : ""), sse: [SPEC.statusUpdate(cur.id, ctx, state, text)] });
          go(state, p);
        }
        if (s === "SUBMITTED") {
          act("Agent starts work", "server", function () { ev("WORKING"); });
          act("Agent refuses the request", "danger", function () { ev("REJECTED", "Out of scope for release operations."); });
        } else if (s === "WORKING") {
          act("Agent needs input", "server", function () { ev("INPUT_REQUIRED", "Production deploy needs approval. Approve CHG-1234?"); });
          act("Agent needs credentials", "auth", function () { ev("AUTH_REQUIRED", "Grant access to the GitHub repo acme/checkout."); });
          act("Agent finishes", "server", function () {
            wire.add({ kind: "evt", actor: "server", label: "artifactUpdate · release-report.md", sse: [{ artifactUpdate: { taskId: cur.id, contextId: ctx, artifact: { artifactId: "art-" + PG.hex(2), name: "release-report.md", parts: [{ text: "Deployed 2.14.0 to 100%." }] }, lastChunk: true } }] });
            ev("COMPLETED");
          });
          act("Agent errors", "danger", function () { ev("FAILED", "Canary error rate exceeded 1%; rolled back."); });
          act("Client cancels", "client", clientCancel);
        } else if (s === "INPUT_REQUIRED" || s === "AUTH_REQUIRED") {
          act(s === "INPUT_REQUIRED" ? "Client replies on the same taskId" : "Credential arrives", "client", function () {
            const p = cur.state;
            if (s === "INPUT_REQUIRED") {
              wire.add({ actor: "client", label: "SendMessage · taskId=" + cur.id + " · “Approved”", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Approved. Ticket CHG-1234."], { taskId: cur.id, contextId: ctx }) }), hl: ["taskId"] });
            } else {
              wire.add({ kind: "note", actor: "auth", label: "The user completed an OAuth consent out-of-band; the agent received the token and resumes." });
            }
            wire.add({ kind: "evt", actor: "server", label: "statusUpdate · WORKING", sse: [SPEC.statusUpdate(cur.id, ctx, "WORKING")] });
            go("WORKING", p);
          });
          act("Client cancels", "client", clientCancel);
        } else {
          act("Send another message to this task", "danger", function () {
            wire.add({ actor: "client", label: "SendMessage · taskId=" + cur.id + " (terminal)", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["One more thing…"], { taskId: cur.id }) }), hl: ["taskId"] });
            wire.add({ kind: "in", actor: "server", label: "UnsupportedOperationError: task is " + s, status: "-32004", http: SPEC.res(200), body: SPEC.rpcErr("UnsupportedOperationError", 1, "TASK_IN_TERMINAL_STATE"), open: true });
          });
          act("Cancel it", "danger", function () {
            wire.add({ actor: "client", label: "CancelTask · " + cur.id, http: SPEC.post("/a2a/release"), body: SPEC.rpc("CancelTask", { id: cur.id }) });
            wire.add({ kind: "in", actor: "server", label: "TaskNotCancelableError", status: "-32002", http: SPEC.res(200), body: SPEC.rpcErr("TaskNotCancelableError"), open: true });
          });
          act("Refine: new task, same context", "client", function () {
            const old = cur.id;
            newTask([old]);
            wire.add({ actor: "client", label: "SendMessage · contextId=" + ctx + " · referenceTaskIds=[" + old + "]", http: SPEC.post("/a2a/release"),
              body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Now roll the same version out to eu-west-1"], { contextId: ctx, referenceTaskIds: [old] }) }), hl: ["contextId", "referenceTaskIds"] });
            paint(null);
          });
        }
        act("Reset", "", reset);
        ctxBox.innerHTML = "";
        ctxBox.append(h("div", { class: "row" }, h("span", { class: "small muted", text: "contextId" }), h("span", { class: "chip mono", text: ctx })),
          h("div", { class: "row" }, tasks.map(function (t) {
            return h("span", { class: "row", style: { gap: "4px", padding: "3px 6px", border: "1px solid " + (t === cur ? "var(--ink)" : "var(--rule)"), borderRadius: "4px" } },
              h("span", { class: "mono small", text: t.id }), PG.stateChip(t.state), t.refs ? h("span", { class: "mono small muted", text: "refs " + t.refs[0] }) : null);
          })),
          h("div", { class: "small muted", text: "History of " + cur.id + ": " + cur.history.map(function (x) { return x.s; }).join(" → ") }));
      }
      function clientCancel() {
        const p = cur.state;
        wire.add({ actor: "client", label: "CancelTask · " + cur.id, http: SPEC.post("/a2a/release"), body: SPEC.rpc("CancelTask", { id: cur.id }) });
        wire.add({ kind: "in", actor: "server", label: "Task · CANCELED", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: SPEC.task(cur.id, ctx, "CANCELED") } });
        go("CANCELED", p);
      }
      reset();

      /* Lab B: Message vs Task */
      const b = PG.lab(bench, "What does the agent send back?", "Lab · message-only · task-generating · hybrid");
      let kind = "task", prompt = "hi";
      const out = h("div");
      function show() {
        out.innerHTML = "";
        const small = prompt === "hi";
        let res, note;
        const ctx2 = "ctx-" + PG.hex(3);
        if (kind === "message" || (kind === "hybrid" && small)) {
          res = { message: SPEC.msg("agent", [small ? "I handle release readiness, compliance scans, approvals and deployments." : "Queued your deployment request."], { contextId: ctx2 }) };
          note = kind === "message" ? "Message-only agents never create tasks, even for real work, so there is nothing to poll, cancel or resume." : "Hybrid: small talk and negotiation come back as a Message. No task is created yet.";
        } else {
          res = { task: SPEC.task("task-" + PG.hex(3), ctx2, small ? "COMPLETED" : "WORKING", small ? { artifacts: [{ artifactId: "art-1", parts: [{ text: "I handle release readiness, compliance scans, approvals and deployments." }] }] } : {}) };
          note = kind === "task" ? (small ? "Task-generating agents model even “hi” as a task, completed immediately. ADK behaves this way." : "Real work becomes a task you can poll, stream, cancel and resume.") : "Hybrid: committed work creates a Task so it can be tracked.";
        }
        out.append(h("pre", { class: "code", html: PG.jsonHTML({ jsonrpc: "2.0", id: 1, result: res }) }), h("div", { class: "result", text: note }));
      }
      b.body.append(h("div", { class: "row" },
        PG.seg([{ v: "message", label: "Message-only" }, { v: "task", label: "Task-generating" }, { v: "hybrid", label: "Hybrid" }], kind, function (v) { kind = v; show(); }, "Agent type"),
        PG.seg([{ v: "hi", label: "“hi, what can you do?”" }, { v: "deploy", label: "“deploy to staging”" }], prompt, function (v) { prompt = v; show(); }, "Prompt")), out);
      show();
    },
    quiz: [
      { q: "A task is INPUT_REQUIRED. How does the client answer it?",
        opts: ["SendMessage with no taskId", "SendMessage with the same taskId", "CancelTask then SendMessage", "SubscribeToTask with the answer"],
        a: 1, why: "The taskId tells the agent which paused task this message continues." },
      { q: "A task is COMPLETED and the user wants a follow-up. What's correct?",
        opts: ["Send to the same taskId", "Start a new task in the same contextId with referenceTaskIds", "Reopen it with CancelTask", "Use a new contextId so history is lost"],
        a: 1, why: "Terminal tasks are immutable. Refinements are new tasks in the same context, referencing the old one." },
      { q: "Which pair are both <em>interrupted</em> states?",
        opts: ["SUBMITTED, WORKING", "INPUT_REQUIRED, AUTH_REQUIRED", "COMPLETED, CANCELED", "FAILED, REJECTED"],
        a: 1, why: "The agent is waiting on the client: for input, or for credentials." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Polling · Streaming · Push
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "delivery",
    track: "conversation",
    title: "Polling, streaming, push",
    short: "Polling · streaming · push",
    thesis: "The same task can report back three ways. Polling asks repeatedly, streaming holds a connection open, and push calls you back when something changes. Each trades requests, open connections and latency differently.",
    refs: "Spec §3.1.1–3.1.2 · §3.1.6 SubscribeToTask · §3.5 update delivery · §4.3 push · topic: streaming-and-async",
    brief: `
      <h2>Polling</h2>
      <p><code>SendMessage</code> is <strong>blocking by default</strong>: it returns when the task is terminal or interrupted. Set <code>configuration.returnImmediately: true</code> to get the task back at once, then call <code>GetTask</code> on an interval.</p>
      <h2>Streaming</h2>
      <p><code>SendStreamingMessage</code> answers with <code>text/event-stream</code>. The first event is the Task, then <code>statusUpdate</code> and <code>artifactUpdate</code> events. The stream closes when the task is terminal or interrupted. Requires <code>capabilities.streaming</code>. If the connection drops while the task is still active, <code>SubscribeToTask</code> re-attaches; on a terminal task it returns <code>UnsupportedOperationError</code>.</p>
      <h2>Push</h2>
      <p>For long jobs or clients that can't hold a connection. Register a <code>TaskPushNotificationConfig</code> (a webhook <code>url</code>, optional <code>token</code>, and <code>authentication</code> the agent uses when calling you), either in <code>configuration</code> or with <code>CreateTaskPushNotificationConfig</code>. The agent POSTs a <code>StreamResponse</code> to your webhook; you verify it and usually call <code>GetTask</code> for the full picture. Without <code>capabilities.pushNotifications</code> you get <code>PushNotificationNotSupportedError</code> (-32003).</p>
      <div class="note spec"><span class="note-label">Spec</span>Webhook receivers MUST validate authenticity and the task id, SHOULD process deliveries idempotently (duplicates happen), and MUST answer 2xx. Agents SHOULD guard webhook URLs against SSRF.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Race the same 12-second job three ways", "Lab · delivery mechanisms");
      const cfg = { poll: 3, drop: true, push: true };
      const JOB = 12, SPAN = 15;
      const wire = PG.wire(a.body, { title: "Wire (all lanes)" });
      const lanesEl = h("div", { class: "lanes" });
      const lanes = {};
      [["poll", "Polling", "client"], ["stream", "Streaming", "server"], ["push", "Push", "auth"]].forEach(function (l) {
        const track = h("div", { class: "lane-track" });
        const cursor = h("div", { class: "cursor", style: { left: "0%" } });
        track.appendChild(cursor);
        const stats = h("div", { class: "lane-stats" });
        const el = h("div", { class: "lane" }, h("div", { class: "lane-head" }, h("b", { text: l[1] })), track, stats);
        lanes[l[0]] = { el: el, track: track, cursor: cursor, stats: stats, color: "var(--" + l[2] + ")" };
        lanesEl.appendChild(el);
      });
      const start = h("button", { class: "btn primary", type: "button", text: "Start the race" });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, start,
          h("span", { class: "small muted", text: "Poll every" }),
          PG.seg([{ v: 1, label: "1 s" }, { v: 3, label: "3 s" }, { v: 5, label: "5 s" }], cfg.poll, function (v) { cfg.poll = Number(v); }, "Poll interval")),
        h("div", { class: "row" },
          PG.switch("drop-conn", "Drop the stream at t=6 s", cfg.drop, function (v) { cfg.drop = v; }),
          PG.switch("push-cap", "Agent supports push", cfg.push, function (v) { cfg.push = v; })),
        lanesEl,
        h("div", { class: "small muted", html: "Job: <span class='mono'>WORKING</span> at 0 s, report chunk at 4 s, “canary 50%” at 8 s, <span class='mono'>COMPLETED</span> at 12 s." })), wire.el);

      function plan() {
        const id = "task-" + PG.hex(3), ctx = "ctx-" + PG.hex(3), E = { poll: [], stream: [], push: [] };
        const agentEvents = [[0, "WORKING"], [4, "artifact"], [8, "WORKING · canary 50%"], [12, "COMPLETED"]];
        /* polling */
        E.poll.push({ t: 0, tick: "req", w: { actor: "client", tag: "POLL", label: "SendMessage · returnImmediately: true", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Deploy checkout-api"]), configuration: { returnImmediately: true } }), hl: ["returnImmediately"] } });
        let know = null, reqs = 1;
        for (let t = cfg.poll; t <= SPAN; t += cfg.poll) {
          const st = t >= JOB ? "COMPLETED" : "WORKING";
          reqs++;
          E.poll.push({ t: t, tick: st === "COMPLETED" ? "done" : "req", w: { actor: "client", tag: "POLL", label: "GetTask → " + st, status: st === "COMPLETED" ? "done" : "wasted", tone: st === "COMPLETED" ? "ok" : "warn",
            http: SPEC.post("/a2a/release"), body: SPEC.rpc("GetTask", { id: id }) } });
          if (st === "COMPLETED") { know = t; break; }
        }
        E.poll.stats = { requests: reqs, held: 0, know: know };
        /* streaming */
        E.stream.push({ t: 0, tick: "req", w: { actor: "client", tag: "STREAM", label: "SendStreamingMessage (connection held open)", http: SPEC.post("/a2a/release", { Accept: "text/event-stream" }), body: SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", ["Deploy checkout-api"]) }) } });
        let sreq = 1, held = JOB, gap = null;
        agentEvents.forEach(function (ev) {
          if (cfg.drop && ev[0] > 6 && ev[0] < 7.5) return;
          const sse = ev[1] === "artifact" ? [{ artifactUpdate: { taskId: id, contextId: ctx, artifact: { artifactId: "art-1", parts: [{ text: "# Release report" }] } } }]
            : ev[0] === 0 ? [{ task: SPEC.task(id, ctx, "WORKING") }] : [SPEC.statusUpdate(id, ctx, ev[1].split(" ")[0], ev[1].indexOf("canary") >= 0 ? "canary 50%" : null)];
          E.stream.push({ t: ev[0], tick: ev[0] === JOB ? "done" : "evt", w: { kind: "evt", actor: "server", tag: "STREAM", label: (sse[0].task ? "task" : sse[0].artifactUpdate ? "artifactUpdate" : "statusUpdate") + " · " + ev[1], sse: sse } });
        });
        if (cfg.drop) {
          gap = [6, 7];
          held = JOB - 1;
          sreq++;
          E.stream.push({ t: 6, tick: "cut", w: { kind: "note", actor: "proxy", tag: "STREAM", label: "Connection dropped at 6 s. The task keeps running on the agent.", status: "dropped", tone: "err" } });
          E.stream.push({ t: 7, tick: "req", w: { actor: "client", tag: "STREAM", label: "SubscribeToTask · " + id + " (re-attach)", http: SPEC.post("/a2a/release", { Accept: "text/event-stream" }), body: SPEC.rpc("SubscribeToTask", { id: id }), hl: ["id"] } });
          E.stream.push({ t: 7.1, tick: "evt", w: { kind: "evt", actor: "server", tag: "STREAM", label: "task snapshot · WORKING (current state on re-attach)", sse: [{ task: SPEC.task(id, ctx, "WORKING") }] } });
        }
        E.stream.sort(function (x, y) { return x.t - y.t; });
        E.stream.stats = { requests: sreq, held: held, know: JOB, gap: gap };
        /* push */
        const cfgObj = { url: "https://concierge.example.com/a2a/webhook", token: "tok_" + PG.hex(4), authentication: { scheme: "Bearer", credentials: "whk_" + PG.hex(6) } };
        E.push.push({ t: 0, tick: "req", w: { actor: "client", tag: "PUSH", label: "SendMessage + taskPushNotificationConfig, then disconnect", http: SPEC.post("/a2a/release"),
          body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Deploy checkout-api"]), configuration: { returnImmediately: true, taskPushNotificationConfig: cfgObj } }), hl: ["taskPushNotificationConfig"] } });
        if (!cfg.push) {
          E.push.push({ t: 0.2, tick: "cut", w: { kind: "in", actor: "server", tag: "PUSH", label: "PushNotificationNotSupportedError", status: "-32003", http: SPEC.res(200), body: SPEC.rpcErr("PushNotificationNotSupportedError") } });
          E.push.stats = { requests: 1, held: 0, know: null };
        } else {
          E.push.push({ t: 12, tick: "hook", w: { kind: "hook", actor: "server", tag: "WEBHOOK", label: "Agent POSTs statusUpdate COMPLETED to your webhook",
            http: { start: "POST /a2a/webhook HTTP/1.1", headers: { Host: "concierge.example.com", Authorization: "Bearer " + cfgObj.authentication.credentials, "Content-Type": "application/a2a+json" } },
            body: SPEC.statusUpdate(id, ctx, "COMPLETED"), note: "The agent authenticates with the credentials you registered. You verify them and the task id, answer 2xx, and treat duplicates idempotently." } });
          E.push.push({ t: 12.4, tick: "req", w: { actor: "client", tag: "PUSH", label: "GetTask · " + id + " (fetch artifacts)", http: SPEC.post("/a2a/release"), body: SPEC.rpc("GetTask", { id: id }) } });
          E.push.stats = { requests: 2, held: 0, know: 12 };
        }
        return E;
      }
      function tick(l, t, kind) {
        const col = kind === "done" ? "var(--ok)" : kind === "cut" ? "var(--err)" : kind === "hook" ? "var(--auth)" : kind === "evt" ? "var(--server)" : "var(--client)";
        l.track.appendChild(h("div", { class: "tick", style: { left: (100 * t) / SPAN + "%", background: col } }));
      }
      start.addEventListener("click", async function () {
        start.disabled = true;
        wire.clear();
        const E = plan();
        Object.keys(lanes).forEach(function (k) {
          const l = lanes[k];
          l.track.querySelectorAll(".tick,.span").forEach(function (x) { x.remove(); });
          l.stats.innerHTML = "";
        });
        /* connection spans */
        const s = lanes.stream;
        if (E.stream.stats.gap) {
          s.track.appendChild(h("div", { class: "span", style: { left: "0%", width: (100 * 6) / SPAN + "%", background: "color-mix(in srgb, var(--server) 35%, transparent)" } }));
          s.track.appendChild(h("div", { class: "span", style: { left: (100 * 7) / SPAN + "%", width: (100 * 5) / SPAN + "%", background: "color-mix(in srgb, var(--server) 35%, transparent)" } }));
        } else s.track.appendChild(h("div", { class: "span", style: { left: "0%", width: (100 * JOB) / SPAN + "%", background: "color-mix(in srgb, var(--server) 35%, transparent)" } }));
        const idx = { poll: 0, stream: 0, push: 0 };
        for (let t = 0; t <= SPAN + 0.001; t += 0.1) {
          if (!api.alive()) return;
          Object.keys(lanes).forEach(function (k) {
            lanes[k].cursor.style.left = (100 * t) / SPAN + "%";
            const list = E[k];
            while (idx[k] < list.length && list[idx[k]].t <= t + 1e-9) {
              const item = list[idx[k]++];
              tick(lanes[k], item.t, item.tick);
              wire.add(item.w);
            }
          });
          await PG.sleep(45);
        }
        Object.keys(lanes).forEach(function (k) {
          const st = E[k].stats;
          lanes[k].stats.append(
            h("span", { class: "chip", text: st.requests + " client request" + (st.requests === 1 ? "" : "s") }),
            h("span", { class: "chip", text: st.held + " s connection held" }),
            h("span", { class: "chip " + (st.know === null ? "err" : st.know - JOB > 0.5 ? "warn" : "ok"), text: st.know === null ? "never learned the result" : "knew at " + st.know + " s" + (st.know - JOB > 0.5 ? " (+" + (st.know - JOB) + " s late)" : "") }));
        });
        start.disabled = false;
      });
    },
    quiz: [
      { q: "You call SendMessage with no configuration. When does it return?",
        opts: ["Immediately with SUBMITTED", "When the task is terminal or interrupted", "After exactly 30 s", "Never; you must stream"],
        a: 1, why: "SendMessage is blocking by default. Set configuration.returnImmediately: true to return at once and poll." },
      { q: "Your SSE stream dropped while the task is still WORKING. What do you call?",
        opts: ["SendStreamingMessage again with the same text", "SubscribeToTask with the task id", "CancelTask", "GetExtendedAgentCard"],
        a: 1, why: "SubscribeToTask re-attaches to an active task's stream. Re-sending the message would start a new task." },
      { q: "How does the agent authenticate when it calls your push webhook?",
        opts: ["It doesn't", "With the credentials you gave in TaskPushNotificationConfig.authentication", "With its Agent Card signature", "With the user's OAuth token"],
        a: 1, why: "Agents MUST include the authentication you registered; receivers MUST validate it." },
    ],
  });
})();
