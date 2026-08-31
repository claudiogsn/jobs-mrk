require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

async function testCatalog() {
    const email = 'peachtwocaminhodasarvores@takeat.app';
    const password = 'peachtwocaminhodasarvorestakeat';

    console.log('1. Autenticando na Takeat...');
    const respAuth = await axios.post('https://webhook.takeat.app/public/api/sessions', {
        email,
        password
    });
    const token = respAuth.data.token;
    const restaurantId = respAuth.data.restaurant?.id;

    console.log('Token obtido para restaurantId:', restaurantId);

    const endpoints = [
        { name: 'Products (webhook)', url: 'https://webhook.takeat.app/api/v1/products' },
        { name: 'Products (public-api)', url: 'https://public-api.takeat.app/v1/products' },
        { name: 'Menu (webhook)', url: 'https://webhook.takeat.app/api/v1/menu' },
        { name: 'Menu (public-api)', url: 'https://public-api.takeat.app/v1/menu' },
        { name: 'Inputs (public-api)', url: 'https://public-api.takeat.app/v1/inputs' },
        { name: 'Intermediaries (public-api)', url: 'https://public-api.takeat.app/v1/intermediaries' }
    ];

    for (const ep of endpoints) {
        console.log(`\nTesting ${ep.name} -> ${ep.url}...`);
        try {
            const resp = await axios.get(ep.url, {
                params: { restaurant_id: restaurantId },
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                timeout: 15000
            });
            const data = resp.data;
            const items = Array.isArray(data) ? data : (data.data || data.products || data.items || []);
            console.log(`✅ Sucesso! Retornados ${items.length} itens. Formato:`, Array.isArray(data) ? 'Array' : Object.keys(data));
            if (items.length > 0) {
                console.log('Exemplo de item 0:', JSON.stringify(items[0]).slice(0, 300));
            }
        } catch (e) {
            console.log(`❌ Erro: ${e.response?.status} - ${JSON.stringify(e.response?.data || e.message)}`);
        }
    }
}

testCatalog();
