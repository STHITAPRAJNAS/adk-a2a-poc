/* Track 2 — Discovery & trust: finding agents, choosing interfaces, caching,
 * signed cards and the extended card. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  function miniCard(name, host, skills) {
    return {
      name: name, description: name + " agent", version: "1.4.0",
      supportedInterfaces: [{ url: "https://" + host + "/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: true }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      skills: skills,
    };
  }
  const AGENTS = [
    { id: "travel", host: "travel.example", card: miniCard("Trip Planner", "travel.example", [{ id: "plan_trip", name: "Plan a trip", description: "Itineraries and bookings", tags: ["travel", "booking"] }]) },
    { id: "fx", host: "fx.example", card: miniCard("FX Desk", "fx.example", [{ id: "convert_currency", name: "Convert currency", description: "Live FX conversion between ISO-4217 currencies", tags: ["fx", "currency", "finance"], examples: ["Convert 250 EUR to JPY"] }]) },
    { id: "maps", host: "maps.example", card: miniCard("Route Planner", "maps.example", [{ id: "route", name: "Route optimizer", description: "Traffic-aware routing", tags: ["maps", "routing"] }]) },
  ];
  function matches(card) { return card.skills.some(function (s) { return s.tags.indexOf("currency") >= 0; }); }

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Discovery
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "discovery",
    track: "discovery",
    title: "Finding an agent",
    short: "Discovery",
    thesis: "Before any task, a client needs a card. The spec names three ways to get one, a rule for picking the transport, and standard HTTP caching so cards are not re-downloaded on every call.",
    refs: "Spec §8.2 discovery · §8.3 interface selection · §8.6 caching · topic: agent-discovery",
    brief: `
      <h2>Three discovery strategies</h2>
      <dl class="terms">
        <dt>Well-known URI</dt><dd><code>https://{domain}/.well-known/agent-card.json</code> (RFC 8615). Simple and public, but you must already know the domain.</dd>
        <dt>Curated registry</dt><dd>A catalog you query by skill, tag, provider or capability. Can filter results by the caller's identity (“selective disclosure”).</dd>
        <dt>Direct configuration</dt><dd>A card URL or card content in config or an environment variable. Right for fixed, known relationships.</dd>
      </dl>
      <h2>Picking an interface</h2>
      <p>A card lists <code>supportedInterfaces</code> in preference order. The client MUST walk that list and use the <strong>first entry whose binding it supports</strong>, at that entry's URL. If the entry has a <code>tenant</code>, every request must carry exactly that tenant.</p>
      <h2>Caching</h2>
      <p>Cards change rarely. Servers SHOULD send <code>Cache-Control: max-age</code> and an <code>ETag</code>; clients SHOULD honor them and revalidate stale cards with <code>If-None-Match</code>, which costs a <code>304 Not Modified</code> instead of a full download.</p>
      <div class="note ours"><span class="note-label">In this repo</span>The concierge uses direct configuration: <code>DEPLOYMENT_AGENT_CARD_URL</code> in <code>.env</code>. ADK serves each card at <code>/a2a/&lt;agent&gt;/.well-known/agent-card.json</code>, a per-agent path rather than the domain root.</div>`,
    lab: function (bench, api) {
      /* Lab A: strategies */
      const a = PG.lab(bench, "Find an agent that converts currency", "Lab · discovery strategies");
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "client", role: "client", label: "Client agent", sub: "needs: currency", x: 12, y: 46 },
          { id: "registry", role: "registry", label: "Agent registry", sub: "catalog.example", x: 46, y: 84 },
          { id: "travel", role: "server", label: "Trip Planner", sub: "travel.example", x: 84, y: 14 },
          { id: "fx", role: "server", label: "FX Desk", sub: "fx.example", x: 84, y: 46 },
          { id: "maps", role: "server", label: "Route Planner", sub: "maps.example", x: 84, y: 78 },
        ],
        links: [["client", "travel"], ["client", "fx"], ["client", "maps"], ["client", "registry"]],
      });
      const wire = PG.wire(a.body);
      let mode = "wellknown";
      const run = h("button", { class: "btn primary", type: "button", text: "Discover" });
      a.body.insertBefore(h("div", { class: "row" }, PG.seg([{ v: "wellknown", label: "Well-known URI" }, { v: "registry", label: "Registry" }, { v: "direct", label: "Direct config" }], mode, function (v) { mode = v; }, "Strategy"), run), a.body.firstChild);
      function getCard(host, card, extra) {
        wire.add({ actor: "client", label: "GET https://" + host + "/.well-known/agent-card.json", http: { start: "GET /.well-known/agent-card.json HTTP/1.1", headers: Object.assign({ Host: host, Accept: "application/json" }, extra || {}) } });
        wire.add({ kind: "in", actor: "server", label: card.name + " · skills: " + card.skills.map(function (s) { return s.id; }).join(", "), status: "200",
          http: SPEC.res(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300", ETag: '"' + card.version + '"' }), body: card, hl: ["skills"] });
      }
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear();
        ["travel", "fx", "maps"].forEach(function (id) { stage.badge(id, ""); });
        if (mode === "wellknown") {
          stage.caption("The client already knows three domains and asks each one for its card.");
          for (const ag of AGENTS) {
            if (!(await stage.send("client", ag.id, "GET card"))) return;
            getCard(ag.host, ag.card);
            await stage.send(ag.id, "client", "card");
            if (!api.alive()) return;
            stage.badge(ag.id, matches(ag.card) ? '<span style="color:var(--ok)">✓ currency</span>' : "no match");
          }
          stage.caption("Three downloads to find one match. Works on the open web, but only for domains you already knew about.");
        } else if (mode === "registry") {
          stage.caption("The client asks a registry for agents tagged “currency”.");
          wire.add({ actor: "client", label: "GET https://catalog.example/v1/agents?tag=currency", http: { start: "GET /v1/agents?tag=currency HTTP/1.1", headers: { Host: "catalog.example", Authorization: "Bearer eyJ…(client token)" } } });
          if (!(await stage.send("client", "registry", "query tag=currency"))) return;
          wire.add({ kind: "in", actor: "registry", label: "1 match · FX Desk", status: "200", http: SPEC.res(200), body: { agents: [AGENTS[1].card] },
            note: "Registries can apply <b>selective disclosure</b>: the same query returns different cards depending on who asks." });
          await stage.send("registry", "client", "1 match");
          if (!api.alive()) return;
          stage.caption("One query, one match. The client can now fetch the live card from fx.example to confirm it is current.");
          if (!(await stage.send("client", "fx", "GET card"))) return;
          getCard("fx.example", AGENTS[1].card);
          await stage.send("fx", "client", "card");
          stage.badge("fx", '<span style="color:var(--ok)">✓ currency</span>');
        } else {
          stage.caption("The URL comes from configuration: FX_AGENT_CARD_URL=https://fx.example/.well-known/agent-card.json");
          wire.add({ kind: "note", actor: "client", label: "config: FX_AGENT_CARD_URL=https://fx.example/.well-known/agent-card.json" });
          if (!(await stage.send("client", "fx", "GET card"))) return;
          getCard("fx.example", AGENTS[1].card);
          await stage.send("fx", "client", "card");
          stage.badge("fx", '<span style="color:var(--ok)">✓ currency</span>');
          stage.caption("One request, no search. Right for static relationships, like the concierge and deployment agent in this repo.");
        }
        run.disabled = false;
      });

      /* Lab B: interface selection */
      const b = PG.lab(bench, "Which interface does the client use?", "Lab · §8.3.2 selection rule");
      let order = [
        { url: "https://agents.example.com/a2a/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
        { url: "https://agents.example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "acme" },
        { url: "https://agents.example.com/a2a/json", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      ];
      const supports = { GRPC: false, JSONRPC: true, "HTTP+JSON": true };
      const list = h("div", { class: "stack" });
      const out = h("div", { class: "result" });
      function paint() {
        list.innerHTML = "";
        const chosen = order.find(function (i) { return supports[i.protocolBinding]; });
        order.forEach(function (i, n) {
          const up = h("button", { class: "btn small", type: "button", text: "↑", "aria-label": "Move " + i.protocolBinding + " up", disabled: n === 0,
            onclick: function () { const t = order[n - 1]; order[n - 1] = order[n]; order[n] = t; paint(); } });
          list.appendChild(h("div", { class: "row", style: { padding: "6px 8px", borderRadius: "4px", border: "1px solid var(--rule)", background: i === chosen ? "var(--ok-bg)" : "var(--panel)" } },
            h("span", { class: "chip mono", text: String(n + 1) }), h("span", { class: "chip mono client", text: i.protocolBinding }),
            h("span", { class: "mono small", text: i.url }), i.tenant ? h("span", { class: "chip mono", text: "tenant: " + i.tenant }) : null,
            h("span", { style: { flex: 1 } }), up));
        });
        if (!chosen) { out.className = "result err"; out.innerHTML = "No overlap: the client supports none of these bindings, so it cannot talk to this agent."; return; }
        out.className = "result ok";
        out.innerHTML = "The client uses <b>" + chosen.protocolBinding + "</b> at <span class='mono'>" + chosen.url + "</span>: the first entry in the card's order that the client supports." +
          (chosen.tenant ? " This entry declares <span class='mono'>tenant: " + chosen.tenant + "</span>, so every request must carry exactly that tenant." : "");
      }
      const checks = h("div", { class: "row" }, h("span", { class: "small muted", text: "Client supports:" }),
        ["GRPC", "JSONRPC", "HTTP+JSON"].map(function (bnd) {
          return PG.switch("sup-" + bnd.replace("+", ""), bnd, supports[bnd], function (on) { supports[bnd] = on; paint(); });
        }));
      b.body.append(checks, h("p", { class: "small muted", text: "Card order (preference). Reorder it with ↑:" }), list, out);
      paint();

      /* Lab C: caching */
      const c = PG.lab(bench, "Caching the card", "Lab · §8.6 ETag + max-age");
      const serverVersion = { v: "2.3.0" };
      const cache = { etag: null, fetchedAt: null };
      let clock = 0;
      const state = h("dl", { class: "kv" });
      const cwire = PG.wire(c.body, { title: "Card fetches" });
      function paintCache() {
        const age = cache.fetchedAt === null ? null : clock - cache.fetchedAt;
        state.innerHTML = "";
        [["clock", "t = " + clock + " s"], ["server card", "v" + serverVersion.v + ' · ETag "' + serverVersion.v + '"'],
         ["client cache", cache.etag ? 'ETag ' + cache.etag + " · age " + age + " s · " + (age < 300 ? "fresh" : "stale") : "empty"]].forEach(function (kv) {
          state.append(h("dt", { text: kv[0] }), h("dd", { text: kv[1] }));
        });
      }
      function fetchCard() {
        const age = cache.fetchedAt === null ? null : clock - cache.fetchedAt;
        const et = '"' + serverVersion.v + '"';
        if (cache.etag && age < 300) {
          cwire.add({ kind: "note", actor: "client", label: "Served from cache (age " + age + " s < max-age 300). No request sent.", status: "cached" });
        } else if (cache.etag) {
          const same = cache.etag === et;
          cwire.add({ actor: "client", label: "GET /.well-known/agent-card.json  If-None-Match: " + cache.etag,
            http: { start: "GET /.well-known/agent-card.json HTTP/1.1", headers: { Host: "agents.example.com", "If-None-Match": cache.etag } } });
          cwire.add({ kind: "in", actor: "server", label: same ? "Not Modified, reuse the cached card" : "Changed, new card v" + serverVersion.v, status: same ? "304" : "200",
            http: SPEC.res(same ? 304 : 200, { "Cache-Control": "max-age=300", ETag: et }), body: same ? undefined : { name: "Release Operations Agent", version: serverVersion.v, "…": "full card" } });
          cache.etag = et; cache.fetchedAt = clock;
        } else {
          cwire.add({ actor: "client", label: "GET /.well-known/agent-card.json", http: { start: "GET /.well-known/agent-card.json HTTP/1.1", headers: { Host: "agents.example.com" } } });
          cwire.add({ kind: "in", actor: "server", label: "Full card v" + serverVersion.v, status: "200", http: SPEC.res(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300", ETag: et }), body: { name: "Release Operations Agent", version: serverVersion.v, "…": "full card" } });
          cache.etag = et; cache.fetchedAt = clock;
        }
        paintCache();
      }
      c.body.insertBefore(h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", text: "Fetch card", onclick: fetchCard }),
        h("button", { class: "btn", type: "button", text: "Advance clock +6 min", onclick: function () { clock += 360; paintCache(); } }),
        h("button", { class: "btn server", type: "button", text: "Agent publishes a new version", onclick: function () {
          const p = serverVersion.v.split("."); p[1] = String(Number(p[1]) + 1); serverVersion.v = p.join(".");
          cwire.add({ kind: "note", actor: "server", label: "The agent now serves v" + serverVersion.v + ". Cached copies keep the old ETag until they revalidate." });
          paintCache();
        } })), c.body.firstChild);
      c.body.insertBefore(state, cwire.el);
      paintCache();
    },
    quiz: [
      { q: "A card lists interfaces in the order GRPC, JSONRPC, HTTP+JSON. The client supports JSONRPC and HTTP+JSON. Which does it use?",
        opts: ["GRPC", "JSONRPC", "HTTP+JSON", "Whichever is fastest"],
        a: 1, why: "Walk the card's list in order and take the first binding the client supports: JSONRPC." },
      { q: "Which strategy fits a client that must find agents by skill across a large organization?",
        opts: ["Well-known URI", "Curated registry", "Direct configuration"],
        a: 1, why: "Registries are searchable by skill, tag and capability, and can filter by caller identity." },
      { q: "The cached card is past max-age. What should the client send?",
        opts: ["A fresh GET with no headers", "A conditional GET with If-None-Match and the stored ETag", "Nothing; keep using it forever", "GetExtendedAgentCard"],
        a: 1, why: "Revalidate with If-None-Match. An unchanged card costs a 304 instead of a full download." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Trust — signatures & the extended card
   * ════════════════════════════════════════════════════════════════════ */
  function jcs(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + jcs(v[k]); }).join(",") + "}";
  }
  PG.jcs = jcs;

  PG.lesson({
    id: "trust",
    track: "discovery",
    title: "Trusting a card",
    short: "Signatures & extended card",
    thesis: "Anyone can serve a JSON file. A signed card proves who published it; an extended card shows more to clients that have authenticated.",
    refs: "Spec §8.4 Agent Card signing · §3.1.11 / §13.3 extended Agent Card · RFC 7515 (JWS) · RFC 8785 (JCS)",
    brief: `
      <h2>Signed cards</h2>
      <p>A card may carry <code>signatures</code>: JWS signatures over the card itself. To verify one, the client:</p>
      <ol>
        <li>removes the <code>signatures</code> field,</li>
        <li>canonicalizes the remaining JSON with <strong>RFC 8785 (JCS)</strong>: sorted keys, no whitespace,</li>
        <li>rebuilds the signing input <code>base64url(protected) + "." + base64url(canonical)</code>,</li>
        <li>checks the signature with the key named in the protected header (<code>kid</code>, fetched over HTTPS via <code>jku</code> or a trusted key store).</li>
      </ol>
      <p>Canonicalization is why formatting doesn't matter: reorder keys or re-indent and the signature still holds. Change a single value and it breaks.</p>
      <div class="note spec"><span class="note-label">Spec</span>Clients SHOULD verify at least one signature before trusting a card. Expired or revoked keys MUST NOT be used. Multiple signatures support key rotation.</div>
      <h2>The extended card</h2>
      <p>The public card is for everyone. An agent that sets <code>capabilities.extendedAgentCard: true</code> also serves a richer card to authenticated clients through <code>GetExtendedAgentCard</code>: more skills, quotas, tenant-specific detail.</p>
      <ul>
        <li>The call MUST be authenticated with a scheme declared in the public card.</li>
        <li>Capability off → <code>UnsupportedOperationError</code> (-32004). Capability on but nothing configured → <code>ExtendedAgentCardNotConfiguredError</code> (-32007).</li>
        <li>Clients SHOULD replace their cached public card with the extended one for the session.</li>
        <li>Extended cards SHOULD NOT leak exploitable detail such as internal service URLs.</li>
      </ul>`,
    lab: function (bench, api) {
      /* Lab A: real signatures */
      const a = PG.lab(bench, "Sign and verify a card", "Lab · real ES256 in your browser");
      const subtle = window.crypto && window.crypto.subtle;
      if (!subtle) {
        a.body.appendChild(h("div", { class: "result warn", text: "WebCrypto isn't available here (it needs HTTPS or localhost). Open the site over https:// or http://localhost to run this lab." }));
      } else {
        const base = PG.clone(PG.cards.release);
        base.skills = base.skills.slice(0, 2);
        const ta = h("textarea", { class: "code", id: "sig-editor", spellcheck: "false", style: { minHeight: "220px" }, "aria-label": "Signed card JSON" });
        ta.value = JSON.stringify(base, null, 2);
        const out = h("div", { class: "result", text: "Keys are being generated…" });
        const detail = h("pre", { class: "code wrap", hidden: true });
        let providerKey, attackerKey;
        const header = { alg: "ES256", typ: "JOSE", kid: "release-key-1", jku: "https://agents.example.com/.well-known/jwks.json" };
        Promise.all([
          subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
          subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
        ]).then(function (ks) {
          providerKey = ks[0]; attackerKey = ks[1];
          out.className = "result"; out.textContent = "Provider key pair ready (P-256, kid release-key-1). Sign the card to begin.";
        }).catch(function (e) { out.className = "result err"; out.textContent = "Key generation failed: " + e.message; });

        async function sign(key) {
          let card; try { card = JSON.parse(ta.value); } catch (e) { PG.toast("Fix the JSON first", "err"); return; }
          delete card.signatures;
          const canonical = jcs(card);
          const prot = PG.b64url(JSON.stringify(header));
          const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(prot + "." + PG.b64url(canonical)));
          card.signatures = [{ protected: prot, signature: PG.b64url(sig) }];
          ta.value = JSON.stringify(card, null, 2);
          detail.hidden = false;
          detail.textContent = "protected header: " + JSON.stringify(header) + "\n\ncanonical payload (JCS, " + canonical.length + " bytes):\n" + canonical.slice(0, 420) + (canonical.length > 420 ? "…" : "");
          return card;
        }
        async function verify() {
          let card; try { card = JSON.parse(ta.value); } catch (e) { out.className = "result err"; out.textContent = "Not valid JSON."; return; }
          const s = (card.signatures || [])[0];
          if (!s) { out.className = "result warn"; out.textContent = "No signatures field. The card is unsigned, so there is nothing to verify."; return; }
          delete card.signatures;
          const canonical = jcs(card);
          let ok = false;
          try {
            const bin = Uint8Array.from(atob(s.signature.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.signature.length + 3) % 4)), function (ch) { return ch.charCodeAt(0); });
            ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, providerKey.publicKey, bin, new TextEncoder().encode(s.protected + "." + PG.b64url(canonical)));
          } catch (e) { ok = false; }
          if (!api.alive()) return;
          out.className = "result " + (ok ? "ok" : "err");
          out.innerHTML = ok
            ? "<b>✓ Signature valid.</b> The canonical form of this card is exactly what release-key-1 signed. Whitespace and key order don't matter."
            : "<b>✗ Signature invalid.</b> The card was changed after signing, or signed with a key other than release-key-1. A client must not trust it.";
        }
        function tamper(fn, msg) {
          let card; try { card = JSON.parse(ta.value); } catch (e) { return; }
          if (!card.signatures) { PG.toast("Sign the card first", "err"); return; }
          fn(card);
          ta.value = typeof card === "string" ? card : JSON.stringify(card, null, 2);
          out.className = "result"; out.textContent = msg + " Now press Verify.";
        }
        a.body.append(
          h("div", { class: "row" },
            h("button", { class: "btn server", type: "button", text: "Sign as provider", onclick: function () { if (providerKey) sign(providerKey).then(function () { out.className = "result ok"; out.textContent = "Signed. The signatures field now holds a JWS (protected header + signature)."; }); } }),
            h("button", { class: "btn client", type: "button", text: "Verify as client", onclick: function () { if (providerKey) verify(); } })),
          h("div", { class: "row" }, h("span", { class: "small muted", text: "Tamper:" }),
            h("button", { class: "btn small danger", type: "button", text: "Redirect url to attacker", onclick: function () {
              tamper(function (c) { c.supportedInterfaces[0].url = "https://evil.example/a2a"; }, "The endpoint now points at evil.example.");
            } }),
            h("button", { class: "btn small danger", type: "button", text: "Add a skill", onclick: function () {
              tamper(function (c) { c.skills.push({ id: "wire_money", name: "Wire money", description: "Moves funds", tags: ["finance"] }); }, "A skill the provider never published was added.");
            } }),
            h("button", { class: "btn small", type: "button", text: "Reorder keys + reformat", onclick: function () {
              let card; try { card = JSON.parse(ta.value); } catch (e) { return; }
              if (!card.signatures) { PG.toast("Sign the card first", "err"); return; }
              const rev = {}; Object.keys(card).reverse().forEach(function (k) { rev[k] = card[k]; });
              ta.value = JSON.stringify(rev, null, 6);
              out.className = "result"; out.textContent = "Keys reversed and indentation changed; no value changed. Now press Verify.";
            } }),
            h("button", { class: "btn small danger", type: "button", text: "Attacker re-signs with own key", onclick: function () {
              if (!attackerKey) return;
              let card; try { card = JSON.parse(ta.value); } catch (e) { return; }
              card.supportedInterfaces[0].url = "https://evil.example/a2a";
              ta.value = JSON.stringify(card, null, 2);
              sign(attackerKey).then(function () { out.className = "result"; out.textContent = "The attacker changed the url and signed with their own key, claiming kid release-key-1. Now press Verify."; });
            } })),
          ta, out, detail);
      }

      /* Lab B: extended card */
      const b = PG.lab(bench, "Public card vs extended card", "Lab · GetExtendedAgentCard");
      const cfg = { cap: true, configured: true, cred: "none" };
      const wire = PG.wire(b.body, { title: "Wire" });
      const diff = h("div");
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          PG.switch("ext-cap", "capabilities.extendedAgentCard", cfg.cap, function (v) { cfg.cap = v; }),
          PG.switch("ext-conf", "Extended card configured on the server", cfg.configured, function (v) { cfg.configured = v; })),
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Client credential:" }),
          PG.seg([{ v: "none", label: "None" }, { v: "valid", label: "Valid OAuth token" }], cfg.cred, function (v) { cfg.cred = v; }, "Credential")),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Call GetExtendedAgentCard", onclick: call }))), wire.el);
      b.body.appendChild(diff);
      function call() {
        diff.innerHTML = "";
        const headers = cfg.cred === "valid" ? { Authorization: "Bearer " + PG.fakeJwt({ sub: "ops-concierge", scope: "deploy:read" }).slice(0, 38) + "…" } : {};
        const req = SPEC.rpc("GetExtendedAgentCard");
        wire.add({ actor: "client", label: "POST /a2a/release  GetExtendedAgentCard", http: SPEC.post("/a2a/release", headers), body: req });
        if (!cfg.cap) {
          wire.add({ kind: "in", actor: "server", label: "UnsupportedOperationError", status: "-32004", http: SPEC.res(200), body: SPEC.rpcErr("UnsupportedOperationError", 1, "EXTENDED_CARD_NOT_SUPPORTED"),
            note: "The public card says <code>extendedAgentCard</code> is false or absent, so the operation is unsupported." });
          return;
        }
        if (cfg.cred !== "valid") {
          wire.add({ kind: "in", actor: "server", label: "Authentication required", status: "401",
            http: SPEC.res(401, { "WWW-Authenticate": 'Bearer realm="a2a", error="invalid_request"', "Content-Type": "application/json" }), body: { error: "missing credentials" },
            note: "GetExtendedAgentCard MUST be authenticated with a scheme from the public card (§13.3)." });
          return;
        }
        if (!cfg.configured) {
          wire.add({ kind: "in", actor: "server", label: "ExtendedAgentCardNotConfiguredError", status: "-32007", http: SPEC.res(200), body: SPEC.rpcErr("ExtendedAgentCardNotConfiguredError") });
          return;
        }
        const ext = PG.clone(PG.cards.release);
        ext.skills.push({ id: "emergency_rollback", name: "Emergency rollback", description: "Rolls back the last production deployment. Rate limit: 3 per hour per tenant.", tags: ["rollback", "incident"],
          securityRequirements: [{ schemes: { platformOAuth: { list: ["deploy:prod"] } } }] });
        wire.add({ kind: "in", actor: "server", label: "Extended card · " + ext.skills.length + " skills", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: ext }, hl: ["skills"] });
        diff.appendChild(h("div", { class: "result ok", html: "<b>Extended card received.</b> Compared with the public card: <code>+ skills[4] emergency_rollback</code> (requires scope <code>deploy:prod</code>, rate limit in the description). The client should use this card instead of the cached public one for the rest of its session." }));
      }
    },
    quiz: [
      { q: "Before verifying a card signature, what must the client do to the JSON?",
        opts: ["Nothing; verify the raw bytes", "Remove signatures, then canonicalize with RFC 8785 (JCS)", "Pretty-print it with 2-space indent", "Base64 the whole file"],
        a: 1, why: "The signature covers the JCS-canonical card without its signatures field, so key order and whitespace don't matter." },
      { q: "The public card has <code>extendedAgentCard: false</code>. What does GetExtendedAgentCard return?",
        opts: ["An empty card", "UnsupportedOperationError (-32004)", "ExtendedAgentCardNotConfiguredError (-32007)", "404 Not Found"],
        a: 1, why: "Capability off means the operation is unsupported. -32007 is for capability on but nothing configured." },
      { q: "An attacker changes the url and re-signs with their own key, keeping kid <code>release-key-1</code>. Why does verification fail?",
        opts: ["JCS rejects the new URL", "The client verifies with the real release-key-1 public key, which didn't produce this signature", "ES256 forbids changing URLs", "It doesn't fail"],
        a: 1, why: "The kid is only a label. The client resolves it to the provider's real public key (over HTTPS or a trusted store), and that key did not sign the tampered card." },
    ],
  });
})();
