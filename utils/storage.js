// utils/storage.js
// Arquivos dos jobs no S3 (bucket de arquivos da AWS), sem nada em disco no container.
//
// Tudo fica em private/<app>/<caminho>: os relatórios dos jobs em private/jobs-mrk/reports/ e os
// arquivos do portal (ex.: CSV do 3LM) em private/portal-mrk/... Quem precisa do arquivo (Z-API,
// navegador) recebe um link temporário (URL pré-assinada).
//
// Configuração: FILES_BUCKET, FILES_PREFIX (jobs-mrk) e AWS_REGION. A credencial vem da role da
// máquina (IMDS); não há chave de acesso no .env.
const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;

function s3() {
    if (!client) {
        client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    return client;
}

function bucket() {
    const name = process.env.FILES_BUCKET;
    if (!name) throw new Error('FILES_BUCKET não configurado');
    return name;
}

/** Chave no bucket: private/<app>/<caminho>. app padrão = FILES_PREFIX (jobs-mrk). */
function key(filePath, app = process.env.FILES_PREFIX || 'jobs-mrk') {
    const clean = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || /(^|\/)\.\.?(\/|$)/.test(clean)) {
        throw new Error(`Caminho inválido: ${filePath}`);
    }
    return `private/${String(app).replace(/^\/+|\/+$/g, '')}/${clean}`;
}

function isNotFound(err) {
    return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

async function put(filePath, body, contentType = 'application/octet-stream', app) {
    const Key = key(filePath, app);
    await s3().send(new PutObjectCommand({ Bucket: bucket(), Key, Body: body, ContentType: contentType }));
    return Key;
}

/** Conteúdo como Buffer, ou null se não existir. */
async function get(filePath, app) {
    try {
        const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key(filePath, app) }));
        return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

async function exists(filePath, app) {
    try {
        await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key(filePath, app) }));
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
    }
}

async function remove(filePath, app) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key(filePath, app) }));
}

/** Link temporário (padrão: 1 hora). */
async function url(filePath, ttlSeconds = 3600, app) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key(filePath, app) }), {
        expiresIn: ttlSeconds,
    });
}

/** Gera o PDF do pdfmake em memória (sem arquivo em disco). */
function pdfToBuffer(pdfDoc) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        pdfDoc.on('data', (c) => chunks.push(c));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        pdfDoc.end();
    });
}

/** Sobe um relatório PDF (reports/<nome>) e devolve o link temporário para a Z-API baixar. */
async function publishReport(fileName, buffer) {
    const filePath = `reports/${fileName}`;
    await put(filePath, buffer, 'application/pdf');
    return url(filePath, 3600);
}

module.exports = { key, put, get, exists, remove, url, pdfToBuffer, publishReport };
