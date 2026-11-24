import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  failableTool,
  type ToolFailure,
  toolFailure,
} from "@/graph/tools/failure";
import { fetchBounded, OutboundTimeoutError } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { resolveInjectableCredentialEntry } from "@/modules/vault/injectable";
import { leafInvoiceExternalId } from "../leaf-admin-mapper";
import { leafApiBase, leafSystemUrlProblem } from "../leaf-system-url";
import { fetchDespiteExpiredCertificate } from "../leaf-tls";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Leaf Admin outbound toolpack. The ERP root and the token come from the leaf_admin
// credential (header x-auth-header, then /api/v2). The contact phone is the Chatwoot
// mirror. A write runs only when confirmed is true. An expired certificate is retried
// once so the HTTP request still leaves (`leaf-tls.ts`).

const TIMEOUT_MS = 15_000;
const LIST_CAP = 64_000;
const PAYMENT_CAP = 1_000_000;
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;
const DOCUMENT_ATTRIBUTE = "cpf_cnpj";
const INVOICE_ID = /^[1-9]\d*$/;
const QR_MAX = 4_000;
const SECRET_MIN = 8;

const PAYMENT_QUERY = {
  pix: "pix",
  boleto: "bankSlip",
  card: "creditCard",
} as const;
type PaymentType = keyof typeof PAYMENT_QUERY;

const CONFIRM_REFUSAL =
  "Refused: set confirmed to true only after the customer agrees to this change.";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function scrub(text: string, secret: string): string {
  if (secret.length < SECRET_MIN) return text;
  return text.split(secret).join("[filtered]");
}

function fail(secret: string, message: string): ToolFailure {
  return toolFailure(scrub(message, secret));
}

