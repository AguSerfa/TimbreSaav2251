import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

    if (req.body && req.body.message) {
        const chatId = req.body.message.chat.id;
        const msg = req.body.message;

        // Buscamos el ID en cualquier tipo de archivo adjunto
        const fileObj = msg.audio || msg.document || msg.voice || (msg.photo ? msg.photo[msg.photo.length - 1] : null);

        if (fileObj && fileObj.file_id) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    text: `🆔 **¡ID ENCONTRADO!**\n\n\`${fileObj.file_id}\` \n\nCopiá este código para Vercel.`,
                    parse_mode: 'Markdown' 
                })
            });
            return res.status(200).send('ok');
        }

        // Si mandás texto, el bot te avisa que está esperando el archivo
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "Aún no recibí el archivo. Mandame el audio .mp3 como 'Archivo' o como 'Música'." })
        });
    }
    return res.status(200).send('ok');
}
