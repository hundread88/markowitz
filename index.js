import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import axios from 'axios';
import { mean, multiply, transpose, inv, ones, squeeze, subtract } from 'mathjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const HOST_URL = process.env.HOST_URL; 

if (!TOKEN || !HOST_URL) {
  console.error('Ошибка: Переменные окружения TELEGRAM_TOKEN и HOST_URL должны быть установлены.');
  process.exit(1);
}

const WEBHOOK_PATH = `/webhook/${TOKEN}`;
const bot = new TelegramBot(TOKEN);

bot.setWebHook(`${HOST_URL}${WEBHOOK_PATH}`);

app.use(express.json());

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function fetchPrices(coinIds, days = 30) {
  const prices = {};
  for (let id of coinIds) {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
      const { data } = await axios.get(url);
      if (!data.prices || data.prices.length === 0) {
          throw new Error(`Нет данных о ценах для ${id}`);
      }
      prices[id] = data.prices.map(p => p[1]);
    } catch (error) {
       console.error(`Не удалось получить данные для ${id}:`, error.message);
       throw new Error(`Не удалось найти монету с ID "${id}". Проверьте правильность написания.`);
    }
  }
  return prices;
}

function computeReturns(prices) {
  const returns = [];
  const keys = Object.keys(prices);
  const numPrices = prices[keys[0]].length;

  for (const key of keys) {
      if (prices[key].length !== numPrices) {
          throw new Error("Несоответствие количества данных о ценах для разных активов.");
      }
  }
  
  for (let i = 1; i < numPrices; i++) {
    const row = keys.map(k =>
      Math.log(prices[k][i] / prices[k][i - 1])
    );
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
  try {
    const avgReturns = mean(returns, 0);
    const covMatrix = calculateCovarianceMatrix(returns);
    const covInv = inv(covMatrix);
    const oneVec = ones([avgReturns.length, 1]);
    const top = multiply(covInv, oneVec);
    const bottom = multiply(transpose(oneVec), top); // bottom здесь - это скаляр (число)
    
    // --- ИЗМЕНЕНИЕ ---
    // Используем 'bottom' напрямую, так как это уже число, а не матрица.
    const weights = squeeze(top).map(w => w / bottom);
    return weights;
  } catch(error) {
    console.error("Ошибка при расчете портфеля:", error);
    throw new Error("Не удалось рассчитать портфель. Возможно, данные по монетам слишком коррелируют или их недостаточно. Попробуйте другой набор монет.");
  }
}

function formatWeights(coinIds, weights) {
  return coinIds.map((id, i) =>
    `${id}: ${(weights[i] * 100).toFixed(2)}%`
  ).join('\n');
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `Привет! Отправь мне список ID монет с CoinGecko через запятую (например: bitcoin,ethereum,solana), и я рассчитаю для них портфель с минимальным риском по теории Марковица.`);
});

bot.on('message', async msg => {
  if (msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const input = msg.text.toLowerCase().replace(/\s/g, '');
  
  if (!input) {
      bot.sendMessage(chatId, "Пожалуйста, введите ID монет.");
      return;
  }
  
  const coins = input.split(',');

  bot.sendMessage(chatId, `⏳ Рассчитываю портфель для: ${coins.join(', ')}...`);

  try {
    const prices = await fetchPrices(coins);
    const returns = computeReturns(prices);
    const weights = optimizePortfolio(returns);
    const result = formatWeights(coins, weights);
    bot.sendMessage(chatId, `📊 Оптимальное распределение портфеля (минимальный риск):\n\n${result}`);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
  }
});

app.get('/', (_, res) => res.send('Telegram Bot is running.'));

app.listen(PORT, () => {
  console.log(`Express server is listening on port ${PORT}`);
});
