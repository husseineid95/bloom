export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/worker.js' || url.pathname === '/wrangler.jsonc') return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === '/api/bloom' && request.method === 'POST') {
      try {
        return json(await handleBloomAction(await request.json(), env));
      } catch (err) {
        return json({ error: err?.message || 'AI Tutor error' }, 500);
      }
    }

    if (url.pathname === '/api/tts' && request.method === 'POST') {
      try {
        const { text, tutorGender = 'female' } = await request.json();
        if (!text || !env.GEMINI_API_KEY) return json({ fallback: true }, 200);
        const audio = await generateHumanSpeech(env.GEMINI_API_KEY, text, tutorGender);
        return json(audio || { fallback: true }, 200);
      } catch (_) {
        return json({ fallback: true }, 200);
      }
    }

    if (url.pathname === '/api/youtube' && request.method === 'POST') {
      try {
        const { videoId } = await request.json();
        return json(await fetchYouTubeContext(videoId));
      } catch (err) {
        return json({ error: err?.message || 'Video error' }, 500);
      }
    }

    if (url.pathname === '/api/auth' && request.method === 'POST') {
      try {
        return await handleAuth(await request.json(), env);
      } catch (err) {
        return json({ error: err?.message || 'Auth error' }, 500);
      }
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}
async function handleBloomAction(body = {}, env) {
  if (!env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY in Cloudflare Worker Secrets.');
  const langMap = { en: 'English', de: 'German', fr: 'French', es: 'Spanish' };
  const langName = langMap[body.lang] || 'English';
  const tutorName = body.tutorName || 'Claire';
  const tutorGender = body.tutorGender || 'female';
  const correctionMode = body.correctionMode || 'gentle';
  const history = Array.isArray(body.history) ? body.history.slice(-14) : [];
  const currentRate = Number(body.speechRate) || 1.0;

  const correctionRule =
    correctionMode === 'repeat'
      ? 'Only if the user makes a clear grammar mistake, warmly model the fix and ask them to repeat it once.'
      : correctionMode === 'none'
      ? 'Never correct grammar; focus 100% on natural, engaging conversation.'
      : 'Never nitpick valid phrasing. Only if there is an obvious grammar error, briefly recast the natural phrasing in 5-8 words without lecturing, then continue chatting.';

  const systemPrompt = [
    'You are ' + tutorName + ', a warm, intelligent, well-read human conversation partner (' + (tutorGender === 'female' ? 'woman' : 'man') + ') on a live voice call in Bloom.',
    'Language: ' + langName + '.',
    'KNOWLEDGE: You have broad general knowledge across technology, AI, science, history, geography, cities, cultures, websites, current world affairs, and everyday life. Discuss any topic naturally like a smart, curious friend.',
    'ADAPTABILITY: Follow live user instructions immediately (speak slower/faster, use simpler words, explain in detail, or repeat). Keep normal replies concise (1-3 spoken sentences) with one engaging follow-up question unless asked for a detailed explanation.',
    'Never use markdown, asterisks, bullets, or emojis.',
    correctionRule,
    'Output ONLY valid JSON: {"transcript":"what the user said","reply":"your spoken response","speechRate":' + currentRate + '}. Set speechRate to 0.8 if asked to slow down, 1.15 if faster, 1.0 if normal, else keep ' + currentRate + '.'
  ].join(' ');

  if (body.action === 'suggest_reply') {
    const prompt = 'Give 3 natural spoken reply ideas in ' + langName + ' to: "' + (body.lastTutorMessage || '') + '". Return ONLY JSON: {"suggestions":[{"text":""}]}';
    const raw = await callGeminiSmart(env.GEMINI_API_KEY, systemPrompt, prompt, [], null, null);
    return { reply: raw.replace(/```json|```/gi, '').trim() };
  }

  let userPrompt = '';
  if (body.action === 'discuss_video') {
    const ctx = (body.videoContext || '').slice(0, 3200);
    userPrompt = body.message === '__START_VIDEO_TALK__'
      ? 'We just watched "' + (body.videoTitle || 'Video') + '" (' + ctx + '). Share a thoughtful reaction in ' + langName + ' and ask an opening question.'
      : 'Discussing video "' + (body.videoTitle || 'Video') + '" (' + ctx + '). Listen to the user audio (or message: "' + (body.message || '') + '") and reply naturally in ' + langName + '.';
  } else {
    userPrompt = body.message === '__GREET__'
      ? 'Say a warm, natural hello as ' + tutorName + ' in ' + langName + ' and ask an engaging opening question.'
      : 'Listen carefully to the user audio (or message: "' + (body.message || '') + '") and respond naturally and intelligently in ' + langName + '.';
  }

  const raw = await callGeminiSmart(env.GEMINI_API_KEY, systemPrompt, userPrompt, history, body.audioBase64 || null, body.audioMime || 'audio/webm');
  return parseTutorEnvelope(raw, currentRate);
}

function parseTutorEnvelope(raw, fallbackRate = 1.0) {
  try {
    const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
    const obj = JSON.parse(cleaned);
    return { transcript: String(obj.transcript || '').trim(), reply: String(obj.reply || '').trim() || cleaned, speechRate: Number(obj.speechRate) || fallbackRate };
  } catch (_) {
    return { transcript: '', reply: String(raw || '').replace(/```json|```/gi, '').trim(), speechRate: fallbackRate };
  }
}

async function callGeminiSmart(apiKey, systemPrompt, userPrompt, history = [], audioBase64 = null, audioMime = 'audio/webm') {
  const host = ['generativelanguage', 'googleapis', 'com'].join('.');
  const models = ['gemini-3.8-flash', 'gemini-3.0-flash', 'gemini-2.5-flash'];
  const contents = [];

  for (const turn of history) {
    if (turn && turn.text) contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(turn.text) }] });
  }
  const userParts = [{ text: userPrompt }];
  if (audioBase64) userParts.push({ inlineData: { mimeType: audioMime || 'audio/webm', data: audioBase64 } });
  contents.push({ role: 'user', parts: userParts });

  let lastError = 'Gemini busy';
  for (const model of models) {
    try {
      const endpoint = 'https://' + host + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { temperature: 0.75, maxOutputTokens: 350 } })
      });
      const data = await res.json();
      if (!res.ok) { lastError = data?.error?.message || ('HTTP ' + res.status); continue; }
      const firstCand = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
      const parts = Array.isArray(firstCand?.content?.parts) ? firstCand.content.parts : [];
      const text = parts.map((p) => p.text || '').join('').trim();
      if (text) return text;
    } catch (e) { lastError = e?.message || lastError; }
  }
  throw new Error(lastError);
                              }
