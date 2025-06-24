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
const WEBHOOK_PATH = `/webhook/${TOKEN}`;
const bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });

app.use(express.json());
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.setWebHook(`${HOST_URL}${WEBHOOK_PATH}`);

async function fetchPrices(coinIds, days = 30) {
  const prices = {};
  for (let id of coinIds) {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
    const { data } = await axios.get(url);
    prices[id] = data.prices.map(p => p[1]);
  }
  return prices;
}

function computeReturns(prices) {
  const returns = [];
  const keys = Object.keys(prices);
  for (let i = 1; i < prices[keys[0]].length; i++) {
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
  const avgReturns = mean(returns, 0);
  const covMatrix = calculateCovarianceMatrix(returns);
  const covInv = inv(covMatrix);
  const oneVec = ones([avgReturns.length, 1]);
  const top = multiply(transpose(oneVec), covInv);
  const bottom = multiply(top, oneVec);
  const weights = squeeze(multiply(covInv, oneVec))
    .map(w => w / bottom._data[0][0]);
  return weights;
}

function formatWeights(coinIds, weights) {
  return coinIds.map((id, i) =>
    `${id}: ${(weights[i] * 100).toFixed(2)}%`
  ).join('\n');
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `Привет! Отправь список монет через запятую (например: bitcoin,ethereum,solana)`);
});

bot.on('message', async msg => {
  if (msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const input = msg.text.toLowerCase().replace(/\s/g, '');
  const coins = input.split(',');

  bot.sendMessage(chatId, `⏳ Загружаю данные для: ${coins.join(', ')}`);

  try {
    const prices = await fetchPrices(coins);
    const returns = computeReturns(prices);
    const weights = optimizePortfolio(returns);
    const result = formatWeights(coins, weights);
    bot.sendMessage(chatId, `📊 Оптимальное распределение (Мин. риск):\n\n${result}`);
  } catch (err) {
    bot.sendMessage(chatId, `Ошибка при расчёте: ${err.message}`);
  }
});

app.get('/', (_, res) => res.send('Bot is running.'));

app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});
