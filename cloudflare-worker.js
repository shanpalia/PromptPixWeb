export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = [
      "https://shanpalia.github.io"
    ];

    const corsOrigin = allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
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
      const type = String(body.type || "image").toLowerCase();
      const prompt = String(body.prompt || "").trim();

      if (!prompt) {
        return json({ error: "Prompt is required." }, 400, corsHeaders);
      }

      if (type === "video") {
        if (prompt.length > 1000) {
          return json(
            { error: "Video prompt must be 1000 characters or less." },
            400,
            corsHeaders
          );
        }

        const duration = Number(body.duration || 5);
        const allowedDurations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

        if (!allowedDurations.includes(duration)) {
          return json(
            { error: "Video duration must be between 1 and 15 seconds." },
            400,
            corsHeaders
          );
        }

        const ratio = String(body.ratio || "16:9");
        const allowedRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"];

        if (!allowedRatios.includes(ratio)) {
          return json({ error: "Unsupported video ratio." }, 400, corsHeaders);
        }

        const result = await env.AI.run("pixverse/v6", {
          prompt,
          aspect_ratio: ratio,
          duration,
          generate_audio: body.generateAudio !== false,
          quality: "720p"
        });

        const videoUrl = result?.video || result?.result?.video;

        if (!videoUrl) {
          console.error("Video generation returned no URL:", result);
          return json(
            { error: "No video URL was returned by the AI provider." },
            500,
            corsHeaders
          );
        }

        return json(
          {
            type: "video",
            videoUrl,
            duration,
            ratio,
            mimeType: "video/mp4"
          },
          200,
          corsHeaders
        );
      }

      const safePrompt = prompt.slice(0, 2048);

      const result = await env.AI.run(
        "@cf/black-forest-labs/flux-1-schnell",
        {
          prompt: safePrompt,
          steps: 4
        }
      );

      if (!result || !result.image) {
        return json(
          { error: "No image was generated." },
          500,
          corsHeaders
        );
      }

      return json(
        {
          type: "image",
          imageBase64: result.image,
          mimeType: "image/jpeg"
        },
        200,
        corsHeaders
      );

    } catch (error) {
      console.error("PromptPix AI Worker error:", error);

      return json(
        {
          error: error?.message || "AI generation failed."
        },
        500,
        corsHeaders
      );
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
