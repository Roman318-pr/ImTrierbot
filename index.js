// index.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cron = require('node-cron');
const winston = require('winston');
const { TonClient } = require('ton');
const { Address } = require('ton-core');

// ========== 1. НАСТРОЙКА ЛОГИРОВАНИЯ ==========
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

// ========== 2. ИНИЦИАЛИЗАЦИЯ FIREBASE ==========
let firebaseApp;
try {
    const serviceAccount = require('./firebase-key.json');
    firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    logger.info('Firebase успешно инициализирован');
} catch (error) {
    logger.error('Ошибка инициализации Firebase:', error);
    process.exit(1);
}

const db = admin.database();

// ========== 3. ИНИЦИАЛИЗАЦИЯ TON CLIENT ==========
let tonClient;
try {
    tonClient = new TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY
    });
    logger.info('TON клиент успешно инициализирован');
} catch (error) {
    logger.error('Ошибка инициализации TON клиента:', error);
    process.exit(1);
}

// ========== 4. КЭШ ДЛЯ УЖЕ ОБРАБОТАННЫХ ТРАНЗАКЦИЙ ==========
const processedTransactions = new Set();

// ========== 5. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

/**
 * Получение информации о NFT по его адресу
 * @param {string} nftAddress - адрес NFT контракта
 */
async function getNFTInfo(nftAddress) {
    try {
        const address = Address.parse(nftAddress);

        // Получаем данные NFT через TON Center API
        const response = await axios.post('https://toncenter.com/api/v2/jsonRPC', {
            jsonrpc: '2.0',
            method: 'getNftData',
            params: [nftAddress],
            id: 1
        }, {
            headers: { 'X-API-Key': process.env.TONCENTER_API_KEY }
        });

        if (response.data && response.data.result) {
            const data = response.data.result;

            // Получаем метаданные
            let metadata = {
                name: 'Unknown NFT',
                description: '',
                image: '',
                collection: '',
                attributes: []
            };

            if (data.content && data.content.uri) {
                try {
                    const metaResponse = await axios.get(data.content.uri);
                    metadata = { ...metadata, ...metaResponse.data };
                } catch (metaError) {
                    logger.warn('Не удалось загрузить метаданные:', metaError.message);
                }
            }

            // Получаем цену с маркетплейса (опционально)
            const price = await getNFTPrice(nftAddress);

            return {
                id: nftAddress,
                name: metadata.name,
                collection: metadata.collection || data.collection_name || 'Unknown',
                image: metadata.image || '',
                description: metadata.description || '',
                attributes: metadata.attributes || [],
                owner: data.owner,
                priceTON: price,
                lastTransfer: data.last_transaction_time,
                metadata: metadata
            };
        }
        return null;
    } catch (error) {
        logger.error('Ошибка получения информации NFT:', error);
        return null;
    }
}

/**
 * Получение рыночной цены NFT (опционально)
 * @param {string} nftAddress
 */
async function getNFTPrice(nftAddress) {
    try {
        // Пробуем получить цену с Getgems
        const response = await axios.get(`https://api.getgems.io/v1/nft/${nftAddress}/price`);
        if (response.data && response.data.price) {
            return response.data.price;
        }

        // Пробуем Tonnel
        const tonnelResponse = await axios.post('https://market.tonnel.network/api/gifts/getGifts', {
            address: nftAddress,
            limit: 1
        });

        if (tonnelResponse.data && tonnelResponse.data[0]) {
            return tonnelResponse.data[0].price;
        }

        return 0;
    } catch (error) {
        logger.debug('Не удалось получить цену NFT:', error.message);
        return 0;
    }
}

/**
 * Поиск пользователя по адресу кошелька в Firebase
 * @param {string} walletAddress
 */
async function findUserByWallet(walletAddress) {
    try {
        const usersRef = db.ref('users');
        const snapshot = await usersRef.orderByChild('wallet/address').equalTo(walletAddress).once('value');

        const users = snapshot.val();
        if (users) {
            // Возвращаем первого найденного пользователя
            const userId = Object.keys(users)[0];
            return {
                id: userId,
                ...users[userId]
            };
        }
        return null;
    } catch (error) {
        logger.error('Ошибка поиска пользователя:', error);
        return null;
    }
}

/**
 * Добавление NFT в инвентарь пользователя
 * @param {string} userId
 * @param {object} nftData
 */
