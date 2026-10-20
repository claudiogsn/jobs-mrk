const test = require('node:test');
const assert = require('node:assert/strict');
const { removerDuplicadasEntreImportacoes } = require('../utils/dedupExtrato');

const tx = (id, amount, type = 'debit', date = '2026-10-09') => ({ transactionId: id, date, amount, transactionType: type });
const row = (id, amount, type = 'debit', date = '2026-10-09') => ({ pluggy_transaction_id: id, date, amount, type });

test('transação reenviada com outro id não entra de novo', () => {
    const r = removerDuplicadasEntreImportacoes([tx('novo-1', 1000)], new Set(), [row('antigo-1', '1000.00')]);
    assert.equal(r.transacoes.length, 0);
    assert.equal(r.ignoradas, 1);
});

test('transação já importada via OFX não é duplicada pelo Open Finance', () => {
    const r = removerDuplicadasEntreImportacoes([tx('of-1', 357.63)], new Set(), [row('OFX_13_20261007357631-56', '357.63')]);
    assert.equal(r.ignoradas, 1);
});

test('duas transações legítimas iguais no mesmo dia continuam entrando', () => {
    const r = removerDuplicadasEntreImportacoes([tx('a', 23), tx('b', 23)], new Set(), []);
    assert.equal(r.transacoes.length, 2);
    assert.equal(r.ignoradas, 0);
});

test('lote com uma a mais que o banco grava só a diferença', () => {
    const r = removerDuplicadasEntreImportacoes([tx('n1', 23), tx('n2', 23)], new Set(), [row('velho', '23.00')]);
    assert.deepEqual(r.transacoes.map(t => t.transactionId), ['n1']);
});

test('ids já gravados são atualizações e nunca são descartados', () => {
    const existentes = [row('a', '50.00'), row('b', '50.00')];
    const r = removerDuplicadasEntreImportacoes([tx('a', 50), tx('b', 50)], new Set(['a', 'b']), existentes);
    assert.equal(r.transacoes.length, 2);
});

test('tipo e data diferentes não colidem', () => {
    const r = removerDuplicadasEntreImportacoes(
        [tx('c1', 100, 'credit'), tx('d2', 100, 'debit', '2026-10-10')], new Set(), [row('x', '100.00', 'debit')]
    );
    assert.equal(r.transacoes.length, 2);
});
