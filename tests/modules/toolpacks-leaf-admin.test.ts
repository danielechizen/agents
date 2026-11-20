import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import { leafInvoiceExternalId } from "@/modules/integrations/leaf-admin-mapper";
import { getMapper } from "@/modules/integrations/mappers";
import { leafAdminToolpack } from "@/modules/integrations/toolpacks/leaf-admin";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

const SECRET = "LEAF_SECRET_KEY_DO_NOT_LEAK";
const BASE = "https://leaf.example.com";
const PHONE = "+55 (11) 98888-7777";
const PHONE_DIGITS = "5511988887777";
const DOCUMENT = "123.456.789-01";
const DOCUMENT_DIGITS = "12345678901";

type Call = { url: string; init: RequestInit };

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  reply: (
    url: string,
    init: RequestInit,
  ) => { status?: number; json: unknown } | "throw",
) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url: String(url), init: i });
    const answered = reply(String(url), i);
    if (answered === "throw") throw new Error(`socket ${SECRET}`);
    return ok(answered.json, answered.status ?? 200);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body ?? "null"));
}

function contactBase(
  row: {
    phone: string | null;
    customAttributes: Record<string, unknown>;
  } | null,
  refs: Array<{ externalId: string }> = [],
) {
  const tx = {
    $executeRaw: async () => 1,
    contact: { findUnique: async () => row },
    integrationExternalRef: {
      upsert: async (args: { create: { externalId: string } }) => {
        refs.push(args.create);
        return args.create;
      },
    },
  };
  const client = {
    $extends: () => client,
    $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return client as unknown as PrismaClient;
}

function ctx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: contactBase({ phone: PHONE, customAttributes: {} }),
    threadId: "1:1:9",
    contactDbId: 7n,
    resolveCredential: async () => SECRET,
    assertSafe: async () => undefined,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 4n,
    catalogType: "LEAF_ADMIN",
    config: { system_url: BASE },
    credentialRef: "vault:leaf",
    enabledTools: [],
    ...over,
  };
}

