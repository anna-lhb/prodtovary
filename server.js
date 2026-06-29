import express from 'express';
import { readFile } from 'fs/promises';
import pg from 'pg';

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://prodtovary.com');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Form-Token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const FORM_API_TOKEN = process.env.FORM_API_TOKEN || process.env.QR2_FORM_API_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const BOT_SECRET = process.env.BOT_SECRET || 'feedback-webhook-secret';

const stores = JSON.parse(await readFile(new URL('./stores.json', import.meta.url), 'utf8'));
const sessions = new Map();
const reviewTickets = new Map();

let db = null;

if (process.env.DATABASE_URL) {
  db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });

  await db.query(`CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    source TEXT,
    store_id TEXT,
    store_name TEXT,
    name TEXT,
    phone TEXT,
    email TEXT,
    telegram_username TEXT,
    text TEXT NOT NULL,
    raw JSONB,
    status TEXT DEFAULT 'new',
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

  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result;
}

function findStore(id) {
  return stores.find((item) => item.id === id) || null;
}

function storeName(id) {
  return findStore(id)?.name || id || 'Не выбран';
}

function storeAddress(id) {
  return findStore(id)?.address || '';
}

function isTrue(value) {
  return value === true || value === '1' || value === 1 || value === 'true' || value === 'yes' || value === 'да';
}

function makeReviewId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function contactLabel(review) {
  if (!isTrue(review.wantsReply)) return 'Ответ не требуется';

  if (review.replyChannel === 'phone' || review.phone) return '☎️ Клиент просит ответ по телефону';
  if (review.replyChannel === 'email' || review.email) return '✉️ Клиент просит ответ на email';
  if (review.replyChannel === 'telegram' || review.telegram_username) return '💬 Клиент просит ответ в Telegram';

  return 'Клиент просит ответ';
}

function reviewMessage(review) {
  return [
    '🟡 Новый отзыв',
    '',
    `🏬 ${review.store_name || storeName(review.store_id)}`,
    review.store_address || storeAddress(review.store_id) ? `📍 ${review.store_address || storeAddress(review.store_id)}` : '',
    '',
    `💬 ${review.text || 'Без текста'}`,
    '',
    contactLabel(review),
    review.phone ? `📱 ${review.phone}` : '',
    review.email ? `📧 ${review.email}` : '',
    review.telegram_username ? `TG: @${String(review.telegram_username).replace(/^@/, '')}` : '',
    '',
    review.photos?.length ? `📎 Фото: ${review.photos.length}` : '',
    `🕒 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}`
  ].filter(Boolean).join('\n');
}

function reviewKeyboard(review, reviewId) {
  const rows = [
    [
      {
        text: '👤 Взять в работу',
        callback_data: `take:${reviewId}`
      },
      {
        text: '✅ Обработано',
        callback_data: `done:${reviewId}`
      }
    ]
  ];

  if (review.telegram_username) {
    rows.unshift([
      {
        text: '💬 Написать в Telegram',
        url: `https://t.me/${String(review.telegram_username).replace(/^@/, '')}`
      }
    ]);
  }

  return { inline_keyboard: rows };
}

async function sendPhotosToAdmin(review) {
  if (!ADMIN_CHAT_ID || !Array.isArray(review.photos) || review.photos.length === 0) return;

  for (const photoUrl of review.photos.slice(0, 10)) {
    try {
      await telegram('sendPhoto', {
        chat_id: ADMIN_CHAT_ID,
        photo: photoUrl
      });
    } catch (error) {
      await telegram('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `📎 Фото к отзыву: ${photoUrl}`
      });
    }
  }
}

