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
const API_KEY = process.env.COINGECKO_API_KEY; // Получаем ключ из окружения

if (!TOKEN || !HOST_URL) {
  console.error('Ошибка: Переменные окружения TELEGRAM_TOKEN и HOST_URL должны быть установлены.');
  process.exit(1);
}

if (API_KEY) {
    console.log("Обнаружен API ключ CoinGecko. Запросы будут выполняться с ним.");
} else {
    console.warn("Внимание: API ключ CoinGecko не найден. Работа в режиме без ключа с ограниченными лимитами.");
}

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${HOST_URL}/webhook/${TOKEN}`);

app.use(express.json());
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// --- Кэширование ---
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// --- Логика бота ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchPrices(coinIds, days = 30) {
  const prices = {};
  const coinGeckoApi = axios.create({
    baseURL: 'https://api.coingecko.com/api/v3',
    headers: API_KEY ? { 'x-cg-demo-api-key': API_KEY } : {}
  });

  for (const id of coinIds) {
    // Проверяем кэш
    if (cache.has(id) && (Date.now() - cache.get(id).timestamp < CACHE_TTL)) {
      console.log(`Использую кэш для: ${id}`);
      prices[id] = cache.get(id).data;
      continue;
    }
    
    let retries = 0;
    const maxRetries = 4;
    let success = false;

    while (retries < maxRetries && !success) {
      try {
        console.log(`Запрашиваю данные для: ${id} (попытка ${retries + 1})`);
        const { data } = await coinGeckoApi.get(`/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
        
        if (!data.prices || data.prices.length === 0) {
          throw new Error(`Нет данных о ценах для ${id}`);
        }
        
        const priceData = data.prices.map(p => p[1]);
        prices[id] = priceData;
        cache.set(id, { data: priceData, timestamp: Date.now() }); // Сохраняем в кэш
        success = true;

      } catch (error) {
        if (error.response && error.response.status === 429) {
          retries++;
          const waitTime = Math.pow(2, retries) * 1000; // Экспоненциальная задержка (2с, 4с, 8с...)
          console.warn(`Достигнут лимит API для ${id}. Повторная попытка через ${waitTime / 1000}с...`);
          await delay(waitTime);
        } else {
          console.error(`Не удалось получить данные для ${id}:`, error.message);
          throw new Error(`Не удалось найти монету с ID "${id}". Проверьте правильность написания.`);
        }
      }
    }

    if (!success) {
      throw new Error(`Не удалось получить данные для ${id} после ${maxRetries} попыток. API CoinGecko перегружен.`);
    }
  }
  return prices;
}


function computeReturns(prices) {
    const returns = [];
    const keys = Object.keys(prices);
    if (keys.length === 0) return [];
    
    const numPrices = prices[keys[0]].length;
    for (const key of keys) {
        if (prices[key].length !== numPrices) {
            throw new Error("Несоответствие количества данных о ценах. Возможно, для одной из монет неполная история.");
        }
    }
    for (let i = 1; i < numPrices; i++) {
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
        const weights = squeeze(top).map(w => w / bottom);
        return weights;
    } catch (error) {
        console.error("Ошибка при расчете портфеля:", error);
        throw new Error("Не удалось рассчитать портфель. Возможно, данные по монетам слишком коррелируют или их недостаточно. Попробуйте другой набор монет.");
    }
}

function formatWeights(coinIds, weights) {
    return coinIds.map((id, i) => `${id}: ${(weights[i] * 100).toFixed(2)}%`).join('\n');
}

bot.onText(/\/start/, msg => {
    bot.sendMessage(msg.chat.id, `Привет! Отправь мне список ID монет с CoinGecko через запятую (например: bitcoin,ethereum,solana), и я рассчитаю для них портфель с минимальным риском по теории Марковица.`);
});

bot.on('message', async msg => {
    if (msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const input = msg.text.toLowerCase().replace(/\s/g, '');
    if (!input) {
        return bot.sendMessage(chatId, "Пожалуйста, введите ID монет.");
    }
    const coins = input.split(',');
    const message = await bot.sendMessage(chatId, `⏳ Загружаю данные и рассчитываю портфель для: ${coins.join(', ')}... Это может занять некоторое время.`);

    try {
        const prices = await fetchPrices(coins);
        const returns = computeReturns(prices);
        const weights = optimizePortfolio(returns);
        const result = formatWeights(coins, weights);
        bot.editMessageText(`📊 Оптимальное распределение портфеля (минимальный риск):\n\n${result}`, {
            chat_id: chatId,
            message_id: message.message_id
        });
    } catch (err) {
        bot.editMessageText(`❌ Ошибка: ${err.message}`, {
            chat_id: chatId,
            message_id: message.message_id
        });
    }
});

app.get('/', (_, res) => res.send('Telegram Bot is running.'));
app.listen(PORT, () => console.log(`Express server is listening on port ${PORT}`));
