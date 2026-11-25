export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/bloom' && request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = env.GEMINI_API_KEY || env.OPENAI_API_KEY;
        if (!apiKey) {
          return json({ error: 'Missing AI API key on worker.' }, 500);
        }

        const { systemPrompt, userPrompt, expectJson } = buildPrompt(body);
        const reply = env.GEMINI_API_KEY
          ? await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt, expectJson)
          : await callOpenAI(env.OPENAI_API_KEY, systemPrompt, userPrompt, expectJson);

        return json({ reply });
      } catch (err) {
        return json({ error: err?.message || 'Worker error' }, 500);
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function buildPrompt(body = {}) {
  const langMap = { en: 'English', de: 'German', fr: 'French', es: 'Spanish' };
  const langName = langMap[body.lang] || 'English';
  const level = body.level || 'B2';
  const tutorName = body.tutorName || 'Claire';
  const tutorGender = body.tutorGender || 'female';

  const systemPrompt = [
    `You are ${tutorName}, a ${tutorGender === 'female' ? 'woman' : 'man'} language coach inside Bloom.`,
    `Target language: ${langName}. Learner CEFR level: ${level}.`,
    `Focus strictly on speaking, listening, and gentle, clear corrections on mistakes in ${langName}.`,
    `Keep spoken responses natural, encouraging, and concise.`
  ].join(' ');

  if (body.action === 'video_vocab') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Extract 6 authentic vocabulary items fitting a ${langName} ${level} video titled "${body.videoTitle || 'Video'}" (${body.videoContext || ''}). Each item needs "term" (in ${langName}), "meaningInLang" (clear meaning in ${langName}), and "example" (natural sentence using the term in ${langName}). Return ONLY JSON: {"words":[{"term":"","meaningInLang":"","example":""}]}`
    };
  }

  if (body.action === 'discuss_video') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Voice discussion on "${body.videoTitle || 'Video'}" (${body.videoContext || ''}). Learner said: "${body.message || ''}". Gently correct any mistake in 1 short line if needed, reply in 1-2 short spoken sentences, and ask one focused follow-up question in ${langName}.`
    };
  }

  if (body.action === 'eval_flashcard') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Evaluate spoken flashcard recall. Direction: ${body.direction || 'target_to_meaning'}. Target term: "${body.cardTerm || ''}". Meaning: "${body.cardMeaning || ''}". Learner spoke: "${body.message || ''}". Return ONLY JSON: {"accurate":true,"gentleCorrection":"","expectedAnswer":""}`
    };
  }

  if (body.action === 'photo_chit_chat') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Photo prompt context: "${body.topic || ''}". Learner spoke: "${body.message || ''}". Give gentle corrections, 1-2 natural phrasing improvements in ${langName}, and a brief follow-up prompt.`
    };
  }

  if (body.action === 'topic_talk') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Topic: "${body.topic || ''}". Learner spoke in ${langName}: "${body.message || ''}". Give gentle written/spoken feedback, fix key grammar/wording issues, and suggest one stronger ${level} expression.`
    };
  }

  if (body.action === 'word_link') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Word Link starting word: "${body.word || ''}". Learner spoke: "${body.message || ''}". Briefly evaluate word chain flow and vocabulary accuracy in ${langName}.`
    };
  }

  if (body.action === 'shadowing') {
    if (body.message === '__NEXT_SENTENCE__') {
      return {
        expectJson: false,
        systemPrompt,
        userPrompt: `Provide ONE natural, idiomatic ${langName} sentence at ${level} level suitable for shadowing practice. Output ONLY the sentence with no quotes or numbering.`
      };
    }
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Target sentence was: "${body.topic || ''}". Learner attempted: "${body.message || ''}". Give 1 brief pronunciation/rhythm tip in ${langName}, then provide ONE new ${level} sentence on the last line for the next shadowing turn.`
    };
  }

  if (body.action === 'role_play') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Role play scenario: "${body.topic || 'Everyday conversation'}". Learner said: "${body.message || ''}". Stay in character as ${tutorName}, gently correct any clear mistake in 1 short phrase, and reply in 1-2 natural spoken sentences in ${langName}.`
    };
  }

  if (body.action === 'grade_quiz') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Grade this ${level} CEFR placement/unlock quiz (reading, listening, writing, speaking, grammar): ${JSON.stringify(body.quizAnswers || {})}. Return ONLY JSON: {"scorePercent":80,"feedback":"concise summary"}`
    };
  }

  return {
    expectJson: false,
    systemPrompt,
    userPrompt: `Learner said in ${langName}: "${body.message || ''}". Respond conversationally in 1-2 short spoken sentences in ${langName}, gently correcting any mistake if needed.`
  };
}

async function callGemini(apiKey, systemPrompt, userPrompt, expectJson) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const generationConfig = expectJson ? { responseMimeType: 'application/json' } : {};

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Empty response from Gemini.');
  return text;
}

async function callOpenAI(apiKey, systemPrompt, userPrompt, expectJson) {
  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
  if (expectJson) payload.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response from OpenAI.');
  return text;
}
