const axios = require('axios');
const { log } = require('./logger');

const TAKEAT_SESSION_URL = 'https://webhook.takeat.app/public/api/sessions';

/**
 * Obtém token JWT válido e dados da loja a partir de unit_integracoes.
 * Se o token estiver expirado ou ausente, faz o login via API da Takeat.
 * 
 * @param {object} conn Conexão MySQL
 * @param {number} systemUnitId ID da unidade
 * @returns {Promise<{token: string, restaurantId: number|null, fantasyName: string, cnpj: string}>}
 */
async function getTakeatSession(conn, systemUnitId) {
    const [rows] = await conn.execute(`
        SELECT id, system_unit_id, config, status, ativo
        FROM unit_integracoes
        WHERE system_unit_id = ? AND provider = 'takeat' AND ativo = 1
    `, [systemUnitId]);

    if (rows.length === 0) {
        throw new Error(`Unidade #${systemUnitId} não possui integração Takeat ativa em unit_integracoes.`);
    }

    let config = rows[0].config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {
            config = {};
        }
    }
    if (!config) config = {};

    const tokenCreatedAt = config.token_created_at ? new Date(config.token_created_at) : null;
    const dezDiasEmMs = 10 * 24 * 60 * 60 * 1000;

    // Se possui token e tem menos de 10 dias, reutiliza com segurança
    if (config.token && tokenCreatedAt && (Date.now() - tokenCreatedAt.getTime() < dezDiasEmMs)) {
        return {
            token: config.token,
            restaurantId: config.restaurant_id || null,
            fantasyName: config.fantasy_name || config.restaurant_name || '',
            cnpj: config.cnpj || ''
        };
    }

    if (!config.email || !config.password) {
        throw new Error(`Unidade #${systemUnitId} não possui e-mail e senha configurados no provider Takeat.`);
    }

    log(`[Takeat Auth #${systemUnitId}] Autenticando sessão na Takeat para ${config.email}...`, 'takeat');

    const resp = await axios.post(TAKEAT_SESSION_URL, {
        email: config.email,
        password: config.password
    }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 20000
    });

    if (!resp.data || !resp.data.token) {
        throw new Error(`Resposta inválida ao autenticar na Takeat: ${JSON.stringify(resp.data)}`);
    }

    const token = resp.data.token;
    const restaurant = resp.data.restaurant || {};

    config.token = token;
    config.restaurant_id = restaurant.id || config.restaurant_id;
    config.restaurant_name = restaurant.name || config.restaurant_name;
    config.fantasy_name = restaurant.fantasy_name || config.fantasy_name;
    config.cnpj = restaurant.cnpj || config.cnpj;
    config.token_created_at = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await conn.execute(`
        UPDATE unit_integracoes
        SET config = ?, status = 'CONECTADA', ultimo_erro = NULL, updated_at = NOW()
        WHERE system_unit_id = ? AND provider = 'takeat'
    `, [JSON.stringify(config), systemUnitId]);

    return {
        token,
        restaurantId: config.restaurant_id,
        fantasyName: config.fantasy_name || config.restaurant_name || '',
        cnpj: config.cnpj || ''
    };
}

module.exports = { getTakeatSession };