async function generateHumanSpeech(apiKey, text, tutorGender = 'female') {
  const voiceName = tutorGender === 'female' ? 'Aoede' : 'Charon';
  const cleanText = String(text || '').replace(/[*#_`~]/g, '').trim();
  const host = ['generativelanguage', 'googleapis', 'com'].join('.');
  const models = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'];

  for (const model of models) {
    try {
      const endpoint = 'https://' + host + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: cleanText }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } }
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const firstCand = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
      const parts = Array.isArray(firstCand?.content?.parts) ? firstCand.content.parts : [];
      const audioPart = parts.find((p) => p.inlineData?.mimeType?.startsWith('audio/'));
      if (audioPart?.inlineData?.data) return { audioBase64: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType || 'audio/wav' };
    } catch (_) {}
  }
  return null;
}

async function fetchYouTubeContext(videoId) {
  let title = '', transcript = '';
  try {
    const oRes = await fetch('https://youtube.com' + encodeURIComponent(videoId) + '&format=json');
    if (oRes.ok) { const o = await oRes.json(); title = o.title || ''; }
  } catch (_) {}
  try {
    const pRes = await fetch('https://youtube.com' + encodeURIComponent(videoId), { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' } });
    if (pRes.ok) {
      const html = await pRes.text();
      if (!title) { const tMatch = html.match(/<title>(.*?)<\/title>/); if (tMatch && tMatch.at(1)) title = tMatch.at(1).replace(' - YouTube', '').trim(); }
      const capMatch = html.match(/"captionTracks":\[(\{.*?\})\]/);
      const urlMatch = capMatch && capMatch.at(1) && capMatch.at(1).match(/"baseUrl":"(.*?)"/);
      if (urlMatch && urlMatch.at(1)) {
        const cRes = await fetch(urlMatch.at(1).replace(/\\u0026/g, '&'));
        if (cRes.ok) {
          const xml = await cRes.text();
          transcript = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => (m.at(1) || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '')).join(' ').slice(0, 3500);
        }
      }
    }
  } catch (_) {}
  return { videoId, title: title || ('YouTube Video (' + videoId + ')'), transcript };
}

async function hashPassword(password, salt = 'bloom_v2_salt') {
  const enc = new TextEncoder().encode(salt + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleAuth(body = {}, env) {
  const mode = body.mode;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  const kv = env.BLOOM_KV && typeof env.BLOOM_KV.get === 'function' ? env.BLOOM_KV : null;

  if (mode === 'signup') {
    const password = String(body.password || '');
    const name = String(body.name || email.split('@').at(0)).trim();
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400);
    const pwHash = await hashPassword(password);
    if (kv) {
      const existing = await kv.get('user:' + email, 'json');
      if (existing) return json({ error: 'Account already exists. Please Sign In.' }, 409);
      const userRecord = { email, name, pwHash, provider: 'email', createdAt: new Date().toISOString(), progress: body.progress || null };
      await kv.put('user:' + email, JSON.stringify(userRecord));
      return json({ ok: true, user: { email, name, provider: 'email' }, progress: userRecord.progress });
    }
    return json({ ok: true, user: { email, name, provider: 'email', pwHash }, progress: body.progress || null });
  }

  if (mode === 'signin') {
    const password = String(body.password || '');
    if (!password) return json({ error: 'Please enter your password.' }, 400);
    const pwHash = await hashPassword(password);
    if (kv) {
      const existing = await kv.get('user:' + email, 'json');
      if (!existing) return json({ error: 'No account found for this email. Create an account first.' }, 404);
      if (existing.pwHash && existing.pwHash !== pwHash) return json({ error: 'Incorrect password.' }, 401);
      return json({ ok: true, user: { email: existing.email, name: existing.name, provider: existing.provider || 'email' }, progress: existing.progress || null });
    }
    return json({ ok: true, user: { email, name: email.split('@').at(0), provider: 'email', pwHash }, progress: null });
  }

  if (mode === 'google') {
    const name = String(body.name || email.split('@').at(0)).trim();
    if (kv) {
      let existing = await kv.get('user:' + email, 'json');
      if (!existing) {
        existing = { email, name, provider: 'google', createdAt: new Date().toISOString(), progress: body.progress || null };
        await kv.put('user:' + email, JSON.stringify(existing));
      }
      return json({ ok: true, user: { email: existing.email, name: existing.name, provider: existing.provider || 'google' }, progress: existing.progress || null });
    }
    return json({ ok: true, user: { email, name, provider: 'google' }, progress: body.progress || null });
  }

  if (mode === 'sync' && kv) {
    const existing = await kv.get('user:' + email, 'json');
    if (existing) { existing.progress = body.progress; existing.updatedAt = new Date().toISOString(); await kv.put('user:' + email, JSON.stringify(existing)); }
  }
  return json({ ok: true });
}
