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

const MOTIVO_COPIA_PENDENTE = 'Possível duplicidade automática: lançamento pendente repetido pelo banco sem favorecido';

/**
 * Identifica a cópia que o banco envia na mesma resposta para um lançamento ainda pendente: mesma
 * data, valor, tipo e descrição, com outro transactionId e sem o favorecido. A cópia é gravada como
 * excluída, e não descartada, porque dois boletos legítimos iguais não têm como ser diferenciados
 * com certeza: o operador pode restaurá-la na lista de excluídos do extrato.
 *
 * Os pares são formados um a um, então só sai o que tem correspondente com favorecido.
 *
 * @param {object[]} transacoes  lote vindo da API
 * @returns {Set<string>} transactionIds das cópias
 */
function identificarCopiasPendentes(transacoes) {
    const grupos = new Map();
    const vistos = new Set();

    for (const tx of transacoes) {
        const id = String(tx.transactionId || '');
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        if (String(tx.status || '').toUpperCase() !== 'PENDING') continue;

        const descricao = String(tx.description || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const chave = `${chaveExtrato(tx.date, tx.amount, tipoDaTransacao(tx))}|${descricao}`;
        if (!grupos.has(chave)) grupos.set(chave, { comFavorecido: 0, semFavorecido: [] });

        const grupo = grupos.get(chave);
        if (tx.participantReceiver) grupo.comFavorecido += 1;
        else grupo.semFavorecido.push(id);
    }

    const copias = new Set();
    for (const { comFavorecido, semFavorecido } of grupos.values()) {
        semFavorecido.slice(0, comFavorecido).forEach(id => copias.add(id));
    }
    return copias;
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

module.exports = {
    MOTIVO_COPIA_PENDENTE,
    chaveExtrato,
    identificarCopiasPendentes,
    removerDuplicadasEntreImportacoes,
    filtrarDuplicadasEntreImportacoes,
};
