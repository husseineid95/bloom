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
        if (!env.GEMINI_API_KEY) {
          return json({ fallback: true, reason: 'No GEMINI_API_KEY configured' }, 200);
        }
        const audioResult = await generateHumanSpeech(env.GEMINI_API_KEY, text, tutorGender, lang);
        return json(audioResult || { fallback: true }, 200);
      } catch (err) {
        return json({ fallback: true, error: err?.message }, 200);
      }
    }

    if (url.pathname === '/api/youtube' && request.method === 'POST') {
      try {
        const { videoId } = await request.json();
        if (!videoId) return json({ error: 'Missing videoId' }, 400);
        const meta = await fetchYouTubeContext(videoId);
        return json(meta);
      } catch (err) {
        return json({ error: err?.message || 'Could not load video details' }, 500);
      }
    }

    if (url.pathname === '/api/auth' && request.method === 'POST') {
      try {
        const body = await request.json();
        return await handleAuth(body, env);
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
  const level = body.level || 'B2';
  const tutorName = body.tutorName || 'Claire';
  const tutorGender = body.tutorGender || 'female';
  const correctionMode = body.correctionMode || 'gentle';
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

  const correctionInstruction =
    correctionMode === 'repeat'
      ? `If the learner makes a grammar or vocabulary mistake, warmly point it out and ask them to repeat the corrected sentence aloud before continuing.`
      : correctionMode === 'none'
      ? `Focus purely on natural flow and meaning; do not interrupt with grammar corrections unless asked.`
      : `If the learner makes a noticeable mistake, recast or gently correct it in 1 brief, warm sentence, then continue the conversation naturally.`;

  const systemPrompt = [
    `You are ${tutorName}, a warm, realistic human language coach (${tutorGender === 'female' ? 'woman' : 'man'}) on a live voice call in Bloom.`,
    `Target language: ${langName}. Learner CEFR level: ${level}.`,
    `Speak like a real human friend and coach: use natural contractions, warm reactions, and concise spoken sentences (1-3 sentences max).`,
    `Never use markdown asterisks, bullet symbols, emojis, or stage directions because your text is read aloud by a human voice synthesizer.`,
    correctionInstruction
  ].join(' ');

  if (body.action === 'suggest_reply') {
    const prompt = `The learner (${level} ${langName}) is in a conversation. Last tutor message: "${body.lastTutorMessage || ''}". Context: "${body.topic || 'General chat'}". Give 3 natural, spoken reply options the learner can say next in ${langName}, ranging from simple to expressive. Return ONLY JSON: {"suggestions":[{"text":"","translationHint":""}]}`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'video_vocab') {
    const prompt = `Based on this ${langName} video titled "${body.videoTitle || 'Video'}" and transcript/context: "${(body.videoContext || '').slice(0, 3500)}", extract 8 high-value ${level} vocabulary words or idiomatic phrases actually relevant to this video. For each item provide: "term" (in ${langName}), "meaningInLang" (clear definition in ${langName}), "example" (natural ${level} sentence in ${langName}), and "partOfSpeech". Return ONLY JSON: {"words":[{"term":"","partOfSpeech":"","meaningInLang":"","example":""}]}`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'discuss_video') {
    const prompt = `We just watched "${body.videoTitle || 'a video'}". Context: "${(body.videoContext || '').slice(0, 2000)}". Learner said: "${body.message || 'Start the discussion'}". Respond naturally in ${langName} in 1-2 spoken sentences and ask one engaging follow-up question about the video's ideas.`;
    return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
  }

  if (body.action === 'eval_flashcard') {
    const prompt = `Evaluate spoken flashcard recall. Mode: ${body.direction || 'target_to_meaning'}. Target word/phrase: "${body.cardTerm || ''}". Meaning/definition: "${body.cardMeaning || ''}". Learner said: "${body.message || ''}". Be fair to minor speech-to-text transcription quirks. Return ONLY JSON: {"accurate":true,"gentleCorrection":"short spoken feedback in ${langName}","expectedAnswer":"${body.cardTerm || ''}"}`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'photo_chit_chat') {
    const prompt = `Photo description challenge. Scene: "${body.topic || ''}". Learner spoke for 1 minute in ${langName}: "${body.message || ''}". Give warm spoken feedback: praise what sounded natural, fix 1-2 grammar/vocabulary errors clearly, and suggest one richer ${level} phrase they could have used.`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], false, body.imageBase64 || null) };
  }

  if (body.action === 'topic_talk') {
    const prompt = `1-minute Topic Talk on: "${body.topic || ''}". Learner said in ${langName}: "${body.message || ''}". Give concise, encouraging spoken coaching: highlight one strength, correct key grammar or phrasing issues naturally, and model a native-sounding ${level} sentence.`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], false) };
  }

  if (body.action === 'word_link') {
    const prompt = `Word Link fluency drill. Starting word: "${body.word || ''}". Learner's spoken word chain: "${body.message || ''}". Count valid connected words in ${langName}, give brief energetic feedback, and point out any non-${langName} or invalid words.`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], false) };
  }

  if (body.action === 'shadowing') {
    if (body.message === '__NEXT_SENTENCE__') {
      const prompt = `Generate ONE natural, everyday idiomatic ${langName} sentence at ${level} CEFR level (8 to 15 words) that a native speaker would actually say in conversation. Output ONLY the plain sentence with no quotes.`;
      return { reply: await runLLM(env, systemPrompt, prompt, [], false) };
    }
    const prompt = `Shadowing practice. Target sentence: "${body.topic || ''}". Learner's spoken attempt: "${body.message || ''}". Compare them closely: give 1 brief, friendly pronunciation/wording tip in ${langName}, and on a new line provide ONE fresh ${level} sentence for the next turn.`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], false) };
  }

  if (body.action === 'role_play') {
    const prompt = `Role-play scenario: "${body.topic || 'Ordering at a busy café'}". Learner said: "${body.message || 'Start the role play'}". Stay fully in character, react naturally in 1-2 spoken sentences in ${langName}, and keep the scene moving.`;
    return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
  }

  if (body.action === 'generate_quiz') {
    const targetLevel = body.targetLevel || 'B2';
    const prompt = `Create a rigorous, authentic ${targetLevel} CEFR certification exam in ${langName}. Test genuine ${targetLevel} mastery (nuanced grammar, idioms, collocations, inference, and listening comprehension). Return ONLY valid JSON: {"readingPassage":"110-140 word ${langName} article excerpt at ${targetLevel}","listeningScript":"75-95 word spoken ${langName} script at ${targetLevel}","mcqs":[{"id":"q1","skill":"Reading","question":"","options":["","","",""],"answerIndex":0},{"id":"q2","skill":"Reading","question":"","options":["","","",""],"answerIndex":1},{"id":"q3","skill":"Listening","question":"","options":["","","",""],"answerIndex":2},{"id":"q4","skill":"Listening","question":"","options":["","","",""],"answerIndex":0},{"id":"q5","skill":"Grammar","question":"","options":["","","",""],"answerIndex":3},{"id":"q6","skill":"Grammar","question":"","options":["","","",""],"answerIndex":1}],"writingPrompt":"Demanding ${targetLevel} writing prompt in ${langName}","speakingPrompt":"Demanding ${targetLevel} speaking prompt in ${langName}"}`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  if (body.action === 'grade_quiz') {
    const prompt = `You are a strict CEFR examiner grading a ${body.targetLevel || level} exam in ${langName}. Exam data & learner responses: ${JSON.stringify(body.quizAnswers || {})}. Score MCQs objectively (60% weight), Writing depth/grammar/vocabulary at ${body.targetLevel || level} standard (20% weight), and Speaking fluency/accuracy (20% weight). Pass mark is 75%. Return ONLY JSON: {"scorePercent":78,"passed":true,"breakdown":"Reading/Listening/Grammar: X/6, Writing: Y/20, Speaking: Z/20","feedback":"Clear, constructive 2-sentence examiner evaluation in English."}`;
    return { reply: await runLLM(env, systemPrompt, prompt, [], true) };
  }

  const prompt = body.message === '__GREET__'
    ? `Start a live voice call with the learner in ${langName} at ${level} level. Greet them warmly as ${tutorName} and ask an engaging, natural opening question in ${langName}.`
    : `Learner said in ${langName}: "${body.message || ''}". Reply warmly and naturally in 1-2 spoken sentences in ${langName} and keep the conversation flowing.`;

  return { reply: await runLLM(env, systemPrompt, prompt, history, false) };
}

