# MrkSync no lugar da API do Menew (vendas)

O MrkSync (agente Windows nas lojas) copia o Firebird do PDV Menew para as tabelas `integracao_menew_*`, uma linha
do Firebird por registro, em `dados` (JSON). O objetivo é que, nas lojas com o agente, o faturamento, os itens
vendidos e os pagamentos venham dessa réplica, gravados nas mesmas tabelas e no mesmo formato que os jobs da API do
Menew gravam hoje. Assim nenhuma tela, relatório ou o mrk-core muda.

## Etapas

1. **Comparador (no ar desde 24/11/2026):** monta as vendas da réplica e compara com o que a API gravou. Não grava
   em tabela de venda. Job `ExecuteJobMrkSyncComparador` às 06:00 (disparos id 29).
2. **Chave "Fonte das vendas" (no ar desde 24/11/2026):** `api` ou `mrksync`, no cartão Menew da tela de Integrações
   do portal, gravada em `unit_integracoes.config.fonte` e em `system_unit.menew_fonte_vendas`
   (`portal-mrk/migrations/mrksync_fonte_vendas.sql`). Os jobs da API (caixa, itens e conferência) pulam as lojas em
   `mrksync` (`mrksync/fonte.js`). A tela só oferece MrkSync com máquina ativa, réplica nas últimas 2 horas e
   `MRKSYNC_VENDAS_ATIVO=1` no ambiente do portal.
3. **Worker que grava (no ar desde 24/11/2026):** `workers/workerMrkSyncVendas.js`, job `ExecuteJobMrkSyncVendas`
   a cada 5 minutos (disparos id 30), ontem e hoje. Grava `movimento_caixa`, `sales` e `api_pagamentos` numa
   transação por loja (`mrksync/gravar.js`). A consolidação (`_bi_sales`, 04:00) e a baixa de estoque (04:30)
   continuam lendo o `sales`. Índices da réplica: migration 000035 do mrk-core.
4. **RED Burger - Barra em MrkSync desde 24/11/2026, 02:16.** Para voltar à API: trocar a fonte para API do Menew na
   tela (ou `UPDATE system_unit SET menew_fonte_vendas = 'api' WHERE id = 4`); no ciclo seguinte os jobs da API
   regravam o dia.
5. **Alerta (no ar):** quando o computador da loja mandou sinal hoje depois das 10h e está há mais de 30 minutos
   sem sinal, o worker registra no log e, se `MRKSYNC_ALERTA_WHATSAPP` estiver definido no jobs-mrk, manda no
   WhatsApp. Loja fechada com o computador desligado não gera aviso.

### Simulação da virada (dia 23/11, RED Burger - Barra)

| | API do Menew (antigo) | MrkSync (novo) |
| --- | --- | --- |
| Pedidos | 59 | 59 |
| Faturamento bruto | R$ 8.008,88 | R$ 8.008,88 |
| Taxa de serviço | R$ 586,59 | R$ 586,59 |
| Descontos | R$ 499,93 | R$ 499,93 |
| Faturamento líquido | R$ 6.922,36 | R$ 6.922,36 |
| Pessoas / ticket médio | 94 / R$ 85,20 | 94 / R$ 85,20 |
| Pagamentos | 79, R$ 8.008,88 | 79, R$ 8.008,88 |
| Itens (sales / _bi_sales) | 314 itens, R$ 8.775,12 | 301 itens, R$ 8.500,25 |

A diferença nos itens (R$ 274,87) vem de 6 notas que o PDV recriou: a API manteve os itens antigos junto com os
novos (na nota 80886, 16 itens no lugar de 8). Em 5 delas o total da réplica é exatamente o total de produtos da
NFC-e. De 1 a 22/11 essas notas inflaram os itens da API em R$ 1.334,38 (0,48% de R$ 280.320,14). Com o MrkSync,
o CMV e a baixa de estoque deixam de contar esses itens duplicados.

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
