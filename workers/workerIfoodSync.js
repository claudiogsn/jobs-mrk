require('dotenv').config();

const { log } = require('../utils/logger');
const { appendApiLog } = require('../utils/apiLogger');
const { getConnection } = require('../utils/utils');
const { DateTime } = require('luxon');
const axios = require('axios');
const crypto = require('crypto');

function workerIfoodLog(label, data) {
    appendApiLog('ifood', `[workerIfoodSync] ${label}\n${JSON.stringify(data, null, 2)}`);
}

async function ifoodAxios(config) {
    const { url, method = 'GET', headers, params, data: body } = config;
    workerIfoodLog(`➡️  ${method} ${url}`, { params, body: body ?? undefined });
    try {
        const resp = await axios({ method, url, headers, params, data: body });
        workerIfoodLog(`✅  ${method} ${url} → ${resp.status}`, {
            headers: resp.headers,
            data: resp.data,
        });
        return resp;
    } catch (err) {
        workerIfoodLog(`❌  ${method} ${url} → ${err.response?.status ?? err.message}`, {
            responseHeaders: err.response?.headers,
            responseData: err.response?.data,
            message: err.message,
        });
        throw err;
    }
}

const IFOOD_BASE_URL = 'https://merchant-api.ifood.com.br';
const JANELA_DIAS = parseInt(process.env.IFOOD_JANELA_DIAS) || 32;
const TOLERANCIA = 0.01;

// ============================================================
// TOKEN
// ============================================================

async function getAccessToken(conn, credencial) {
    const agora = Date.now();
    const expira = credencial.access_token_expira_em
        ? new Date(credencial.access_token_expira_em).getTime()
        : 0;

    if (credencial.access_token && expira - 5 * 60 * 1000 > agora) {
        return credencial.access_token;
    }

    if (!credencial.refresh_token) {
        throw new Error(`Sem refresh_token para merchant ${credencial.merchant_id}`);
    }

    const params = new URLSearchParams({
        grantType: 'refresh_token',
        clientId: process.env.IFOOD_CLIENT_ID,
        clientSecret: process.env.IFOOD_CLIENT_SECRET,
        refreshToken: credencial.refresh_token,
    });

    let resp;
    try {
        resp = await ifoodAxios({
            method: 'POST',
            url: `${IFOOD_BASE_URL}/authentication/v1.0/oauth/token`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: params.toString(),
        });
    } catch (err) {
        if (err.response?.status === 401) {
            throw new Error(`refresh_token revogado para merchant ${credencial.merchant_id}`);
        }
        throw err;
    }

    const dados = resp.data;
    const novoAccess = dados.accessToken;
    const novoRefresh = dados.refreshToken || credencial.refresh_token;
    const expiraEm = DateTime.now()
        .plus({ seconds: dados.expiresIn || 21600 })
        .toFormat('yyyy-MM-dd HH:mm:ss');

    await conn.execute(
        `UPDATE ifood_credenciais
            SET access_token = ?, access_token_expira_em = ?,
                refresh_token = ?, status = 'CONECTADA', ultimo_erro = NULL
          WHERE id = ?`,
        [novoAccess, expiraEm, novoRefresh, credencial.id]
    );

    credencial.access_token = novoAccess;
    credencial.access_token_expira_em = expiraEm;
    credencial.refresh_token = novoRefresh;
    return novoAccess;
}

function montarHeaders(token) {
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (process.env.IFOOD_AMBIENTE === 'TESTE') h['x-request-homologation'] = 'true';
    return h;
}

// ============================================================
// CHAMADAS À API
// ============================================================

async function fetchFinancialEvents(credencial, token, beginDate, endDate) {
    const todos = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
        const resp = await ifoodAxios({
            url: `${IFOOD_BASE_URL}/financial/v3.0/merchants/${credencial.merchant_id}/financialEvents`,
            headers: montarHeaders(token),
            params: { beginDate, endDate, page, size: 100 },
        });
        (resp.data.financialEvents || []).forEach(e => todos.push(e));
        hasNext = resp.data.hasNextPage === true;
        page++;
    }
    return todos;
}