function say(secret: string, message: string): string {
  return scrub(message, secret);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function rawText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

function digits(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const only = raw.replace(/\D/g, "");
  return only.length > 0 ? only : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function successStatus(code: unknown): boolean {
  if (code === 1) return true;
  return (
    typeof code === "string" && ["1", "ok"].includes(code.trim().toLowerCase())
  );
}

function invalidDetail(detail: unknown): boolean {
  if (detail === undefined || detail === null) return false;
  return ["19", "43", "bad_token", "forbidden"].includes(
    String(detail).trim().toLowerCase(),
  );
}

const LEAF_MISSING_URL =
  "Falta a URL base do ERP. No cofre, edite a credencial do tipo Leaf Admin e preencha URL base do ERP (https, sem /api no final).";
const LEAF_MISSING_TOKEN =
  "Falta o token do Leaf Admin. No cofre, edite a credencial do tipo Leaf Admin e preencha o token.";
const LEAF_WRONG_KIND =
  "A credencial não é do tipo Leaf Admin. No cofre, crie uma credencial Leaf Admin com a URL base do ERP e o token.";

function leafUrlRefusal(raw: string): string {
  const problem = leafSystemUrlProblem(raw.trim().replace(/\/+$/, ""));
  if (problem === "https") return "A URL base do ERP precisa usar https.";
  if (problem === "api") {
    return "A URL base do ERP não pode terminar com /api. O cliente acrescenta /api/v2.";
  }
  if (problem === "userinfo") {
    return "A URL base do ERP não pode ter usuário nem senha.";
  }
  if (problem === "query") {
    return "A URL base do ERP não pode ter query nem fragmento.";
  }
  if (problem === "empty") return LEAF_MISSING_URL;
  return "A URL base do ERP não é válida.";
}

function resolveBase(raw: unknown): { base: string } | { refusal: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { refusal: LEAF_MISSING_URL };
  }
  const base = leafApiBase(raw);
  if (base) return { base };
  return { refusal: leafUrlRefusal(raw) };
}

type LeafNo = { ok: false; failure: ToolFailure };
type Ready = { ok: true; token: string; base: string };

async function prepare(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): Promise<Ready | LeafNo> {
  if (!sel.credentialRef) {
    return { ok: false, failure: toolFailure(LEAF_WRONG_KIND) };
  }
  let entry: {
    value: string;
    kind: string | null;
    baseUrl: string | null;
  } | null = null;
  try {
    const read =
      ctx.resolveCredentialEntry ??
      ((ref: string) =>
        resolveInjectableCredentialEntry(ctx.base, ctx.tenantId, ref));
    entry = await read(sel.credentialRef);
  } catch {
    logger.warn({ phase: "credential" }, "leaf-admin: credential read failed");
    return {
      ok: false,
      failure: toolFailure("A credencial do Leaf Admin não pôde ser lida."),
    };
  }
  if (entry?.kind !== "leaf_admin") {
    return { ok: false, failure: toolFailure(LEAF_WRONG_KIND) };
  }
  const base = resolveBase(entry.baseUrl);
  if ("refusal" in base) {
    return { ok: false, failure: toolFailure(base.refusal) };
  }
  if (!entry.value) {
    return { ok: false, failure: toolFailure(LEAF_MISSING_TOKEN) };
  }
  return { ok: true, token: entry.value, base: base.base };
}

function leafUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

async function leafRequest(
  ready: Ready,
  ctx: ToolpackCtx,
  path: string,
  init: {
    method: "GET" | "POST";
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    cap?: number;
    acceptPayload?: (record: Record<string, unknown>) => boolean;
  },
): Promise<{ ok: true; body: Record<string, unknown> } | LeafNo> {
  const url = leafUrl(ready.base, path, init.query);
  const cap = init.cap ?? LIST_CAP;
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  try {
    await assertSafe(url);
  } catch (err) {
    logger.warn(
      { detail: scrub(errText(err), ready.token) },
      "leaf-admin: url refused",
    );
    return {
      ok: false,
      failure: fail(
        ready.token,
        "The Leaf Admin URL was refused. It must be https on a public host.",
      ),
    };
  }
  const baseFetch = ctx.fetchImpl ?? fetch;
  const doFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchDespiteExpiredCertificate(baseFetch, input, init)) as typeof fetch;
  let status = 0;
  let json: unknown = null;
  let truncated = false;
  try {
    const { res, body } = await fetchBounded(
      url,
      {
        method: init.method,
        headers: {
          "x-auth-header": ready.token,
          Accept: "application/json",
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          "User-Agent": "agents",
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        redirect: "error",
      },
      { timeoutMs: TIMEOUT_MS, cap, fetchImpl: doFetch },
    );
    status = res.status;
    truncated = body.chars > cap;
    try {
      json = JSON.parse(body.text);
    } catch {
      json = null;
    }
  } catch (err) {
    logger.warn(
      { detail: scrub(errText(err), ready.token) },
      "leaf-admin: request failed",
    );
    return {
      ok: false,
      failure: fail(
        ready.token,
        "Failed to reach Leaf Admin. Try again shortly.",
      ),
    };
  }
  if (truncated) {
    return {
      ok: false,
      failure: fail(ready.token, "Leaf Admin response was too large to read."),
    };
  }
  const record = asRecord(json);
  if (
    status >= 200 &&
    status < 300 &&
    record &&
    (successStatus(record.statusCode) || init.acceptPayload?.(record) === true)
  ) {
    return { ok: true, body: record };
  }
  const detailCode = record?.detailCode;
  logger.warn(
    {
      status,
      detailCode:
        detailCode === undefined ? undefined : clipText(String(detailCode), 64),
    },
    "leaf-admin: request rejected",
  );
  if (status === 401 || status === 403 || invalidDetail(detailCode)) {
    return {
      ok: false,
      failure: fail(
        ready.token,
        "Leaf Admin rejected the credential. Check the vault API key.",
      ),
    };
  }
  return {
    ok: false,
    failure: fail(
      ready.token,
      `Leaf Admin rejected the request (HTTP ${status}).`,
    ),
  };
}

export type LeafProbe =
  | { ok: true; httpStatus: number; statusCode: string }
  | {
      ok: false;
      code:
        | "missing"
        | "missing_url"
        | "missing_token"
        | "wrong_kind"
        | "blocked"
        | "rejected"
        | "answered"
        | "http"
        | "timeout"
        | "unreachable";
      httpStatus?: number;
      statusCode?: string;
    };

function probeCode(value: unknown, token: string): string | undefined {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!raw || raw.length > 32 || raw.includes(token)) return undefined;
  return raw;
}

