// ============================================================
// BirdyDex – Cloudflare Worker
// Gère deux APIs :
//   1. Gemini (analyse screenshots Merlin)
//   2. Xeno-canto API v3 (sons d'oiseaux)
//
// Variables secrètes à configurer dans Workers > Settings > Variables :
//   GEMINI_KEY  = ta clé Google AI Studio
//   XENO_KEY    = ta clé Xeno-canto (compte gratuit sur xeno-canto.org)
// ============================================================

export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    // ── Xeno-canto (GET ?xeno=1&query=...) ──
    if (request.method === "GET" && url.searchParams.get("xeno") === "1") {
      const rawQuery = url.searchParams.get("query") || "";
      if (!rawQuery) {
        return new Response(JSON.stringify({ error: "query required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // ── Fix API v3 : les requêtes sans tag sont refusées (400).
      // Si la query ne contient pas déjà un tag (présence de ":"),
      // on la convertit en sp:"genre espece" (recherche par nom scientifique complet).
      // Ex: "Phoenicurus ochruros" → sp:"phoenicurus ochruros"
      const query = rawQuery.includes(":")
        ? rawQuery
        : `sp:"${rawQuery.toLowerCase()}"`;

      // Vérifier que la clé est configurée
      if (!env.XENO_KEY) {
        return new Response(JSON.stringify({ error: "XENO_KEY not configured", recordings: [] }), {
          status: 200, // on retourne 200 avec tableau vide pour ne pas bloquer l'app
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        const xenoUrl = `https://xeno-canto.org/api/3/recordings?query=${encodeURIComponent(query)}&per_page=10&key=${env.XENO_KEY}`;
        const resp = await fetch(xenoUrl, {
          headers: { "Accept": "application/json", "User-Agent": "BirdyDex/1.0" }
        });
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          status: resp.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch(err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ── Gemini (POST — analyse d'image) ──
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${env.GEMINI_KEY}`;
        const response = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
