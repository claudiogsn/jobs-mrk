// workers/WorkerConsolidationStock.js
require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const mysql = require('mysql2/promise');
const { callPHP } = require('../utils/utils');

// Data padrão = ontem (YYYY-MM-DD)
function getTargetDate(data_ref) {
    if (data_ref) return data_ref;
    return DateTime.now().minus({ days: 1 }).toFormat('yyyy-MM-dd');
}

/**
 * Consolida estoque para UM produto em UMA unidade e UMA data
 */
async function consolidarProduto(conn, { system_unit_id, dataRef, produtoCodigo }) {
    // 1) Info atual do produto (saldo atual)
    const [prodRows] = await conn.execute(
        `SELECT nome, saldo, preco_custo, categoria
         FROM products
         WHERE system_unit_id = ? AND codigo = ?`,
        [system_unit_id, produtoCodigo]
    );

    if (!prodRows.length) {
        // Produto não existe mais na tabela, ignora
        return;
    }

    const produto = prodRows[0];
    const nome_produto = produto.nome || 'Produto Desconhecido';
    const saldoAtual = parseFloat(produto.saldo ?? 0);

    // 2) Último balanço do dia (contagem realizada)
    const [balancoRows] = await conn.execute(
        `SELECT doc, quantidade
           FROM movimentacao
          WHERE data = ?
            AND system_unit_id = ?
            AND status = 1
            AND tipo = 'b'
            AND produto = ?
          ORDER BY id DESC
          LIMIT 1`,
        [dataRef, system_unit_id, produtoCodigo]
    );

    let contagemRealizada = null;
    let docBalanco = null;

    if (balancoRows.length) {
        contagemRealizada = parseFloat(balancoRows[0].quantidade ?? 0);
        docBalanco = balancoRows[0].doc || null;
    }

    // 3) Entradas do dia
    const [[entradasRow]] = await conn.execute(
        `SELECT SUM(quantidade) AS total
           FROM movimentacao
          WHERE data = ?
            AND system_unit_id = ?
            AND status = 1
            AND tipo_mov = 'entrada'
            AND produto = ?`,
        [dataRef, system_unit_id, produtoCodigo]
    );
    const entradas = parseFloat(entradasRow?.total ?? 0);

    // 4) Saídas do dia
    const [[saidasRow]] = await conn.execute(
        `SELECT SUM(quantidade) AS total
           FROM movimentacao
          WHERE data = ?
            AND system_unit_id = ?
            AND status = 1
            AND tipo_mov = 'saida'
            AND produto = ?`,
        [dataRef, system_unit_id, produtoCodigo]
    );
    const saidas = parseFloat(saidasRow?.total ?? 0);

    // 5) Cálculos
    const saldo_anterior = saldoAtual; // saldo antes de aplicar o dia
    const contagem_ideal = saldo_anterior + entradas - saidas;

    let contagem_realizada;
    let diferenca;
    let novoSaldo;
    let docParaRegistro = docBalanco;

    if (contagemRealizada !== null) {
        // Teve balanço → usa contagem como saldo real
        contagem_realizada = contagemRealizada;
        diferenca = contagem_realizada - contagem_ideal;
        novoSaldo = contagem_realizada;
    } else {
        // Não teve balanço → segue o fluxo teórico
        contagem_realizada = contagem_ideal;
        diferenca = 0;
        novoSaldo = contagem_ideal;
        docParaRegistro = null; // sem doc específico
    }

    // 6) Grava em diferencas_estoque (pode sobrescrever)
    await conn.execute(
        `INSERT INTO diferencas_estoque (
            data, system_unit_id, doc, produto, nome_produto,
            saldo_anterior, entradas, saidas,
            contagem_ideal, contagem_realizada, diferenca
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            nome_produto       = VALUES(nome_produto),
            saldo_anterior     = VALUES(saldo_anterior),
            entradas           = VALUES(entradas),
            saidas             = VALUES(saidas),
            contagem_ideal     = VALUES(contagem_ideal),
            contagem_realizada = VALUES(contagem_realizada),
            diferenca          = VALUES(diferenca),
            updated_at         = CURRENT_TIMESTAMP`,
        [
            dataRef,
            system_unit_id,
            docParaRegistro,
            produtoCodigo,
            nome_produto,
            saldo_anterior,
            entradas,
            saidas,
            contagem_ideal,
            contagem_realizada,
            diferenca
        ]
    );

    // 7) A atualização oficial do saldo em products foi centralizada no WorkerRecalcularSaldos (05:15),
    // garantindo o recálculo contábil exato a partir do marco zero (Balanço ou Ajuste).
    // O WorkerConsolidationStock mantém exclusivamente a geração analítica de diferencas_estoque para relatórios/CMV.
}

