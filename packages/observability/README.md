# @mrksolucoes/observability

Camada reutilizável de observabilidade para projetos Node.js da MRK Soluções.
Padroniza **logs** (Pino/JSON), **traces** e **métricas** via **OpenTelemetry (OTLP)**,
exportando para o **SigNoz**.

## Instalação (uso interno via npm workspaces)

Já disponível no monorepo como dependência local. Em outro projeto:

```bash
npm install @mrksolucoes/observability
```

## Inicialização

A forma recomendada é o **preload**, que garante a instrumentação antes dos módulos
da aplicação:

```bash
node -r dotenv/config -r @mrksolucoes/observability/register index.js
```

Ou programática (chamar o quanto antes, antes de http/express/mysql2/amqplib):

```js
require('@mrksolucoes/observability').initObservability();
```

## Uso

```js
const { getLogger, runWithExecution, requestContextMiddleware } = require('@mrksolucoes/observability');
const log = getLogger();

log.info('mensagem', { qualquer: 'coisa' }); // o 2º arg já é o metadata
log.error(new Error('falhou'));              // preserva stack, type, file, line

// Workers: executionId + início/fim/duração/erro automáticos
await runWithExecution('MeuJob', async ({ executionId }) => {
    // ... regra de negócio ...
}, { jobId: 42 });

// Express
app.use(requestContextMiddleware);
```

## Configuração (variáveis de ambiente)

| Variável | Default | Descrição |
|---|---|---|
| `OTEL_ENABLED` | `true` | Liga/desliga toda a stack. `false` = app roda idêntico ao original. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://monitor.mrksolucoes.com.br:4318` | Endpoint OTLP do SigNoz (porta 4318 = ingest; :443 é a UI). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Protocolo OTLP. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Headers extras (ex.: auth). |
| `OTEL_SERVICE_NAME` | `npm_package_name` | Nome do serviço. |
| `OTEL_SERVICE_VERSION` | `npm_package_version` | Versão do serviço. |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Atributos extras de resource. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Intervalo de export de métricas (ms). |
| `LOG_LEVEL` | `info` (prod) / `debug` | Nível mínimo do Pino. |
| `NODE_ENV` | `development` | Ambiente (vira `deployment.environment`). |

## Campos do log estruturado

`timestamp, level, service, environment, version, hostname, pid, worker, executionId,
traceId, spanId, requestId, correlationId, tenantId, userId, jobId, message, metadata,
error{ type, message, code, file, line, stack }`.
