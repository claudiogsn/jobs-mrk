require('dotenv').config();
const { publishToQueue, connect, QUEUES } = require('../utils/rabbitmq');
const { callPHP, formatCurrency } = require('../utils/utils');
const { log } = require('../utils/logger');

function formatDateBr(dateStr) {
    if (!dateStr) return '';
    const [data] = dateStr.split(' ');
    const parts = data.split('-');
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    return `${d}/${m}/${y}`;
}

async function enviarNotasPendentes(contato, grupo) {
    const { nome, telefone } = contato;
    const groupId = grupo.id;
    const grupoNome = grupo.nome;

    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });
    if (!Array.isArray(unidades) || unidades.length === 0) {
        log(`❌ Erro: retorno inesperado de getUnitsByGroup para grupo ${grupoNome}`, 'WorkerNotasPendentes');
        return;
    }

    let corpoMensagem = `Segue abaixo as notas fiscais de *entrada não importadas* dos últimos 30 dias para o grupo *${grupoNome}*:\n\n━━━━━━━━━━━━━━━━━━━\n`;
    let totalNotasPendentesGeral = 0;

    const promessas = unidades.map(async (unidade) => {
        const systemUnitId = unidade.system_unit_id;
        const unitName = unidade.name || unidade.nome || unidade.descricao || `Unidade ${systemUnitId}`;

        const resp = await callPHP('listarNotasNaoImportadasUltimos30Dias', {
            system_unit_id: systemUnitId
        });

        return { unidade, resp, unitName };
    });

    const resultados = await Promise.all(promessas);

    for (const { unidade, resp, unitName } of resultados) {
        if (!resp || !resp.success) {
            log(`⚠️ Falha ao consultar notas pendentes da unidade ${unitName}: ${resp?.message || 'sem mensagem'}`, 'WorkerNotasPendentes');
            continue;
        }

        const notasPendentes = resp.data?.notas_pendentes || [];
        if (!Array.isArray(notasPendentes) || notasPendentes.length === 0) {
            continue;
        }

        totalNotasPendentesGeral += notasPendentes.length;

        corpoMensagem += `📍 *${unitName}*\n`;

        const limite = 20;
        notasPendentes.slice(0, limite).forEach((nota) => {
            const numeroNf = nota.numero_nf;
            const dataEmissaoBr = formatDateBr(nota.data_emissao);
            const fornecedor = nota.emitente_razao || 'Fornecedor não informado';
            const valor = formatCurrency(nota.valor_total || 0);
            corpoMensagem += `• ${dataEmissaoBr} - ${numeroNf} - ${fornecedor} - ${valor}\n`;
        });

        if (notasPendentes.length > limite) {
            corpoMensagem += `_… +${notasPendentes.length - limite} nota(s) pendente(s)_\n`;
        }

        corpoMensagem += `\n━━━━━━━━━━━━━━━━━━━\n`;
    }


    if (totalNotasPendentesGeral === 0) {
        log(`✅ Nenhuma nota pendente encontrada para ${nome} / grupo ${grupoNome}. Mensagem não enviada.`, 'WorkerNotasPendentes');
        return;
    }

    const mensagem = `⚠️ Olá, *${nome}*!\n\n${corpoMensagem.trim()}`;
    const payload = { telefone, mensagem };

    try {
        await publishToQueue(QUEUES.WHATSAPP, payload);
        log(`✅ Mensagem de notas pendentes enviada para ${nome} (${telefone}) – Total pendentes: ${totalNotasPendentesGeral}`, 'WorkerNotasPendentes');
    } catch (err) {
        log(`❌ Falha ao enviar mensagem de notas pendentes para ${nome}: ${err.message}`, 'WorkerNotasPendentes');
    }
}

async function WorkerNotasPendentes() {
    await connect();

    const idDisparo = 17;
    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: idDisparo });

    if (!contatosResp || !contatosResp.success) {
        log(`❌ Erro ao buscar contatos para disparo ${idDisparo}: ${contatosResp?.message || 'sem mensagem'}`, 'WorkerNotasPendentes');
        return;
    }

    if (!Array.isArray(contatosResp.data) || contatosResp.data.length === 0) {
        log(`ℹ️ Nenhum contato retornado para disparo ${idDisparo}`, 'WorkerNotasPendentes');
        return;
    }

    for (const contato of contatosResp.data) {
        if (!Array.isArray(contato.grupos) || contato.grupos.length === 0) {
            continue;
        }

        for (const grupo of contato.grupos) {
            await enviarNotasPendentes(contato, grupo);
        }
    }
}

module.exports = {
    enviarNotasPendentes,
    WorkerNotasPendentes
};

if (require.main === module) {
    WorkerNotasPendentes();
}