// One cheap read of the saved ERP, for the button on the integration. The answer
// keeps the HTTP status and statusCode. The body, the token and any customer field stay here.
export async function probeLeafAdmin(
  config: Record<string, unknown>,
  token: string | null,
  deps: {
    fetchImpl?: typeof fetch;
    assertSafe?: (url: string) => Promise<URL>;
    beforeFetch?: () => void;
  } = {},
): Promise<LeafProbe> {
  const base = resolveBase(config.system_url);
  if ("refusal" in base) {
    return {
      ok: false,
      code: base.refusal === LEAF_MISSING_URL ? "missing" : "blocked",
    };
  }
  if (!token) return { ok: false, code: "missing" };
  const url = leafUrl(base.base, "/integrations/contracts", {
    page: 1,
    limit: 1,
  });
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  try {
    await assertSafe(url);
  } catch {
    return { ok: false, code: "blocked" };
  }
  deps.beforeFetch?.();
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const { res, body } = await fetchBounded(
      url,
      {
        method: "GET",
        headers: {
          "x-auth-header": token,
          Accept: "application/json",
          "User-Agent": "agents",
        },
        redirect: "error",
      },
      { timeoutMs: TIMEOUT_MS, cap: 16_000, fetchImpl: doFetch },
    );
    if (body.chars > 16_000) {
      return { ok: false, code: "http", httpStatus: res.status };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(body.text);
    } catch {
      json = null;
    }
    const record = asRecord(json);
    const statusCode = probeCode(record?.statusCode, token);
    const httpStatus = res.status;
    if (
      httpStatus === 401 ||
      httpStatus === 403 ||
      invalidDetail(record?.detailCode)
    ) {
      return { ok: false, code: "rejected", httpStatus, statusCode };
    }
    if (
      httpStatus >= 200 &&
      httpStatus < 300 &&
      successStatus(record?.statusCode)
    ) {
      return { ok: true, httpStatus, statusCode: statusCode ?? "1" };
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ok: false, code: "answered", httpStatus, statusCode };
    }
    return { ok: false, code: "http", httpStatus, statusCode };
  } catch (err) {
    if (err instanceof OutboundTimeoutError) {
      return { ok: false, code: "timeout" };
    }
    return { ok: false, code: "unreachable" };
  }
}

function documentOf(attrs: unknown): string | null {
  const bag = asRecord(attrs);
  if (!bag) return null;
  return digits(bag[DOCUMENT_ATTRIBUTE]);
}

async function loadIdentity(
  ctx: ToolpackCtx,
): Promise<
  { ok: true; phone: string | null; document: string | null } | LeafNo
> {
  if (ctx.contactDbId == null) {
    return { ok: true, phone: null, document: null };
  }
  const contactId = ctx.contactDbId;
  try {
    const row = await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
      db.contact.findUnique({
        where: { id: contactId },
        select: { phone: true, customAttributes: true },
      }),
    );
    return {
      ok: true,
      phone: digits(row?.phone),
      document: documentOf(row?.customAttributes),
    };
  } catch (err) {
    logger.warn(
      { detail: clipText(errText(err), 200) },
      "leaf-admin: contact read failed",
    );
    return {
      ok: false,
      failure: toolFailure(
        "Could not read this contact, so Leaf Admin was not called.",
      ),
    };
  }
}

type OwnedContract = {
  id: string;
  connectionId: string | null;
  connectionValue: unknown;
  name: string | null;
  status: string | null;
  customerId: string | null;
  address: { street?: string; number?: string } | null;
};

function parseContract(row: Record<string, unknown>): OwnedContract | null {
  const id = text(row.id);
  if (!id) return null;
  const connectionValue = row.connectionId;
  const connectionId = text(connectionValue);
  const customer = asRecord(row.customer);
  const customerId =
    text(row.customerId) ??
    text(row.clientId) ??
    (customer ? (text(customer.id) ?? text(customer.customerId)) : null);
  const addressRaw = asRecord(row.address);
  const street = addressRaw ? text(addressRaw.street) : null;
  const number = addressRaw ? text(addressRaw.number) : null;
  const address =
    street || number
      ? {
          ...(street ? { street } : {}),
          ...(number ? { number } : {}),
        }
      : null;
  return {
    id,
    connectionId,
    connectionValue: connectionId ? connectionValue : null,
    name: text(row.name),
    status: text(row.status),
    customerId,
    address,
  };
}

function projectContract(contract: OwnedContract): Record<string, unknown> {
  return {
    id: contract.id,
    ...(contract.name ? { name: contract.name } : {}),
    ...(contract.status ? { status: contract.status } : {}),
    ...(contract.connectionId ? { connectionId: contract.connectionId } : {}),
    ...(contract.customerId ? { customerId: contract.customerId } : {}),
    ...(contract.address ? { address: contract.address } : {}),
  };
}

