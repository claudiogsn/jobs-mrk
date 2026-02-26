const fs = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');
const axios = require('axios');

/**
 * ======================================================
 * 1. SVGs COM OPACIDADE EMBUTIDA (CORREÇÃO)
 * Adicionei <g opacity="0.1"> dentro dos SVGs para forçar a transparência
 * ======================================================
 */

// GRAFISMO 01 (Topo) - Envolvi o conteúdo em um grupo <g opacity="0.1">
const SVG_GRAF_TOP = `
<svg width="100%" height="100%" viewBox="0 0 2732 2048" version="1.1" xmlns="http://www.w3.org/2000/svg">
    <g opacity="0.1"> <path d="M1366,449.468L1940.53,1024L1366,1598.53L791.468,1024L1366,449.468ZM1366,632.951L1757.05,1024L1366,1415.05L974.951,1024L1366,632.951Z" style="fill:url(#_Linear1);"/>
        <defs>
            <linearGradient id="_Linear1" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(1115.98,2.27374e-13,-2.27374e-13,1115.98,791.468,1024)"><stop offset="0" style="stop-color:rgb(244,164,72);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(227,79,87);stop-opacity:1"/></linearGradient>
        </defs>
    </g>
</svg>
`;

// GRAFISMO 02 (Rodapé) - Adicionei opacity="0.1" no grupo principal
const SVG_GRAF_BOTTOM = `
<svg width="100%" height="100%" viewBox="0 0 2732 2048" version="1.1" xmlns="http://www.w3.org/2000/svg">
    <g opacity="0.1" transform="matrix(1.97902,-1.97902,1.97902,1.97902,-3078.61,1762.38)"> <g transform="matrix(1.07942,0,0,1.07942,-127.9,-81.4412)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear1);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear2);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear3);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear4);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear5);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear6);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear7);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-133.3)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear8);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear9);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear10);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear11);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear12);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear13);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear14);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-185.16)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear15);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear16);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear17);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear18);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear19);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear20);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear21);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-237.019)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear22);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear23);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear24);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear25);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear26);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear27);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear28);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-288.878)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear29);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear30);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear31);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear32);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear33);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear34);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear35);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-340.738)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear36);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear37);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear38);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear39);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear40);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear41);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear42);"/>
            </g>
        </g>
        <g transform="matrix(1.07942,0,0,1.07942,-127.9,-392.597)">
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1017.23,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear43);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1113.36,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear44);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1209.02,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear45);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1065.46,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear46);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1161.59,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear47);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1257.25,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear48);"/>
            </g>
            <g transform="matrix(0.530829,0.530829,-0.530829,0.530829,1305.49,-144.07)">
                <circle cx="1320" cy="999.261" r="6.786" style="fill:url(#_Linear49);"/>
            </g>
        </g>
    </g>
    <defs>
        <linearGradient id="_Linear1" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(556.611,-1.02167e-13,1.02167e-13,556.611,1041.7,727.742)"><stop offset="0" style="stop-color:rgb(227,79,87);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(244,164,72);stop-opacity:1"/></linearGradient>
        <linearGradient id="_Linear2" x1="0" y1="0" x2="1" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="matrix(556.611,-1.02167e-13,1.02167e-13,556.611,951.154,818.285)"><stop offset="0" style="stop-color:rgb(227,79,87);stop-opacity:1"/><stop offset="1" style="stop-color:rgb(244,164,72);stop-opacity:1"/></linearGradient>
        </defs>
</svg>
`;

/**
 * ======================================================
 * 2. CONFIGURAÇÃO DE FONTES
 * ======================================================
 */
const fonts = {
    Teko: {
        normal: path.join(__dirname, 'fonts', 'Teko-Regular.ttf'),
        bold: path.join(__dirname, 'fonts', 'Teko-Medium.ttf'),
        italics: path.join(__dirname, 'fonts', 'Teko-Light.ttf')
    },
    Inter: {
        normal: path.join(__dirname, 'fonts', 'Inter-Regular.ttf'),
        bold: path.join(__dirname, 'fonts', 'Inter-Bold.ttf'),
        italics: path.join(__dirname, 'fonts', 'Inter-Regular.ttf'),
        bolditalics: path.join(__dirname, 'fonts', 'Inter-Bold.ttf')
    }
};

