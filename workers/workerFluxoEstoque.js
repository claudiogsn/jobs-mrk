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

// Calcula automaticamente os últimos 7 dias (hoje -7 até ontem)
function getDataRange() {
    const fim = new Date();
    fim.setDate(fim.getDate() - 1);

    const inicio = new Date(fim);
    inicio.setDate(fim.getDate() - 6);

    const format = date => date.toISOString().split('T')[0];
    return {
        dtInicio: format(inicio),
        dtFim: format(fim)
    };
}

async function main() {
    const { dtInicio, dtFim } = getDataRange();

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        dateStrings: true
    });

    const [lojas] = await conn.execute(`
        SELECT 
            rel.system_unit_id, 
            su.custom_code,
            su.name
        FROM grupo_estabelecimento_rel AS rel 
        JOIN system_unit AS su ON rel.system_unit_id = su.id 
        WHERE rel.grupo_id = 1
          AND su.custom_code IS NOT NULL
        ORDER BY FIELD(su.id, 9, 3, 4, 5, 7);
    `);

    for (const loja of lojas) {
        log(`🔍 Processando loja: ${loja.name} (${loja.system_unit_id})`);
        const inicioLoja = Date.now();

        const [produtos] = await conn.execute(`
            SELECT codigo, nome, preco_custo, categoria
            FROM products
            WHERE system_unit_id = ? AND insumo = 1
        `, [loja.system_unit_id]);

        let totalProdutos = 0;
        const chunks = chunkArray(produtos, CHUNK_SIZE);

        for (const [index, chunk] of chunks.entries()) {
            log(`  🧩 Processando chunk ${index + 1}/${chunks.length} (${chunk.length} produtos)...`, `workerFluxoEstoque`);
            await Promise.all(
                chunk.map(produto =>
                    processarProduto(conn, loja.system_unit_id, produto, dtInicio, dtFim)
                        .then(() => {
                            totalProdutos++;
                            log(`Produto ${produto.codigo} processado com sucesso`, `workerFluxoEstoque`);
                        })
                        .catch(err => {
                            log(`Produto ${produto.codigo} falhou: ${err.message}`, `workerFluxoEstoque`);
                        })
                )
            );
        }

        const duracao = ((Date.now() - inicioLoja) / 1000).toFixed(2);
        log(`✅ Loja ${loja.name} finalizada — ${totalProdutos} produtos processados em ${duracao} segundos`, `workerFluxoEstoque`);
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
    let docAnterior = balancoAnterior ? balancoAnterior.doc : null;

    const [movs] = await conn.execute(`
        SELECT data, tipo_mov, doc, quantidade
        FROM movimentacao
        WHERE system_unit_id = ? AND produto = ? AND status = 1 AND data BETWEEN ? AND ?
        ORDER BY data, id
    `, [system_unit_id, codigo, dtInicio, dtFim]);

    const agrupado = {};
    for (const mov of movs) {
        if (!agrupado[mov.data]) {
            agrupado[mov.data] = { data: mov.data, entradas: 0, saidas: 0, balanco: null };
        }
        if (mov.tipo_mov === 'entrada') {
            agrupado[mov.data].entradas += parseFloat(mov.quantidade);
        } else if (mov.tipo_mov === 'saida') {
            agrupado[mov.data].saidas += parseFloat(mov.quantidade);
        } else if (mov.tipo_mov === 'balanco') {
            agrupado[mov.data].balanco = { doc: mov.doc, quantidade: parseFloat(mov.quantidade) };
        }
    }

    for (const dia of Object.values(agrupado)) {
        const saldo_anterior = saldo;
        saldo += dia.entradas - dia.saidas;
        const contagem = dia.balanco ? dia.balanco.quantidade : null;
        const diferenca = contagem !== null ? contagem - saldo : 0;

        if (dia.balanco) {
            docAnterior = dia.balanco.doc;
            saldo = contagem;
        }

        await conn.execute(`
            INSERT INTO fluxo_estoque (
                data, system_unit_id, produto, nome_produto, categoria, preco_custo,
                saldo_anterior, entradas, saidas, contagem_ideal, contagem_realizada, diferenca
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                nome_produto = VALUES(nome_produto),
                categoria = VALUES(categoria),
                preco_custo = VALUES(preco_custo),
                saldo_anterior = VALUES(saldo_anterior),
                entradas = VALUES(entradas),
                saidas = VALUES(saidas),
                contagem_ideal = VALUES(contagem_ideal),
                contagem_realizada = VALUES(contagem_realizada),
                diferenca = VALUES(diferenca)
        `, [
            dia.data, system_unit_id, codigo, nome, categoria, preco_custo,
            saldo_anterior, dia.entradas, dia.saidas, saldo, contagem ?? saldo, diferenca
        ]);
    }
}

// Exporta função principal para uso externo
module.exports = { ExecuteJobFluxoEstoque: main };

// Executa se rodar diretamente
if (require.main === module) {
    main().catch(err => {
        log(`❌ Erro ao executar job Fluxo de Estoque: ${err.message}`, 'workerFluxoEstoque');
        process.exit(1);
    });
}
