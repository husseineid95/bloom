export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/speak" && request.method === "POST") {
      try {
        const {
          mode,
          message,
          videoTranscript,
          savedWords,
          crosstalk,
          corrections,
          nativeLang
        } = await request.json();

        let modePrompt = "Have a natural, engaging English conversation on any topic.";
        if (mode === "discuss_video") {
          modePrompt = `The user just watched a video with this transcript: "${videoTranscript}". Discuss what happened, ask for their opinion, and encourage them to use these words: [${(savedWords || []).join(", ")}].`;
        } else if (mode === "role_play") {
          modePrompt = "Act out a realistic everyday English scenario (e.g. ordering coffee, traveling, job interview). Stay in character.";
        } else if (mode === "shadowing") {
          modePrompt = "Give the user one natural, everyday British/American English phrase to repeat, then give feedback on natural rhythm and stress.";
        } else if (mode === "exercises") {
          modePrompt = `Give the user a quick speaking prompt to practice using these words: [${(savedWords || []).join(", ")}].`;
        }

        const crosstalkRule = crosstalk
          ? `CROSSTALK MODE ON: The user may write or speak in ${nativeLang || "Arabic"} or English. Understand both seamlessly, and ALWAYS reply in clear, natural English.`
          : "Speak and reply in natural English.";

        const correctionRule =
          corrections === "Gentle"
            ? "If the user makes a grammar or phrasing mistake, reply naturally first, then add a brief '💡 Tip:' showing how a native speaker would say it."
            : corrections === "Direct"
            ? "Point out any grammar mistakes clearly before continuing the conversation."
            : "";

        const systemPrompt = `You are Bloom, a warm, encouraging English immersion tutor.
${modePrompt}
${crosstalkRule}
${correctionRule}
Keep your reply short and conversational (2–3 sentences) and end with an engaging follow-up question.`;

        const payload = {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
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
            if (aiResponse && (aiResponse.response || aiResponse.result)) {
              replyText = aiResponse.response || aiResponse.result;
              break;
            }
          } catch (modelErr) {
            lastError = modelErr.message;
          }
        }

        if (!replyText) {
          return Response.json(
            { error: `Workers AI model error: ${lastError || "No active model responded"}` },
            { status: 500 }
          );
        }

        return Response.json({ reply: replyText });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
