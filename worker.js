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
        const raw = env.GEMINI_API_KEY
          ? await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt, expectJson)
          : await callOpenAI(env.OPENAI_API_KEY, systemPrompt, userPrompt, expectJson);
        return json({ reply: raw });
      } catch (err) {
        return json({ error: err.message || 'Worker error' }, 500);
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
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

function buildPrompt(body) {
  const langMap = { en: 'English', de: 'German', fr: 'French', es: 'Spanish' };
  const langName = langMap[body.lang] || 'English';
  const level = body.level || 'B2';
  const tutorName = body.tutorName || 'Claire';
  const tutorGender = body.tutorGender || 'female';

  const systemPrompt = [
    `You are ${tutorName}, a${tutorGender === 'female' ? 'woman' : 'man'} language coach inside Bloom.`,
    `Target language: ${langName}. Learner CEFR level: ${level}.`,
    `Never chat casually in text logs or mention being an AI unless asked. Give gentle, brief corrections on mistakes in ${langName} when speaking/writing, then keep practice moving smoothly.`
  ].join(' ');

  if (body.action === 'video_vocab') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Extract 6 authentic, useful vocabulary words/phrases that fit inside a ${langName}${level} video titled "${body.videoTitle \vert{}\vert{} 'Video'}" (${body.videoContext || ''}). For each item provide "term" (in ${langName}), "meaningInLang" (clear meaning in ${langName}), and "example" (natural sentence using the term in ${langName}). Return ONLY valid JSON: {"words":[{"term":"","meaningInLang":"","example":""}]}`
    };
  }

  if (body.action === 'discuss_video') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Spoken video discussion for "${body.videoTitle \vert{}\vert{} 'Video'}" (${body.videoContext || ''}). Learner said: "${body.message || ''}". Gently correct any mistake in 1 short line if needed, then respond naturally in 1-2 short spoken sentences and ask one focused follow-up question in ${langName}.`
    };
  }

  if (body.action === 'eval_flashcard') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Evaluate active recall. Direction: "${body.direction || 'target_to_meaning'}". Card term: "${body.cardTerm || ''}". Expected meaning: "${body.cardMeaning || ''}". Learner spoke: "${body.message || ''}". Return ONLY valid JSON: {"accurate":true,"gentleCorrection":"","expectedAnswer":""}`
    };
  }

  if (body.action === 'photo_chit_chat') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Learner described a photo (${body.topic \vert{}\vert{} ''}) in${langName} at ${level}: "${body.message || ''}". Give gentle corrections on mistakes, 2 natural phrasing upgrades, and 2 quick conversation ideas in ${langName}.`
    };
  }

  if (body.action === 'topic_talk') {
    return {
      expectJson: false,
      systemPrompt,
      userPrompt: `Learner spoke on "${body.topic \vert{}\vert{} ''}" in ${langName} at ${level}: "${body.message || ''}". Provide gentle written corrections for mistakes, a clean improved version, and one next point to explore in ${langName}.`
    };
  }

  if (body.action === 'grade_quiz') {
    return {
      expectJson: true,
      systemPrompt,
      userPrompt: `Grade ${level} assessment: ${JSON.stringify(body.quizAnswers || {})}. Return ONLY valid JSON: {"scorePercent":75,"feedback":"short summary"}`
    };
  }

  return {
    expectJson: false,
    systemPrompt,
    userPrompt: `Live spoken call turn at ${level} in ${langName}. Learner said: "${body.message || ''}". Gently correct any mistake briefly, reply naturally in 1-2 short spoken sentences, and ask one concise question.`
  };
}

async function callGemini(apiKey, systemPrompt, userPrompt, expectJson) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.4,
          ...(expectJson ? { responseMimeType: 'application/json' } : {})
        }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini request failed');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(apiKey, systemPrompt, userPrompt, expectJson) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI request failed');
  return data.choices?.[0]?.message?.content || '';
}
