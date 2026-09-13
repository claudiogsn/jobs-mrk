// workers/WorkerRecalcularSaldos.js
require('dotenv').config();
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const { log } = require('../utils/logger');
const { callPHP } = require('../utils/utils');

const CLI_SCRIPT_PATH = path.resolve(__dirname, '../../portal-mrk/api/v1/cli/recalcularSaldosCli.php');

/**
 * Executa o recálculo via CLI PHP local caso a chamada HTTP à API falhe ou a API ainda não esteja implantada.
 */
async function recalcularViaCli(systemUnitId, produtoCodigo = null, origem = 'JOB_05AM') {
    const args = [
        CLI_SCRIPT_PATH,
        `--system_unit_id=${systemUnitId}`,
        `--origem=${origem}`
    ];
    if (produtoCodigo) {
        args.push(`--produto_codigo=${produtoCodigo}`);
    }

    const { stdout } = await execFileAsync('php', args, {
        timeout: 300000 // 5 minutos por unidade
    });

    try {
        return JSON.parse(stdout.trim());
    } catch (e) {
        return { success: false, message: `Falha ao interpretar resposta do CLI: ${stdout}` };
    }
}

/**
 * Executa o recálculo para uma única loja.
 * Tenta primeiro via chamada HTTP da API (callPHP). Se não estiver disponível, faz fallback para o script CLI local.
 */
async function recalcularUnidade(unitId, unitName, produtoCodigo = null, origem = 'JOB_05AM') {
    let result = null;

    try {
        // 1) Tentativa via API central do portal
        result = await callPHP('recalcularSaldos', {
            system_unit_id: unitId,
            origem,
            produto_codigo: produtoCodigo
        });
    } catch (err) {
        log(`⚠️ Chamada HTTP falhou para loja ${unitName} (${unitId}): ${err.message}. Tentando fallback CLI...`, 'WorkerRecalcularSaldos');
    }

    // 2) Se a API remota retornar null, método não suportado ou erro, recorre ao CLI PHP
    if (!result || result.error || !result.success) {
        try {
            result = await recalcularViaCli(unitId, produtoCodigo, origem);
        } catch (cliErr) {
            log(`❌ Erro no fallback CLI para unidade ${unitName} (${unitId}): ${cliErr.message}`, 'WorkerRecalcularSaldos');
            return {
                success: false,
                message: cliErr.message
            };
        }
    }

    return result;
}

/**
 * WorkerRecalcularSaldos
 * - Executa diariamente às 05:15 (após o WorkerConsolidationStock das 05:00)
 * - Roda para TODAS as lojas ativas, independente de parâmetros adicionais
 * - Recalcula saldos a partir do marco zero mais recente (Balanço ou Ajuste de Saldo)
 * - Salva o histórico detalhado na tabela estoque_recalculo_log e auditoria
 */
async function WorkerRecalcularSaldos({ unit = null, produtoCodigo = null, origem = 'JOB_05AM' } = {}) {
    const inicio = DateTime.local();
    log(
        `🚀 Iniciando WorkerRecalcularSaldos às ${inicio.toFormat('HH:mm:ss')} (Independente de parâmetros de consolidação)`,
        'WorkerRecalcularSaldos'
    );

    let conn;
    let lojas = [];

    try {
        conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            dateStrings: true
        });

        if (unit) {
            const [rows] = await conn.execute(
                `SELECT id, name, custom_code FROM system_unit WHERE id = ?`,
                [unit]
            );
            lojas = rows;
        } else {
            // Busca TODAS as unidades ativas
            const [rows] = await conn.execute(
                `SELECT id, name, custom_code 
                 FROM system_unit 
                 WHERE status = 1 OR status IS NULL 
                 ORDER BY id ASC`
            );
            lojas = rows;
        }
    } catch (dbErr) {
        log(`❌ Erro ao conectar no banco para buscar lojas: ${dbErr.message}`, 'WorkerRecalcularSaldos');
        return;
    } finally {
        if (conn) {
            await conn.end();
        }
    }

    if (!lojas.length) {
        log('⚠️ Nenhuma unidade encontrada para recalcular saldos.', 'WorkerRecalcularSaldos');
        return;
    }

    log(`📦 Total de lojas a processar: ${lojas.length}`, 'WorkerRecalcularSaldos');

    let totalGeralProcessados = 0;
    let totalGeralAtualizados = 0;
    let totalGeralInalterados = 0;
    let totalLojasSucesso = 0;
    let totalLojasFalha = 0;

    for (const loja of lojas) {
        const unitId = loja.id;
        const unitName = loja.name || `Unidade ${unitId}`;

        log(`🔄 Recalculando saldos: ${unitName} (ID: ${unitId})...`, 'WorkerRecalcularSaldos');

        try {
            const res = await recalcularUnidade(unitId, unitName, produtoCodigo, origem);

            if (res && res.success) {
                totalLojasSucesso++;
                totalGeralProcessados += (res.total_processados || 0);
                totalGeralAtualizados += (res.total_atualizados || 0);
                totalGeralInalterados += (res.total_inalterados || 0);

                log(
                    `✅ ${unitName} finalizada: ${res.total_processados || 0} produtos verificados | ` +
                    `${res.total_atualizados || 0} saldos corrigidos | ${res.total_inalterados || 0} alinhados ` +
                    `(${res.duracao_segundos || 0}s)`,
                    'WorkerRecalcularSaldos'
                );
            } else {
                totalLojasFalha++;
                log(`❌ Falha em ${unitName}: ${res?.message || 'Sem resposta'}`, 'WorkerRecalcularSaldos');
            }
        } catch (err) {
            totalLojasFalha++;
            log(`❌ Erro inesperado ao recalcular loja ${unitName}: ${err.message}`, 'WorkerRecalcularSaldos');
        }
    }

    const fim = DateTime.local();
    const duracaoTotal = fim.diff(inicio, ['minutes', 'seconds']).toObject();
    const minutos = Math.floor(duracaoTotal.minutes || 0);
    const segundos = Math.round(duracaoTotal.seconds || 0);

    log(
        `🏁 WorkerRecalcularSaldos concluído em ${minutos}m ${segundos}s! ` +
        `Lojas: ${totalLojasSucesso} com sucesso, ${totalLojasFalha} com falha | ` +
        `Produtos: ${totalGeralProcessados} total, ${totalGeralAtualizados} atualizados, ${totalGeralInalterados} inalterados.`,
        'WorkerRecalcularSaldos'
    );
}

module.exports = {
    WorkerRecalcularSaldos,
    recalcularUnidade
};

if (require.main === module) {
    WorkerRecalcularSaldos();
}
