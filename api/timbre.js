export default async function handler(req, res) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const { depto } = req.query;

  // URL de Telegram
  const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent("🔔 Timbre: " + (depto || "Prueba"))}`;

  try {
    const response = await fetch(url);
    const data = await response.json(); // Aquí Telegram nos da la respuesta real

    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (data.ok) {
      res.status(200).send("✅ Telegram aceptó el mensaje");
    } else {
      // Si hay un error, lo mostramos en pantalla
      res.status(200).send("❌ Telegram rechazó el mensaje: " + data.description);
    }
  } catch (error) {
    res.status(500).send("❌ Error técnico: " + error.message);
  }
}
