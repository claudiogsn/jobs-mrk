require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

async function inspectComplements() {
    const email = 'peachtwocaminhodasarvores@takeat.app';
    const password = 'peachtwocaminhodasarvorestakeat';

    const respAuth = await axios.post('https://webhook.takeat.app/public/api/sessions', { email, password });
    const token = respAuth.data.token;
    const restaurantId = respAuth.data.restaurant?.id;

    const resp = await axios.get('https://webhook.takeat.app/api/v1/products', {
        params: { restaurant_id: restaurantId },
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });

    const categories = resp.data || [];
    let complementsFound = 0;
    const sampleComplements = [];

    for (const cat of categories) {
        for (const p of (cat.products || [])) {
            if (p.complement_categories && p.complement_categories.length > 0) {
                for (const cc of p.complement_categories) {
                    for (const comp of (cc.complements || [])) {
                        complementsFound++;
                        sampleComplements.push({
                            product_id: p.id,
                            product_name: p.name,
                            category_complement_name: cc.name,
                            complement_id: comp.id,
                            complement_name: comp.name,
                            price: comp.price
                        });
                    }
                }
            }
        }
    }

    console.log(`Total de complementos/adicionais encontrados no catálogo: ${complementsFound}`);
    console.log('Primeiros 5 complementos:', JSON.stringify(sampleComplements.slice(0, 5), null, 2));
}

inspectComplements();
