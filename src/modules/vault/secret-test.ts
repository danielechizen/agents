import logger from "@/api/lib/logger";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { clipText } from "@/lib/text";
import { fetchDespiteExpiredCertificate } from "@/modules/integrations/leaf-tls";
import {
  getSecretType,
  resolveSecretInjection,
  type SecretTestSpec,
  type SecretType,
} from "./secret-types";

// Connectivity test for a vault credential (test-on-save, n8n parity). Given a `kind` + plaintext
// secret (+ an optional baseURL for self-hosted/configurable services), the runner issues a single
// cheap authenticated GET to the type's declared probe endpoint, applying the SAME injection the
// real requests use (resolveSecretInjection), and maps the HTTP status to a stable failure code the
// client localizes. INVARIANTS: the secret is NEVER logged and never lands in a test URL (no
// testable type injects via query — only header/bearer); every probe URL is SSRF-guarded
// (https-only, blocks private/loopback/metadata) including the fixed public hosts (defensive).

const TEST_TIMEOUT_MS = 8_000;

export type SecretTestFailCode =
  | "unauthorized"
  | "forbidden"
  | "http_error"
  | "unreachable"
  | "timeout"
  | "blocked_url"
  | "missing_base_url"
  // Not a connectivity outcome: the write would refuse this value, so the probe says so instead of
  // reporting "Connection OK" for a header kind (fetch strips the padding on the way out).
  | "surrounding_whitespace";

export type SecretTestResult =
  | { testable: false }
  | { testable: true; ok: true }
  | { testable: true; ok: false; code: SecretTestFailCode; status?: number };

export interface SecretTestInput {
  kind: string;
  value: string;
  baseURL?: string | null;
  // For needsParamName types (header/query), the param name stored on the entry. Forwarded to
  // resolveSecretInjection so the probe uses the same effective name as the real request.
  paramName?: string | null;
}

export interface SecretTestDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
}

function leafLogText(value: unknown, secret: string): string {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  return secret ? text.split(secret).join("") : text;
}

async function readProbeBody(res: Response): Promise<string> {
  try {
    return clipText(await res.text(), 2_000);
  } catch {
    return "";
  }
}

function leafAccepted(statusCode: unknown): boolean {
  if (statusCode === 1) return true;
  return (
    typeof statusCode === "string" &&
    ["1", "ok"].includes(statusCode.trim().toLowerCase())
  );
}

function leafVerdict(
  status: number,
  body: string,
): Extract<SecretTestResult, { testable: true }> {
  let parsed: { statusCode?: unknown; detailCode?: unknown } | null = null;
  try {
    parsed = JSON.parse(body) as { statusCode?: unknown; detailCode?: unknown };
  } catch {
    parsed = null;
  }
  if (status >= 200 && status < 300 && leafAccepted(parsed?.statusCode)) {
    return { testable: true, ok: true };
  }
  const detail = String(parsed?.detailCode ?? "")
    .trim()
    .toLowerCase();
  if (status === 401 || detail === "bad_token") {
    return { testable: true, ok: false, code: "unauthorized", status };
  }
  if (status === 403 || detail === "forbidden") {
    return { testable: true, ok: false, code: "forbidden", status };
  }
  return { testable: true, ok: false, code: "http_error", status };
}

async function probe(
  rawBase: string,
  spec: SecretTestSpec,
  type: SecretType,
  value: string,
  paramName: string | null | undefined,
  fetchImpl: typeof fetch,
  assertSafe: (url: string) => Promise<URL>,
): Promise<Extract<SecretTestResult, { testable: true }>> {
  const root = rawBase.replace(/\/+$/, "");
  let url = `${root}${spec.path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(spec.extraHeaders ?? {}),
  };

  const injection = resolveSecretInjection(type.id, value, paramName);
  if (injection) {
    if (injection.target === "header") {
      headers[injection.name] = injection.value;
    } else {
      // No testable type injects via query today; kept correct for future declarations.
      try {
        const u = new URL(url);
        u.searchParams.set(injection.name, injection.value);
        url = u.toString();
      } catch {
        return { testable: true, ok: false, code: "blocked_url" };
      }
    }
  }

  try {
    await assertSafe(url);
  } catch {
    return { testable: true, ok: false, code: "blocked_url" };
  }

  const init: RequestInit = {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  };
  const send =
    type.id === "leaf_admin"
      ? (input: Parameters<typeof fetch>[0], next?: RequestInit) =>
          fetchDespiteExpiredCertificate(fetchImpl, input, next)
      : fetchImpl;

  let res: Response;
  try {
    res = await send(url, init);
  } catch (err) {
    if (type.id === "leaf_admin") {
      logger.info(
        {
          method: "GET",
          url,
          error: clipText(leafLogText(err, value), 240),
        },
        "leaf-admin: credential test",
      );
    }
    const name = err instanceof Error ? err.name : "";
    const code =
      name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "unreachable";
    return { testable: true, ok: false, code };
  }

  if (type.id === "leaf_admin") {
    const body = await readProbeBody(res);
    const verdict = leafVerdict(res.status, body);
    logger.info(
      {
        method: "GET",
        url,
        status: res.status,
        ...(verdict.ok
          ? {}
          : { error: clipText(leafLogText(body, value), 240) }),
      },
      "leaf-admin: credential test",
    );
    return verdict;
  }

  if (res.ok) return { testable: true, ok: true };

  // Scope-aware pass: a valid-but-scoped key can 4xx on the probe endpoint while still proving it
  // authenticated. When the type declares how to recognize that body, treat it as a pass (see
  // SecretTestSpec.authConfirmedOn4xx). Body is read capped and only substring-matched, never logged.
  if (spec.authConfirmedOn4xx && res.status >= 400 && res.status < 500) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 2_000);
    } catch {
      // Body unreadable: fall through to the status-based mapping below.
    }
    if (spec.authConfirmedOn4xx(res.status, body)) {
      return { testable: true, ok: true };
    }
  }

  if (res.status === 401)
    return { testable: true, ok: false, code: "unauthorized", status: 401 };
  if (res.status === 403)
    return { testable: true, ok: false, code: "forbidden", status: 403 };
  return { testable: true, ok: false, code: "http_error", status: res.status };
}

export async function runSecretTest(
  input: SecretTestInput,
  deps: SecretTestDeps = {},
): Promise<SecretTestResult> {
  const type = getSecretType(input.kind);
  if (!type?.test) return { testable: false };
  const spec = type.test;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;

  let bases: string[];
  if (spec.needsBase) {
    const base = (input.baseURL ?? "").trim();
    if (!base) return { testable: true, ok: false, code: "missing_base_url" };
    bases = [base];
  } else {
    const entryBase = spec.entryBaseFirst ? (input.baseURL ?? "").trim() : "";
    bases = entryBase
      ? [entryBase]
      : (spec.basesForValue?.(input.value) ?? spec.bases ?? []);
  }

  let lastFailure: Extract<SecretTestResult, { testable: true; ok: false }> = {
    testable: true,
    ok: false,
    code: "unreachable",
  };
  for (const base of bases) {
    const attempt = await probe(
      base,
      spec,
      type,
      input.value,
      input.paramName,
      fetchImpl,
      assertSafe,
    );
    if (attempt.ok) return attempt;
    lastFailure = attempt;
    // Fall through to the next base on any failure (covers asaas production → sandbox).
  }
  return lastFailure;
}
