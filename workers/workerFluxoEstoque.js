require('dotenv').config();
const { log } = require('../utils/logger');
const mysql = require('mysql2/promise');

const CHUNK_SIZE = 100;

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

function getDataRange() {
    const fim = new Date();
    fim.setDate(fim.getDate() - 1);

    const inicio = new Date(fim);
    inicio.setDate(fim.getDate() - 6);

    const fmt = date => date.toISOString().split('T')[0];
    return { dtInicio: fmt(inicio), dtFim: fmt(fim) };
}

async function ExecuteJobFluxoEstoque({ group = null, unit = null, inicio = null, fim = null }) {
    const { dtInicio, dtFim } = inicio && fim ? { dtInicio: inicio, dtFim: fim } : getDataRange();

    log(`▶️ Iniciando Fluxo de Estoque | Grupo: ${group ?? '-'} | Unidade: ${unit ?? '-'} | Período: ${dtInicio} -> ${dtFim}`, "workerFluxoEstoque");

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        dateStrings: true
    });

    let lojas = [];

    // Se passou apenas unidade, processa um único estabelecimento
    if (unit) {
        const [result] = await conn.execute(`
            SELECT id AS system_unit_id, custom_code, name
            FROM system_unit
            WHERE id = ?
        `, [unit]);
        lojas = result;
    }
    // Caso contrário, processa pelo grupo
    else if (group) {
        const [result] = await conn.execute(`
            SELECT 
                rel.system_unit_id, 
                su.custom_code,
                su.name
            FROM grupo_estabelecimento_rel AS rel 
            JOIN system_unit AS su ON rel.system_unit_id = su.id 
            WHERE rel.grupo_id = ? 
              AND su.custom_code IS NOT NULL
        `, [group]);
        lojas = result;
    }

    if (!lojas.length) {
        log(`⚠️ Nenhuma unidade encontrada para esse parâmetro`, `workerFluxoEstoque`);
        return;
    }

    for (const loja of lojas) {
        log(`🔍 Processando loja: ${loja.name} (${loja.system_unit_id})`, `workerFluxoEstoque`);
        const inicioLoja = Date.now();

        const [produtos] = await conn.execute(`
            SELECT codigo, nome, preco_custo, categoria
            FROM products
            WHERE system_unit_id = ? AND insumo = 1
        `, [loja.system_unit_id]);

        let totalProdutos = 0;
        const chunks = chunkArray(produtos, CHUNK_SIZE);

        for (const [i, chunk] of chunks.entries()) {
            log(`  🧩 Chunk ${i + 1}/${chunks.length} (${chunk.length} produtos)`, `workerFluxoEstoque`);
            await Promise.all(
                chunk.map(produto =>
                    processarProduto(conn, loja.system_unit_id, produto, dtInicio, dtFim)
                        .then(() => totalProdutos++)
                        .catch(err => log(`Erro em ${produto.codigo}: ${err.message}`, `workerFluxoEstoque`))
                )
            );
        }

        const duracao = ((Date.now() - inicioLoja) / 1000).toFixed(2);
        log(`✅ Loja ${loja.name} finalizada | ${totalProdutos} produtos | ${duracao}s`, `workerFluxoEstoque`);
    }

    await conn.end();
}

async function processarProduto(conn, system_unit_id, produto, dtInicio, dtFim) {

    const { codigo, nome, preco_custo, categoria } = produto;

    const [[balancoAnterior]] = await conn.execute(`
        SELECT doc, quantidade
        FROM movimentacao
        WHERE system_unit_id = ? AND produto = ? AND tipo_mov = 'balanco' AND status = 1 AND data < ?
        ORDER BY data DESC, id DESC LIMIT 1
    `, [system_unit_id, codigo, dtInicio]);

    let saldo = balancoAnterior ? parseFloat(balancoAnterior.quantidade) : 0;

    const [movs] = await conn.execute(`
        SELECT data, tipo_mov, doc, quantidade
        FROM movimentacao
        WHERE system_unit_id = ? AND produto = ? AND status = 1 AND data BETWEEN ? AND ?
        ORDER BY data, id
    `, [system_unit_id, codigo, dtInicio, dtFim]);

    const agrupado = {};
    for (const mov of movs) {
        if (!agrupado[mov.data]) agrupado[mov.data] = { data: mov.data, entradas: 0, saidas: 0, balanco: null };
        if (mov.tipo_mov === 'entrada') agrupado[mov.data].entradas += parseFloat(mov.quantidade);
        else if (mov.tipo_mov === 'saida') agrupado[mov.data].saidas += parseFloat(mov.quantidade);
        else if (mov.tipo_mov === 'balanco') agrupado[mov.data].balanco = { doc: mov.doc, quantidade: parseFloat(mov.quantidade) };
    }

    for (const dia of Object.values(agrupado)) {
        const saldoAnterior = saldo;
        saldo += dia.entradas - dia.saidas;
        const contagem = dia.balanco ? dia.balanco.quantidade : null;
        const diferenca = contagem !== null ? contagem - saldo : 0;
        if (dia.balanco) saldo = contagem;

        await conn.execute(`
            INSERT INTO fluxo_estoque (
                data, system_unit_id, produto, nome_produto, categoria, preco_custo,
                saldo_anterior, entradas, saidas, contagem_ideal, contagem_realizada, diferenca
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                                     nome_produto=VALUES(nome_produto),
                                     categoria=VALUES(categoria),
                                     preco_custo=VALUES(preco_custo),
                                     saldo_anterior=VALUES(saldo_anterior),
                                     entradas=VALUES(entradas),
                                     saidas=VALUES(saidas),
                                     contagem_ideal=VALUES(contagem_ideal),
                                     contagem_realizada=VALUES(contagem_realizada),
                                     diferenca=VALUES(diferenca)
        `, [
            dia.data, system_unit_id, codigo, nome, categoria, preco_custo,
            saldoAnterior, dia.entradas, dia.saidas, saldo, contagem ?? saldo, diferenca
        ]);
    }
}

module.exports = { ExecuteJobFluxoEstoque };
