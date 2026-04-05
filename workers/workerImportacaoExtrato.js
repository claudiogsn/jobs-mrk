const path = require('path');
require('dotenv').config({ path: path.resolve('../.env') });
const mysql = require('mysql2/promise');
const { log } = require('../utils/logger');
const { callTecnoSpeed } = require('../utils/utils'); // <--- Importando nosso wrapper

const CHUNK_SIZE = 500;
const API_URL = process.env.TECNOSPEED_API_URL || 'https://api.pagamentobancario.com.br';
const CNPJ_SH = process.env.TECNOSPEED_CNPJ_SH;
const TOKEN_SH = process.env.TECNOSPEED_TOKEN_SH;

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) { result.push(array.slice(i, i + size)); }
    return result;
}

async function salvarTransacoes(conn, transactions, systemUnitId, accountId) {
    if (!transactions || transactions.length === 0) return 0;

    const rows = [];
    for (const tx of transactions) {
        // CORREÇÃO AQUI: Pegando os nomes exatos que vêm no JSON da Tecnospeed
        const transactionId = tx.transactionId;
        const tipoTransacao = tx.transactionType || tx.type || 'credit';

        // Se por algum motivo a API não mandar o ID, a gente pula para não quebrar o UNIQUE
        if (!transactionId) continue;

        rows.push([
            systemUnitId,
            accountId,
            transactionId,
            tipoTransacao,
            tx.description || 'Movimentação',
            tx.amount || 0,
            tx.date,
            JSON.stringify(tx)
        ]);
    }

    if (rows.length > 0) {
        const sql = `
            INSERT IGNORE INTO pluggy_transactions (
                system_unit_id, account_id, pluggy_transaction_id, type, description, amount, date, raw_data
            ) VALUES ?
        `;

        for (const chunk of chunkArray(rows, CHUNK_SIZE)) {
            await conn.query(sql, [chunk]);
        }
    }

    return rows.length;
}

// ==========================================
// WORKER 2: IMPORTAÇÃO E PROCESSAMENTO
// ==========================================
async function ExecuteJobImportacao() {
    log(`📥 Iniciando Verificação de Protocolos Pendentes...`, 'workerImportacao');

    const dbConfig = {
        host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
        database: process.env.DB_NAME, dateStrings: true
    };

    let conn;
    try { conn = await mysql.createConnection(dbConfig); }
    catch (e) { throw e; }

    try {
        const [imports] = await conn.execute(`
            SELECT
                psi.id, psi.unique_id, psi.system_unit_id, psi.account_id,
                p.cpf_cnpj
            FROM pluggy_statement_imports psi
                     JOIN pluggy_accounts a ON a.id = psi.account_id
                     JOIN pluggy_payers p ON p.id = a.payer_id
            WHERE psi.status = 'processing'
        `);

        if (imports.length === 0) {
            log('💤 Nenhum protocolo pendente de processamento.', 'workerImportacao');
            return;
        }

        for (const importTask of imports) {
            log(`  🔍 Consultando protocolo: ${importTask.unique_id}`, 'workerImportacao');

            const headers = {
                'cnpjsh': CNPJ_SH,
                'tokensh': TOKEN_SH,
                'payercpfcnpj': importTask.cpf_cnpj.replace(/\D/g, ''),
                'Content-Type': 'application/json'
            };

            try {
                // 🚨 AQUI: Trocando axios.get pelo nosso Wrapper para gravar o Log
                const response = await callTecnoSpeed(importTask.system_unit_id, {
                    method: 'GET',
                    url: `${API_URL}/api/v1/statement/openfinance/${importTask.unique_id}`,
                    headers: headers,
                    timeout: 45000
                });

                const statusApi = response.data.statement?.status || 'ERROR';

                if (statusApi === 'SUCCESS') {
                    const creditos = (response.data.transaction?.credit || []).map(t => ({ ...t, type: 'credit' }));
                    const debitos = (response.data.transaction?.debit || []).map(t => ({ ...t, type: 'debit' }));
                    const transacoes = [...creditos, ...debitos];

                    const savedQtd = await salvarTransacoes(conn, transacoes, importTask.system_unit_id, importTask.account_id);

                    await conn.execute(`
                        UPDATE pluggy_statement_imports
                        SET status = 'done', total_transactions = ?
                        WHERE id = ?
                    `, [savedQtd, importTask.id]);

                    log(`    ✅ Sucesso! Protocolo ${importTask.unique_id} finalizado com ${savedQtd} transações.`, 'workerImportacao');

                } else if (statusApi === 'ERROR' || statusApi === 'FAILED') {
                    await conn.execute(`UPDATE pluggy_statement_imports SET status = 'error' WHERE id = ?`, [importTask.id]);
                    log(`    ❌ Banco retornou erro no protocolo ${importTask.unique_id}.`, 'workerImportacao');
                } else {
                    log(`    ⏳ Protocolo ${importTask.unique_id} ainda em processamento pelo banco.`, 'workerImportacao');
                }

            } catch (error) {
                const apiError = error.response?.data?.message || error.message;
                log(`    ❌ Falha HTTP ao consultar protocolo ${importTask.unique_id}: ${apiError}`, 'workerImportacao');
            }
        }
    } catch (err) {
        log(`🔥 Erro Fatal: ${err.message}`, 'workerImportacao');
    } finally {
        if (conn) await conn.end();
    }
}

module.exports = { ExecuteJobImportacao };
if (require.main === module) { ExecuteJobImportacao(); }