async function listContracts(
  ready: Ready,
  ctx: ToolpackCtx,
  filter: { phone?: string; document?: string },
): Promise<{ ok: true; rows: OwnedContract[] } | LeafNo> {
  const rows: OwnedContract[] = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await leafRequest(ready, ctx, "/integrations/contracts", {
      method: "GET",
      query: { ...filter, page, limit: PAGE_LIMIT },
    });
    if (!res.ok) return res;
    const raw = Array.isArray(res.body.results) ? res.body.results : [];
    for (const item of raw) {
      const record = asRecord(item);
      const parsed = record ? parseContract(record) : null;
      if (parsed) rows.push(parsed);
    }
    seen += raw.length;
    const total = finiteNumber(res.body.total) ?? 0;
    if (raw.length === 0 || seen >= total) break;
  }
  return { ok: true, rows };
}

function statedDocument(
  raw: string | undefined,
): { ok: true; digits: string | null } | { ok: false } {
  if (raw == null || raw.trim() === "") return { ok: true, digits: null };
  const only = raw.replace(/\D/g, "");
  if (only.length !== 11 && only.length !== 14) return { ok: false };
  return { ok: true, digits: only };
}

async function findContracts(
  ready: Ready,
  ctx: ToolpackCtx,
  statedRaw?: string,
): Promise<
  | { ok: true; matchedBy: "phone" | "document"; contracts: OwnedContract[] }
  | LeafNo
> {
  const stated = statedDocument(statedRaw);
  if (!stated.ok) {
    return {
      ok: false,
      failure: fail(ready.token, "The CPF/CNPJ must be 11 or 14 digits."),
    };
  }
  const identity = await loadIdentity(ctx);
  if (!identity.ok) return identity;
  if (identity.phone) {
    const listed = await listContracts(ready, ctx, { phone: identity.phone });
    if (!listed.ok) return listed;
    if (listed.rows.length > 0) {
      return { ok: true, matchedBy: "phone", contracts: listed.rows };
    }
  }
  const document = identity.document ?? stated.digits;
  if (document) {
    const listed = await listContracts(ready, ctx, { document });
    if (!listed.ok) return listed;
    if (listed.rows.length > 0) {
      return { ok: true, matchedBy: "document", contracts: listed.rows };
    }
  }
  if (ctx.contactDbId == null && !stated.digits) {
    return {
      ok: false,
      failure: fail(
        ready.token,
        "Não há contato nesta conversa e não veio CPF/CNPJ. Passe document com 11 ou 14 dígitos.",
      ),
    };
  }
  if (!identity.phone && !identity.document && !stated.digits) {
    return {
      ok: false,
      failure: fail(
        ready.token,
        "This contact has no phone and no stored CPF/CNPJ. Pass document as the CPF/CNPJ the customer stated, 11 or 14 digits.",
      ),
    };
  }
  return {
    ok: false,
    failure: fail(ready.token, "No Leaf Admin contract matches this contact."),
  };
}

function byContractId(rows: OwnedContract[], id: string): OwnedContract | null {
  const wanted = id.trim();
  return rows.find((row) => row.id === wanted) ?? null;
}

function byConnectionId(
  rows: OwnedContract[],
  id: string,
): OwnedContract | null {
  const wanted = id.trim();
  return rows.find((row) => row.connectionId === wanted) ?? null;
}

function postConnectionId(contract: OwnedContract): string | number {
  const value = contract.connectionValue;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value;
  return contract.connectionId ?? "";
}

async function rememberInvoices(
  ready: Ready,
  ctx: ToolpackCtx,
  sel: IntegrationSelection,
  tool: string,
  ids: string[],
  metadata: Record<string, unknown>,
): Promise<void> {
  const unique = [
    ...new Set(
      ids
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 200),
    ),
  ];
  if (unique.length === 0) return;
  try {
    await runScopedOn(ctx.base, sysCtx(ctx.tenantId), async (db) => {
      for (const id of unique) {
        const externalId = leafInvoiceExternalId(id);
        await db.integrationExternalRef.upsert({
          where: {
            tenantId_externalId: { tenantId: ctx.tenantId, externalId },
          },
          create: {
            tenantId: ctx.tenantId,
            integrationInstanceId: sel.instanceId,
            externalId,
            threadId: ctx.threadId,
            kind: "leaf_invoice",
            metadata: metadata as Prisma.InputJsonValue,
          },
          update: {
            threadId: ctx.threadId,
            integrationInstanceId: sel.instanceId,
            kind: "leaf_invoice",
            metadata: metadata as Prisma.InputJsonValue,
          },
        });
      }
    });
  } catch (err) {
    logger.warn(
      { detail: clipText(scrub(errText(err), ready.token), 200) },
      "leaf-admin: failed to persist invoice correlation",
    );
    ctx.onSideEffectError?.({ tool, phase: "persist_ref", err });
  }
}

