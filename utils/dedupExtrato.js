// Deduplicação do extrato entre importações (mesma regra de ExtratoBancario.php no portal-mrk).
//
// O Open Finance reenvia a mesma transação com outro transactionId em sincronizações
// seguintes, e um OFX importado antes gera a mesma movimentação com outro id. A comparação
// é por data + valor + tipo (a descrição muda entre OFX e Open Finance). O lote é a fonte
// da verdade para as datas que cobre: numa chave em que ele traz N transações novas e o
// banco já tem E linhas de outras importações, entram só max(0, N - E).

function chaveExtrato(data, valor, tipo) {
    const t = String(tipo || '').toLowerCase();
    const tipoNorm = ['debit', 'd', 'debito', 'débito'].includes(t) ? 'debit' : 'credit';
    return `${String(data || '').slice(0, 10)}|${Math.abs(Number(valor) || 0).toFixed(2)}|${tipoNorm}`;
}

const tipoDaTransacao = tx => tx.transactionType || tx.type || '';

/**
 * @param {object[]} transacoes  lote vindo da API (transactionId, date, amount, transactionType/type)
 * @param {Set<string>} idsJaGravados  ids do lote que já existem em pluggy_transactions
 * @param {object[]} existentesNasDatas  linhas gravadas nas datas do lote (pluggy_transaction_id, date, amount, type)
 * @returns {{ transacoes: object[], ignoradas: number }}
 */
function removerDuplicadasEntreImportacoes(transacoes, idsJaGravados, existentesNasDatas) {
    const idsLote = new Set(transacoes.map(tx => String(tx.transactionId || '')).filter(Boolean));

    const existentes = new Map();
    for (const row of existentesNasDatas) {
        if (idsLote.has(String(row.pluggy_transaction_id))) continue;
        const chave = chaveExtrato(row.date, row.amount, row.type);
        existentes.set(chave, (existentes.get(chave) || 0) + 1);
    }

    const novasPorChave = new Map();
    transacoes.forEach((tx, i) => {
        const id = String(tx.transactionId || '');
        if (!id || idsJaGravados.has(id)) return;
        const chave = chaveExtrato(tx.date, tx.amount, tipoDaTransacao(tx));
        if (!novasPorChave.has(chave)) novasPorChave.set(chave, []);
        novasPorChave.get(chave).push(i);
    });

    const descartar = new Set();
    for (const [chave, indices] of novasPorChave) {
        const sobra = indices.length - (existentes.get(chave) || 0);
        indices.slice(Math.max(0, sobra)).forEach(i => descartar.add(i));
    }

    return {
        transacoes: transacoes.filter((_, i) => !descartar.has(i)),
        ignoradas: descartar.size,
    };
}

async function filtrarDuplicadasEntreImportacoes(conn, systemUnitId, accountId, transacoes) {
    if (!transacoes || transacoes.length === 0) return { transacoes: [], ignoradas: 0 };

    const ids = [...new Set(transacoes.map(tx => String(tx.transactionId || '')).filter(Boolean))];
    const idsJaGravados = new Set();
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const [rows] = await conn.query(
            'SELECT pluggy_transaction_id FROM pluggy_transactions WHERE pluggy_transaction_id IN (?)', [chunk]
        );
        rows.forEach(r => idsJaGravados.add(String(r.pluggy_transaction_id)));
    }

    const datas = [...new Set(transacoes
        .filter(tx => tx.transactionId && !idsJaGravados.has(String(tx.transactionId)))
        .map(tx => String(tx.date || '').slice(0, 10)))];
    if (datas.length === 0) return { transacoes, ignoradas: 0 };

    const [existentes] = await conn.query(
        `SELECT pluggy_transaction_id, date, amount, type
           FROM pluggy_transactions
          WHERE system_unit_id = ? AND account_id = ? AND date IN (?)`,
        [systemUnitId, accountId, datas]
    );

    return removerDuplicadasEntreImportacoes(transacoes, idsJaGravados, existentes);
}

module.exports = { chaveExtrato, removerDuplicadasEntreImportacoes, filtrarDuplicadasEntreImportacoes };
