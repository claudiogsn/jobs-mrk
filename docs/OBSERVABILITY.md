# Observabilidade — jobs-mrk (SigNoz + OpenTelemetry + Pino)

Documento de entrega da camada de observabilidade e do desacoplamento de processos.

---

## 1. O que foi entregue

1. **Pacote reutilizável `@mrksolucoes/observability`** (em `packages/observability/`, via npm workspaces) — logs estruturados (Pino/JSON), traces, métricas e logs via OpenTelemetry/OTLP. Extraível como pacote privado: basta mover a pasta e `npm publish`.
2. **Integração no jobs-mrk** sem alterar regra de negócio: logger central, fim dos `console.*`, instrumentação automática dos 16 cron jobs e das rotas HTTP.
3. **Desacoplamento em 3 processos** (api / scheduler / consumer) sob PM2, com pool de conexão MySQL.
4. **Correções seguras de bugs** (path do dotenv, args invertidos do pipeline).

Validado ponta-a-ponta contra o SigNoz de produção (serviço `jobs-mrk-dev`).

---

## 2. Arquivos criados

| Arquivo | Função |
|---|---|
| `packages/observability/package.json` | Manifesto do pacote `@mrksolucoes/observability`. |
| `packages/observability/register.js` | Preload `-r` — inicia o OTel antes de tudo. |
| `packages/observability/src/index.js` | API pública do pacote. |
| `packages/observability/src/config/env.js` | Configuração 100% por env (OTEL_*, LOG_LEVEL…). |
| `packages/observability/src/otel/sdk.js` | NodeSDK: traces + métricas + logs OTLP + auto-instrumentação. |
| `packages/observability/src/logger/logger.js` | Logger Pino/JSON + serializer de erro. |
| `packages/observability/src/logger/context.js` | AsyncLocalStorage de correlação. |
| `packages/observability/src/workers/withExecution.js` | Envelope de execução de workers (executionId + início/fim/duração/erro). |
| `packages/observability/src/http/requestContext.js` | Middleware Express (requestId/trace/span). |
| `processes/api.js`, `processes/scheduler.js`, `processes/consumer.js` | Entrypoints desacoplados. |
| `.env.example` | Todas as 30+ variáveis documentadas. |
| `docs/OBSERVABILITY.md` | Este documento. |

## 3. Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `package.json` | `workspaces`, dependência do pacote, `start` com preload `-r`. |
| `index.js` | Inicializa OTel antes dos requires; inicia listener de reload. |
| `server.js` | Middleware de contexto; removido o override de `console.log`; `console.*`→logger; `/reload-cron` via fanout. |
| `cron/agendador.js` | Cada job envolto em `runWithExecution`; listener de reload. |
| `utils/logger.js` | Vira adapter de compatibilidade (delega ao pacote). |
| `utils/utils.js` | Pool de conexão MySQL singleton (`getConnection`/`getPool`). |
| `utils/rabbitmq.js` | `publishFanout`/`subscribeFanout` para reload cross-process. |
| `utils/apiLogger.js` | Espelha logs de API no logger estruturado. |
| `workers/*.js` | `console.*`→logger; correções de bugs (ver §6). |
| `ecosystem.config.js` | 3 apps PM2 com preload OTel e service-name próprio. |

---

## 4. Decisões técnicas (o porquê)

- **Preload `-r`**: o OTel faz monkey-patch de `http`/`express`/`mysql2`/`amqplib`/`pino`; precisa carregar **antes** desses módulos. Por isso `node -r dotenv/config -r @mrksolucoes/observability/register`. `initObservability()` no `index.js` é fallback idempotente.
- **`OTEL_ENABLED` (gate)**: com `false`, o app roda idêntico ao original (atende "nada pode deixar de funcionar"). O logger Pino continua imprimindo JSON local.
- **Adapter em `utils/logger.js`**: preserva a assinatura `log(message, worker)` usada por 28 arquivos — DRY, zero edição em massa.
- **Campos promovidos vs metadata**: `worker/executionId/jobId/requestId/correlationId/tenantId/userId` vão top-level (contrato); o resto vai sob `metadata`.
- **Pool com `end`→`release`**: o mysql2 já redireciona `conn.end()`→`release()` em pool, mas com warning de deprecação a cada chamada. Encapsulamos no `getConnection()` para não tocar nos ~18 callers nem poluir o log.
- **Reload via fanout RabbitMQ**: com o scheduler em outro processo, `/reload-cron` (na API) publica em `cron.reload`; o scheduler escuta e recarrega. Reusa infra existente, baixo acoplamento.
- **Erros nunca engolidos**: `runWithExecution` loga a stack completa e **re-lança**; o serializer extrai `type/file/line/stack`.

---

## 5. Como visualizar no SigNoz

Endpoint OTLP: **`http://monitor.mrksolucoes.com.br:4318`** (porta 4318 = ingest; a raiz `:443`/https serve a UI e **não** aceita OTLP).

- **Logs**: SigNoz → *Logs*. Filtrar por `service.name = jobs-mrk-api|scheduler|consumer`. Cada log traz `traceId`, `executionId`, `worker`, `requestId`.
- **Traces**: SigNoz → *Traces*. Spans `worker:<NomeDoJob>` (cron) e spans HTTP/`mysql2`/`amqplib` aninhados. Clicar num trace mostra a cascata rota → query → chamada externa.
- **Métricas**: SigNoz → *Dashboards*/*Metrics*. Runtime do Node (event loop lag, heap, GC) + métricas HTTP automáticas.
- **Correlação log↔trace**: num log, usar o `traceId` para abrir o trace correspondente.

> Teste de validação já enviado: serviço `jobs-mrk-dev`, span `worker:ValidacaoSigNoz`.

---

## 6. Bugs corrigidos (seguros)

1. `workers/workerPagamentos.js` — `dotenv.config({ path: path.resolve('../.env') })` (path relativo ao CWD, quebrava sob PM2) → `config()` puro.
2. `workers/workerSalesPipeline.js` — etapa 4 chamava `ExecuteJobCaixa(gid, start, end)` com args **invertidos** (assinatura é `dt_inicio, dt_fim, group_id`). Corrigido.
3. Vazamento de token: `console.log(url)` (URL com `Authorization=` na query) → log sem o token.

**Não alterados (confirmado com o time):** `movimento_caixa` (PHP) e a família `api_movimento_caixa` (conferência) são **pipelines distintos**, não duplicação — mantidos.

---

## 7. Sugestões futuras

- **Expor OTLP via HTTPS**: hoje a telemetria vai por HTTP puro (porta 4318). Configurar proxy reverso `https://monitor.mrksolucoes.com.br/v1/*` → collector:4318 e trocar a env para `https://`.
- **Crons fantasmas** (id16 `runSalesPipeline`, id18 `WorkerCopReport`): ativos na tabela mas fora do `jobMap` — religar com defaults ou marcar `ativo=0`.
- **Dead-letter queue** no consumer: hoje `nack(requeue=true)` reenfileira poison messages infinitamente.
- **Propagar erros de integração**: `callPHP`/`callMenew` retornam `null` em falha (falha silenciosa). Considerar lançar e marcar dia/loja para reprocesso.
- **Migrar `mysql.createConnection` avulsos** restantes (ex.: `workerPagamentos`) para o pool.
