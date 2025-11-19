require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');
const axios = require('axios');
const { callPHP, sendWhatsappPdf, sendWhatsappText } = require('../utils/utils');
const { log } = require('../utils/logger');

// ================== CONFIG BÁSICA ==================

const IS_PROD = process.env.NODE_ENV === 'production';

// Diretório padrão onde os PDFs serão salvos
// - Em produção: /var/www/html/reports  (URL: ${PUBLIC_BASE_REPORT_URL}/arquivo.pdf)
// - Em dev/local: pasta "reports" ao lado deste arquivo
const DEFAULT_REPORTS_DIR = path.join(__dirname, 'reports');

// URL base pública para os relatórios (usar algo tipo https://portal.mrksolucoes.com.br/reports)
const PUBLIC_BASE_REPORT_URL = process.env.PUBLIC_BASE_REPORT_URL || null;

// ID do disparo cadastrado no sistema para esse tipo de auditoria COP
const ID_DISPARO_COP = parseInt(process.env.ID_DISPARO_COP || '18', 10);

// ================== FONTES DO PDFMAKE ==================

const fonts = {
    Roboto: {
        normal: path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'),
        bold: path.join(__dirname, 'fonts', 'Roboto-Medium.ttf'),
        italics: path.join(__dirname, 'fonts', 'Roboto-Italic.ttf'),
        bolditalics: path.join(__dirname, 'fonts', 'Roboto-MediumItalic.ttf')
    }
};

const printer = new PdfPrinter(fonts);

// ================== HELPERS DE FORMATAÇÃO ==================

function formatDateBR(iso) {
    if (!iso) return '';
    const d = String(iso).slice(0, 10); // yyyy-mm-dd
    const [y, m, day] = d.split('-');
    if (!y || !m || !day) return '';
    return `${day}/${m}/${y}`;
}

function formatDateISO(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getDefaultDates() {
    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);

    const anteontem = new Date(hoje);
    anteontem.setDate(anteontem.getDate() - 2);

    // dt_inicio = anteontem, dt_fim = ontem
    return {
        dt_inicio: formatDateISO(anteontem),
        dt_fim: formatDateISO(ontem)
    };
}

function brQty(v, casas = 2) {
    if (v == null || isNaN(v)) return '-';
    return Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas
    });
}

