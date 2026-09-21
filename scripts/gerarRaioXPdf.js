const fs = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');

const fonts = {
    Roboto: {
        normal: path.join(__dirname, '../workers/fonts', 'Roboto-Regular.ttf'),
        bold: path.join(__dirname, '../workers/fonts', 'Roboto-Medium.ttf'),
        italics: path.join(__dirname, '../workers/fonts', 'Roboto-Italic.ttf'),
        bolditalics: path.join(__dirname, '../workers/fonts', 'Roboto-MediumItalic.ttf')
    }
};

const printer = new PdfPrinter(fonts);

let logoBase64 = null;
const logoPath = path.join(__dirname, '../workers/logo.png');
if (fs.existsSync(logoPath)) {
    const logoBuffer = fs.readFileSync(logoPath);
    logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
}

const docDefinition = {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [32, 26, 32, 26],
    defaultStyle: {
        font: 'Roboto',
        fontSize: 8.5,
        color: '#1e293b'
    },
    styles: {
        headerTitle: {
            fontSize: 14,
            bold: true,
            color: '#0284c7'
        },
        headerSubtitle: {
            fontSize: 8.5,
            color: '#64748b',
            margin: [0, 1, 0, 0]
        },
        sectionTitle: {
            fontSize: 10,
            bold: true,
            color: '#0f172a',
            margin: [0, 6, 0, 2]
        },
        cardBox: {
            fillColor: '#f8fafc',
            margin: [0, 0, 0, 4]
        },
        tableHeader: {
            bold: true,
            fontSize: 7.5,
            fillColor: '#0284c7',
            color: '#ffffff',
            alignment: 'center'
        },
        tableHeaderSecondary: {
            bold: true,
            fontSize: 7.5,
            fillColor: '#e2e8f0',
            color: '#0f172a',
            alignment: 'center'
        },
        tableCell: {
            fontSize: 7.5,
            margin: [2, 1.5, 2, 1.5]
        },
        tableCellCenter: {
            fontSize: 7.5,
            alignment: 'center',
            margin: [2, 1.5, 2, 1.5]
        },
        tableCellRight: {
            fontSize: 7.5,
            alignment: 'right',
            margin: [2, 1.5, 2, 1.5]
        },
        calloutBox: {
            fillColor: '#f0fdf4',
            color: '#166534',
            fontSize: 8
        }
    },
    content: [
        // Top Header
        {
            columns: [
                logoBase64 ? { image: logoBase64, width: 110 } : { text: 'MRK SOLUÇÕES', bold: true, fontSize: 16, color: '#0284c7' },
                {
                    stack: [
                        { text: 'LAUDO TÉCNICO & RAIO-X DE ESTOQUE', style: 'headerTitle', alignment: 'right' },
                        { text: 'Auditoria de Saldos e Rastreabilidade Contábil', style: 'headerSubtitle', alignment: 'right' },
                        { text: 'Emissão: 13/09/2026 às 11:06 | Sistema MRK', style: 'headerSubtitle', alignment: 'right' }
                    ]
                }
            ]
        },
        {
            canvas: [
                { type: 'line', x1: 0, y1: 8, x2: 523, y2: 8, lineWidth: 2, lineColor: '#0284c7' }
            ],
            margin: [0, 0, 0, 8]
        },

        // 1. Identificação do Produto e Unidade
        { text: '1. IDENTIFICAÇÃO DO PRODUTO E UNIDADE', style: 'sectionTitle' },
        {
            table: {
                widths: ['25%', '25%', '25%', '25%'],
                body: [
                    [
                        { text: 'Unidade:', bold: true, style: 'tableCell' },
                        { text: '24 - Casa Iryna', style: 'tableCell' },
                        { text: 'Código do Produto:', bold: true, style: 'tableCell' },
                        { text: '2000153', bold: true, color: '#0284c7', style: 'tableCell' }
                    ],
                    [
                        { text: 'Nome do Produto:', bold: true, style: 'tableCell' },
                        { text: 'FILE CRUDO 80G', bold: true, style: 'tableCell' },
                        { text: 'Unidade de Medida:', bold: true, style: 'tableCell' },
                        { text: 'UND', style: 'tableCell' }
                    ],
                    [
                        { text: 'Classificação:', bold: true, style: 'tableCell' },
                        { text: 'Insumo (Ativo)', style: 'tableCell' },
                        { text: 'Categoria:', bold: true, style: 'tableCell' },
                        { text: '36', style: 'tableCell' }
                    ],
                    [
                        { text: 'Saldo Atual no Cadastro:', bold: true, style: 'tableCell' },
                        { text: '20.0000 UND (100% Alinhado)', bold: true, color: '#16a34a', style: 'tableCell' },
                        { text: 'Status da Auditoria:', bold: true, style: 'tableCell' },
                        { text: 'Auditado e Validado', bold: true, color: '#16a34a', style: 'tableCell' }
                    ]
                ]
            },
            layout: {
                fillColor: (rowIndex) => (rowIndex % 2 === 0 ? '#f8fafc' : '#ffffff'),
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => '#e2e8f0',
                vLineColor: () => '#e2e8f0'
            }
        },

        // 2. Diagnóstico da Auditoria
        { text: '2. DIAGNÓSTICO: ANTES vs DEPOIS DO RECÁLCULO', style: 'sectionTitle' },
        {
            table: {
                widths: ['40%', '30%', '30%'],
                body: [
                    [
                        { text: 'Métrica Auditada', style: 'tableHeader' },
                        { text: 'Antes do Recálculo', style: 'tableHeader' },
                        { text: 'Após o Recálculo (Atual)', style: 'tableHeader' }
                    ],
                    [
                        { text: 'Saldo no Cadastro (products.saldo)', bold: true, style: 'tableCell' },
                        { text: '9.0010 UND  [INCORRETO]', bold: true, color: '#dc2626', style: 'tableCellCenter' },
                        { text: '20.0000 UND  [CORRIGIDO]', bold: true, color: '#16a34a', style: 'tableCellCenter' }
                    ],
                    [
                        { text: 'Saldo Físico Real Auditado', bold: true, style: 'tableCell' },
                        { text: '20.0000 UND', style: 'tableCellCenter' },
                        { text: '20.0000 UND', style: 'tableCellCenter' }
                    ],
                    [
                        { text: 'Divergência Contábil', bold: true, style: 'tableCell' },
                        { text: '-10.9990 UND (Defasagem)', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '0.0000 UND (Perfeito)', bold: true, color: '#16a34a', style: 'tableCellCenter' }
                    ]
                ]
            },
            layout: {
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => '#cbd5e1',
                vLineColor: () => '#cbd5e1'
            }
        },

        // 3. Causa Raiz da Divergência
        { text: '3. CAUSA RAIZ DA DIVERGÊNCIA IDENTIFICADA', style: 'sectionTitle' },
        {
            text: [
                { text: '• Balanço Físico Registrado: ', bold: true },
                'No dia 07/09/2026 às 15:18, foi concluído o Balanço Físico Oficial (Doc: b-000033) por Jonatas Ribeiro, apurando a contagem física real de 33 UND.\n',
                { text: '• Falha do Algoritmo Anterior: ', bold: true },
                'O antigo job da madrugada (WorkerConsolidationStock) não recalculava a partir do Marco Zero do balanço; ele apenas subtraía as saídas do dia sobre o saldo pré-existente no cadastro. Como o produto continha resíduos decimais antigos (0.001 de produções mp-000007), o saldo no banco foi decrescendo erroneamente (14.001 no dia 11/09 e 9.0010 no dia 12/09 às 08:01), ignorando os 33 contados no balanço.\n',
                { text: '• Solução Definitiva com o Novo Recálculo: ', bold: true },
                'Ao rodar a nova função de recálculo inteligente, o sistema adotou o balanço de 33 UND como Marco Zero inegociável, auditou as 5 saídas por venda subsequentes (-13 UND) e ajustou o saldo contábil para 20.0000 UND.'
            ],
            style: 'tableCell',
            lineHeight: 1.2
        },

        // 4. Demonstrativo Contábil Rastreável
        { text: '4. DEMONSTRATIVO CONTÁBIL RASTREÁVEL (MARCO ZERO)', style: 'sectionTitle' },
        {
            table: {
                widths: ['75%', '25%'],
                body: [
                    [
                        { text: '(+) Marco Zero: Balanço Físico (b-000033 em 07/09/2026 às 15:18)', bold: true, style: 'tableCell' },
                        { text: '33.0000 UND', bold: true, style: 'tableCellRight' }
                    ],
                    [
                        { text: '(+) Entradas de Notas Fiscais e Transferências Recebidas (08 a 12/09)', style: 'tableCell' },
                        { text: '+0.0000 UND', style: 'tableCellRight' }
                    ],
                    [
                        { text: '(-) Saídas por Vendas PDV (08 a 12/09)', style: 'tableCell' },
                        { text: '-13.0000 UND', color: '#dc2626', style: 'tableCellRight' }
                    ],
                    [
                        { text: '(+/-) Documentos Manuais de Ajuste de Saldo Registrados', style: 'tableCell' },
                        { text: '+0.0000 UND', style: 'tableCellRight' }
                    ],
                    [
                        { text: '(=) SALDO FINAL AUDITADO E CORRIGIDO', bold: true, color: '#0284c7', style: 'tableCell' },
                        { text: '20.0000 UND', bold: true, color: '#0284c7', style: 'tableCellRight' }
                    ]
                ]
            },
            layout: {
                fillColor: (rowIndex) => (rowIndex === 4 ? '#e0f2fe' : (rowIndex % 2 === 0 ? '#f8fafc' : '#ffffff')),
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => '#cbd5e1',
                vLineColor: () => '#cbd5e1'
            }
        },

        // 5. Detalhamento Cronológico dos Documentos Considerados
        { text: '5. RASTREABILIDADE CRONOLÓGICA DOS DOCUMENTOS CONSIDERADOS', style: 'sectionTitle' },
        {
            table: {
                widths: ['15%', '18%', '17%', '14%', '14%', '22%'],
                body: [
                    [
                        { text: 'Data', style: 'tableHeader' },
                        { text: 'Documento', style: 'tableHeader' },
                        { text: 'Operação', style: 'tableHeader' },
                        { text: 'Qtd Mov.', style: 'tableHeader' },
                        { text: 'Saldo Após', style: 'tableHeader' },
                        { text: 'Observação / Auditoria', style: 'tableHeader' }
                    ],
                    [
                        { text: '07/09/2026', style: 'tableCellCenter' },
                        { text: 'b-000033', bold: true, color: '#0284c7', style: 'tableCellCenter' },
                        { text: 'Balanço Físico', bold: true, style: 'tableCell' },
                        { text: '33', bold: true, color: '#16a34a', style: 'tableCellCenter' },
                        { text: '33 UND', bold: true, style: 'tableCellCenter' },
                        { text: 'Marco Zero Oficial (Jonatas Ribeiro)', style: 'tableCell' }
                    ],
                    [
                        { text: '08/09/2026', style: 'tableCellCenter' },
                        { text: 'v-20260908', style: 'tableCellCenter' },
                        { text: 'Venda PDV', style: 'tableCell' },
                        { text: '-1', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '32 UND', style: 'tableCellCenter' },
                        { text: 'Baixa de vendas diárias', style: 'tableCell' }
                    ],
                    [
                        { text: '09/09/2026', style: 'tableCellCenter' },
                        { text: 'v-20260909', style: 'tableCellCenter' },
                        { text: 'Venda PDV', style: 'tableCell' },
                        { text: '-2', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '30 UND', style: 'tableCellCenter' },
                        { text: 'Baixa de vendas diárias', style: 'tableCell' }
                    ],
                    [
                        { text: '10/09/2026', style: 'tableCellCenter' },
                        { text: 'v-20260910', style: 'tableCellCenter' },
                        { text: 'Venda PDV', style: 'tableCell' },
                        { text: '-1', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '29 UND', style: 'tableCellCenter' },
                        { text: 'Baixa de vendas diárias', style: 'tableCell' }
                    ],
                    [
                        { text: '11/09/2026', style: 'tableCellCenter' },
                        { text: 'v-20260911', style: 'tableCellCenter' },
                        { text: 'Venda PDV', style: 'tableCell' },
                        { text: '-4', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '25 UND', style: 'tableCellCenter' },
                        { text: 'Baixa de vendas diárias', style: 'tableCell' }
                    ],
                    [
                        { text: '12/09/2026', style: 'tableCellCenter' },
                        { text: 'v-20260912', style: 'tableCellCenter' },
                        { text: 'Venda PDV', style: 'tableCell' },
                        { text: '-5', color: '#dc2626', style: 'tableCellCenter' },
                        { text: '20 UND', bold: true, color: '#0284c7', style: 'tableCellCenter' },
                        { text: 'Baixa de vendas diárias', style: 'tableCell' }
                    ]
                ]
            },
            layout: {
                fillColor: (rowIndex) => (rowIndex === 0 ? '#0284c7' : (rowIndex === 1 ? '#f0fdf4' : (rowIndex % 2 === 0 ? '#f8fafc' : '#ffffff'))),
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => '#cbd5e1',
                vLineColor: () => '#cbd5e1'
            }
        },

        // 6. Registro de Auditoria e Integridade
        { text: '6. HISTÓRICO NO BANCO DE DADOS & SEGURANÇA CONTÁBIL', style: 'sectionTitle' },
        {
            table: {
                widths: ['100%'],
                body: [
                    [
                        {
                            stack: [
                                { text: '• Registro de Reprocessamento: ID 2100 na tabela estoque_recalculo_log.', bold: true },
                                { text: '• Data/Hora da Execução: 13/09/2026 às 11:00:11 (Disparado via Tela de Saldos pelo Usuário 1).' },
                                { text: '• Resumo JSON: Todos os 6 documentos acima foram serializados em formato JSON estruturado na tabela de log.' },
                                { text: '• Tabela ajustes_saldo: NENHUM documento avulso foi gerado, garantindo conformidade e não poluindo os ajustes manuais.' },
                                { text: '• Prevenção Definitiva: A mutação de saldo foi removida do WorkerConsolidationStock e centralizada no novo worker matinal das 05:15 (WorkerRecalcularSaldos), impedindo que desvios ocorram novamente nas madrugadas.' }
                            ],
                            style: 'tableCell',
                            lineHeight: 1.2
                        }
                    ]
                ]
            },
            layout: {
                fillColor: () => '#f8fafc',
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => '#cbd5e1',
                vLineColor: () => '#cbd5e1'
            }
        },

        // Parecer Técnico Final
        {
            table: {
                widths: ['100%'],
                body: [
                    [
                        {
                            text: 'PARECER TÉCNICO FINAL: O saldo de 20 UND no produto 2000153 (FILE CRUDO 80G) na Casa Iryna está 100% exato, comprovado matematicamente pelo Balanço Físico de 33 UND descontadas as 13 saídas legítimas de vendas. A inconsistência anterior de 9.0010 UND decorria do algoritmo antigo e já foi permanentemente eliminada da arquitetura.',
                            bold: true,
                            color: '#0369a1',
                            alignment: 'justify',
                            style: 'tableCell',
                            margin: [4, 4, 4, 4]
                        }
                    ]
                ]
            },
            layout: {
                fillColor: () => '#f0f9ff',
                hLineWidth: () => 1,
                vLineWidth: () => 1,
                hLineColor: () => '#0284c7',
                vLineColor: () => '#0284c7'
            },
            margin: [0, 8, 0, 0]
        }
    ],
    footer: function(currentPage, pageCount) {
        return {
            columns: [
                { text: 'MRK Soluções — Sistema de Gestão e Inteligência em Food Service', fontSize: 7.5, color: '#94a3b8', margin: [36, 0, 0, 0] },
                { text: `Página ${currentPage} de ${pageCount}`, fontSize: 7.5, color: '#94a3b8', alignment: 'right', margin: [0, 0, 36, 0] }
            ]
        };
    }
};

const outputPath = path.resolve(__dirname, '../../RaioX_Produto_2000153_Unidade24.pdf');

const pdfDoc = printer.createPdfKitDocument(docDefinition);
const stream = fs.createWriteStream(outputPath);
pdfDoc.pipe(stream);
pdfDoc.end();

stream.on('finish', () => {
    console.log(`✅ PDF gerado com sucesso em: ${outputPath}`);
    process.exit(0);
});
stream.on('error', (err) => {
    console.error(`❌ Erro ao gerar PDF: ${err.message}`);
    process.exit(1);
});