async function saveReview(review) {
  if (!db) return null;

  const result = await db.query(
    `INSERT INTO reviews (source, store_id, store_name, name, phone, email, telegram_username, text, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      review.source,
      review.store_id,
      review.store_name || storeName(review.store_id),
      review.name || review.customerName || null,
      review.phone || null,
      review.email || null,
      review.telegram_username || null,
      review.text,
      review
    ]
  );

  return result.rows[0].id;
}

async function sendReviewToAdmin(review) {
  if (!ADMIN_CHAT_ID) return null;

  const reviewId = review.reviewId || makeReviewId();
  review.reviewId = reviewId;

  const text = reviewMessage(review);

  const message = await telegram('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text,
    reply_markup: reviewKeyboard(review, reviewId)
  });

  reviewTickets.set(reviewId, {
    review,
    status: 'new',
    chat_id: ADMIN_CHAT_ID,
    message_id: message.message_id,
    text
  });

  await sendPhotosToAdmin(review);

  return message;
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'feedback-bot', stores: stores.length });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/stores', (req, res) => {
  res.json({
    ok: true,
    result: {
      categories: [],
      stores
    }
  });
});

app.post('/api/reviews', async (req, res) => {
  try {
    const authOk =
      !FORM_API_TOKEN ||
      req.headers.authorization === `Bearer ${FORM_API_TOKEN}` ||
      req.headers['x-form-token'] === FORM_API_TOKEN ||
      req.body.token === FORM_API_TOKEN;

    if (!authOk) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const review = {
      source: 'web-form',
      store_id: req.body.storeId || req.body.store_id || req.body.store || '',
      store_name: req.body.storeName || req.body.store_name || '',
      store_address: req.body.storeAddress || req.body.store_address || '',
      name: req.body.name || req.body.customerName || '',
      customerName: req.body.customerName || req.body.name || '',
      phone: req.body.phone || '',
      email: req.body.email || '',
      telegram_username: req.body.telegram || req.body.telegram_username || '',
      wantsReply: req.body.wantsReply,
      replyChannel: req.body.replyChannel || '',
      photos: Array.isArray(req.body.photos) ? req.body.photos : [],
      text: req.body.text || req.body.review || req.body.message || req.body.comment || ''
    };

    if (!review.text.trim()) {
      return res.status(400).json({ ok: false, error: 'Review text is required' });
    }

    const id = await saveReview(review);
    review.backendId = id;

    await sendReviewToAdmin(review);

    res.json({
      ok: true,
      result: {
        id: id || review.reviewId
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post(`/telegram/${BOT_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const callback = req.body.callback_query;

    if (callback) {
      const data = callback.data || '';
      const fromName = [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(' ') || callback.from?.username || 'Администратор';

      await telegram('answerCallbackQuery', {
        callback_query_id: callback.id
      });

      const [action, reviewId] = data.split(':');
      const ticket = reviewTickets.get(reviewId);

      if (!ticket) {
        await telegram('sendMessage', {
          chat_id: callback.message.chat.id,
          text: 'Не удалось найти отзыв в памяти бота. Возможно, бот был перезапущен.'
        });
        return;
      }

      if (action === 'take') {
        ticket.status = 'in_progress';

        const newText = ticket.text.replace('🟡 Новый отзыв', `🟠 В работе\n👤 Ответственный: ${fromName}`);

        await telegram('editMessageText', {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          text: newText,
          reply_markup: reviewKeyboard(ticket.review, reviewId)
        });

        return;
      }

      if (action === 'done') {
        ticket.status = 'done';

        const baseText = ticket.text.replace('🟡 Новый отзыв', '🟢 Обработано');

        await telegram('editMessageText', {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          text: [
            baseText,
            '',
            `✅ Закрыл: ${fromName}`,
            `🕒 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk' })}`
          ].join('\n'),
          reply_markup: { inline_keyboard: [] }
        });

        return;
      }

      return;
    }

    const msg = req.body.message;

    if (!msg?.chat?.id) return;

    const chatId = msg.chat.id;
    const username = msg.from?.username || '';
    const text = msg.text?.trim() || '';

    if (text.startsWith('/start')) {
      const startPayload = text.split(' ')[1];

      if (startPayload) {
        sessions.set(chatId, {
          step: 'text',
          store_id: startPayload,
          photos: []
        });

        await telegram('sendMessage', {
          chat_id: chatId,
          text: [
            'Здравствуйте! Вы оставляете отзыв для:',
            '',
            `🏬 ${storeName(startPayload)}`,
            storeAddress(startPayload) ? `📍 ${storeAddress(startPayload)}` : '',
            '',
            'Напишите, пожалуйста, ваш отзыв одним сообщением.'
          ].filter(Boolean).join('\n')
        });

        return;
      }

      sessions.set(chatId, { step: 'store', photos: [] });

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Здравствуйте! Напишите ID магазина или откройте бота по QR-коду конкретной точки.'
      });

      return;
    }

    if (text === '/skip') {
      const session = sessions.get(chatId);

      if (!session || !session.text) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Нет активного отзыва. Откройте бота по QR-коду или нажмите /start.'
        });
        return;
      }

      const review = {
        source: 'telegram-bot',
        store_id: session.store_id,
        text: session.text,
        telegram_username: username,
        photos: session.photos || []
      };

      const id = await saveReview(review);
      review.backendId = id;

      await sendReviewToAdmin(review);
      sessions.delete(chatId);

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Спасибо! Ваш отзыв передан.'
      });

      return;
    }

    if (!sessions.has(chatId)) {
      sessions.set(chatId, { step: 'store', photos: [] });

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Напишите ID магазина или откройте бота по QR-коду конкретной точки.'
      });

      return;
    }

    const session = sessions.get(chatId);

    if (session.step === 'store') {
      session.store_id = text;
      session.step = 'text';

      await telegram('sendMessage', {
        chat_id: chatId,
        text: [
          `Вы оставляете отзыв для: ${storeName(text)}`,
          storeAddress(text) ? `📍 ${storeAddress(text)}` : '',
          '',
          'Напишите, пожалуйста, ваш отзыв одним сообщением.'
        ].filter(Boolean).join('\n')
      });

      return;
    }

    if (session.step === 'text') {
      if (!text) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Напишите отзыв текстом.'
        });
        return;
      }

      session.text = text;
      session.step = 'photos';

      await telegram('sendMessage', {
        chat_id: chatId,
        text: [
          'Спасибо! Если хотите, прикрепите фото.',
          '',
          'Можно отправить JPG, PNG, WEBP или HEIC.',
          'Если фото нет — нажмите /skip.'
        ].join('\n')
      });

      return;
    }

    if (session.step === 'photos') {
      if (msg.photo?.length) {
        const bestPhoto = msg.photo[msg.photo.length - 1];

        const file = await telegram('getFile', {
          file_id: bestPhoto.file_id
        });

        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

        session.photos = session.photos || [];
        session.photos.push(fileUrl);

        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Фото добавлено. Можете отправить ещё фото или нажать /skip, чтобы завершить отзыв.'
        });

        return;
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Отправьте фото или нажмите /skip.'
      });

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
      await telegram('setWebhook', {
        url: `${PUBLIC_URL}/telegram/${BOT_SECRET}`
      });

      console.log('Telegram webhook set');
    } catch (error) {
      console.error('Webhook error:', error.message);
    }
  }
});
