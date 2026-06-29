import express from 'express';
import { readFile } from 'fs/promises';
import pg from 'pg';

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://prodtovary.com');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const FORM_API_TOKEN = process.env.FORM_API_TOKEN || process.env.QR2_FORM_API_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const BOT_SECRET = process.env.BOT_SECRET || 'feedback-webhook-secret';

const stores = JSON.parse(await readFile(new URL('./stores.json', import.meta.url), 'utf8'));
const sessions = new Map();
let db = null;

if (process.env.DATABASE_URL) {
  db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  await db.query(`CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    source TEXT,
    store_id TEXT,
    store_name TEXT,
    name TEXT,
    phone TEXT,
    telegram_username TEXT,
    rating INTEGER,
    text TEXT NOT NULL,
    raw JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
}

function tgUrl(method) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not set');
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function telegram(method, payload) {
  const res = await fetch(tgUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

function storeName(id) {
  return stores.find(s => s.id === id)?.name || id || 'Не выбран';
}

function reviewMessage(review) {
  return [
    '📝 Новый отзыв',
    `Источник: ${review.source || 'web/bot'}`,
    `Точка: ${review.store_name || storeName(review.store_id)}`,
    review.rating ? `Оценка: ${review.rating}/5` : '',
    review.name ? `Имя: ${review.name}` : '',
    review.phone ? `Телефон: ${review.phone}` : '',
    review.telegram_username ? `Telegram: @${String(review.telegram_username).replace(/^@/, '')}` : '',
    '',
    review.text || review.message || 'Без текста'
  ].filter(Boolean).join('\n');
}

async function saveReview(review) {
  if (!db) return null;
  const result = await db.query(
    `INSERT INTO reviews (source, store_id, store_name, name, phone, telegram_username, rating, text, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [review.source, review.store_id, review.store_name || storeName(review.store_id), review.name, review.phone, review.telegram_username, review.rating || null, review.text || review.message, review]
  );
  return result.rows[0].id;
}

app.get('/', (req, res) => res.json({ ok: true, service: 'feedback-bot', stores: stores.length }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/stores', (req, res) => res.json({
  ok: true,
  result: {
    categories: [],
    stores
  }
}));
app.post('/api/reviews', async (req, res) => {
  try {
    if (FORM_API_TOKEN && req.headers.authorization !== `Bearer ${FORM_API_TOKEN}` && req.body.token !== FORM_API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const review = {
      source: 'web-form',
      store_id: req.body.storeId || req.body.store_id || req.body.store,
      store_name: req.body.storeName || req.body.store_name,
      name: req.body.name,
      phone: req.body.phone,
      telegram_username: req.body.telegram || req.body.telegram_username,
      rating: Number(req.body.rating || 0) || null,
      text: req.body.text || req.body.review || req.body.message || req.body.comment || ''
    };
    if (!review.text.trim()) return res.status(400).json({ ok: false, error: 'Review text is required' });
    const id = await saveReview(review);
    if (ADMIN_CHAT_ID) await telegram('sendMessage', { chat_id: ADMIN_CHAT_ID, text: reviewMessage(review) });
    res.json({ ok: true, id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post(`/telegram/${BOT_SECRET}`, async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message;
    if (!msg?.chat?.id || !msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const username = msg.from?.username;

if (text.startsWith('/start')) {
  const startPayload = text.split(' ')[1];

  if (startPayload) {
    sessions.set(chatId, {
      step: 'rating',
      store_id: startPayload
    });

    await telegram('sendMessage', {
      chat_id: chatId,
      text: `Здравствуйте! Вы оставляете отзыв для точки: ${storeName(startPayload)}.\n\nПоставьте оценку от 1 до 5.`
    });

    return;
  }

  sessions.set(chatId, { step: 'store' });

  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Здравствуйте! Выберите точку или напишите ID магазина.'
  });

  return;
}

if (text === '/review' || !sessions.has(chatId)) {
  sessions.set(chatId, { step: 'store' });

  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Напишите ID магазина, например: prod3_saturn, miks_1, zoo3.'
  });

  return;
}

    const session = sessions.get(chatId);
    if (session.step === 'store') {
      session.store_id = text;
      session.step = 'rating';
      await telegram('sendMessage', { chat_id: chatId, text: 'Поставьте оценку от 1 до 5.' });
      return;
    }

    if (session.step === 'rating') {
      const rating = Number(text);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        await telegram('sendMessage', { chat_id: chatId, text: 'Пожалуйста, отправьте число от 1 до 5.' });
        return;
      }
      session.rating = rating;
      session.step = 'text';
      await telegram('sendMessage', { chat_id: chatId, text: 'Напишите сам отзыв.' });
      return;
    }

    if (session.step === 'text') {
      const review = { source: 'telegram-bot', store_id: session.store_id, rating: session.rating, text, telegram_username: username };
      const id = await saveReview(review);
      if (ADMIN_CHAT_ID) await telegram('sendMessage', { chat_id: ADMIN_CHAT_ID, text: reviewMessage(review) });
      sessions.delete(chatId);
      await telegram('sendMessage', { chat_id: chatId, text: 'Спасибо! Ваш отзыв передан.' });
      return;
    }
  } catch (error) {
    console.error(error);
  }
});

app.listen(PORT, async () => {
  console.log(`Listening on ${PORT}`);
  if (BOT_TOKEN && PUBLIC_URL) {
    try {
      await telegram('setWebhook', { url: `${PUBLIC_URL}/telegram/${BOT_SECRET}` });
      console.log('Telegram webhook set');
    } catch (error) {
      console.error('Webhook error:', error.message);
    }
  }
});
