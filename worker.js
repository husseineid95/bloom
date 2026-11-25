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
          quizAnswers = null,
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
          taskPrompt = `Extract 6 practical, high-utility words or short phrases fit for CEFR ${level} from the video "${videoTitle}" (${videoContext || ""}). Return STRICT JSON only with no markdown: {"words":[{"term":"...","meaningInLang":"...","example":"..."}]}.`;
        } else if (action === "discuss_video") {
          taskPrompt = `Discuss the video "${videoTitle}" (${videoContext || ""}) with ${userName} in ${lm.name} at CEFR ${level}. Ask natural follow-up questions and keep replies clear and helpful.`;
        } else if (action === "photo_chit_chat") {
          taskPrompt = `Evaluate ${userName}'s 1-minute photo description for scene "${topic}" at CEFR ${level} in ${lm.name}. Give: 1) Brief praise/clarity check, 2) Clear written corrections, 3) 2-3 stronger phrasing ideas.`;
        } else if (action === "topic_talk") {
          taskPrompt = `Evaluate ${userName}'s 1-minute speech on topic "${topic}" at CEFR ${level} in ${lm.name}. Give concise written grammar/phrasing corrections and 1 follow-up question.`;
        } else if (action === "word_link") {
          taskPrompt = `Evaluate ${userName}'s 1-minute Word Link starting from "${word}" at CEFR ${level} in ${lm.name}. Note any mistakes and give a clean chain of 5 connected words starting from "${word}".`;
        } else if (action === "shadowing") {
          if (!message || message === "__NEXT_SENTENCE__") {
            taskPrompt = `Output ONE natural ${lm.name} sentence (9-15 words) suited to CEFR ${level}. Output ONLY the sentence.`;
          } else {
            taskPrompt = `Compare learner attempt "${message}" against target "${topic}" at CEFR ${level} in ${lm.name}. Point out any error clearly, then give the next ${lm.name} sentence.`;
          }
        } else if (action === "role_play") {
          taskPrompt = `Role-play "${topic || "everyday situation"}" in ${lm.name} at CEFR ${level}. Stay in character and respond naturally.`;
        } else if (action === "grade_quiz") {
          taskPrompt = `Grade these CEFR ${level} 4-skills + grammar answers in ${lm.name}: ${JSON.stringify(quizAnswers || {})}. Return STRICT JSON only with no markdown: {"scorePercent":0,"passed":false,"feedback":"..."}. Pass mark is 70.`;
        } else {
          taskPrompt = `Converse naturally with ${userName} in ${lm.name} calibrated to CEFR ${level}.`;
        }

        const systemInstruction = `You are ${activeTutor}, a ${tutorGender === "male" ? "male" : "female"} language coach on Bloom.
Target language: ${lm.name} (${lang}). Learner level: ${level}. Be accurate, clear, and helpful.
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
        return Response.json({ error: err?.message || "Invalid request" }, { status: 400 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
