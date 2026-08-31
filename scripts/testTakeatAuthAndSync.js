require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const { DateTime } = require('luxon');

async function testTakeat() {
    console.log('--- 🧪 Teste de Conexão e API Takeat ---');
    
    const email = 'peachtwocaminhodasarvores@takeat.app';
    const password = 'peachtwocaminhodasarvorestakeat';

    console.log(`1. Testando login via POST https://webhook.takeat.app/public/api/sessions para: ${email}...`);
    try {
        const respAuth = await axios.post('https://webhook.takeat.app/public/api/sessions', {
            email,
            password
        }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 20000
        });

        console.log('✅ Autenticação com Sucesso!');
        console.log('Restaurante:', respAuth.data.restaurant);
        const token = respAuth.data.token;
        const restaurantId = respAuth.data.restaurant?.id;
        console.log('Token JWT (prefixo):', token.slice(0, 30) + '...');

        console.log('\n2. Testando consulta de table-sessions (últimos 2 dias)...');
        const endDt = DateTime.now().setZone('America/Sao_Paulo').endOf('day').toUTC().toISO();
        const startDt = DateTime.now().setZone('America/Sao_Paulo').minus({ days: 2 }).startOf('day').toUTC().toISO();

        const params = {
            start_date: startDt,
            end_date: endDt
        };
        if (restaurantId) params.restaurant_id = restaurantId;

        console.log('Parâmetros:', params);

        let sessions = [];
        try {
            const respSessions = await axios.get('https://webhook.takeat.app/api/v1/table-sessions', {
                params,
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                timeout: 30000
            });
            sessions = respSessions.data || [];
            console.log(`✅ Sucesso via webhook.takeat.app! Retornadas ${Array.isArray(sessions) ? sessions.length : (sessions.data?.length || 0)} sessões.`);
        } catch (e1) {
            console.log(`⚠️ Tentativa via webhook falhou (${e1.message}), tentando public-api.takeat.app...`);
            const respSessions = await axios.get('https://public-api.takeat.app/v1/table-sessions', {
                params,
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                timeout: 30000
            });
            sessions = respSessions.data || [];
            console.log(`✅ Sucesso via public-api.takeat.app! Retornadas ${Array.isArray(sessions) ? sessions.length : (sessions.data?.length || 0)} sessões.`);
        }

        console.log('\n🎉 Teste concluído com êxito!');
    } catch (err) {
        console.error('❌ Erro no teste:', err.response?.data || err.message);
    }
}

testTakeat();
