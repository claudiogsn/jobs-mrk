# MrkSync no lugar da API do Menew (vendas)

O MrkSync (agente Windows nas lojas) copia o Firebird do PDV Menew para as tabelas `integracao_menew_*`, uma linha
do Firebird por registro, em `dados` (JSON). O objetivo é que, nas lojas com o agente, o faturamento, os itens
vendidos e os pagamentos venham dessa réplica, gravados nas mesmas tabelas e no mesmo formato que os jobs da API do
Menew gravam hoje. Assim nenhuma tela, relatório ou o mrk-core muda.

## Etapas

1. **Comparador (pronto):** monta as vendas da réplica e compara com o que a API gravou. Não grava em tabela de venda.
2. Chave por loja **"Fonte das vendas"** (`api` ou `mrksync`) na integração Menew, espelhada em
   `system_unit.menew_fonte_vendas`. Os jobs do Menew só processam lojas em `api`.
3. Worker que grava `movimento_caixa`, `sales` e `api_pagamentos` para as lojas em `mrksync`.
4. Ligar na RED Burger - Barra por uma semana, com o comparador rodando.
5. Alerta de réplica parada e as demais lojas.

## Comparador

- Código: `mrksync/transformar.js` (monta as vendas, puro), `mrksync/comparar.js` (compara, puro),
  `mrksync/replica.js` (leitura no banco, só SELECT), `workers/workerMrkSyncComparador.js` (job).
- Job `ExecuteJobMrkSyncComparador` (cadastrar em `disparos`, ex. `0 6 * * *`): compara o dia anterior em todas as
  lojas com máquina ativa e grava o relatório em `mrksync/comparacao/AAAA-MM-DD/<loja>.json` no S3.
- Rota: `GET /api/mrksync/comparar?unit=4&inicio=AAAA-MM-DD&fim=AAAA-MM-DD` (sem datas: ontem; sem `unit`: lista as
  lojas). Período máximo de 31 dias.
- Testes: `npm run test:mrksync`.
- Rodar no horário certo: o job de itens da API roda às 03:30 e a conferência às 05:30. Antes disso o dia anterior
  aparece com itens faltando do lado da API.

Validação em 23/11/2026, RED Burger - Barra, 1 a 22/11: 2.168 de 2.168 contas, 1.499 de 1.499 produtos por dia e
3.171 de 3.171 pagamentos iguais. 67 notas aparecem como recriadas (ver abaixo).

## Regras (conferidas contra a API)

### Quais contas entram

- **Caixa e itens:** contas com `STATUS = 2` e com registro em `TBNFCE`, de qualquer ocorrência (A autorizada,
  G contingência, E rejeitada, N não emitida por falta de certificado). É o que a API faz. Contas fechadas sem
  nenhuma NFC-e ficam de fora (decisão de 23/11/2026: só vendas com NFC-e). Contas com `STATUS` 10 ou 11 ficam de fora.
- **Pagamentos:** todas as contas com `STATUS = 2`, com ou sem nota (o método `pagamentos` da API não filtra por
  NFC-e), menos linhas com `VALOR` negativo (troco lançado como pagamento).

### `movimento_caixa` (TBCABCONTA)

