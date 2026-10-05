/* Track 1 — Foundations: actors & layers, the Agent Card. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  /* Track order is defined here, once, for the whole site. */
  PG.track("foundations", "Foundations", "Who talks to whom, and the document every conversation starts from.");
  PG.track("discovery", "Discovery & trust", "How a client finds an agent, picks a transport, and decides to trust what it found.");
  PG.track("conversation", "Conversation", "Skills, messages, tasks and the three ways results come back.");
  PG.track("security", "Security", "Authentication, authorization, and asking for credentials mid-task.");
  PG.track("infrastructure", "Infrastructure", "Bindings, versions, gateways and extensions: what sits between two agents.");
  PG.track("production", "Agents in production", "What breaks once agents call agents for real: restarts, cancels, fan-out, identity, tracing and untrusted replies.");
  PG.track("mastery", "Mastery", "Put it together, then prove it.");

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Actors & layers
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "actors",
    track: "foundations",
    title: "Actors and the three layers",
    short: "Actors & layers",
    thesis: "A2A has three parties and one rule that shapes everything else: the remote agent is a black box. The client sees a card and task objects, never prompts, tools or memory.",
    refs: "Spec §1 (principles) · §2 (layers) · topic: key-concepts",
    brief: `
      <h2>The three actors</h2>
      <dl class="terms">
        <dt>User</dt><dd>A person or automated service with a goal.</dd>
        <dt>A2A client</dt><dd>An app or another agent acting for the user. It starts every exchange.</dd>
        <dt>A2A server</dt><dd>The remote agent. It exposes an HTTP endpoint that speaks A2A, processes tasks and reports progress.</dd>
      </dl>
      <p>“Client” and “server” describe the <strong>direction of a call</strong>, not intelligence. In this repository <code>ops_concierge</code> is a server to its callers and a client of <code>deployment_agent</code>. Most real agents are both.</p>
      <h2>Opaque execution</h2>
      <p>The spec's founding principle: agents collaborate on declared capabilities and exchanged messages <em>without sharing internal thoughts, plans or tool implementations</em>. Everything a client learns comes from two places: the Agent Card, and the Task and Message objects on the wire.</p>
      <h2>Three layers</h2>
      <p>The 1.0 specification is organized as three layers, and the separation is what lets one agent speak JSON-RPC, gRPC and REST at once:</p>
      <ol>
        <li><strong>Data model</strong>: Task, Message, Part, Artifact, AgentCard and friends.</li>
        <li><strong>Abstract operations</strong>: Send Message, Get Task, Cancel Task and eight more, defined independently of any transport.</li>
        <li><strong>Protocol bindings</strong>: concrete mappings to JSON-RPC 2.0, gRPC and HTTP+JSON.</li>
      </ol>
      <div class="note ours"><span class="note-label">In this repo</span>Both agents are ADK apps served with <code>get_fast_api_app(a2a=True)</code>. The concierge's <code>RemoteA2aAgent</code> is the A2A client; ADK generated the server side for both.</div>`,
    lab: function (bench, api) {
      /* Lab A: opacity */
      const a = PG.lab(bench, "What the client can see", "Lab · opacity");
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "Platform engineer", sub: "has a goal", x: 11, y: 42 },
          { id: "client", role: "client", label: "Client agent", sub: "ops_concierge", x: 44, y: 42 },
          { id: "server", role: "server", label: "Remote agent", sub: "deployment_agent", x: 81, y: 42, locked: true },
        ],
        links: [["user", "client"], ["client", "server"]],
      });
      const peek = h("div", { class: "grid2" });
      const seen = h("div", { class: "note" }, h("span", { class: "note-label", text: "Client sees" }),
        h("div", { class: "row" }, ["Agent Card", "Task id + status", "Messages (Parts)", "Artifacts"].map(function (t) { return h("span", { class: "chip client", text: t }); })));
      const hidden = h("div", { class: "note", hidden: true }, h("span", { class: "note-label", text: "Hidden inside the remote agent" }),
        h("div", { class: "row" }, ["System prompt", "LLM choice", "check_release_readiness()", "run_compliance_scan()", "session memory", "OPA tool policy"].map(function (t) { return h("span", { class: "chip server", text: t }); })),
        h("div", { class: "small muted", text: "None of this appears in the card or on the wire. The client could swap this agent for a completely different implementation with the same card and never know." }));
      peek.append(seen, hidden);
      const wire = PG.wire(a.body);
      const run = h("button", { class: "btn primary", type: "button", text: "Send a request" });
      const sw = PG.switch("peek-internals", "Peek inside the remote agent", false, function (on) {
        hidden.hidden = !on;
        stage.set("server", { locked: !on });
      });
      a.body.insertBefore(h("div", { class: "row" }, run, sw), a.body.firstChild);
      a.body.insertBefore(peek, wire.el);
      run.addEventListener("click", async function () {
        run.disabled = true;
        const task = "task-" + PG.hex(3), ctx = "ctx-" + PG.hex(3);
        stage.caption("The engineer asks the concierge for a deployment.");
        await stage.send("user", "client", "“deploy checkout-api”");
        if (!api.alive()) return;
        stage.caption("The client turns the goal into an A2A message and sends it.");
        const req = SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Deploy checkout-api 2.14.0 to production"]) });
        wire.add({ actor: "client", label: "POST /a2a/release  SendMessage", http: SPEC.post("/a2a/release"), body: req });
        await stage.send("client", "server", "SendMessage");
        if (!api.alive()) return;
        stage.caption("Inside the black box the agent plans, calls tools, keeps memory. The client sees none of it.");
        await PG.sleep(700);
        const res = { jsonrpc: "2.0", id: 1, result: { task: SPEC.task(task, ctx, "WORKING") } };
        wire.add({ kind: "in", actor: "server", label: "Task " + task + "  WORKING", status: "200", http: SPEC.res(200), body: res });
        await stage.send("server", "client", "Task · WORKING");
        if (!api.alive()) return;
        stage.caption("What came back is a Task object: an id, a context id and a status. That is the whole contract.");
        run.disabled = false;
      });

      /* Lab B: three layers */
      const b = PG.lab(bench, "The three layers of the spec", "Lab · architecture");
      const panel = h("div", { class: "stack" });
      const layers = [
        { v: "data", label: "1 · Data model" },
        { v: "ops", label: "2 · Abstract operations" },
        { v: "bind", label: "3 · Protocol bindings" },
      ];
      function show(v) {
        panel.innerHTML = "";
        if (v === "data") {
          panel.append(h("p", { class: "small muted", text: "The nouns. Every binding carries exactly these structures." }),
            h("div", { class: "row" }, ["AgentCard", "AgentSkill", "AgentInterface", "Task", "TaskStatus", "Message", "Part", "Artifact", "TaskStatusUpdateEvent", "TaskArtifactUpdateEvent", "SecurityScheme", "AgentExtension", "TaskPushNotificationConfig"].map(function (t) { return h("span", { class: "chip mono", text: t }); })));
        } else if (v === "ops") {
          const detail = h("div", { class: "result", text: "Pick an operation to see how each binding spells it." });
          panel.append(h("p", { class: "small muted", text: "The verbs, defined once, independent of transport." }),
            h("div", { class: "row" }, SPEC.methods.map(function (m) {
              return h("button", { class: "btn small", type: "button", text: m.op, onclick: function () {
                detail.innerHTML = "<b>" + PG.esc(m.op) + "</b> · " + PG.esc(m.what) + "<br><span class='mono'>JSON-RPC <b>" + m.jsonrpc + "</b> · gRPC <b>" + m.jsonrpc + "</b> · REST <b>" + PG.esc(m.rest) + "</b></span>";
              } });
            })), detail);
        } else {
          panel.append(h("p", { class: "small muted", text: "The same operations over three wires. An agent lists the ones it serves in supportedInterfaces, most preferred first." }),
            h("div", { class: "grid3" },
              h("div", { class: "note" }, h("span", { class: "note-label", text: "JSONRPC" }), h("span", { class: "small", text: "JSON-RPC 2.0 over HTTP POST to one URL. PascalCase methods. Streaming as Server-Sent Events." })),
              h("div", { class: "note" }, h("span", { class: "note-label", text: "GRPC" }), h("span", { class: "small", text: "Protobuf over HTTP/2 from a2a.proto. Server streaming for SendStreamingMessage." })),
              h("div", { class: "note" }, h("span", { class: "note-label", text: "HTTP+JSON" }), h("span", { class: "small", text: "Resource URLs like POST /message:send and GET /tasks/{id}. Content-Type application/a2a+json." }))));
        }
      }
      b.body.append(PG.seg(layers, "data", show, "Layer"), panel);
      show("data");

      /* Lab C: both roles */
      const c = PG.lab(bench, "One agent, both roles", "Lab · this repository");
      const chain = PG.stage(c.body, {
        size: "short",
        actors: [
          { id: "caller", role: "user", label: "Outside caller", sub: "curl / UI", x: 12, y: 40 },
          { id: "conc", role: "client", label: "ops_concierge", sub: "server + client", x: 50, y: 40 },
          { id: "dep", role: "server", label: "deployment_agent", sub: "server", x: 86, y: 40 },
        ],
        links: [["caller", "conc"], ["conc", "dep"]],
      });
      const go = h("button", { class: "btn primary", type: "button", text: "Run the two-hop chain" });
      c.body.insertBefore(h("div", { class: "row" }, go), c.body.firstChild);
      c.body.appendChild(h("p", { class: "small muted", text: "Each hop owns its own task. The caller only ever sees the first task id; the concierge opens a second task one hop further in." }));
      go.addEventListener("click", async function () {
        go.disabled = true;
        chain.badge("conc", ""); chain.badge("dep", "");
        chain.caption("The caller sends SendMessage to the concierge.");
        await chain.send("caller", "conc", "SendMessage");
        if (!api.alive()) return;
        chain.badge("conc", "task T1");
        chain.caption("The concierge is now a server holding task T1, and it becomes a client for the next hop.");
        await chain.send("conc", "dep", "SendMessage");
        if (!api.alive()) return;
        chain.badge("dep", "task T2");
        chain.caption("deployment_agent creates its own task T2. Two tasks, one conversation.");
        await chain.send("dep", "conc", "T2 · INPUT_REQUIRED");
        if (!api.alive()) return;
        await chain.send("conc", "caller", "T1 · INPUT_REQUIRED");
        chain.caption("The approval gate surfaces on both hops. Answering T1 is relayed onto T2.");
        go.disabled = false;
      });
    },
    quiz: [
      { q: "What decides whether an agent is the “client” in an A2A exchange?",
        opts: ["Whether it uses an LLM", "Which side initiates the call", "Whether it publishes an Agent Card", "Whether it runs in Kubernetes"],
        a: 1, why: "Client and server name the direction of the call. The concierge is a server to its callers and a client of the deployment agent." },
      { q: "A client wants to know which tools the remote agent will call. Where does it look?",
        opts: ["The Agent Card's tools field", "The Task history", "Nowhere: tools are internal and opaque", "The JSON-RPC error data"],
        a: 2, why: "Opaque execution: the card advertises skills, never tools, prompts or memory." },
      { q: "Which layer defines <code>POST /message:send</code>?",
        opts: ["Data model", "Abstract operations", "Protocol bindings"],
        a: 2, why: "The abstract operation is Send Message. The HTTP+JSON binding maps it to <code>POST /message:send</code>; JSON-RPC maps it to the method <code>SendMessage</code>." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: The Agent Card
   * ════════════════════════════════════════════════════════════════════ */
  const MEDIA = /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i;
  const SCHEME_KEYS = ["apiKeySecurityScheme", "httpAuthSecurityScheme", "oauth2SecurityScheme", "openIdConnectSecurityScheme", "mtlsSecurityScheme"];

  function lintCard(c) {
    const F = [];
    function f(lvl, msg, ref) { F.push({ lvl: lvl, msg: msg, ref: ref || "" }); }
    function str(k) { if (typeof c[k] !== "string" || !c[k].trim()) f("err", "<code>" + k + "</code> is required and must be a non-empty string.", "AgentCard." + k); }
    ["name", "description", "version"].forEach(str);

    if (!Array.isArray(c.supportedInterfaces) || !c.supportedInterfaces.length) {
      if (c.url) f("err", "0.3 shape: <code>url</code> + <code>preferredTransport</code> are not 1.0 fields. Declare endpoints in <code>supportedInterfaces</code>.", "§8.3.1");
      else f("err", "<code>supportedInterfaces</code> is required: at least one {url, protocolBinding, protocolVersion}.", "AgentCard.supported_interfaces");
    } else {
      c.supportedInterfaces.forEach(function (i, n) {
        const at = "supportedInterfaces[" + n + "]";
        if (!i || typeof i.url !== "string") { f("err", at + ".url is required.", "AgentInterface.url"); return; }
        if (/^http:\/\//.test(i.url) && !/\/\/(localhost|127\.0\.0\.1)/.test(i.url)) f("warn", at + " uses plain HTTP. Production deployments MUST use HTTPS.", "§7.1");
        if (SPEC.bindings.indexOf(i.protocolBinding) < 0) f("warn", at + ".protocolBinding <code>" + PG.esc(String(i.protocolBinding)) + "</code> is not a standard binding (JSONRPC, GRPC, HTTP+JSON). Custom bindings are allowed, but most clients will skip it.", "§5 / §12");
        if (!i.protocolVersion) f("err", at + ".protocolVersion is required.", "AgentInterface.protocol_version");
        else if (/^\d+\.\d+\.\d+$/.test(i.protocolVersion)) f("warn", at + ".protocolVersion <code>" + i.protocolVersion + "</code> includes a patch number. Versions are Major.Minor; write <code>" + i.protocolVersion.split(".").slice(0, 2).join(".") + "</code>.", "§3.6");
        else if (!/^\d+\.\d+$/.test(i.protocolVersion)) f("err", at + ".protocolVersion must look like <code>1.0</code>.", "§3.6");
      });
      const first = c.supportedInterfaces[0];
      if (first && first.url) f("info", "Preferred interface (first entry): <code>" + PG.esc(first.protocolBinding || "?") + "</code> at <code>" + PG.esc(first.url) + "</code>.", "§8.3.2");
    }

    if (c.protocolVersion) f("warn", "Top-level <code>protocolVersion</code> is a 0.3 field. In 1.0 each interface declares its own.", "0.3 → 1.0");
    if (c.preferredTransport) f("warn", "<code>preferredTransport</code> is a 0.3 field. Order <code>supportedInterfaces</code> by preference instead.", "0.3 → 1.0");
    if (c.url && Array.isArray(c.supportedInterfaces)) f("warn", "Top-level <code>url</code> is ignored by 1.0 clients.", "0.3 → 1.0");
    if ("supportsAuthenticatedExtendedCard" in c) f("warn", "<code>supportsAuthenticatedExtendedCard</code> was renamed and moved to <code>capabilities.extendedAgentCard</code>.", "CHANGELOG 1.0.0");
    if (c.security) f("warn", "<code>security</code> is the 0.3 name. 1.0 uses <code>securityRequirements</code>.", "AgentCard.security_requirements");

    const cap = c.capabilities;
    if (!cap || typeof cap !== "object") f("err", "<code>capabilities</code> is required (it may be <code>{}</code>).", "AgentCard.capabilities");
    else {
      ["streaming", "pushNotifications", "extendedAgentCard"].forEach(function (k) {
        if (k in cap && typeof cap[k] !== "boolean") f("err", "<code>capabilities." + k + "</code> must be a boolean, not " + typeof cap[k] + ".", "AgentCapabilities");
      });
      if ("stateTransitionHistory" in cap) f("warn", "<code>capabilities.stateTransitionHistory</code> was removed in 1.0.", "CHANGELOG 1.0.0");
      (cap.extensions || []).forEach(function (x, n) { if (!x || !x.uri) f("err", "capabilities.extensions[" + n + "] needs a <code>uri</code>.", "AgentExtension"); });
      if (cap.extendedAgentCard && !c.securitySchemes) f("warn", "An extended card MUST require authentication, but no securitySchemes are declared.", "§13.3");
    }

    ["defaultInputModes", "defaultOutputModes"].forEach(function (k) {
      if (!Array.isArray(c[k]) || !c[k].length) f("err", "<code>" + k + "</code> is required: a list of media types.", "AgentCard." + k);
      else c[k].forEach(function (m) { if (!MEDIA.test(m)) f("warn", "<code>" + PG.esc(m) + "</code> in " + k + " is not a media type like text/plain.", "AgentCard." + k); });
    });

    if (c.provider && (!c.provider.organization || !c.provider.url)) f("err", "<code>provider</code> needs both <code>organization</code> and <code>url</code>.", "AgentProvider");

    const schemes = c.securitySchemes || {};
    Object.keys(schemes).forEach(function (name) {
      const s = schemes[name] || {};
      const kinds = Object.keys(s).filter(function (k) { return SCHEME_KEYS.indexOf(k) >= 0; });
      if (s.type) f("warn", "Scheme <code>" + PG.esc(name) + "</code> uses the 0.3/OpenAPI <code>type</code> shape. 1.0 wraps it: e.g. <code>{\"oauth2SecurityScheme\": {...}}</code>.", "SecurityScheme");
      else if (kinds.length !== 1) f("err", "Scheme <code>" + PG.esc(name) + "</code> must contain exactly one of " + SCHEME_KEYS.join(", ") + ".", "SecurityScheme");
      const flows = s.oauth2SecurityScheme && s.oauth2SecurityScheme.flows;
      if (flows) {
        if (flows.implicit || flows.password) f("warn", "Scheme <code>" + PG.esc(name) + "</code> uses a deprecated OAuth flow. 1.0 removed implicit and password; use authorizationCode (with PKCE) or deviceCode.", "OAuthFlows");
        if (flows.authorizationCode && !flows.authorizationCode.pkceRequired) f("info", "Consider <code>pkceRequired: true</code> on the authorizationCode flow.", "AuthorizationCodeOAuthFlow");
      }
    });
    function checkReqs(reqs, where) {
      (reqs || []).forEach(function (r) {
        Object.keys((r && r.schemes) || {}).forEach(function (n) {
          if (!schemes[n]) f("err", where + " references scheme <code>" + PG.esc(n) + "</code>, which is not declared in securitySchemes.", "SecurityRequirement");
        });
      });
    }
    checkReqs(c.securityRequirements, "securityRequirements");
    if (!Object.keys(schemes).length) f("warn", "No authentication declared. Servers MUST authenticate every request; declare how, so clients can comply.", "§7.3 / §7.4");

    if (!Array.isArray(c.skills)) f("err", "<code>skills</code> is required (an empty list is allowed).", "AgentCard.skills");
    else {
      if (!c.skills.length) f("warn", "No skills: registries and routing clients have nothing to match on.", "AgentSkill");
      const ids = {};
      c.skills.forEach(function (s, n) {
        const at = "skills[" + n + "]";
        ["id", "name", "description"].forEach(function (k) { if (!s || !s[k]) f("err", at + "." + k + " is required.", "AgentSkill." + k); });
        if (!s || !Array.isArray(s.tags)) f("err", at + ".tags is required (a list of keywords).", "AgentSkill.tags");
        if (s && !s.examples) f("info", at + " has no examples. Examples are how LLM-driven clients learn what to send.", "AgentSkill.examples");
        if (s && s.id) { if (ids[s.id]) f("err", "Duplicate skill id <code>" + PG.esc(s.id) + "</code>.", "AgentSkill.id"); ids[s.id] = 1; }
        if (s) checkReqs(s.securityRequirements, at + ".securityRequirements");
      });
    }
    if (Array.isArray(c.signatures) && c.signatures.length) f("info", "Signed with " + c.signatures.length + " JWS signature(s). Verify before trusting (see the Trust lesson).", "§8.4");
    else f("info", "Unsigned card. A client cannot prove who published it.", "§8.4");
    return F;
  }
  PG.lintCard = lintCard;

  function migrate(c) {
    const out = PG.clone(c), log = [];
    if (!out.supportedInterfaces && out.url) {
      out.supportedInterfaces = [{ url: out.url, protocolBinding: out.preferredTransport || "JSONRPC", protocolVersion: "1.0" }];
      log.push("Moved <code>url</code> and <code>preferredTransport</code> into <code>supportedInterfaces[0]</code> with protocolVersion 1.0.");
    }
    ["url", "preferredTransport", "protocolVersion"].forEach(function (k) { if (k in out) { delete out[k]; log.push("Removed top-level <code>" + k + "</code>."); } });
    if (out.capabilities && "stateTransitionHistory" in out.capabilities) { delete out.capabilities.stateTransitionHistory; log.push("Removed <code>capabilities.stateTransitionHistory</code> (dropped in 1.0)."); }
    if ("supportsAuthenticatedExtendedCard" in out) {
      out.capabilities = out.capabilities || {};
      if (out.supportsAuthenticatedExtendedCard) out.capabilities.extendedAgentCard = true;
      delete out.supportsAuthenticatedExtendedCard;
      log.push("Replaced <code>supportsAuthenticatedExtendedCard</code> with <code>capabilities.extendedAgentCard</code>.");
    }
    if (out.security && !out.securityRequirements) {
      out.securityRequirements = out.security.map(function (req) {
        const schemes = {};
        Object.keys(req).forEach(function (k) { schemes[k] = { list: req[k] }; });
        return { schemes: schemes };
      });
      delete out.security;
      log.push("Converted <code>security</code> to <code>securityRequirements</code>.");
    }
    Object.keys(out.securitySchemes || {}).forEach(function (n) {
      const s = out.securitySchemes[n];
      if (!s.type) return;
      const map = { apiKey: ["apiKeySecurityScheme", { location: s.in, name: s.name }], http: ["httpAuthSecurityScheme", { scheme: s.scheme, bearerFormat: s.bearerFormat }],
        oauth2: ["oauth2SecurityScheme", { flows: s.flows }], openIdConnect: ["openIdConnectSecurityScheme", { openIdConnectUrl: s.openIdConnectUrl }], mutualTLS: ["mtlsSecurityScheme", {}] };
      const m = map[s.type];
      if (m) { const o = {}; o[m[0]] = JSON.parse(JSON.stringify(m[1])); out.securitySchemes[n] = o; log.push("Wrapped scheme <code>" + n + "</code> as <code>" + m[0] + "</code>."); }
    });
    if (!log.length) log.push("Nothing to migrate: this card already uses 1.0 field names.");
    return { card: out, log: log };
  }

  function visualCard(c) {
    const el = h("div", { class: "vcard" });
    if (!c || typeof c !== "object") return el;
    el.appendChild(h("div", { class: "vcard-top" },
      h("div", { class: "vname", text: c.name || "(no name)" }),
      c.provider ? h("div", { class: "small muted", text: (c.provider.organization || "") + " · v" + (c.version || "?") }) : h("div", { class: "small muted", text: "v" + (c.version || "?") }),
      h("div", { class: "vdesc", text: c.description || "(no description)" })));
    const ifs = h("div", { class: "vcard-sec" }, h("h5", { text: "Interfaces · first is preferred" }));
    (c.supportedInterfaces || (c.url ? [{ url: c.url, protocolBinding: c.preferredTransport || "?", protocolVersion: c.protocolVersion || "?" }] : [])).forEach(function (i) {
      ifs.appendChild(h("div", { class: "row" }, h("span", { class: "chip mono client", text: i.protocolBinding || "?" }), h("span", { class: "chip mono", text: "v" + (i.protocolVersion || "?") }), h("span", { class: "mono small", text: i.url || "" })));
    });
    el.appendChild(ifs);
    const cap = c.capabilities || {};
    el.appendChild(h("div", { class: "vcard-sec" }, h("h5", { text: "Capabilities" }),
      h("div", { class: "row" }, ["streaming", "pushNotifications", "extendedAgentCard"].map(function (k) {
        return h("span", { class: "chip " + (cap[k] === true ? "ok" : ""), text: (cap[k] === true ? "✓ " : "✗ ") + k });
      }))));
    const sch = c.securitySchemes || {};
    const auth = h("div", { class: "vcard-sec" }, h("h5", { text: "Authentication" }));
    const names = Object.keys(sch);
    if (!names.length) auth.appendChild(h("span", { class: "chip warn", text: "none declared" }));
    names.forEach(function (n) {
      const kind = Object.keys(sch[n] || {})[0] || "?";
      auth.appendChild(h("div", { class: "row" }, h("span", { class: "chip auth", text: n }), h("span", { class: "mono small muted", text: kind })));
    });
    (c.securityRequirements || []).forEach(function (r) {
      Object.keys(r.schemes || {}).forEach(function (n) {
        auth.appendChild(h("div", { class: "small muted", text: "requires " + n + ((r.schemes[n].list || []).length ? " with scopes: " + r.schemes[n].list.join(", ") : "") }));
      });
    });
    el.appendChild(auth);
    const sk = h("div", { class: "vcard-sec" }, h("h5", { text: "Skills · " + ((c.skills || []).length) }));
    (c.skills || []).forEach(function (s) {
      sk.appendChild(h("div", { class: "skill" }, h("span", { class: "skill-name", text: s.name || "(unnamed)" }), h("span", { class: "skill-id", text: s.id || "" }),
        s.tags ? h("div", { class: "row" }, s.tags.map(function (t) { return h("span", { class: "chip", text: t }); })) : null));
    });
    el.appendChild(sk);
    el.appendChild(h("div", { class: "vcard-sec" }, h("h5", { text: "Signature" }),
      h("span", { class: "chip " + ((c.signatures || []).length ? "ok" : "warn"), text: (c.signatures || []).length ? "signed (JWS)" : "unsigned" })));
    return el;
  }
  PG.visualCard = visualCard;

  PG.lesson({
    id: "card",
    track: "foundations",
    title: "The Agent Card",
    short: "Agent Card",
    thesis: "The Agent Card is a JSON document an agent publishes about itself: who it is, where to reach it, what it can do and how to authenticate. Every interaction starts by reading one.",
    refs: "Spec §4.4 AgentCard · §8 Agent Discovery · a2a.proto message AgentCard",
    brief: `
      <p>Clients parse the card to decide whether an agent fits the job, which transport to use, and which credentials to fetch. It is the contract; if the card is wrong, a correct agent is unreachable.</p>
      <h2>Required in 1.0</h2>
      <dl class="terms">
        <dt>name, description</dt><dd>Identity. Descriptions are read by LLM routers, so write them for a model.</dd>
        <dt>supportedInterfaces</dt><dd>Ordered list of <code>{url, protocolBinding, protocolVersion}</code>. The first entry is the preferred one.</dd>
        <dt>version</dt><dd>The agent's own version, not the protocol's.</dd>
        <dt>capabilities</dt><dd><code>streaming</code>, <code>pushNotifications</code>, <code>extendedAgentCard</code>, <code>extensions</code>.</dd>
        <dt>defaultInput/OutputModes</dt><dd>Media types the agent accepts and produces.</dd>
        <dt>skills</dt><dd>What it can do: id, name, description, tags, plus examples.</dd>
      </dl>
      <p>Optional but important: <code>provider</code>, <code>securitySchemes</code> and <code>securityRequirements</code> (how to authenticate), <code>signatures</code> (proof of origin), <code>documentationUrl</code>, <code>iconUrl</code>.</p>
      <h2>What 1.0 changed</h2>
      <ul>
        <li><code>url</code>, <code>preferredTransport</code> and top-level <code>protocolVersion</code> became the <code>supportedInterfaces</code> list.</li>
        <li>Versions are <strong>Major.Minor</strong> only: <code>1.0</code>, never <code>1.0.0</code>.</li>
        <li><code>stateTransitionHistory</code> was removed; <code>supportsAuthenticatedExtendedCard</code> became <code>capabilities.extendedAgentCard</code>.</li>
        <li>Security schemes are wrapped by type (<code>oauth2SecurityScheme</code>, …) and requirements are <code>securityRequirements</code>. OAuth implicit and password flows are deprecated.</li>
      </ul>
      <div class="note ours"><span class="note-label">In this repo</span>Load “This repo's 0.3 card” in the workbench. It is what <code>remote_agents/deployment_agent/agent.json</code> looked like before the migration. Run the migrator and watch every warning clear.</div>`,
    lab: function (bench) {
      const lab = PG.lab(bench, "Card workbench", "Lab · live 1.0 linter");
      const ta = h("textarea", { class: "code", id: "card-editor", spellcheck: "false", "aria-label": "Agent Card JSON" });
      const findings = h("ul", { class: "findings" });
      const score = h("div", { class: "score" });
      const preview = h("div");
      const migLog = h("div", { class: "result", hidden: true });
      const migBtn = h("button", { class: "btn server", type: "button", text: "Migrate 0.3 → 1.0" });
      function load(which) {
        ta.value = JSON.stringify(PG.cards[which], null, 2);
        migLog.hidden = true;
        check();
      }
      const pick = PG.seg([{ v: "release", label: "1.0 sample" }, { v: "legacy03", label: "This repo's 0.3 card" }, { v: "broken", label: "Broken card" }], "release", load, "Sample card");
      let t;
      function check() {
        findings.innerHTML = ""; score.innerHTML = ""; preview.innerHTML = "";
        let card;
        try { card = JSON.parse(ta.value); } catch (e) {
          findings.appendChild(h("li", {}, h("span", { class: "chip err", text: "JSON" }), h("span", { text: "Not valid JSON: " + e.message })));
          score.appendChild(h("span", { class: "chip err", text: "cannot parse" }));
          return;
        }
        const F = lintCard(card);
        const n = { err: 0, warn: 0, info: 0 };
        F.forEach(function (x) { n[x.lvl]++; });
        score.append(h("span", { class: "chip " + (n.err ? "err" : "ok"), text: n.err ? "Not 1.0-conformant" : "1.0-conformant" }),
          h("span", { class: "chip err", text: n.err + " errors" }), h("span", { class: "chip warn", text: n.warn + " warnings" }), h("span", { class: "chip info", text: n.info + " notes" }));
        const order = { err: 0, warn: 1, info: 2 };
        F.sort(function (a, b) { return order[a.lvl] - order[b.lvl]; }).forEach(function (x) {
          findings.appendChild(h("li", {}, h("span", { class: "chip " + x.lvl, text: x.lvl === "err" ? "error" : x.lvl === "warn" ? "warning" : "note" }),
            h("span", { html: x.msg + (x.ref ? '<span class="ref">' + PG.esc(x.ref) + "</span>" : "") })));
        });
        preview.appendChild(visualCard(card));
      }
      ta.addEventListener("input", function () { clearTimeout(t); t = setTimeout(check, 250); });
      migBtn.addEventListener("click", function () {
        let card;
        try { card = JSON.parse(ta.value); } catch (e) { PG.toast("Fix the JSON first", "err"); return; }
        const m = migrate(card);
        ta.value = JSON.stringify(m.card, null, 2);
        migLog.hidden = false;
        migLog.className = "result ok";
        migLog.innerHTML = "<b>Migrated.</b><ul style='margin:6px 0 0;padding-left:1.2em'>" + m.log.map(function (l) { return "<li>" + l + "</li>"; }).join("") + "</ul>";
        check();
      });
      lab.body.append(h("div", { class: "row" }, pick, migBtn), migLog,
        h("div", { class: "grid2" }, h("div", { class: "stack" }, ta), h("div", { class: "stack" }, score, findings)),
        h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "How a client reads it" }), preview));
      load("release");
    },
    quiz: [
      { q: "Where does a 1.0 card say which URL and transport to use?",
        opts: ["Top-level <code>url</code> and <code>preferredTransport</code>", "<code>supportedInterfaces</code>, first entry preferred", "<code>capabilities.transport</code>", "The <code>A2A-Version</code> header"],
        a: 1, why: "1.0 replaced url/preferredTransport with an ordered supportedInterfaces list. Clients pick the first entry they support." },
      { q: "Which protocolVersion value is correct for a 1.0 interface?",
        opts: ["<code>1.0.0</code>", "<code>1</code>", "<code>1.0</code>", "<code>v1</code>"],
        a: 2, why: "Versions are Major.Minor. Patch numbers SHOULD NOT appear in cards, requests or responses (§3.6)." },
      { q: "A card has <code>capabilities.stateTransitionHistory: true</code>. What should a 1.0 author do?",
        opts: ["Keep it; it enables task history", "Rename it to historyLength", "Remove it; the field was dropped in 1.0", "Move it into supportedInterfaces"],
        a: 2, why: "It was an unimplemented capability and was removed in 1.0.0. History length is requested per call via historyLength." },
      { q: "A card declares no securitySchemes. What does the server still have to do?",
        opts: ["Nothing: no schemes means public", "Authenticate every request anyway (§7.4); the card just fails to tell clients how", "Return 401 to everyone", "Switch to mTLS"],
        a: 1, why: "Servers MUST authenticate every request. Declaring schemes is how clients learn what to send; omitting them does not remove the obligation." },
    ],
  });
})();
