/* Track 5 — Authorization: who signs in and how, the OAuth flow, finding the
 * authorization server and registering, tokens over time, scopes and
 * passthrough, client credentials and enterprise-managed authorization. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  const MCP = "https://release-tools.example.com/mcp";
  const PRM = "https://release-tools.example.com/.well-known/oauth-protected-resource/mcp";
  const AS = "https://auth.example.com";
  const CIMD = "https://ops-console.example.com/oauth/client.json";
  const REDIRECT = "http://127.0.0.1:33418/callback";


  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Choosing how to authorize
   * ════════════════════════════════════════════════════════════════════ */
  const EXT_CC = "io.modelcontextprotocol/oauth-client-credentials";
  const EXT_EMA = "io.modelcontextprotocol/enterprise-managed-authorization";
  PG.lesson({
    id: "auth-models",
    track: "auth",
    title: "Who signs in, and how",
    short: "Choosing an auth model",
    thesis: "MCP authorization is OAuth, and the first job is naming the OAuth roles: the MCP server is the resource server, the MCP client is the OAuth client, and an authorization server issues tokens. Then three questions pick the flow: is the server remote, is a person present, and does an organization manage access?",
    refs: "Spec 2026-07-28 · Authorization §Overview, §Roles · ext-auth: OAuth Client Credentials (draft), Enterprise-Managed Authorization (stable)",
    brief: `
      <h2>The same boxes, with their OAuth names</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>MCP name</th><th>OAuth name</th><th>Example</th></tr></thead><tbody>
        <tr><td>MCP server (the thing with the tools)</td><td><strong>resource server</strong>: accepts or refuses tokens</td><td><code>release-tools</code></td></tr>
        <tr><td>MCP client (inside the host app)</td><td><strong>client</strong>: gets tokens and sends them</td><td>ops-console's connector</td></tr>
        <tr><td>(not an MCP role)</td><td><strong>authorization server</strong>: signs people in and issues tokens</td><td>Okta, Entra ID, Auth0, Keycloak, or one built into the server</td></tr>
        <tr><td>the user</td><td><strong>resource owner</strong>: grants access</td><td>you</td></tr>
      </tbody></table></div>
      <p>The MCP server never sees a password. It only checks tokens. The authorization server can be a separate company's service.</p>
      <h2>Pick the flow</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Situation</th><th>Use</th><th>Status</th></tr></thead><tbody>
        <tr><td>Local server over stdio</td><td>No OAuth. The server reads credentials from its environment.</td><td>Core spec: stdio SHOULD NOT use the OAuth flow</td></tr>
        <tr><td>Remote server, a person using an app</td><td>Authorization code + PKCE (the core flow)</td><td>Core spec</td></tr>
        <tr><td>Remote server, no person (CI job, nightly agent)</td><td>Client credentials: the client signs in as itself</td><td>Extension <code>${EXT_CC}</code>, draft</td></tr>
        <tr><td>Remote server, employees of a company with SSO</td><td>Enterprise-managed: the company's identity provider decides</td><td>Extension <code>${EXT_EMA}</code>, stable</td></tr>
      </tbody></table></div>
      <div class="note spec"><span class="note-label">Spec</span>Authorization is OPTIONAL for MCP. When an HTTP server supports it, it SHOULD follow the spec. Extensions are opt-in on both sides: the client lists them in <code>clientCapabilities.extensions</code>, the server in <code>server/discover</code>.</div>
      <div class="note"><span class="note-label">Not this</span>Authorizing the <em>MCP server</em> to a third-party API on your behalf is a different problem: URL elicitation (Asking the client track). And the MCP server never forwards your token to another API (Scopes &amp; passthrough).</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Answer three questions", "Lab · stdio · auth code · client credentials · enterprise");
      const q = { remote: "yes", person: "yes", org: "no" };
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "Person", sub: "", x: 12, y: 16 },
          { id: "client", role: "client", label: "MCP client", sub: "OAuth client", x: 14, y: 70 },
          { id: "idp", role: "auth", label: "Company IdP", sub: "SSO", x: 50, y: 14, glyph: "I" },
          { id: "as", role: "auth", label: "Auth server", x: 84, y: 18 },
          { id: "server", role: "server", label: "MCP server", x: 84, y: 74 },
        ],
        links: [["user", "client"], ["client", "idp"], ["client", "as"], ["client", "server"], ["user", "idp"], ["user", "as"]],
      });
      const out = h("div", { class: "result" });
      const show = h("button", { class: "btn primary", type: "button", text: "Show the flow" });
      function pick() {
        if (q.remote === "no") return "stdio";
        if (q.person === "no") return "cc";
        return q.org === "yes" ? "ema" : "code";
      }
      const TEXT = {
        stdio: ["<b>No OAuth.</b> The host starts the server with credentials in its environment (for example a deploy-API token from your config). The server uses them for the APIs behind it.", ["client", "server"]],
        code: ["<b>Authorization code + PKCE.</b> You sign in once in a browser at the authorization server; the client gets a token for this one server.", ["user", "client", "as", "server"]],
        cc: ["<b>Client credentials</b> (extension, draft). No browser, no person: the client proves who it is with a signed JWT (or a secret) and gets a token for itself.", ["client", "as", "server"]],
        ema: ["<b>Enterprise-managed</b> (extension, stable). You signed in to the app with company SSO; the company IdP decides whether you may use this server and hands the client a grant to trade for a token. No per-server consent screen.", ["user", "client", "idp", "as", "server"]],
      };
      function paint() {
        const k = pick(), t = TEXT[k];
        ["user", "client", "idp", "as", "server"].forEach(function (id) { stage.set(id, { dim: t[1].indexOf(id) < 0 }); });
        PG.setResult(out, "info", t[0]);
      }
      async function play() {
        show.disabled = true;
        const k = pick();
        stage.badge("server", null);
        if (k === "stdio") { await stage.send("client", "server", "spawn · env vars"); await stage.send("client", "server", "tools/call"); }
        else if (k === "code") {
          await stage.send("client", "server", "tools/call", {}); await stage.send("server", "client", "401", { tone: "err" });
          await stage.send("user", "as", "sign in + consent"); await stage.send("as", "client", "token"); await stage.send("client", "server", "Bearer");
        } else if (k === "cc") {
          await stage.send("client", "as", "client_credentials + JWT"); await stage.send("as", "client", "token"); await stage.send("client", "server", "Bearer");
        } else {
          await stage.send("user", "idp", "SSO (once)"); await stage.send("client", "idp", "token exchange"); await stage.send("idp", "client", "ID-JAG");
          await stage.send("client", "as", "jwt-bearer grant"); await stage.send("as", "client", "token"); await stage.send("client", "server", "Bearer");
        }
        stage.badge("server", "✓ " + (k === "stdio" ? "trusted local process" : "token for this server"));
        show.disabled = false;
      }
      show.addEventListener("click", play);
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small", text: "Server is remote (HTTP)?" }), PG.seg([{ v: "yes", label: "Yes" }, { v: "no", label: "No, local stdio" }], "yes", function (v) { q.remote = v; paint(); }, "Remote")),
        h("div", { class: "row" }, h("span", { class: "small", text: "A person is using it?" }), PG.seg([{ v: "yes", label: "Yes" }, { v: "no", label: "No, a job or daemon" }], "yes", function (v) { q.person = v; paint(); }, "Person")),
        h("div", { class: "row" }, h("span", { class: "small", text: "Company SSO manages access?" }), PG.seg([{ v: "no", label: "No" }, { v: "yes", label: "Yes" }], "no", function (v) { q.org = v; paint(); }, "Org")),
        h("div", { class: "row" }, show), out), stage.el);
      paint();

      const b = PG.lab(bench, "Name the OAuth role", "Lab · same boxes, OAuth words");
      PG.sorter(b.body, [
        { t: "release-tools, checking the token on every request", a: "Resource server", why: "The MCP server is the OAuth resource server." },
        { t: "ops-console's MCP connector, holding the token", a: "OAuth client", why: "The MCP client is the OAuth client." },
        { t: "auth.example.com, where you type your password", a: "Authorization server", why: "It authenticates you and issues tokens; the MCP server never sees your password." },
        { t: "You, clicking Allow on the consent screen", a: "Resource owner", why: "The person granting access." },
        { t: "A nightly CI job calling release-tools with its own credentials", a: "OAuth client", why: "Still the client: it just authenticates as itself (client credentials)." },
        { t: "The company's Okta tenant deciding who may use release-tools", a: "Authorization server", why: "In enterprise-managed auth the IdP is an authorization server too: it issues the ID-JAG grant. The MCP server's own authorization server then issues the access token." },
      ], ["Resource server", "OAuth client", "Authorization server", "Resource owner"]);
    },
    quiz: [
      { q: "In OAuth terms, what is an MCP server?",
        opts: ["The authorization server", "The resource server", "The OAuth client", "The resource owner"],
        a: 1, why: "It holds the resources (tools, data) and accepts or refuses tokens." },
      { q: "A nightly job with no person present needs a remote MCP server. Which mechanism?",
        opts: ["Authorization code + PKCE", "The OAuth Client Credentials extension", "Form elicitation for a password", "Environment variables on the remote server"],
        a: 1, why: "Machine-to-machine: the client authenticates as itself." },
      { q: "A local stdio server needs a deploy-API key. Where does it come from?",
        opts: ["The OAuth flow", "Its environment, set by the host's configuration", "A form elicitation", "The model"],
        a: 1, why: "stdio SHOULD NOT use the OAuth flow; credentials come from the environment." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: OAuth for remote servers
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "oauth",
    track: "auth",
    title: "Signing in to a remote server",
    short: "OAuth flow",
    thesis: "A remote MCP server is an OAuth 2.1 resource server. It answers 401 with a pointer to its metadata; the client finds the authorization server, identifies itself with a URL, signs the user in with PKCE, asks for a token for exactly this server, and sends it on every request.",
    refs: "Spec 2026-07-28 · Authorization · Authorization server discovery · Client registration · Security considerations · RFC 9728, 8414, 8707, 9207",
    brief: `
      <h2>The steps</h2>
      <ol>
        <li><strong>401.</strong> The server answers an unauthenticated request with <code>WWW-Authenticate: Bearer resource_metadata="…"</code> (and often <code>scope="…"</code>).</li>
        <li><strong>Protected Resource Metadata</strong> (RFC 9728), from that URL or from <code>/.well-known/oauth-protected-resource[/path]</code>: the server's canonical <code>resource</code> URI, its <code>authorization_servers</code>, <code>scopes_supported</code>.</li>
        <li><strong>Authorization server metadata</strong> (RFC 8414 or OpenID discovery; clients try several well-known paths). It MUST list <code>code_challenge_methods_supported</code>, or the client MUST refuse: no PKCE, no flow.</li>
        <li><strong>Who is the client?</strong> In order: pre-registered credentials; a <strong>Client ID Metadata Document</strong> (the <code>client_id</code> is an https URL to a JSON file with <code>client_id</code>, <code>client_name</code>, <code>redirect_uris</code>) when the server says it supports them; Dynamic Client Registration only as a deprecated fallback.</li>
        <li><strong>Authorize</strong> in the browser with PKCE (<code>S256</code>), <code>state</code>, the scopes, and <code>resource=</code> the server's canonical URI (RFC 8707).</li>
        <li><strong>Redirect back</strong> with <code>code</code>, <code>state</code> and <code>iss</code>. Check that <code>state</code> matches and that <code>iss</code> is the issuer you started with (RFC 9207, stops mix-up attacks).</li>
        <li><strong>Token request</strong> with the <code>code_verifier</code> and the same <code>resource</code>.</li>
        <li><strong>Use it</strong>: <code>Authorization: Bearer …</code> on every request, never in the URL. The server checks the token was issued <em>for it</em> (audience) and answers 401 otherwise.</li>
      </ol>
      <div class="note spec"><span class="note-label">Spec</span>Redirect URIs must be localhost or https, matched exactly. Credentials are bound to the authorization server that issued them: key them by issuer and re-register if it changes. stdio servers don't use this flow.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Walk the flow, then break it", "Lab · 401 · PRM · AS metadata · CIMD · PKCE · resource · iss");
      let fault = "none";
      const stage = PG.stage(a.body, {
        actors: [
          { id: "browser", role: "user", label: "Browser", sub: "you sign in", x: 12, y: 16 },
          { id: "client", role: "client", label: "MCP client", sub: "ops-console", x: 14, y: 72 },
          { id: "auth", role: "auth", label: "Auth server", sub: "auth.example.com", x: 56, y: 16 },
          { id: "server", role: "server", label: "release-tools", sub: "MCP server", x: 86, y: 72 },
        ],
        links: [["browser", "client"], ["browser", "auth"], ["client", "auth"], ["client", "server"], ["auth", "client"]],
      });
      const wire = PG.wire(a.body);
      const steps = PG.steps(a.body, ["401 + resource_metadata", "Protected Resource Metadata", "Authorization server metadata", "Client ID Metadata Document", "Authorize (PKCE, resource, state)", "Redirect back (code, state, iss)", "Token request", "Call with Bearer"]);
      const verdict = h("div", { class: "result", text: "Run the flow as it should be, then pick a fault." });
      const run = h("button", { class: "btn primary", type: "button", text: "Run" });
      a.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" }, PG.seg([
        { v: "none", label: "Everything right" }, { v: "pkce", label: "AS doesn't advertise PKCE" }, { v: "resource", label: "Client omits resource" },
        { v: "iss", label: "Response has another iss" }, { v: "query", label: "Token in the URL" },
      ], "none", function (v) { fault = v; }, "Fault"), run), verdict), stage.el);
      function fail(i, html) { steps.mark(i, "fail"); PG.setResult(verdict, "ok", html); run.disabled = false; }
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); steps.reset();
        const verifier = "(random 43–128 chars, kept by the client)";
        steps.mark(0, "run");
        if (!(await stage.send("client", "server", "tools/list"))) return;
        wire.add({ actor: "client", label: "POST /mcp tools/list (no token)", http: SPEC.post("tools/list", null, null, { auth: false, host: "release-tools.example.com" }), body: SPEC.rpc("tools/list", {}, 1) });
        await stage.send("server", "client", "401", { tone: "err" });
        wire.add({ kind: "in", actor: "server", label: "401 · WWW-Authenticate", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer resource_metadata="' + PRM + '", scope="releases:read"' }) });
        steps.mark(0, "pass"); steps.mark(1, "run");
        await stage.send("client", "server", "GET PRM");
        wire.add({ actor: "client", label: "GET " + PRM.replace("https://release-tools.example.com", ""), http: { start: "GET /.well-known/oauth-protected-resource/mcp HTTP/1.1", headers: { Host: "release-tools.example.com" } } });
        await stage.send("server", "client", "PRM");
        wire.add({ kind: "in", actor: "server", label: "Protected Resource Metadata", status: "200", http: SPEC.res(200), body: { resource: MCP, authorization_servers: [AS], scopes_supported: ["releases:read", "releases:write"], bearer_methods_supported: ["header"] }, hl: ["resource", "authorization_servers"] });
        steps.mark(1, "pass"); steps.mark(2, "run");
        await stage.send("client", "auth", "GET AS metadata");
        const asMeta = { issuer: AS, authorization_endpoint: AS + "/authorize", token_endpoint: AS + "/token", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true };
        if (fault === "pkce") delete asMeta.code_challenge_methods_supported;
        await stage.send("auth", "client", "metadata");
        wire.add({ kind: "in", actor: "auth", label: "GET /.well-known/oauth-authorization-server", status: "200", http: SPEC.res(200), body: asMeta, hl: ["code_challenge_methods_supported", "client_id_metadata_document_supported"] });
        if (fault === "pkce") return fail(2, "The client refused to continue: <code>code_challenge_methods_supported</code> is missing, which means this server can't be relied on for PKCE. Without PKCE an intercepted code could be redeemed by someone else.");
        steps.mark(2, "pass"); steps.mark(3, "run");
        wire.add({ kind: "note", label: "No pre-registered credentials for this AS, and it supports Client ID Metadata Documents, so client_id is a URL." });
        await stage.send("auth", "client", "GET client.json", { tone: "auth" });
        wire.add({ kind: "in", actor: "client", label: "GET " + CIMD + " (fetched by the auth server)", status: "200", http: SPEC.res(200), body: { client_id: CIMD, client_name: "Ops Console", client_uri: "https://ops-console.example.com", redirect_uris: [REDIRECT], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }, hl: ["client_id", "redirect_uris"] });
        steps.mark(3, "pass"); steps.mark(4, "run");
        const state = PG.hex(8);
        const params = ["response_type=code", "client_id=" + encodeURIComponent(CIMD), "redirect_uri=" + encodeURIComponent(REDIRECT), "code_challenge=(SHA-256 of the verifier, base64url)", "code_challenge_method=S256", "scope=releases:read", "state=" + state];
        if (fault !== "resource") params.push("resource=" + encodeURIComponent(MCP));
        await stage.send("client", "browser", "open /authorize");
        await stage.send("browser", "auth", "GET /authorize");
        wire.add({ actor: "user", label: "GET /authorize" + (fault === "resource" ? " (no resource parameter)" : " · resource=" + MCP), http: { start: "GET /authorize?" + params.join("&") + " HTTP/1.1", headers: { Host: "auth.example.com" } } });
        steps.mark(4, "pass"); steps.mark(5, "run");
        stage.badge("browser", "signed in ✓");
        const iss = fault === "iss" ? "https://login.attacker.example" : AS;
        await stage.send("auth", "browser", "302 → callback");
        await stage.send("browser", "client", "code, state, iss");
        stage.badge("browser", null);
        wire.add({ kind: "in", actor: "auth", label: "302 → " + REDIRECT + "?code=…&state=" + state + "&iss=" + iss, status: "302", http: { start: "HTTP/1.1 302 Found", headers: { Location: REDIRECT + "?code=(one-time code)&state=" + state + "&iss=" + encodeURIComponent(iss) } } });
        if (fault === "iss") return fail(5, "The <code>iss</code> in the response isn't the issuer the client started with. That's the signature of a mix-up attack: a malicious authorization server trying to get the client to send it a code from the honest one. The client MUST NOT redeem the code.");
        steps.mark(5, "pass"); steps.mark(6, "run");
        await stage.send("client", "auth", "POST /token");
        const tokBody = "grant_type=authorization_code&code=(the code)&redirect_uri=" + encodeURIComponent(REDIRECT) + "&client_id=" + encodeURIComponent(CIMD) + "&code_verifier=" + verifier + (fault === "resource" ? "" : "&resource=" + encodeURIComponent(MCP));
        wire.add({ actor: "client", label: "POST /token" + (fault === "resource" ? " (no resource)" : " · resource"), http: { start: "POST /token HTTP/1.1", headers: { Host: "auth.example.com", "Content-Type": "application/x-www-form-urlencoded" } }, body: tokBody });
        const aud = fault === "resource" ? "https://api.example.com" : MCP;
        await stage.send("auth", "client", "access token");
        wire.add({ kind: "in", actor: "auth", label: "token · aud " + aud, status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }), body: { access_token: "<JWT: iss " + AS + ", aud " + aud + ", sub alice, scope releases:read>", token_type: "Bearer", expires_in: 600, scope: "releases:read" } });
        steps.mark(6, "pass"); steps.mark(7, "run");
        if (fault === "query") {
          await stage.send("client", "server", "POST /mcp?access_token=…", { tone: "err" });
          wire.add({ actor: "client", label: "POST /mcp?access_token=… (wrong)", http: { start: "POST /mcp?access_token=(token) HTTP/1.1", headers: { Host: "release-tools.example.com" } } });
          await stage.send("server", "client", "401", { tone: "err" });
          wire.add({ kind: "in", actor: "server", label: "401 · tokens only in the Authorization header", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer error="invalid_request", resource_metadata="' + PRM + '"' }) });
          return fail(7, "Refused. Tokens in URLs end up in proxy logs, browser history and Referer headers. MCP allows only <code>Authorization: Bearer</code>.");
        }
        await stage.send("client", "server", "tools/list + Bearer");
        wire.add({ actor: "client", label: "POST /mcp tools/list · Authorization: Bearer", http: SPEC.post("tools/list", null, null, { host: "release-tools.example.com" }), body: SPEC.rpc("tools/list", {}, 2) });
        if (fault === "resource") {
          await stage.send("server", "client", "401", { tone: "err" });
          wire.add({ kind: "in", actor: "server", label: "401 · token audience is not this server", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="audience mismatch", resource_metadata="' + PRM + '"' }) });
          return fail(7, "Without <code>resource</code>, the authorization server issued a token for some other audience. release-tools checks that every token was issued <em>for it</em> and refuses. The same check stops a token stolen from another service being replayed here.");
        }
        await stage.send("server", "client", "200");
        wire.add({ kind: "in", actor: "server", label: "200 · tools", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { tools: SPEC.tools.slice(0, 2).map(function (t) { return { name: t.name }; }), ttlMs: 300000, cacheScope: "private" }) });
        steps.mark(7, "pass");
        PG.setResult(verdict, "ok", "Signed in. The token is bound to release-tools (audience), to this client (PKCE), and to the issuer the client started with.");
        run.disabled = false;
      });
    },
    quiz: [
      { q: "Where does a client first learn which authorization server to use?",
        opts: ["From serverInfo", "From the Protected Resource Metadata the 401 points to", "From the tools/list result", "It guesses auth.<domain>"],
        a: 1, why: "The 401's WWW-Authenticate resource_metadata (or the well-known PRM path) lists authorization_servers." },
      { q: "The authorization server's metadata has no code_challenge_methods_supported. What does the client do?",
        opts: ["Proceed without PKCE", "Use plain PKCE", "Refuse to proceed", "Use Dynamic Client Registration"],
        a: 2, why: "Clients MUST verify PKCE support from metadata and refuse if it isn't advertised." },
      { q: "Why send resource= in both the authorization and token requests?",
        opts: ["It's the redirect target", "It asks for a token whose audience is this specific MCP server", "It selects the scopes", "It identifies the user"],
        a: 1, why: "RFC 8707 resource indicators bind the token to the server, which then validates the audience." },
    ],
  });


  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Finding the authorization server, registering the client
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "registration",
    track: "auth",
    title: "Finding the auth server and saying who the client is",
    short: "Discovery & registration",
    thesis: "Before anyone signs in, the client has to find the right authorization server (and check it is the one it claims to be) and introduce itself. Today that introduction is usually a URL: a Client ID Metadata Document the authorization server fetches.",
    refs: "Spec 2026-07-28 · Authorization server discovery · Client registration · Security considerations §CIMD · RFC 8414, RFC 9728",
    brief: `
      <h2>Finding the authorization server</h2>
      <p>The Protected Resource Metadata lists <code>authorization_servers</code>. For each issuer URL, the client tries well-known paths in a fixed order:</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Issuer</th><th>Try, in order</th></tr></thead><tbody>
        <tr><td><code>https://auth.example.com</code></td><td>1. <code>/.well-known/oauth-authorization-server</code><br>2. <code>/.well-known/openid-configuration</code></td></tr>
        <tr><td><code>https://auth.example.com/tenant1</code></td><td>1. <code>/.well-known/oauth-authorization-server/tenant1</code><br>2. <code>/.well-known/openid-configuration/tenant1</code><br>3. <code>/tenant1/.well-known/openid-configuration</code></td></tr>
      </tbody></table></div>
      <p>The <code>issuer</code> inside the document MUST be exactly the issuer used to build the URL, or the client MUST NOT use it.</p>
      <h2>Saying who the client is, in priority order</h2>
      <ol>
        <li><strong>Pre-registered</strong> credentials, if the client has them for this authorization server.</li>
        <li><strong>Client ID Metadata Document (CIMD)</strong>, if the server's metadata says <code>client_id_metadata_document_supported: true</code>. The <code>client_id</code> is an https URL with a path; the document at that URL contains at least <code>client_id</code> (identical to the URL), <code>client_name</code> and <code>redirect_uris</code>.</li>
        <li><strong>Dynamic Client Registration</strong> (deprecated), if there is a <code>registration_endpoint</code>; the client must send a suitable <code>application_type</code> (<code>native</code> for localhost redirects, <code>web</code> otherwise).</li>
        <li>Otherwise, ask the user to enter client details.</li>
      </ol>
      <div class="note trap"><span class="note-label">Localhost redirects</span>Any program on a machine can listen on 127.0.0.1, so a CIMD alone can't prove a localhost redirect belongs to the real app. Authorization servers SHOULD warn for localhost-only redirect URIs and MUST show the redirect hostname on the consent screen. Fetching client documents is also an SSRF risk the server must guard against.</div>
      <div class="note spec"><span class="note-label">Credentials belong to one issuer</span>Store pre-registered or DCR credentials keyed by the authorization server's <code>issuer</code>. If the metadata starts pointing at a different authorization server, don't reuse them: register again. CIMD client ids are portable, because they're your own URL.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Probe for the authorization server's metadata", "Lab · well-known order · issuer check");
      let iss = "https://auth.example.com/tenant1", hasOauth = false, evil = false;
      const wire = PG.wire(a.body, { title: "Wire" });
      const out = h("div", { class: "result" });
      function urls(i) {
        const u = new URL(i), path = u.pathname.replace(/\/$/, "");
        if (!path) return [u.origin + "/.well-known/oauth-authorization-server", u.origin + "/.well-known/openid-configuration"];
        return [u.origin + "/.well-known/oauth-authorization-server" + path, u.origin + "/.well-known/openid-configuration" + path, u.origin + path + "/.well-known/openid-configuration"];
      }
      function run() {
        wire.clear();
        const list = urls(iss);
        const hit = hasOauth ? 0 : list.length - 1;
        for (let i = 0; i < list.length; i++) {
          const u = new URL(list[i]);
          wire.add({ actor: "client", label: "GET " + u.pathname, http: { start: "GET " + u.pathname + " HTTP/1.1", headers: { Host: u.host, Accept: "application/json" } } });
          if (i < hit) { wire.add({ kind: "in", actor: "auth", label: "404", status: "404", http: { start: "HTTP/1.1 404 Not Found", headers: {} } }); continue; }
          const doc = { issuer: evil ? "https://login.attacker.example" : iss, authorization_endpoint: iss + "/authorize", token_endpoint: iss + "/token", code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, scopes_supported: ["releases:read", "releases:write", "offline_access"] };
          wire.add({ kind: "in", actor: "auth", label: "200 · issuer " + doc.issuer, status: evil ? "✗ issuer mismatch" : "200", tone: evil ? "err" : "ok", http: SPEC.res(200), body: doc, hl: ["issuer"], open: true });
          break;
        }
        PG.setResult(out, evil ? "err" : "ok", evil
          ? "Rejected. The document came from <code>" + new URL(iss).host + "</code> but names a different issuer. Using it would let one server pose as another (a mix-up attack), so the client MUST NOT use it."
          : "Found on try " + (hit + 1) + " of " + list.length + ". The issuer matches the URL it was built from, so the client uses this metadata.");
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([{ v: "https://auth.example.com", label: "Issuer without a path" }, { v: "https://auth.example.com/tenant1", label: "Issuer with /tenant1" }], iss, function (v) { iss = v; run(); }, "Issuer")),
        h("div", { class: "row" },
          PG.switch("rg-oauth", "Server publishes OAuth metadata (not only OpenID)", false, function (v) { hasOauth = v; run(); }),
          PG.switch("rg-evil", "Document names a different issuer", false, function (v) { evil = v; run(); })), out), wire.el);
      run();

      const b = PG.lab(bench, "Be the authorization server: check a Client ID Metadata Document", "Lab · CIMD validation");
      const DOC = {
        client_id: "https://ops-console.example.com/oauth/client.json",
        client_name: "Ops Console",
        client_uri: "https://ops-console.example.com",
        redirect_uris: ["http://127.0.0.1:33418/callback", "https://ops-console.example.com/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
      const presets = {
        good: { url: DOC.client_id, redirect: "https://ops-console.example.com/oauth/callback", doc: DOC },
        mismatch: { url: DOC.client_id, redirect: "https://ops-console.example.com/oauth/callback", doc: Object.assign({}, DOC, { client_id: "https://ops-console.example.com/oauth/other.json" }) },
        redirect: { url: DOC.client_id, redirect: "https://ops-console.example.com/callback?next=/admin", doc: DOC },
        local: { url: DOC.client_id, redirect: "http://127.0.0.1:33418/callback", doc: Object.assign({}, DOC, { redirect_uris: ["http://127.0.0.1:33418/callback"] }) },
        http: { url: "http://ops-console.example.com/client.json", redirect: "https://ops-console.example.com/oauth/callback", doc: Object.assign({}, DOC, { client_id: "http://ops-console.example.com/client.json" }) },
      };
      const urlIn = h("input", { class: "inline", id: "cimd-url", style: { flex: "1 1 280px", fontFamily: "var(--font-mono)", fontSize: "12px" }, "aria-label": "client_id URL" });
      const redIn = h("input", { class: "inline", id: "cimd-redirect", style: { flex: "1 1 280px", fontFamily: "var(--font-mono)", fontSize: "12px" }, "aria-label": "redirect_uri in the authorization request" });
      const docIn = h("textarea", { class: "inline", id: "cimd-doc", rows: 10, style: { width: "100%", fontFamily: "var(--font-mono)", fontSize: "11.5px" }, "aria-label": "Document served at the client_id URL" });
      const list = h("ul", { class: "findings" });
      const verdict = h("div", { class: "result" });
      function load(k) { const p = presets[k]; urlIn.value = p.url; redIn.value = p.redirect; docIn.value = JSON.stringify(p.doc, null, 1); check(); }
      function check() {
        list.innerHTML = "";
        let doc, ok = true, warn = false;
        function row(pass, text, level) {
          if (!pass && level !== "warn") ok = false;
          if (!pass && level === "warn") warn = true;
          list.appendChild(h("li", {}, h("span", { class: "chip " + (pass ? "ok" : level === "warn" ? "warn" : "err"), text: pass ? "pass" : level === "warn" ? "warn" : "fail" }), h("span", { html: text })));
        }
        let u = null;
        try { u = new URL(urlIn.value); } catch (e) { /* invalid */ }
        row(!!u && u.protocol === "https:" && u.pathname.length > 1, "client_id is an <code>https</code> URL with a path");
        try { doc = JSON.parse(docIn.value); } catch (e) { row(false, "document is valid JSON"); PG.setResult(verdict, "err", "Refuse: the document isn't JSON."); return; }
        row(doc.client_id === urlIn.value, "document's <code>client_id</code> is exactly the URL it was fetched from");
        row(!!doc.client_name, "document has <code>client_name</code> (shown on the consent screen)");
        row(Array.isArray(doc.redirect_uris) && doc.redirect_uris.length > 0, "document lists <code>redirect_uris</code>");
        row(Array.isArray(doc.redirect_uris) && doc.redirect_uris.indexOf(redIn.value) >= 0, "the request's <code>redirect_uri</code> exactly matches one listed (no prefix or wildcard matching)");
        let r = null; try { r = new URL(redIn.value); } catch (e) { /* invalid */ }
        row(!!r && (r.protocol === "https:" || /^(127\.0\.0\.1|localhost|\[::1\])$/.test(r.hostname)), "redirect is https, or http only on localhost");
        const onlyLocal = Array.isArray(doc.redirect_uris) && doc.redirect_uris.length && doc.redirect_uris.every(function (x) { return /^http:\/\/(127\.0\.0\.1|localhost)/.test(x); });
        row(!onlyLocal, "not localhost-only (any local program could listen there): show an extra warning", "warn");
        PG.setResult(verdict, ok ? (warn ? "warn" : "ok") : "err", ok
          ? (warn ? "Accept, with a warning on the consent screen naming the redirect host <code>" + (r ? r.host : "?") + "</code>." : "Accept. The consent screen shows <b>" + PG.esc(doc.client_name) + "</b> and the redirect host <code>" + (r ? r.host : "?") + "</code>.")
          : "Refuse the authorization request. Each failed check above is a way an attacker could get a code sent somewhere else.");
      }
      [urlIn, redIn, docIn].forEach(function (el) { el.addEventListener("input", check); });
      b.body.append(h("div", { class: "row" },
        h("button", { class: "btn small", type: "button", text: "Good document", onclick: function () { load("good"); } }),
        h("button", { class: "btn small", type: "button", text: "client_id doesn't match", onclick: function () { load("mismatch"); } }),
        h("button", { class: "btn small", type: "button", text: "Redirect not listed", onclick: function () { load("redirect"); } }),
        h("button", { class: "btn small", type: "button", text: "Localhost only", onclick: function () { load("local"); } }),
        h("button", { class: "btn small", type: "button", text: "Plain http client_id", onclick: function () { load("http"); } })),
        h("label", { class: "field", for: "cimd-url" }, h("span", { text: "client_id (the URL the server fetches)" }), urlIn),
        h("label", { class: "field", for: "cimd-redirect" }, h("span", { text: "redirect_uri in the authorization request" }), redIn),
        h("label", { class: "field", for: "cimd-doc" }, h("span", { text: "Document served at that URL" }), docIn), verdict, list);
      load("good");
    },
    quiz: [
      { q: "The issuer is https://auth.example.com/tenant1. Which URL does the client try first?",
        opts: ["https://auth.example.com/tenant1/.well-known/openid-configuration", "https://auth.example.com/.well-known/oauth-authorization-server/tenant1", "https://auth.example.com/.well-known/openid-configuration", "https://auth.example.com/tenant1/oauth"],
        a: 1, why: "OAuth metadata with path insertion first, then OpenID with path insertion, then OpenID with path appending." },
      { q: "With no pre-registered credentials, what does a client prefer when the server supports it?",
        opts: ["Dynamic Client Registration", "A Client ID Metadata Document: an https URL as its client_id", "Asking the user for a password", "No client id at all"],
        a: 1, why: "Order: pre-registered, then CIMD, then (deprecated) DCR, then ask the user." },
      { q: "Protected Resource Metadata now names a different authorization server. What about the client's stored DCR credentials?",
        opts: ["Reuse them", "Don't reuse them; register again with the new server", "Send them to both", "Convert them to a CIMD"],
        a: 1, why: "Credentials are bound to the issuer that created them." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Tokens over time
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "tokens",
    track: "auth",
    title: "Tokens over time: expiry, refresh, rotation",
    short: "Tokens over time",
    thesis: "Access tokens are meant to expire quickly. A client that may hold a refresh token gets new access tokens without asking you again; for public clients each refresh also replaces the refresh token, so a stolen old one stops working.",
    refs: "Spec 2026-07-28 · Authorization §Refresh tokens · §Error handling · Security considerations §Token theft · OAuth 2.1 §4.3",
    brief: `
      <h2>Lifetimes</h2>
      <ul>
        <li><strong>Access token</strong>: short-lived (minutes). Authorization servers SHOULD keep them short so a leaked one is worth little. Sent on every request.</li>
        <li><strong>Refresh token</strong>: longer-lived, sent only to the authorization server, never to the MCP server. A client asks for one by including <code>offline_access</code> in <code>scope</code>, only if the authorization server lists it in <code>scopes_supported</code>, and must not assume it will get one.</li>
      </ul>
      <h2>What each error means</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Answer</th><th>Meaning</th><th>Client does</th></tr></thead><tbody>
        <tr><td><code>401</code> <code>invalid_token</code></td><td>Missing, expired, or not for this server</td><td>Refresh; if that fails, sign in again</td></tr>
        <tr><td><code>403</code> <code>insufficient_scope</code></td><td>Valid token, not enough permission</td><td>Step up (Scopes &amp; passthrough lesson)</td></tr>
        <tr><td><code>400</code></td><td>Malformed authorization request</td><td>Fix the request</td></tr>
      </tbody></table></div>
      <h2>Rotation</h2>
      <p>For public clients (apps that can't keep a secret, like desktop and CLI apps), authorization servers MUST rotate refresh tokens: every refresh returns a new refresh token and the old one stops working. If an attacker and the real app both use the same old token, the server can tell something is wrong.</p>
      <div class="note spec"><span class="note-label">Spec</span>Clients and servers MUST store tokens securely. MCP servers SHOULD NOT put <code>offline_access</code> in their challenges or <code>scopes_supported</code>: refresh tokens are the client's business, not a resource requirement.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "A working day with one sign-in", "Lab · expiry · refresh · rotation · new authorization server");
      let clock = 0, access = null, refresh = null, oldRefresh = null, gen = 0, askedOffline = true, rotate = true, asIssuer = "https://auth.example.com", credIssuer = "https://auth.example.com";
      const wire = PG.wire(a.body);
      const state = h("dl", { class: "kv" });
      const out = h("div", { class: "result" });
      function paint() {
        state.innerHTML = "";
        [["time", "+" + clock + " min"], ["access token", access ? "#" + access.n + " · expires +" + access.exp + " min" + (access.exp <= clock ? " (expired)" : "") : "none"], ["refresh token", refresh ? "R" + refresh.n + (rotate ? " (rotating)" : "") : "none"], ["client registered with", credIssuer]].forEach(function (p) { state.append(h("dt", { text: p[0] }), h("dd", { text: p[1] })); });
      }
      function signIn() {
        wire.add({ kind: "note", label: "Browser sign-in at " + asIssuer + " (authorization code + PKCE), scope releases:read" + (askedOffline ? " offline_access" : "") });
        gen++;
        access = { n: gen, exp: clock + 15 };
        refresh = askedOffline ? { n: gen } : null;
        wire.add({ kind: "in", actor: "auth", label: "token · access #" + gen + (refresh ? " + refresh R" + gen : " (no refresh token)"), status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }),
          body: Object.assign({ access_token: "<access token #" + gen + ">", token_type: "Bearer", expires_in: 900, scope: "releases:read" }, refresh ? { refresh_token: "<refresh token R" + gen + ">" } : {}) });
      }
      async function doRefresh(useOld) {
        const tok = useOld ? oldRefresh : refresh;
        wire.add({ actor: useOld ? "attacker" : "client", label: (useOld ? "Attacker: " : "") + "POST /token grant_type=refresh_token (R" + (tok ? tok.n : "?") + ")", http: { start: "POST /token HTTP/1.1", headers: { Host: new URL(asIssuer).host, "Content-Type": "application/x-www-form-urlencoded" } }, body: "grant_type=refresh_token&refresh_token=<R" + (tok ? tok.n : "?") + ">&client_id=https%3A%2F%2Fops-console.example.com%2Foauth%2Fclient.json&resource=" + encodeURIComponent("https://release-tools.example.com/mcp") });
        if (!tok || (rotate && tok.n !== refresh.n) || tok.dead) {
          wire.add({ kind: "in", actor: "auth", label: "400 invalid_grant" + (useOld ? " · reuse of a rotated token detected" : ""), status: "400", http: SPEC.res(400), body: { error: "invalid_grant", error_description: useOld ? "Refresh token was already used" : "Refresh token is not valid" } });
          return false;
        }
        gen++;
        access = { n: gen, exp: clock + 15 };
        if (rotate) { oldRefresh = refresh; refresh = { n: gen }; } else oldRefresh = refresh;
        wire.add({ kind: "in", actor: "auth", label: "token · access #" + gen + (rotate ? " + NEW refresh R" + gen : ""), status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }), body: Object.assign({ access_token: "<access token #" + gen + ">", token_type: "Bearer", expires_in: 900 }, rotate ? { refresh_token: "<refresh token R" + gen + ">" } : {}) });
        return true;
      }
      async function call() {
        if (credIssuer !== asIssuer) {
          wire.add({ kind: "note", label: "Protected Resource Metadata now lists " + asIssuer + ". Stored credentials are keyed to " + credIssuer + ": don't reuse them. Register again (CIMD id is portable), then sign in." });
          credIssuer = asIssuer; refresh = null; access = null; oldRefresh = null;
          signIn(); paint();
          PG.setResult(out, "info", "The authorization server changed. The client didn't try its old credentials against the new one; it registered and signed in again.");
          return;
        }
        if (!access) { signIn(); paint(); }
        wire.add({ actor: "client", label: "tools/call get_service_status · Bearer #" + access.n, http: SPEC.post("tools/call", "get_service_status", { Authorization: "Bearer <access token #" + access.n + ">" }), body: SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "checkout-api" } }, clock + 1) });
        if (access.exp <= clock) {
          wire.add({ kind: "in", actor: "server", label: "401 · invalid_token (expired)", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token expired", resource_metadata="https://release-tools.example.com/.well-known/oauth-protected-resource/mcp"' }) });
          if (await doRefresh(false)) {
            wire.add({ actor: "client", label: "tools/call (retry) · Bearer #" + access.n, http: SPEC.post("tools/call", "get_service_status", { Authorization: "Bearer <access token #" + access.n + ">" }), body: SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "checkout-api" } }, clock + 2) });
            wire.add({ kind: "in", actor: "server", label: "200", status: "200", http: SPEC.res(200), body: SPEC.ok(clock + 2, PG.runTool("get_service_status", { service: "checkout-api" })) });
            PG.setResult(out, "ok", "Expired, refreshed, retried. You never saw a sign-in page." + (rotate ? " The refresh also replaced the refresh token." : ""));
          } else {
            signIn();
            PG.setResult(out, "warn", askedOffline ? "The refresh failed, so the client fell back to a full sign-in." : "No refresh token (the client didn't ask for <code>offline_access</code>), so every expiry means a new browser sign-in.");
          }
        } else {
          wire.add({ kind: "in", actor: "server", label: "200", status: "200", http: SPEC.res(200), body: SPEC.ok(clock + 1, PG.runTool("get_service_status", { service: "checkout-api" })) });
          PG.setResult(out, "ok", "Token still valid.");
        }
        paint();
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          PG.switch("tk-off", "Ask for offline_access", true, function (v) { askedOffline = v; }),
          PG.switch("tk-rot", "Server rotates refresh tokens", true, function (v) { rotate = v; })),
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Call a tool", onclick: call }),
          h("button", { class: "btn", type: "button", text: "Wait 20 minutes", onclick: function () { clock += 20; paint(); PG.setResult(out, "info", "20 minutes later. The access token lives 15."); } }),
          h("button", { class: "btn", type: "button", text: "Attacker replays an old refresh token", onclick: async function () {
            if (!oldRefresh) { PG.toast("Refresh at least once first (call after waiting)"); return; }
            const ok = await doRefresh(true);
            PG.setResult(out, ok ? "err" : "ok", ok ? "Without rotation the stolen refresh token still works: the attacker now has fresh access tokens for as long as it lasts." : "Rejected: that refresh token was already used. A server can treat reuse as theft and revoke the whole chain.");
          } }),
          h("button", { class: "btn", type: "button", text: "Server moves to a new auth server", onclick: function () { asIssuer = asIssuer === "https://auth.example.com" ? "https://login.newidp.example" : "https://auth.example.com"; PG.setResult(out, "info", "The MCP server's metadata now lists <code>" + asIssuer + "</code>. Call a tool."); } }),
          h("button", { class: "btn small", type: "button", text: "Reset", onclick: function () { clock = 0; access = refresh = oldRefresh = null; gen = 0; asIssuer = credIssuer = "https://auth.example.com"; wire.clear(); paint(); PG.setResult(out, "", "Start by calling a tool."); } })),
        state, out), wire.el);
      paint();
      PG.setResult(out, "", "Start by calling a tool; then wait, call again, and try the attacker.");
    },
    quiz: [
      { q: "A tool call answers 401 with error=\"invalid_token\" (expired). What should a client with a refresh token do?",
        opts: ["Step up for more scopes", "Use the refresh token at the authorization server, then retry", "Send the refresh token to the MCP server", "Give up"],
        a: 1, why: "Refresh tokens go only to the authorization server; then retry with the new access token." },
      { q: "With refresh token rotation, what happens to the old refresh token after a refresh?",
        opts: ["It keeps working", "It stops working; reusing it signals possible theft", "It becomes an access token", "It's sent to the MCP server"],
        a: 1, why: "Authorization servers MUST rotate refresh tokens for public clients." },
      { q: "Should an MCP server list offline_access in its scopes_supported?",
        opts: ["Yes, always", "No: refresh tokens aren't a resource requirement", "Only for stdio", "Only with DCR"],
        a: 1, why: "It's the client's choice to request offline access from the authorization server." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Scopes, step-up, no passthrough
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "scopes",
    track: "auth",
    title: "Scopes, step-up, and never passing the token on",
    short: "Scopes & passthrough",
    thesis: "Ask for the least you need, and when the server answers 403 insufficient_scope, sign in again for the union of what you had and what it wants. And when the server calls another API, it uses its own token for that API, never the one you gave it.",
    refs: "Spec 2026-07-28 · Authorization §Scope selection · §Step-up · Security considerations §Access token privilege restriction · §Confused deputy",
    brief: `
      <h2>Choosing scopes</h2>
      <p>Use the <code>scope</code> from the latest <code>WWW-Authenticate</code> challenge; if there isn't one, use <code>scopes_supported</code> from the Protected Resource Metadata. Start small.</p>
      <h2>Step-up</h2>
      <p>A call that needs more answers <code>403</code> with <code>WWW-Authenticate: Bearer error="insufficient_scope", scope="releases:write", resource_metadata="…"</code>. A client acting for a user SHOULD re-authorize asking for the <strong>union</strong> of its previous scopes and the new ones (so it doesn't lose what it had), then retry, a few times at most.</p>
      <h2>No token passthrough</h2>
      <p>The token you send release-tools has <em>release-tools</em> as its audience. If release-tools needs the deploy API, it acts as an OAuth client to that API and uses a <strong>separate</strong> token issued for it. It MUST NOT forward yours. Passthrough breaks audit (the deploy API thinks you called it directly), skips release-tools' own checks, and makes any leaked token valid everywhere.</p>
      <div class="note trap"><span class="note-label">Confused deputy</span>An MCP server that proxies to a third-party API with one static client id must get the user's consent for each client before forwarding to the third party's authorization server. Otherwise an attacker can ride on consent another user gave.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Read is fine, rollback needs more", "Lab · 403 insufficient_scope · union");
      let union = true;
      const wire = PG.wire(a.body);
      const have = h("span", { class: "chip mono", text: "token scope: releases:read" });
      const verdict = h("div", { class: "result", text: "Call rollback with a read-only token, then call status again." });
      let scopes = ["releases:read"];
      function call(name, need, id) {
        wire.add({ actor: "client", label: "tools/call " + name + " (scope " + scopes.join(" ") + ")", http: SPEC.post("tools/call", name), body: SPEC.rpc("tools/call", { name: name, arguments: name === "rollback_release" ? { service: "checkout-api", to_version: "2.13.2" } : { service: "checkout-api" } }, id) });
        if (scopes.indexOf(need) < 0) {
          wire.add({ kind: "in", actor: "server", label: "403 · insufficient_scope " + need, status: "403", http: SPEC.res(403, "none", { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="' + need + '", resource_metadata="' + PRM + '"' }) });
          return false;
        }
        wire.add({ kind: "in", actor: "server", label: "200", status: "200", http: SPEC.res(200), body: SPEC.ok(id, PG.runTool(name, name === "rollback_release" ? { service: "checkout-api", to_version: "2.13.2" } : { service: "checkout-api" })) });
        return true;
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.switch("sc-union", "Step-up asks for the union of scopes", true, function (v) { union = v; }), have),
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Roll back (needs releases:write)", onclick: function () {
            if (call("rollback_release", "releases:write", 1)) { PG.setResult(verdict, "ok", "Already allowed."); return; }
            scopes = union ? ["releases:read", "releases:write"] : ["releases:write"];
            have.textContent = "token scope: " + scopes.join(" ");
            wire.add({ kind: "note", label: "Client re-authorizes (browser consent) with scope=" + scopes.join(" ") + ", same resource, new PKCE pair." });
            call("rollback_release", "releases:write", 2);
            PG.setResult(verdict, union ? "ok" : "warn", union ? "Stepped up and retried. The new token keeps releases:read too." : "Stepped up, but only for releases:write. Now try the status call.");
          } }),
          h("button", { class: "btn", type: "button", text: "Check status (needs releases:read)", onclick: function () {
            const ok = call("get_service_status", "releases:read", 3);
            PG.setResult(verdict, ok ? "ok" : "err", ok ? "Still works: the union kept the earlier scope." : "The step-up dropped releases:read, so a call that worked a minute ago fails. Always ask for the union.");
          } }),
          h("button", { class: "btn small", type: "button", text: "Reset", onclick: function () { scopes = ["releases:read"]; have.textContent = "token scope: releases:read"; wire.clear(); } })), verdict), wire.el);

      const b = PG.lab(bench, "release-tools calls the deploy API", "Lab · token passthrough vs own token");
      let pass = true;
      const stage = PG.stage(b.body, {
        actors: [
          { id: "client", role: "client", label: "MCP client", sub: "alice", x: 12, y: 50 },
          { id: "server", role: "server", label: "release-tools", sub: "MCP server", x: 46, y: 50 },
          { id: "das", role: "auth", label: "Deploy API auth", sub: "", x: 84, y: 14 },
          { id: "dapi", role: "registry", label: "Deploy API", sub: "upstream", x: 84, y: 86, glyph: "A" },
        ],
        links: [["client", "server"], ["server", "das"], ["server", "dapi"]],
      });
      const bw = PG.wire(b.body, { title: "Wire" });
      const bv = h("div", { class: "result", text: "Choose how release-tools authenticates upstream." });
      b.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" },
        PG.seg([{ v: true, label: "Forward Alice's token (passthrough)" }, { v: false, label: "Use its own token" }], true, function (v) { pass = v === true || v === "true"; }, "Upstream auth"),
        h("button", { class: "btn primary", type: "button", text: "Roll back", onclick: async function () {
          bw.clear();
          await stage.send("client", "server", "tools/call");
          bw.add({ actor: "client", label: "tools/call rollback_release · Bearer (aud release-tools)", http: SPEC.post("tools/call", "rollback_release", { Authorization: "Bearer <alice → aud release-tools>" }), body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" } }, 1) });
          if (pass) {
            await stage.send("server", "dapi", "Bearer <alice's token>", { tone: "err" });
            bw.add({ actor: "server", label: "POST deploy-api/rollbacks · Authorization: (Alice's MCP token, forwarded)", http: { start: "POST /v2/rollbacks HTTP/1.1", headers: { Host: "deploy-api.example.com", Authorization: "Bearer <alice → aud release-tools>" } }, body: { service: "checkout-api", to: "2.13.2" } });
            await stage.send("dapi", "server", "401 wrong audience", { tone: "err" });
            bw.add({ kind: "in", actor: "registry", label: "401 · audience is release-tools, not deploy-api", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer error="invalid_token"' }) });
            PG.setResult(bv, "err", "Forbidden by the spec, and here it doesn't even work: a well-behaved deploy API rejects a token issued for someone else. A sloppy one that accepts it is worse: its logs say Alice called it directly, release-tools' own rate limits and checks are bypassed, and Alice's token now opens two systems.");
          } else {
            await stage.send("server", "das", "client_credentials / token exchange");
            bw.add({ actor: "server", label: "POST deploy-auth/token (release-tools as an OAuth client)", http: { start: "POST /token HTTP/1.1", headers: { Host: "deploy-auth.example.com", "Content-Type": "application/x-www-form-urlencoded" } }, body: "grant_type=client_credentials&scope=rollbacks:write&resource=https%3A%2F%2Fdeploy-api.example.com" });
            await stage.send("das", "server", "token aud deploy-api");
            await stage.send("server", "dapi", "Bearer <release-tools' token>");
            bw.add({ actor: "server", label: "POST deploy-api/rollbacks · own token, on behalf of alice", http: { start: "POST /v2/rollbacks HTTP/1.1", headers: { Host: "deploy-api.example.com", Authorization: "Bearer <release-tools → aud deploy-api>", "X-On-Behalf-Of": "alice" } }, body: { service: "checkout-api", to: "2.13.2", requested_by: "alice" } });
            await stage.send("dapi", "server", "201");
            await stage.send("server", "client", "result");
            bw.add({ kind: "in", actor: "server", label: "result · rolled back", status: "200", http: SPEC.res(200), body: SPEC.ok(1, { content: [{ type: "text", text: "checkout-api rolled back to 2.13.2" }], isError: false }) });
            PG.setResult(bv, "ok", "Two tokens, two audiences. Alice's token never left release-tools; the deploy API sees release-tools acting for Alice, which is what really happened.");
          }
        } })), bv), stage.el);
    },
    quiz: [
      { q: "A client with releases:read gets 403 insufficient_scope, scope=\"releases:write\". What should it request?",
        opts: ["releases:write only", "releases:read releases:write", "Every scope in scopes_supported", "Nothing: give up"],
        a: 1, why: "Step-up asks for the union of previously requested scopes and the challenged ones." },
      { q: "release-tools needs to call the deploy API. Which token?",
        opts: ["The client's token, forwarded", "A separate token issued for the deploy API", "No token", "The user's password"],
        a: 1, why: "MCP servers MUST NOT pass through the token they received; upstream calls use their own credentials." },
      { q: "A token issued for api.example.com reaches release-tools. What should release-tools do?",
        opts: ["Accept it if it's signed by the same AS", "Reject it: it wasn't issued for this server", "Accept it read-only", "Exchange it silently"],
        a: 1, why: "Servers MUST only accept tokens whose audience is themselves." },
    ],
  });


  /* ════════════════════════════════════════════════════════════════════
   * Lesson: No person present — client credentials
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "client-credentials",
    track: "auth",
    title: "No person present: client credentials",
    short: "Machine to machine",
    thesis: "A CI pipeline or a nightly agent has nobody to click Allow. With the OAuth Client Credentials extension the client signs in as itself, preferably with a short-lived JWT signed by its own key, and gets a token for the MCP server.",
    refs: "ext-auth: OAuth Client Credentials (io.modelcontextprotocol/oauth-client-credentials, draft) · RFC 7523 §2.2 · OAuth 2.1 §2.4.1",
    brief: `
      <h2>What changes</h2>
      <ul>
        <li>Discovery is the same: 401, Protected Resource Metadata, authorization server metadata.</li>
        <li>No browser, no consent screen, no PKCE. The client calls the token endpoint with <code>grant_type=client_credentials</code>, plus <code>resource</code> and <code>scope</code>.</li>
        <li>The client must be <strong>pre-registered</strong> with the authorization server (no Dynamic Client Registration).</li>
        <li>Both sides opt in: the client lists <code>io.modelcontextprotocol/oauth-client-credentials</code> in its capabilities; the server may advertise it in <code>server/discover</code>.</li>
      </ul>
      <h2>Two ways to prove who you are</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Method</th><th>What's sent</th><th>Trade-off</th></tr></thead><tbody>
        <tr><td><strong>JWT assertion</strong> (recommended)</td><td><code>client_assertion_type=…jwt-bearer</code> and a JWT signed with the client's private key: <code>iss</code> = <code>sub</code> = client id, <code>aud</code> = token endpoint, short <code>exp</code></td><td>The key never leaves the client; each assertion expires in minutes</td></tr>
        <tr><td><strong>Client secret</strong></td><td><code>client_id</code> and <code>client_secret</code></td><td>Simple, but a long-lived secret: leak it and anyone is your app until you rotate it</td></tr>
      </tbody></table></div>
      <p>The authorization server's metadata must list <code>token_endpoint_auth_methods_supported</code> with <code>private_key_jwt</code> and/or <code>client_secret_basic</code> (and the signing algorithms, for JWT).</p>
      <div class="note trap"><span class="note-label">Design for no human</span>The token stands for the job, not a person, so give it the smallest scopes that work. And nobody can answer an elicitation: tools that need a confirmation must fail clearly or be configured with an explicit policy instead.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "The nightly readiness job signs in", "Lab · private_key_jwt vs client_secret");
      let method = "jwt", fault = "none";
      const stage = PG.stage(a.body, {
        actors: [
          { id: "job", role: "client", label: "CI job", sub: "MCP client", x: 14, y: 50, glyph: "C" },
          { id: "as", role: "auth", label: "Auth server", sub: "", x: 54, y: 16 },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 86, y: 70 },
          { id: "att", role: "attacker", label: "Attacker", sub: "", x: 50, y: 86 },
        ],
        links: [["job", "as"], ["job", "server"], ["att", "as"]],
      });
      const wire = PG.wire(a.body);
      const out = h("div", { class: "result" });
      const CID = "release-readiness-nightly";
      const run = h("button", { class: "btn primary", type: "button", text: "Run the job" });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([{ v: "jwt", label: "JWT assertion (private_key_jwt)" }, { v: "secret", label: "Client secret" }], "jwt", function (v) { method = v; }, "Method")),
        h("div", { class: "row" }, PG.seg([{ v: "none", label: "Normal night" }, { v: "aud", label: "Assertion has the wrong aud" }, { v: "leak", label: "Credential leaks in a CI log" }], "none", function (v) { fault = v; }, "Fault"), run), out), stage.el);
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); stage.set("att", { dim: true });
        const now = 1792040400;
        let body;
        if (method === "jwt") {
          const claims = { iss: CID, sub: CID, aud: fault === "aud" ? "https://release-tools.example.com/mcp" : "https://auth.example.com/token", iat: now, exp: now + 120, jti: PG.hex(8) };
          body = "grant_type=client_credentials\n&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer\n&client_assertion=<JWT signed with the job's private key>\n&resource=https%3A%2F%2Frelease-tools.example.com%2Fmcp\n&scope=releases%3Aread";
          wire.add({ kind: "note", label: "JWT the job signs (claims): " + JSON.stringify(claims) + (fault === "aud" ? "  ← aud should be the token endpoint" : "") });
        } else body = "grant_type=client_credentials\n&client_id=" + CID + "\n&client_secret=<the job's secret, from a secrets manager>\n&resource=https%3A%2F%2Frelease-tools.example.com%2Fmcp\n&scope=releases%3Aread";
        await stage.send("job", "as", "POST /token");
        wire.add({ actor: "client", label: "POST /token · client_credentials · " + (method === "jwt" ? "client_assertion" : "client_secret"), http: { start: "POST /token HTTP/1.1", headers: { Host: "auth.example.com", "Content-Type": "application/x-www-form-urlencoded" } }, body: body });
        if (fault === "aud" && method === "jwt") {
          await stage.send("as", "job", "invalid_client", { tone: "err" });
          wire.add({ kind: "in", actor: "auth", label: "401 invalid_client · assertion audience", status: "401", http: SPEC.res(401), body: { error: "invalid_client", error_description: "assertion aud must be the token endpoint" } });
          PG.setResult(out, "ok", "Refused. An assertion is only valid for the token endpoint it names; one minted for anything else can't be replayed here.");
          run.disabled = false; return;
        }
        await stage.send("as", "job", "access token");
        wire.add({ kind: "in", actor: "auth", label: "token · sub " + CID + " · releases:read · 10 min", status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }), body: { access_token: "<access token for " + CID + ">", token_type: "Bearer", expires_in: 600, scope: "releases:read" } });
        const caps = { extensions: {} }; caps.extensions[EXT_CC] = {};
        await stage.send("job", "server", "tools/call");
        wire.add({ actor: "client", label: "tools/call check_release_readiness · Bearer", http: SPEC.post("tools/call", "check_release_readiness"), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, 1, { caps: caps }), hl: [SPEC.K.caps] });
        await stage.send("server", "job", "result");
        wire.add({ kind: "in", actor: "server", label: "result · ready", status: "200", http: SPEC.res(200), body: SPEC.ok(1, PG.runTool("check_release_readiness", { service: "checkout-api", version: "2.14.0" })) });
        if (fault === "leak") {
          stage.set("att", { dim: false });
          await stage.send("att", "as", method === "jwt" ? "replay JWT" : "client_secret", { tone: "err" });
          if (method === "jwt") {
            wire.add({ kind: "in", actor: "auth", label: "Attacker replays the logged assertion · 401 (expired / jti already used)", status: "401", http: SPEC.res(401), body: { error: "invalid_client" } });
            PG.setResult(out, "ok", "The log leaked a JWT assertion, which expired two minutes after it was made and named a one-time <code>jti</code>. The private key never left the job, so there's nothing reusable.");
          } else {
            wire.add({ kind: "in", actor: "auth", label: "Attacker uses the leaked secret · 200, token issued", status: "200", tone: "err", http: SPEC.res(200), body: { access_token: "<access token for " + CID + ">", token_type: "Bearer", expires_in: 600 } });
            PG.setResult(out, "err", "The leaked secret works for anyone, from anywhere, until someone rotates it. Prefer JWT assertions; keep secrets in a secrets manager and rotate them.");
          }
        } else PG.setResult(out, "ok", "Signed in as itself, with read-only scope, and the call ran. No person, no browser, no consent screen.");
        run.disabled = false;
      });
    },
    quiz: [
      { q: "Which client authentication does the client credentials extension recommend?",
        opts: ["A password", "A JWT assertion signed with the client's private key", "A client secret in the URL", "PKCE"],
        a: 1, why: "JWT authentication (RFC 7523 §2.2) is recommended; client secrets are allowed." },
      { q: "In a client_credentials JWT assertion, what is aud?",
        opts: ["The MCP server URL", "The authorization server's token endpoint", "The client id", "Any value"],
        a: 1, why: "The assertion is addressed to the token endpoint; iss and sub are the client id." },
      { q: "Can a client credentials client use Dynamic Client Registration to get its credentials?",
        opts: ["Yes, that's typical", "No: it must be pre-registered out of band", "Only with CIMD", "Only on stdio"],
        a: 1, why: "The flow requires pre-registered credentials." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Enterprise-managed authorization
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "enterprise-auth",
    track: "auth",
    title: "Company sign-in decides: enterprise-managed authorization",
    short: "Enterprise SSO",
    thesis: "At work, employees shouldn't approve every MCP server one by one, and IT needs one place to grant and revoke access. With the Enterprise-Managed Authorization extension the company's identity provider checks policy and issues a grant (an ID-JAG) that the client trades for an MCP access token, with no consent screen per server.",
    refs: "ext-auth: Enterprise-Managed Authorization (io.modelcontextprotocol/enterprise-managed-authorization, stable) · draft-ietf-oauth-identity-assertion-authz-grant · RFC 8693 token exchange · RFC 7523",
    brief: `
      <h2>The flow</h2>
      <ol>
        <li><strong>SSO into the app.</strong> The employee signs in to the MCP client with the company IdP (OpenID Connect or SAML). The client keeps the ID token.</li>
        <li><strong>Token exchange at the IdP.</strong> The client asks the IdP for an <strong>ID-JAG</strong> (Identity Assertion JWT Authorization Grant): <code>grant_type=urn:ietf:params:oauth:grant-type:token-exchange</code>, <code>requested_token_type=urn:ietf:params:oauth:token-type:id-jag</code>, <code>audience</code> = the MCP server's authorization server, <code>resource</code> = the MCP server, <code>subject_token</code> = the ID token.</li>
        <li><strong>Policy.</strong> The IdP checks groups, roles and conditions. No access, no ID-JAG.</li>
        <li><strong>Trade the grant.</strong> The client sends the ID-JAG to the MCP authorization server with <code>grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer</code> and <code>assertion=&lt;ID-JAG&gt;</code>. It gets an access token restricted to that one MCP server.</li>
        <li><strong>Call</strong> the MCP server with the token, as usual.</li>
      </ol>
      <p>The client knows the MCP authorization server supports this when its metadata lists <code>urn:ietf:params:oauth:grant-profile:id-jag</code> in <code>authorization_grant_profiles_supported</code>. The ID-JAG is a short-lived JWT (<code>typ: oauth-id-jag+jwt</code>) with <code>iss</code> (the IdP), <code>sub</code>, <code>aud</code>, <code>resource</code>, <code>client_id</code>, <code>scope</code> and a short <code>exp</code>.</p>
      <div class="note"><span class="note-label">What IT gets</span>One admin console for which employees may use which MCP servers; onboarding and offboarding in one place; an audit trail. Removing someone stops new ID-JAGs immediately; access tokens already issued last until they expire, which is one more reason to keep them short.</div>
      <div class="note spec"><span class="note-label">Extension</span>The client lists <code>io.modelcontextprotocol/enterprise-managed-authorization</code> in its capabilities and is usually pre-registered with the company IdP for SSO. It must not send the employee to the MCP authorization server's own login page in this flow.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Alice opens the release console at work", "Lab · SSO · token exchange · ID-JAG · jwt-bearer");
      let inGroup = true, revoked = false;
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "Alice", sub: "employee", x: 12, y: 16 },
          { id: "client", role: "client", label: "MCP client", sub: "ops-console", x: 14, y: 72 },
          { id: "idp", role: "auth", label: "Company IdP", sub: "acme.idp.example", x: 50, y: 16, glyph: "I" },
          { id: "as", role: "auth", label: "MCP auth server", sub: "", x: 86, y: 16 },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 84, y: 74 },
        ],
        links: [["user", "client"], ["user", "idp"], ["client", "idp"], ["client", "as"], ["client", "server"]],
      });
      const wire = PG.wire(a.body);
      const steps = PG.steps(a.body, ["SSO: Alice signs in to the app with the company IdP", "Token exchange: ID token → ID-JAG (policy check)", "jwt-bearer: ID-JAG → MCP access token", "Call release-tools"]);
      const out = h("div", { class: "result" });
      const run = h("button", { class: "btn primary", type: "button", text: "Open the console" });
      a.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" },
        PG.switch("ema-group", "Alice is in “release-engineers”", true, function (v) { inGroup = v; }),
        PG.switch("ema-rev", "IT removed Alice's access this morning", false, function (v) { revoked = v; }), run), out), stage.el);
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); steps.reset();
        steps.mark(0, "run");
        await stage.send("client", "user", "redirect to IdP");
        await stage.send("user", "idp", "SSO login");
        await stage.send("idp", "client", "ID token");
        wire.add({ kind: "in", actor: "auth", label: "OpenID Connect: ID token for alice@acme.example (kept by the client)", status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }), body: { id_token: "<ID token: iss acme.idp.example, sub U019488227>", token_type: "Bearer", expires_in: 3600 } });
        steps.mark(0, "pass"); steps.mark(1, "run");
        await stage.send("client", "idp", "token exchange");
        wire.add({ actor: "client", label: "POST acme.idp.example/oauth2/token · token-exchange for an ID-JAG", http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "acme.idp.example", "Content-Type": "application/x-www-form-urlencoded" } },
          body: "grant_type=urn:ietf:params:oauth:grant-type:token-exchange\n&requested_token_type=urn:ietf:params:oauth:token-type:id-jag\n&audience=https://auth.release-tools.example.com/\n&resource=https://release-tools.example.com/mcp\n&scope=releases:read+releases:write\n&subject_token=<Alice's ID token>\n&subject_token_type=urn:ietf:params:oauth:token-type:id_token\n&client_id=<ops-console's id at the IdP>\n&client_secret=<ops-console's IdP secret>" });
        if (!inGroup || revoked) {
          await stage.send("idp", "client", "denied", { tone: "err" });
          wire.add({ kind: "in", actor: "auth", label: "400 · policy denied: no ID-JAG", status: "400", http: SPEC.res(400), body: { error: "invalid_grant", error_description: revoked ? "Access to release-tools was removed for this user" : "User is not in a group allowed to use release-tools" } });
          steps.mark(1, "fail");
          PG.setResult(out, "ok", (revoked ? "IT's change took effect on the very next request: " : "Policy said no: ") + "the IdP issued no grant, so the client never gets a token for release-tools. (The exact error code is the IdP's choice; it's an OAuth token error.) There was no consent screen to click through.");
          run.disabled = false; return;
        }
        await stage.send("idp", "client", "ID-JAG");
        wire.add({ kind: "in", actor: "auth", label: "ID-JAG issued (5 min)", status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }),
          body: { issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", access_token: "<ID-JAG>", token_type: "N_A", scope: "releases:read releases:write", expires_in: 300 } });
        wire.add({ kind: "note", label: "Inside the ID-JAG (typ oauth-id-jag+jwt): " + JSON.stringify({ iss: "https://acme.idp.example", sub: "U019488227", email: "alice@acme.example", aud: "https://auth.release-tools.example.com/", resource: "https://release-tools.example.com/mcp", client_id: "ops-console", scope: "releases:read releases:write", exp: "+300 s" }) });
        steps.mark(1, "pass"); steps.mark(2, "run");
        await stage.send("client", "as", "jwt-bearer");
        wire.add({ actor: "client", label: "POST auth.release-tools.example.com/token · jwt-bearer with the ID-JAG", http: { start: "POST /token HTTP/1.1", headers: { Host: "auth.release-tools.example.com", "Content-Type": "application/x-www-form-urlencoded" } },
          body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer\n&assertion=<ID-JAG>\n&client_id=https://ops-console.example.com/oauth/client.json" });
        await stage.send("as", "client", "access token");
        wire.add({ kind: "in", actor: "auth", label: "access token · audience release-tools only", status: "200", http: SPEC.res(200, "json", { "Cache-Control": "no-store" }), body: { token_type: "Bearer", access_token: "<access token, aud https://release-tools.example.com/mcp>", expires_in: 900, scope: "releases:read releases:write" } });
        steps.mark(2, "pass"); steps.mark(3, "run");
        const caps = { extensions: {} }; caps.extensions[EXT_EMA] = {};
        await stage.send("client", "server", "tools/call");
        wire.add({ actor: "client", label: "tools/call get_service_status · Bearer", http: SPEC.post("tools/call", "get_service_status"), body: SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "checkout-api" } }, 1, { caps: caps }), hl: [SPEC.K.caps] });
        await stage.send("server", "client", "200");
        steps.mark(3, "pass");
        PG.setResult(out, "ok", "Alice signed in once, to her company. The IdP decided she may use release-tools; the MCP auth server turned that decision into a token for this one server.");
        run.disabled = false;
      });
    },
    quiz: [
      { q: "What does the client send the company IdP to get an ID-JAG?",
        opts: ["The user's password", "A token-exchange request with the user's ID token as subject_token", "An MCP tools/call", "A client credentials grant"],
        a: 1, why: "RFC 8693 token exchange with requested_token_type id-jag." },
      { q: "Where is the access policy evaluated in enterprise-managed authorization?",
        opts: ["In the MCP server's tool code only", "At the company IdP, before it issues the ID-JAG", "In the client UI", "Nowhere"],
        a: 1, why: "The IdP is the decision point; no grant means no token." },
      { q: "IT removes an employee's access. What stops at once?",
        opts: ["Every token already issued", "New ID-JAGs, so no new MCP access tokens; existing ones last until they expire", "Nothing", "The MCP server"],
        a: 1, why: "Revocation is at the IdP; keep access tokens short-lived." },
    ],
  });

})();
