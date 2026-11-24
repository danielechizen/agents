// The Leaf Admin certificate at dev is a real chain whose date has passed. The
// runtime then aborts before any HTTP byte leaves. A second attempt is made
// only for that error, so the request still reaches the server. Every other
// TLS failure stays a failure.

export function isExpiredCertificate(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  if (code === "CERT_HAS_EXPIRED") return true;
  const message = err instanceof Error ? err.message : "";
  return message.includes("certificate has expired");
}

export async function fetchDespiteExpiredCertificate(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (err) {
    if (!isExpiredCertificate(err)) throw err;
    return await fetchImpl(input, {
      ...(init ?? {}),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
  }
}
