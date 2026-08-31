require('dotenv').config();
const axios = require('axios');
const { DateTime } = require('luxon');
const { randomUUID } = require('crypto');
const { getConnection, callPHP } = require('../utils/utils');
const { log } = require('../utils/logger');
const { getTakeatSession } = require('../utils/takeatAuth');

const TAKEAT_BASE_URL = process.env.TAKEAT_API_BASE_URL || 'https://webhook.takeat.app/api/v1';

/**
 * Normaliza método e bandeira para os padrões de fechamento do MRK
 */
function normalizePaymentMethod(pm) {
    if (!pm) {
        return {
            id_tipo: 6,
            tipo_pagamento: 'OUTROS',
            bandeira: null
        };
    }

    const method = (pm.method || '').toUpperCase();
    const brand = (pm.brand || '').toUpperCase() || null;
    const name = (pm.name || '').toUpperCase();

    if (method === 'MONEY' || method === 'CASH' || name.includes('DINHEIRO')) {
        return { id_tipo: 1, tipo_pagamento: 'DINHEIRO', bandeira: null };
    }
    if (method === 'DEBIT' || name.includes('DEBITO') || name.includes('DÉBITO')) {
        return { id_tipo: 2, tipo_pagamento: 'CARTAO DE DEBITO', bandeira: brand || 'DÉBITO' };
    }
    if (method === 'CREDIT' || name.includes('CREDITO') || name.includes('CRÉDITO')) {
        return { id_tipo: 3, tipo_pagamento: 'CARTAO DE CREDITO', bandeira: brand || 'CRÉDITO' };
    }
    if (method === 'PIX' || name.includes('PIX')) {
        return { id_tipo: 4, tipo_pagamento: 'PIX', bandeira: null };
    }
    if (method === 'VOUCHER' || method === 'MEAL_VOUCHER' || name.includes('VR') || name.includes('VA') || name.includes('ALELO') || name.includes('SODEXO') || name.includes('TICKET')) {
        return { id_tipo: 5, tipo_pagamento: 'VOUCHER', bandeira: brand || 'VOUCHER' };
    }

    return { id_tipo: 6, tipo_pagamento: name || 'OUTROS', bandeira: brand };
}

/**
 * Insere registros em lote (bulk insert) para ganho de performance
 */
async function batchInsert(conn, table, columns, rows, batchSize = 100) {
    if (!rows || rows.length === 0) return;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ?`;
        await conn.query(sql, [batch]);
    }
}

/**
 * Upsert em lote para _bi_sales
 */
async function batchUpsertBiSales(conn, rows, batchSize = 100) {
    if (!rows || rows.length === 0) return;
    const columns = [
        'data_movimento', 'cod_material', 'quantidade', 'valor_bruto',
        'valor_unitario', 'valor_unitario_liquido', 'valor_liquido',
        'custom_code', 'system_unit_id'
    ];
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const sql = `
            INSERT INTO _bi_sales (${columns.join(', ')})
            VALUES ?
            ON DUPLICATE KEY UPDATE
                quantidade = VALUES(quantidade),
                valor_bruto = VALUES(valor_bruto),
                valor_unitario = VALUES(valor_unitario),
                valor_unitario_liquido = VALUES(valor_unitario_liquido),
                valor_liquido = VALUES(valor_liquido)
        `;
        await conn.query(sql, [batch]);
    }
}

/**
 * Varre todas as unidades em unit_integracoes com provider = 'takeat' e ativo = 1
 */
async function ProcessJobTakeatAll(dataInicio, dataFim) {
    let conn;
    try {
        conn = await getConnection();
        const [lojas] = await conn.execute(`
            SELECT ui.system_unit_id, su.name AS unit_name, su.custom_code
            FROM unit_integracoes ui
            JOIN system_unit su ON su.id = ui.system_unit_id
            WHERE ui.provider = 'takeat' AND ui.ativo = 1 AND su.status = 1
        `);

        if (!lojas || lojas.length === 0) {
            log(`ℹ️ [Takeat Worker] Nenhuma loja ativa encontrada em unit_integracoes.`, 'takeat');
            return { totalLojas: 0, processadas: 0 };
        }

        log(`🚀 [Takeat Worker] Iniciando sincronização para ${lojas.length} loja(s) de ${dataInicio} até ${dataFim}.`, 'takeat');

        let processadas = 0;
        for (const loja of lojas) {
            try {
                await ProcessStoreTakeat(conn, loja.system_unit_id, dataInicio, dataFim, loja.unit_name);
                processadas++;
            } catch (errLoja) {
                log(`❌ [Takeat Worker] Erro na loja #${loja.system_unit_id} (${loja.unit_name}): ${errLoja.message}`, 'takeat');

                try {
                    await conn.execute(`
                        UPDATE unit_integracoes
                        SET status = 'ERRO', ultimo_erro = ?, updated_at = NOW()
                        WHERE system_unit_id = ? AND provider = 'takeat'
                    `, [errLoja.message.slice(0, 490), loja.system_unit_id]);
                } catch (e) {}
            }
        }

        log(`🏁 [Takeat Worker] Varredura concluída: ${processadas}/${lojas.length} lojas processadas.`, 'takeat');
        return { totalLojas: lojas.length, processadas };

    } finally {
        if (conn) await conn.end();
    }
}

