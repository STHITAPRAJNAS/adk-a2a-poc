// The CopilotKit runtime: the browser talks to this route, and this route talks
// AG-UI to the ADK agent through the load balancer. This is the documented
// CopilotKit + ADK wiring (CopilotRuntime + HttpAgent), nothing custom.
//
//   browser ──► /api/copilotkit (this, on any copilotkit-web replica)
//                    │  HttpAgent: POST {ADK_URL}/agui, the whole history every run
//                    ▼
//              adk-lb (L7 round robin, no affinity) ──► support-desk replicas
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";
import type { NextRequest } from "next/server";

// The load balancer in front of the ADK replicas, never a single pod.
const ADK_URL = process.env.ADK_URL ?? "http://127.0.0.1:8300";

const runtime = new CopilotRuntime({
  agents: {
    support_desk: new HttpAgent({ url: `${ADK_URL}/agui` }),
  },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
