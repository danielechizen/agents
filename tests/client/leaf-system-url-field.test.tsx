/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider, useModalController } from "@/client/components";
import { IntegrationEditModal } from "@/client/pages/resources/IntegrationEditModal";

// The operator types the ERP base on the Leaf Admin integration. An empty value,
// http and a trailing slash never leave the form. Assertions stay on strings.

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function install(posts: unknown[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "POST" && path === "/api/v1/integrations/instances") {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ id: "9", inboundUrl: null });
    }
    if (path === "/api/v1/integrations/catalog") {
      return json({
        catalog: [
          {
            catalogType: "LEAF_ADMIN",
            label: "Leaf Admin",
            description: "ERP",
            kind: "TOOLPACK",
            supportsInbound: true,
            defaultInboundAuth: "STATIC_HEADER",
            tools: [],
          },
        ],
      });
    }
    if (path === "/api/v1/vault") {
      return json({
        entries: [
          {
            id: "4",
            name: "Leaf token",
            kind: "generic",
            baseUrl: null,
            paramName: null,
            status: "active",
          },
        ],
      });
    }
    if (path === "/api/v1/tools") return json({ tools: [] });
    if (path === "/api/v1/business-hours") return json({ businessHours: [] });
    return json({ items: [], entries: [] });
  }) as typeof fetch;
}

function open(id?: string) {
  function Harness() {
    const modal = useModalController<{ id?: string }>();
    const opened = useRef(false);
    useEffect(() => {
      if (opened.current) return;
      opened.current = true;
      modal.open(id ? { id } : {});
    }, [modal]);
    return <IntegrationEditModal modal={modal} />;
  }
  render(
    <MemoryRouter>
      <ToastProvider>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

test("the Leaf Admin form shows the base URL and refuses an empty or invalid one", async () => {
  const posts: unknown[] = [];
  install(posts);
  open();
  const testButton = await screen.findByRole("button", {
    name: "Test connection",
  });
  expect((testButton as HTMLButtonElement).disabled).toBe(true);
  expect(
    document.body.textContent?.includes("Save the integration to test."),
  ).toBe(true);
  const field = await screen.findByLabelText(/ERP base URL/);
  expect((field as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(document.body.textContent?.includes("Enter the ERP base URL.")).toBe(
    true,
  );
  expect(posts.length).toBe(0);

  fireEvent.change(field, { target: { value: "http://erp.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(document.body.textContent?.includes("The URL must use https.")).toBe(
    true,
  );
  expect(posts.length).toBe(0);

  fireEvent.change(field, { target: { value: "https://erp.example.com/" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    document.body.textContent?.includes("The URL must not end with a slash."),
  ).toBe(true);
  expect(posts.length).toBe(0);

  fireEvent.change(field, { target: { value: "https://erp.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Integration created.");
  const sent = posts[0] as { config?: { system_url?: string } };
  expect(sent.config?.system_url).toBe("https://erp.example.com");
});

test("the connection test uses the saved integration and shows the answer", async () => {
  const probes: string[] = [];
  let reply: unknown = { ok: true, httpStatus: 200, statusCode: "1" };
  install([]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "POST" && path.endsWith("/test-connection")) {
      probes.push(String(init?.body ?? ""));
      return json(reply);
    }
    if (method === "GET" && path.endsWith("/instances/9")) {
      return json({
        integration: {
          id: "9",
          catalogType: "LEAF_ADMIN",
          name: "Leaf",
          enabled: true,
          config: { system_url: "https://erp.example.com" },
          credentialRef: "vault:4",
          inboundAuthStrategy: "STATIC_HEADER",
          inboundSecretRef: null,
          routeToken: null,
          routeTokenStatus: "absent",
          inboundUrl: null,
        },
      });
    }
    if (path === "/api/v1/integrations/catalog") {
      return json({
        catalog: [
          {
            catalogType: "LEAF_ADMIN",
            label: "Leaf Admin",
            description: "ERP",
            kind: "TOOLPACK",
            supportsInbound: true,
            defaultInboundAuth: "STATIC_HEADER",
            tools: [],
          },
        ],
      });
    }
    if (path === "/api/v1/vault") {
      return json({
        entries: [
          {
            id: "4",
            name: "Leaf token",
            kind: "generic",
            baseUrl: null,
            paramName: null,
            status: "active",
          },
        ],
      });
    }
    if (path === "/api/v1/tools") return json({ tools: [] });
    if (path === "/api/v1/business-hours") return json({ businessHours: [] });
    return json({ items: [], entries: [] });
  }) as typeof fetch;
  open("9");
  const button = await screen.findByRole("button", { name: "Test connection" });
  await screen.findByText("Uses the saved URL and token.");
  fireEvent.click(button);
  await screen.findByText("Connection OK (HTTP 200, statusCode 1).");
  expect(probes.some((body) => body.includes("token"))).toBe(false);
  reply = { ok: false, code: "rejected", httpStatus: 403 };
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Leaf Admin rejected the credential (HTTP 403).");
});
