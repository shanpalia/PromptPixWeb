export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://shanpalia.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "Only POST requests are allowed." }, 405, corsHeaders);
    }

    try {
      const body = await request.json();
      const type = String(body.type || "image").toLowerCase();
      const prompt = String(body.prompt || "").trim();

      if (!prompt) {
        return json({ error: "Prompt is required." }, 400, corsHeaders);
      }

      // VIDEO GENERATION
      if (type === "video") {
        const safePrompt = prompt.slice(0, 2048);
        const duration = Number(body.duration || 5);
        const ratio = String(body.ratio || "16:9");

        const allowedRatios = ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"];

        if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
          return json({ error: "Video duration must be between 1 and 15 seconds." }, 400, corsHeaders);
        }

        if (!allowedRatios.includes(ratio)) {
          return json({ error: "Unsupported video ratio." }, 400, corsHeaders);
        }

        const result = await env.AI.run("pixverse/v6", {
          prompt: safePrompt,
          aspect_ratio: ratio,
          duration,
          generate_audio: body.generateAudio !== false,
          quality: "720p"
        });

        const videoUrl = result?.result?.video || result?.video;

        if (!videoUrl) {
          console.error("PixVerse response:", JSON.stringify(result));
          return json({
            error: "Cloudflare AI did not return a video URL.",
            state: result?.state || null,
            providerResponse: result || null
          }, 502, corsHeaders);
        }

        return json({
          type: "video",
          videoUrl,
          duration,
          ratio,
          mimeType: "video/mp4"
        }, 200, corsHeaders);
      }

      // IMAGE GENERATION — existing behavior preserved
      const safePrompt = prompt.slice(0, 2048);

      const result = await env.AI.run(
        "@cf/black-forest-labs/flux-1-schnell",
        {
          prompt: safePrompt,
          steps: 4
        }
      );

      if (!result || !result.image) {
        return json({ error: "No image was generated." }, 500, corsHeaders);
      }

      return json({
        imageBase64: result.image,
        mimeType: "image/jpeg"
      }, 200, corsHeaders);

    } catch (error) {
      console.error("PromptPix Worker error:", error);

      return json({
        error: error?.message || "AI generation failed."
      }, 500, corsHeaders);
    }
  }
};

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
