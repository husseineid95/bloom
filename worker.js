export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/bloom" && request.method === "POST") {
      try {
        const body = await request.json();
        const {
          lang = "en",
          level = "B2",
          tutorGender = "female",
          tutorName = "Claire",
          action = "chat",
          message = "",
          videoTitle = "",
          videoContext = "",
          topic = "",
          word = "",
          history = [],
          userName = "Learner"
        } = body;

        const LANG_META = {
          en: { name: "English", female: "Claire", male: "Julian" },
          de: { name: "German", female: "Hannah", male: "Lukas" },
          fr: { name: "French", female: "Camille", male: "Julien" },
          es: { name: "Spanish", female: "Sofia", male: "Mateo" }
        };

        const lm = LANG_META[lang] || LANG_META.en;
        const activeTutor = tutorName || (tutorGender === "male" ? lm.male : lm.female);

        let taskPrompt = "";
        if (action === "video_vocab") {
          taskPrompt = `Extract 6 high-utility, practical words or short phrases directly relevant to the video "${videoTitle}" (${videoContext || "general immersion video"}) at CEFR level ${level}. Return STRICT JSON only with this exact shape: {"words":[{"term":"...","meaningInLang":"...","example":"..."}]}. No markdown fences.`;
        } else if (action === "discuss_video") {
          taskPrompt = `You are discussing the video "${videoTitle}" (${videoContext || ""}) with ${userName} in a natural conversation (or live voice call). Ask engaging questions, build on what they watched, and keep responses concise and natural in ${lm.name} at level ${level}.`;
        } else if (action === "photo_chit_chat") {
          taskPrompt = `The learner just described a photo (${topic || "scene"}) for up to 1 minute. Give: 1) brief encouraging feedback, 2) clear written corrections if needed, and 3) 2-3 natural phrasing ideas at CEFR ${level} in ${lm.name}.`;
        } else if (action === "topic_talk") {
          taskPrompt = `The learner spoke for up to 1 minute on the topic "${topic}". Provide concise written corrections on grammar/phrasing and one natural follow-up question in ${lm.name} at CEFR ${level}.`;
        } else if (action === "word_link") {
          taskPrompt = `The learner played 1-minute Word Link starting from "${word}". Check any linked words they gave, briefly note any corrections, and suggest a clean chain of 4 related ${lm.name} words at CEFR ${level}.`;
        } else if (action === "shadowing") {
          if (!message || message === "__NEXT_SENTENCE__") {
            taskPrompt = `Give ONE natural ${lm.name} sentence (8-15 words) suited to CEFR ${level} for pronunciation shadowing. Reply with ONLY the sentence.`;
          } else {
            taskPrompt = `Compare the learner's shadowing attempt "${message}" against the target sentence "${topic || "the sentence"}". Point out any pronunciation/word/grammar issue clearly and concisely in ${lm.name}, then provide the next ${lm.name} sentence at CEFR ${level}.`;
          }
        } else if (action === "role_play") {
          taskPrompt = `Stay in character for the role-play scenario "${topic || "everyday situation"}". Speak naturally in ${lm.name} at CEFR ${level} and keep the scene moving.`;
        } else {
          taskPrompt = `Have a helpful, natural conversation with ${userName} in ${lm.name} adapted to CEFR level ${level} (vocabulary complexity, sentence length, and clarity suited to ${level}).`;
        }

        const systemInstruction = `You are ${activeTutor}, a ${tutorGender === "male" ? "male" : "female"} language coach on Bloom.
Target language: ${lm.name} (code: ${lang}). Learner CEFR level: ${level}.
Be accurate, encouraging, and free of mistakes. Write naturally in ${lm.name} unless translating into ${lm.name} for video vocabulary meanings.
${taskPrompt}`;

        const safeHistory = Array.isArray(history)
          ? history.slice(-8).map(m => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: String(m.content || "").slice(0, 1200)
            }))
          : [];

        const messages = [
          { role: "system", content: systemInstruction },
          ...safeHistory,
          { role: "user", content: message || "Hello" }
        ];

        const models = [
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          "@cf/mistralai/mistral-small-3.1-24b-instruct",
          "@cf/meta/llama-3.2-3b-instruct"
        ];

        let reply = "";
        let lastErr = "";

        for (const model of models) {
          try {
            const out = await env.AI.run(model, { messages });
            const text = out?.response || out?.result || out?.output_text || "";
            if (typeof text === "string" && text.trim()) {
              reply = text.trim();
              break;
            }
          } catch (e) {
            lastErr = e?.message || String(e);
          }
        }

        if (!reply) {
          return Response.json({ error: lastErr || "AI model unavailable" }, { status: 500 });
        }

        return Response.json({ reply, tutor: activeTutor, gender: tutorGender, lang, level });
      } catch (err) {
        return Response.json({ error: err?.message || "Bad request" }, { status: 400 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