async function fetchSales(credencial, token, beginDate, endDate) {
    const todas = [];
    let page = 1;
    let pageCount = 1;

    do {
        const resp = await ifoodAxios({
            url: `${IFOOD_BASE_URL}/financial/v3.0/merchants/${credencial.merchant_id}/sales`,
            headers: montarHeaders(token),
            params: { beginSalesDate: beginDate, endSalesDate: endDate, page },
        });
        (resp.data.sales || []).forEach(s => todas.push(s));
        pageCount = resp.data.pageCount || 1;
        page++;
    } while (page <= pageCount);

    return todas;
}

async function fetchSettlements(credencial, token, beginDate, endDate) {
    const resp = await ifoodAxios({
        url: `${IFOOD_BASE_URL}/financial/v3.0/merchants/${credencial.merchant_id}/settlements`,
        headers: montarHeaders(token),
        params: { beginDate, endDate },
    });
    return resp.data.settlements || resp.data.settlement || [];
}

// ============================================================
// HASH (idempotência)
// ============================================================

function hashFinancialEvent(merchantId, ev) {
    const ref = ev.reference || {};
    const chave = [
        merchantId, ev.name || '', ev.description || '', ev.trigger || '',
        ref.type || '', ref.id || '', ref.date || '', ev.competence || '',
        ev.period?.beginDate || '', ev.period?.endDate || '',
        ev.amount?.value || '', ev.billing?.baseValue || '',
    ].join('|');
    return crypto.createHash('sha256').update(chave).digest('hex');
}

function hashSale(merchantId, sale) {
    const chave = [merchantId, 'SALE', sale.id || '', sale.currentStatus || '',
        sale.billingSummary?.saleBalance || ''].join('|');
    return crypto.createHash('sha256').update(chave).digest('hex');
}

function hashSettlement(merchantId, st) {
    const chave = [merchantId, 'SETTLEMENT',
        st.id || st.settlementId || '',
        st.expectedDate || st.calculationDate || '',
        st.amount || st.transferAmount || ''].join('|');
    return crypto.createHash('sha256').update(chave).digest('hex');
}

// ============================================================
// NORMALIZAÇÃO
// ============================================================

function categorizarEvento(nome, trigger) {
    const n = (nome || '').toUpperCase();
    const t = (trigger || '').toUpperCase();
    if (n === 'ORDER_PAYMENT') return 'VENDA';
    if (n === 'ORDER_COMMISSION') return 'COMISSAO';
    if (n.includes('FEE')) return 'TAXA';
    if (n === 'STORE_REFUND' || n.includes('REFUND')) return 'RESSARCIMENTO';
    if (n.includes('SUBSIDY')) return 'SUBSIDIO';
    if (n === 'ANTICIPATION_FEE') return 'ANTECIPACAO';
    if (t.includes('CANCEL') || t === 'NO_CONCLUDED_STATUS') return 'CANCELAMENTO';
    if (t === 'MANUAL_REBILLING') return 'AJUSTE';
    return 'OUTRO';
}

function normalizarFinancialEvent(merchantId, ev) {
    const ref = ev.reference || {};
    const amount = ev.amount || {};
    const billing = ev.billing || {};
    const settlement = ev.settlement || {};
    const payment = ev.payment || {};
    return {
        merchant_id: merchantId,
        order_id: ref.type === 'ORDER' ? ref.id : null,
        nome_evento: ev.name || 'DESCONHECIDO',
        descricao_evento: ev.description || null,
        gatilho: ev.trigger || null,
        categoria: categorizarEvento(ev.name, ev.trigger),
        valor: parseFloat(amount.value || '0'),
        base_calculo: billing.baseValue != null ? parseFloat(billing.baseValue) : null,
        percentual: billing.feePercentage != null ? parseFloat(billing.feePercentage) : null,
        impacta_repasse: ev.hasTransferImpact === true ? 1 : 0,
        competencia: ev.competence || null,
        data_evento: ref.date ? ref.date.slice(0, 19).replace('T', ' ') : null,
        data_pagamento_prev: settlement.expectedDate || null,
        metodo_pagamento: payment.method || null,
        bandeira: payment.brand || null,
        recebedor: payment.liability || null,
    };
}

