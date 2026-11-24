/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import ptBR from "@/client/locales/pt-BR.json";
import { LeafLookupHelp } from "@/client/pages/resources/IntegrationEditModal";

afterEach(cleanup);

test("the Leaf Admin integration screen states the lookup parameters", () => {
  render(<LeafLookupHelp />);
  const text = document.body.textContent ?? "";
  expect(text).toContain("phone parameter on GET /integrations/contracts");
  expect(text).toContain(
    "does not supply the phone, the URL, the token or an id",
  );
  expect(text).toContain("cpf_cnpj");
  expect(text).toContain("document parameter");
  expect(text).toContain("only when the contact exists");
  expect(text).toContain("the conversation has no contact");
  expect(text).toContain("connectionId");
  const pt = ptBR.integrations as {
    leafLookupPhone: string;
    leafLookupDocument: string;
    leafLookupIds: string;
  };
  expect(pt.leafLookupPhone).toContain("parâmetro phone");
  expect(pt.leafLookupPhone).toContain("GET /integrations/contracts");
  expect(pt.leafLookupPhone).toContain("só quando o contato existe");
  expect(pt.leafLookupPhone).toContain(
    "não informa telefone, URL, token nem id",
  );
  expect(pt.leafLookupDocument).toContain("cpf_cnpj");
  expect(pt.leafLookupDocument).toContain("parâmetro document");
  expect(pt.leafLookupDocument).toContain(
    "ou se a conversa não tiver contato, a ferramenta aceita o CPF/CNPJ que o cliente disse (11 ou 14 dígitos) e manda em document",
  );
  expect(pt.leafLookupIds).toContain("connectionId");
});