function tool(
  name: string,
  overCtx: Partial<ToolpackCtx> = {},
  config?: Record<string, unknown>,
) {
  const built = leafAdminToolpack.build(
    sel({
      enabledTools: [name],
      ...(config ? { config } : {}),
    }),
    ctx(overCtx),
  );
  const found = built[0];
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const CONTRACT = {
  id: 15,
  name: "Maria",
  status: "active",
  connectionId: 99,
  customerId: "cust-1",
  address: { street: "Rua A", number: "10" },
};

function contractsPayload(results: unknown[], total = results.length) {
  return { statusCode: 1, results, total };
}

describe("leaf admin catalog and mapper", () => {
  test("the catalog entry is an authenticated outbound toolpack", () => {
    expect(getCatalogEntry("LEAF_ADMIN")).toMatchObject({
      kind: "TOOLPACK",
      supportsInbound: true,
      defaultInboundAuth: "STATIC_HEADER",
      requiresInboundAuth: true,
    });
  });

  test("INVOICE_PAID wakes the conversation stored for that invoice id", () => {
    const mapped = getMapper("LEAF_ADMIN")?.map({
      event: "INVOICE_PAID",
      data: {
        id: 15,
        uid: "uid-15",
        due_date: "2026-11-01",
        value: 89.9,
        status: "paid",
      },
    });
    expect(mapped).toEqual({
      ok: true,
      event: {
        kind: "agent_nudge",
        externalId: leafInvoiceExternalId("15"),
        dedupeKey: "INVOICE_PAID:15",
        summary: "Invoice paid",
        status: "paid",
        value: 89.9,
        metadata: { dueDate: "2026-11-01" },
      },
    });
  });

  test("a paid invoice with only uid correlates on the uid", () => {
    const mapped = getMapper("LEAF_ADMIN")?.map({
      event: "INVOICE_PAID",
      data: { uid: "uid-9", value: 10, status: "paid" },
    });
    expect(mapped?.ok).toBe(true);
    if (mapped?.ok)
      expect(mapped.event.externalId).toBe(leafInvoiceExternalId("uid-9"));
  });

  test("other events are ignored and a broken body is invalid", () => {
    expect(
      getMapper("LEAF_ADMIN")?.map({
        event: "INVOICE_OPENED",
        data: { id: 1 },
      }),
    ).toEqual({
      ok: false,
      reason: "unhandled",
    });
    expect(getMapper("LEAF_ADMIN")?.map({ event: "INVOICE_PAID" })?.ok).toBe(
      false,
    );
    expect(getMapper("LEAF_ADMIN")?.map({ nope: true })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("leaf admin toolpack — identity", () => {
  test("phone lookup uses the contact phone and skips the stored document", async () => {
    const { impl, calls } = mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/integrations/contracts")) {
        return { json: contractsPayload([CONTRACT]) };
      }
      return { json: { statusCode: 0 } };
    });
    const out = (await tool("leaf_lookup_customer", {
      fetchImpl: impl,
      base: contactBase({
        phone: PHONE,
        customAttributes: { cpf_cnpj: DOCUMENT },
      }),
    }).invoke({})) as string;
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]?.url ?? "");
    expect(u.pathname).toBe("/api/v2/integrations/contracts");
    expect(u.searchParams.get("phone")).toBe(PHONE_DIGITS);
    expect(u.searchParams.get("document")).toBeNull();
    expect(u.searchParams.get("page")).toBe("1");
    expect(u.searchParams.get("limit")).toBe("50");
    expect(header(calls[0]?.init ?? {}, "x-auth-header")).toBe(SECRET);
    expect(out).toContain("Maria");
    expect(out).toContain('"matchedBy":"phone"');
    expect(out).not.toContain(SECRET);
  });

  test("document is the fallback only when the phone matches nothing", async () => {
    const { impl, calls } = mockFetch((url) => {
      const u = new URL(url);
      if (u.searchParams.get("phone")) return { json: contractsPayload([]) };
      if (u.searchParams.get("document") === DOCUMENT_DIGITS) {
        return { json: contractsPayload([{ id: "8", name: "Por CPF" }]) };
      }
      return { json: contractsPayload([]) };
    });
    const out = (await tool("leaf_lookup_customer", {
      fetchImpl: impl,
      base: contactBase({
        phone: PHONE,
        customAttributes: { cpf_cnpj: DOCUMENT },
      }),
    }).invoke({})) as string;
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("phone")).toBe(
      PHONE_DIGITS,
    );
    expect(new URL(calls[1]?.url ?? "").searchParams.get("document")).toBe(
      DOCUMENT_DIGITS,
    );
    expect(out).toContain("Por CPF");
    expect(out).toContain('"matchedBy":"document"');
  });

  test("pages until the total is covered and stops on an empty page", async () => {
    const { impl, calls } = mockFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) {
        return {
          json: contractsPayload(
            Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1) })),
            51,
          ),
        };
      }
      if (page === 2) return { json: contractsPayload([{ id: "51" }], 51) };
      return { json: contractsPayload([{ id: "extra" }], 51) };
    });
    const out = (await tool("leaf_lookup_customer", { fetchImpl: impl }).invoke(
      {},
    )) as string;
    expect(calls).toHaveLength(2);
    expect(out).toContain('"id":"51"');
    expect(out).not.toContain("extra");
  });

  test("an empty later page stops the walk", async () => {
    const { impl, calls } = mockFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return { json: contractsPayload([{ id: "1" }], 100) };
      return { json: contractsPayload([], 100) };
    });
    await tool("leaf_lookup_customer", { fetchImpl: impl }).invoke({});
    expect(calls).toHaveLength(2);
  });

  test("never asks for a 21st page", async () => {
    const { impl, calls } = mockFetch((url) => {
      const page = new URL(url).searchParams.get("page") ?? "0";
      return { json: contractsPayload([{ id: page }], 10_000) };
    });
    await tool("leaf_lookup_customer", { fetchImpl: impl }).invoke({});
    expect(calls).toHaveLength(20);
  });
});

