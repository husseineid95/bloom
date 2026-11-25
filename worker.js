export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/speak" && request.method === "POST") {
      try {
        const body = await request.json();
        const {
          mode = "general",
          tutorName = "Clara",
          tutorAccent = "British English",
          scenarioType = "",
          situation = "",
          topic = "",
          message = "",
          videoTranscript = "",
          savedWords = [],
          crosstalk = true,
          corrections = "Gentle",
          nativeLang = "Arabic",
          level = "B2"
        } = body;

        const cleanName = String(tutorName || "Clara").replace(/\s*(🇺🇸|🇬🇧|🇦🇺).*/u, "").trim() || "Clara";
        const wordsList = Array.isArray(savedWords) && savedWords.length ? savedWords.join(", ") : "stroll, fair enough, peckish";

        let modeInstruction = `Have a warm, natural conversation on whatever topic ${body.userName || "the learner"} brings up.`;
        if (mode === "role_play") {
          modeInstruction = `Role Play mode — Scenario category: "${scenarioType || "Everyday Life"}", Situation: "${situation || "A real-life conversation"}". Stay fully in character as the other person in this situation, respond naturally, and keep the scene moving forward.`;
        } else if (mode === "discuss_video") {
          modeInstruction = `Discuss a Video mode — Context/notes: "${videoTranscript || "A video lesson"}". Talk about the ideas, story, or details in the video, ask what the learner thinks, and naturally invite them to use words from their Vocab Garden (${wordsList}).`;
        } else if (mode === "shadowing") {
          modeInstruction = `Shadowing mode — Topic: "${topic || "everyday life"}". Provide ONE clear, natural ${tutorAccent} sentence (around 10–16 words) for the learner to mimic and repeat. If the learner already repeated a sentence, briefly comment on natural stress/rhythm and give the next sentence on the topic.`;
        } else if (mode === "exercises") {
          modeInstruction = `Speaking Exercises mode — Use these Vocab Garden words: [${wordsList}]. Give a short, engaging speaking prompt or Word Link challenge that helps the learner actively use these words in context.`;
        } else if (topic) {
          modeInstruction = `Conversation mode focused on: "${topic}".`;
        }

        const crosstalkRule = crosstalk
          ? `Crosstalk is ON: The learner may speak or write in ${nativeLang} or English. Understand ${nativeLang} or English effortlessly, and ALWAYS reply in natural ${tutorAccent}.`
          : `Reply in natural ${tutorAccent}.`;

        const correctionRule =
          corrections === "Gentle"
            ? `Corrections are Gentle: Reply naturally first so the conversation flows, then if there is a clear grammar or phrasing mistake, add a brief "💡 Tip:" at the end with a natural phrasing.`
            : corrections === "Direct"
            ? `Corrections are Direct: Briefly and clearly point out any grammar or phrasing mistake, then continue the conversation naturally.`
            : `Corrections are Off: Do not correct grammar; focus purely on natural conversation.`;

        const systemPrompt = `You are ${cleanName}, a human-like immersion language tutor speaking ${tutorAccent}, inside the Bloom app.
Never call yourself "Bloom" or say you are an AI model unless explicitly asked about how the app works. Stay in character as ${cleanName} at all times.
Target learner level: ${level}.
${modeInstruction}
${crosstalkRule}
${correctionRule}
Keep responses concise, natural, and conversational (2–4 sentences), without robotic bullet lists unless asked.`;

        const payload = {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message || "Hello!" }
          ]
        };

        const models = [
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          "@cf/mistralai/mistral-small-3.1-24b-instruct",
          "@cf/meta/llama-3.2-3b-instruct"
        ];

        let replyText = "";
        let lastError = "";

        for (const modelName of models) {
          try {
            const aiResponse = await env.AI.run(modelName, payload);
            const candidate =
              aiResponse?.response ||
              aiResponse?.result ||
              aiResponse?.output_text ||
              "";
            if (typeof candidate === "string" && candidate.trim()) {
              replyText = candidate.trim();
              break;
            }
          } catch (err) {
            lastError = err?.message || String(err);
          }
        }

        if (!replyText) {
          return Response.json(
            { error: `Workers AI unavailable: ${lastError || "No model responded"}` },
            { status: 500 }
          );
        }

        return Response.json({ reply: replyText, tutor: cleanName });
      } catch (err) {
        return Response.json({ error: err?.message || "Invalid request" }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
