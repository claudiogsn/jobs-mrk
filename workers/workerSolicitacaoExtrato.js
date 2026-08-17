const path = require('path');
require('dotenv').config({ path: path.resolve('../.env') });
const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const { log } = require('../utils/logger');
const { callTecnoSpeed } = require('../utils/utils'); // <--- Importando nosso wrapper

const API_URL = process.env.TECNOSPEED_API_URL || 'https://api.pagamentobancario.com.br';
const CNPJ_SH = process.env.TECNOSPEED_CNPJ_SH;
const TOKEN_SH = process.env.TECNOSPEED_TOKEN_SH;

async function registrarEvento(conn, systemUnitId, payerId, accountId, status, message, eventType = 'automatic', userId = null) {
    try {
        await conn.execute(`
            INSERT INTO pluggy_extrato_events (system_unit_id, payer_id, account_id, user_id, event_type, status, message)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [systemUnitId, payerId, accountId, userId, eventType, status, message]);
    } catch (e) {
        log(`Erro ao registrar evento: ${e.message}`, 'workerSolicitacao');
    }
}

async function verificarLimiteDiarioConta(conn, accountId) {
    const [rows] = await conn.execute(`
        SELECT COUNT(*) as qtd
        FROM pluggy_extrato_events
        WHERE account_id = ?
          AND DATE(created_at) = CURDATE()
          AND event_type = 'automatic'
    `, [accountId]);
    return rows[0].qtd;
}

// ==========================================
// WORKER 1: SOLICITAÇÃO DE EXTRATOS
// ==========================================
async function ExecuteJobSolicitacao({ system_unit_id, account_id, dt_inicio, dt_fim, user_id } = {}) {
    const isManual = !!system_unit_id || !!dt_inicio;
    const eventType = isManual ? 'manual' : 'automatic';

    // Por padrão na rotina automática, olha os últimos 7 dias até ontem para cobrir eventuais atrasos do banco
    const ontem = DateTime.now().minus({ days: 1 }).toISODate();
    const seteDiasAtras = DateTime.now().minus({ days: 7 }).toISODate();

    let dataStart = dt_inicio || seteDiasAtras;
    let dataEnd = dt_fim || ontem;

    // Validação de intervalo máximo de 30 dias
    if (isManual && dt_inicio && dt_fim) {
        const d1 = DateTime.fromISO(dt_inicio);
        const d2 = DateTime.fromISO(dt_fim);
        const diffDays = Math.abs(d2.diff(d1, 'days').days);
        if (diffDays > 30) {
            log(`⚠️ Intervalo solicitado de ${diffDays} dias excede o limite máximo de 30 dias. Ajustando para 30 dias retroativos.`, 'workerSolicitacao');
            dataStart = d2.minus({ days: 30 }).toISODate();
        }
    }

    log(`🚀 Iniciando Solicitação de Extratos | Período: ${dataStart} a ${dataEnd} | Modo: ${eventType}`, 'workerSolicitacao');

    const dbConfig = {
        host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
        database: process.env.DB_NAME, dateStrings: true
    };

    let conn;
    try { conn = await mysql.createConnection(dbConfig); }
    catch (e) { throw e; }

    try {
        let sqlPayers = `SELECT id, system_unit_id, cpf_cnpj, name FROM pluggy_payers WHERE active = 1 AND statement_actived = 1`;
        const paramsPayers = [];
        if (system_unit_id) { sqlPayers += ` AND system_unit_id = ?`; paramsPayers.push(system_unit_id); }

        const [payers] = await conn.execute(sqlPayers, paramsPayers);

        for (const payer of payers) {
            log(`🏢 Solicitando para Pagador: ${payer.name}`, 'workerSolicitacao');

            const headers = {
                'cnpjsh': CNPJ_SH,
                'tokensh': TOKEN_SH,
                'payercpfcnpj': payer.cpf_cnpj.replace(/\D/g, ''),
                'Content-Type': 'application/json'
            };

            let sqlAccounts = `
                SELECT id, account_hash FROM pluggy_accounts
                WHERE system_unit_id = ? AND payer_id = ? AND active = 1 AND statement_actived = 1
            `;
            const paramsAccounts = [payer.system_unit_id, payer.id];
            if (account_id) {
                sqlAccounts += ` AND id = ?`;
                paramsAccounts.push(account_id);
            }

            const [accounts] = await conn.execute(sqlAccounts, paramsAccounts);

            let sucessoGeral = true;
            let protocolosGerados = 0;

            for (const account of accounts) {
                if (eventType === 'automatic') {
                    const reqHoje = await verificarLimiteDiarioConta(conn, account.id);
                    if (reqHoje >= 3) {
                        await registrarEvento(conn, payer.system_unit_id, payer.id, account.id, 'error', `Limite diário atingido para esta conta.`, eventType, user_id);
                        log(`    🚨 Limite diário atingido para a conta ${account.account_hash}.`, 'workerSolicitacao');
                        continue;
                    }
                }

                try {
                    const payload = {
                        dateStart: dataStart,
                        dateEnd: dataEnd,
                        today: false,
                        accountHash: account.account_hash,
                        statementType: "BANK"
                    };

                    const response = await callTecnoSpeed(payer.system_unit_id, {
                        method: 'POST',
                        url: `${API_URL}/api/v1/statement/openfinance`,
                        data: payload,
                        headers: headers,
                        timeout: 30000
                    });

                    const uniqueId = response.data.uniqueid || response.data.uniqueId;

                    if (!uniqueId) throw new Error('API não retornou o uniqueId.');

                    await conn.execute(`
                        INSERT IGNORE INTO pluggy_statement_imports
                            (system_unit_id, account_id, unique_id, status, date_start, date_end)
                        VALUES (?, ?, ?, 'processing', ?, ?)
                    `, [payer.system_unit_id, account.id, uniqueId, dataStart, dataEnd]);

                    await registrarEvento(conn, payer.system_unit_id, payer.id, account.id, 'success', `Protocolo ${uniqueId} solicitado com sucesso.`, eventType, user_id);

                    protocolosGerados++;
                    log(`    ⏳ Protocolo ${uniqueId} gerado para conta ${account.account_hash}.`, 'workerSolicitacao');

                } catch (error) {
                    sucessoGeral = false;
                    const apiError = error.response?.data?.message || error.message;
                    await registrarEvento(conn, payer.system_unit_id, payer.id, account.id, 'error', `Falha ao solicitar extrato: ${apiError}`, eventType, user_id);
                    log(`    ❌ Erro ao solicitar extrato (${account.account_hash}): ${apiError}`, 'workerSolicitacao');
                }
            }

            if (sucessoGeral && protocolosGerados > 0) {
                await registrarEvento(conn, payer.system_unit_id, payer.id, null, 'success', `Resumo: ${protocolosGerados} contas processadas.`, eventType, user_id);
            }
        }
    } catch (err) {
        log(`🔥 Erro Fatal: ${err.message}`, 'workerSolicitacao');
    } finally {
        if (conn) await conn.end();
    }
}

module.exports = { ExecuteJobSolicitacao };
if (require.main === module) { ExecuteJobSolicitacao(); }