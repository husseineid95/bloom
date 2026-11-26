export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

    if (url.pathname === "/api/products") {
      if (request.method === "GET") {
        const list = await env.STORE_KV.list({ prefix: "prod:" });
        if (list.keys.length > 0) {
          const items = await Promise.all(list.keys.map((k) => env.STORE_KV.get(k.name, "json")));
          const valid = items.filter(Boolean).sort((a, b) => (b.id || "").localeCompare(a.id || ""));
          return new Response(JSON.stringify(valid), { headers: cors });
        }
        return new Response("[]", { headers: cors });
      }
      if (request.method === "POST") {
        const payload = await request.json();
        if (Array.isArray(payload)) {
          await Promise.all(payload.map((p) => env.STORE_KV.put(`prod:${p.id}`, JSON.stringify(p))));
        } else if (payload && payload.id) {
          await env.STORE_KV.put(`prod:${payload.id}`, JSON.stringify(payload));
        }
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (id) await env.STORE_KV.delete(`prod:${id}`);
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
    }

    if (url.pathname === "/api/orders") {
      if (request.method === "GET") {
        const data = await env.STORE_KV.get("orders");
        return new Response(data || "[]", { headers: cors });
      }
      if (request.method === "POST") {
        const body = await request.text();
        await env.STORE_KV.put("orders", body);
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
    }

    if (url.pathname === "/api/settings") {
      if (request.method === "GET") {
        const data = await env.STORE_KV.get("settings");
        return new Response(data || "{}", { headers: cors });
      }
      if (request.method === "POST") {
        const body = await request.text();
        await env.STORE_KV.put("settings", body);
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
    }

    if (url.pathname === "/api/ai" && request.method === "POST") {
      try {
        const body = await request.json();
        const prompt = String(body.prompt || "");
        const imageBase64 = String(body.image || "");

        // 1. Try Google AI Studio if a valid AIza... key is set
        if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.startsWith("AIza")) {
          const parts = [{ text: prompt }];
          if (imageBase64.startsWith("data:image/")) {
            const commaIdx = imageBase64.indexOf(",");
            const mime = imageBase64.slice(5, imageBase64.indexOf(";"));
            const data = imageBase64.slice(commaIdx + 1);
            parts.push({ inline_data: { mime_type: mime, data } });
          }
          const geminiUrl = "https://googleapis.com" + env.GEMINI_API_KEY;
          const aiRes = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          });
          if (aiRes.ok) {
            const aiJson = await aiRes.json();
            const rawText = aiJson?.candidates?.at(0)?.content?.parts?.at(0)?.text || "{}";
            return new Response(rawText, { headers: cors });
          }
        }

        // 2. Fallback to built-in Cloudflare Workers AI (env.AI)
        if (env.AI) {
          let visualHint = "";
          if (imageBase64.startsWith("data:image/")) {
            const base64Data = imageBase64.slice(imageBase64.indexOf(",") + 1);
            const binStr = atob(base64Data);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
            const visionRes = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
              image: Array.from(bytes),
              prompt: "Describe this product concisely in one sentence.",
              max_tokens: 100,
            }).catch(() => null);
            if (visionRes && visionRes.description) {
              visualHint = " Visual appearance: " + visionRes.description;
            }
          }

          const cfRes = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
            messages: [
              { role: "system", content: "Return ONLY valid JSON with keys: name_en, desc_en, name_ar, desc_ar, name_fr, desc_fr, name_de, desc_de, category. No markdown." },
              { role: "user", content: prompt + visualHint },
            ],
          });
          const text = String(cfRes.response || "{}");
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          const cleanJson = start !== -1 && end !== -1 ? text.slice(start, end + 1) : "{}";
          return new Response(cleanJson, { headers: cors });
        }

        return new Response(JSON.stringify({ error: "No AI binding available" }), { status: 500, headers: cors });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