describe("leaf admin toolpack — reads", () => {
  test("connection status strips the pppoe password", async () => {
    const password = "PPPOE-SECRET-VALUE";
    const { impl, calls } = mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/contracts"))
        return { json: contractsPayload([CONTRACT]) };
      return {
        json: {
          statusCode: "OK",
          results: [
            {
              connectionId: 99,
              status: "online",
              pppoeLogin: "maria",
              pppoePassword: password,
              gpon: { status: "online", rxPower: -18, pppoePassword: password },
            },
          ],
        },
      };
    });
    const out = (await tool("leaf_connection_status", {
      fetchImpl: impl,
    }).invoke({
      connectionId: "99",
    })) as string;
    const customer = calls.find((c) =>
      c.url.includes("/integrations/customers"),
    );
    expect(new URL(customer?.url ?? "").searchParams.get("limit")).toBe("1");
    expect(new URL(customer?.url ?? "").searchParams.get("connectionId")).toBe(
      "99",
    );
    expect(out).toContain("online");
    expect(out).toContain("maria");
    expect(out).not.toContain(password);
    expect(out).not.toContain("pppoePassword");
  });

  test("a connection the lookup did not return is refused", async () => {
    const { impl, calls } = mockFetch(() => ({
      json: contractsPayload([CONTRACT]),
    }));
    const out = (await tool("leaf_connection_status", {
      fetchImpl: impl,
    }).invoke({
      connectionId: "404",
    })) as string;
    expect(out).toContain("not returned");
    expect(calls.every((c) => c.url.includes("/contracts"))).toBe(true);
  });

  test("second copy for the contact phone returns pix and boleto", async () => {
    const sent: Array<{ name: string; mime: string; text: string }> = [];
    const refs: Array<{ externalId: string }> = [];
    const { impl, calls } = mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/contracts"))
        return { json: contractsPayload([CONTRACT]) };
      if (u.pathname.endsWith("/billets")) {
        return {
          json: {
            statusCode: 1,
            paymentMethods: { pix: true, bankSlip: true, creditCard: true },
            results: [
              {
                id: 7,
                uid: "uid-7",
                description: "Mensalidade",
                amount: 89.9,
                status: "delayed",
              },
            ],
          },
        };
      }
      if (u.searchParams.get("type") === "pix") {
        return {
          json: { statusCode: "ok", copyPaste: "000201PIX", qr: "qr-image" },
        };
      }
      if (u.searchParams.get("type") === "bankSlip") {
        return {
          json: {
            statusCode: 1,
            url: "https://pay.example/boleto/7",
            pdf: Buffer.from("hello-pdf").toString("base64"),
          },
        };
      }
      if (u.searchParams.get("type") === "creditCard") {
        return { json: { statusCode: 1, url: "https://pay.example/card/7" } };
      }
      return { json: { statusCode: 0 } };
    });
    const second = tool("leaf_second_copy", {
      fetchImpl: impl,
      base: contactBase({ phone: PHONE, customAttributes: {} }, refs),
      chatwoot: {
        client: {
          muted: false,
          sendFileAttachment: async (
            _id: number,
            bytes: ArrayBuffer,
            name: string,
            mime: string,
          ) => {
            sent.push({ name, mime, text: new TextDecoder().decode(bytes) });
          },
        } as unknown as ChatwootClient,
        conversationId: 9,
      },
    });
    const pix = (await second.invoke({
      contractId: "15",
      invoiceId: "7",
      type: "pix",
    })) as string;
    const boleto = (await second.invoke({
      contractId: "15",
      invoiceId: "7",
      type: "boleto",
    })) as string;
    const card = (await second.invoke({
      contractId: "15",
      invoiceId: "7",
      type: "card",
    })) as string;
    expect(
      calls.some(
        (c) => new URL(c.url).searchParams.get("phone") === PHONE_DIGITS,
      ),
    ).toBe(true);
    expect(pix).toContain("000201PIX");
    expect(pix).toContain("qr-image");
    expect(boleto).toContain("https://pay.example/boleto/7");
    expect(boleto).not.toContain(Buffer.from("hello-pdf").toString("base64"));
    expect(sent).toEqual([
      { name: "boleto-7.pdf", mime: "application/pdf", text: "hello-pdf" },
    ]);
    expect(card).toContain("https://pay.example/card/7");
    expect(
      calls.some((c) => c.url.includes("/billets/7/payment?type=pix")),
    ).toBe(true);
    expect(
      calls.some((c) => c.url.includes("/billets/7/payment?type=bankSlip")),
    ).toBe(true);
    expect(
      calls.some((c) => c.url.includes("/billets/7/payment?type=creditCard")),
    ).toBe(true);
    expect(refs.map((r) => r.externalId)).toContain(leafInvoiceExternalId("7"));
    expect(refs.map((r) => r.externalId)).toContain(
      leafInvoiceExternalId("uid-7"),
    );
  });

  test("an invoice id that is not digits never calls Leaf", async () => {
    const { impl, calls } = mockFetch(() => ({
      json: contractsPayload([CONTRACT]),
    }));
    const out = (await tool("leaf_second_copy", { fetchImpl: impl }).invoke({
      contractId: "15",
      invoiceId: "01",
      type: "pix",
    })) as string;
    expect(out).toContain("digits");
    expect(calls).toHaveLength(0);
  });
});

