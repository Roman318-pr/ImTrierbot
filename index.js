const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 10000;

// ========== 1. ИНИЦИАЛИЗАЦИЯ FIREBASE ==========
let db;
try {
    const serviceAccount = {
        "type": "service_account",
        "project_id": "imtrierbot",
        "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
        "private_key": process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        "client_email": process.env.FIREBASE_CLIENT_EMAIL,
        "client_id": process.env.FIREBASE_CLIENT_ID,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs"
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    
    db = admin.database();
    console.log('✅ Firebase успешно инициализирован');
} catch (error) {
    console.error('❌ Ошибка инициализации Firebase:', error);
}

app.use(express.json());

// ========== 2. API ЭНДПОИНТЫ ==========

// Проверка здоровья
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

// Получение NFT пользователя
app.get('/api/user/:userId/nfts', async (req, res) => {
    const userId = req.params.userId;
    
    try {
        const nftsRef = db.ref(`users/${userId}/nfts`);
        const snapshot = await nftsRef.once('value');
        const nfts = snapshot.val() || {};
        
        // Преобразуем объект в массив
        const nftsArray = Object.values(nfts).map(nft => ({
            ...nft,
            staked: nft.staked || false
        }));
        
        res.json(nftsArray);
    } catch (error) {
        console.error('Ошибка получения NFT:', error);
        res.status(500).json({ error: error.message });
    }
});

// Добавление NFT (для админа)
app.post('/api/user/:userId/nfts/add', async (req, res) => {
    const userId = req.params.userId;
    const { name, collection, image, priceTON } = req.body;
    
    try {
        const nftId = `nft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const nftRef = db.ref(`users/${userId}/nfts/${nftId}`);
        
        await nftRef.set({
            id: nftId,
            name: name || 'Unknown NFT',
            collection: collection || 'Unknown',
            image: image || '🎨',
            priceTON: priceTON || 0,
            staked: false,
            receivedAt: Date.now()
        });
        
        console.log(`✅ NFT добавлен пользователю ${userId}`);
        res.json({ success: true, nftId });
    } catch (error) {
        console.error('Ошибка добавления NFT:', error);
        res.status(500).json({ error: error.message });
    }
});

// Обновление статуса NFT (stake/unstake)
app.post('/api/nft/:nftId/stake', async (req, res) => {
    const { nftId } = req.params;
    const { userId, color, stake } = req.body;
    
    try {
        const nftRef = db.ref(`users/${userId}/nfts/${nftId}`);
        await nftRef.update({
            staked: stake,
            betColor: stake ? color : null,
            stakedAt: stake ? Date.now() : null
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка обновления NFT:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получение информации о NFT из Tonnel
app.get('/api/nft/:address/info', async (req, res) => {
    try {
        const response = await axios.post('https://market.tonnel.network/api/gifts/getGifts', {
            address: req.params.address,
            limit: 1
        });
        res.json(response.data[0] || null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получение минимальных цен коллекций
app.get('/api/collections/prices', async (req, res) => {
    try {
        const collections = ['toy bear', 'durov cap', 'heart locket', 'plush pepe', 'swiss watch'];
        const prices = {};
        
        for (const collection of collections) {
            const response = await axios.post('https://market.tonnel.network/api/gifts/getGifts', {
                gift_name: collection,
                limit: 30,
                sort: 'price_asc'
            });
            
            if (response.data) {
                const floorPrices = {};
                response.data.forEach(gift => {
                    if (!floorPrices[gift.model] || gift.price < floorPrices[gift.model]) {
                        floorPrices[gift.model] = gift.price;
                    }
                });
                prices[collection] = floorPrices;
            }
        }
        
        res.json(prices);
    } catch (error) {
        console.error('Ошибка получения цен:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== 3. ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('🎰 NFT Gift Server запущен');
    console.log(`📡 Порт: ${PORT}`);
    console.log(`🔥 Firebase: ${process.env.FIREBASE_DATABASE_URL ? '✅' : '❌'}`);
    console.log('=================================');
});
