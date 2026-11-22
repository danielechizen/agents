/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The ERP root and the connection test live on the Leaf Admin credential. A generic
// credential has no test. Assertions stay on strings.

const { CredentialForm } = await import("@/client/components/CredentialForm");
const { ToastProvider } = await import("@/client/components/Toast");

afterEach(cleanup);

function form(kind: string) {
  render(
    <ToastProvider>
      <CredentialForm
        mode="create"
        initialKind={kind}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </ToastProvider>,
  );
}

function buttonName(name: string): string | null {
  return screen.queryByRole("button", { name })?.textContent ?? null;
}

test("Leaf Admin shows the ERP URL and the connection test", () => {
  form("leaf_admin");
  expect(buttonName("Test connection")).toBe("Test connection");
  expect(
    screen.getByLabelText(/ERP base URL/).getAttribute("placeholder"),
  ).toBe("https://erp.example.com");
  expect(document.body.textContent ?? "").toContain("no /api at the end");
  expect(screen.getByLabelText("Token").getAttribute("type")).toBe("password");
});

test("a generic credential has no connection test", () => {
  form("generic");
  expect(buttonName("Test connection")).toBeNull();
  expect(document.body.textContent ?? "").not.toContain("ERP base URL");
});

test("http and a URL ending in /api stay on the field", () => {
  form("leaf_admin");
  const input = screen.getByLabelText(/ERP base URL/);
  fireEvent.change(input, { target: { value: "http://erp.example.com" } });
  fireEvent.blur(input);
  expect(document.body.textContent ?? "").toContain("must use https");
  fireEvent.change(input, {
    target: { value: "https://erp.example.com/api" },
  });
  fireEvent.blur(input);
  expect(document.body.textContent ?? "").toContain("must not end with /api");
});