function brMoney(v) {
    if (v == null || isNaN(v)) return '-';
    return Number(v).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

function formatDiffQty(qty) {
    if (qty == null || isNaN(qty)) return null;
    const n = Number(qty);
    if (n === 0) return null;
    const sign = n > 0 ? '+' : '-';
    const abs = Math.abs(n);
    return `${sign}${brQty(abs, 2)}`;
}

// tenta carregar logo.png ao lado do worker
function loadLogoBase64() {
    try {
        const logoPath = path.join(__dirname, 'logo.png');
        if (!fs.existsSync(logoPath)) return null;
        const img = fs.readFileSync(logoPath);
        return 'data:image/png;base64,' + img.toString('base64');
    } catch (e) {
        console.error('Erro ao carregar logo.png:', e.message);
        return null;
    }
}

// ================== CHAMADA À API (via callPHP) ==================

async function fetchCopData({ system_unit_id, dt_inicio, dt_fim }) {
    const token = process.env.MRK_TOKEN;
    const payload = {
        method: 'extratoCopEntreBalancos',
        token,
        data: { system_unit_id, dt_inicio, dt_fim },
    };
    const BASE_URL = process.env.BACKEND_URL;

    const res = await axios.post(BASE_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!res.data) {
        throw new Error('Resposta vazia da API');
    }

    return res.data; // <-- aqui já vem { mensagem, janela, itens }
}


// ================== MONTAGEM DO DOCDEFINITION ==================

function buildDocDefinition({ apiData, params }) {
    const { system_unit_id, unit_name, dt_inicio, dt_fim } = params;
    const { mensagem, janela, itens } = apiData || {};

    const logoBase64 = loadLogoBase64();

    const dataIniBal = janela?.data_inicial_balanco;
    const dataFimBal = janela?.data_final_balanco;

    const thSaldoInicial = `Saldo Inicial${dataIniBal ? ' (' + formatDateBR(dataIniBal) + ')' : ''}`;
    const thBalancoFinal = `Balanço Final${dataFimBal ? ' (' + formatDateBR(dataFimBal) + ')' : ''}`;

    // Totais
    let totalIni = 0;
    let totalEnt = 0;
    let totalSai = 0;
    let totalEsp = 0;
    let totalFin = 0;
    let totalDiv = 0;
    let totalVal = 0;

    const body = [];

    // cabeçalho da tabela
    body.push([
        { text: 'Insumo', style: 'tableHeader' },
        { text: thSaldoInicial, style: 'tableHeader' },
        { text: 'Entradas', style: 'tableHeader' },
        { text: 'Saídas', style: 'tableHeader' },
        { text: 'Saldo Estimado Final', style: 'tableHeader' },
        { text: thBalancoFinal, style: 'tableHeader' },
        { text: 'Diferença (quant.)', style: 'tableHeader' },
        { text: 'Custo Unitário (R$)', style: 'tableHeader' },
        { text: 'Valor Diferença (R$)', style: 'tableHeader' }
    ]);

    (itens || []).forEach((item) => {
        const nome = item.nome_produto || '-';
        const ini = Number(item.saldo_inicial || 0);
        const ent = Number(item.entradas || 0);
        const sai = Number(item.saidas || 0);
        const esp = Number(item.saldo_esperado || 0);
        const fin = item.saldo_final_balanco != null ? Number(item.saldo_final_balanco) : null;
        const div = item.divergencia != null ? Number(item.divergencia) : null;
        const custo = item.custo_unitario != null ? Number(item.custo_unitario) : null;
        const valD =
            item.valor_diferenca != null
                ? Number(item.valor_diferenca)
                : div != null && custo != null
                    ? div * custo
                    : null;

        totalIni += ini;
        totalEnt += ent;
        totalSai += sai;
        totalEsp += esp;
        totalFin += fin || 0;
        totalDiv += div || 0;
        totalVal += valD || 0;

        body.push([
            { text: nome, style: 'tableCell' },
            { text: brQty(ini, 2), style: 'tableCellRight' },
            { text: brQty(ent, 2), style: 'tableCellRight' },
            { text: brQty(sai, 2), style: 'tableCellRight' },
            { text: brQty(esp, 2), style: 'tableCellRight' },
            { text: fin != null ? brQty(fin, 2) : '-', style: 'tableCellRight' },
            { text: div != null ? brQty(div, 2) : '-', style: 'tableCellRight' },
            { text: custo != null ? brMoney(custo) : '-', style: 'tableCellRight' },
            { text: valD != null ? brMoney(valD) : '-', style: 'tableCellRight' }
        ]);
    });

    // linha de totais
    body.push([
        { text: 'Totais', style: 'tableHeader' },
        { text: brQty(totalIni, 2), style: 'tableHeaderRight' },
        { text: brQty(totalEnt, 2), style: 'tableHeaderRight' },
        { text: brQty(totalSai, 2), style: 'tableHeaderRight' },
        { text: brQty(totalEsp, 2), style: 'tableHeaderRight' },
        { text: brQty(totalFin, 2), style: 'tableHeaderRight' },
        { text: brQty(totalDiv, 2), style: 'tableHeaderRight' },
        { text: '-', style: 'tableHeaderRight' },
        { text: brMoney(totalVal), style: 'tableHeaderRight' }
    ]);

    const periodoLabel = `Período de ${formatDateBR(dt_inicio)} a ${formatDateBR(dt_fim)}`;

    const docDefinition = {
        pageSize: 'A4',
        pageOrientation: 'landscape',
        defaultStyle: {
            font: 'Roboto',
            fontSize: 8
        },
        styles: {
            title: { fontSize: 14, bold: true },
            subtitle: { fontSize: 10, margin: [0, 2, 0, 0] },
            subtitle2: { fontSize: 9, margin: [0, 1, 0, 0] },
            muted: { fontSize: 8, color: '#666', margin: [0, 3, 0, 0] },
            tableHeader: { bold: true, fontSize: 8, alignment: 'center', fillColor: '#eeeeee' },
            tableHeaderRight: { bold: true, fontSize: 8, alignment: 'right', fillColor: '#eeeeee' },
            tableCell: { fontSize: 8, alignment: 'left' },
            tableCellRight: { fontSize: 8, alignment: 'right' },
            totalsText: { fontSize: 8, alignment: 'right', margin: [0, 8, 0, 0] }
        },
        images: {},
        content: []
    };

    // injeta logo se existir
    if (logoBase64) {
        docDefinition.images.logo = logoBase64;
    }

    // cabeçalho
    docDefinition.content.push({
        columns: [
            {
                width: '*',
                stack: [
                    { text: 'Portal MRK', style: 'title' },
                    { text: 'Relatório de Auditoria - COP', style: 'subtitle' },
                    { text: `${system_unit_id} - ${unit_name || ''}`, style: 'subtitle2' },
                    { text: periodoLabel, style: 'subtitle2' },
                    mensagem ? { text: mensagem, style: 'muted' } : null
                ].filter(Boolean)
            },
            logoBase64
                ? {
                    width: 'auto',
                    image: 'logo',
                    fit: [80, 80],
                    alignment: 'right'
                }
                : {}
        ],
        margin: [0, 0, 0, 8]
    });

    // linha horizontal
    docDefinition.content.push({
        canvas: [
            {
                type: 'line',
                x1: 0,
                y1: 0,
                x2: 800,
                y2: 0,
                lineWidth: 1
            }
        ],
        margin: [0, 4, 0, 8]
    });

    // tabela
    docDefinition.content.push({
        table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body
        },
        layout: 'lightHorizontalLines'
    });

    // texto resumo de totais
    docDefinition.content.push({
        text:
            `Totais | ` +
            `Inicial: ${brQty(totalIni, 2)} · ` +
            `Entradas: ${brQty(totalEnt, 2)} · ` +
            `Saídas: ${brQty(totalSai, 2)} · ` +
            `Esperado: ${brQty(totalEsp, 2)} · ` +
            `Balanço Final: ${brQty(totalFin, 2)} · ` +
            `Diferença (quant.): ${brQty(totalDiv, 2)} · ` +
            `Valor Diferença: ${brMoney(totalVal)}`,
        style: 'totalsText'
    });

    return docDefinition;
}

