import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    if (req.body && req.body.message) {
        const chatId = req.body.message.chat.id;

        // --- ESTO ES LO QUE BUSCA EL ID ---
        if (req.body.message.audio || req.body.message.document) {
            const fileId = (req.body.message.audio || req.body.message.document).file_id;
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `🆔 Tu FILE_ID es:\n\n\`${fileId}\``, parse_mode: 'Markdown' })
            });
            return res.status(200).send('ok');
        }
        // ---------------------------------

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "Mandame el archivo .mp3 ahora para darte el ID." })
        });
    }
    return res.status(200).send('ok');
}