async function addNFTToInventory(userId, nftData) {
    try {
        const userNFTsRef = db.ref(`users/${userId}/nfts`);

        // Генерируем уникальный ID для NFT
        const nftId = `nft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        await userNFTsRef.child(nftId).set({
            ...nftData,
            id: nftId,
            receivedAt: Date.now(),
            staked: false,
            gameId: null
        });

        logger.info(`NFT ${nftData.name} добавлен пользователю ${userId}`);
        return true;
    } catch (error) {
        logger.error('Ошибка добавления NFT:', error);
        return false;
    }
}

/**
 * Проверка транзакции на наличие NFT перевода
 * @param {object} transaction
 */
async function checkTransaction(transaction) {
    try {
        // Проверяем, не обрабатывали ли мы эту транзакцию
        if (processedTransactions.has(transaction.hash)) {
            return;
        }

        // Проверяем, является ли получатель нашим адресом
        const receiverAddress = process.env.RECEIVER_ADDRESS;
        if (!transaction.out_msgs || !transaction.out_msgs.length) return;

        for (const msg of transaction.out_msgs) {
            // Проверяем, отправлено ли сообщение на наш адрес
            if (msg.destination === receiverAddress) {
                // Проверяем, является ли это переводом NFT
                if (msg.body && msg.body.includes('5fcc3d14')) { // opcode transfer
                    logger.info('Обнаружен перевод NFT!', {
                        hash: transaction.hash,
                        from: msg.source,
                        to: msg.destination
                    });

                    // Ищем отправителя в нашей базе
                    const sender = await findUserByWallet(msg.source);

                    if (sender) {
                        // Получаем информацию о NFT
                        const nftInfo = await getNFTInfo(msg.source); // В реальности нужно извлекать адрес NFT из тела сообщения

                        if (nftInfo) {
                            // Добавляем NFT в инвентарь отправителя
                            await addNFTToInventory(sender.id, nftInfo);

                            // Отправляем уведомление пользователю
                            await sendNotification(sender.id, nftInfo);
                        }
                    }

                    processedTransactions.add(transaction.hash);
                }
            }
        }
    } catch (error) {
        logger.error('Ошибка проверки транзакции:', error);
    }
}

/**
 * Отправка уведомления пользователю через бота
 * @param {string} userId
 * @param {object} nftInfo
 */
async function sendNotification(userId, nftInfo) {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) return;

        const message = `🎁 Получен новый NFT подарок!\n\n` +
                       `Название: ${nftInfo.name}\n` +
                       `Коллекция: ${nftInfo.collection}\n` +
                       `Цена: ${nftInfo.priceTON} TON\n\n` +
                       `Он уже в вашем инвентаре в игре!`;

        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: userId,
            text: message,
            parse_mode: 'HTML'
        });

        logger.info(`Уведомление отправлено пользователю ${userId}`);
    } catch (error) {
        logger.error('Ошибка отправки уведомления:', error);
    }
}

/**
 * Проверка последних транзакций
 */
async function checkRecentTransactions() {
    try {
        logger.info('Проверка новых транзакций...');

        const receiverAddress = process.env.RECEIVER_ADDRESS;

        // Получаем последние транзакции нашего адреса через TON Center
        const response = await axios.get(`https://toncenter.com/api/v2/getTransactions`, {
            params: {
                address: receiverAddress,
                limit: 20,
                to_lt: 0,
                archival: true,
                api_key: process.env.TONCENTER_API_KEY
            }
        });

        if (response.data && response.data.result) {
            for (const tx of response.data.result) {
                await checkTransaction(tx);
            }
        }
    } catch (error) {
        logger.error('Ошибка проверки транзакций:', error);
    }
}

/**
 * Получение статистики
 */
function getStats() {
    return {
        uptime: process.uptime(),
        processedTransactions: processedTransactions.size,
        memoryUsage: process.memoryUsage(),
        timestamp: Date.now()
    };
}

// ========== 6. ИНИЦИАЛИЗАЦИЯ EXPRESS СЕРВЕРА ==========
const app = express();
app.use(express.json());

// API для проверки статуса сервера
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        stats: getStats()
    });
});

// API для ручного запуска проверки
app.post('/api/check', async (req, res) => {
    try {
        await checkRecentTransactions();
        res.json({ success: true, message: 'Проверка завершена' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для получения информации о NFT
app.get('/api/nft/:address', async (req, res) => {
    try {
        const nftInfo = await getNFTInfo(req.params.address);
        res.json(nftInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Сервер запущен на порту ${PORT}`);
});

// ========== 7. ПЕРИОДИЧЕСКИЕ ЗАДАЧИ ==========

// Проверка каждые N миллисекунд
const checkInterval = setInterval(checkRecentTransactions, process.env.CHECK_INTERVAL || 60000);

// Ежедневная очистка кэша транзакций (чтобы не рос бесконечно)
cron.schedule('0 0 * * *', () => {
    const size = processedTransactions.size;
    processedTransactions.clear();
    logger.info(`Кэш транзакций очищен. Удалено ${size} записей`);
});

// ========== 8. ОБРАБОТКА ЗАВЕРШЕНИЯ ==========
process.on('SIGTERM', () => {
    logger.info('Получен сигнал SIGTERM, завершаем работу...');
    clearInterval(checkInterval);
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('Получен сигнал SIGINT, завершаем работу...');
    clearInterval(checkInterval);
    process.exit(0);
});

logger.info('Сервер успешно запущен!');
console.log('=================================');
console.log('NFT Gift Server запущен');
console.log(`Порт: ${PORT}`);
console.log(`Адрес получателя: ${process.env.RECEIVER_ADDRESS}`);
console.log(`Интервал проверки: ${process.env.CHECK_INTERVAL || 60000}ms`);
console.log('=================================');