// ================== GERAÇÃO DO PDF ==================

async function generateCopPdf({
                                  system_unit_id,
                                  unit_name,
                                  dt_inicio,
                                  dt_fim,
                                  apiData,
                                  outputDir = DEFAULT_REPORTS_DIR
                              }) {
    if (!system_unit_id || !dt_inicio || !dt_fim) {
        throw new Error('Parâmetros obrigatórios: system_unit_id, dt_inicio, dt_fim');
    }

    // Garante que a pasta existe
    fs.mkdirSync(outputDir, { recursive: true });

    log(
        `[COP] Gerando PDF para unidade ${system_unit_id} (${unit_name || ''}) período ${dt_inicio} a ${dt_fim}...`,
        'generateCopPdf'
    );

    // Se apiData não foi passado, busca da API
    const data = apiData || (await fetchCopData({ system_unit_id, dt_inicio, dt_fim }));

    const docDefinition = buildDocDefinition({
        apiData: data,
        params: { system_unit_id, unit_name, dt_inicio, dt_fim }
    });

    const safeUnitName = (unit_name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\-]+/g, '_');

    const fileName = `COP_${system_unit_id}_${safeUnitName}_${dt_inicio}_${dt_fim}.pdf`;
    const outputPath = path.join(outputDir, fileName);

    return new Promise((resolve, reject) => {
        try {
            const pdfDoc = printer.createPdfKitDocument(docDefinition);
            const stream = fs.createWriteStream(outputPath);
            pdfDoc.pipe(stream);
            pdfDoc.end();

            stream.on('finish', () => {
                log(`[COP] PDF gerado com sucesso em: ${outputPath}`, 'generateCopPdf');

                const publicUrl =
                    IS_PROD && PUBLIC_BASE_REPORT_URL
                        ? `${PUBLIC_BASE_REPORT_URL.replace(/\/+$/, '')}/${fileName}`
                        : null;

                if (publicUrl) {
                    log(`[COP] URL pública: ${publicUrl}`, 'generateCopPdf');
                }

                resolve({ filePath: outputPath, fileName, publicUrl, apiData: data });
            });

            stream.on('error', (err) => {
                log(`[COP] Erro ao salvar PDF: ${err.message}`, 'generateCopPdf');
                reject(err);
            });
        } catch (err) {
            log(`[COP] Erro ao criar documento PDF: ${err.message}`, 'generateCopPdf');
            reject(err);
        }
    });
}

// ================== MENSAGEM DE WHATSAPP ==================

function montarMensagemAuditoria(contatoNome, unitName, dataRefISO, itens) {
    const dataRefBr = formatDateBR(dataRefISO);

    // Ordena pelos maiores desvios em quantidade
    const ordenados =
        (itens || [])
            .filter((i) => i.divergencia != null && Number(i.divergencia) !== 0)
            .sort((a, b) => Math.abs(Number(b.divergencia || 0)) - Math.abs(Number(a.divergencia || 0)));

    const top5 = ordenados.slice(0, 5);

    // Sem divergências relevantes
    if (top5.length === 0) {
        return (
            `Olá, ${contatoNome}\n` +
            `Segue auditoria da *${unitName} no dia ${dataRefBr}*.\n\n` +
            `Nenhuma divergência relevante encontrada.`
        ).trim();
    }

    // Com divergências
    let msg = '';
    msg += `Olá, ${contatoNome}\n`;
    msg += `Segue auditoria da *${unitName} no dia ${dataRefBr}* :\n\n`;

    for (const item of top5) {
        const nome = item.nome_produto || 'Insumo sem nome';
        const diffStr = formatDiffQty(item.divergencia);
        if (!diffStr) continue;
        msg += `⦁\t${nome} (Dif. ${diffStr}) \n`;
    }

    return msg.trim();
}