/**
 * processConsolidation
 *  - Recebe group_id e data_ref
 *  - Lista unidades via getUnitsByGroup
 *  - Para cada unidade, consolida todos os produtos com movimentação naquele dia
 */
async function processConsolidationStock({ group_id, data_ref } = {}) {
    const groupId = parseInt(group_id ?? process.env.GROUP_ID);
    const dataRef = getTargetDate(data_ref);

    if (!groupId) {
        log('❌ group_id não informado para processConsolidation', 'WorkerConsolidationStock');
        return;
    }

    log(`▶️ Iniciando consolidação de estoque | Grupo: ${groupId} | Data: ${dataRef}`, 'WorkerConsolidationStock');

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        dateStrings: true
    });

    try {
        // Pega unidades do grupo
        const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });

        if (!Array.isArray(unidades) || unidades.length === 0) {
            log(`⚠️ Nenhuma unidade encontrada para o grupo ${groupId}`, 'WorkerConsolidationStock');
            return;
        }

        for (const unidade of unidades) {
            const system_unit_id = unidade.system_unit_id || unidade.id;
            const name = unidade.name || unidade.nome || unidade.descricao || `Unidade ${system_unit_id}`;

            // 🔒 1) Verifica se JÁ EXISTE consolidação para essa data/unidade
            const [[jaConsolidado]] = await conn.execute(
                `SELECT COUNT(*) AS total
                 FROM diferencas_estoque
                 WHERE data = ?
                   AND system_unit_id = ?`,
                [dataRef, system_unit_id]
            );

            if (Number(jaConsolidado?.total || 0) > 0) {
                log(
                    `⏭️ Unidade ${name} (${system_unit_id}) já consolidada em ${dataRef} (${jaConsolidado.total} registros em diferencas_estoque). Pulando...`,
                    'WorkerConsolidationStock'
                );
                continue; // NÃO consolida de novo essa unidade
            }

            log(
                `🔍 Consolidação estoque | Unidade: ${name} (${system_unit_id}) | Data: ${dataRef}`,
                'WorkerConsolidationStock'
            );

            // 2) Produtos com movimentação no dia
            const [prodRows] = await conn.execute(
                `SELECT DISTINCT produto
           FROM movimentacao
          WHERE data = ?
            AND system_unit_id = ?
            AND status = 1`,
                [dataRef, system_unit_id]
            );

            if (!prodRows.length) {
                log(`ℹ️ Nenhuma movimentação em ${dataRef} para unidade ${name}`, 'WorkerConsolidationStock');
                continue;
            }

            let count = 0;
            for (const row of prodRows) {
                const produtoCodigo = row.produto;
                if (!produtoCodigo) continue;

                try {
                    await consolidarProduto(conn, { system_unit_id, dataRef, produtoCodigo });
                    count++;
                } catch (err) {
                    log(`❌ Erro ao consolidar produto ${produtoCodigo} na unidade ${name}: ${err.message}`, 'WorkerConsolidationStock');
                }
            }

            log(`✅ Unidade ${name} consolidada (${count} produtos)`, 'WorkerConsolidationStock');
        }


        log(`✅ Consolidação de estoque finalizada para grupo ${groupId} em ${dataRef}`, 'WorkerConsolidationStock');
    } catch (err) {
        log(`❌ Erro em processConsolidation (grupo ${groupId}, data ${dataRef}): ${err.message}`, 'WorkerConsolidationStock');
    } finally {
        await conn.end();
    }
}

/**
 * ExecuteJobConsolidation
 *  - NÃO recebe nada
 *  - Define data_ref = ontem
 *  - Busca grupos via getGroupsToProcess
 *  - Chama processConsolidation para cada grupo
 */
async function WorkerConsolidationStock() {
    const hoje = DateTime.local();
    const ontem = hoje.minus({ days: 1 });

    const dataRef = ontem.toFormat('yyyy-MM-dd');

    log(
        `🚀 Iniciando WorkerConsolidationStock para data ${dataRef} às ${hoje.toFormat('HH:mm:ss')}`,
        'WorkerConsolidationStock'
    );

    const grupos = await callPHP('getGroupsToConsolidation', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'WorkerConsolidationStock');
        return;
    }

    for (const grupo of grupos) {
        const group_id = grupo.id;
        const nomeGrupo = grupo.nome || `Grupo ${group_id}`;

        log(
            `📦 Consolidando grupo: ${nomeGrupo} (ID: ${group_id}) para data ${dataRef}`,
            'WorkerConsolidationStock'
        );

        await processConsolidationStock({ group_id, data_ref: dataRef });
    }

    log(
        `✅ WorkerConsolidationStock finalizado para data ${dataRef} às ${hoje.toFormat('HH:mm:ss')}`,
        'WorkerConsolidationStock'
    );
}


module.exports = {
    processConsolidationStock,
    WorkerConsolidationStock
};

if (require.main === module) {
    WorkerConsolidationStock();
}