// ============================================================
// BANCO DE DADOS
// ============================================================

function semanasEntre(beginDate, endDate) {
    const out = [];
    const cursor = new Date(beginDate + 'T00:00:00Z');
    const diaSemana = (cursor.getUTCDay() + 6) % 7;
    cursor.setUTCDate(cursor.getUTCDate() - diaSemana);
    const fimJanela = new Date(endDate + 'T00:00:00Z');
    while (cursor <= fimJanela) {
        const ini = new Date(cursor);
        const fim = new Date(cursor);
        fim.setUTCDate(fim.getUTCDate() + 6);
        out.push({ inicio: ini.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) });
        cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return out;
}

async function garantirCompetencias(conn, credencial, beginDate, endDate) {
    for (const s of semanasEntre(beginDate, endDate)) {
        await conn.execute(
            `INSERT INTO ifood_competencia (credencial_id, merchant_id, periodo_inicio, periodo_fim, competencia)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
            [credencial.id, credencial.merchant_id, s.inicio, s.fim, s.inicio.slice(0, 7)]
        );
    }
}

async function upsertRaw(conn, r) {
    let competenciaId = null;
    if (r.periodoInicio) {
        const [c] = await conn.execute(
            `SELECT id FROM ifood_competencia
              WHERE merchant_id = ? AND periodo_inicio <= ? AND periodo_fim >= ? LIMIT 1`,
            [r.merchantId, r.periodoInicio, r.periodoInicio]
        );
        if (c.length) competenciaId = c[0].id;
    }
    await conn.execute(
        `INSERT INTO ifood_fin_raw
           (merchant_id, competencia_id, api_origem, event_hash, order_id,
            competencia, periodo_inicio, periodo_fim, payload, processado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 0)
         ON DUPLICATE KEY UPDATE
            payload = VALUES(payload), competencia_id = VALUES(competencia_id),
            processado = 0, erro_processo = NULL, updated_at = CURRENT_TIMESTAMP`,
        [r.merchantId, competenciaId, r.apiOrigem, r.hash, r.orderId,
         r.competencia, r.periodoInicio || null, r.periodoFim || null,
         JSON.stringify(r.payload)]
    );
}

async function resolverCompetencia(conn, merchantId, dataInicio) {
    if (!dataInicio) return null;
    const [c] = await conn.execute(
        `SELECT id FROM ifood_competencia
          WHERE merchant_id = ? AND periodo_inicio <= ? AND periodo_fim >= ? LIMIT 1`,
        [merchantId, dataInicio, dataInicio]
    );
    return c.length ? c[0].id : null;
}

async function recalcularPedidos(conn, credencialId, merchantId) {
    const [pedidos] = await conn.execute(
        `SELECT order_id,
                SUM(CASE WHEN impacta_repasse = 1 THEN valor ELSE 0 END) AS liquido,
                SUM(CASE WHEN categoria = 'TAXA' THEN valor ELSE 0 END)     AS taxas,
                SUM(CASE WHEN categoria = 'COMISSAO' THEN valor ELSE 0 END) AS comissao,
                COUNT(*) AS qtd,
                MIN(data_evento) AS data_pedido
           FROM ifood_lancamento
          WHERE merchant_id = ? AND order_id IS NOT NULL
          GROUP BY order_id`,
        [merchantId]
    );

    for (const p of pedidos) {
        const [vendaRaw] = await conn.execute(
            `SELECT payload FROM ifood_fin_raw
              WHERE merchant_id = ? AND api_origem = 'SALES' AND order_id = ? LIMIT 1`,
            [merchantId, p.order_id]
        );
        let statusVenda = null, valorBruto = null, shortId = null;
        let salePayload = null;
        if (vendaRaw.length) {
            const s = typeof vendaRaw[0].payload === 'string'
                ? JSON.parse(vendaRaw[0].payload) : vendaRaw[0].payload;
            salePayload  = s;
            statusVenda  = s.currentStatus || null;
            shortId      = s.shortId || null;
            if (s.saleGrossValue) {
                valorBruto = (s.saleGrossValue.bag || 0)
                    + (s.saleGrossValue.deliveryFee || 0)
                    + (s.saleGrossValue.serviceFee || 0);
            }
        }
        const statusConc = statusVenda && statusVenda !== 'CONCLUDED' ? 'PENDENTE_MATCH' : 'CONCILIADO';
        await conn.execute(
            `INSERT INTO ifood_pedido_conciliado
               (credencial_id, merchant_id, order_id, order_short_id, data_pedido,
                status_venda, valor_bruto, valor_liquido, total_taxas,
                total_comissao, status_conciliacao, qtd_lancamentos)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                data_pedido = VALUES(data_pedido), status_venda = VALUES(status_venda),
                valor_bruto = VALUES(valor_bruto), valor_liquido = VALUES(valor_liquido),
                total_taxas = VALUES(total_taxas), total_comissao = VALUES(total_comissao),
                status_conciliacao = VALUES(status_conciliacao),
                qtd_lancamentos = VALUES(qtd_lancamentos), updated_at = CURRENT_TIMESTAMP`,
            [credencialId, merchantId, p.order_id, shortId, p.data_pedido,
             statusVenda, valorBruto, p.liquido, p.taxas, p.comissao, statusConc, p.qtd]
        );

        // Popula os pagamentos do pedido extraídos do payload Sales
        if (salePayload) {
            await sincronizarPagamentosPedido(conn, merchantId, p.order_id, shortId, p.data_pedido, statusVenda, valorBruto, salePayload);
        }
    }
}

async function sincronizarPagamentosPedido(conn, merchantId, orderId, shortId, dataPedido, statusVenda, valorBruto, sale) {
    // Remove os pagamentos anteriores do pedido e reinserida (idempotente)
    await conn.execute(
        `DELETE FROM ifood_pedido_pagamentos WHERE merchant_id = ? AND order_id = ?`,
        [merchantId, orderId]
    );

    const pagamentos = Array.isArray(sale.payments) ? sale.payments
        : Array.isArray(sale.payments?.methods) ? sale.payments.methods
        : Array.isArray(sale.payment) ? sale.payment
        : [];
    if (!pagamentos.length) {
        // Sem array payments — insere uma linha com o total bruto como fallback
        await conn.execute(
            `INSERT INTO ifood_pedido_pagamentos
               (merchant_id, order_id, order_short_id, metodo, bandeira, valor, data_pedido, status_venda, valor_bruto)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [merchantId, orderId, shortId, null, null, valorBruto || 0, dataPedido, statusVenda, valorBruto]
        );
        return;
    }

    for (const pg of pagamentos) {
        const metodo   = pg.method  || pg.tipo    || pg.paymentType || null;
        const bandeira = pg.brand   || pg.bandeira || null;
        const valor    = parseFloat(pg.value   || pg.valor   || pg.amount || 0);
        const troco    = pg.change  != null ? parseFloat(pg.change)  : null;
        const parcelas = pg.installments || null;

        await conn.execute(
            `INSERT INTO ifood_pedido_pagamentos
               (merchant_id, order_id, order_short_id, metodo, bandeira, valor, troco, parcelas,
                data_pedido, status_venda, valor_bruto)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [merchantId, orderId, shortId, metodo, bandeira, valor, troco, parcelas,
             dataPedido, statusVenda, valorBruto]
        );
    }
}

async function upsertPedido(conn, merchantId, credencialId, sale) {
    const orderId = sale.id;
    if (!orderId) return;

    const dataPedido = sale.createdAt ? sale.createdAt.slice(0, 19).replace('T', ' ') : null;
    const dataDate   = dataPedido ? dataPedido.slice(0, 10) : null;

    let competenciaId = null;
    if (dataDate) {
        const [c] = await conn.execute(
            `SELECT id FROM ifood_competencia
              WHERE merchant_id = ? AND periodo_inicio <= ? AND periodo_fim >= ? LIMIT 1`,
            [merchantId, dataDate, dataDate]
        );
        if (c.length) competenciaId = c[0].id;
    }

    const gross        = sale.saleGrossValue || {};
    const bag          = gross.bag          != null ? parseFloat(gross.bag)          : null;
    const deliveryFee  = gross.deliveryFee  != null ? parseFloat(gross.deliveryFee)  : null;
    const serviceFee   = gross.serviceFee   != null ? parseFloat(gross.serviceFee)   : null;
    const valorBruto   = (bag != null || deliveryFee != null || serviceFee != null)
        ? (bag || 0) + (deliveryFee || 0) + (serviceFee || 0) : null;
    const valorLiquido   = sale.billingSummary?.saleBalance != null
        ? parseFloat(sale.billingSummary.saleBalance) : null;
    const valorBeneficios = sale.benefits?.totalValue != null
        ? parseFloat(sale.benefits.totalValue) : null;

    await conn.execute(
        `INSERT INTO ifood_pedidos
           (merchant_id, credencial_id, competencia_id, order_id, order_short_id,
            status, tipo, categoria, canal, tipo_entrega, provedor_logistica,
            data_pedido, valor_bag, valor_entrega, valor_servico, valor_bruto,
            valor_beneficios, valor_liquido)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            status             = VALUES(status),
            competencia_id     = COALESCE(VALUES(competencia_id), competencia_id),
            valor_bag          = VALUES(valor_bag),
            valor_entrega      = VALUES(valor_entrega),
            valor_servico      = VALUES(valor_servico),
            valor_bruto        = VALUES(valor_bruto),
            valor_beneficios   = VALUES(valor_beneficios),
            valor_liquido      = VALUES(valor_liquido),
            tipo_entrega       = VALUES(tipo_entrega),
            provedor_logistica = VALUES(provedor_logistica),
            updated_at         = CURRENT_TIMESTAMP`,
        [merchantId, credencialId, competenciaId, orderId, sale.shortId || null,
         sale.currentStatus || null, sale.type || null, sale.category || null,
         sale.salesChannel || null,
         sale.delivery?.type || null,
         sale.delivery?.deliveryParameters?.logisticProvider || null,
         dataPedido, bag, deliveryFee, serviceFee, valorBruto,
         valorBeneficios, valorLiquido]
    );
}

async function sincronizarPagamentosDeTodasSales(conn, merchantId) {
    const [rows] = await conn.execute(
        `SELECT order_id, payload FROM ifood_fin_raw WHERE merchant_id = ? AND api_origem = 'SALES'`,
        [merchantId]
    );
    for (const row of rows) {
        const sale = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const orderId = row.order_id;
        if (!orderId) continue;
        const shortId = sale.shortId || null;
        const dataPedido = sale.createdAt ? sale.createdAt.slice(0, 19).replace('T', ' ') : null;
        const statusVenda = sale.currentStatus || null;
        let valorBruto = null;
        if (sale.saleGrossValue) {
            valorBruto = (sale.saleGrossValue.bag || 0)
                + (sale.saleGrossValue.deliveryFee || 0)
                + (sale.saleGrossValue.serviceFee || 0);
        }
        await sincronizarPagamentosPedido(conn, merchantId, orderId, shortId, dataPedido, statusVenda, valorBruto, sale);
    }
}

async function somarSettlement(conn, merchantId, inicio, fim) {
    const [rows] = await conn.execute(
        `SELECT payload FROM ifood_fin_raw WHERE merchant_id = ? AND api_origem = 'SETTLEMENT'`,
        [merchantId]
    );
    if (!rows.length) return null;
    let total = 0, achou = false;
    for (const r of rows) {
        const s = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        const ini = s.beginDate || s.period?.beginDate || s.calculationStart;
        if (ini && ini >= inicio && ini <= fim) {
            total += Number(s.transferAmount || s.amount || s.netValue || 0);
            achou = true;
        }
    }
    return achou ? Number(total.toFixed(2)) : null;
}

async function statusRepasseCompetencia(conn, merchantId, inicio, fim) {
    const [rows] = await conn.execute(
        `SELECT payload FROM ifood_fin_raw WHERE merchant_id = ? AND api_origem = 'SETTLEMENT'`,
        [merchantId]
    );
    for (const r of rows) {
        const s = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        const ini = s.beginDate || s.startDateCalculation || s.period?.beginDate;
        if (!ini || ini < inicio || ini > fim) continue;
        const closingItems = s.closingItems || [];
        const repasse = closingItems.find(i => i.type === 'REPASSE');
        if (!repasse) return 'AGENDADO';
        return repasse.status === 'COMPENSATED' ? 'PAGO' : 'AGENDADO';
    }
    return null;
}

async function recalcularCompetencias(conn, merchantId) {
    const [comps] = await conn.execute(
        `SELECT id, periodo_inicio, periodo_fim FROM ifood_competencia WHERE merchant_id = ?`,
        [merchantId]
    );
    for (const c of comps) {
        const [tot] = await conn.execute(
            `SELECT
                COALESCE(SUM(CASE WHEN impacta_repasse=1 AND valor>0 THEN valor END), 0) AS cred,
                COALESCE(SUM(CASE WHEN impacta_repasse=1 AND valor<0 THEN valor END), 0) AS deb,
                COUNT(*) AS qtd
               FROM ifood_lancamento WHERE competencia_id = ?`,
            [c.id]
        );
        const creditos = Number(tot[0].cred);
        const debitos = Number(tot[0].deb);
        const esperado = creditos + debitos;
        const liquidado = await somarSettlement(conn, merchantId, c.periodo_inicio, c.periodo_fim);
        let status = 'ABERTA', divergencia = null;
        if (liquidado != null) {
            divergencia = Number((liquidado - esperado).toFixed(2));
            status = Math.abs(divergencia) <= TOLERANCIA ? 'CONCILIADA' : 'FECHADA';
        } else if (new Date(c.periodo_fim) < new Date()) {
            status = 'FECHADA';
        }
        await conn.execute(
            `UPDATE ifood_competencia
                SET total_creditos = ?, total_debitos = ?, repasse_esperado = ?,
                    repasse_liquidado = ?, divergencia = ?, qtd_lancamentos = ?,
                    status = ?, sincronizado_em = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [creditos, debitos, esperado, liquidado, divergencia, tot[0].qtd, status, c.id]
        );
        if (status === 'FECHADA' && divergencia != null && Math.abs(divergencia) > TOLERANCIA) {
            await conn.execute(
                `UPDATE ifood_pedido_conciliado p
                   JOIN ifood_lancamento l ON l.order_id = p.order_id AND l.merchant_id = p.merchant_id
                   SET p.status_conciliacao = 'DIVERGENTE'
                 WHERE l.competencia_id = ?`,
                [c.id]
            );
        }

        // Atualiza status_repasse em ifood_pedidos para todos os pedidos desta semana
        const statusRepasse = await statusRepasseCompetencia(conn, merchantId, c.periodo_inicio, c.periodo_fim);
        if (statusRepasse) {
            await conn.execute(
                `UPDATE ifood_pedidos SET status_repasse = ?
                  WHERE competencia_id = ? AND status_repasse != 'PAGO'`,
                [statusRepasse, c.id]
            );
        }
    }
}