// ================== FUNÇÃO PRINCIPAL POR CONTATO/GRUPO ==================

/**
 * Envia auditoria COP para um contato, percorrendo as unidades do grupo.
 * - contato: { nome, telefone, ... }
 * - grupo: { id, nome, ... }
 * - options: { dt_inicio?, dt_fim? }
 */
async function enviarAuditoriaCop(contato, grupo) {
    console.log(`[COP] ${contato} (${grupo})`);
    const { nome, telefone } = contato;
    const grupoId = grupo.id;
    const grupoNome = grupo.nome;
    console.log(`passei`)



        const padrao = getDefaultDates();
        const dt_inicio = padrao.dt_inicio;
        const dt_fim = padrao.dt_fim;

    log(
        `🔎 Iniciando auditoria COP para contato ${nome} (${telefone}) - grupo ${grupoNome} - período ${dt_inicio} a ${dt_fim}`,
        'enviarAuditoriaCop'
    );

    // pega as unidades do grupo
    const unidades = await callPHP('getUnitsByGroup', { group_id: grupoId });
    if (!Array.isArray(unidades) || unidades.length === 0) {
        log(`❌ Erro: retorno inesperado de getUnitsByGroup para grupo ${grupoNome}`, 'enviarAuditoriaCop');
        return;
    }

    for (const unidade of unidades) {
        const systemUnitId = unidade.system_unit_id || unidade.id;
        const unitName = unidade.name || unidade.nome || unidade.descricao || `Unidade ${systemUnitId}`;

        if (!systemUnitId) {
            log(`⚠️ Unidade sem system_unit_id no grupo ${grupoNome}`, 'enviarAuditoriaCop');
            continue;
        }

        try {
            // Busca dados de COP
            const apiData = await fetchCopData({
                system_unit_id: systemUnitId,
                dt_inicio,
                dt_fim
            });

            const itens = apiData?.itens || [];

            if (!Array.isArray(itens) || itens.length === 0) {
                log(
                    `ℹ️ Nenhum item com COP para unidade ${unitName} no período. Pulando envio para essa unidade.`,
                    'enviarAuditoriaCop'
                );
                continue;
            }

            // Gera o PDF usando os dados já obtidos
            const { publicUrl } = await generateCopPdf({
                system_unit_id: systemUnitId,
                unit_name: unitName,
                dt_inicio,
                dt_fim,
                apiData
            });

            const mensagem = montarMensagemAuditoria(nome, unitName, dt_fim, itens);

            log(
                `📨 Enviando auditoria COP para ${nome} (${telefone}) - unidade ${unitName}`,
                'enviarAuditoriaCop'
            );

            // 1) Mensagem texto
            await sendWhatsappText(telefone, mensagem);

            // 2) PDF
            if (publicUrl) {
                await sendWhatsappPdf(telefone, publicUrl);
            } else {
                log(
                    `⚠️ PUBLIC_BASE_REPORT_URL não configurada. PDF gerado localmente, mas sem URL pública para envio.`,
                    'enviarAuditoriaCop'
                );
            }
        } catch (err) {
            log(
                `❌ Erro ao processar auditoria COP para unidade ${unitName}: ${err.message}`,
                'enviarAuditoriaCop'
            );
        }
    }
}

// ================== WORKER PRINCIPAL (CRON / CLI) ==================

async function WorkerCopReport() {
    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: ID_DISPARO_COP });

    if (!contatosResp || !contatosResp.success) {
        log(`❌ Erro ao buscar contatos para disparo ${ID_DISPARO_COP}`, 'WorkerCopReport');
        return;
    }

    for (const contato of contatosResp.data) {
        if (!Array.isArray(contato.grupos) || contato.grupos.length === 0) {
            continue;
        }

        for (const grupo of contato.grupos) {
            await enviarAuditoriaCop(contato, grupo);
        }
    }
}

// ================== EXPORTS ==================

module.exports = {
    WorkerCopReport,
    enviarAuditoriaCop,
    generateCopPdf // se quiser usar direto em algum endpoint
};

// ================== EXECUÇÃO DIRETA (CRON) ==================

if (require.main === module) {
    WorkerCopReport()
        .then(() => {
            log('✅ WorkerCopReport finalizado', 'WorkerCopReport');
            process.exit(0);
        })
        .catch((err) => {
            log('❌ Erro geral no WorkerCopReport: ' + err.message, 'WorkerCopReport');
            process.exit(1);
        });
}
