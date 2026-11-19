const test = require('node:test');
const assert = require('node:assert/strict');
const { identificarCopiasPendentes, removerDuplicadasEntreImportacoes } = require('../utils/dedupExtrato');
const { salvarTransacoes } = require('../workers/workerImportacaoExtrato');

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

const favorecido = { name: 'FORNECEDOR LTDA' };
const lanc = (id, { status = 'PENDING', receiver = favorecido, amount = '100.00', description = 'BOLETO FORNECEDOR' } = {}) => ({
    ...tx(id, amount, 'debit', '2026-11-17'), status, description, participantReceiver: receiver,
});
const copias = lista => [...identificarCopiasPendentes(lista)].sort();

test('boleto pendente repetido sem favorecido é marcado como cópia', () => {
    assert.deepEqual(copias([lanc('com'), lanc('sem', { receiver: null })]), ['sem']);
});

test('dois Pix confirmados iguais para o mesmo favorecido não são marcados', () => {
    assert.deepEqual(copias([lanc('p1', { status: 'POSTED' }), lanc('p2', { status: 'POSTED' })]), []);
});

test('dois boletos pendentes iguais com favorecido não são marcados', () => {
    assert.deepEqual(copias([lanc('b1'), lanc('b2')]), []);
});

test('dois boletos enviados em dobro perdem só as duas cópias', () => {
    const lista = [lanc('c1'), lanc('c2'), lanc('s1', { receiver: null }), lanc('s2', { receiver: null })];
    assert.deepEqual(copias(lista), ['s1', 's2']);
});

test('lançamento sem favorecido e sem par continua valendo', () => {
    assert.deepEqual(copias([lanc('s1', { receiver: null })]), []);
});

test('descrição ou valor diferentes não formam par', () => {
    const lista = [
        lanc('a'),
        lanc('b', { receiver: null, description: 'BOLETO OUTRO' }),
        lanc('c', { receiver: null, amount: '100.01' }),
    ];
    assert.deepEqual(copias(lista), []);
});

test('o mesmo id repetido na resposta não forma par consigo mesmo', () => {
    assert.deepEqual(copias([lanc('x'), lanc('x', { receiver: null })]), []);
});

test('a cópia é gravada excluída e a sincronização não altera a exclusão existente', async () => {
    const chamadas = [];
    const conn = { query: async (sql, params) => { chamadas.push({ sql, linhas: params[0] }); } };

    await salvarTransacoes(conn, [lanc('com'), lanc('sem', { receiver: null })], 25, 13, new Set(['sem']));

    const [{ sql, linhas }] = chamadas;
    const [normal, copia] = linhas;
    assert.deepEqual(normal.slice(8), [0, null, null, null]);
    assert.equal(copia[8], 1);
    assert.equal(copia[10], 'sistema');
    assert.match(copia[11], /duplicidade automática/);
    assert.doesNotMatch(sql.split('ON DUPLICATE KEY UPDATE')[1], /is_ignored|ignored_/);
});
