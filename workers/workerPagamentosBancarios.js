require('dotenv').config();

const axios = require('axios');
const { log } = require('../utils/logger');

const ORIGEM = 'workerPagamentosBancarios';

/**
 * Pede ao portal para conferir os pagamentos em andamento na API da TecnoSpeed.
 * A regra (status, baixa e estorno) fica no portal; este worker só dispara a rotina.
 * Cobre avisos de webhook perdidos e pagamentos cujo envio ficou sem resposta.
 */
async function ExecuteJobPagamentosBancarios() {
    const segredo = process.env.TECNOSPEED_PAG_JOB_SECRET;
    const base = process.env.BACKEND_URL;
    if (!segredo || !base) {
        throw new Error('Configure TECNOSPEED_PAG_JOB_SECRET e BACKEND_URL no jobs-mrk.');
    }

    const url = new URL('pagamentos_bancarios.php', base).toString();
    const { data } = await axios.post(
        url,
        { method: 'sincronizarPendentes', data: { limite: 200 } },
        { headers: { 'X-MRK-Job-Secret': segredo }, timeout: 280000 }
    );

    if (!data?.success) {
        throw new Error(data?.message || 'O portal não concluiu a sincronização.');
    }
    log(`Pagamentos consultados: ${data.consultados}. Alterados: ${data.alterados}.`, ORIGEM);
    return data;
}

module.exports = { ExecuteJobPagamentosBancarios };

if (require.main === module) {
    ExecuteJobPagamentosBancarios().catch((e) => {
        log(`Falha: ${e.message}`, ORIGEM);
        process.exitCode = 1;
    });
}
