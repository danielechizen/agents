# Leaf Admin

Toolpack de saída para o sistema Leaf Admin do provedor, mais o webhook `INVOICE_PAID`. O modelo não escolhe a URL, o token, o telefone nem um id que esta conversa não tenha encontrado.

A verificação TLS fica ligada. O adaptador do Leaf Agent manda `verify: false`; este cliente não desliga a verificação e não instala um agente TLS próprio.

## URL e cabeçalho

A URL e o token ficam na credencial do tipo `leaf_admin`, não numa credencial genérica. O campo **URL base do ERP** é a raiz https do sistema, sem barra no final e sem `/api`. O cliente chama `{url}/api/v2`. `http`, usuário e senha na URL, query, fragmento e um caminho que já termina em `/api` são recusados antes de gravar. Uma barra que já esteja gravada é removida na chamada.

Cada request manda `x-auth-header` com o texto puro do token dessa credencial. A credencial genérica não tem teste de conexão e a ferramenta não a lê. Sem a URL, ou sem o token, a ferramenta diz em português qual dos dois falta. O token não entra no log, na mensagem devolvida ao modelo nem no corpo que o modelo vê.

Sucesso é HTTP 2xx **e** `statusCode` `1` ou `"ok"` (sem distinguir maiúsculas; `"1"` também vale).

Credencial inválida, e a chamada fecha: HTTP 401 ou 403, ou `detailCode` `19`, `43`, `bad_token` ou `forbidden`.

O request não segue redirect, estoura em 15 s e lê no máximo um prefixo do corpo. A URL montada passa pelo guarda SSRF (`assertSafeOutboundUrl`): https e host público. A origem é a URL base da credencial Leaf Admin, nunca um argumento da ferramenta.

## Cadastro

1. No cofre, ou ao criar a credencial a partir da integração, escolha o tipo **Leaf Admin**. Preencha **URL base do ERP** (`https`, sem barra no final e sem `/api`) e o **token**. **Testar conexão** aparece nesse tipo, como nos outros tipos de serviço, e continua ausente no genérico.
2. Em Componentes → Integrações, crie a instância **Leaf Admin** e escolha essa credencial. **Testar comunicação**, na integração já salva, usa a URL e o token dessa credencial e não devolve o token.
3. O webhook exige autenticação (`NONE` é recusado na gravação). Na mesma tela, estratégia **cabeçalho estático** e um segredo do cofre em `inboundSecretRef`. O nome padrão do cabeçalho é `x-webhook-token`. `config.authHeader` troca o nome.

## Identidade

O telefone é `Contact.phone`, o espelho do telefone do contato no Chatwoot, só os dígitos. Não é argumento da ferramenta. O CPF/CNPJ é o atributo de contato `cpf_cnpj`, e só entra na busca quando o telefone não acha contrato (ou quando o contato não tem telefone). Sem os dois, a ferramenta não chama o Leaf.

Contrato, conexão e fatura que o modelo passa têm de estar na busca **desta** chamada. Um id que a lista não devolveu não segue para o GET ou o POST.

A listagem de contratos pede `limit=50`, no máximo 20 páginas, e para quando `results` vem vazio ou a quantidade lida alcança `total`. `total` ausente ou `0` encerra na primeira página, como o adaptador do Leaf (`to_i` de nil é 0).

## Caminhos

| Ferramenta | Método e caminho |
| --- | --- |
| `leaf_lookup_customer` | `GET /integrations/contracts?phone=` ou `document=`, com `page` e `limit` |
| `leaf_connection_status` | `GET /integrations/customers?connectionId=&limit=1` |
| `leaf_open_invoices` | `GET /integrations/billets?contractId=&status=delayed&limit=5` |
| `leaf_second_copy` | `GET /integrations/billets/{id}/payment?type=pix\|bankSlip\|creditCard` |
| `leaf_extend_connection` | `POST /integrations/customers/extend` `{connectionId}` |
| `leaf_clear_mac` | `POST /integrations/customers/clear-mac` `{connectionId}` |
| `leaf_disconnect` | `POST /integrations/customers/disconnect` `{connectionId, force: false}` |

O `id` da segunda via é só dígitos, sem zero à esquerda. `type` na query é `pix`, `bankSlip` ou `creditCard`, conforme o cliente pediu pix, boleto ou cartão. Se a lista de faturas trouxer `paymentMethods`, o método precisa estar marcado; sem esse objeto, o tipo pedido segue.

`pppoePassword` não volta para o modelo, nem aninhado. A leitura de conexão devolve status, `pppoeLogin`, GPON (`status`, `rxPower`, `alarm`) e a mensagem de `auth`.

PIX: `copyPaste` e `qr` (se `qr` não vier, lê `qrCode`, que é o nome no adaptador do Leaf Agent). Um QR maior que 4000 caracteres não entra no texto da ferramenta; a linha copia-e-cola sim.

Boleto: `pdf` (base64) e `url`. Com uma conversa ao vivo, o PDF sai pelo anexo que o cliente Chatwoot já tem (`sendFileAttachment`), nome `boleto-{id}.pdf`. A URL volta na resposta da ferramenta. Sem conversa (playground) ou se o envio falhar, a ferramenta devolve a URL e diz que o PDF não foi anexado — não há um transporte novo. Cartão: `url`, ou `params.url` se a primeira não vier.

## Escrita

`confirmed` é obrigatório. `true` só depois que o cliente concordou nesta conversa. `false` recusa e não chama o Leaf. `force` no disconnect é sempre `false`; o modelo não liga isso.

## Webhook `INVOICE_PAID`

Corpo: `{ "event": "INVOICE_PAID", "data": { "id", "uid", "due_date", "value", "status" } }`. Vira `agent_nudge` na conversa correlacionada. A chave é `leaf:` + `id` (ou `uid`, se `id` vier vazio). A ferramenta grava essa chave ao listar ou buscar a fatura (`IntegrationExternalRef`, kind `leaf_invoice`). O modelo não informa o id. Outros eventos são ignorados.

Lacuna: o webhook do Leaf não documenta segredo compartilhado nem cabeçalho de assinatura. A rota não aceita POST anônimo. O operador configura o cabeçalho estático e o segredo do cofre, e o Leaf precisa enviar esse cabeçalho. Enquanto o Leaf não documentar o segredo, uma entrega sem ele responde 401 e não escreve na conversa.

## Imagem

`custom/bin/publish-image.sh` publica `leaf-agent-ia` (não `leaf-agent`, que é a imagem do Chatwoot). `local` sobe `localhost:5000/leaf-agent-ia:latest` e `:<git sha>`. `remote` exige `LEAF_REGISTRY`, `LEAF_REGISTRY_USER` e `LEAF_REGISTRY_PASSWORD` (a senha entra por stdin no `docker login`). O Dockerfile é o da raiz do repositório, contexto `.`.
