/* A2A Proving Ground — spec data
 *
 * Everything here is transcribed from the A2A 1.0 specification
 * (a2aproject/A2A, docs/specification.md + specification/a2a.proto).
 * Lessons read from this module so a fact lives in exactly one place.
 */
(function () {
  "use strict";
  const PG = window.PG;

  const SPEC = (PG.SPEC = {});
  SPEC.version = "1.0";
  SPEC.url = "https://a2a-protocol.org/latest/specification/";

  /* §5.3 Method mapping reference */
  SPEC.methods = [
    { op: "Send message", jsonrpc: "SendMessage", rest: "POST /message:send", stream: false,
      what: "Start or continue work. Returns a Task or, for simple replies, a Message." },
    { op: "Send streaming message", jsonrpc: "SendStreamingMessage", rest: "POST /message:stream", stream: true,
      what: "Same as SendMessage, but the response is a Server-Sent Events stream of StreamResponse objects." },
    { op: "Get task", jsonrpc: "GetTask", rest: "GET /tasks/{id}", stream: false,
      what: "Read a task's current status, artifacts and (optionally) history. The polling primitive." },
    { op: "List tasks", jsonrpc: "ListTasks", rest: "GET /tasks", stream: false,
      what: "Cursor-paginated list, filtered by contextId/status. MUST only return tasks the caller may see." },
    { op: "Cancel task", jsonrpc: "CancelTask", rest: "POST /tasks/{id}:cancel", stream: false,
      what: "Request cancellation. Terminal tasks answer TaskNotCancelableError." },
    { op: "Subscribe to task", jsonrpc: "SubscribeToTask", rest: "GET /tasks/{id}:subscribe", stream: true,
      note: "a2a.proto annotates GET; the spec's §5.3 table lists POST. Check your server.",
      what: "Re-attach to a running task's event stream after a dropped connection." },
    { op: "Create push notification config", jsonrpc: "CreateTaskPushNotificationConfig", rest: "POST /tasks/{id}/pushNotificationConfigs", stream: false,
      what: "Register a webhook the agent will POST task updates to." },
    { op: "Get push notification config", jsonrpc: "GetTaskPushNotificationConfig", rest: "GET /tasks/{id}/pushNotificationConfigs/{configId}", stream: false,
      what: "Read one webhook registration." },
    { op: "List push notification configs", jsonrpc: "ListTaskPushNotificationConfigs", rest: "GET /tasks/{id}/pushNotificationConfigs", stream: false,
      what: "List a task's webhook registrations." },
    { op: "Delete push notification config", jsonrpc: "DeleteTaskPushNotificationConfig", rest: "DELETE /tasks/{id}/pushNotificationConfigs/{configId}", stream: false,
      what: "Remove a webhook registration." },
    { op: "Get extended Agent Card", jsonrpc: "GetExtendedAgentCard", rest: "GET /extendedAgentCard", stream: false,
      what: "Fetch the richer card an authenticated client is allowed to see." },
  ];

  /* §5.4 Error code mappings */
  SPEC.errors = [
    { name: "TaskNotFoundError", code: -32001, grpc: "NOT_FOUND", http: "404 Not Found",
      when: "The task id does not exist, or exists but is not visible to this caller." },
    { name: "TaskNotCancelableError", code: -32002, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "Cancel was requested for a task that is already terminal." },
    { name: "PushNotificationNotSupportedError", code: -32003, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "Push config was requested but capabilities.pushNotifications is false." },
    { name: "UnsupportedOperationError", code: -32004, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "The operation is not supported: e.g. a message to a terminal task, streaming when streaming is off." },
    { name: "ContentTypeNotSupportedError", code: -32005, grpc: "INVALID_ARGUMENT", http: "400 Bad Request",
      when: "A part's media type is not accepted by the agent or the skill." },
    { name: "InvalidAgentResponseError", code: -32006, grpc: "INTERNAL", http: "500 Internal Server Error",
      when: "The agent produced a response that does not conform to the spec." },
    { name: "ExtendedAgentCardNotConfiguredError", code: -32007, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "The card declares extendedAgentCard: true but none is configured." },
    { name: "ExtensionSupportRequiredError", code: -32008, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "The card marks an extension required: true and the client did not activate it." },
    { name: "VersionNotSupportedError", code: -32009, grpc: "FAILED_PRECONDITION", http: "400 Bad Request",
      when: "The A2A-Version the client asked for is not served by this interface." },
  ];
  SPEC.err = function (name) { return SPEC.errors.find(function (e) { return e.name === name; }); };

  /* TaskState (a2a.proto) */
  SPEC.states = ["SUBMITTED", "WORKING", "INPUT_REQUIRED", "AUTH_REQUIRED", "COMPLETED", "FAILED", "CANCELED", "REJECTED"];
  SPEC.terminal = ["COMPLETED", "FAILED", "CANCELED", "REJECTED"];
  SPEC.interrupted = ["INPUT_REQUIRED", "AUTH_REQUIRED"];

  SPEC.bindings = ["JSONRPC", "GRPC", "HTTP+JSON"];

  /* ── builders for wire objects in 1.0 ProtoJSON shape ─────────────────── */
  SPEC.msg = function (role, parts, extra) {
    return Object.assign({ messageId: "msg-" + PG.hex(4), role: role === "agent" ? "ROLE_AGENT" : "ROLE_USER",
      parts: parts.map(function (p) { return typeof p === "string" ? { text: p } : p; }) }, extra || {});
  };
  SPEC.task = function (id, ctx, state, extra) {
    return Object.assign({ id: id, contextId: ctx, status: { state: "TASK_STATE_" + state, timestamp: new Date().toISOString() } }, extra || {});
  };
  SPEC.statusUpdate = function (id, ctx, state, text) {
    const st = { state: "TASK_STATE_" + state };
    if (text) st.message = SPEC.msg("agent", [text]);
    return { statusUpdate: { taskId: id, contextId: ctx, status: st } };
  };
  SPEC.rpc = function (method, params, id) {
    const r = { jsonrpc: "2.0", id: id || 1, method: method };
    if (params !== undefined) r.params = params;
    return r;
  };
  SPEC.rpcErr = function (name, id, detail) {
    const e = SPEC.err(name);
    const out = { jsonrpc: "2.0", id: id || 1, error: { code: e.code, message: e.name.replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") } };
    if (detail) out.error.data = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: detail, domain: "a2a-protocol.org" }];
    return out;
  };
  SPEC.post = function (path, headers) {
    return { start: "POST " + path + " HTTP/1.1", headers: Object.assign({ Host: "agents.example.com", "Content-Type": "application/json", "A2A-Version": "1.0" }, headers || {}) };
  };
  SPEC.res = function (code, headers) {
    const text = { 200: "OK", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 502: "Bad Gateway", 504: "Gateway Timeout" }[code] || "";
    return { start: "HTTP/1.1 " + code + " " + text, headers: headers || { "Content-Type": "application/json" } };
  };

  /* ── sample cards ────────────────────────────────────────────────────── */
  const SKILLS = [
    { id: "release_readiness", name: "Release readiness check",
      description: "Reports whether a service version can ship to an environment: open incidents, tier, owner, risk, and whether a human approval is required.",
      tags: ["release", "readiness", "preflight"],
      examples: ["Is checkout-api 2.14.0 ready for production?"] },
    { id: "compliance_scan", name: "Pre-release compliance scan",
      description: "Runs the SOC2/PCI control scan for a service before release. Long-running; streams progress.",
      tags: ["compliance", "soc2", "pci", "long-running"],
      examples: ["Run the compliance scan for billing-worker"] },
    { id: "human_change_approval", name: "Human change approval",
      description: "Opens a change ticket and pauses the task in TASK_STATE_INPUT_REQUIRED until a human approves or rejects it.",
      tags: ["hitl", "approval", "governance"],
      examples: ["Deploy checkout-api 2.14.0 to production"] },
    { id: "deployment_execution", name: "Deployment execution",
      description: "Runs a canary rollout that outlives a single request and reports the terminal result as an artifact.",
      tags: ["deploy", "canary", "long-running"],
      examples: ["Roll out checkout-api 2.14.0 now that CHG-1234 is approved"],
      securityRequirements: [{ schemes: { platformOAuth: { list: ["deploy:write"] } } }] },
  ];

  PG.cards = {};
  PG.cards.release = {
    name: "Release Operations Agent",
    description: "Checks release readiness, runs compliance scans, opens human change-approval tickets and drives canary deployments for the platform team.",
    supportedInterfaces: [
      { url: "https://agents.example.com/a2a/release", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://agents.example.com/a2a/release/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    provider: { organization: "Platform Team", url: "https://platform.example.com" },
    version: "2.3.0",
    documentationUrl: "https://platform.example.com/docs/release-agent",
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true },
    securitySchemes: {
      platformOAuth: {
        oauth2SecurityScheme: {
          description: "Machine-to-machine access for other agents",
          flows: { clientCredentials: {
            tokenUrl: "https://auth.example.com/oauth2/token",
            scopes: { "deploy:read": "Read release state", "deploy:write": "Start deployments", "deploy:prod": "Deploy to production" },
          } },
        },
      },
    },
    securityRequirements: [{ schemes: { platformOAuth: { list: ["deploy:read"] } } }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: SKILLS,
  };

  /* The card this repository shipped before the 1.0 migration (0.3 shape). */
  PG.cards.legacy03 = {
    name: "deployment_agent",
    description: "Release operations specialist. Checks release readiness, runs compliance scans, raises human change-approval tickets and drives deployment jobs.",
    url: "http://127.0.0.1:8001/a2a/deployment_agent",
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    provider: { organization: "adk-a2a-poc", url: "https://github.com/sthitaprajnas/adk-a2a-poc" },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    supportsAuthenticatedExtendedCard: false,
    skills: SKILLS.slice(0, 3).map(function (s) { return { id: s.id, name: s.name, description: s.description, tags: s.tags, examples: s.examples }; }),
  };

  PG.cards.broken = {
    name: "Weather Oracle",
    supportedInterfaces: [{ url: "http://weather.example.net/a2a", protocolBinding: "SOAP", protocolVersion: "1.0.2" }],
    version: "0.1",
    capabilities: { streaming: "yes" },
    securityRequirements: [{ schemes: { apiKey: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    skills: [{ id: "forecast", name: "Forecast" }],
  };

  /* Security scheme samples, one per scheme type (§4.5). */
  SPEC.schemes = {
    apiKey: { apiKeySecurityScheme: { description: "Key issued in the developer portal", location: "header", name: "X-API-Key" } },
    bearer: { httpAuthSecurityScheme: { description: "Signed JWT access token", scheme: "Bearer", bearerFormat: "JWT" } },
    oauthCC: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: "https://auth.example.com/oauth2/token", scopes: { "deploy:read": "Read release state", "deploy:write": "Start deployments" } } } } },
    oauthAC: { oauth2SecurityScheme: { flows: { authorizationCode: { authorizationUrl: "https://auth.example.com/oauth2/authorize", tokenUrl: "https://auth.example.com/oauth2/token", scopes: { "calendar.read": "Read the user's calendar" }, pkceRequired: true } } } },
    oauthDC: { oauth2SecurityScheme: { flows: { deviceCode: { deviceAuthorizationUrl: "https://auth.example.com/oauth2/device", tokenUrl: "https://auth.example.com/oauth2/token", scopes: { "deploy:read": "Read release state" } } } } },
    oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration" } },
    mtls: { mtlsSecurityScheme: { description: "Client certificate issued by the platform CA" } },
  };
})();
