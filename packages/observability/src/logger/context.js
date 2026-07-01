'use strict';

/**
 * Contexto de execução propagado de forma assíncrona via AsyncLocalStorage.
 *
 * Permite que qualquer log emitido dentro de uma requisição HTTP ou de uma execução
 * de worker carregue automaticamente identificadores de correlação (executionId,
 * requestId, correlationId, etc.) sem precisar passá-los manualmente por parâmetro.
 *
 * Execuções paralelas (vários workers/requests ao mesmo tempo) têm cada uma o seu
 * próprio store isolado — é exatamente a garantia do AsyncLocalStorage.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Executa `fn` dentro de um novo escopo de contexto, herdando o que já existir.
 * @template T
 * @param {Record<string, any>} fields
 * @param {() => T} fn
 * @returns {T}
 */
function withContext(fields, fn) {
    const current = storage.getStore() || {};
    const merged = { ...current, ...fields };
    return storage.run(merged, fn);
}

/** Acrescenta campos ao contexto atual (se houver), in-place. */
function setContext(fields) {
    const current = storage.getStore();
    if (current) Object.assign(current, fields);
}

/** Retorna uma cópia rasa do contexto atual (ou objeto vazio). */
function getContext() {
    return { ...(storage.getStore() || {}) };
}

module.exports = { storage, withContext, setContext, getContext };
