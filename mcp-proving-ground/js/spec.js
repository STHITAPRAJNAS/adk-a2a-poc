/* MCP Proving Ground — spec data
 *
 * Transcribed from the Model Context Protocol specification, revision
 * 2026-07-28 (modelcontextprotocol/modelcontextprotocol, docs/specification
 * and schema/2026-07-28/schema.ts). Lessons read from this module so a fact
 * lives in exactly one place.
 *
 * The running example is a "release-tools" MCP server: the release work the
 * repo's deployment_agent does over A2A, offered instead as MCP tools,
 * resources and prompts.
 */
(function () {
  "use strict";
  const PG = window.PG;

  const SPEC = (PG.SPEC = {});
  SPEC.V = "2026-07-28";
  SPEC.LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
  SPEC.url = "https://modelcontextprotocol.io/specification/2026-07-28";
  SPEC.K = {
    version: "io.modelcontextprotocol/protocolVersion",
    caps: "io.modelcontextprotocol/clientCapabilities",
    client: "io.modelcontextprotocol/clientInfo",
    server: "io.modelcontextprotocol/serverInfo",
    log: "io.modelcontextprotocol/logLevel",
    sub: "io.modelcontextprotocol/subscriptionId",
  };
  SPEC.clientInfo = { name: "ops-console", version: "3.2.0" };
  SPEC.serverInfo = { name: "release-tools", version: "1.4.0" };
  SPEC.defaultCaps = { elicitation: { form: {}, url: {} } };

  /* ── message builders ────────────────────────────────────────────────── */
  /* The per-request _meta every 2026-07-28 request carries. opts:
   *   caps     client capabilities (default: elicitation form+url)
   *   version  protocol version
   *   omit     array of keys to leave out ("version", "caps", "client")
   *   log      a logLevel to request notifications/message
   *   progress a progressToken                                            */
  SPEC.meta = function (opts) {
    opts = opts || {};
    const omit = opts.omit || [];
    const m = {};
    if (omit.indexOf("version") < 0) m[SPEC.K.version] = opts.version || SPEC.V;
    if (omit.indexOf("client") < 0) m[SPEC.K.client] = SPEC.clientInfo;
    if (omit.indexOf("caps") < 0) m[SPEC.K.caps] = opts.caps || SPEC.defaultCaps;
    if (opts.log) m[SPEC.K.log] = opts.log;
    if (opts.progress) m.progressToken = opts.progress;
    return m;
  };
  /* A JSON-RPC request. params get _meta unless opts.noMeta (legacy era). */
  SPEC.rpc = function (method, params, id, opts) {
    opts = opts || {};
    const p = Object.assign({}, params || {});
    if (!opts.noMeta) p._meta = Object.assign(SPEC.meta(opts), p._meta || {});
    const msg = { jsonrpc: "2.0", id: id === undefined ? 1 : id, method: method };
    if (Object.keys(p).length) msg.params = p;
    return msg;
  };
  SPEC.notif = function (method, params) {
    const msg = { jsonrpc: "2.0", method: method };
    if (params) msg.params = params;
    return msg;
  };
  /* A successful result: resultType first, serverInfo in _meta. */
  SPEC.ok = function (id, result, opts) {
    opts = opts || {};
    const r = Object.assign({ resultType: "complete" }, result || {});
    if (!opts.legacy) {
      r._meta = Object.assign({}, r._meta || {});
      r._meta[SPEC.K.server] = SPEC.serverInfo;
    } else delete r.resultType;
    return { jsonrpc: "2.0", id: id, result: r };
  };
  SPEC.err = function (id, code, message, data) {
    const e = { code: code, message: message };
    if (data !== undefined) e.data = data;
    return { jsonrpc: "2.0", id: id, error: e };
  };

  /* Streamable HTTP request start line + headers. name feeds Mcp-Name. */
  SPEC.post = function (method, name, extra, opts) {
    opts = opts || {};
    const headers = {
      Host: opts.host || "release-tools.internal",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (!opts.legacy) {
      headers["MCP-Protocol-Version"] = opts.version || SPEC.V;
      if (method) headers["Mcp-Method"] = method;
      if (name) headers["Mcp-Name"] = SPEC.headerValue(name);
    }
    if (opts.auth !== false) headers.Authorization = "Bearer <access token>";
    return { start: "POST " + (opts.path || "/mcp") + " HTTP/1.1", headers: Object.assign(headers, extra || {}) };
  };
  const REASON = { 200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error", 302: "Found" };
  SPEC.res = function (status, kind, extra) {
    const headers = {};
    if (kind === "sse") { headers["Content-Type"] = "text/event-stream"; headers["Cache-Control"] = "no-cache"; headers["X-Accel-Buffering"] = "no"; }
    else if (kind !== "none") headers["Content-Type"] = "application/json";
    return { start: "HTTP/1.1 " + status + " " + (REASON[status] || ""), headers: Object.assign(headers, extra || {}) };
  };

  /* §Value Encoding: plain ASCII as is; anything else as =?base64?…?= */
  SPEC.headerValue = function (v) {
    const s = String(v);
    const safe = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(s) && s.indexOf("=?base64?") !== 0;
    if (safe) return s;
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return "=?base64?" + btoa(bin) + "?=";
  };

  /* ── error codes (basic §Error codes, schema.ts) ─────────────────────── */
  SPEC.errors = [
    { code: -32700, name: "Parse error", when: "The bytes are not valid JSON." },
    { code: -32600, name: "Invalid Request", when: "Valid JSON, but not a valid JSON-RPC request (e.g. id is null)." },
    { code: -32601, name: "Method not found", when: "Unknown method. Over HTTP this comes with 404." },
    { code: -32602, name: "Invalid params", when: "Missing required _meta, unknown tool, bad cursor, resource not found, invalid log level." },
    { code: -32603, name: "Internal error", when: "The server failed while handling a valid request." },
    { code: -32020, name: "HeaderMismatch", when: "An HTTP header (MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-*) disagrees with the body." },
    { code: -32021, name: "MissingRequiredClientCapability", when: "The server needs a capability the client did not declare; data.requiredCapabilities says which." },
    { code: -32022, name: "UnsupportedProtocolVersion", when: "The requested protocol version is not one the server speaks; data lists supported and requested." },
  ];
  SPEC.errorsLegacy = [
    { code: -32002, name: "Resource not found (before 2026-07-28)", when: "Now -32602. Clients SHOULD still accept -32002 from older servers." },
    { code: -32042, name: "URL elicitation required (2025-11-25 only)", when: "Replaced by MRTR: the server returns an InputRequiredResult instead." },
  ];
  SPEC.errorRanges = "-32000 to -32019: implementation-defined (existing SDK use grandfathered). -32020 to -32099: reserved for the MCP specification.";

  /* ── methods ──────────────────────────────────────────────────────────── */
  SPEC.methods = [
    { m: "server/discover", dir: "c→s", what: "Versions, capabilities, identity, instructions. Servers MUST implement it.", cache: true },
    { m: "tools/list", dir: "c→s", what: "The tools, paginated, deterministic order.", cache: true },
    { m: "tools/call", dir: "c→s", what: "Run a tool. May answer input_required (MRTR).", mrtr: true },
    { m: "resources/list", dir: "c→s", what: "Concrete resources, paginated.", cache: true },
    { m: "resources/templates/list", dir: "c→s", what: "RFC 6570 URI templates.", cache: true },
    { m: "resources/read", dir: "c→s", what: "Read one URI; may return several contents. May answer input_required.", cache: true, mrtr: true },
    { m: "prompts/list", dir: "c→s", what: "Prompt templates, paginated.", cache: true },
    { m: "prompts/get", dir: "c→s", what: "Fill a prompt with arguments. May answer input_required.", mrtr: true },
    { m: "completion/complete", dir: "c→s", what: "Suggestions for a prompt or template argument." },
    { m: "subscriptions/listen", dir: "c→s", what: "One long-lived stream of opted-in change notifications." },
    { m: "notifications/cancelled", dir: "either", what: "Stop work on a request (stdio; on HTTP, close the stream)." },
    { m: "notifications/progress", dir: "s→c", what: "Progress for a request that carried a progressToken." },
  ];
  SPEC.removed = [
    { m: "initialize / notifications/initialized", why: "No handshake: version and capabilities ride on every request." },
    { m: "Mcp-Session-Id header", why: "No protocol sessions. Cross-call state uses server-minted handles in tool arguments." },
    { m: "ping", why: "Nothing to keep alive; transports have their own liveness." },
    { m: "logging/setLevel", why: "Per-request _meta io.modelcontextprotocol/logLevel instead." },
    { m: "HTTP GET stream, resources/subscribe", why: "subscriptions/listen instead." },
    { m: "Last-Event-ID resumability", why: "A broken stream loses the request; re-issue with a new id." },
    { m: "server→client requests (sampling, elicitation, roots)", why: "MRTR: they travel inside an InputRequiredResult." },
    { m: "notifications/elicitation/complete, elicitationId", why: "The client learns the outcome by retrying the request." },
    { m: "notifications/roots/list_changed", why: "Roots are deprecated and fetched per request." },
  ];

  /* ── the release-tools server ─────────────────────────────────────────── */
  SPEC.tools = [
    {
      name: "check_release_readiness",
      title: "Check release readiness",
      description: "Report whether a service version passed CI, has a changelog, and has no open blocking incidents. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name, e.g. checkout-api" },
          version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$", description: "Semantic version" },
        },
        required: ["service", "version"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ready: { type: "boolean" }, checks: { type: "array", items: { type: "string" } }, blockers: { type: "array", items: { type: "string" } } },
        required: ["ready", "checks", "blockers"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "get_service_status",
      title: "Service status",
      description: "Current version, replicas and error rate for a service.",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "scale_service",
      title: "Scale a service",
      description: "Set the replica count of a service in one region.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string" },
          replicas: { type: "integer", minimum: 0, maximum: 50 },
          region: { type: "string", enum: ["eu-west1", "us-east1", "ap-south1"], "x-mcp-header": "Region" },
        },
        required: ["service", "replicas", "region"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "rollback_release",
      title: "Roll back a release",
      description: "Roll a service back to an earlier version in production.",
      inputSchema: {
        type: "object",
        properties: { service: { type: "string" }, to_version: { type: "string" } },
        required: ["service", "to_version"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
  SPEC.tool = function (name) { return SPEC.tools.find(function (t) { return t.name === name; }); };

  SPEC.resources = [
    { uri: "runbook://checkout-api/rollback", name: "checkout-api rollback runbook", mimeType: "text/markdown",
      annotations: { audience: ["user", "assistant"], priority: 0.9, lastModified: "2026-09-30T08:12:00Z" } },
    { uri: "runbook://billing-worker/rollback", name: "billing-worker rollback runbook", mimeType: "text/markdown",
      annotations: { audience: ["user", "assistant"], priority: 0.7, lastModified: "2026-08-14T15:40:00Z" } },
    { uri: "file:///srv/releases/checkout-api/CHANGELOG.md", name: "checkout-api changelog", mimeType: "text/markdown",
      annotations: { audience: ["assistant"], priority: 0.4 } },
  ];
  SPEC.templates = [
    { uriTemplate: "logs://{service}/{date}", name: "Service logs for one day", mimeType: "text/plain",
      description: "Error and warning lines for a service on a date (YYYY-MM-DD)." },
    { uriTemplate: "release://{service}/{version}/notes", name: "Release notes", mimeType: "text/markdown" },
  ];
  SPEC.prompts = [
    { name: "incident_summary", title: "Summarise an incident",
      description: "Turn the last hours of logs and alerts for a service into an incident summary.",
      arguments: [{ name: "service", description: "Service name", required: true }, { name: "hours", description: "How far back, default 6", required: false }] },
    { name: "release_notes", title: "Draft release notes",
      description: "Draft customer-facing notes from a changelog.",
      arguments: [{ name: "service", required: true }, { name: "version", required: true }] },
  ];
  SPEC.services = ["checkout-api", "billing-worker", "search-indexer", "cart-api", "catalog-sync"];

  SPEC.serverCaps = {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
    completions: {},
    extensions: { "io.modelcontextprotocol/tasks": {} },
  };
  SPEC.discoverResult = function (opts) {
    opts = opts || {};
    return {
      supportedVersions: opts.versions || [SPEC.V, "2025-11-25"],
      capabilities: opts.caps || SPEC.serverCaps,
      instructions: "Release operations for the shop's services. Check readiness before any rollout; rollbacks need a human confirmation.",
      ttlMs: 3600000,
      cacheScope: "public",
    };
  };

  /* A fake, opaque requestState: base64url of a JSON payload plus a fake
   * MAC. Teaching only: the point is that the client must not touch it. */
  SPEC.requestState = function (payload) {
    return PG.b64url(JSON.stringify(payload)) + "." + PG.b64url(PG.hex(12));
  };

  /* Tool name rule (tools §Tool names): 1–128 chars of A-Z a-z 0-9 _ - . */
  SPEC.validToolName = function (n) { return /^[A-Za-z0-9_.-]{1,128}$/.test(n); };
})();
