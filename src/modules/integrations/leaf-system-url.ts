// The ERP root an operator types on a Leaf Admin credential. The client appends
// `/api/v2`. https only, no userinfo, no query, and the path must not already be
// `/api` or `/api/v2`. A slash already stored is still stripped at call time.

export type LeafSystemUrlProblem =
  | "empty"
  | "invalid"
  | "https"
  | "slash"
  | "userinfo"
  | "query"
  | "api";

export function leafSystemUrlProblem(
  raw: unknown,
): LeafSystemUrlProblem | null {
  if (typeof raw !== "string" || raw.trim() === "") return "empty";
  const value = raw.trim();
  if (value.endsWith("/")) return "slash";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:") return "https";
  if (url.username || url.password) return "userinfo";
  if (url.search || url.hash) return "query";
  const path = url.pathname.replace(/\/+$/, "");
  if (
    path === "/api" ||
    path.endsWith("/api") ||
    path === "/api/v2" ||
    path.endsWith("/api/v2")
  ) {
    return "api";
  }
  return null;
}

// The origin the tool calls. A trailing slash already on the row is removed so
// the request still reaches `/api/v2`.
export function leafApiBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (leafSystemUrlProblem(trimmed)) return null;
  return `${trimmed}/api/v2`;
}
