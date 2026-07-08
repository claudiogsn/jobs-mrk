require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getConnection, callPHP } = require('../utils/utils');
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { randomUUID } = require('crypto');

const UPLOAD_3LM_DIR = process.env.UPLOAD_3LM_DIR || '/Users/claudiogomes/projects/portal-mrk/api/v1/public/uploads/3lm';

// Helper para converter string BRL (ex: "1.230,50") para float
function parseBRL(val) {
    if (!val) return 0.0;
    val = val.trim();
    val = val.replace(/\./g, '').replace(',', '.');
    const f = parseFloat(val);
    return isNaN(f) ? 0.0 : f;
}

// Limpa aspas e espaços de um campo CSV
function cleanCsvField(val) {
    if (!val) return '';
    return val.trim().replace(/^['"]|['"]$/g, '');
}

// Formata data brasileira (DD/MM/YYYY) para ISO (YYYY-MM-DD)
function formatToISODate(dateStr) {
    if (!dateStr) return null;
    dateStr = dateStr.trim();
    // Se já estiver no formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr;
    }
    // Se estiver no formato DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
        const [day, month, year] = dateStr.split('/');
        return `${year}-${month}-${day}`;
    }
    // Se contiver hora, ex: DD/MM/YYYY HH:mm:ss ou YYYY-MM-DD HH:mm:ss
    const parts = dateStr.split(' ');
    const onlyDate = parts[0];
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(onlyDate)) {
        const [day, month, year] = onlyDate.split('/');
        return `${year}-${month}-${day}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(onlyDate)) {
        return onlyDate;
    }
    return dateStr;
}

function map3lmPaymentType(tipoOperacao, descrPagto) {
    const desc = (descrPagto || '').toUpperCase().trim();
    const oper = (tipoOperacao || '').toUpperCase().trim();

    // 1. Verifica pelo tipoOperacao primeiro
    if (oper === 'VD CRED') {
        return { id_tipo: 3, tipo_pagamento: 'Cartão Crédito' };
    }
    if (oper === 'VD DEB') {
        return { id_tipo: 4, tipo_pagamento: 'Cartão Débito' };
    }
    if (oper === 'PIX') {
        return { id_tipo: 99, tipo_pagamento: 'Outros' };
    }
    if (oper === 'VD VOUCH') {
        return { id_tipo: 11, tipo_pagamento: 'Refeição' };
    }

    // 2. Fallback pela descrição
    if (desc.includes('CRED') || desc.includes('AMEX')) {
        return { id_tipo: 3, tipo_pagamento: 'Cartão Crédito' };
    }
    if (desc.includes('DEB') || desc.includes('DEBITO')) {
        return { id_tipo: 4, tipo_pagamento: 'Cartão Débito' };
    }
    if (desc.includes('PIX')) {
        return { id_tipo: 99, tipo_pagamento: 'Outros' };
    }
    if (desc.includes('DINHEIRO') || desc.includes('MONEY')) {
        return { id_tipo: 1, tipo_pagamento: 'Dinheiro' };
    }
    if (desc.includes('ALELO') || desc.includes('SODEXO') || desc.includes('TICKET') || desc.includes('VOUCH') || desc.includes('VALE')) {
        return { id_tipo: 11, tipo_pagamento: 'Refeição' };
    }

    // Fallback padrão
    return { id_tipo: 99, tipo_pagamento: 'Outros' };
}

async function run(importId) {
    if (!importId) {
        log('❌ Erro no worker: importId ausente.', '3lm_import');
        return;
    }
    let conn = null;
    try {
        conn = await getConnection();

        // 1. Busca a importação específica
        const [rows] = await conn.execute(
            "SELECT id, system_unit_id, usuario_id, nome_arquivo FROM 3lm_imports WHERE id = ?",
            [importId]
        );

        if (rows.length === 0) {
            log(`[3LM Import #${importId}] ⚠️ Importação não encontrada no banco de dados.`, '3lm_import');
            conn.end();
            return;
        }

        const systemUnitId = rows[0].system_unit_id;
        const usuarioId = rows[0].usuario_id;
        const nomeArquivo = rows[0].nome_arquivo;

        log(`[3LM Import #${importId}] 🚀 [Passo 1/6] Localizando e abrindo arquivo ${nomeArquivo} (Unidade: ${systemUnitId})...`, '3lm_import');

        // 2. Reserva a tarefa para evitar duplicidade de execução
        await conn.execute("UPDATE 3lm_imports SET status = 'processando' WHERE id = ?", [importId]);

        const filePath = path.join(UPLOAD_3LM_DIR, `import_${importId}.csv`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Arquivo temporário do CSV não foi encontrado no servidor: ${filePath}`);
        }

        // 3. Lê o CSV
        const csvContent = fs.readFileSync(filePath, 'utf8');
        const lines = csvContent.replace(/\r/g, '').split('\n');

        log(`[3LM Import #${importId}] 📂 [Passo 2/6] Analisando e estruturando dados do CSV (Total de ${lines.length} linhas)...`, '3lm_import');

        if (lines.length < 2) {
            throw new Error("Arquivo CSV está vazio ou não possui registros.");
        }

        // 4. Carrega informações da unidade
        const [unitRows] = await conn.execute("SELECT name, custom_code FROM system_unit WHERE id = ?", [systemUnitId]);
        if (unitRows.length === 0) {
            throw new Error(`Unidade ${systemUnitId} não foi encontrada.`);
        }
        const unitName = unitRows[0].name;
        const customCode = unitRows[0].custom_code || String(systemUnitId);

        // 5. Carrega mapeamento de produtos (de-para)
        const [prodRows] = await conn.execute("SELECT codigo, codigo_pdv FROM products WHERE system_unit_id = ?", [systemUnitId]);
        const mapaCodigos = {};
        prodRows.forEach(p => {
            const codigoInterno = parseInt(p.codigo);
            const codigoPdv = (p.codigo_pdv || '').trim();
            if (codigoPdv !== '') {
                mapaCodigos[codigoPdv] = codigoInterno;
            }
            mapaCodigos[String(codigoInterno)] = codigoInterno;
        });

        // 6. Faz o parse de dados das linhas do CSV
        const orders = {};
        const produtosFaltantes = {};
        let isFirstLine = true;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line === '') continue;

            // Remove UTF-8 BOM se presente na primeira linha
            if (isFirstLine && line.charCodeAt(0) === 0xFEFF) {
                line = line.substring(1);
            }

            const row = line.split(';').map(cleanCsvField);

            if (isFirstLine) {
                isFirstLine = false;
                continue; // Pula o cabeçalho
            }

            const padRow = row.concat(Array(46).fill('')).slice(0, 46);

            const dataCaixa = formatToISODate(padRow[0]);
            const notaFiscal = padRow[3];

            if (!dataCaixa || !notaFiscal) {
                continue;
            }

            const codProduto = padRow[16];
            const descProduto = padRow[17];
            const quantidade = parseBRL(padRow[18]);
            const valorBruto = parseBRL(padRow[19]);
            const descontoItem = parseBRL(padRow[45]);
            const valorItemLiquido = valorBruto - descontoItem;
            const valorUnitario = quantidade > 0 ? (valorBruto / quantidade) : 0.0;

            const dataHoraEmissao = dataCaixa;
            const horaAbert = padRow[1];

            const codPagto = padRow[30];
            const descrPagto = padRow[31];
            const valorPagto = parseBRL(padRow[32]);
            const operadora = padRow[33];
            const tipoOperacao = padRow[34];
            const nsu = padRow[35];
            const autorizacao = padRow[36];

            const chaveUnique = notaFiscal;

            if (!orders[chaveUnique]) {
                orders[chaveUnique] = {
                    data_caixa: dataCaixa,
                    dt_emissao: dataHoraEmissao,
                    hora_abert: horaAbert,
                    num_nota: notaFiscal,
                    val_total_nota: 0.0,
                    items: {},
                    payments: {}
                };
            }

            // Agrupa itens únicos
            const itemKey = `${codProduto}-${quantidade}-${valorBruto}-${descontoItem}`;
            if (!orders[chaveUnique].items[itemKey]) {
                orders[chaveUnique].items[itemKey] = {
                    cod_produto: codProduto,
                    descricao: descProduto,
                    quantidade: quantidade,
                    valor_unitario: valorUnitario,
                    valor_item: valorBruto,
                    desconto_item: descontoItem,
                    valor_liquido: valorItemLiquido
                };
                orders[chaveUnique].val_total_nota += valorItemLiquido;
            }

            // Agrupa pagamentos únicos
            const pagKey = `${codPagto}-${valorPagto}-${nsu}-${autorizacao}`;
            if (!orders[chaveUnique].payments[pagKey] && valorPagto > 0) {
                orders[chaveUnique].payments[pagKey] = {
                    cod_pagto: codPagto,
                    descr_pagto: descrPagto,
                    valor_pagto: valorPagto,
                    operadora: operadora,
                    nsu: nsu,
                    autorizacao: autorizacao,
                    tipo_operacao: tipoOperacao
                };
            }
        }

        const listOrders = Object.values(orders);
        log(`[3LM Import #${importId}] 🧠 [Passo 3/6] Estruturação concluída: ${listOrders.length} notas fiscais identificadas.`, '3lm_import');

        const datasParaProcessarEstoque = new Set();
        let totalVendasCalculado = 0.0;
        let totalNotasImportadas = listOrders.length;
        let dataInicioFaturamento = null;
        let dataFimFaturamento = null;

        for (const order of listOrders) {
            const dataContabil = order.data_caixa;
            datasParaProcessarEstoque.add(dataContabil);
            totalVendasCalculado += order.val_total_nota;

            if (!dataInicioFaturamento || dataContabil < dataInicioFaturamento) dataInicioFaturamento = dataContabil;
            if (!dataFimFaturamento || dataContabil > dataFimFaturamento) dataFimFaturamento = dataContabil;
        }

        const datasArray = Array.from(datasParaProcessarEstoque);

        // 7. Inicia transação no MySQL
        log(`[3LM Import #${importId}] 🔒 [Passo 4/6] Iniciando transação MySQL e limpando dados anteriores em lote...`, '3lm_import');
        await conn.beginTransaction();

        if (datasArray.length > 0) {
            const placeholders = datasArray.map(() => '?').join(',');

            log(`[3LM Import #${importId}]   -> Limpando em lote da tabela sales (${datasArray.length} datas)...`, '3lm_import');
            await conn.execute(`
                DELETE FROM sales 
                WHERE system_unit_id = ? 
                  AND dtLancamento IN (${placeholders}) 
                  AND idItemVenda LIKE '3lm-%'
            `, [systemUnitId, ...datasArray]);

            log(`[3LM Import #${importId}]   -> Limpando em lote da tabela movimento_caixa...`, '3lm_import');
            await conn.execute(`
                DELETE FROM movimento_caixa 
                WHERE lojaId = ? 
                  AND dataContabil IN (${placeholders}) 
                  AND num_controle LIKE '3lm-%'
            `, [customCode.toString(), ...datasArray]);

            log(`[3LM Import #${importId}]   -> Limpando em lote da tabela api_pagamentos...`, '3lm_import');
            await conn.execute(`
                DELETE FROM api_pagamentos 
                WHERE id_loja = ? 
                  AND data_contabil IN (${placeholders}) 
                  AND id_operacao LIKE '3lm-%'
            `, [customCode.toString(), ...datasArray]);
        }

        let orderCount = 0;
        for (const order of listOrders) {
            orderCount++;
            const notaFiscal = order.num_nota;
            const dataContabil = order.data_caixa;
            const idOperacao = `3lm-${systemUnitId}-${notaFiscal}`;

            // Log de progresso estruturado
            if (orderCount === 1 || orderCount === listOrders.length || orderCount % 50 === 0) {
                log(`[3LM Import #${importId}]   -> Gravando no banco: Nota ${orderCount} de ${listOrders.length} (NF: ${notaFiscal}, Data: ${dataContabil})...`, '3lm_import');
            }

            // 7.2. Grava pagamentos
            const paymentsList = Object.values(order.payments);
            let payIndex = 0;
            for (const pay of paymentsList) {
                payIndex++;
                const payUuid = randomUUID();
                const paymentMapping = map3lmPaymentType(pay.tipo_operacao, pay.descr_pagto);

                await conn.execute(`
                    INSERT INTO api_pagamentos (
                        uuid, id_operacao, id_loja, nome_loja, num_pedido, seq_pedido, 
                        data_contabil, status_pagamento, data_lancamento, hora_lancamento, 
                        id_m, descricao, data_vencimento, valor, valor_liquido, 
                        nsu, adquirente, autorizacao, id_tipo, tipo_pagamento, origem
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '3LM')
                `, [
                    payUuid,
                    idOperacao,
                    customCode.toString(),
                    unitName,
                    parseInt(notaFiscal),
                    payIndex,
                    dataContabil,
                    'finalizado',
                    dataContabil,
                    order.hora_abert || '00:00:00',
                    parseInt(pay.cod_pagto),
                    pay.descr_pagto,
                    dataContabil,
                    pay.valor_pagto,
                    pay.valor_pagto,
                    pay.nsu || null,
                    pay.operadora || null,
                    pay.autorizacao || null,
                    paymentMapping.id_tipo,
                    paymentMapping.tipo_pagamento
                ]);
            }

            // 7.3. Grava itens de venda
            const itemsList = Object.values(order.items);
            let itemIndex = 0;
            for (const item of itemsList) {
                itemIndex++;
                const codExterno = item.cod_produto;
                let codMaterial = parseInt(codExterno);

                // De-para de códigos
                if (mapaCodigos[codExterno] !== undefined) {
                    codMaterial = mapaCodigos[codExterno];
                } else {
                    produtosFaltantes[codExterno] = item.descricao;
                }

                const idItemVenda = `3lm-${systemUnitId}-${notaFiscal}-${codMaterial}-${itemIndex}`;
                const valorBruto = item.valor_item;
                const quantidade = item.quantidade;
                const descontoItem = item.desconto_item;
                const valorLiquido = valorBruto - descontoItem;
                const valorUnitario = quantidade > 0 ? (valorBruto / quantidade) : 0.0;
                const valorUnitarioLiquido = quantidade > 0 ? (valorLiquido / quantidade) : 0.0;

                await conn.execute(`
                    INSERT INTO sales (
                        idItemVenda, system_unit_id, valorBruto, valorUnitario, valorUnitarioLiquido, 
                        valorLiquido, modoVenda, quantidade, unidade, lojaId, idMaterial, codMaterial, 
                        descricao, grupo__idGrupo, grupo__descricao, __nfNumeroC, dtLancamento, custom_code
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    idItemVenda,
                    systemUnitId,
                    valorBruto,
                    valorUnitario,
                    valorUnitarioLiquido,
                    valorLiquido,
                    'BALCAO',
                    quantidade,
                    'UND',
                    customCode.toString(),
                    codMaterial,
                    codMaterial,
                    item.descricao,
                    999,
                    'IMPORTACAO 3LM',
                    parseInt(notaFiscal),
                    `${dataContabil} ${order.hora_abert || '00:00:00'}`,
                    customCode
                ]);
            }

            // 7.4. Grava movimento_caixa
            const somaPagamentos = paymentsList.reduce((acc, p) => acc + p.valor_pagto, 0.0);
            const somaDescontos = itemsList.reduce((acc, i) => acc + i.desconto_item, 0.0);
            const somaBruto = itemsList.reduce((acc, i) => acc + i.valor_item, 0.0);

            await conn.execute(`
                INSERT INTO movimento_caixa (
                    id, num_controle, dataAbertura, dataContabil, 
                    lojaId, loja, vlTotalReceber, vlTotalRecebido, vlDesconto, rede,
                    cancelado, numPessoas, modoVenda2
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '3LM PDV', 0, 1, 'BALCAO')
            `, [
                idOperacao,
                idOperacao,
                `${dataContabil} ${order.hora_abert || '00:00:00'}`,
                dataContabil,
                customCode.toString(),
                unitName,
                somaBruto,
                somaPagamentos,
                somaDescontos
            ]);
        }

        // 7.5. Registra produtos faltantes em alertas (como notificações do Adianti)
        log(`[3LM Import #${importId}] ⚠️ [Passo 5/6] Analisando produtos sem mapeamento de-para...`, '3lm_import');
        if (usuarioId) {
            const dtMsg = DateTime.now().setZone('America/Sao_Paulo').toFormat('yyyy-MM-dd HH:mm:ss');
            for (const [codExt, nomeProd] of Object.entries(produtosFaltantes)) {
                const titleAlert = `Produto 3LM Sem De-para: ${nomeProd}`;
                const [alertCheck] = await conn.execute(
                    "SELECT id FROM system_notification WHERE system_user_to_id = ? AND subject = ? AND checked = 'N'",
                    [usuarioId, titleAlert]
                );

                if (alertCheck.length === 0) {
                    const [[maxIdRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_notification");
                    const nextNotifId = maxIdRow.nextId;

                    // 1. Grava no sininho do Adianti (system_notification)
                    await conn.execute(`
                        INSERT INTO system_notification (
                            id, system_user_id, system_user_to_id, subject, message, dt_message, action_url, action_label, icon, checked
                        ) VALUES (?, 1, ?, ?, ?, ?, 'index.php?class=SystemUnitAlertList', 'Ver Alertas', 'fas:exclamation-triangle text-warning', 'N')
                    `, [
                        nextNotifId,
                        usuarioId,
                        titleAlert,
                        `O produto "${nomeProd}" (Código 3LM: ${codExt}) foi importado mas não possui mapeamento com código interno.`,
                        dtMsg
                    ]);

                    // 2. Grava na tabela customizada mrk_alerts do Portal
                    await conn.execute(`
                        INSERT INTO mrk_alerts (system_unit_id, title, message, type, category, active)
                        VALUES (?, ?, ?, 'warning', 'integracao_pdv', 'Y')
                    `, [
                        systemUnitId,
                        titleAlert,
                        `O produto "${nomeProd}" (Código 3LM: ${codExt}) foi importado mas não possui mapeamento com código interno.`
                    ]);
                }
            }
        }

        await conn.commit();
        log(`[3LM Import #${importId}] 💾 Gravado com sucesso no MySQL (Vendas, Pagamentos e Caixas).`, '3lm_import');

        // 8. Processamento assíncrono de estoque e BI via chamadas HTTP (para reuso do PHP)
        log(`[3LM Import #${importId}] ⚡ [Passo 6/6] Sincronizando estoque e BI (Processando ${datasArray.length} datas no backend PHP)...`, '3lm_import');

        for (const dataRef of datasArray) {
            try {
                log(`[3LM Import #${importId}]   -> Sincronizando estoque para a data ${dataRef}...`, '3lm_import');
                await callPHP('importMovBySalesCons', { system_unit_id: systemUnitId, data: dataRef });
            } catch (errEstoque) {
                log(`[3LM Import #${importId}] ⚠️ Falha na consolidação de estoque da data ${dataRef}: ${errEstoque.message}`, '3lm_import');
            }
        }

        // 9. Consolida faturamento de BI
        if (dataInicioFaturamento && dataFimFaturamento) {
            log(`[3LM Import #${importId}]   -> Sincronizando BI para o período de ${dataInicioFaturamento} a ${dataFimFaturamento}...`, '3lm_import');
            try {
                await callPHP('consolidateSalesByUnit', {
                    system_unit_id: systemUnitId,
                    dt_inicio: dataInicioFaturamento,
                    dt_fim: dataFimFaturamento
                });
            } catch (errBi) {
                log(`[3LM Import #${importId}] ⚠️ Falha na consolidação do BI: ${errBi.message}`, '3lm_import');
            }
        }

        // 10. Atualiza o status da importação para sucesso
        await conn.execute(`
            UPDATE 3lm_imports 
            SET status = 'sucesso', 
                total_vendas = ?, 
                total_notas = ?, 
                data_inicio_faturamento = ?, 
                data_fim_faturamento = ? 
            WHERE id = ?
        `, [totalVendasCalculado, totalNotasImportadas, dataInicioFaturamento, dataFimFaturamento, importId]);

        // Remove arquivo físico
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        log(`[3LM Import #${importId}] 🔔 Gerando notificação no painel do usuário...`, '3lm_import');

        // 11. Envia notificação no Adianti
        if (usuarioId) {
            const dtMsg = DateTime.now().setZone('America/Sao_Paulo').toFormat('yyyy-MM-dd HH:mm:ss');
            const [[maxIdRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_notification");
            const nextId = maxIdRow.nextId;

            await conn.execute(`
                INSERT INTO system_notification (
                    id, system_user_id, system_user_to_id, subject, message, dt_message, action_url, action_label, icon, checked
                ) VALUES (?, 1, ?, ?, ?, ?, 'index.php?class=Importador3lmList&method=onReload', 'Visualizar no Portal', 'far:check-circle text-success', 'N')
            `, [
                nextId,
                usuarioId,
                'Importação 3LM Concluída!',
                `A planilha de faturamento '${nomeArquivo}' foi processada com sucesso. Total de ${totalNotasImportadas} notas importadas.`,
                dtMsg
            ]);
        }

        log(`[3LM Import #${importId}] Processamento concluído com sucesso.`, '3lm_import');
        conn.end();

    } catch (error) {
        log(`[3LM Import] ❌ Erro durante processamento: ${error.message}`, '3lm_import');
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
            
            try {
                const [rows] = await conn.execute(
                    "SELECT id, usuario_id, nome_arquivo FROM 3lm_imports WHERE status = 'processando' ORDER BY id DESC LIMIT 1"
                );
                if (rows.length > 0) {
                    const errorImportId = rows[0].id;
                    const errorUser = rows[0].usuario_id;
                    const errorFile = rows[0].nome_arquivo;

                    await conn.execute("UPDATE 3lm_imports SET status = 'erro', mensagem_erro = ? WHERE id = ?", [error.message, errorImportId]);
                    
                    const errorFilePath = path.join(UPLOAD_3LM_DIR, `import_${errorImportId}.csv`);
                    if (fs.existsSync(errorFilePath)) {
                        fs.unlinkSync(errorFilePath);
                    }

                    if (errorUser) {
                        const [[maxIdRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_notification");
                        const nextId = maxIdRow.nextId;

                        await conn.execute(`
                            INSERT INTO system_notification (
                                id, system_user_id, system_user_to_id, subject, message, dt_message, action_url, action_label, icon, checked
                            ) VALUES (?, 1, ?, ?, ?, NOW(), 'index.php?class=Importador3lmList', 'Ver Detalhes', 'fas:exclamation-triangle text-danger', 'N')
                        `, [
                            nextId,
                            errorUser,
                            'Erro na Importação 3LM',
                            `Falha ao processar a planilha '${errorFile}': ${error.message}`
                        ]);
                    }
                }
            } catch (errDb) {
                log(`[3LM Import] ❌ Falha crítica ao salvar status de erro no MySQL: ${errDb.message}`, '3lm_import');
            }
        }
    }
}

async function runExclusao(importId, systemUnitId) {
    if (!importId || !systemUnitId) {
        log('❌ Erro no worker de exclusão: importId ou systemUnitId ausente.', '3lm_import');
        return;
    }
    let conn = null;
    try {
        conn = await getConnection();

        // 1. Busca a importação para obter período e nome do arquivo
        const [rows] = await conn.execute(
            "SELECT data_inicio_faturamento, data_fim_faturamento, nome_arquivo, usuario_id FROM 3lm_imports WHERE id = ? AND system_unit_id = ?",
            [importId, systemUnitId]
        );

        if (rows.length === 0) {
            log(`[3LM Exclusão #${importId}] ⚠️ Importação não encontrada no banco de dados.`, '3lm_import');
            conn.end();
            return;
        }

        const dataInicio = rows[0].data_inicio_faturamento;
        const dataFim = rows[0].data_fim_faturamento;
        const nomeArquivo = rows[0].nome_arquivo;
        const usuarioId = rows[0].usuario_id;

        // 2. Busca custom_code e name da unidade
        const [units] = await conn.execute("SELECT name, custom_code FROM system_unit WHERE id = ?", [systemUnitId]);
        if (units.length === 0) {
            log(`[3LM Exclusão #${importId}] ⚠️ Unidade ${systemUnitId} não encontrada.`, '3lm_import');
            conn.end();
            return;
        }

        const unitName = units[0].name;
        const customCode = units[0].custom_code || systemUnitId.toString();

        log(`[3LM Exclusão #${importId}] 🚀 Iniciando exclusão assíncrona da importação ${nomeArquivo}...`, '3lm_import');

        // Formata as datas para YYYY-MM-DD
        let formattedDataInicio = null;
        let formattedDataFim = null;
        if (dataInicio) {
            formattedDataInicio = dataInicio instanceof Date 
                ? DateTime.fromJSDate(dataInicio).toISODate() 
                : formatToISODate(dataInicio.toString());
        }
        if (dataFim) {
            formattedDataFim = dataFim instanceof Date 
                ? DateTime.fromJSDate(dataFim).toISODate() 
                : formatToISODate(dataFim.toString());
        }

        // Se não tiver datas, não há registros associados para excluir nas outras tabelas, podemos apenas remover o metadado
        if (formattedDataInicio && formattedDataFim) {
            log(`[3LM Exclusão #${importId}] 🔒 Iniciando transação para limpar dados do período ${formattedDataInicio} a ${formattedDataFim}...`, '3lm_import');
            await conn.beginTransaction();

            // 2.1. Deleta da api_pagamentos
            log(`[3LM Exclusão #${importId}]   -> Removendo registros da api_pagamentos...`, '3lm_import');
            await conn.execute(`
                DELETE FROM api_pagamentos 
                WHERE id_loja = ? 
                  AND data_contabil BETWEEN ? AND ? 
                  AND origem = '3LM'
            `, [customCode.toString(), formattedDataInicio, formattedDataFim]);

            // 2.2. Deleta da movimento_caixa
            log(`[3LM Exclusão #${importId}]   -> Removendo registros da movimento_caixa...`, '3lm_import');
            await conn.execute(`
                DELETE FROM movimento_caixa 
                WHERE lojaId = ? 
                  AND dataContabil BETWEEN ? AND ? 
                  AND rede = '3LM PDV'
            `, [customCode.toString(), formattedDataInicio, formattedDataFim]);

            // 2.3. Deleta da sales
            log(`[3LM Exclusão #${importId}]   -> Removendo registros da sales...`, '3lm_import');
            await conn.execute(`
                DELETE FROM sales 
                WHERE system_unit_id = ? 
                  AND dtLancamento BETWEEN ? AND ? 
                  AND idItemVenda LIKE '3lm-%'
            `, [systemUnitId, `${formattedDataInicio} 00:00:00`, `${formattedDataFim} 23:59:59`]);

            // 2.4. Deleta da _bi_sales
            log(`[3LM Exclusão #${importId}]   -> Removendo registros da _bi_sales...`, '3lm_import');
            await conn.execute(`
                DELETE FROM _bi_sales 
                WHERE system_unit_id = ? 
                  AND data_movimento BETWEEN ? AND ? 
                  AND custom_code = ?
            `, [systemUnitId, `${formattedDataInicio} 00:00:00`, `${formattedDataFim} 23:59:59`, customCode]);

            await conn.commit();
            log(`[3LM Exclusão #${importId}] 💾 Dados limpos do banco de dados com sucesso.`, '3lm_import');

            // 3. Sincroniza estoque e BI (Processando datas no backend PHP)
            log(`[3LM Exclusão #${importId}] ⚡ Iniciando sincronização pós-exclusão...`, '3lm_import');

            // Gera lista de datas no período para sincronizar estoque
            const start = DateTime.fromISO(formattedDataInicio);
            const end = DateTime.fromISO(formattedDataFim);
            const diffDays = Math.round(end.diff(start, 'days').days);
            const datasArray = [];
            for (let i = 0; i <= diffDays; i++) {
                datasArray.push(start.plus({ days: i }).toISODate());
            }

            for (const dataRef of datasArray) {
                try {
                    log(`[3LM Exclusão #${importId}]   -> Sincronizando estoque para a data ${dataRef}...`, '3lm_import');
                    await callPHP('importMovBySalesCons', { system_unit_id: systemUnitId, data: dataRef });
                } catch (errEstoque) {
                    log(`[3LM Exclusão #${importId}] ⚠️ Falha na consolidação de estoque da data ${dataRef}: ${errEstoque.message}`, '3lm_import');
                }
            }

            // Sincroniza BI
            try {
                log(`[3LM Exclusão #${importId}]   -> Sincronizando BI para o período de ${formattedDataInicio} a ${formattedDataFim}...`, '3lm_import');
                await callPHP('consolidateSalesByUnit', {
                    system_unit_id: systemUnitId,
                    dt_inicio: `${formattedDataInicio} 00:00:00`,
                    dt_fim: `${formattedDataFim} 23:59:59`
                });
            } catch (errBi) {
                log(`[3LM Exclusão #${importId}] ⚠️ Falha na consolidação do BI pós-exclusão: ${errBi.message}`, '3lm_import');
            }
        }

        // 4. Remove a importação da tabela 3lm_imports e o arquivo CSV
        await conn.execute("DELETE FROM 3lm_imports WHERE id = ?", [importId]);

        const filePath = path.join(UPLOAD_3LM_DIR, `import_${importId}.csv`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        log(`[3LM Exclusão #${importId}] 🔔 Gerando notificação de exclusão no painel do usuário...`, '3lm_import');
        if (usuarioId) {
            const dtMsg = DateTime.now().setZone('America/Sao_Paulo').toFormat('yyyy-MM-dd HH:mm:ss');
            const [[maxIdRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_notification");
            const nextId = maxIdRow.nextId;

            await conn.execute(`
                INSERT INTO system_notification (
                    id, system_user_id, system_user_to_id, subject, message, dt_message, action_url, action_label, icon, checked
                ) VALUES (?, 1, ?, ?, ?, ?, 'index.php?class=Importador3lmList', 'Visualizar no Portal', 'far:check-circle text-success', 'N')
            `, [
                nextId,
                usuarioId,
                'Exclusão 3LM Concluída',
                `Os dados da planilha de faturamento '${nomeArquivo}' foram completamente excluídos com sucesso.`,
                dtMsg
            ]);
        }

        log(`[3LM Exclusão #${importId}] Processo concluído com sucesso.`, '3lm_import');
        conn.end();

    } catch (error) {
        log(`[3LM Exclusão] ❌ Erro durante a exclusão: ${error.message}`, '3lm_import');
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
            
            // Caso ocorra erro, atualiza a importação para status = 'erro' com a mensagem de erro
            try {
                await conn.execute("UPDATE 3lm_imports SET status = 'erro', mensagem_erro = ? WHERE id = ?", [error.message, importId]);
            } catch (errDb) {
                log(`[3LM Exclusão] ❌ Falha crítica ao salvar status de erro da exclusão no MySQL: ${errDb.message}`, '3lm_import');
            }
            conn.end();
        }
    }
}

module.exports = { 
    run3lmImportById: run,
    run3lmExclusaoById: runExclusao
};
