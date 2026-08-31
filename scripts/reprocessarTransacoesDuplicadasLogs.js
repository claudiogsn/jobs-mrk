const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const CHUNK_SIZE = 500;

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

async function reprocessarTransacoesDuplicadas() {
    console.log('=====================================================');
    console.log('🔄 INICIANDO REPROCESSAMENTO DE TRANSAÇÕES DOS LOGS');
    console.log('=====================================================');

    const dbConfig = {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        dateStrings: true
    };

    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
    } catch (e) {
        console.error('❌ Erro de conexão com o banco de dados:', e.message);
        process.exit(1);
    }

    try {
        // 1. Carrega todas as contas cadastradas para mapear account_hash -> account_id
        const [accounts] = await conn.execute(`
            SELECT id, system_unit_id, account_hash 
            FROM pluggy_accounts
        `);
        const accountMap = new Map(); // key: `${system_unit_id}_${account_hash}` -> account_id
        const unitAccountsMap = new Map(); // key: system_unit_id -> array de accounts

        for (const acc of accounts) {
            accountMap.set(`${acc.system_unit_id}_${acc.account_hash}`, acc.id);
            if (!unitAccountsMap.has(acc.system_unit_id)) {
                unitAccountsMap.set(acc.system_unit_id, []);
            }
            unitAccountsMap.get(acc.system_unit_id).push(acc.id);
        }
        console.log(`✅ Contas carregadas: ${accounts.length}`);

        // 2. Carrega IDs das transações já existentes no banco para contagem
        const [existingRows] = await conn.execute(`
            SELECT pluggy_transaction_id FROM pluggy_transactions
        `);
        const existingTxSet = new Set(existingRows.map(r => r.pluggy_transaction_id));
        console.log(`✅ Transações já existentes no banco: ${existingTxSet.size}`);

        // 3. Busca logs de integração com transactionDuplicated
        const [logs] = await conn.execute(`
            SELECT id, system_unit_id, response_body, created_at 
            FROM pluggy_integration_logs 
            WHERE response_body LIKE '%transactionDuplicated%' 
              AND http_code = 200 
            ORDER BY id ASC
        `);
        console.log(`✅ Logs para analisar: ${logs.length}`);

        const transactionsToInsert = [];
        const seenInBatch = new Set();
        let totalEncontradasNoLog = 0;
        let totalNovasParaInserir = 0;
        let logsComTransacoes = 0;

        for (const logItem of logs) {
            try {
                const data = JSON.parse(logItem.response_body);
                const accountHash = data.statement?.accountHash;
                const unitId = logItem.system_unit_id;

                // Resolve account_id
                let accountId = null;
                if (accountHash) {
                    accountId = accountMap.get(`${unitId}_${accountHash}`);
                }
                // Fallback: se a unidade só tiver 1 conta
                if (!accountId && unitAccountsMap.has(unitId) && unitAccountsMap.get(unitId).length === 1) {
                    accountId = unitAccountsMap.get(unitId)[0];
                }

                if (!accountId) {
                    // Não foi possível associar a uma conta válida
                    continue;
                }

                const creditosDup = (data.transactionDuplicated?.credit || []).map(t => ({ ...t, type: t.transactionType || 'credit' }));
                const debitosDup  = (data.transactionDuplicated?.debit || []).map(t => ({ ...t, type: t.transactionType || 'debit' }));
                const todasDup    = [...creditosDup, ...debitosDup];

                if (todasDup.length > 0) {
                    logsComTransacoes++;
                }

                for (const tx of todasDup) {
                    const txId = tx.transactionId;
                    if (!txId) continue;

                    totalEncontradasNoLog++;

                    if (seenInBatch.has(txId)) {
                        continue;
                    }
                    seenInBatch.add(txId);

                    const isNew = !existingTxSet.has(txId);
                    if (isNew) {
                        totalNovasParaInserir++;
                    }

                    transactionsToInsert.push([
                        unitId,
                        accountId,
                        txId,
                        tx.type || 'credit',
                        tx.description || 'Movimentação',
                        tx.amount || 0,
                        tx.date,
                        JSON.stringify(tx)
                    ]);
                }
            } catch (jsonErr) {
                // Log truncado ou erro de parse ignorado
            }
        }

        console.log('\n--- RESUMO DA EXTRAÇÃO ---');
        console.log(`📊 Total de transações duplicadas encontradas nos logs: ${totalEncontradasNoLog}`);
        console.log(`📊 Transações únicas consolidadas: ${transactionsToInsert.length}`);
        console.log(`🆕 Transações NOVAS que não existiam no BD: ${totalNovasParaInserir}`);

        // 4. Executa o upsert no banco
        if (transactionsToInsert.length > 0) {
            const sql = `
                INSERT INTO pluggy_transactions (
                    system_unit_id, account_id, pluggy_transaction_id, type, description, amount, date, raw_data
                ) VALUES ?
                ON DUPLICATE KEY UPDATE
                    type = VALUES(type),
                    description = VALUES(description),
                    amount = VALUES(amount),
                    date = VALUES(date),
                    raw_data = VALUES(raw_data)
            `;

            for (const chunk of chunkArray(transactionsToInsert, CHUNK_SIZE)) {
                await conn.query(sql, [chunk]);
            }

            console.log(`\n🎉 SUCESSO! ${transactionsToInsert.length} transações salvas/atualizadas no banco com segurança.`);
        } else {
            console.log('\nℹ️ Nenhuma transação pendente para inserir.');
        }

    } catch (err) {
        console.error('🔥 Erro ao reprocessar:', err);
    } finally {
        if (conn) await conn.end();
        console.log('=====================================================');
    }
}

if (require.main === module) {
    reprocessarTransacoesDuplicadas();
}

module.exports = { reprocessarTransacoesDuplicadas };
