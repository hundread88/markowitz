import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import axios from 'axios';
import { mean, multiply, transpose, inv, ones, squeeze, subtract } from 'mathjs';

dotenv.config();

// --- Конфигурация ---
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const HOST_URL = process.env.HOST_URL;
const API_KEY = process.env.COINGECKO_API_KEY;

if (!TOKEN || !HOST_URL) {
  console.error('Ошибка: Переменные окружения TELEGRAM_TOKEN и HOST_URL должны быть установлены.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${HOST_URL}/webhook/${TOKEN}`);

// --- API клиент для CoinGecko ---
const coinGeckoApi = axios.create({
  baseURL: 'https://api.coingecko.com/api/v3',
  headers: API_KEY ? { 'x-cg-demo-api-key': API_KEY } : {}
});

// --- Кэширование списка монет и цен ---
let coinListCache = [];
const priceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут для цен

// --- Инициализация ---
async function initializeCoinList() {
    try {
        // --- ИЗМЕНЕНИЕ: Загружаем список рынков, отсортированный по капитализации ---
        console.log("Загрузка списка рынков с CoinGecko (отсортировано по капитализации)...");
        // Загружаем несколько страниц, чтобы получить более полный список
        let allCoins = [];
        for (let page = 1; page <= 5; page++) { // Загружаем 5 страниц = 1250 монет
            const { data } = await coinGeckoApi.get('/coins/markets', {
                params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 250, page: page }
            });
            allCoins = allCoins.concat(data);
            await delay(500); // Небольшая задержка между запросами страниц
        }
        
        coinListCache = allCoins;
        console.log(`Список монет успешно загружен. Всего: ${coinListCache.length} монет.`);
    } catch (error) {
        console.error("Критическая ошибка: не удалось загрузить список монет. Бот не сможет конвертировать тикеры в ID.", error.message);
    }
}

// --- Логика бота ---

function convertTickersToIds(tickers) {
    const foundIds = [];
    const notFound = [];

    for (const ticker of tickers) {
        const lowerTicker = ticker.toLowerCase();
        
        // --- ИЗМЕНЕНИЕ: Улучшенная логика поиска ---
        // Сначала ищем точное совпадение ID, что маловероятно, но возможно
        let match = coinListCache.find(coin => coin.id === lowerTicker);
        
        // Если не нашли по ID, ищем по символу.
        // Так как список отсортирован по капитализации, первое совпадение будет самым популярным.
        if (!match) {
            match = coinListCache.find(coin => coin.symbol === lowerTicker);
        }

        if (match) {
            foundIds.push(match.id);
        } else {
            notFound.push(ticker);
        }
    }

    if (notFound.length > 0) {
        throw new Error(`Не удалось найти монеты для следующих тикеров: ${notFound.join(', ')}`);
    }

    return foundIds;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchPrices(coinIds, days) {
  const prices = {};
  for (const id of coinIds) {
    const cacheKey = `${id}-${days}`;
    if (priceCache.has(cacheKey) && (Date.now() - priceCache.get(cacheKey).timestamp < CACHE_TTL)) {
      console.log(`Использую кэш для: ${id} на ${days} дней`);
      prices[id] = priceCache.get(cacheKey).data;
      continue;
    }
    
    let retries = 0;
    const maxRetries = 3;
    let success = false;

    while (retries < maxRetries && !success) {
      try {
        const { data } = await coinGeckoApi.get(`/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
        if (!data.prices || data.prices.length < 2) {
          throw new Error(`Недостаточно данных о ценах для ${id} за период ${days} дней.`);
        }
        
        const priceData = data.prices.map(p => p[1]);
        prices[id] = priceData;
        priceCache.set(cacheKey, { data: priceData, timestamp: Date.now() });
        success = true;
      } catch (error) {
        if (error.response && error.response.status === 429) {
          retries++;
          const waitTime = Math.pow(2, retries) * 1000;
          console.warn(`Достигнут лимит API для ${id}. Повторная попытка через ${waitTime / 1000}с...`);
          await delay(waitTime);
        } else {
          throw new Error(error.response?.data?.error || `Не удалось найти монету с ID "${id}".`);
        }
      }
    }

    if (!success) {
      throw new Error(`Не удалось получить данные для ${id} после ${maxRetries} попыток.`);
    }
  }
  return prices;
}

function computeReturns(prices) {
    const returns = [];
    const keys = Object.keys(prices);
    if (keys.length === 0) return [];

    let minLength = Infinity;
    for (const key of keys) {
        if (prices[key].length < minLength) {
            minLength = prices[key].length;
        }
    }

    if (minLength < 2) {
      throw new Error("Недостаточно исторических данных для расчета.");
    }

    for (const key of keys) {
        if (prices[key].length > minLength) {
            console.warn(`Усекаю историю для ${key} до ${minLength} записей для соответствия`);
            prices[key] = prices[key].slice(prices[key].length - minLength);
        }
    }
    
    for (let i = 1; i < minLength; i++) {
        const row = keys.map(k => Math.log(prices[k][i] / prices[k][i - 1]));
        returns.push(row);
    }
    return returns;
}

function calculateCovarianceMatrix(data) {
    const meanReturns = mean(data, 0);
    const demeaned = data.map(row => subtract(row, meanReturns));
    const n = data.length;
    const matrix = multiply(transpose(demeaned), demeaned);
    return matrix.map(row => row.map(value => value / (n - 1)));
}

function optimizePortfolio(returns) {
    if (returns.length === 0) {
        throw new Error("Нет данных о доходности для расчета.");
    }
    try {
        const avgReturns = mean(returns, 0);
        const covMatrix = calculateCovarianceMatrix(returns);
        const covInv = inv(covMatrix);
        const oneVec = ones([avgReturns.length, 1]);
        const top = multiply(covInv, oneVec);
        const bottom = multiply(transpose(oneVec), top);
        return squeeze(top).map(w => w / bottom);
    } catch (error) {
        console.error("Ошибка при расчете портфеля:", error);
        throw new Error("Не удалось рассчитать портфель. Возможно, монеты слишком коррелируют. Попробуйте другой набор или период.");
    }
}

function formatWeights(coinIds, weights) {
    return coinIds.map((id, i) => `${id}: ${(weights[i] * 100).toFixed(2)}%`).join('\n');
}

// --- Обработчики Telegram ---

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, `Привет! Отправь мне тикеры монет через запятую.
    \n<b>Пример:</b> <code>BTC, ETH, SOL</code>
    \nЧтобы указать период расчета в днях, добавь в конце "/".
    \n<b>Пример:</b> <code>BTC, ETH / 90</code>
    \n(По умолчанию: 30 дней)`, { parse_mode: 'HTML'});
});

bot.on('message', async msg => {
    if (msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    
    if (coinListCache.length === 0) {
        return bot.sendMessage(chatId, "⏳ Бот инициализируется, список монет еще загружается. Пожалуйста, подождите минуту и попробуйте снова.");
    }
    
    const rawInput = msg.text.trim();
    
    // --- Парсинг ввода ---
    let days = 30;
    let tickersString = rawInput;

    const periodMatch = rawInput.match(/\/\s*(\d+)\s*$/);
    if (periodMatch) {
        const parsedDays = parseInt(periodMatch[1], 10);
        if (!isNaN(parsedDays) && parsedDays >= 7 && parsedDays <= 2000) { // Увеличил макс. период
            days = parsedDays;
            tickersString = rawInput.replace(/\/\s*(\d+)\s*$/, '').trim();
        } else {
            return bot.sendMessage(chatId, "❌ Ошибка: Период должен быть числом от 7 до 2000 дней.");
        }
    }
    
    const tickers = tickersString.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    if (tickers.length === 0) {
        return bot.sendMessage(chatId, "Пожалуйста, введите тикеры монет.");
    }

    const waitingMessage = await bot.sendMessage(chatId, `⏳ Ищу монеты по тикерам: ${tickers.join(', ')}...`);
    
    try {
        const coinIds = convertTickersToIds(tickers);
        await bot.editMessageText(`✅ Монеты найдены: <code>${coinIds.join(', ')}</code>\n\n⏳ Загружаю данные за ${days} дней и рассчитываю портфель...`, {
            chat_id: chatId,
            message_id: waitingMessage.message_id,
            parse_mode: 'HTML'
        });

        const prices = await fetchPrices(coinIds, days);
        const returns = computeReturns(prices);
        const weights = optimizePortfolio(returns);
        const result = formatWeights(coinIds, weights);

        await bot.editMessageText(`📊 Оптимальное распределение портфеля (минимальный риск, ${days} дней):\n\n<pre>${result}</pre>`, {
            chat_id: chatId,
            message_id: waitingMessage.message_id,
            parse_mode: 'HTML'
        });
    } catch (err) {
        await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
            chat_id: chatId,
            message_id: waitingMessage.message_id
        });
    }
});

// --- Запуск сервера ---
app.use(express.json());
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (_, res) => res.send('Telegram Bot is running.'));
app.listen(PORT, () => {
    console.log(`Express server is listening on port ${PORT}`);
    initializeCoinList(); // Загружаем список монет при старте
});
