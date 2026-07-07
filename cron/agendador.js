const cron = require('node-cron');
const { log } = require('../utils/logger');
const { getConnection } = require('../utils/utils');
const { runWithExecution } = require('@mrksolucoes/observability');
const { subscribeFanout, EXCHANGES } = require('../utils/rabbitmq');

const jobMap = {
    ExecuteJobCaixa: require('../workers/workerMovimentoCaixa').ExecuteJobCaixa,
    ExecuteJobItemVenda: require('../workers/workerItemVenda').ExecuteJobItemVenda,
    ExecuteJobConsolidation: require('../workers/workerConsolidateSales').ExecuteJobConsolidation,
    ExecuteJobDocSaida: require('../workers/workerCreateDocSaida').ExecuteJobDocSaida,
    gerarFilaWhatsappCMV: require('../workers/WorkerDisparoEstoque').gerarFilaWhatsappCMV,
    ExecuteJobFluxoEstoque: require('../workers/workerFluxoEstoque').ExecuteJobFluxoEstoque,
    WorkerResumoDiario: require('../workers/WorkerDisparoFaturamento').WorkerResumoDiario,
    WorkerReportPdfWeekly: require('../workers/WorkerReportPdfWeekly').WorkerReportPdfWeekly,
    WorkerReportPdfMonthly: require('../workers/WorkerReportPdfMonthly').WorkerReportPdfMonthly,
    WorkerNotasPendentes: require('../workers/workerNotasPendentes').WorkerNotasPendentes,
    WorkerConsolidationStock: require('../workers/WorkerConsolidationStock').WorkerConsolidationStock,
    ExecuteJobTelemetria: require('../workers/workerTelemetria').ExecuteJobTelemetria,
    WorkerJobConferencia: require('../workers/workerPagamentos').WorkerJobConferencia,
    ExecuteJobSolicitacao: require( '../workers/workerSolicitacaoExtrato').ExecuteJobSolicitacao,
    ExecuteJobImportacao: require('../workers/workerImportacaoExtrato').ExecuteJobImportacao,
    ExecuteJobIfoodSync: require('../workers/workerIfoodSync').ExecuteJobIfoodSync,
    ExecuteJob3lmEstoque: require('../workers/worker3lmEstoque').ExecuteJob3lmEstoque,

    // 🔧 Job de teste
    jobTesteLog: async () => {
        log('💡 Job de teste executado com sucesso!', 'CronJob');
    }
};

let jobsAgendados = [];

async function agendarJobsDinamicos() {
    const conn = await getConnection();
    const [jobs] = await conn.query('SELECT * FROM disparos WHERE ativo = 1');
    await conn.end();

    log(`🔁 Carregando ${jobs.length} cron jobs ativos...`, 'CronJob');

    jobsAgendados.forEach(job => job.stop());
    jobsAgendados = [];

    for (const job of jobs) {
        const metodoFn = jobMap[job.metodo];

        if (!metodoFn) {
            log(`❌ Ignorado: ${job.nome} (método "${job.metodo}" não encontrado)`, 'CronJob');
            continue;
        }

        try {
            const task = cron.schedule(job.cron_expr, async () => {
                log(`⏰ Executando: ${job.nome}`, 'CronJob');
                try {
                    // Envelope de observabilidade: executionId + início/fim/duração/erro
                    // + span raiz do job. Re-lança em erro (tratado abaixo p/ disparos_logs).
                    await runWithExecution(
                        job.metodo,
                        () => metodoFn(),
                        { jobId: job.id, metadata: { nome: job.nome, cron: job.cron_expr } }
                    );

                    const innerConn = await getConnection();
                    await innerConn.query('UPDATE disparos SET ultima_execucao = NOW() WHERE id = ?', [job.id]);
                    await innerConn.query(`
                        INSERT INTO disparos_logs (disparo_id, status, mensagem)
                        VALUES (?, 'ok', ?)`,
                        [job.id, `Executado com sucesso`]);
                    await innerConn.end();

                } catch (errExec) {
                    log(`❌ Erro: ${errExec.message}`, 'CronJob');

                    const errorConn = await getConnection();
                    await errorConn.query(`
                        INSERT INTO disparos_logs (disparo_id, status, mensagem)
                        VALUES (?, 'erro', ?)`,
                        [job.id, errExec.message]);
                    await errorConn.end();
                }
            }, {
                timezone: 'America/Sao_Paulo'
            });

            jobsAgendados.push(task);

            log(`✅ Job agendado: "${job.nome}" → ${job.cron_expr} → ${job.metodo}`, 'CronJob');

        } catch (errSchedule) {
            log(`❌ Erro ao agendar "${job.nome}": ${errSchedule.message}`, 'CronJob');
        }
    }

    log(`✅ Todos os cron jobs foram carregados com sucesso.`, 'CronJob');
}

/**
 * Escuta o sinal de reload (exchange fanout) e recarrega os jobs sem reiniciar o
 * processo. Permite que a rota /reload-cron (no processo da API) recarregue o
 * agendador mesmo quando ele roda em outro processo.
 */
async function iniciarListenerReload() {
    try {
        await subscribeFanout(EXCHANGES.CRON_RELOAD, async () => {
            log('🔄 Sinal de reload recebido — recarregando cron jobs...', 'CronJob');
            await agendarJobsDinamicos();
        });
    } catch (err) {
        log(`⚠️ Não foi possível iniciar o listener de reload: ${err.message}`, 'CronJob');
    }
}

module.exports = { agendarJobsDinamicos, iniciarListenerReload };