async function runLLM(env, systemPrompt, userPrompt, history = [], expectJson = false, imageBase64 = null) {
  if (env.GEMINI_API_KEY) {
    return await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt, history, expectJson, imageBase64);
  }
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, systemPrompt, userPrompt, history, expectJson);
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
  throw new Error('No AI provider available. Please add GEMINI_API_KEY in Cloudflare Worker Secrets.');
}

async function callGemini(apiKey, systemPrompt, userPrompt, history = [], expectJson = false, imageBase64 = null) {
  const endpoint = `https://googleapis.com{encodeURIComponent(apiKey)}`;
  const contents = [];

  for (const turn of history) {
    if (!turn?.text) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.text) }]
    });
  }

    const userParts = [{ text: userPrompt }];
  if (imageBase64 && imageBase64.includes(',')) {
    const [meta, data] = imageBase64.split(',');
    const mimeMatch = meta.match(/data:(.*?);base64/);
    userParts.push({
      inlineData: { mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg', data }
    });
  }
  contents.push({ role: 'user', parts: userParts });

  const generationConfig = {
    temperature: expectJson ? 0.3 : 0.75,
    maxOutputTokens: expectJson ? 1800 : 350
  };
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
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error (${res.status})`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Empty response from Gemini.');
  return text;
}

async function callOpenAI(apiKey, systemPrompt, userPrompt, history = [], expectJson = false) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
    { role: 'user', content: userPrompt }
  ];
  const payload = { model: 'gpt-4o-mini', messages };
  if (expectJson) payload.response_format = { type: 'json_object' };

  const res = await fetch('https://openai.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI error (${res.status})`);
  return data?.choices?.[0]?.message?.content?.trim() || '';
}
async function generateHumanSpeech(apiKey, text, tutorGender = 'female', lang = 'en') {
  const voiceName = tutorGender === 'female' ? 'Aoede' : 'Charon';
  const cleanText = text.replace(/[*#_`~]/g, '').trim();
  const models = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash'];

  for (const model of models) {
    try {
      const endpoint = `https://googleapis.com{model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `Read this ${lang} line aloud naturally like a real human tutor on a voice call. Add no extra words:\n\n${cleanText}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
          }
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
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
    const oRes = await fetch(`https://youtube.com{encodeURIComponent(videoId)}&format=json`);
    if (oRes.ok) {
      const o = await oRes.json();
      title = o.title || '';
      author = o.author_name || '';
    }
  } catch (_) {}

  try {
    const pRes = await fetch(`https://youtube.com{encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (pRes.ok) {
      const html = await pRes.text();
      if (!title) {
        const tMatch = html.match(/<title>(.*?)<\/title>/);
        if (tMatch) title = tMatch[1].replace(' - YouTube', '').trim();
      }
      const capMatch = html.match(/"captionTracks":\[(\{.*?\})\]/);
      const urlMatch = capMatch && capMatch[1].match(/"baseUrl":"(.*?)"/);
      if (urlMatch) {
        const cRes = await fetch(urlMatch[1].replace(/\\u0026/g, '&'));
        if (cRes.ok) {
          const xml = await cRes.text();
          transcript = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)]
            .map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, ''))
            .join(' ').slice(0, 3500);
        }
      }
    }
  } catch (_) {}

  return { videoId, title: title || `YouTube Video (${videoId})`, author, transcript };
}
async function hashPassword(password, salt = 'bloom_v2_salt') {
  const enc = new TextEncoder().encode(`${salt}:${password}`);
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
    const name = String(body.name || email.split('@')).trim();
    if (password.length < 6) {
      return json({ error: 'Password must be at least 6 characters.' }, 400);
    }
    const pwHash = await hashPassword(password);
    if (kv) {
      const existing = await kv.get(`user:${email}`, 'json');
      if (existing) {
        return json({ error: 'Account already exists. Please Sign In.' }, 409);
      }
      const userRecord = { email, name, pwHash, provider: 'email', createdAt: new Date().toISOString(), progress: body.progress || null };
      await kv.put(`user:${email}`, JSON.stringify(userRecord));
      return json({ ok: true, user: { email, name, provider: 'email' }, progress: userRecord.progress });
    }
    return json({ ok: true, user: { email, name, provider: 'email', pwHash }, progress: body.progress || null });
  }

  if (mode === 'signin') {
    const password = String(body.password || '');
    if (!password) return json({ error: 'Please enter your password.' }, 400);
    const pwHash = await hashPassword(password);
    if (kv) {
      const existing = await kv.get(`user:${email}`, 'json');
      if (!existing) return json({ error: 'No account found for this email. Create an account first.' }, 404);
      if (existing.pwHash && existing.pwHash !== pwHash) return json({ error: 'Incorrect password.' }, 401);
      return json({ ok: true, user: { email: existing.email, name: existing.name, provider: existing.provider || 'email' }, progress: existing.progress || null });
    }
    return json({ ok: true, user: { email, name: email.split('@'), provider: 'email', pwHash }, progress: null });
  }

  if (mode === 'google') {
    const name = String(body.name || email.split('@')).trim();
    if (kv) {
      let existing = await kv.get(`user:${email}`, 'json');
      if (!existing) {
        existing = { email, name, provider: 'google', createdAt: new Date().toISOString(), progress: body.progress || null };
        await kv.put(`user:${email}`, JSON.stringify(existing));
      }
      return json({ ok: true, user: { email: existing.email, name: existing.name, provider: 'google' }, progress: existing.progress || null });
    }
    return json({ ok: true, user: { email, name, provider: 'google' }, progress: body.progress || null });
  }

  if (mode === 'sync' && kv) {
    const existing = await kv.get(`user:${email}`, 'json');
    if (existing) {
      existing.progress = body.progress;
      existing.updatedAt = new Date().toISOString();
      await kv.put(`user:${email}`, JSON.stringify(existing));
    }
    return json({ ok: true });
  }

  return json({ ok: true });
}

      
