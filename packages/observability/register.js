'use strict';

/**
 * Preload de observabilidade.
 *
 * Uso: `node -r @mrksolucoes/observability/register app.js`
 * (ou via PM2 `node_args: '-r @mrksolucoes/observability/register'`).
 *
 * Carregar por `-r` garante que o OpenTelemetry instrumente http/express/mysql2/
 * amqplib/pino ANTES de a aplicação os requerer — pré-requisito para o patch funcionar.
 *
 * Espera-se que as variáveis de ambiente já estejam carregadas. Para projetos que usam
 * dotenv, basta exportar as variáveis no ambiente do PM2 ou usar `-r dotenv/config`
 * ANTES deste preload.
 */

require('./src/otel/sdk').startOtel();
