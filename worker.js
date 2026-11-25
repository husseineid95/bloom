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
      ? 'Only if the learner makes a clear grammar error, warmly model the fix and ask them to repeat it once.'
      : correctionMode === 'none'
      ? 'Do not correct grammar at all; focus 100% on natural conversation.'
      : 'Never nitpick valid phrasing. Only if there is an obvious grammar mistake, briefly model the natural way in 5-8 words without lecturing, then continue chatting.';

  const systemPrompt = [
    'You are ' + tutorName + ', a warm, friendly human conversation partner (' + (tutorGender === 'female' ? 'woman' : 'man') + ') on a live phone call in Bloom.',
    'Language: ' + langName + '.',
    'CRITICAL RULE: Keep every reply to 1 or 2 short, natural spoken sentences (maximum 30 words total). Never give long speeches or lists.',
    'Sound like a real human friend talking on the phone: use natural contractions, warmth, and ask ONE short, engaging follow-up question.',
    'Never use markdown, asterisks, bullet points, or emojis.',
    correctionRule
  ].join(' ');

  if (body.action === 'suggest_reply') {
    const prompt = 'Give 3 short, natural spoken reply ideas in ' + langName + ' to: "' + (body.lastTutorMessage || '') + '". Return ONLY JSON: {"suggestions":[{"text":""}]}';
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'discuss_video') {
    const context = (body.videoContext || '').slice(0, 3000);
    const prompt = body.message === '__START_VIDEO_TALK__'
      ? 'We just watched "' + (body.videoTitle || 'Video') + '" (' + context + '). In 1-2 short spoken sentences in ' + langName + ', share one quick reaction to the video and ask what stood out to the learner.'
      : 'Discussing video "' + (body.videoTitle || 'Video') + '" (' + context + '). Learner said: "' + (body.message || '') + '". Reply in 1-2 short, natural spoken sentences in ' + langName + ' and ask one follow-up question.';
    return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
  }

  const prompt = body.message === '__GREET__'
    ? 'Say a warm, casual 1-sentence hello as ' + tutorName + ' in ' + langName + ' and ask a fun, easy question to start the call.'
    : 'Learner said: "' + (body.message || '') + '". Reply in 1-2 short, natural spoken sentences in ' + langName + ' (under 30 words) like a real friend on a call.';

  return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
}


async function runLLM(env, systemPrompt, userPrompt, history = [], expectJson = false) {
  let lastErr = '';
  if (env.GEMINI_API_KEY) {
    const geminiModels = ['gemini-3.8-flash', 'gemini-3.0-flash', 'gemini-2.5-flash-lite'];
    for (const model of geminiModels) {
      try {
        return await callGemini(env.GEMINI_API_KEY, model, systemPrompt, userPrompt, history, expectJson);
      } catch (err) {
        lastErr = err && err.message ? err.message : 'Gemini busy';
      }
    }
  }
  if (env.AI && typeof env.AI.run === 'function') {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: userPrompt }
    ];
    const cfModels = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.2-3b-instruct', '@cf/qwen/qwen2.5-7b-instruct-fp8'];
    for (const cfModel of cfModels) {
      try {
        const res = await env.AI.run(cfModel, { messages });
        if (res && res.response) return res.response.trim();
      } catch (err) {
        lastErr = err && err.message ? err.message : lastErr;
      }
    }
  }
  throw new Error(lastErr || 'AI tutors are temporarily busy. Please tap again.');
}


async function callGemini(apiKey, model, systemPrompt, userPrompt, history = [], expectJson = false) {
  const host = ['generativelanguage', 'googleapis', 'com'].join('.');
  const endpoint = 'https://' + host + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
  const contents = [];

  for (const turn of history) {
    if (turn && turn.text) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(turn.text) }]
      });
    }
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
    throw new Error('Upstream (' + res.status + ')');
  }
  if (!res.ok) throw new Error(data?.error?.message || 'Gemini error (' + res.status + ')');
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates.at(0) : null;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Empty response');
  return text;
}




async function generateHumanSpeech(apiKey, text, tutorGender = 'female', lang = 'en', env = null) {
  const voiceName = tutorGender === 'female' ? 'Aoede' : 'Charon';
  const cleanText = text.replace(/[*#_`~]/g, '').trim();
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
