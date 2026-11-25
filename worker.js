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
          level = "B2",
          userName = "Hussein"
        } = body;

        const cleanName = String(tutorName || "Clara").replace(/\s*(🇺🇸|🇬🇧|🇦🇺).*/u, "").trim() || "Clara";
        const wordsList = Array.isArray(savedWords) && savedWords.length ? savedWords.join(", ") : "stroll, peckish, fair enough";

        let modeInstruction = `Have a warm, natural conversation on whatever topic ${userName} brings up.`;
        if (mode === "role_play") {
          modeInstruction = `Role Play mode — Scenario category: "${scenarioType || "Everyday Life"}", Situation: "${situation || "A real-life conversation"}". Stay in character as the other person in this situation and keep the dialogue natural and engaging.`;
        } else if (mode === "photo_chit_chat") {
          modeInstruction = `Photo Chit Chat mode — Scene context: "${topic || "A photograph"}". Respond naturally to how ${userName} describes the photo, ask a natural follow-up question about what they see, and keep it conversational.`;
        } else if (mode === "discuss_video") {
          modeInstruction = `Discuss a Video mode — Context: "${videoTranscript || "A video lesson"}". Talk about the video's ideas or story, ask what ${userName} thinks, and invite them to use words from their Vocab Garden (${wordsList}).`;
        } else if (mode === "shadowing") {
          modeInstruction = `Shadowing mode — Topic: "${topic || "everyday life"}". Provide ONE natural ${tutorAccent} sentence (around 10–16 words) for ${userName} to repeat. If they already repeated a sentence, briefly note natural stress/rhythm and give the next sentence.`;
        } else if (mode === "exercises") {
          modeInstruction = `Speaking Exercises mode — Vocab Garden words: [${wordsList}]. Give a short speaking prompt or Word Link challenge using these words in context.`;
        } else if (topic) {
          modeInstruction = `Conversation mode focused on: "${topic}".`;
        }

        const crosstalkRule = crosstalk
          ? `Crosstalk is ON: ${userName} may speak or write in ${nativeLang} or English. Understand ${nativeLang} or English smoothly, and ALWAYS reply in natural ${tutorAccent}.`
          : `Reply in natural ${tutorAccent}.`;

        const correctionRule =
          corrections === "Gentle"
            ? `Corrections are Gentle: Reply naturally first, then if there is a clear grammar or phrasing mistake, add a brief "💡 Tip:" at the end.`
            : corrections === "Direct"
            ? `Corrections are Direct: Briefly and clearly point out any grammar or phrasing mistake, then continue naturally.`
            : `Corrections are Off: Do not correct grammar; focus purely on natural conversation.`;

        const systemPrompt = `You are ${cleanName}, a human-like immersion language tutor speaking ${tutorAccent}, inside the Bloom app.
Never call yourself "Bloom" or say you are an AI unless directly asked how the app works. Stay in character as ${cleanName} at all times.
Target learner level: ${level}.
${modeInstruction}
${crosstalkRule}
${correctionRule}
Keep responses concise, natural, and conversational (2–4 sentences), without robotic lists unless asked.`;

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
            const candidate = aiResponse?.response || aiResponse?.result || aiResponse?.output_text || "";
            if (typeof candidate === "string" && candidate.trim()) {
              replyText = candidate.trim();
              break;
            }
          } catch (err) {
            lastError = err?.message || String(err);
          }
        }

        if (!replyText) {
          return Response.json({ error: `Workers AI unavailable: ${lastError || "No model responded"}` }, { status: 500 });
        }

        return Response.json({ reply: replyText, tutor: cleanName });
      } catch (err) {
        return Response.json({ error: err?.message || "Invalid request" }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
