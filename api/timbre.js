import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.BOT_TOKEN;

    // --- CASO A: WEBHOOK DE TELEGRAM (Registro de vecinos) ---
    // Esto se activa cuando alguien le escribe al BOT
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;

        if (msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1]; // Saca el número después de /alta
            if (!depto) return res.status(200).send();

            // Guardamos: el ID del vecino para ese depto Y agregamos el depto a la lista de botones
            await kv.set(`owner:${depto}`, chatId); 
            
            let lista = await kv.get('lista_deptos') || ['4'];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await kv.set('lista_deptos', lista.sort());
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `✅ Registrado con éxito en el Interno ${depto}. Recibirás las alertas aquí.` })
            });
        }
        return res.status(200).send('ok');
    }

    // --- CASO B: PETICIÓN DE LA WEB (Tocar timbre o Listar botones) ---
    const { depto } = req.query;

    // Si no hay depto, devolvemos la lista para dibujar los botones
    if (!depto) {
        const botones = await kv.get('lista_deptos') || ['4'];
        return res.status(200).json(botones);
    }

    // Si hay depto, buscamos quién es el dueño en la DB
    const vecinoChatId = await kv.get(`owner:${depto}`);
    const destinoId = vecinoChatId || process.env.CHAT_ID; // Si no hay dueño, te llega a vos por defecto

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: destinoId, text: `🔔 ¡Timbre! Alguien llama al Interno ${depto}` })
        });
        return res.status(200).send("Enviado");
    } catch (e) {
        return res.status(500).send("Error");
    }
}