describe("leaf admin toolpack — writes and failures", () => {
  test("a write without confirmation does not call Leaf", async () => {
    const { impl, calls } = mockFetch(() => ({
      json: contractsPayload([CONTRACT]),
    }));
    for (const name of [
      "leaf_extend_connection",
      "leaf_clear_mac",
      "leaf_disconnect",
    ]) {
      const out = (await tool(name, { fetchImpl: impl }).invoke({
        connectionId: "99",
        confirmed: false,
      })) as string;
      expect(out).toContain("confirmed");
    }
    expect(calls).toHaveLength(0);
  });

  test("a confirmed disconnect posts force false for an owned connection", async () => {
    const { impl, calls } = mockFetch((url, init) => {
      if (url.includes("/contracts"))
        return { json: contractsPayload([CONTRACT]) };
      expect(init.method).toBe("POST");
      expect(bodyOf(init)).toEqual({ connectionId: 99, force: false });
      expect(header(init, "x-auth-header")).toBe(SECRET);
      expect(init.redirect).toBe("error");
      return { json: { statusCode: 1 } };
    });
    const out = (await tool("leaf_disconnect", { fetchImpl: impl }).invoke({
      connectionId: "99",
      confirmed: true,
    })) as string;
    expect(out).toContain("disconnected");
    expect(
      calls.some((c) => c.url.endsWith("/integrations/customers/disconnect")),
    ).toBe(true);
    expect(out).not.toContain(SECRET);
  });

  test("extend and clear-mac post only the connection id", async () => {
    const bodies: unknown[] = [];
    const { impl } = mockFetch((url, init) => {
      if (url.includes("/contracts"))
        return { json: contractsPayload([CONTRACT]) };
      bodies.push(bodyOf(init));
      return { json: { statusCode: "Ok" } };
    });
    await tool("leaf_extend_connection", { fetchImpl: impl }).invoke({
      connectionId: "99",
      confirmed: true,
    });
    await tool("leaf_clear_mac", { fetchImpl: impl }).invoke({
      connectionId: "99",
      confirmed: true,
    });
    expect(bodies).toEqual([{ connectionId: 99 }, { connectionId: 99 }]);
  });

  test("a bad statusCode is not a success and the body is not echoed", async () => {
    const { impl } = mockFetch(() => ({
      json: {
        statusCode: 0,
        detailDescription: SECRET,
        results: [{ id: 1, name: "SHOULD_NOT_LEAK_NAME" }],
      },
    }));
    const out = (await tool("leaf_lookup_customer", { fetchImpl: impl }).invoke(
      {},
    )) as string;
    expect(out).toContain("rejected");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("SHOULD_NOT_LEAK_NAME");
  });

  test("detailCode 19 and HTTP 403 are invalid credentials", async () => {
    const forbidden = mockFetch(() => ({
      status: 200,
      json: { statusCode: "ERROR", detailCode: 19, detailDescription: SECRET },
    }));
    const denied = mockFetch(() => ({
      status: 403,
      json: { detailDescription: SECRET },
    }));
    const a = (await tool("leaf_lookup_customer", {
      fetchImpl: forbidden.impl,
    }).invoke({})) as string;
    const b = (await tool("leaf_lookup_customer", {
      fetchImpl: denied.impl,
    }).invoke({})) as string;
    expect(a).toContain("credential");
    expect(b).toContain("credential");
    expect(a).not.toContain(SECRET);
    expect(b).not.toContain(SECRET);
    expect(header(forbidden.calls[0]?.init ?? {}, "x-auth-header")).toBe(
      SECRET,
    );
  });

  test("http and a refused host never send the key", async () => {
    const http = mockFetch(() => ({ json: { statusCode: 1, results: [] } }));
    const httpOut = (await tool(
      "leaf_lookup_customer",
      { fetchImpl: http.impl },
      { system_url: "http://leaf.example.com" },
    ).invoke({})) as string;
    expect(http.calls).toHaveLength(0);
    expect(httpOut).toContain("https");
    expect(httpOut).not.toContain(SECRET);

    const blocked = mockFetch(() => ({ json: { statusCode: 1 } }));
    const blockedOut = (await tool("leaf_lookup_customer", {
      fetchImpl: blocked.impl,
      assertSafe: async () => {
        throw new Error(`blocked ${SECRET}`);
      },
    }).invoke({})) as string;
    expect(blocked.calls).toHaveLength(0);
    expect(blockedOut).toContain("refused");
    expect(blockedOut).not.toContain(SECRET);
  });

  test("a transport error does not repeat the credential", async () => {
    const { impl } = mockFetch(() => "throw");
    const out = (await tool("leaf_lookup_customer", { fetchImpl: impl }).invoke(
      {},
    )) as string;
    expect(out).not.toContain(SECRET);
    expect(out).toContain("Failed to reach");
  });

  test("a thrown credential read does not repeat the key", async () => {
    const { impl, calls } = mockFetch(() => ({ json: { statusCode: 1 } }));
    const out = (await tool("leaf_lookup_customer", {
      fetchImpl: impl,
      resolveCredential: async () => {
        throw new Error(`vault ${SECRET}`);
      },
    }).invoke({})) as string;
    expect(calls).toHaveLength(0);
    expect(out).not.toContain(SECRET);
  });

  test("the model has no phone, url, or token argument", () => {
    const names = leafAdminToolpack.toolSpecs.flatMap((spec) =>
      Object.keys(spec.schema.shape),
    );
    expect(names).not.toContain("phone");
    expect(names).not.toContain("document");
    expect(names).not.toContain("system_url");
    expect(names).not.toContain("api_key");
    expect(names).not.toContain("url");
  });

  test("trailing slash on system_url is stripped before /api/v2", async () => {
    const { impl, calls } = mockFetch(() => ({ json: contractsPayload([]) }));
    await tool(
      "leaf_lookup_customer",
      { fetchImpl: impl },
      { system_url: "https://leaf.example.com/" },
    ).invoke({});
    expect(calls[0]?.url.startsWith("https://leaf.example.com/api/v2/")).toBe(
      true,
    );
  });
});
