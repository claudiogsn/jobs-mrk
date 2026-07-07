const mysql = require('mysql2/promise');
const { DateTime } = require('luxon');
const { callPHP } = require('../utils/utils');
const { log } = require('../utils/logger');

async function ExecuteJob3lmEstoque(dt_inicio, dt_fim) {
    const hoje = DateTime.now().toISODate();
    const ontem = DateTime.now().minus({ days: 1 }).toISODate();

    if (!dt_inicio || !dt_fim) {
        dt_inicio = ontem;
        dt_fim = hoje;
    }

    let start = DateTime.fromISO(dt_inicio);
    let end = DateTime.fromISO(dt_fim);
    if (end < start) [start, end] = [end, start];

    log(`⏱️ Iniciando processamento de estoque 3LM de ${dt_inicio} até ${dt_fim}`, 'worker3lmEstoque');

    // 1. Busca todas as unidades com 3lm_integration_estoque ativo
    const dbConfig = {
        host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
        database: process.env.DB_NAME, dateStrings: true
    };

    let conn;
    let unidades = [];
    try {
        conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute(
            "SELECT id AS system_unit_id, name, custom_code FROM system_unit WHERE 3lm_integration_estoque = '1'"
        );
        unidades = rows;
    } catch (err) {
        log(`❌ Erro ao conectar ao banco de dados: ${err.message}`, 'worker3lmEstoque');
        return;
    } finally {
        if (conn) await conn.end();
    }

    if (unidades.length === 0) {
        log('⚠️ Nenhuma unidade encontrada com integração de estoque 3LM ativa.', 'worker3lmEstoque');
        return;
    }

    log(`🔎 Encontradas ${unidades.length} unidades para processamento 3LM.`, 'worker3lmEstoque');

    for (const unidade of unidades) {
        const system_unit_id = unidade.system_unit_id;
        log(`🔄 Processando estoque 3LM para unidade ${system_unit_id} (${unidade.name})`, 'worker3lmEstoque');

        for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
            const data = cursor.toFormat('yyyy-MM-dd');
            try {
                const inicio = Date.now();
                log(`  📅 Executando importMovBySalesCons para data ${data}`, 'worker3lmEstoque');
                
                const result = await callPHP('importMovBySalesCons', { system_unit_id, data });
                const sucesso = result?.success === true || result?.status === 'success' || (typeof result === 'string' && result.includes('sucesso')) || (result?.message && result.message.includes('sucesso'));

                if (!sucesso) {
                    log(`  ❌ Falha no processamento: ${JSON.stringify(result)}`, 'worker3lmEstoque');
                    continue;
                }

                const final = Date.now();
                await callPHP('registerJobExecution', {
                    nome_job: 'estoque-3lm-js',
                    system_unit_id: system_unit_id,
                    custom_code: unidade.custom_code,
                    inicio: DateTime.fromMillis(inicio).toFormat('yyyy-MM-dd HH:mm:ss'),
                    final: DateTime.fromMillis(final).toFormat('yyyy-MM-dd HH:mm:ss')
                });

                log(`  ✅ Data ${data} processada com sucesso.`, 'worker3lmEstoque');
            } catch (err) {
                log(`  ❌ Erro ao processar data ${data}: ${err.message}`, 'worker3lmEstoque');
            }
        }
    }

    log(`🏁 Processamento de estoque 3LM concluído.`, 'worker3lmEstoque');
}

module.exports = { ExecuteJob3lmEstoque };
