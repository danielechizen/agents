import { z } from "zod";
import { clipText } from "@/lib/text";
import type { InboundMapper, MapResult } from "./types";

// INVOICE_PAID → agent_nudge. externalId is `leaf:` plus the invoice id stored when the
// toolpack listed or fetched that invoice. The model never supplies it. Other events are ignored.

export const LEAF_INVOICE_KIND = "leaf_invoice";

export function leafInvoiceExternalId(id: string): string {
  return `leaf:${id}`;
}

const idValue = z.union([z.string(), z.number().finite()]);

const leafInvoiceSchema = z.object({
  event: z.string().min(1),
  data: z
    .object({
      id: idValue.nullish(),
      uid: z.string().nullish(),
      due_date: z.string().max(64).nullish(),
      value: z.number().finite().nullish(),
      status: z.string().max(64).nullish(),
    })
    .nullish(),
});

function issuePaths(error: z.ZodError): string {
  return clipText(
    error.issues.map((i) => i.path.join(".") || "(root)").join(", "),
    200,
  );
}

function refToken(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export const leafAdminMapper: InboundMapper = {
  catalogType: "LEAF_ADMIN",
  map(raw: unknown): MapResult {
    const parsed = leafInvoiceSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: issuePaths(parsed.error) };
    }
    if (parsed.data.event !== "INVOICE_PAID") {
      return { ok: false, reason: "unhandled" };
    }
    const data = parsed.data.data;
    if (!data) return { ok: false, reason: "invalid", detail: "data" };
    const key = refToken(data.id) ?? refToken(data.uid);
    if (!key) return { ok: false, reason: "invalid", detail: "data.id" };
    return {
      ok: true,
      event: {
        kind: "agent_nudge",
        externalId: leafInvoiceExternalId(key),
        dedupeKey: `INVOICE_PAID:${key}`,
        summary: "Invoice paid",
        ...(data.status ? { status: data.status } : {}),
        ...(typeof data.value === "number" ? { value: data.value } : {}),
        ...(data.due_date ? { metadata: { dueDate: data.due_date } } : {}),
      },
    };
  },
};
