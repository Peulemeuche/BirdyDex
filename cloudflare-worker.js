// ============================================================
// BirdrDex – Cloudflare Worker (proxy Claude API)
// Déployer sur : https://workers.cloudflare.com
// ============================================================
//
// SETUP (5 minutes) :
// 1. Va sur https://workers.cloudflare.com → crée un compte gratuit
// 2. Crée un nouveau Worker, colle ce code
// 3. Dans "Settings" > "Variables" > "Secret variables" :
//    Ajoute  ANTHROPIC_API_KEY = sk-ant-xxxx  (ta clé Anthropic)
// 4. Déploie → tu obtiens une URL du style :
//    https://birdrdex-proxy.TON-SOUS-DOMAINE.workers.dev
// 5. Copie cette URL dans app.js à la ligne WORKER_URL
// ============================================================

export default {
  async fetch(request, env) {
    // Autoriser les requêtes cross-origin (CORS) depuis n'importe quel site
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();

      // Appel à l'API Anthropic avec la clé secrète (jamais exposée au client)
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