function invoiceIds(row: Record<string, unknown>): string[] {
  const id = text(row.id);
  const uid = text(row.uid);
  const out: string[] = [];
  if (id) out.push(id);
  if (uid && uid !== id) out.push(uid);
  return out;
}

function projectInvoice(
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const id = text(row.id);
  if (!id) return null;
  const description = text(row.description) ?? text(row.name);
  const uid = text(row.uid);
  const dueDate = text(row.dueDate);
  const status = text(row.status);
  return {
    id,
    ...(uid ? { uid } : {}),
    ...(description ? { description } : {}),
    ...(row.amount !== undefined ? { amount: row.amount } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(status ? { status } : {}),
  };
}

function paymentMethods(
  body: Record<string, unknown>,
): { pix: boolean; bankSlip: boolean; creditCard: boolean } | null {
  const flags = asRecord(body.paymentMethods);
  if (!flags) return null;
  return {
    pix: flags.pix === true,
    bankSlip: flags.bankSlip === true,
    creditCard: flags.creditCard === true,
  };
}

function projectGpon(value: unknown): Record<string, unknown> | null {
  const gpon = asRecord(value);
  if (!gpon) return null;
  const out: Record<string, unknown> = {};
  if (gpon.status !== undefined) out.status = gpon.status;
  if (gpon.rxPower !== undefined) out.rxPower = gpon.rxPower;
  if (gpon.alarm !== undefined) out.alarm = gpon.alarm;
  return out;
}

function projectConnection(
  body: Record<string, unknown>,
  connectionId: string,
): Record<string, unknown> {
  const results = Array.isArray(body.results) ? body.results : [];
  const records = results
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
  const row =
    records.find((item) => text(item.connectionId) === connectionId) ??
    records[0] ??
    null;
  if (!row) return { connectionId };
  const auth = asRecord(row.auth);
  const gpon = projectGpon(row.gpon);
  return {
    connectionId: text(row.connectionId) ?? connectionId,
    ...(text(row.status) ? { status: text(row.status) } : {}),
    ...(text(row.pppoeLogin) ? { pppoeLogin: text(row.pppoeLogin) } : {}),
    ...(gpon ? { gpon } : {}),
    ...(text(auth?.message) ? { authMessage: text(auth?.message) } : {}),
  };
}

function canSend(ctx: ToolpackCtx): ctx is ToolpackCtx & {
  chatwoot: NonNullable<ToolpackCtx["chatwoot"]>;
} {
  if (!ctx.chatwoot) return false;
  if (ctx.muted === true || ctx.chatwoot.client.muted === true) return false;
  return true;
}

function decodePdf(b64: string): ArrayBuffer | null {
  const cleaned = b64.replace(/\s/g, "");
  if (!cleaned) return null;
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) return null;
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

const STATED_DOCUMENT = z
  .string()
  .max(40)
  .optional()
  .describe(
    "CPF or CNPJ the customer stated in this conversation. Sent as document only when this contact has no cpf_cnpj attribute and the phone matches no contract. 11 or 14 digits; punctuation is ignored. Not a URL, a token, or an id. Pass the same value on the next Leaf tool so that tool can check the id.",
  );
const LOOKUP_SCHEMA = z.object({ document: STATED_DOCUMENT });
const CONNECTION_SCHEMA = z.object({
  connectionId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "connectionId of a contract leaf_lookup_customer returned for this contact. Any other id is refused.",
    ),
  document: STATED_DOCUMENT,
});
const CONTRACT_SCHEMA = z.object({
  contractId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Contract id leaf_lookup_customer returned for this contact. Any other id is refused.",
    ),
  document: STATED_DOCUMENT,
});
const SECOND_COPY_SCHEMA = z.object({
  contractId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Contract id leaf_lookup_customer returned for this contact. Any other id is refused.",
    ),
  document: STATED_DOCUMENT,
  invoiceId: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "Billet id from leaf_open_invoices, digits only, no leading zero.",
    ),
  type: z
    .enum(["pix", "boleto", "card"])
    .describe("How the customer asked to pay: pix, boleto, or card."),
});
const EXTEND_SCHEMA = z.object({
  connectionId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "connectionId from leaf_lookup_customer. When that contract has no connectionId, pass its contract id here; the call sends contractId and does not send connectionId.",
    ),
  confirmed: z
    .boolean()
    .describe(
      "True only after the customer explicitly agreed to this change in the conversation. false refuses the call and nothing is sent.",
    ),
  document: STATED_DOCUMENT,
});
const WRITE_SCHEMA = z.object({
  connectionId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "connectionId of a contract leaf_lookup_customer returned for this contact. Any other id is refused.",
    ),
  confirmed: z
    .boolean()
    .describe(
      "True only after the customer explicitly agreed to this change in the conversation. false refuses the call and nothing is sent.",
    ),
  document: STATED_DOCUMENT,
});

