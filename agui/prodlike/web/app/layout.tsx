import type { ReactNode } from "react";
import "@copilotkit/react-ui/styles.css";
import "./globals.css";

export const metadata = {
  title: "Support desk",
  description: "CopilotKit → load balancer → ADK replicas: ag-ui#2603 in a production-like setup",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
