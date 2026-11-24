// Vendas pelo MrkSync (etapa 3 da troca da API do Menew pela réplica do PDV): para cada loja com "Fonte das
// vendas" = MrkSync, monta movimento_caixa, sales e api_pagamentos a partir da réplica e grava (mrksync/gravar.js).
// Roda a cada 5 minutos para ontem e hoje (o dia contábil passa da meia-noite). Os jobs da API pulam essas lojas
// (mrksync/fonte.js). A consolidação (_bi_sales, 04:00) e a baixa de estoque (04:30) seguem lendo o sales.
//
// Também avisa quando a réplica de uma loja parou (etapa 5): sem lote há mais de 30 minutos entre 10h e 23h59.
// Plano e regras: docs/mrksync-vendas.md.

require('dotenv').config();
const { getConnection, sendWhatsappText } = require('../utils/utils');
const { log } = require('../utils/logger');
const { montarVendas } = require('../mrksync/transformar');
const { gravarVendas } = require('../mrksync/gravar');
const { lerReplica, diaMais } = require('../mrksync/replica');

const ORIGEM = 'MrkSyncVendas';
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const horaSP = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;

/** Lojas com "Fonte das vendas" = MrkSync e a situação da réplica. Sem a coluna (migration), nenhuma. */
async function lojasMrkSync(conn) {
    try {
        const [rows] = await conn.query(`
            SELECT su.id, su.name AS nome, su.custom_code,
                   MAX(m.ultima_replica_em) AS ultima_replica_em,
                   MAX(m.ultima_replica_em) >= NOW() - INTERVAL 30 MINUTE AS replica_recente
            FROM system_unit su
            LEFT JOIN agentes_maquinas m ON m.system_unit_id = su.id AND m.revogado_em IS NULL
            WHERE su.menew_fonte_vendas = 'mrksync'
            GROUP BY su.id, su.name, su.custom_code`);
        return rows;
    } catch (err) {
        if (err && err.code === 'ER_BAD_FIELD_ERROR') return [];
        throw err;
    }
}

const ultimoAlerta = new Map();
/** Avisa no máximo uma vez por hora por loja (no log e, se configurado, no WhatsApp da equipe). */
async function alertarReplicaParada(loja) {
    const agora = Date.now();
    if (agora - (ultimoAlerta.get(loja.id) || 0) < 3600 * 1000) return false;
    ultimoAlerta.set(loja.id, agora);
    const desde = loja.ultima_replica_em ? new Date(loja.ultima_replica_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'nunca';
    const texto = `⚠️ MrkSync: ${loja.nome} sem enviar vendas desde ${desde}. O faturamento da loja não está atualizando. Confira o computador da loja.`;
    log(texto, ORIGEM);
    const destino = process.env.MRKSYNC_ALERTA_WHATSAPP;
    if (destino) {
        try {
            await sendWhatsappText(destino, texto);
        } catch (err) {
            log(`Falha ao enviar o alerta no WhatsApp: ${err.message}`, ORIGEM);
        }
    }
    return true;
}

/** Monta e grava uma loja em [inicio, fim]. Não apaga nada se a réplica vier vazia e o banco tiver vendas. */
async function processarLoja(conn, loja, inicio, fim) {
    const replica = await lerReplica(conn, loja.id, inicio, fim);
    const sync = montarVendas({ unidade: loja, ...replica });
    if (sync.caixa.length === 0) {
        const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM movimento_caixa WHERE lojaId = ? AND dataContabil BETWEEN ? AND ?', [String(loja.custom_code), inicio, fim]);
        if (Number(n) > 0) {
            log(`⏸️ ${loja.nome}: réplica sem contas de ${inicio} a ${fim}, mas o banco tem ${n}. Nada foi alterado.`, ORIGEM);
            return { pulado: true, motivo: 'replica_vazia', contas_no_banco: Number(n) };
        }
    }
    const r = await gravarVendas(conn, loja, sync, inicio, fim);
    log(`✅ ${loja.nome} ${inicio}${inicio === fim ? '' : ` a ${fim}`}: ${r.caixa} contas, ${r.itens} itens, ${r.pagamentos} pagamentos (removidos: ${r.caixa_removidas} contas, ${r.itens_removidos} itens); ${sync.ignoradas.semNota.length} sem NFC-e`, ORIGEM);
    return { ...r, sem_nota: sync.ignoradas.semNota.length };
}

/** Job: ontem e hoje (ou o período pedido) para as lojas com MrkSync. */
async function ExecuteJobMrkSyncVendas(dtInicio, dtFim) {
    const fim = dtFim || hojeSP();
    const inicio = dtInicio || diaMais(fim, -1);
    const conn = await getConnection();
    const resumo = [];
    try {
        const lojas = await lojasMrkSync(conn);
        if (lojas.length === 0) return resumo;
        const hora = horaSP();
        for (const loja of lojas) {
            if (!loja.custom_code) {
                log(`❌ ${loja.nome}: sem código Menew (custom_code).`, ORIGEM);
                continue;
            }
            if (!Number(loja.replica_recente) && hora >= 10) await alertarReplicaParada(loja);
            try {
                resumo.push({ loja: loja.id, nome: loja.nome, ...(await processarLoja(conn, loja, inicio, fim)) });
            } catch (err) {
                log(`❌ ${loja.nome}: ${err.message}`, ORIGEM);
                resumo.push({ loja: loja.id, nome: loja.nome, erro: err.message });
            }
        }
    } finally {
        conn.end();
    }
    return resumo;
}

module.exports = { ExecuteJobMrkSyncVendas, processarLoja, lojasMrkSync, alertarReplicaParada };

if (require.main === module) {
    const [, , inicio, fim] = process.argv;
    ExecuteJobMrkSyncVendas(inicio, fim)
        .then((r) => {
            console.log(JSON.stringify(r, null, 2));
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
