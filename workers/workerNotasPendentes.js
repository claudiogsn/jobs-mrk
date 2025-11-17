require('dotenv').config();
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { callPHP, formatCurrency } = require('../utils/utils');
const { log } = require('../utils/logger');

const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// helper local pra formatar data YYYY-MM-DD -> DD/MM/YYYY
function formatDateBr(dateStr) {
    if (!dateStr) return '';
    // aceita também datetime (YYYY-MM-DD HH:MM:SS)
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

    // pega as unidades do grupo
    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });
    if (!Array.isArray(unidades) || unidades.length === 0) {
        log(`❌ Erro: retorno inesperado de getUnitsByGroup para grupo ${grupoNome}`, 'WorkerNotasPendentes');
        return;
    }

    let corpoMensagem = `Segue abaixo as notas fiscais de *entrada não importadas* dos últimos 30 dias para o grupo *${grupoNome}*:\n\n━━━━━━━━━━━━━━━━━━━\n`;
    let totalNotasPendentesGeral = 0;

    for (const unidade of unidades) {
        // aqui assumo que getUnitsByGroup retorna "id" (system_unit_id) e "name"
        const systemUnitId = unidade.id;
        const unitName = unidade.name || unidade.nome || unidade.descricao || `Unidade ${systemUnitId}`;

        const resp = await callPHP('listarNotasNaoImportadasUltimos30Dias', {
            system_unit_id: systemUnitId
        });

        if (!resp || !resp.success) {
            log(`⚠️ Falha ao consultar notas pendentes da unidade ${unitName}: ${resp?.message || 'sem mensagem'}`, 'WorkerNotasPendentes');
            continue;
        }

        const notasPendentes = resp.data?.notas_pendentes || [];
        if (!Array.isArray(notasPendentes) || notasPendentes.length === 0) {
            // nada pendente nessa unidade
            continue;
        }

        totalNotasPendentesGeral += notasPendentes.length;

        corpoMensagem += `📍 *${unitName}*\n`;

        // Limita a, por exemplo, 10 linhas para não estourar a mensagem
        const limite = 10;
        notasPendentes.slice(0, limite).forEach((nota) => {
            const dataEmissaoBr = formatDateBr(nota.data_emissao);
            const fornecedor = nota.emitente_razao || 'Fornecedor não informado';
            const valor = formatCurrency(nota.valor_total || 0);
            const chave = nota.chave_acesso || '';

            corpoMensagem += `• ${dataEmissaoBr} - ${fornecedor} - ${valor}\n`;
            corpoMensagem += `  Chave: ${chave}\n`;
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

    const payload = {
        telefone,
        mensagem
    };

    try {
        await sqs.send(new SendMessageCommand({
            QueueUrl: process.env.WHATSAPP_QUEUE_URL,
            MessageBody: JSON.stringify(payload)
        }));

        log(`✅ Mensagem de notas pendentes enviada para ${nome} (${telefone}) – Total pendentes: ${totalNotasPendentesGeral}`, 'WorkerNotasPendentes');
    } catch (err) {
        log(`❌ Falha ao enviar mensagem de notas pendentes para ${nome}: ${err.message}`, 'WorkerNotasPendentes');
    }
}

async function WorkerNotasPendentes() {
    // aqui você pode usar outro disparo, se quiser separar das mensagens de resumo diário
    const idDisparo = 2; // AJUSTA ESSE ID CONFORME CADASTRO NO SEU SISTEMA

    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: idDisparo });
    if (!contatosResp || !contatosResp.success) {
        log(`❌ Erro ao buscar contatos para disparo ${idDisparo}`, 'WorkerNotasPendentes');
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
