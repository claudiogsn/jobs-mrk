// Comparador do MrkSync (etapa 1 da troca da API do Menew pela réplica do PDV): para cada loja com MrkSync, monta
// as vendas a partir da réplica e compara com o que a API do Menew gravou. Não grava nada nas tabelas de venda;
// guarda o relatório no S3 (mrksync/comparacao/AAAA-MM-DD/<loja>.json). Plano e regras: docs/mrksync-vendas.md.

require('dotenv').config();
const { getConnection } = require('../utils/utils');
const { log } = require('../utils/logger');
const storage = require('../utils/storage');
const { montarVendas } = require('../mrksync/transformar');
const { comparar } = require('../mrksync/comparar');
const { unidadesComMrkSync, unidade, lerReplica, lerApi, diaMais } = require('../mrksync/replica');

const hojeSP = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);

/** Compara uma loja em [inicio, fim]. Devolve o relatório (não grava). */
async function compararUnidade(unitId, inicio, fim, conn) {
    const propria = !conn;
    conn = conn || (await getConnection());
    try {
        const un = await unidade(conn, unitId);
        if (!un) throw new Error(`Loja ${unitId} não encontrada.`);
        if (!un.custom_code) throw new Error(`Loja ${un.nome} sem código Menew (custom_code).`);
        const replica = await lerReplica(conn, un.id, inicio, fim);
        const sync = montarVendas({ unidade: un, ...replica });
        const api = await lerApi(conn, un, inicio, fim);
        const relatorio = comparar(sync, api);
        return {
            loja: { id: un.id, nome: un.nome, codigo: un.custom_code },
            periodo: { inicio, fim },
            gerado_em: new Date().toISOString(),
            contas_sem_nota: sync.ignoradas.semNota.length,
            ...relatorio,
        };
    } finally {
        if (propria) conn.end();
    }
}

/** Job diário: compara o dia anterior (ou o período pedido) em todas as lojas com MrkSync e guarda no S3. */
async function ExecuteJobMrkSyncComparador(dtInicio, dtFim) {
    const fim = dtFim || diaMais(hojeSP(), -1);
    const inicio = dtInicio || fim;
    const conn = await getConnection();
    const resumo = [];
    try {
        const lojas = await unidadesComMrkSync(conn);
        log(`🔎 Comparador MrkSync: ${lojas.length} loja(s), ${inicio} a ${fim}`, 'MrkSync');
        for (const l of lojas) {
            try {
                const rel = await compararUnidade(l.id, inicio, fim, conn);
                const nome = inicio === fim ? inicio : `${inicio}_${fim}`;
                await storage.put(`mrksync/comparacao/${nome}/${l.id}.json`, JSON.stringify(rel, null, 2), 'application/json');
                const c = rel.contagem;
                log(`${rel.igual ? '✅' : '⚠️'} ${l.nome}: contas ${c.contas_iguais}/${c.contas}, produtos ${c.produtos_iguais}/${c.produtos}, pagamentos ${c.pagamentos_iguais}/${c.pagamentos}, notas recriadas ${c.notas_recriadas}`, 'MrkSync');
                resumo.push({ loja: l.id, nome: l.nome, igual: rel.igual, contagem: c });
            } catch (err) {
                log(`❌ ${l.nome}: ${err.message}`, 'MrkSync');
                resumo.push({ loja: l.id, nome: l.nome, erro: err.message });
            }
        }
    } finally {
        conn.end();
    }
    return resumo;
}

module.exports = { compararUnidade, ExecuteJobMrkSyncComparador };

if (require.main === module) {
    const [, , inicio, fim] = process.argv;
    ExecuteJobMrkSyncComparador(inicio, fim)
        .then((r) => {
            console.log(JSON.stringify(r, null, 2));
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
