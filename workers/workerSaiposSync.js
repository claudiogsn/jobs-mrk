require('dotenv').config();
const axios = require('axios');
const { DateTime } = require('luxon');
const { randomUUID } = require('crypto');
const { getConnection, callPHP } = require('../utils/utils');
const { log } = require('../utils/logger');

const SAIPOS_BASE_URL = process.env.SAIPOS_API_BASE_URL || 'https://data.saipos.io/v1';

/**
 * Normaliza o token garantindo o formato 'Bearer <token>'
 */
function formatBearerToken(rawToken) {
    if (!rawToken) return '';
    const clean = String(rawToken).trim();
    return clean.toLowerCase().startsWith('bearer ') ? clean : `Bearer ${clean}`;
}

/**
 * Normaliza método e bandeira para o padrão de fechamento de caixa do MRK
 */
function normalizePaymentMethodSaipos(descPagamento, smartposArr = [], tefArr = []) {
    const raw = String(descPagamento || '').trim().toUpperCase();

    // Tenta identificar bandeira em transações TEF ou SmartPOS
    let bandeira = null;
    let nsu = null;
    let autorizacao = null;
    let adquirente = null;

    if (Array.isArray(tefArr) && tefArr.length > 0) {
        const t = tefArr[0];
        bandeira = t.card_label || null;
        nsu = t.nsu || null;
        adquirente = t.id_authorizer || null;
    } else if (Array.isArray(smartposArr) && smartposArr.length > 0) {
        const s = smartposArr[0];
        bandeira = s.card_label || null;
        autorizacao = s.authorization_code || null;
        adquirente = s.id_pos_partner || null;
    }

    if (raw.includes('DINHEIRO') || raw === 'CASH' || raw === 'MONEY') {
        return { id_tipo: 1, tipo_pagamento: 'DINHEIRO', bandeira: null, nsu, autorizacao, adquirente };
    }
    if (raw.includes('DEBITO') || raw.includes('DÉBITO') || raw === 'DEBIT') {
        return { id_tipo: 2, tipo_pagamento: 'CARTAO DE DEBITO', bandeira: bandeira || 'DÉBITO', nsu, autorizacao, adquirente };
    }
    if (raw.includes('CREDITO') || raw.includes('CRÉDITO') || raw === 'CREDIT') {
        return { id_tipo: 3, tipo_pagamento: 'CARTAO DE CREDITO', bandeira: bandeira || 'CRÉDITO', nsu, autorizacao, adquirente };
    }
    if (raw.includes('PIX')) {
        return { id_tipo: 4, tipo_pagamento: 'PIX', bandeira: null, nsu, autorizacao, adquirente };
    }
    if (raw.includes('VOUCHER') || raw.includes('REFEICAO') || raw.includes('REFEIÇÃO') || raw.includes('ALELO') || raw.includes('SODEXO') || raw.includes('TICKET') || raw.includes('VR') || raw.includes('VA') || raw.includes('BEN')) {
        return { id_tipo: 5, tipo_pagamento: 'VOUCHER', bandeira: bandeira || 'VOUCHER', nsu, autorizacao, adquirente };
    }

    return { id_tipo: 6, tipo_pagamento: raw || 'OUTROS', bandeira, nsu, autorizacao, adquirente };
}

/**
 * Normaliza o tipo de venda Saipos para o modoVenda do MRK
 * 1: Entrega (Delivery) | 2: Retirada balcão | 3: Salão | 4: Ficha / Senha
 */
function normalizeModoVendaSaipos(idSaleType) {
    const type = parseInt(idSaleType, 10);
    switch (type) {
        case 1:
            return 'DELIVERY';
        case 2:
            return 'BALCAO';
        case 3:
            return 'SALAO';
        case 4:
            return 'FICHA';
        default:
            return 'BALCAO';
    }
}

/**
 * Insere registros em lote (bulk insert) com tolerância a falhas e idempotência
 */
