export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/worker.js' || url.pathname === '/wrangler.jsonc') {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/bloom' && request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await handleBloomAction(body, env);
        return json(result);
      } catch (err) {
        return json({ error: err?.message || 'AI Tutor error' }, 500);
      }
    }

    if (url.pathname === '/api/tts' && request.method === 'POST') {
      try {
        const { text, tutorGender = 'female', lang = 'en' } = await request.json();
        if (!text || !text.trim()) return json({ error: 'No text provided' }, 400);
        if (!env.GEMINI_API_KEY) return json({ fallback: true }, 200);
        const audioResult = await generateHumanSpeech(env.GEMINI_API_KEY, text, tutorGender, lang);
        return json(audioResult || { fallback: true }, 200);
      } catch (err) {
        return json({ fallback: true }, 200);
      }
    }

    if (url.pathname === '/api/youtube' && request.method === 'POST') {
      try {
        const { videoId } = await request.json();
        if (!videoId) return json({ error: 'Missing videoId' }, 400);
        return json(await fetchYouTubeContext(videoId));
      } catch (err) {
        return json({ error: err?.message || 'Could not load video details' }, 500);
      }
    }

    if (url.pathname === '/api/auth' && request.method === 'POST') {
      try {
        return await handleAuth(await request.json(), env);
      } catch (err) {
        return json({ error: err?.message || 'Authentication error' }, 500);
      }
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
async function handleBloomAction(body = {}, env) {
  const langMap = { en: 'English', de: 'German', fr: 'French', es: 'Spanish' };
  const langName = langMap[body.lang] || 'English';
  const tutorName = body.tutorName || 'Claire';
  const tutorGender = body.tutorGender || 'female';
  const correctionMode = body.correctionMode || 'gentle';
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

  const correctionRule =
    correctionMode === 'repeat'
      ? 'If the learner makes a noticeable mistake, warmly highlight it and ask them to repeat the corrected phrasing aloud.'
      : correctionMode === 'none'
      ? 'Keep the conversation flowing naturally without interrupting for grammar corrections.'
      : 'If the learner makes a grammar or vocabulary mistake, gently recast it in one brief warm sentence before continuing.';

  const systemPrompt = [
    'You are ' + tutorName + ', an experienced, articulate human language coach (' + (tutorGender === 'female' ? 'woman' : 'man') + ') on a live voice call inside Bloom.',
    'Target language: ' + langName + '.',
    'Speak like a real, thoughtful human conversation partner: use natural contractions, insightful reactions, and clear spoken phrasing (2-3 concise sentences max).',
    'Never use markdown asterisks, bullet symbols, emojis, or stage directions because your words are spoken aloud by a human voice synthesizer.',
    correctionRule
  ].join(' ');

  if (body.action === 'suggest_reply') {
    const prompt = 'The learner is practicing spoken ' + langName + '. Last tutor line: "' + (body.lastTutorMessage || '') + '". Context: "' + (body.topic || 'General conversation') + '". Give 3 natural spoken reply ideas in ' + langName + ' from simple to expressive. Return ONLY JSON: {"suggestions":[{"text":"","hint":""}]}';
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'discuss_video') {
    const context = (body.videoContext || '').slice(0, 3200);
    const prompt = body.message === '__START_VIDEO_TALK__'
      ? 'The learner just finished watching a ' + langName + ' video titled "' + (body.videoTitle || 'Video') + '". Video transcript/summary: "' + context + '". Open a thoughtful, engaging voice discussion about the core ideas or key moments in this video, and ask one insightful opening question in ' + langName + '.'
      : 'Voice discussion on the video "' + (body.videoTitle || 'Video') + '" (context: "' + context + '"). Learner said: "' + (body.message || '') + '". Respond professionally like a real human tutor in ' + langName + ' (2-3 spoken sentences), connecting to the video themes and asking one natural follow-up question.';
    return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
  }

  const prompt = body.message === '__GREET__'
    ? 'Start a live voice call in ' + langName + '. Greet the learner warmly as ' + tutorName + ' and ask an engaging, natural conversation opener in ' + langName + '.'
    : 'Learner said in ' + langName + ': "' + (body.message || '') + '". Reply professionally and naturally like a real human tutor in ' + langName + ' (2-3 spoken sentences) and keep the dialogue flowing.';

  return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
}
async function runLLM(env, systemPrompt, userPrompt, history = [], expectJson = false) {
  if (env.GEMINI_API_KEY) {
    return await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt, history, expectJson);
  }
  if (env.AI && typeof env.AI.run === 'function') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: userPrompt }
    ];
    const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages });
    if (res?.response) return res.response.trim();
  }
  throw new Error('Missing GEMINI_API_KEY in Cloudflare Worker Variables and Secrets.');
}

