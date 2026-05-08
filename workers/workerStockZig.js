require('dotenv').config();
const { DateTime } = require('luxon');
const { callPHP, getZig } = require('../utils/utils');
const { log } = require('../utils/logger');

async function ProcessJobStockZig(group_id, data) {
    const lojas = await callPHP('getUnitsIntegrationZigStock', { group_id });

    if (!Array.isArray(lojas) || lojas.length === 0) {
        log(`⚠️ Nenhuma loja encontrada para o grupo ${group_id} no dia ${data}`, 'workerStockZig');
        return;
    }

    for (const loja of lojas) {
        const lojaId = loja.lojaId;
        const system_unit_id = loja.system_unit_id;
        const tokenZig = loja.token_zig;

        if (!lojaId || !tokenZig || !system_unit_id) {
            log(`⚠️ Dados faltando para loja: ${JSON.stringify(loja)}`, 'workerStockZig');
            continue;
        }

        // Mapeamento SKU -> Código
        const produtos = await callPHP('getProdutosComSkuZig', { system_unit_id });
        const mapaProdutos = {};
        for (const produto of produtos) {
            mapaProdutos[produto.sku_zig] = parseInt(produto.codigo);
        }

        const saidas = await getZig('saida-produtos', lojaId, data, data, tokenZig);

        if (!Array.isArray(saidas) || saidas.length === 0) {
            log(`ℹ️ Sem saída-produtos para loja ${lojaId} no dia ${data}`, 'workerStockZig');
            continue;
        }

        const agrupados = {};

        // NOVO: Objeto para guardar os SKUs que falharam no mapeamento
        const skusNaoMapeados = {};

        for (const item of saidas) {
            const sku = item.productSku;

            // Verifica se o produto não tem SKU ou se o SKU não está mapeado no Portal MRK
            if (!sku || !mapaProdutos[sku]) {
                if (sku && !skusNaoMapeados[sku]) {
                    // Guarda o SKU e o nome (ajuste 'productName' se a API da Zig retornar com outro nome)
                    skusNaoMapeados[sku] = item.productName || 'Sem nome na Zig';
                }
                continue;
            }

            const qtd = parseInt(item.count ?? 0);
            const valorUnit = parseFloat(item.unitValue ?? 0) / 100;
            const desconto = parseFloat(item.discountValue ?? 0) / 100;

            if (!agrupados[sku]) {
                agrupados[sku] = {
                    cod_material: mapaProdutos[sku],
                    quantidade: 0,
                    valor_unitario: valorUnit,
                    valor_bruto: 0,
                    valor_liquido: 0
                };
            }

            agrupados[sku].quantidade += qtd;
            agrupados[sku].valor_bruto += valorUnit * qtd;
            agrupados[sku].valor_liquido += (valorUnit - desconto) * qtd;
        }

        const inserts = Object.values(agrupados).map(item => ({
            data_movimento: `${data} 00:00:00`,
            cod_material: item.cod_material,
            quantidade: item.quantidade,
            valor_bruto: parseFloat(item.valor_bruto.toFixed(2)),
            valor_unitario: parseFloat(item.valor_unitario.toFixed(2)),
            valor_unitario_liquido: parseFloat((item.valor_liquido / item.quantidade).toFixed(2)),
            valor_liquido: parseFloat(item.valor_liquido.toFixed(2)),
            custom_code: lojaId,
            system_unit_id
        }));

        for (const registro of inserts) {
            const res = await callPHP('upsertBiSalesZig', registro);
            log(`📦 Produto ${registro.cod_material} - Loja ${lojaId} em ${data}: ${res?.message || 'registro inserido/atualizado'}`, 'workerStockZig');
        }

        const listaNaoMapeados = Object.keys(skusNaoMapeados);
        if (listaNaoMapeados.length > 0) {
            const alertasPayload = listaNaoMapeados.map(sku => ({
                sku: sku,
                nome: skusNaoMapeados[sku]
            }));

            await callPHP('registerZigAlerts', {
                system_unit_id: system_unit_id,
                alertas: alertasPayload
            });

            log(`⚠️ Gerados ${listaNaoMapeados.length} alertas de produtos não mapeados para a loja ${lojaId}`, 'workerStockZig');
        }
    }
}

async function ExecuteJobStockZig(dt_inicio, dt_fim) {
    const hoje = DateTime.now().toISODate();
    const ontem = DateTime.now().minus({ days: 1 }).toISODate();

    if (!dt_inicio || !dt_fim) {
        dt_inicio = ontem;
        dt_fim = hoje;
    }

    const start = DateTime.fromISO(dt_inicio);
    const end = DateTime.fromISO(dt_fim);

    const grupos = await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'workerStockZig');
        return;
    }

    for (const grupo of grupos) {
        const group_id = grupo.id;
        log(`Start: ${start.toISODate()} - End: ${end.toISODate()}`);
        log(`⏱️ Início do processamento às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerStockZig');

        for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
            const data = cursor.toFormat('yyyy-MM-dd');
            await ProcessJobStockZig(group_id, data);
            log(`✅ Dia ${data} processado para o grupo ${group_id}`, 'workerStockZig');
        }

        log(`✅ Grupo ${group_id} finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerStockZig');
    }
}

module.exports = { ExecuteJobStockZig, ProcessJobStockZig };

if (require.main === module) {
    ExecuteJobStockZig();
}