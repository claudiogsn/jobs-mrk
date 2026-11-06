require('dotenv').config();
const axios = require('axios');
const { DateTime } = require('luxon');
const { getConnection } = require('../utils/utils');
const { ProcessStoreSaipos, ProcessJobSaiposAll } = require('../workers/workerSaiposSync');

const DEFAULT_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJrZXkiOiIwYzZjZmUyMC1jNWViLTc1M2QtMjJlYy04OGIyYTg2OTA4YWQiLCJpYXQiOjE3OTMzODcxNzh9.kFyAXbS12s9pjVirc9wJs4RPHK09ba6OaEjgGjlrySE';

async function main() {
    const args = process.argv.slice(2);
    const comando = args[0] || 'info';

    console.log('🍔 [Saipos Tool] Iniciando ferramenta de teste da integração Saipos...');

    if (comando === 'test-api') {
        const token = args[1] || DEFAULT_TOKEN;
        const hoje = DateTime.now().toISODate();
        console.log(`📡 Testando chamada direta à Saipos Data API com o token informado para ${hoje}...`);

        try {
            const resp = await axios.get('https://data.saipos.io/v1/search_sales', {
                params: {
                    p_date_column_filter: 'shift_date',
                    p_filter_date_start: `${hoje} 00:00:00`,
                    p_filter_date_end: `${hoje} 23:59:59`,
                    p_limit: 5
                },
                headers: {
                    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
                    Accept: 'application/json'
                },
                timeout: 15000
            });
            console.log('✅ Sucesso na chamada!', resp.status, `Registros retornados: ${resp.data?.length || 0}`);
            if (resp.data && resp.data.length > 0) {
                console.log('Primeira venda:', JSON.stringify(resp.data[0], null, 2));
            }
        } catch (err) {
            console.error('❌ Erro na chamada da API:', err.response?.status, err.response?.data || err.message);
        }
        return;
    }

    if (comando === 'cadastrar-loja') {
        const systemUnitId = parseInt(args[1] || '336', 10);
        const storeName = args[2] || 'Hamburguerio';
        const token = args[3] || DEFAULT_TOKEN;

        console.log(`💾 Registrando loja #${systemUnitId} (${storeName}) na tabela unit_integracoes...`);

        const conn = await getConnection();
        try {
            const config = JSON.stringify({
                token: token.trim(),
                store_id: '336',
                store_name: storeName,
                faturamento: 1,
                estoque: 1
            });

            await conn.execute(`
                INSERT INTO unit_integracoes (system_unit_id, provider, ativo, status, config, created_at, updated_at)
                VALUES (?, 'saipos', 1, 'CONFIGURADA', ?, NOW(), NOW())
                ON DUPLICATE KEY UPDATE
                    ativo = 1,
                    status = 'CONFIGURADA',
                    config = VALUES(config),
                    updated_at = NOW()
            `, [systemUnitId, config]);

            console.log(`✅ Loja #${systemUnitId} configurada com sucesso em unit_integracoes.`);
        } finally {
            await conn.end();
        }
        return;
    }

    if (comando === 'sync-store') {
        const systemUnitId = parseInt(args[1] || '336', 10);
        const dtInicio = args[2] || DateTime.now().minus({ days: 1 }).toISODate();
        const dtFim = args[3] || dtInicio;

        console.log(`🚀 Executando sincronização para loja #${systemUnitId} (${dtInicio} a ${dtFim})...`);
        const conn = await getConnection();
        try {
            const res = await ProcessStoreSaipos(conn, systemUnitId, dtInicio, dtFim);
            console.log('✅ Resultado da sincronização:', res);
        } finally {
            await conn.end();
        }
        return;
    }

    if (comando === 'sync-all') {
        const dtInicio = args[1] || DateTime.now().minus({ days: 1 }).toISODate();
        const dtFim = args[2] || dtInicio;

        console.log(`🚀 Executando varredura geral Saipos (${dtInicio} a ${dtFim})...`);
        const res = await ProcessJobSaiposAll(dtInicio, dtFim);
        console.log('✅ Resultado da varredura:', res);
        return;
    }

    console.log(`
Uso do script:
  node testSaiposSync.js test-api [token]
  node testSaiposSync.js cadastrar-loja [system_unit_id] [store_name] [token]
  node testSaiposSync.js sync-store [system_unit_id] [data_inicio] [data_fim]
  node testSaiposSync.js sync-all [data_inicio] [data_fim]
    `);
}

main().catch(e => {
    console.error('Erro fatal:', e);
    process.exit(1);
});