const printer = new PdfPrinter(fonts);

/**
 * ======================================================
 * 3. HELPERS
 * ======================================================
 */
const brMoney = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatDateBR = (dateStr) => {
    if (!dateStr) return '---';
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
};

// Carrega LOGO
function loadLogo() {
    try {
        const filePath = path.join(__dirname, 'logo-preta.png');
        if (fs.existsSync(filePath)) {
            return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
        }
        return null;
    } catch (e) { return null; }
}

/**
 * ======================================================
 * 4. FUNÇÃO PRINCIPAL
 * ======================================================
 */
async function generateBioneProposalNode(propostaId, showPrice = true) {
    try {
        console.log(`[1/3] Buscando dados da proposta ${propostaId}...`);
        const response = await axios.get(`http://localhost/proposta-bione/get_proposal.php?id=${propostaId}`);
        const data = response.data;

        if(!data || data.error) throw new Error("Dados inválidos.");
        const areas = JSON.parse(data.itens_json || '[]');
        const imgLogo = loadLogo();

        const docDefinition = {
            pageSize: 'A4',
            pageMargins: [40, 40, 40, 100],
            defaultStyle: { font: 'Inter', fontSize: 10, color: '#000' },

            // --- BACKGROUND ---
            // Agora que a opacidade está dentro do SVG, NÃO usamos opacity aqui
            background: function(currentPage, pageSize) {
                return [
                    {
                        svg: SVG_GRAF_TOP,
                        width: 500,
                        absolutePosition: { x: pageSize.width - 300, y: 0 }
                    },
                    {
                        svg: SVG_GRAF_BOTTOM,
                        width: 450, // Ajuste o tamanho
                        absolutePosition: { x: -80, y: pageSize.height - 300 }
                    }
                ];
            },

            footer: (currentPage, pageCount) => {
                return {
                    margin: [40, 0, 40, 0],
                    stack: [
                        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.1, lineColor: '#000' }] },
                        {
                            text: 'Bione Alugueis e Serviços de Informática LTDA | CNPJ: 11.204.447/0001-07\n' +
                                'Rua Luiza Maria da Conceição, 187, Renascer - Cabedelo – PB\n' +
                                'Fone: (83) 98871-9620 | bionetecnologia.com.br',
                            style: 'footerText',
                            margin: [0, 10, 0, 0]
                        }
                    ]
                };
            },

            // ... (restante dos styles e content igual ao anterior) ...
            styles: {
                headerTitle: { font: 'Teko', fontSize: 32, margin: [0, 0, 0, 5] },
                docNumber: { fontSize: 18, bold: true, alignment: 'center', margin: [0, 15, 0, 15] },
                tableHeader: { bold: true, fontSize: 9, color: 'white', fillColor: '#1e293b' },
                areaTitle: { fontSize: 12, bold: true, margin: [0, 15, 0, 5], uppercase: true },
                label: { bold: true },
                totalLabel: { fontSize: 12, bold: true, alignment: 'right', uppercase: true },
                totalValue: { font: 'Teko', italics: true, fontSize: 55, color: '#F4AA48', alignment: 'right', margin: [0, -12, 0, 0] },
                footerText: { fontSize: 9, color: '#444', alignment: 'center' },
                obsBox: { fontSize: 9, color: '#333' }
            },

            content: [
                // HEADER
                {
                    columns: [
                        {
                            width: '*',
                            stack: [
                                { text: 'Proposta Comercial', style: 'headerTitle' },
                                { text: [{ text: 'Cliente: ', style: 'label' }, data.cliente_nome || '---'] },
                                { text: [{ text: 'Email: ', style: 'label' }, data.cliente_email || '---'] },
                                { text: [{ text: 'Telefone: ', style: 'label' }, data.cliente_telefone || '---'] },
                            ]
                        },
                        {
                            width: 100,
                            image: imgLogo ? imgLogo : null,
                            width: 90,
                            alignment: 'right'
                        }
                    ]
                },

                { text: `PROPOSTA #${data.id}`, style: 'docNumber' },

                // DADOS EVENTO
                {
                    margin: [0, 0, 0, 10],
                    stack: [
                        { text: [{ text: 'Responsável: ', style: 'label' }, data.responsavel || '---'] },
                        { text: [{ text: 'Local: ', style: 'label' }, data.local_evento || 'A definir'] },
                        { text: [{ text: 'Data do Evento: ', style: 'label' }, formatDateBR(data.data_evento)] },
                    ]
                },

                // TABELAS
                ...areas.map(area => {
                    const tableBody = [
                        [
                            { text: 'Descrição', style: 'tableHeader' },
                            { text: 'Qtd', style: 'tableHeader', alignment: 'center' },
                            { text: 'Dias', style: 'tableHeader', alignment: 'center' },
                            ...(showPrice ? [
                                { text: 'Unitário', style: 'tableHeader', alignment: 'right' },
                                { text: 'Subtotal', style: 'tableHeader', alignment: 'right' }
                            ] : [])
                        ]
                    ];

                    area.itens.forEach(item => {
                        const sub = Number(item.qtd) * Number(item.dias) * Number(item.valor);
                        tableBody.push([
                            { text: item.nome, fontSize: 10 },
                            { text: item.qtd, alignment: 'center' },
                            { text: item.dias, alignment: 'center' },
                            ...(showPrice ? [
                                { text: brMoney(item.valor), alignment: 'right', fontSize: 10 },
                                { text: brMoney(sub), alignment: 'right', bold: true, fontSize: 10 }
                            ] : [])
                        ]);
                    });

                    return {
                        unbreakable: false,
                        stack: [
                            { text: area.nome, style: 'areaTitle' },
                            {
                                table: {
                                    headerRows: 1,
                                    widths: showPrice ? ['*', 30, 30, 70, 70] : ['*', 40, 40],
                                    body: tableBody
                                },
                                layout: {
                                    hLineWidth: () => 0.1,
                                    vLineWidth: () => 0.1,
                                    hLineColor: () => '#000',
                                    vLineColor: () => '#000',
                                    paddingLeft: () => 5,
                                    paddingRight: () => 5,
                                    paddingTop: () => 5,
                                    paddingBottom: () => 5
                                }
                            }
                        ]
                    };
                }),

                // TOTAL
                showPrice ? {
                    margin: [0, 20, 0, 0],
                    unbreakable: true,
                    stack: [
                        { text: 'Investimento Total', style: 'totalLabel' },
                        { text: brMoney(data.valor_total), style: 'totalValue' }
                    ]
                } : null,

                // CONSIDERAÇÕES
                {
                    margin: [0, 30, 0, 0],
                    unbreakable: true,
                    stack: [
                        { text: 'Observações / Considerações Gerais', style: 'label', fontSize: 8, color: '#666', margin: [0, 0, 0, 2] },
                        {
                            table: {
                                widths: ['*'],
                                body: [
                                    [{
                                        text: data.consideracoes_gerais || 'Nenhuma observação.',
                                        style: 'obsBox',
                                        fillColor: '#fafafa',
                                        margin: [5, 5]
                                    }]
                                ]
                            },
                            layout: {
                                hLineWidth: () => 0.1,
                                vLineWidth: () => 0.1,
                                hLineColor: () => '#ccc',
                                vLineColor: () => '#ccc'
                            }
                        }
                    ]
                }
            ]
        };

        console.log(`[2/3] Gerando PDF...`);
        const pdfDoc = printer.createPdfKitDocument(docDefinition);
        const reportsDir = path.join(__dirname, 'reports');
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

        const fileName = `Proposta_${propostaId}.pdf`;
        pdfDoc.pipe(fs.createWriteStream(path.join(reportsDir, fileName)));
        pdfDoc.end();

        console.log(`✅ [3/3] Sucesso! PDF salvo em: reports/${fileName}`);

    } catch (err) {
        console.error("❌ Erro fatal:", err.message);
    }
}

generateBioneProposalNode('319022026', true);