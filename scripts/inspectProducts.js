require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');

async function inspectProducts() {
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
    console.log(`Total de categorias retornadas: ${categories.length}`);

    let totalProducts = 0;
    const sampleProducts = [];

    for (const cat of categories) {
        const prods = cat.products || [];
        totalProducts += prods.length;
        for (const p of prods) {
            sampleProducts.push({
                category_id: cat.id,
                category_name: cat.name,
                product_id: p.id,
                product_name: p.name,
                price: p.price,
                pdv_code: p.pdv_code || p.pdv_codes || null,
                available: p.available
            });
        }
    }

    console.log(`Total de produtos em todas as categorias: ${totalProducts}`);
    console.log('Primeiros 5 produtos:', JSON.stringify(sampleProducts.slice(0, 5), null, 2));
}

inspectProducts();
