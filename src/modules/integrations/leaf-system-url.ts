// The ERP base an operator types on a Leaf Admin integration. The tool appends
// `/api/v2`. A write refuses an empty value, anything other than https, and a
// trailing slash. A slash already stored is still stripped at call time.

export type LeafSystemUrlProblem =
  | "empty"
  | "invalid"
  | "https"
  | "slash"
  | "userinfo"
  | "query";

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
