/* Track 4 — Security: authentication, then authorization and in-task auth. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  const AGENT = "https://agents.example.com/a2a/release";
  function token(scope, expOffset) {
    const now = Math.floor(Date.now() / 1000);
    return PG.fakeJwt({ iss: "https://auth.example.com", sub: "ops-concierge", aud: AGENT, scope: scope, iat: now - 60, exp: now + (expOffset === undefined ? 300 : expOffset) });
  }
  function claimsOf(jwt) { try { return JSON.parse(PG.b64urlDecode(jwt.split(".")[1])); } catch (e) { return null; } }
  function short(t) { return t.slice(0, 24) + "…" + t.slice(-6); }

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Authentication
   * ════════════════════════════════════════════════════════════════════ */
  const SCHEMES = [
    { v: "apiKey", label: "API key" },
    { v: "bearer", label: "HTTP Bearer" },
    { v: "oauthCC", label: "OAuth2 client credentials" },
    { v: "oauthAC", label: "OAuth2 code + PKCE" },
    { v: "oauthDC", label: "OAuth2 device code" },
    { v: "oidc", label: "OpenID Connect" },
    { v: "mtls", label: "Mutual TLS" },
  ];
  const WHEN = {
    apiKey: "Simplest option: a static key issued out-of-band. No expiry or scopes by default, so it's weakest. Fine for internal tools, risky across organizations.",
    bearer: "A token (usually a signed JWT) obtained elsewhere and sent as Authorization: Bearer. The agent validates the signature against the issuer's keys.",
    oauthCC: "The standard for agent-to-agent calls: the client agent authenticates as itself and gets a short-lived, scoped token. No user involved.",
    oauthAC: "When the client acts for a user who must consent, e.g. an agent reading someone's calendar. PKCE binds the code to the client that asked for it.",
    oauthDC: "For CLIs and devices without a browser: the user approves on another device while the client polls the token endpoint.",
    oidc: "Identity federation. The card points at an OpenID discovery document; the client learns endpoints and keys from it, then runs an OAuth flow and gets an ID token too.",
    mtls: "Identity comes from the TLS client certificate itself, with no header at all. This is what the Istio ambient mesh gives every workload in lab 40.",
  };

  async function pkce() {
    const verifier = PG.b64url(crypto.getRandomValues(new Uint8Array(32)));
    let challenge = "(needs WebCrypto)";
    try {
      const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      challenge = PG.b64url(dig);
    } catch (e) { /* insecure context */ }
    return { verifier: verifier, challenge: challenge };
  }

  PG.lesson({
    id: "auth",
    track: "security",
    title: "Authentication",
    short: "Authentication",
    thesis: "A2A doesn't invent security. It reuses HTTP's: the card declares which schemes it accepts, the client gets credentials out-of-band, and every request carries them in headers. The server authenticates every single request.",
    refs: "Spec §7.1–7.4 · §4.5 SecurityScheme · a2a.proto OAuthFlows · topic: enterprise-ready",
    brief: `
      <h2>The four steps</h2>
      <ol>
        <li><strong>Transport.</strong> Production MUST use HTTPS (TLS 1.3 recommended); clients SHOULD verify the server's certificate.</li>
        <li><strong>Discover requirements.</strong> Read <code>securitySchemes</code> and <code>securityRequirements</code> in the card. Skills may add their own requirements.</li>
        <li><strong>Acquire credentials out-of-band.</strong> OAuth flows, a key from a portal, a certificate from your CA. None of this is A2A.</li>
        <li><strong>Send them on every request</strong>, in HTTP headers (or gRPC metadata). The server MUST authenticate every request.</li>
      </ol>
      <h2>Five scheme types</h2>
      <dl class="terms">
        <dt>apiKeySecurityScheme</dt><dd><code>location</code> (header, query, cookie) and <code>name</code>.</dd>
        <dt>httpAuthSecurityScheme</dt><dd><code>scheme</code> such as Bearer or Basic, optional <code>bearerFormat</code>.</dd>
        <dt>oauth2SecurityScheme</dt><dd><code>flows</code>: <code>authorizationCode</code> (with <code>pkceRequired</code>), <code>clientCredentials</code>, <code>deviceCode</code>. Implicit and password are deprecated in 1.0.</dd>
        <dt>openIdConnectSecurityScheme</dt><dd><code>openIdConnectUrl</code> to a discovery document.</dd>
        <dt>mtlsSecurityScheme</dt><dd>Client certificate at the TLS layer.</dd>
      </dl>
      <h2>401 versus 403</h2>
      <p><strong>401 Unauthorized</strong> means “I don't know who you are”: credentials missing, malformed or expired. Include a <code>WWW-Authenticate</code> challenge. <strong>403 Forbidden</strong> means “I know who you are, and you may not do this”, e.g. a missing scope.</p>
      <div class="note trap"><span class="note-label">Anti-pattern</span>Never put credentials in the JSON-RPC body or message <code>metadata</code>. Payloads get logged, stored in task history and forwarded to other agents. Headers are where credentials belong.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Pick a scheme, watch the credential flow", "Lab · credential acquisition");
      let scheme = "oauthCC";
      const snippet = h("pre", { class: "code" });
      const when = h("div", { class: "result" });
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "client", role: "client", label: "Client agent", sub: "ops-concierge", x: 13, y: 52 },
          { id: "auth", role: "auth", label: "Authorization server", sub: "auth.example.com", x: 50, y: 14 },
          { id: "user", role: "user", label: "User", sub: "browser / phone", x: 50, y: 86 },
          { id: "agent", role: "server", label: "Release agent", sub: "agents.example.com", x: 87, y: 52 },
        ],
        links: [["client", "auth"], ["client", "agent"], ["user", "auth"], ["user", "client"], ["agent", "auth"]],
      });
      const wire = PG.wire(a.body);
      const run = h("button", { class: "btn primary", type: "button", text: "Run the flow" });
      function paintScheme() {
        const s = {}; s[scheme === "oauthAC" || scheme === "oauthDC" || scheme === "oauthCC" ? "platformOAuth" : scheme] = SPEC.schemes[scheme];
        const name = Object.keys(s)[0];
        const scopes = scheme === "oauthAC" ? ["calendar.read"] : scheme.indexOf("oauth") === 0 ? ["deploy:read"] : [];
        snippet.innerHTML = PG.jsonHTML({ securitySchemes: s, securityRequirements: [{ schemes: (function () { const o = {}; o[name] = { list: scopes }; return o; })() }] });
        when.textContent = WHEN[scheme];
        const needsUser = scheme === "oauthAC" || scheme === "oauthDC";
        stage.set("user", { dim: !needsUser });
        stage.set("auth", { dim: scheme === "apiKey" || scheme === "mtls" });
      }
      a.body.insertBefore(h("div", { class: "stack" },
        PG.seg(SCHEMES, scheme, function (v) { scheme = v; paintScheme(); wire.clear(); stage.caption(""); }, "Scheme"),
        h("div", { class: "grid2" }, h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "What the card declares" }), snippet), h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "When to use it" }), when)),
        h("div", { class: "row" }, run)), stage.el);
      paintScheme();

      function call(headers, label) {
        wire.add({ actor: "client", label: label || "SendMessage with credentials", http: SPEC.post("/a2a/release", headers), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Is checkout-api 2.14.0 ready?"]) }), hl: [] });
      }
      function ok() { wire.add({ kind: "in", actor: "server", label: "Authenticated · Task WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(3), "ctx-" + PG.hex(3), "WORKING") } } }); }
      async function step(from, to, label, caption, entry) {
        if (caption) stage.caption(caption);
        if (entry) wire.add(entry);
        return stage.send(from, to, label);
      }
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear();
        const T = token(scheme === "oauthAC" ? "calendar.read" : "deploy:read");
        try {
          if (scheme === "apiKey") {
            stage.caption("Out-of-band: an admin created the key in a developer portal and put it in the client's secret store.");
            await PG.sleep(900);
            if (!(await step("client", "agent", "X-API-Key", "The key rides in the header the card named.", null))) return;
            call({ "X-API-Key": "ak_live_" + PG.hex(10) }, "SendMessage · X-API-Key header");
            await step("agent", "client", "200", "The agent looks the key up. There's no expiry or scope unless the server adds them.", null);
            ok();
          } else if (scheme === "bearer") {
            stage.caption("Out-of-band: the client already holds a signed JWT from the platform's issuer.");
            await PG.sleep(700);
            if (!(await step("client", "agent", "Bearer JWT", "Authorization: Bearer <jwt> on every request."))) return;
            call({ Authorization: "Bearer " + short(T) }, "SendMessage · Authorization: Bearer");
            if (!(await step("agent", "auth", "GET jwks.json", "The agent validates the signature with the issuer's published keys (cached).",
              { actor: "server", label: "GET https://auth.example.com/.well-known/jwks.json", http: { start: "GET /.well-known/jwks.json HTTP/1.1", headers: { Host: "auth.example.com" } } }))) return;
            await step("auth", "agent", "keys");
            await step("agent", "client", "200", "Signature, issuer, audience and expiry check out.");
            ok();
          } else if (scheme === "oauthCC") {
            if (!(await step("client", "auth", "POST /token", "The client agent authenticates as itself and asks for a scoped token.",
              { actor: "client", label: "POST /oauth2/token · grant_type=client_credentials", http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "auth.example.com", "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic <base64(client_id:client_secret)>" } },
                body: "grant_type=client_credentials&scope=deploy%3Aread" }))) return;
            wire.add({ kind: "in", actor: "auth", label: "access_token (JWT) · expires_in 300", status: "200", http: SPEC.res(200), body: { access_token: short(T), token_type: "Bearer", expires_in: 300, scope: "deploy:read" } });
            await step("auth", "client", "token");
            if (!(await step("client", "agent", "Bearer token", "Short-lived and scoped. The client refreshes it before expiry."))) return;
            call({ Authorization: "Bearer " + short(T) });
            await step("agent", "client", "200");
            ok();
          } else if (scheme === "oauthAC") {
            const p = await pkce();
            if (!api.alive()) return;
            stage.caption("The client makes a random code_verifier and sends only its SHA-256 hash (code_challenge).");
            wire.add({ kind: "note", actor: "client", label: "PKCE: code_verifier=" + p.verifier.slice(0, 16) + "… → code_challenge=S256(verifier)=" + String(p.challenge).slice(0, 16) + "… (computed in your browser)" });
            await PG.sleep(800);
            if (!(await step("client", "user", "open consent URL", "The user is sent to the authorization server's consent page.",
              { actor: "client", label: "302 → /oauth2/authorize?response_type=code&code_challenge=…&code_challenge_method=S256", http: { start: "GET /oauth2/authorize?response_type=code&client_id=ops-concierge&scope=calendar.read&code_challenge=" + String(p.challenge).slice(0, 12) + "…&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fconcierge.example.com%2Fcb HTTP/1.1", headers: { Host: "auth.example.com" } } }))) return;
            if (!(await step("user", "auth", "log in + consent", "The user signs in and approves the calendar.read scope."))) return;
            if (!(await step("auth", "client", "?code=…", "A one-time code comes back via redirect.", { kind: "in", actor: "auth", label: "302 → https://concierge.example.com/cb?code=Splx…", status: "302", tone: "info" }))) return;
            if (!(await step("client", "auth", "code + verifier", "The client redeems the code with the original verifier. A stolen code is useless without it.",
              { actor: "client", label: "POST /oauth2/token · grant_type=authorization_code + code_verifier", http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "auth.example.com", "Content-Type": "application/x-www-form-urlencoded" } }, body: "grant_type=authorization_code&code=Splx…&code_verifier=" + p.verifier.slice(0, 16) + "…" }))) return;
            wire.add({ kind: "in", actor: "auth", label: "SHA-256(verifier) matches challenge · token issued", status: "200", http: SPEC.res(200), body: { access_token: short(T), token_type: "Bearer", expires_in: 3600, scope: "calendar.read" } });
            await step("auth", "client", "token");
            if (!(await step("client", "agent", "Bearer (user-delegated)"))) return;
            call({ Authorization: "Bearer " + short(T) });
            await step("agent", "client", "200", "The token represents the user's consent, scoped to calendar.read.");
            ok();
          } else if (scheme === "oauthDC") {
            if (!(await step("client", "auth", "POST /device", "A browserless client asks for a device code.",
              { actor: "client", label: "POST /oauth2/device · client_id=release-cli", http: { start: "POST /oauth2/device HTTP/1.1", headers: { Host: "auth.example.com" } }, body: "client_id=release-cli&scope=deploy%3Aread" }))) return;
            wire.add({ kind: "in", actor: "auth", label: "user_code WDJB-MJHT · verification_uri", status: "200", http: SPEC.res(200), body: { device_code: "GmRh…", user_code: "WDJB-MJHT", verification_uri: "https://auth.example.com/device", interval: 5, expires_in: 900 } });
            await step("auth", "client", "user_code");
            if (!(await step("client", "user", "“enter WDJB-MJHT”", "The CLI shows the code; the user opens the URL on their phone."))) return;
            for (let i = 0; i < 2; i++) {
              wire.add({ actor: "client", label: "POST /oauth2/token · device_code (poll)", status: "authorization_pending", tone: "warn", http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "auth.example.com" } }, body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=GmRh…" });
              if (!(await step("client", "auth", "poll", "Meanwhile the client polls the token endpoint every 5 s."))) return;
            }
            if (!(await step("user", "auth", "approve", "The user approves on the phone."))) return;
            wire.add({ kind: "in", actor: "auth", label: "access_token issued", status: "200", http: SPEC.res(200), body: { access_token: short(T), token_type: "Bearer", expires_in: 900 } });
            await step("auth", "client", "token");
            if (!(await step("client", "agent", "Bearer token"))) return;
            call({ Authorization: "Bearer " + short(T) });
            await step("agent", "client", "200");
            ok();
          } else if (scheme === "oidc") {
            if (!(await step("client", "auth", "GET openid-configuration", "The card's openIdConnectUrl is a discovery document.",
              { actor: "client", label: "GET /.well-known/openid-configuration", http: { start: "GET /.well-known/openid-configuration HTTP/1.1", headers: { Host: "auth.example.com" } } }))) return;
            wire.add({ kind: "in", actor: "auth", label: "issuer, endpoints, jwks_uri", status: "200", http: SPEC.res(200), body: { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/oauth2/authorize", token_endpoint: "https://auth.example.com/oauth2/token", jwks_uri: "https://auth.example.com/.well-known/jwks.json", scopes_supported: ["openid", "profile", "email"] } });
            await step("auth", "client", "endpoints");
            if (!(await step("client", "auth", "OAuth flow", "It then runs an OAuth flow at the discovered endpoints, asking for openid scope."))) return;
            wire.add({ kind: "in", actor: "auth", label: "id_token + access_token", status: "200", http: SPEC.res(200), body: { id_token: short(PG.fakeJwt({ iss: "https://auth.example.com", sub: "alice", email: "alice@example.com" })), access_token: short(T), token_type: "Bearer" } });
            await step("auth", "client", "tokens");
            if (!(await step("client", "agent", "Bearer"))) return;
            call({ Authorization: "Bearer " + short(T) });
            await step("agent", "client", "200");
            ok();
          } else {
            if (!(await step("client", "agent", "ClientHello", "TLS handshake begins.", { kind: "note", actor: "client", label: "TLS 1.3 ClientHello" }))) return;
            if (!(await step("agent", "client", "cert + CertificateRequest", "The agent proves its identity and asks for the client's certificate.", { kind: "note", actor: "server", label: "ServerHello · Certificate(agents.example.com) · CertificateRequest" }))) return;
            if (!(await step("client", "agent", "client cert", "The client presents a certificate issued by the platform CA.", { kind: "note", actor: "client", label: "Certificate(spiffe://cluster.local/ns/agents/sa/ops-concierge) · CertificateVerify" }))) return;
            stage.caption("The agent verifies the chain. Identity is the certificate subject; no Authorization header is needed.");
            call({}, "SendMessage (identity from the TLS layer, no header)");
            await step("agent", "client", "200");
            ok();
          }
          if (api.alive()) stage.caption(stage.captionEl.innerHTML + " ✓");
        } finally { run.disabled = false; }
      });

      /* Lab B: request tester */
      const b = PG.lab(bench, "What does the server say?", "Lab · 401 vs 403");
      let cred = "none";
      const claims = h("pre", { class: "code", hidden: true });
      const bw = PG.wire(b.body, { title: "Wire" });
      const CREDS = [
        { v: "none", label: "No credential" },
        { v: "malformed", label: "Malformed" },
        { v: "expired", label: "Expired" },
        { v: "scope", label: "Valid, wrong scope" },
        { v: "valid", label: "Valid" },
        { v: "meta", label: "Token in message metadata" },
      ];
      b.body.insertBefore(h("div", { class: "stack" },
        PG.seg(CREDS, cred, function (v) { cred = v; }, "Credential"),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Send SendMessage", onclick: send }),
          h("span", { class: "small muted", html: "Card requires <code>platformOAuth</code> with scope <code>deploy:read</code>." })),
        claims), bw.el);
      function send() {
        claims.hidden = true;
        let headers = {}, T = null;
        if (cred === "malformed") headers.Authorization = "Bearer not-a-jwt";
        if (cred === "expired") T = token("deploy:read", -120);
        if (cred === "scope") T = token("profile");
        if (cred === "valid") T = token("deploy:read");
        if (T) headers.Authorization = "Bearer " + short(T);
        const msg = SPEC.msg("user", ["Is checkout-api 2.14.0 ready?"]);
        if (cred === "meta") msg.metadata = { authorization: "Bearer " + short(token("deploy:read")) };
        bw.add({ actor: "client", label: "SendMessage · " + CREDS.find(function (c) { return c.v === cred; }).label, http: SPEC.post("/a2a/release", headers), body: SPEC.rpc("SendMessage", { message: msg }), hl: cred === "meta" ? ["metadata"] : [] });
        if (T) {
          const c = claimsOf(T);
          claims.hidden = false;
          claims.innerHTML = "<span class='http-h'>decoded JWT payload</span>\n" + PG.jsonHTML(c, ["scope", "exp"]) + (c.exp < Date.now() / 1000 ? "\n<span class='j-absent'>exp is in the past</span>" : "");
        }
        const R = {
          none: [401, 'Bearer realm="agents.example.com", scope="deploy:read"', "No credentials. 401 with a challenge naming what's expected."],
          malformed: [401, 'Bearer error="invalid_token", error_description="malformed token"', "Unparseable token: still 401. The server doesn't know who you are."],
          expired: [401, 'Bearer error="invalid_token", error_description="token expired"', "Expired token: 401. The client should refresh and retry."],
          scope: [403, 'Bearer error="insufficient_scope", scope="deploy:read"', "The token is valid, so the caller is known, but it lacks deploy:read. 403 Forbidden."],
          meta: [401, 'Bearer realm="agents.example.com", scope="deploy:read"', "The token is in the payload, not a header, so the server sees no credentials. Worse, the token is now in logs and task history. Credentials belong in headers."],
        }[cred];
        if (!R) { bw.add({ kind: "in", actor: "server", label: "Authenticated and authorized · Task WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(3), "ctx-" + PG.hex(3), "WORKING") } } }); return; }
        bw.add({ kind: "in", actor: "server", label: (R[0] === 401 ? "Unauthorized" : "Forbidden") + " · " + R[2].split(".")[0], status: String(R[0]),
          http: SPEC.res(R[0], { "WWW-Authenticate": R[1], "Content-Type": "application/json" }), body: { error: R[0] === 401 ? "unauthenticated" : "forbidden" }, note: R[2], open: true });
      }
    },
    quiz: [
      { q: "Where do A2A clients put credentials?",
        opts: ["In message.metadata", "In HTTP headers (or gRPC metadata) on every request", "In the Agent Card", "Only on the first request of a context"],
        a: 1, why: "Credentials travel in protocol headers on every request. Payloads are logged, stored and forwarded." },
      { q: "A valid token lacks the required scope. Which status?",
        opts: ["401 Unauthorized", "403 Forbidden", "404 Not Found", "200 with an error Task"],
        a: 1, why: "The caller is authenticated but not permitted. 401 is for missing, malformed or expired credentials." },
      { q: "Which OAuth flow fits one agent calling another with no user involved?",
        opts: ["Authorization code + PKCE", "Client credentials", "Device code", "Implicit"],
        a: 1, why: "Client credentials authenticates the client agent itself. Implicit is deprecated in 1.0." },
      { q: "What does PKCE protect against?",
        opts: ["Expired tokens", "An intercepted authorization code being redeemed by someone else", "Replay of Agent Cards", "SSRF"],
        a: 1, why: "Only the client holding the original code_verifier can redeem the code." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Authorization, scoping & in-task auth
   * ════════════════════════════════════════════════════════════════════ */
  function isBlockedHost(host) {
    if (host === "localhost" || /\.localhost$/.test(host)) return "loopback hostname";
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const a = +m[1], b = +m[2];
    if (a === 127) return "loopback address";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private network address";
    if (a === 169 && b === 254) return "link-local address (cloud metadata service lives here)";
    if (a === 0) return "unspecified address";
    return null;
  }

  PG.lesson({
    id: "authz",
    track: "security",
    title: "Authorization and in-task auth",
    short: "Authorization & in-task auth",
    thesis: "Authentication says who you are. Authorization decides what you may do: which skills, which actions, which tasks. And sometimes an agent discovers mid-task that it needs a credential it doesn't have.",
    refs: "Spec §7.5 · §7.6 in-task authorization · §13.1 scoping · §13.2 push security",
    brief: `
      <h2>Server authorization</h2>
      <p>Once a request is authenticated, the server decides using its own policy. The spec lists what it MAY consider: the skills requested, the actions attempted within tasks, data access policies and OAuth scopes (§7.5).</p>
      <h2>Scoping is mandatory</h2>
      <ul>
        <li><code>ListTasks</code> MUST return only tasks visible to the caller.</li>
        <li>Get, Cancel, Subscribe and push-config operations MUST check the caller's rights to that task.</li>
        <li>Answer an inaccessible task with <code>TaskNotFoundError</code>, the same as a missing one, so ids can't be probed.</li>
      </ul>
      <h2>In-task authorization</h2>
      <p>An agent may need something mid-task: an OAuth token for a downstream API, or a human's approval. It moves the task to <code>TASK_STATE_AUTH_REQUIRED</code> with a status message explaining what's needed (unless negotiated out-of-band or via an extension). The credential may arrive out-of-band, and the agent may simply continue; or the client may reply on the task.</p>
      <p>If the client is itself an agent, it may pass the request up by moving <em>its own</em> task to <code>AUTH_REQUIRED</code>, forming a chain back to a human.</p>
      <div class="note spec"><span class="note-label">Spec</span>AUTH_REQUIRED by itself is never authorization for anything (§7.6.4). What a credential allows is defined by the agent, the issuer, or an extension.</div>
      <h2>Push webhooks are an attack surface</h2>
      <p>The agent calls a URL the client supplied. Agents SHOULD validate webhook URLs against SSRF (private ranges, loopback, cloud metadata) and MUST authenticate to the webhook; receivers MUST verify it.</p>
      <div class="note ours"><span class="note-label">In this repo</span>Lab 55 puts an OPA check in the agents' <code>before_tool_callback</code>: authorization per tool call, with a change freeze and a no-prod rule. That is §7.5 “actions attempted within tasks”, enforced inside the agent.</div>`,
    lab: function (bench, api) {
      /* Lab A: scoping */
      const a = PG.lab(bench, "Whose tasks can you see?", "Lab · §13.1 scoping");
      const TASKS = [
        { id: "task-a1", owner: "alice-agent", state: "WORKING", what: "deploy checkout-api" },
        { id: "task-a2", owner: "alice-agent", state: "COMPLETED", what: "scan billing-worker" },
        { id: "task-b1", owner: "bob-agent", state: "INPUT_REQUIRED", what: "deploy search-indexer" },
      ];
      let caller = "bob-agent", scoped = true;
      const table = h("div", { class: "table-wrap" });
      const aw = PG.wire(a.body, { title: "Wire" });
      function paintTable(visible) {
        table.innerHTML = "";
        const t = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["task", "owner", "state", "work", "visible to " + caller].map(function (x) { return h("th", { text: x }); }))));
        const tb = h("tbody");
        TASKS.forEach(function (x) {
          const vis = !visible || visible.indexOf(x.id) >= 0;
          const leak = vis && x.owner !== caller;
          tb.appendChild(h("tr", {}, h("td", { class: "mono", text: x.id }), h("td", { class: "mono", text: x.owner }), h("td", {}, PG.stateChip(x.state)), h("td", { text: x.what }),
            h("td", {}, visible ? h("span", { class: "chip " + (leak ? "err" : vis ? "ok" : ""), text: leak ? "LEAKED" : vis ? "yes" : "hidden" }) : h("span", { class: "muted", text: "—" }))));
        });
        t.appendChild(tb);
        table.appendChild(t);
      }
      function headers() { return { Authorization: "Bearer " + short(PG.fakeJwt({ sub: caller, scope: "deploy:read" })) }; }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Caller:" }),
          PG.seg([{ v: "alice-agent", label: "Alice's agent" }, { v: "bob-agent", label: "Bob's agent" }], caller, function (v) { caller = v; paintTable(null); }, "Caller"),
          PG.switch("scope-on", "Server enforces scoping", scoped, function (v) { scoped = v; })),
        h("div", { class: "row" },
          h("button", { class: "btn client", type: "button", text: "ListTasks", onclick: function () {
            const vis = TASKS.filter(function (x) { return !scoped || x.owner === caller; }).map(function (x) { return x.id; });
            aw.add({ actor: "client", label: "ListTasks as " + caller, http: SPEC.post("/a2a/release", headers()), body: SPEC.rpc("ListTasks", { pageSize: 50 }) });
            const leak = vis.some(function (id) { return TASKS.find(function (x) { return x.id === id; }).owner !== caller; });
            aw.add({ kind: "in", actor: "server", label: vis.length + " task(s)" + (leak ? ": includes someone else's" : ""), status: leak ? "LEAK" : "200", tone: leak ? "err" : "ok", http: SPEC.res(200),
              body: { jsonrpc: "2.0", id: 1, result: { tasks: vis.map(function (id) { const x = TASKS.find(function (y) { return y.id === id; }); return SPEC.task(x.id, "ctx-" + x.owner.slice(0, 1), x.state); }), nextPageToken: "" } } });
            paintTable(vis);
          } }),
          h("button", { class: "btn client", type: "button", text: "GetTask task-a1", onclick: function () { probe("GetTask"); } }),
          h("button", { class: "btn danger", type: "button", text: "CancelTask task-a1", onclick: function () { probe("CancelTask"); } })),
        table), aw.el);
      function probe(method) {
        aw.add({ actor: "client", label: method + " task-a1 as " + caller, http: SPEC.post("/a2a/release", headers()), body: SPEC.rpc(method, { id: "task-a1" }) });
        const own = caller === "alice-agent";
        if (scoped && !own) {
          aw.add({ kind: "in", actor: "server", label: "TaskNotFoundError (not 403: don't confirm it exists)", status: "-32001", http: SPEC.res(200), body: SPEC.rpcErr("TaskNotFoundError"), open: true });
        } else {
          const st = method === "CancelTask" ? "CANCELED" : "WORKING";
          aw.add({ kind: "in", actor: "server", label: own ? "Your own task · " + st : "Alice's task · " + st + (method === "CancelTask" ? ". Bob just cancelled Alice's deployment." : ". Bob can read Alice's work."), status: own ? "200" : "LEAK", tone: own ? "ok" : "err", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: SPEC.task("task-a1", "ctx-a", st) } });
          if (method === "CancelTask" && own) TASKS[0].state = "CANCELED";
        }
      }
      paintTable(null);

      /* Lab B: scopes vs skills */
      const b = PG.lab(bench, "Scopes decide which skills run", "Lab · §7.5 authorization");
      const have = { "deploy:read": true, "deploy:write": false, "deploy:prod": false };
      const ACTIONS = [
        { label: "Readiness check", need: "deploy:read", text: "Is checkout-api 2.14.0 ready for production?" },
        { label: "Deploy to staging", need: "deploy:write", text: "Deploy checkout-api 2.14.0 to staging" },
        { label: "Deploy to production", need: "deploy:prod", text: "Deploy checkout-api 2.14.0 to production" },
        { label: "Emergency rollback", need: "deploy:prod", text: "Roll back the last production deploy" },
      ];
      const bw = PG.wire(b.body, { title: "Wire" });
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Token scopes:" }),
          Object.keys(have).map(function (s) { return PG.switch("sc-" + s.replace(":", "-"), s, have[s], function (v) { have[s] = v; }); })),
        h("div", { class: "row" }, ACTIONS.map(function (x) {
          return h("button", { class: "btn small", type: "button", text: x.label, onclick: function () {
            const scopes = Object.keys(have).filter(function (s) { return have[s]; });
            bw.add({ actor: "client", label: "SendMessage · “" + x.text + "”", http: SPEC.post("/a2a/release", { Authorization: "Bearer " + short(PG.fakeJwt({ sub: "ops-concierge", scope: scopes.join(" ") })) }), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", [x.text]) }) });
            if (!scopes.length) { bw.add({ kind: "in", actor: "server", label: "Token has no scopes", status: "403", http: SPEC.res(403, { "WWW-Authenticate": 'Bearer error="insufficient_scope"' }) }); return; }
            if (have[x.need]) {
              bw.add({ kind: "in", actor: "server", label: "Allowed (" + x.need + ") · Task WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(3), "ctx-" + PG.hex(2), "WORKING") } } });
            } else {
              bw.add({ kind: "in", actor: "server", label: "Denied: skill needs " + x.need + " · Task REJECTED", status: "denied", tone: "err", http: SPEC.res(200),
                body: { jsonrpc: "2.0", id: 1, result: { task: { id: "task-" + PG.hex(3), contextId: "ctx-" + PG.hex(2), status: { state: "TASK_STATE_REJECTED", message: SPEC.msg("agent", ["This requires scope " + x.need + ", which your token lacks."]) } } } },
                note: "The agent only learns which skill it needs after reading the message, so it rejects the task with an explanation. A gateway can deny earlier, at the HTTP layer, only for rules it can see without understanding the request." });
            }
          } });
        }))), bw.el);

      /* Lab C: AUTH_REQUIRED chain */
      const c = PG.lab(bench, "A credential needed mid-task", "Lab · §7.6 AUTH_REQUIRED chain");
      const stage = PG.stage(c.body, {
        size: "tall",
        actors: [
          { id: "user", role: "user", label: "Alice", sub: "human", x: 9, y: 58 },
          { id: "client", role: "client", label: "Concierge", sub: "task T1", x: 36, y: 58 },
          { id: "agent", role: "server", label: "Release agent", sub: "task T2", x: 66, y: 58 },
          { id: "gh", role: "auth", label: "GitHub OAuth", sub: "github.com", x: 88, y: 16 },
        ],
        links: [["user", "client"], ["client", "agent"], ["agent", "gh"], ["user", "gh"]],
      });
      const cw = PG.wire(c.body, { title: "Wire" });
      const next = h("button", { class: "btn primary", type: "button", text: "Next step" });
      const restart = h("button", { class: "btn", type: "button", text: "Restart" });
      c.body.insertBefore(h("div", { class: "row" }, next, restart), stage.el);
      let n = 0;
      const STEPS = [
        async function () {
          stage.caption("1 · The concierge (T1) delegates a release that must push a git tag to Alice's repo.");
          stage.badge("client", PG.stateChip("WORKING"));
          cw.add({ actor: "client", label: "SendStreamingMessage · “Release checkout-api and tag acme/checkout”", http: SPEC.post("/a2a/release", { Authorization: "Bearer <concierge token>" }), body: SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", ["Release checkout-api 2.14.0 and tag acme/checkout"]) }) });
          await stage.send("client", "agent", "SendStreamingMessage");
          stage.badge("agent", PG.stateChip("WORKING"));
        },
        async function () {
          stage.caption("2 · The release agent needs repo:write on Alice's repo. It has no such credential, so T2 goes AUTH_REQUIRED with a message saying exactly what it needs.");
          cw.add({ kind: "evt", actor: "server", label: "statusUpdate · T2 AUTH_REQUIRED", sse: [SPEC.statusUpdate("T2", "ctx-rel", "AUTH_REQUIRED", "Needs GitHub scope repo:write on acme/checkout. Authorize: https://github.com/login/oauth/authorize?client_id=release-agent&scope=repo")], open: true });
          await stage.send("agent", "client", "T2 · AUTH_REQUIRED", { tone: "auth" });
          stage.badge("agent", PG.stateChip("AUTH_REQUIRED"));
        },
        async function () {
          stage.caption("3 · The concierge can't grant Alice's permission itself, so it moves its own task T1 to AUTH_REQUIRED and passes the request up. That's the chain.");
          cw.add({ kind: "evt", actor: "client", label: "statusUpdate · T1 AUTH_REQUIRED (relayed to Alice)", sse: [SPEC.statusUpdate("T1", "ctx-conc", "AUTH_REQUIRED", "The release agent needs GitHub access to acme/checkout.")] });
          await stage.send("client", "user", "T1 · AUTH_REQUIRED", { tone: "auth" });
          stage.badge("client", PG.stateChip("AUTH_REQUIRED"));
        },
        async function () {
          stage.caption("4 · Alice consents on GitHub. This happens entirely outside A2A.");
          cw.add({ kind: "note", actor: "user", label: "Alice approves repo:write for release-agent at github.com" });
          await stage.send("user", "gh", "consent");
        },
        async function () {
          stage.caption("5 · The token reaches the release agent out-of-band. The agent kept its stream open and may resume without any new message.");
          cw.add({ kind: "note", actor: "auth", label: "OAuth callback delivers a token to release-agent (out-of-band)" });
          await stage.send("gh", "agent", "token", { tone: "auth" });
          cw.add({ kind: "evt", actor: "server", label: "statusUpdate · T2 WORKING", sse: [SPEC.statusUpdate("T2", "ctx-rel", "WORKING")] });
          stage.badge("agent", PG.stateChip("WORKING"));
        },
        async function () {
          stage.caption("6 · Both tasks complete. Note what did not happen: AUTH_REQUIRED alone granted nothing; the credential issued by GitHub did.");
          cw.add({ kind: "evt", actor: "server", label: "artifactUpdate + statusUpdate · T2 COMPLETED", sse: [SPEC.statusUpdate("T2", "ctx-rel", "COMPLETED")] });
          await stage.send("agent", "client", "T2 · COMPLETED");
          stage.badge("agent", PG.stateChip("COMPLETED"));
          cw.add({ kind: "evt", actor: "client", label: "statusUpdate · T1 COMPLETED", sse: [SPEC.statusUpdate("T1", "ctx-conc", "COMPLETED")] });
          await stage.send("client", "user", "T1 · COMPLETED");
          stage.badge("client", PG.stateChip("COMPLETED"));
        },
      ];
      next.addEventListener("click", async function () {
        if (n >= STEPS.length) { PG.toast("Chain complete. Restart to replay."); return; }
        next.disabled = true;
        await STEPS[n++]();
        if (!api.alive()) return;
        next.disabled = false;
        next.textContent = n >= STEPS.length ? "Done" : "Next step (" + (n + 1) + "/" + STEPS.length + ")";
      });
      restart.addEventListener("click", function () { n = 0; cw.clear(); ["client", "agent"].forEach(function (x) { stage.badge(x, ""); }); stage.caption(""); next.textContent = "Next step"; next.disabled = false; });

      /* Lab D: webhook SSRF */
      const d = PG.lab(bench, "Is this webhook URL safe to call?", "Lab · §13.2 SSRF guard");
      const url = h("input", { class: "inline", id: "hook-url", type: "text", value: "http://169.254.169.254/latest/meta-data/iam/", style: { flex: "1 1 280px", fontFamily: "var(--font-mono)", fontSize: "12.5px" }, "aria-label": "Webhook URL" });
      const verdict = h("div", { class: "result" });
      function check() {
        let u;
        try { u = new URL(url.value); } catch (e) { verdict.className = "result err"; verdict.textContent = "Not a URL. Reject the push config."; return; }
        const problems = [], warns = [];
        if (u.protocol !== "https:") warns.push("not HTTPS: the payload and its credentials travel in clear text");
        const bad = isBlockedHost(u.hostname);
        if (bad) problems.push(bad);
        if (u.username || u.password) problems.push("embedded credentials in the URL");
        if (problems.length) { verdict.className = "result err"; verdict.innerHTML = "<b>Block.</b> " + problems.join("; ") + ". An agent that called this would be making requests into its own network on an attacker's behalf."; }
        else if (warns.length) { verdict.className = "result warn"; verdict.innerHTML = "<b>Allow with caution.</b> " + warns.join("; ") + "."; }
        else { verdict.className = "result ok"; verdict.innerHTML = "<b>Looks safe.</b> Public HTTPS host. Still resolve DNS and re-check the IP at connect time, because a public name can point at a private address (DNS rebinding)."; }
      }
      url.addEventListener("input", check);
      d.body.append(h("div", { class: "row" }, ["https://concierge.example.com/a2a/webhook", "http://169.254.169.254/latest/meta-data/iam/", "http://localhost:8001/ops/jobs", "https://10.0.3.7/hook", "http://hooks.example.com/a2a"].map(function (x) {
        return h("button", { class: "btn small", type: "button", text: x.replace(/^https?:\/\//, "").slice(0, 28), title: x, onclick: function () { url.value = x; check(); } });
      })), h("div", { class: "row" }, url), verdict);
      check();
    },
    quiz: [
      { q: "Bob's agent calls GetTask on Alice's task id. What should a correctly scoped server return?",
        opts: ["403 Forbidden", "The task, read-only", "TaskNotFoundError, as if it didn't exist", "401 Unauthorized"],
        a: 2, why: "TaskNotFoundError covers “not accessible”, so callers can't probe which ids exist." },
      { q: "A remote agent needs a GitHub token mid-task. Which state does it use?",
        opts: ["INPUT_REQUIRED", "AUTH_REQUIRED, with a status message explaining what it needs", "FAILED", "REJECTED"],
        a: 1, why: "AUTH_REQUIRED is the in-task authorization state. The status message MUST explain the required authorization unless negotiated otherwise." },
      { q: "A client registers <code>http://169.254.169.254/...</code> as its push webhook. What should the agent do?",
        opts: ["Call it; the client asked", "Reject it: link-local cloud metadata is a classic SSRF target", "Call it over HTTPS instead", "Ignore the scheme and use the path"],
        a: 1, why: "Agents SHOULD validate webhook URLs against SSRF: private, loopback and link-local addresses." },
    ],
  });
})();
