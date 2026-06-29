# Railway feedback bot

Backend для сбора отзывов:

- `GET /api/stores` — список точек для формы на сайте;
- `POST /api/reviews` — прием отзывов с web-формы;
- Telegram-бот по команде `/start` собирает отзыв и отправляет его администратору;
- опционально сохраняет отзывы в PostgreSQL, если добавить `DATABASE_URL`.

## Переменные Railway

Обязательные:

```env
BOT_TOKEN=токен_бота_от_BotFather
ADMIN_CHAT_ID=ваш_chat_id_или_id_группы
FORM_API_TOKEN=общий_секрет_для_формы
BOT_SECRET=любая_секретная_строка_для_webhook
```

Желательно:

```env
PUBLIC_URL=https://ваш-домен.up.railway.app
```

Если `PUBLIC_URL` не задан, код попробует взять домен из `RAILWAY_PUBLIC_DOMAIN`.

Опционально для хранения отзывов:

```env
DATABASE_URL=postgresql://...
```

## Команды

```bash
npm install
npm start
```

Railway Start Command:

```bash
npm start
```

## Подключение формы Bitrix

В `config.php` frontend-части укажите:

```php
define('QR2_RAILWAY_BASE_URL', 'https://ваш-домен.up.railway.app');
define('QR2_FORM_API_TOKEN', 'тот_же_FORM_API_TOKEN');
```