// ============================================================
// PROCESSAMENTO POR CREDENCIAL
// ============================================================

async function processarCredencial(conn, credencial, beginDate, endDate) {
    const merchantId = credencial.merchant_id;
    const t0 = Date.now();

    let token;
    try {
        token = await getAccessToken(conn, credencial);
    } catch (err) {
        await conn.execute(
            `UPDATE ifood_credenciais SET status = 'DESCONECTADA', ultimo_erro = ? WHERE id = ?`,
            [String(err.message).slice(0, 500), credencial.id]
        );
        log(`⚠️ Credencial desconectada (${merchantId}): ${err.message}`, 'workerIfoodSync');
        return;
    }

    await garantirCompetencias(conn, credencial, beginDate, endDate);

    let totalRaw = 0;

    try {
        const eventos = await fetchFinancialEvents(credencial, token, beginDate, endDate);
        for (const ev of eventos) {
            await upsertRaw(conn, {
                merchantId, apiOrigem: 'FINANCIAL_EVENTS',
                hash: hashFinancialEvent(merchantId, ev),
                orderId: ev.reference?.type === 'ORDER' ? ev.reference.id : null,
                competencia: ev.competence || null,
                periodoInicio: ev.period?.beginDate || null,
                periodoFim: ev.period?.endDate || null,
                payload: ev,
            });
            totalRaw++;
        }
        log(`  📥 Financial Events: ${eventos.length}`, 'workerIfoodSync');
    } catch (err) {
        log(`  ❌ Erro Financial Events (${merchantId}): ${err.message}`, 'workerIfoodSync');
    }

    try {
        const vendas = await fetchSales(credencial, token, beginDate, endDate);
        for (const sale of vendas) {
            await upsertRaw(conn, {
                merchantId, apiOrigem: 'SALES',
                hash: hashSale(merchantId, sale),
                orderId: sale.id, competencia: null,
                periodoInicio: null, periodoFim: null, payload: sale,
            });
            await upsertPedido(conn, merchantId, credencial.id, sale);
            totalRaw++;
        }
        log(`  📦 Sales: ${vendas.length}`, 'workerIfoodSync');
    } catch (err) {
        log(`  ❌ Erro Sales (${merchantId}): ${err.message}`, 'workerIfoodSync');
    }

    try {
        const settlements = await fetchSettlements(credencial, token, beginDate, endDate);
        for (const st of settlements) {
            await upsertRaw(conn, {
                merchantId, apiOrigem: 'SETTLEMENT',
                hash: hashSettlement(merchantId, st),
                orderId: null, competencia: null,
                periodoInicio: null, periodoFim: null, payload: st,
            });
            totalRaw++;
        }
        log(`  💰 Settlements: ${settlements.length}`, 'workerIfoodSync');
    } catch (err) {
        log(`  ❌ Erro Settlements (${merchantId}): ${err.message}`, 'workerIfoodSync');
    }

    // Reconcile: normaliza os eventos brutos ainda não processados
    const [brutos] = await conn.execute(
        `SELECT r.id, r.payload, r.competencia_id
           FROM ifood_fin_raw r
          WHERE r.merchant_id = ? AND r.api_origem = 'FINANCIAL_EVENTS' AND r.processado = 0`,
        [merchantId]
    );

    let normalizados = 0;
    for (const b of brutos) {
        try {
            const ev = typeof b.payload === 'string' ? JSON.parse(b.payload) : b.payload;
            const l = normalizarFinancialEvent(merchantId, ev);
            const competenciaId = b.competencia_id
                || await resolverCompetencia(conn, merchantId, ev.period?.beginDate);
            if (!competenciaId) continue;

            await conn.execute(
                `INSERT INTO ifood_lancamento
                   (raw_id, credencial_id, competencia_id, merchant_id, order_id,
                    nome_evento, descricao_evento, gatilho, categoria, valor,
                    base_calculo, percentual, impacta_repasse, competencia,
                    data_evento, data_pagamento_prev, metodo_pagamento, bandeira, recebedor)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    valor = VALUES(valor), impacta_repasse = VALUES(impacta_repasse),
                    data_pagamento_prev = VALUES(data_pagamento_prev),
                    categoria = VALUES(categoria), updated_at = CURRENT_TIMESTAMP`,
                [b.id, credencial.id, competenciaId, merchantId, l.order_id,
                 l.nome_evento, l.descricao_evento, l.gatilho, l.categoria, l.valor,
                 l.base_calculo, l.percentual, l.impacta_repasse, l.competencia,
                 l.data_evento, l.data_pagamento_prev, l.metodo_pagamento, l.bandeira, l.recebedor]
            );
            await conn.execute(
                `UPDATE ifood_fin_raw
                    SET processado = 1, processado_em = CURRENT_TIMESTAMP, erro_processo = NULL
                  WHERE id = ?`,
                [b.id]
            );
            normalizados++;
        } catch (err) {
            await conn.execute(
                `UPDATE ifood_fin_raw SET erro_processo = ? WHERE id = ?`,
                [String(err.message).slice(0, 500), b.id]
            );
            log(`  ⚠️ Erro ao normalizar raw ${b.id}: ${err.message}`, 'workerIfoodSync');
        }
    }

    await recalcularPedidos(conn, credencial.id, merchantId);
    await sincronizarPagamentosDeTodasSales(conn, merchantId);
    await recalcularCompetencias(conn, merchantId);

    await conn.execute(
        `INSERT INTO ifood_job_log (merchant_id, worker, status, janela_inicio, janela_fim, qtd_registros, duracao_ms)
         VALUES (?, 'sync', 'OK', ?, ?, ?, ?)`,
        [merchantId, beginDate, endDate, totalRaw + normalizados, Date.now() - t0]
    );
    log(`✅ Merchant ${merchantId}: ${totalRaw} raw | ${normalizados} normalizados`, 'workerIfoodSync');
}