/**
 * Processa a sincronização completa de uma única unidade
 */
async function ProcessStoreTakeat(conn, systemUnitId, dataInicio, dataFim, unitNameParam = null) {
    let unitName = unitNameParam;
    if (!unitName) {
        const [uRows] = await conn.execute("SELECT name FROM system_unit WHERE id = ?", [systemUnitId]);
        unitName = uRows[0]?.name || `Unidade #${systemUnitId}`;
    }

    log(`🔄 [Takeat #${systemUnitId}] Obtendo sessão e token da loja (${unitName})...`, 'takeat');
    const { token, restaurantId, fantasyName } = await getTakeatSession(conn, systemUnitId);

    // 1. Carrega mapeamento de produtos indexado por codigo_pdv
    const [prodRows] = await conn.execute(
        "SELECT codigo, codigo_pdv, nome FROM products WHERE system_unit_id = ?",
        [systemUnitId]
    );

    const mapaProdutos = new Map();
    const produtosFaltantes = new Map();

    prodRows.forEach(p => {
        const codInterno = parseInt(p.codigo, 10);
        const codPdv = (p.codigo_pdv || '').trim();
        if (codPdv !== '') {
            mapaProdutos.set(codPdv, codInterno);
        }
        mapaProdutos.set(String(codInterno), codInterno);
    });

    log(`📦 [Takeat #${systemUnitId}] Mapa carregado: ${mapaProdutos.size} chaves de produtos/PDV.`, 'takeat');

    // 2. Quebra o período em blocos de até 2 dias para respeitar o limite máximo da API Takeat (máx 3 dias por chamada)
    let curStart = DateTime.fromISO(dataInicio, { zone: 'America/Sao_Paulo' }).startOf('day');
    const finalEnd = DateTime.fromISO(dataFim, { zone: 'America/Sao_Paulo' }).endOf('day');

    const chunks = [];
    while (curStart < finalEnd) {
        let curEnd = curStart.plus({ days: 2 }).endOf('day');
        if (curEnd > finalEnd) {
            curEnd = finalEnd;
        }
        chunks.push({
            startDt: curStart.toUTC().toISO(),
            endDt: curEnd.toUTC().toISO()
        });
        curStart = curStart.plus({ days: 3 }).startOf('day');
    }

    log(`🌐 [Takeat #${systemUnitId}] Consultando table-sessions em ${chunks.length} bloco(s) de data...`, 'takeat');

    let allSessions = [];
    for (const chunk of chunks) {
        const params = {
            start_date: chunk.startDt,
            end_date: chunk.endDt
        };
        if (restaurantId) {
            params.restaurant_id = restaurantId;
        }

        let chunkSessions = [];
        let attempts = 0;
        while (attempts < 3) {
            attempts++;
            try {
                const resp = await axios.get(`${TAKEAT_BASE_URL}/table-sessions`, {
                    params,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json'
                    },
                    timeout: 45000
                });
                chunkSessions = resp.data || [];
                break;
            } catch (apiErr) {
                if (apiErr.response?.status === 429 && attempts < 3) {
                    const retrySec = 13;
                    log(`⏳ [Takeat #${systemUnitId}] Rate limit atingido (429). Aguardando ${retrySec}s para tentar novamente...`, 'takeat');
                    await new Promise(resolve => setTimeout(resolve, retrySec * 1000));
                    continue;
                }
                throw new Error(`Erro na API Takeat: ${apiErr.response?.data?.message || apiErr.message}`);
            }
        }

        if (!Array.isArray(chunkSessions)) {
            chunkSessions = chunkSessions.data || [];
        }

        allSessions = allSessions.concat(chunkSessions);
    }

    // Remove duplicatas de sessões pelo ID
    const sessionMap = new Map();
    allSessions.forEach(s => {
        if (s && s.id) {
            sessionMap.set(s.id, s);
        }
    });
    const sessions = Array.from(sessionMap.values());

    log(`📥 [Takeat #${systemUnitId}] Total consolidado: ${sessions.length} comandas/sessões retornadas.`, 'takeat');

    // 3. Inicia transação no MySQL
    await conn.beginTransaction();

    try {
        // Limpeza prévia para idempotência
        await conn.execute(`
            DELETE FROM sales
            WHERE system_unit_id = ?
              AND DATE(dtLancamento) >= ? AND DATE(dtLancamento) <= ?
              AND idItemVenda LIKE 'takeat-%'
        `, [systemUnitId, dataInicio, dataFim]);

        await conn.execute(`
            DELETE FROM movimento_caixa
            WHERE lojaId = ?
              AND dataContabil >= ? AND dataContabil <= ?
              AND num_controle LIKE 'takeat-%'
        `, [String(systemUnitId), dataInicio, dataFim]);

        await conn.execute(`
            DELETE FROM api_pagamentos
            WHERE id_loja = ?
              AND data_contabil >= ? AND data_contabil <= ?
              AND origem = 'TAKEAT'
        `, [systemUnitId, dataInicio, dataFim]);

        let totalItensVendidos = 0;
        let totalFaturado = 0;
        const biSalesAgrupados = new Map(); // key: "dataContabil_codMaterial"

        const rowsMovCaixa = [];
        const rowsPagamentos = [];
        const rowsSales = [];

        for (const session of sessions) {
            // Considera sessões fechadas ou concluídas
            const isCompleted = session.status === 'completed' || session.status === 'closed' || session.completed_at || session.end_time;
            if (!isCompleted) continue;

            const completedIso = session.completed_at || session.end_time || session.start_time;
            const dtCompleta = DateTime.fromISO(completedIso, { zone: 'utc' }).setZone('America/Sao_Paulo');
            const dataContabil = dtCompleta.toISODate();
            const horaLancamento = dtCompleta.toFormat('HH:mm:ss');
            const horaInteira = dtCompleta.hour; // 0..23 para o gráfico de faturamento por hora

            const sessionId = session.id;
            const numPedido = session.table?.table_number || sessionId;
            const modoVenda = session.is_delivery ? 'DELIVERY' : 'SALAO';

            const vlBruto = parseFloat(session.old_total_price || session.total_price || 0);
            const vlLiquido = parseFloat(session.total_price || 0);
            const vlDesconto = parseFloat(session.discount_total || 0);
            const vlServico = Math.max(0, parseFloat(session.total_service_price || vlLiquido) - vlLiquido);
            const numPessoas = Math.max(1, parseInt(session.people_at_table || 1, 10));

            const dtAberturaStr = session.start_time
                ? DateTime.fromISO(session.start_time, { zone: 'utc' }).setZone('America/Sao_Paulo').toFormat('yyyy-MM-dd HH:mm:ss')
                : `${dataContabil} 00:00:00`;
            const dtFechamentoStr = completedIso
                ? DateTime.fromISO(completedIso, { zone: 'utc' }).setZone('America/Sao_Paulo').toFormat('yyyy-MM-dd HH:mm:ss')
                : `${dataContabil} 23:59:59`;

            // A) Linha movimento_caixa
            rowsMovCaixa.push([
                `takeat-session-${sessionId}`,
                `takeat-session-${sessionId}`,
                dtAberturaStr,
                dtFechamentoStr,
                dataContabil,
                String(systemUnitId),
                unitName,
                'Takeat PDV',
                vlBruto,
                vlLiquido,
                vlDesconto,
                vlServico,
                numPessoas,
                modoVenda,
                modoVenda,
                horaInteira,
                0
            ]);

            totalFaturado += vlLiquido;

            // B) Linhas api_pagamentos
            const payments = Array.isArray(session.payments) ? session.payments : [];
            let paySeq = 0;

            for (const pay of payments) {
                paySeq++;
                const payUuid = randomUUID();
                const pm = pay.payment_method || {};
                const norm = normalizePaymentMethod(pm);

                const vlrFaturado = parseFloat(pay.payment_value || pay.original_value || 0);
                const vlrLiquidoAdquirente = parseFloat(pay.predicted_received_value || vlrFaturado);
                const vlrComissao = Math.max(0, vlrFaturado - vlrLiquidoAdquirente);
                const taxaPercentual = vlrFaturado > 0 ? (vlrComissao / vlrFaturado) * 100 : 0;

                const dtVencimento = pay.predicted_received_date
                    ? DateTime.fromISO(pay.predicted_received_date, { zone: 'utc' }).setZone('America/Sao_Paulo').toISODate()
                    : dataContabil;

                rowsPagamentos.push([
                    payUuid,
                    `takeat-${systemUnitId}-${sessionId}`,
                    systemUnitId,
                    unitName,
                    parseInt(numPedido, 10) || sessionId,
                    paySeq,
                    dataContabil,
                    'finalizado',
                    dataContabil,
                    horaLancamento,
                    parseInt(pm.id || pay.id || 0, 10),
                    (pm.name || norm.tipo_pagamento || '').slice(0, 100),
                    dtVencimento,
                    vlrFaturado,
                    vlrLiquidoAdquirente,
                    parseFloat(taxaPercentual.toFixed(2)),
                    parseFloat(vlrComissao.toFixed(2)),
                    pay.nsu || null,
                    pay.acquirer || pm.brand || null,
                    pay.authorization_code || null,
                    norm.id_tipo,
                    norm.tipo_pagamento,
                    norm.bandeira,
                    'TAKEAT'
                ]);
            }

            // C) Linhas sales (bills -> order_baskets -> orders -> order_complements)
            const bills = Array.isArray(session.bills) ? session.bills : [];
            for (const bill of bills) {
                const baskets = Array.isArray(bill.order_baskets) ? bill.order_baskets : [];
                for (const basket of baskets) {
                    if (basket.canceled_at) continue;

                    const orders = Array.isArray(basket.orders) ? basket.orders : [];
                    for (const order of orders) {
                        if (order.canceled_at) continue;

                        const takeatProdId = String(order.product?.id || '');
                        const takeatProdNome = order.product?.name || 'Item sem nome';
                        const codMaterial = mapaProdutos.get(takeatProdId);

                        const qtd = parseFloat(order.weight && parseFloat(order.weight) > 0 ? order.weight : order.amount) || 1;
                        const vUnit = parseFloat(order.price || 0);
                        const vTotal = parseFloat(order.total_price || (vUnit * qtd));

                        if (codMaterial) {
                            rowsSales.push([
                                `takeat-${order.id}`,
                                dtFechamentoStr,
                                codMaterial,
                                takeatProdNome.slice(0, 250),
                                qtd,
                                vUnit,
                                vUnit,
                                vTotal,
                                vTotal,
                                modoVenda,
                                systemUnitId,
                                String(systemUnitId)
                            ]);
                            totalItensVendidos += qtd;

                            // Acumulador para _bi_sales
                            const biKey = `${dataContabil}_${codMaterial}`;
                            if (!biSalesAgrupados.has(biKey)) {
                                biSalesAgrupados.set(biKey, {
                                    data_movimento: `${dataContabil} 00:00:00`,
                                    cod_material: codMaterial,
                                    quantidade: 0,
                                    valor_bruto: 0,
                                    valor_liquido: 0,
                                    custom_code: String(systemUnitId),
                                    system_unit_id: systemUnitId
                                });
                            }
                            const biItem = biSalesAgrupados.get(biKey);
                            biItem.quantidade += qtd;
                            biItem.valor_bruto += vTotal;
                            biItem.valor_liquido += vTotal;

                        } else if (takeatProdId) {
                            produtosFaltantes.set(takeatProdId, takeatProdNome);
                        }

                        // Processa Complementos/Adicionais
                        const compCats = Array.isArray(order.complement_categories) ? order.complement_categories : [];
                        for (const cat of compCats) {
                            const comps = Array.isArray(cat.order_complements) ? cat.order_complements : [];
                            for (const comp of comps) {
                                const takeatCompId = String(comp.complement?.id || '');
                                const takeatCompNome = comp.complement?.name || 'Complemento';
                                const codMaterialComp = mapaProdutos.get(takeatCompId);
                                const qtdComp = (parseFloat(comp.amount) || 1) * qtd;

                                if (codMaterialComp) {
                                    rowsSales.push([
                                        `takeat-comp-${comp.id}`,
                                        dtFechamentoStr,
                                        codMaterialComp,
                                        takeatCompNome.slice(0, 250),
                                        qtdComp,
                                        0,
                                        0,
                                        0,
                                        0,
                                        modoVenda,
                                        systemUnitId,
                                        String(systemUnitId)
                                    ]);

                                    const biCompKey = `${dataContabil}_${codMaterialComp}`;
                                    if (!biSalesAgrupados.has(biCompKey)) {
                                        biSalesAgrupados.set(biCompKey, {
                                            data_movimento: `${dataContabil} 00:00:00`,
                                            cod_material: codMaterialComp,
                                            quantidade: 0,
                                            valor_bruto: 0,
                                            valor_liquido: 0,
                                            custom_code: String(systemUnitId),
                                            system_unit_id: systemUnitId
                                        });
                                    }
                                    const biComp = biSalesAgrupados.get(biCompKey);
                                    biComp.quantidade += qtdComp;
                                } else if (takeatCompId) {
                                    produtosFaltantes.set(takeatCompId, `[Adicional] ${takeatCompNome}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Executa gravações em lote ultra-rápidas
        await batchInsert(conn, 'movimento_caixa', [
            'id', 'num_controle', 'dataAbertura', 'dataFechamento', 'dataContabil',
            'lojaId', 'loja', 'rede', 'vlTotalReceber', 'vlTotalRecebido', 'vlDesconto',
            'vlServicoRecebido', 'numPessoas', 'modoVenda', 'modoVenda2', 'hora', 'cancelado'
        ], rowsMovCaixa);

        await batchInsert(conn, 'api_pagamentos', [
            'uuid', 'id_operacao', 'id_loja', 'nome_loja', 'num_pedido', 'seq_pedido',
            'data_contabil', 'status_pagamento', 'data_lancamento', 'hora_lancamento',
            'id_m', 'descricao', 'data_vencimento', 'valor', 'valor_liquido',
            'taxa_comissao', 'valor_comissao', 'nsu', 'adquirente', 'autorizacao',
            'id_tipo', 'tipo_pagamento', 'bandeira', 'origem'
        ], rowsPagamentos);

        await batchInsert(conn, 'sales', [
            'idItemVenda', 'dtLancamento', 'codMaterial', 'descricao', 'quantidade',
            'valorUnitario', 'valorUnitarioLiquido', 'valorLiquido', 'valorBruto',
            'modoVenda', 'system_unit_id', 'custom_code'
        ], rowsSales);

        // D) Grava em lote na tabela _bi_sales (Consolidado)
        const rowsBi = Array.from(biSalesAgrupados.values()).map(bi => {
            const vUnit = bi.quantidade > 0 ? (bi.valor_liquido / bi.quantidade) : 0;
            return [
                bi.data_movimento,
                bi.cod_material,
                bi.quantidade,
                parseFloat(bi.valor_bruto.toFixed(2)),
                parseFloat(vUnit.toFixed(2)),
                parseFloat(vUnit.toFixed(2)),
                parseFloat(bi.valor_liquido.toFixed(2)),
                bi.custom_code,
                bi.system_unit_id
            ];
        });

        await batchUpsertBiSales(conn, rowsBi);

        // Atualiza status e timestamp da sincronização em unit_integracoes
        await conn.execute(`
            UPDATE unit_integracoes
            SET status = 'CONECTADA',
                ultimo_erro = NULL,
                ultima_sincronizacao = NOW(),
                updated_at = NOW()
            WHERE system_unit_id = ? AND provider = 'takeat'
        `, [systemUnitId]);

        await conn.commit();

        log(`✅ [Takeat #${systemUnitId}] Sucesso: ${totalItensVendidos} itens vendidos, R$ ${totalFaturado.toFixed(2)} faturados, ${biSalesAgrupados.size} produtos consolidados em _bi_sales.`, 'takeat');

        // Dispara baixa de estoque por data no backend PHP
        try {
            await callPHP('processarBaixaEstoqueVendas', {
                system_unit_id: systemUnitId,
                data_inicio: dataInicio,
                data_fim: dataFim
            });
        } catch (e) {}

        return {
            success: true,
            totalItensVendidos,
            totalFaturado,
            produtosConsolidados: biSalesAgrupados.size,
            produtosNaoMapeados: Array.from(produtosFaltantes.entries()).map(([k, v]) => ({ codigo_pdv: k, nome: v }))
        };

    } catch (errDb) {
        await conn.rollback();
        throw errDb;
    }
}

module.exports = {
    ProcessJobTakeatAll,
    ProcessStoreTakeat
};
