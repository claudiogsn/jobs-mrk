require('dotenv').config();

const axios = require('axios');
const { log } = require('../utils/logger');
const { sendWhatsappText } = require('../utils/utils');

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
    const headers = { 'X-MRK-Job-Secret': segredo };
    const { data } = await axios.post(
        url,
        { method: 'sincronizarPendentes', data: { limite: 200 } },
        { headers, timeout: 280000 }
    );

    if (!data?.success) {
        throw new Error(data?.message || 'O portal não concluiu a sincronização.');
    }
    const alertas = Array.isArray(data.alertas) ? data.alertas : [];
    for (const alerta of alertas) {
        await sendWhatsappText(alerta.telefone, alerta.texto);
    }
    if (alertas.length > 0) {
        await axios.post(url, { method: 'marcarAlertados', data: { ids: alertas.map((a) => a.id) } }, { headers, timeout: 30000 });
    }
    log(`Pagamentos consultados: ${data.consultados}. Alterados: ${data.alterados}. Alertas: ${alertas.length}.`, ORIGEM);
    return data;
}

module.exports = { ExecuteJobPagamentosBancarios };

if (require.main === module) {
    ExecuteJobPagamentosBancarios().catch((e) => {
        log(`Falha: ${e.message}`, ORIGEM);
        process.exitCode = 1;
    });
}