| Coluna | Regra |
| --- | --- |
| `id` | `{custom_code}99{NUM_CONTROLE}88{NUMERO_NFC}` |
| `lojaId` | `system_unit.custom_code` (o mrk-core só casa pelo id quando a rede é Zig) |
| `operacaoId` | `{custom_code}-{AAAAMMDD de DT_MOV}.{TN_MOV}-{CAIXA}.{NUM_CONTROLE}` |
| `dataContabil` | `DT_MOV` |
| `dataAbertura`, `hora` | `DT_ABERTURA` + `HR_ABERTURA` |
| `dataFechamento` | data de `DT_MOV` + `HR_FECHA` (a API mantém a data contábil quando fecha depois da meia-noite; 4 em 2.168 contas diferem e ficam fora da comparação) |
| `modoVenda`, `modoVenda2` | `DELIVERY` com `INTG_TIPO`; `SALAO` com `MESA > 0`; senão `BALCAO` (1 = BALCAO, 2 = DELIVERY, 3 = SALAO) |
| `idAtendente`, `codAtendente` | `CAIXA` (o operador do caixa) |
| `nomeAtendente` | `TBOPE.NOME` do `NUMERO = CAIXA` |
| `vlDesconto` | `DESCONTO` |
| `vlAcrescimo`, `vlServicoRecebido` | `ACRESCIMO` (é a taxa de serviço) |
| `vlTotalReceber` | soma de `PRECO × QUANT` dos itens (`TBDETCONTA`) com `STATUS = 2`, inclusive os com `CANCELA = 1` |
| `vlTotalRecebido` | soma de `TBPAGCONTA.VALOR` da conta, inclusive linhas negativas |
| `vlTrocoFormasPagto` | `TROCO` |
| `vlTaxaEntrega` | `DELIVERY_FEE` (a API não usa `TAXA_ENTREGA_MARKETPLACE`) |
| `numPessoas` | `NPESSOAS` |
| `periodoId`, `periodoCod`, `periodoNome` | `TN_MOV`, `"Turno N"` |
| máquina | a API grava a máquina da nuvem do Menew ("CX 1"), sem ligação clara com o PDV; fica nula (nenhum relatório lê) |

### `sales` → `_bi_sales` (TBNFCE_ITENS)

Os itens da API são os **itens da NFC-e**, não os itens da conta: por isso cancelados e estornos não entram.

| Coluna | Regra |
| --- | --- |
| `idItemVenda` | `{custom_code}99{CODIGO}88{NUMERO_NFC}` |
| `codMaterial`, `idMaterial` | `PRODUTO` |
| `quantidade` | `QUANTIDADE` truncada (a coluna é inteira) |
| `valorBruto` | `VALOR_TOTAL` |
| `valorUnitario` | `PRECO_UNITARIO` |
| `valorLiquido` | `VALOR_TOTAL - VALOR_DESCONTO` |
| `valorUnitarioLiquido` | líquido ÷ `QUANTIDADE`, truncado em 2 casas |
| `dtLancamento` | `DT_MOV` da conta da nota, à meia-noite |
| `modoVenda` | o da conta |
| `descricao` | `TBPROD.NOME` |
| `grupo__*` | `TBPROD.CATEG` → `TBCATEG.NOME` |
| `__nfNumeroC` | `NUMERO_NFC` |

A taxa de serviço vem como produto **9000 "SERVICO OPCIONAL"**, um item por nota.

**Notas recriadas:** quando o PDV recria os itens de uma NFC-e, a nuvem do Menew fica com os ids antigos (às vezes
duplicados) e o `sales` nunca apaga. Nessas notas os itens da API e da réplica não têm os mesmos ids nem sempre o
mesmo total. O comparador lista essas notas à parte e não reprova por elas; a réplica traz o estado atual do PDV.

### `api_pagamentos` (TBPAGCONTA)

| Coluna | Regra |
| --- | --- |
| `num_pedido`, `seq_pedido` | `NUM_CONTROLE`, `SEQUENCIAL` |
| `id_m` | `FORMA_PAG × 10 + FORMA_COMP` (código do meio na nuvem do Menew: 33 = MASTER CREDITO, 170 = IFOOD ONLINE) |
| `descricao`, `taxa_comissao` | `meios_pagamento` da loja pelo `id_externo = id_m` |
| `valor` | `VALOR` |
| `dias_vencimento` | `TBFORMA.PRAZO` da forma |
| `id_tipo`, `tipo_pagamento`, `id_bandeira`, `bandeira` | pelo nome do meio (DEBITO, CREDITO, VISA, MASTER...) |
| `id_operacao` | o `operacaoId` da conta |

## Observações

- As tabelas da réplica não têm índice pela data de movimento: ler um dia varre as linhas da loja. Ler 2 dias da
  Barra leva cerca de 45 s. Para o worker da etapa 3, criar uma coluna gerada de `DT_MOV` com índice.
- Em novembro, a partir de 14/11, várias notas da Barra ficaram em ocorrência N ("Certificado não encontrado"):
  a venda conta, mas a nota não foi autorizada.