const LEAF_TOOL_SPECS: ToolSpec[] = [
  { name: "leaf_lookup_customer", schema: LOOKUP_SCHEMA },
  { name: "leaf_connection_status", schema: CONNECTION_SCHEMA },
  { name: "leaf_open_invoices", schema: CONTRACT_SCHEMA },
  { name: "leaf_second_copy", schema: SECOND_COPY_SCHEMA },
  { name: "leaf_extend_connection", schema: EXTEND_SCHEMA },
  { name: "leaf_clear_mac", schema: WRITE_SCHEMA },
  { name: "leaf_disconnect", schema: WRITE_SCHEMA },
];

function buildLookupTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { document?: string }) => {
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      return say(
        ready.token,
        JSON.stringify({
          matchedBy: found.matchedBy,
          contracts: found.contracts.map(projectContract),
        }),
      );
    },
    {
      name: "leaf_lookup_customer",
      description:
        "Look up this contact's Leaf Admin contracts. The phone is the Chatwoot contact's phone. A stored CPF/CNPJ (contact attribute cpf_cnpj) is used only when the phone matches nothing. When the contact has no cpf_cnpj, pass document as the CPF/CNPJ the customer stated (11 or 14 digits). Returns contract ids and connection ids for the other Leaf tools. Do not pass a phone, URL, token, or an id.",
      schema: LOOKUP_SCHEMA,
    },
  );
}

function buildConnectionTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { connectionId: string; document?: string }) => {
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      const contract = byConnectionId(found.contracts, input.connectionId);
      if (!contract?.connectionId) {
        return fail(
          ready.token,
          "That connection was not returned for this contact.",
        );
      }
      const res = await leafRequest(ready, ctx, "/integrations/customers", {
        method: "GET",
        query: { connectionId: contract.connectionId, limit: 1 },
      });
      if (!res.ok) return res.failure;
      return say(
        ready.token,
        JSON.stringify(projectConnection(res.body, contract.connectionId)),
      );
    },
    {
      name: "leaf_connection_status",
      description:
        "Read the connection status for a connectionId leaf_lookup_customer returned for this contact. The PPPoE password is never included.",
      schema: CONNECTION_SCHEMA,
    },
  );
}

function buildInvoicesTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { contractId: string; document?: string }) => {
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      const contract = byContractId(found.contracts, input.contractId);
      if (!contract) {
        return fail(
          ready.token,
          "That contract was not returned for this contact.",
        );
      }
      const res = await leafRequest(ready, ctx, "/integrations/billets", {
        method: "GET",
        query: { contractId: contract.id, status: "delayed", limit: 5 },
      });
      if (!res.ok) return res.failure;
      const raw = Array.isArray(res.body.results) ? res.body.results : [];
      const invoices: Record<string, unknown>[] = [];
      const ids: string[] = [];
      for (const item of raw) {
        const record = asRecord(item);
        if (!record) continue;
        const projected = projectInvoice(record);
        if (!projected) continue;
        invoices.push(projected);
        ids.push(...invoiceIds(record));
      }
      await rememberInvoices(ready, ctx, sel, "leaf_open_invoices", ids, {
        contractId: contract.id,
      });
      const methods = paymentMethods(res.body);
      return say(
        ready.token,
        JSON.stringify({
          contractId: contract.id,
          ...(methods ? { paymentMethods: methods } : {}),
          invoices,
        }),
      );
    },
    {
      name: "leaf_open_invoices",
      description:
        "List up to 5 delayed billets for a contract id leaf_lookup_customer returned for this contact. Use an invoice id from this list with leaf_second_copy.",
      schema: CONTRACT_SCHEMA,
    },
  );
}

// A PIX payment is the copy-paste line, the QR, or both. statusCode on that
// HTTP 200 is not the signal: 0 and 2 are the envelope's error and warning.
function pixPayload(record: Record<string, unknown>): boolean {
  return (
    rawText(record.copyPaste) != null ||
    rawText(record.qr) != null ||
    rawText(record.qrCode) != null
  );
}

function leafInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const raw = text(value);
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function extendBody(
  rows: OwnedContract[],
  asked: string,
): { connectionId: number } | { contractId: number } | null {
  const wanted = asked.trim();
  const owned = byConnectionId(rows, wanted);
  if (owned?.connectionId) {
    const connectionId =
      leafInteger(owned.connectionValue) ?? leafInteger(owned.connectionId);
    return connectionId == null ? null : { connectionId };
  }
  const byId = byContractId(rows, wanted);
  const bare = rows.filter((row) => row.connectionId == null);
  const chosen = byId ?? (bare.length === 1 ? bare[0] : null);
  if (!chosen) return null;
  if (chosen.connectionId) {
    const connectionId =
      leafInteger(chosen.connectionValue) ?? leafInteger(chosen.connectionId);
    return connectionId == null ? null : { connectionId };
  }
  const contractId = leafInteger(chosen.id);
  return contractId == null ? null : { contractId };
}

async function renderPayment(
  ready: Ready,
  ctx: ToolpackCtx,
  type: PaymentType,
  invoiceId: string,
  body: Record<string, unknown>,
): Promise<string | ToolFailure> {
  if (type === "pix") {
    const copyPaste = rawText(body.copyPaste);
    const qr = rawText(body.qr) ?? rawText(body.qrCode);
    if (!copyPaste && !qr) {
      return fail(
        ready.token,
        "Leaf Admin did not return a PIX copy-paste code.",
      );
    }
    const qrLine =
      qr && qr.length <= QR_MAX
        ? `QR: ${qr}`
        : qr
          ? "QR image omitted (too large)."
          : "";
    const copyLine = copyPaste ? `PIX copy-paste: ${copyPaste}` : "";
    return say(
      ready.token,
      [copyLine, qrLine].filter((line) => line.length > 0).join("\n"),
    );
  }
  if (type === "card") {
    const params = asRecord(body.params);
    const url = rawText(body.url) ?? (params ? rawText(params.url) : null);
    if (!url) {
      return fail(ready.token, "Leaf Admin did not return a card payment URL.");
    }
    return say(ready.token, `Card payment URL: ${url}`);
  }
  const url = rawText(body.url);
  const pdf = rawText(body.pdf);
  if (!url && !pdf) {
    return fail(ready.token, "Leaf Admin did not return a boleto URL or PDF.");
  }
  let sent = false;
  if (pdf && canSend(ctx)) {
    const bytes = decodePdf(pdf);
    if (bytes) {
      try {
        await ctx.chatwoot.client.sendFileAttachment(
          ctx.chatwoot.conversationId,
          bytes,
          `boleto-${invoiceId}.pdf`,
          "application/pdf",
        );
        ctx.chatwoot.onSent?.();
        sent = true;
      } catch (err) {
        logger.warn(
          { detail: clipText(scrub(errText(err), ready.token), 200) },
          "leaf-admin: boleto pdf delivery failed",
        );
      }
    }
  }
  const lines = [`Boleto ${invoiceId}.`];
  if (url) lines.push(`Payment URL: ${url}`);
  if (sent) lines.push("The PDF was sent in this conversation.");
  else
    lines.push("The PDF was not attached. Send the customer the payment URL.");
  return say(ready.token, lines.join("\n"));
}

function buildSecondCopyTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: {
      contractId: string;
      invoiceId: string;
      type: PaymentType;
      document?: string;
    }) => {
      if (!INVOICE_ID.test(input.invoiceId)) {
        return toolFailure(
          "The invoice id must be digits only, without a leading zero.",
        );
      }
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      const contract = byContractId(found.contracts, input.contractId);
      if (!contract) {
        return fail(
          ready.token,
          "That contract was not returned for this contact.",
        );
      }
      const listed = await leafRequest(ready, ctx, "/integrations/billets", {
        method: "GET",
        query: { contractId: contract.id, status: "delayed", limit: 5 },
      });
      if (!listed.ok) return listed.failure;
      const raw = Array.isArray(listed.body.results) ? listed.body.results : [];
      const records = raw
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
      const invoice = records.find((row) => text(row.id) === input.invoiceId);
      if (!invoice) {
        return fail(
          ready.token,
          "That invoice was not returned for this contact.",
        );
      }
      const methods = paymentMethods(listed.body);
      if (methods && methods[PAYMENT_QUERY[input.type]] !== true) {
        return fail(
          ready.token,
          "That payment method is not available for this invoice.",
        );
      }
      const paid = await leafRequest(
        ready,
        ctx,
        `/integrations/billets/${input.invoiceId}/payment`,
        {
          method: "GET",
          query: { type: PAYMENT_QUERY[input.type] },
          cap: PAYMENT_CAP,
          ...(input.type === "pix" ? { acceptPayload: pixPayload } : {}),
        },
      );
      if (!paid.ok) return paid.failure;
      await rememberInvoices(
        ready,
        ctx,
        sel,
        "leaf_second_copy",
        [...invoiceIds(invoice), input.invoiceId],
        { contractId: contract.id },
      );
      return renderPayment(ready, ctx, input.type, input.invoiceId, paid.body);
    },
    {
      name: "leaf_second_copy",
      description:
        "Second copy of a delayed billet that belongs to this contact (pix, boleto, or card). The invoice id must be one leaf_open_invoices returned, digits only. PIX returns the copy-paste line and the QR. Boleto sends the PDF into this conversation when one is open and returns the payment URL. Card returns the payment URL.",
      schema: SECOND_COPY_SCHEMA,
    },
  );
}

function buildWriteTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
  spec: {
    name: string;
    path: string;
    description: string;
    done: string;
    forceFalse?: boolean;
  },
): StructuredToolInterface {
  return failableTool(
    async (input: {
      connectionId: string;
      confirmed: boolean;
      document?: string;
    }) => {
      if (input.confirmed !== true) return toolFailure(CONFIRM_REFUSAL);
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      const contract = byConnectionId(found.contracts, input.connectionId);
      if (!contract?.connectionId) {
        return fail(
          ready.token,
          "That connection was not returned for this contact.",
        );
      }
      const connectionId = postConnectionId(contract);
      const res = await leafRequest(ready, ctx, spec.path, {
        method: "POST",
        body: spec.forceFalse
          ? { connectionId, force: false }
          : { connectionId },
      });
      if (!res.ok) return res.failure;
      return say(ready.token, spec.done);
    },
    { name: spec.name, description: spec.description, schema: WRITE_SCHEMA },
  );
}

function buildExtendTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: {
      connectionId: string;
      confirmed: boolean;
      document?: string;
    }) => {
      if (input.confirmed !== true) return toolFailure(CONFIRM_REFUSAL);
      const ready = await prepare(sel, ctx);
      if (!ready.ok) return ready.failure;
      const found = await findContracts(ready, ctx, input.document);
      if (!found.ok) return found.failure;
      const body = extendBody(found.contracts, input.connectionId);
      if (!body) {
        return fail(
          ready.token,
          "That connection was not returned for this contact.",
        );
      }
      const res = await leafRequest(
        ready,
        ctx,
        "/integrations/customers/extend",
        { method: "POST", body },
      );
      if (!res.ok) return res.failure;
      return say(ready.token, "The connection was extended.");
    },
    {
      name: "leaf_extend_connection",
      description:
        "Extend (unblock) a contract after the customer confirms. Pass the connectionId leaf_lookup_customer returned. When that contract has no connectionId, pass its contract id in connectionId; the POST then sends contractId and omits connectionId. Set confirmed to true only after they agree; false refuses and sends nothing.",
      schema: EXTEND_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  leaf_lookup_customer: buildLookupTool,
  leaf_connection_status: buildConnectionTool,
  leaf_open_invoices: buildInvoicesTool,
  leaf_second_copy: buildSecondCopyTool,
  leaf_extend_connection: buildExtendTool,
  leaf_clear_mac: (sel, ctx) =>
    buildWriteTool(sel, ctx, {
      name: "leaf_clear_mac",
      path: "/integrations/customers/clear-mac",
      description:
        "Clear the MAC address of a connection after the customer confirms. connectionId must be one leaf_lookup_customer returned for this contact. Set confirmed to true only after they agree; false refuses and sends nothing.",
      done: "The MAC address was cleared.",
    }),
  leaf_disconnect: (sel, ctx) =>
    buildWriteTool(sel, ctx, {
      name: "leaf_disconnect",
      path: "/integrations/customers/disconnect",
      description:
        "Disconnect a connection after the customer confirms. connectionId must be one leaf_lookup_customer returned for this contact. force is always false. Set confirmed to true only after they agree; false refuses and sends nothing.",
      done: "The connection was disconnected.",
      forceFalse: true,
    }),
};

export const leafAdminToolpack: Toolpack = {
  catalogType: "LEAF_ADMIN",
  toolSpecs: LEAF_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(leafAdminToolpack);
