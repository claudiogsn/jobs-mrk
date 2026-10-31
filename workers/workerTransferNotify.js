require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');

const { callPHP, sendWhatsappText, sendWhatsappPdf } = require('../utils/utils');
const { log } = require('../utils/logger');
const storage = require('../utils/storage');

// ================== CONFIG ==================


const fonts = {
    Roboto: {
        normal: path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'),
        bold: path.join(__dirname, 'fonts', 'Roboto-Medium.ttf'),
        italics: path.join(__dirname, 'fonts', 'Roboto-Italic.ttf'),
        bolditalics: path.join(__dirname, 'fonts', 'Roboto-MediumItalic.ttf')
    }
};

const printer = new PdfPrinter(fonts);

// ================== HELPERS ==================

function formatDateBR(date) {
    if (!date) return '';
    const [y, m, d] = String(date).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

function brQty(v, casas = 3) {
    return Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas
    });
}

// tenta carregar logo.png ao lado do worker
function loadLogoBase64() {
    try {
        const logoPath = path.join(__dirname, 'logo.png');
        if (!fs.existsSync(logoPath)) return null;
        const img = fs.readFileSync(logoPath);
        return 'data:image/png;base64,' + img.toString('base64');
    } catch (e) {
        log(`❌ Erro ao carregar logo.png: ${e.message}`, 'workerTransferNotify');
        return null;
    }
}

// ================== BUSCA TRANSFERÊNCIA ==================

async function fetchTransferencia(transfer_key) {
    const resp = await callPHP('getTransferenciaByKey', { transfer_key });

    const logoBase64 = loadLogoBase64();


    if (!resp?.success) {
        throw new Error(resp?.message || 'Transferência não encontrada');
    }

    return resp;
}

// ================== PDF ==================

function buildPdfDefinition(header, items) {
    const logoBase64 = loadLogoBase64();

    const docDefinition = {
        pageSize: 'A4',
        pageOrientation: 'portrait',
        defaultStyle: { font: 'Roboto', fontSize: 10 },
        styles: {
            title: { fontSize: 14, bold: true },
            subtitle: { fontSize: 10, margin: [0, 2, 0, 0] },
            tableHeader: {
                bold: true,
                fontSize: 9,
                alignment: 'center',
                fillColor: '#eeeeee'
            },
            tableCell: {
                fontSize: 9,
                alignment: 'left'
            },
            tableCellRight: {
                fontSize: 9,
                alignment: 'right'
            },
            signatureName: {
                fontSize: 9,
                alignment: 'center',
                margin: [0, 5, 0, 0]
            }
        },
        images: {},
        content: []
    };

    // injeta a logo
    if (logoBase64) {
        docDefinition.images.logo = logoBase64;
    }

    // ================= CABEÇALHO =================
    docDefinition.content.push({
        columns: [
            {
                width: '*',
                stack: [
                    { text: 'Portal MRK', style: 'title' },
                    { text: 'Estoque / Transferência', style: 'subtitle' }
                ]
            },
            logoBase64
                ? {
                    width: 'auto',
                    image: 'logo',
                    fit: [70, 70],
                    alignment: 'right'
                }
                : {}
        ],
        margin: [0, 0, 0, 8]
    });

    // linha horizontal
    docDefinition.content.push({
        canvas: [
            { type: 'line', x1: 0, y1: 0, x2: 520, y2: 0, lineWidth: 1 }
        ],
        margin: [0, 4, 0, 8]
    });

    // ================= DADOS =================
    docDefinition.content.push(
        { text: `Estabelecimento Origem: ${header.unidade_origem.nome}` },
        { text: `Estabelecimento Destino: ${header.unidade_destino.nome}` },
        { text: `Doc Saída: ${header.doc_saida}` },
        { text: `Doc Entrada: ${header.doc_entrada}` },
        { text: `Data: ${formatDateBR(header.data)}` },
        { text: `Usuário: ${header.usuario.nome}`, margin: [0, 0, 0, 10] }
    );

    // ================= TABELA =================
    docDefinition.content.push({
        table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto'],
            body: [
                [
                    { text: 'Código', style: 'tableHeader' },
                    { text: 'Produto', style: 'tableHeader' },
                    { text: 'Quantidade', style: 'tableHeader' }
                ],
                ...items.map(i => [
                    { text: i.codigo, style: 'tableCell' },
                    { text: i.nome, style: 'tableCell' },
                    { text: brQty(i.quantidade), style: 'tableCellRight' }
                ])
            ]
        },
        layout: 'lightHorizontalLines'
    });

    // ================= ASSINATURA =================
    docDefinition.content.push({
        canvas: [
            {
                type: 'line',
                x1: 100,
                y1: 0,
                x2: 420,
                y2: 0,
                lineWidth: 1
            }
        ],
        margin: [0, 50, 0, 0]
    });

    docDefinition.content.push({
        text: header.usuario.nome,
        style: 'signatureName'
    });

    return docDefinition;
}

// PDF em memória -> S3 (private/jobs-mrk/reports/); devolve o link temporário para a Z-API.
async function generateTransferPdf(header, items) {
    const fileName = `TRANSFERENCIA_${header.transfer_key}.pdf`;
    const docDefinition = buildPdfDefinition(header, items);
    const buffer = await storage.pdfToBuffer(printer.createPdfKitDocument(docDefinition));
    return storage.publishReport(fileName, buffer);
}

// ================== WHATSAPP ==================

function montarMensagem(header) {
    return (
        `📦 *Transferência de Estoque*\n\n` +
        `Origem: *${header.unidade_origem.nome}*\n` +
        `Destino: *${header.unidade_destino.nome}*\n` +
        `Doc Saída: *${header.doc_saida}*\n` +
        `Data: *${formatDateBR(header.data)}*\n\n` +
        `Segue o comprovante em anexo.`
    );
}

// ================== WORKER PRINCIPAL ==================

async function ProcessJobTransferNotify(system_unit_id, user_id, transfer_key) {
    log(
        `🔄 Processando transferência ${transfer_key} (unit ${system_unit_id})`,
        'ProcessJobTransferNotify'
    );

    // 1) Busca transferência (já vem header + items)
    const { header, items } = await fetchTransferencia(transfer_key);

    // 2) Usuário logado (contexto padrão do sistema)
    const userResp = await callPHP('getUserDetails', {user: user_id});
    if (!userResp?.success) {
        throw new Error('Falha ao obter usuário logado');
    }

    const user = userResp.userDetails;

    if (!user.phone) {
        throw new Error('Usuário sem telefone cadastrado');
    }

    // 3) PDF
    const pdfUrl = await generateTransferPdf(header, items);

    // 4) WhatsApp
    const mensagem = montarMensagem(header);
    await sendWhatsappText(user.phone, mensagem);

    if (pdfUrl) {
        await sendWhatsappPdf(user.phone, pdfUrl);
    }

    log(
        `✅ Transferência ${transfer_key} enviada com sucesso para ${user.name}`,
        'ProcessJobTransferNotify'
    );
}

// ================== EXPORT ==================

module.exports = {
    ProcessJobTransferNotify
};
