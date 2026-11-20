import { useBranding } from "@/client/contexts/BrandingContext";

// The auth-page footer: "© {year} {brandName}". The name follows the global white-label config
// and is always plain text.
export function BrandFooter() {
  const { brandName } = useBranding();
  const year = new Date().getFullYear();
  return (
    <footer className="mt-12 text-center">
      <p className="text-text-muted text-xs">
        {"© "}
        {year} <span className="text-text-secondary">{brandName}</span>
      </p>
    </footer>
  );
}
