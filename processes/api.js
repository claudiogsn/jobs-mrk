/**
 * Processo: API HTTP (Express).
 *
 * Responsabilidade única: servir as rotas /jobs/* . Não agenda cron nem consome
 * fila. Falhas aqui não afetam o scheduler nem o consumer.
 *
 * OTel: inicializado via `-r @mrksolucoes/observability/register` no ecosystem,
 * com fallback programático abaixo (idempotente).
 */

require('dotenv').config();
require('@mrksolucoes/observability').initObservability();

require('../server'); // sobe o Express (app.listen)