async function batchInsert(conn, table, columns, rows, batchSize = 100) {
    if (!rows || rows.length === 0) return;
    const updateClauses = columns
        .filter(c => c !== 'id' && c !== 'uuid' && c !== 'idItemVenda')
        .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(', ');

    const sql = updateClauses.length > 0
        ? `INSERT INTO ${table} (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${updateClauses}`
        : `INSERT IGNORE INTO ${table} (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ?`;

    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
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
 * Consome o endpoint /search_sales da Saipos com paginação automática
 */
async function fetchSaiposSales(token, filterDateStart, filterDateEnd, storeId = null) {
    const allSales = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
        const params = {
            p_date_column_filter: 'shift_date',
            p_filter_date_start: filterDateStart,
            p_filter_date_end: filterDateEnd,
            p_limit: limit,
            p_offset: offset
        };

        let resp;
        let attempts = 0;
        while (attempts < 3) {
            try {
                resp = await axios.get(`${SAIPOS_BASE_URL}/search_sales`, {
                    params,
                    headers: {
                        Authorization: formatBearerToken(token),
                        Accept: 'application/json'
                    },
                    timeout: 120000
                });
                break;
            } catch (err) {
                attempts++;
                if (attempts >= 3) throw err;
                log(`⚠️ Tentativa ${attempts} falhou em /search_sales (${err.message}). Retentando em 3s...`, 'saipos');
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        const list = Array.isArray(resp.data) ? resp.data : [];
        allSales.push(...list);

        if (list.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    // Se a loja tem store_id configurado, filtra por id_store de forma segura
    if (storeId) {
        const targetId = parseInt(storeId, 10);
        return allSales.filter(s => parseInt(s.id_store, 10) === targetId);
    }

    return allSales;
}

/**
 * Consome o endpoint /sales_items da Saipos com paginação automática
 */
async function fetchSaiposSalesItems(token, filterDateStart, filterDateEnd, storeId = null) {
    const allSalesItems = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
        const params = {
            p_date_column_filter: 'shift_date',
            p_filter_date_start: filterDateStart,
            p_filter_date_end: filterDateEnd,
            p_limit: limit,
            p_offset: offset
        };

        let resp;
        let attempts = 0;
        while (attempts < 3) {
            try {
                resp = await axios.get(`${SAIPOS_BASE_URL}/sales_items`, {
                    params,
                    headers: {
                        Authorization: formatBearerToken(token),
                        Accept: 'application/json'
                    },
                    timeout: 120000
                });
                break;
            } catch (err) {
                attempts++;
                if (attempts >= 3) throw err;
                log(`⚠️ Tentativa ${attempts} falhou em /sales_items (${err.message}). Retentando em 3s...`, 'saipos');
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        const list = Array.isArray(resp.data) ? resp.data : [];
        allSalesItems.push(...list);

        if (list.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    if (storeId) {
        const targetId = parseInt(storeId, 10);
        return allSalesItems.filter(s => parseInt(s.id_store, 10) === targetId);
    }

    return allSalesItems;
}

/**
 * Varre todas as unidades em unit_integracoes com provider = 'saipos' e ativo = 1
 */
async function ProcessJobSaiposAll(dataInicio, dataFim) {
    let conn;
    try {
        conn = await getConnection();
        const [lojas] = await conn.execute(`
            SELECT ui.system_unit_id, su.name AS unit_name, su.custom_code
            FROM unit_integracoes ui
            JOIN system_unit su ON su.id = ui.system_unit_id
            WHERE ui.provider = 'saipos' AND ui.ativo = 1 AND su.status = 1
        `);

        if (!lojas || lojas.length === 0) {
            log(`ℹ️ [Saipos Worker] Nenhuma loja ativa encontrada em unit_integracoes.`, 'saipos');
            return { totalLojas: 0, processadas: 0 };
        }

        log(`🚀 [Saipos Worker] Iniciando sincronização para ${lojas.length} loja(s) de ${dataInicio} até ${dataFim}.`, 'saipos');

        let processadas = 0;
        for (const loja of lojas) {
            try {
                await ProcessStoreSaipos(conn, loja.system_unit_id, dataInicio, dataFim, loja.unit_name);
                processadas++;
            } catch (errLoja) {
                log(`❌ [Saipos Worker] Erro na loja #${loja.system_unit_id} (${loja.unit_name}): ${errLoja.message}`, 'saipos');

                try {
                    await conn.execute(`
                        UPDATE unit_integracoes
                        SET status = 'ERRO', ultimo_erro = ?, updated_at = NOW()
                        WHERE system_unit_id = ? AND provider = 'saipos'
                    `, [errLoja.message.slice(0, 490), loja.system_unit_id]);
                } catch (e) {}
            }
        }

        log(`🏁 [Saipos Worker] Varredura concluída: ${processadas}/${lojas.length} lojas processadas.`, 'saipos');
        return { totalLojas: lojas.length, processadas };

    } finally {
        if (conn) await conn.end();
    }
}

/**
 * Sincroniza uma loja específica da Saipos
 */
async function ProcessStoreSaipos(conn, systemUnitId, dataInicio, dataFim, unitNameParam = null) {
    let unitName = unitNameParam;
    if (!unitName) {
        const [uRows] = await conn.execute("SELECT name FROM system_unit WHERE id = ?", [systemUnitId]);
        unitName = uRows[0]?.name || `Unidade #${systemUnitId}`;
    }

    log(`🔄 [Saipos #${systemUnitId}] Obtendo credenciais da loja (${unitName})...`, 'saipos');

    const [uiRows] = await conn.execute(
        "SELECT config FROM unit_integracoes WHERE system_unit_id = ? AND provider = 'saipos' AND ativo = 1",
        [systemUnitId]
    );

    if (!uiRows || uiRows.length === 0) {
        throw new Error(`Integração Saipos não configurada ou inativa para a unidade #${systemUnitId}`);
    }

    const config = typeof uiRows[0].config === 'string'
        ? JSON.parse(uiRows[0].config || '{}')
        : (uiRows[0].config || {});

    const token = config.token;
    if (!token) {
        throw new Error(`Token Saipos não informado na configuração da unidade #${systemUnitId}`);
    }

    const storeId = config.store_id || null;
    const importarFaturamento = config.faturamento !== 0; // Default: true
    const sincronizarEstoque = config.estoque !== 0;      // Default: true

    // 1. Carrega mapeamento de produtos: codigo_pdv -> codigo interno
    const [prodRows] = await conn.execute(
        "SELECT codigo, codigo_pdv, nome FROM products WHERE system_unit_id = ?",
        [systemUnitId]
    );

    const mapaProdutos = new Map();
    const produtosFaltantes = new Map();

    prodRows.forEach(p => {
        const codInterno = parseInt(p.codigo, 10);
        const codPdv = String(p.codigo_pdv || '').trim();
        if (codPdv !== '') {
            mapaProdutos.set(codPdv, codInterno);
        }
        mapaProdutos.set(String(codInterno), codInterno);
    });

    log(`📦 [Saipos #${systemUnitId}] Mapa carregado: ${mapaProdutos.size} chaves de produtos/PDV.`, 'saipos');

    // 2. Parâmetros de data formatados para a Saipos (ex: 2024-07-01 00:00:00)
    const filterStart = `${dataInicio} 00:00:00`;
    const filterEnd = `${dataFim} 23:59:59`;

    let totalVendasCaixa = 0;
    let totalFaturado = 0;
    let totalItensVendidos = 0;
    const biSalesAgrupados = new Map();

    const rowsMovCaixa = [];
    const rowsPagamentos = [];
    const rowsSales = [];

    await conn.beginTransaction();

    try {
        // =========================================================================
        // PARTE 1: Fechamento de Caixa e Formas de Pagamento (/search_sales)
        // =========================================================================
        if (importarFaturamento) {
            log(`🌐 [Saipos #${systemUnitId}] Consultando vendas em /search_sales (${filterStart} a ${filterEnd})...`, 'saipos');
            const sales = await fetchSaiposSales(token, filterStart, filterEnd, storeId);
            log(`📊 [Saipos #${systemUnitId}] ${sales.length} vendas retornadas da Saipos.`, 'saipos');

            for (const sale of sales) {
                const idSale = sale.id_sale;
                const shiftDate = (sale.shift_date || dataInicio).split('T')[0];
                const createdAt = sale.created_at || `${shiftDate} 12:00:00`;
                const horaLancamento = createdAt.includes('T')
                    ? createdAt.split('T')[1].slice(0, 8)
                    : (createdAt.split(' ')[1]?.slice(0, 8) || '00:00:00');
                const horaCheia = parseInt(horaLancamento.split(':')[0], 10) || 0;

                const modoVenda = normalizeModoVendaSaipos(sale.id_sale_type);
                const totals = sale.totals || {};
                const vlTotalRecebido = parseFloat(sale.total_amount ?? totals.total_amount ?? 0);
                const vlDesconto = parseFloat(sale.total_discount ?? totals.total_discount ?? 0);
                const vlServico = parseFloat(sale.total_increase ?? totals.total_increase ?? 0);
                const vlBruto = parseFloat(sale.total_amount_items ?? totals.total_amount_items ?? (vlTotalRecebido + vlDesconto));
                const numPessoas = parseInt(sale.table_order?.customers_on_table || 1, 10);
                const isCanceled = (sale.canceled === 'S' || sale.canceled === 'true' || sale.status === 'CANCELLED' || sale.deleted === 'S') ? 1 : 0;

                totalVendasCaixa++;
                totalFaturado += vlTotalRecebido;

                // Registro para movimento_caixa
                rowsMovCaixa.push([
                    `saipos-${systemUnitId}-${idSale}`,
                    String(idSale),
                    createdAt.replace('T', ' '),
                    createdAt.replace('T', ' '),
                    shiftDate,
                    systemUnitId,
                    unitName.slice(0, 100),
                    'SAIPOS',
                    vlBruto,
                    vlTotalRecebido,
                    vlDesconto,
                    vlServico,
                    numPessoas,
                    modoVenda,
                    sale.partner_sale?.desc_store_partner || modoVenda,
                    horaCheia,
                    isCanceled
                ]);

                // Formas de pagamento
                const payments = Array.isArray(sale.payments) ? sale.payments : [];
                let seq = 0;
                for (const pay of payments) {
                    seq++;
                    const valorPago = parseFloat(pay.payment_amount || 0);
                    if (valorPago <= 0) continue;

                    const smartpos = sale.payment_transaction_smartpos || [];
                    const tef = sale.payment_transaction_tef || [];
                    const norm = normalizePaymentMethodSaipos(pay.desc_store_payment_type, smartpos, tef);

                    rowsPagamentos.push([
                        randomUUID(),
                        String(idSale),
                        systemUnitId,
                        unitName.slice(0, 100),
                        String(idSale),
                        seq,
                        shiftDate,
                        'APROVADO',
                        shiftDate,
                        horaLancamento,
                        String(idSale),
                        (pay.desc_store_payment_type || 'OUTROS').slice(0, 100),
                        shiftDate,
                        valorPago,
                        valorPago,
                        0,
                        0,
                        norm.nsu ? String(norm.nsu).slice(0, 50) : null,
                        norm.adquirente ? String(norm.adquirente).slice(0, 50) : 'SAIPOS',
                        norm.autorizacao ? String(norm.autorizacao).slice(0, 50) : null,
                        norm.id_tipo,
                        norm.tipo_pagamento,
                        norm.bandeira,
                        'SAIPOS'
                    ]);
                }
            }
        }

        // =========================================================================
        // PARTE 2: Produtos Vendidos & Baixa de Estoque (/sales_items)
        // =========================================================================
        if (sincronizarEstoque) {
            log(`🌐 [Saipos #${systemUnitId}] Consultando itens em /sales_items (${filterStart} a ${filterEnd})...`, 'saipos');
            const salesItemsList = await fetchSaiposSalesItems(token, filterStart, filterEnd, storeId);
            log(`📦 [Saipos #${systemUnitId}] ${salesItemsList.length} pedidos de itens retornados da Saipos.`, 'saipos');

            for (const saleItemObj of salesItemsList) {
                const idSale = saleItemObj.id_sale;
                const shiftDate = (saleItemObj.shift_date || dataInicio).split('T')[0];
                const createdAtStr = (saleItemObj.created_at || `${shiftDate} 12:00:00`).replace('T', ' ');
                const modoVenda = normalizeModoVendaSaipos(saleItemObj.id_sale_type);

                const items = Array.isArray(saleItemObj.items) ? saleItemObj.items : [];
                for (const item of items) {
                    if (item.deleted === 'S' || item.deleted === 'true') continue;

                    const descItem = item.desc_sale_item || 'Item sem nome';
                    const integrationCode = String(item.integration_code || '').trim();
                    const storeItemId = String(item.id_store_item || '').trim();

                    // Mapeamento: 1) integration_code (Código PDV) -> 2) id_store_item
                    const codMaterial = (integrationCode && mapaProdutos.get(integrationCode))
                        || (storeItemId && mapaProdutos.get(storeItemId))
                        || null;

                    const qtd = parseFloat(item.quantity || 1);
                    const vUnit = parseFloat(item.unit_price || 0);
                    const vTotal = parseFloat((vUnit * qtd).toFixed(2));

                    if (codMaterial) {
                        rowsSales.push([
                            `saipos-${systemUnitId}-item-${item.id_sale_item || randomUUID()}`,
                            createdAtStr,
                            codMaterial,
                            descItem.slice(0, 250),
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
                        const biKey = `${shiftDate}_${codMaterial}`;
                        if (!biSalesAgrupados.has(biKey)) {
                            biSalesAgrupados.set(biKey, {
                                data_movimento: `${shiftDate} 00:00:00`,
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

                    } else {
                        const chaveFaltante = integrationCode || storeItemId || descItem;
                        produtosFaltantes.set(chaveFaltante, descItem);
                    }

                    // Processa complementos/adicionais (choices)
                    const choices = Array.isArray(item.choices) ? item.choices : [];
                    for (const choice of choices) {
                        if (choice.deleted === 'S' || choice.deleted === 'true') continue;

                        const descChoice = choice.desc_sale_item_choice || choice.desc_store_choice_item || 'Adicional';
                        const choiceIntegrationCode = String(choice.integration_code || '').trim();
                        const choiceId = String(choice.id_store_choice_item || '').trim();
                        const codMaterialChoice = (choiceIntegrationCode && mapaProdutos.get(choiceIntegrationCode))
                            || (choiceId && mapaProdutos.get(choiceId))
                            || null;
                        const vAdicional = parseFloat(choice.aditional_price || 0);

                        if (codMaterialChoice) {
                            rowsSales.push([
                                `saipos-${systemUnitId}-choice-${choice.id_sale_item_choice || randomUUID()}`,
                                createdAtStr,
                                codMaterialChoice,
                                `[Adicional] ${descChoice}`.slice(0, 250),
                                qtd,
                                vAdicional,
                                vAdicional,
                                parseFloat((vAdicional * qtd).toFixed(2)),
                                parseFloat((vAdicional * qtd).toFixed(2)),
                                modoVenda,
                                systemUnitId,
                                String(systemUnitId)
                            ]);
                            totalItensVendidos += qtd;

                            const biChoiceKey = `${shiftDate}_${codMaterialChoice}`;
                            if (!biSalesAgrupados.has(biChoiceKey)) {
                                biSalesAgrupados.set(biChoiceKey, {
                                    data_movimento: `${shiftDate} 00:00:00`,
                                    cod_material: codMaterialChoice,
                                    quantidade: 0,
                                    valor_bruto: 0,
                                    valor_liquido: 0,
                                    custom_code: String(systemUnitId),
                                    system_unit_id: systemUnitId
                                });
                            }
                            const biChoice = biSalesAgrupados.get(biChoiceKey);
                            biChoice.quantidade += qtd;
                            biChoice.valor_bruto += (vAdicional * qtd);
                            biChoice.valor_liquido += (vAdicional * qtd);
                        } else if (choiceId) {
                            produtosFaltantes.set(choiceId, `[Adicional] ${descChoice}`);
                        }
                    }
                }
            }
        }

        // =========================================================================
        // Gravações em Lote com Alta Performance
        // =========================================================================
        if (rowsMovCaixa.length > 0) {
            await batchInsert(conn, 'movimento_caixa', [
                'id', 'num_controle', 'dataAbertura', 'dataFechamento', 'dataContabil',
                'lojaId', 'loja', 'rede', 'vlTotalReceber', 'vlTotalRecebido', 'vlDesconto',
                'vlServicoRecebido', 'numPessoas', 'modoVenda', 'modoVenda2', 'hora', 'cancelado'
            ], rowsMovCaixa);
        }

        if (rowsPagamentos.length > 0) {
            await batchInsert(conn, 'api_pagamentos', [
                'uuid', 'id_operacao', 'id_loja', 'nome_loja', 'num_pedido', 'seq_pedido',
                'data_contabil', 'status_pagamento', 'data_lancamento', 'hora_lancamento',
                'id_m', 'descricao', 'data_vencimento', 'valor', 'valor_liquido',
                'taxa_comissao', 'valor_comissao', 'nsu', 'adquirente', 'autorizacao',
                'id_tipo', 'tipo_pagamento', 'bandeira', 'origem'
            ], rowsPagamentos);
        }

        if (rowsSales.length > 0) {
            await batchInsert(conn, 'sales', [
                'idItemVenda', 'dtLancamento', 'codMaterial', 'descricao', 'quantidade',
                'valorUnitario', 'valorUnitarioLiquido', 'valorLiquido', 'valorBruto',
                'modoVenda', 'system_unit_id', 'custom_code'
            ], rowsSales);
        }

        if (biSalesAgrupados.size > 0) {
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
        }

        // Atualiza status em unit_integracoes
        await conn.execute(`
            UPDATE unit_integracoes
            SET status = 'CONECTADA',
                ultimo_erro = NULL,
                ultima_sincronizacao = NOW(),
                updated_at = NOW()
            WHERE system_unit_id = ? AND provider = 'saipos'
        `, [systemUnitId]);

        await conn.commit();

        log(`✅ [Saipos #${systemUnitId}] Sucesso: ${totalVendasCaixa} vendas, R$ ${totalFaturado.toFixed(2)} faturados, ${totalItensVendidos} itens vendidos, ${biSalesAgrupados.size} produtos consolidados em _bi_sales.`, 'saipos');

        return {
            success: true,
            totalVendasCaixa,
            totalFaturado,
            totalItensVendidos,
            produtosConsolidados: biSalesAgrupados.size,
            produtosNaoMapeados: Array.from(produtosFaltantes.entries()).map(([k, v]) => ({ codigo_pdv: k, nome: v }))
        };

    } catch (err) {
        await conn.rollback();
        throw err;
    }
}

module.exports = {
    ProcessJobSaiposAll,
    ProcessStoreSaipos,
    normalizePaymentMethodSaipos,
    normalizeModoVendaSaipos
};