async function callGemini(apiKey, systemPrompt, userPrompt, history = [], expectJson = false) {
  const host = ['generativelanguage', 'googleapis', 'com'].join('.');
  const endpoint = 'https://' + host + '/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
  const contents = [];

  for (const turn of history) {
    if (!turn?.text) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.text) }]
    });
  }
  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const generationConfig = { temperature: expectJson ? 0.3 : 0.75, maxOutputTokens: 350 };
  if (expectJson) generationConfig.responseMimeType = 'application/json';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig
    })
  });

  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch (_) {
    throw new Error('Upstream response (' + res.status + '): ' + rawText.slice(0, 120));
  }
  if (!res.ok) throw new Error(data?.error?.message || 'Gemini API error (' + res.status + ')');
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Empty response from Gemini.');
  return text;
}

  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const generationConfig = { temperature: expectJson ? 0.3 : 0.75, maxOutputTokens: 350 };
  if (expectJson) generationConfig.responseMimeType = 'application/json';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Gemini API error (' + res.status + ')');
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Empty response from Gemini.');
  return text;


async function generateHumanSpeech(apiKey, text, tutorGender = 'female', lang = 'en') {
  const voiceName = tutorGender === 'female' ? 'Aoede' : 'Charon';
  const cleanText = text.replace(/[*#_`~]/g, '').trim();
  const models = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash'];

  for (const model of models) {
    try {
      const host = ['generativelanguage', 'googleapis', 'com'].join('.');
const endpoint = 'https://' + host + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Read this ' + lang + ' line aloud naturally like a real human tutor on a voice call. Add no extra words:\n\n' + cleanText }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
          }
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const firstCand = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
      const parts = Array.isArray(firstCand?.content?.parts) ? firstCand.content.parts : [];
      const audioPart = parts.find((p) => p.inlineData?.mimeType?.startsWith('audio/'));
      if (audioPart?.inlineData?.data) {
        return { audioBase64: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType || 'audio/wav' };
      }
    } catch (_) {}
  }
  return null;
}
async function fetchYouTubeContext(videoId) {
  let title = '', author = '', transcript = '';
  try {
    const oRes = await fetch('https://youtube.com' + encodeURIComponent(videoId) + '&format=json');
    if (oRes.ok) {
      const o = await oRes.json();
      title = o.title || '';
      author = o.author_name || '';
    }
  } catch (_) {}

  try {
    const pRes = await fetch('https://youtube.com' + encodeURIComponent(videoId), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (pRes.ok) {
      const html = await pRes.text();
      if (!title) {
        const tMatch = html.match(/<title>(.*?)<\/title>/);
        if (tMatch && tMatch.at(1)) title = tMatch.at(1).replace(' - YouTube', '').trim();
      }
      const capMatch = html.match(/"captionTracks":\[(\{.*?\})\]/);
      const urlMatch = capMatch && capMatch.at(1) && capMatch.at(1).match(/"baseUrl":"(.*?)"/);
      if (urlMatch && urlMatch.at(1)) {
        const cRes = await fetch(urlMatch.at(1).replace(/\\u0026/g, '&'));
        if (cRes.ok) {
          const xml = await cRes.text();
          transcript = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
            .map((m) => (m.at(1) || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, ''))
            .join(' ').slice(0, 3500);
        }
      }
    }
  } catch (_) {}

  return { videoId, title: title || ('YouTube Video (' + videoId + ')'), author, transcript };
}

async function hashPassword(password, salt = 'bloom_v2_salt') {
  const enc = new TextEncoder().encode(salt + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleAuth(body = {}, env) {
  const mode = body.mode;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
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
    if (existing) {
      existing.progress = body.progress;
      existing.updatedAt = new Date().toISOString();
      await kv.put('user:' + email, JSON.stringify(existing));
    }
  }
  return json({ ok: true });
}