// ============================================================
// ENTRY POINT — registrado no jobMap do agendador.js
// ============================================================

async function ExecuteJobIfoodSync() {
    const fim = DateTime.local().minus({ days: 1 });
    const inicio = fim.minus({ days: JANELA_DIAS });
    const beginDate = inicio.toFormat('yyyy-MM-dd');
    const endDate = fim.toFormat('yyyy-MM-dd');

    log(`🚀 Iniciando iFood Sync | janela: ${beginDate} → ${endDate}`, 'workerIfoodSync');

    const conn = await getConnection();
    try {
        const ambiente = process.env.IFOOD_AMBIENTE || 'PRODUCAO';
        const [credenciais] = await conn.execute(
            `SELECT * FROM ifood_credenciais WHERE status = 'CONECTADA' AND ambiente = ?`,
            [ambiente]
        );

        if (!credenciais.length) {
            log('⚠️ Nenhuma credencial iFood conectada.', 'workerIfoodSync');
            return;
        }

        log(`📋 ${credenciais.length} loja(s) para sincronizar`, 'workerIfoodSync');

        for (const cred of credenciais) {
            log(`🏪 Merchant: ${cred.merchant_nome || cred.merchant_id}`, 'workerIfoodSync');
            try {
                await processarCredencial(conn, cred, beginDate, endDate);
            } catch (err) {
                log(`❌ Erro merchant ${cred.merchant_id}: ${err.message}`, 'workerIfoodSync');
                await conn.execute(
                    `INSERT INTO ifood_job_log (merchant_id, worker, status, detalhe)
                     VALUES (?, 'sync', 'ERRO', ?)`,
                    [cred.merchant_id, String(err.message).slice(0, 1000)]
                );
            }
        }
    } finally {
        await conn.end();
    }

    log('🏁 iFood Sync finalizado.', 'workerIfoodSync');
}

module.exports = { ExecuteJobIfoodSync };

if (require.main === module) {
    ExecuteJobIfoodSync().catch(err => {
        log(`🔥 Erro fatal: ${err.message}`, 'workerIfoodSync');
        process.exit(1);
    });
}
