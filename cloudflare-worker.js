import { HfInference } from "@huggingface/inference";

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

      if (type === "video") {
        if (!env.HF_TOKEN) {
          return json({
            error: "HF_TOKEN is not configured in the Worker."
          }, 500, corsHeaders);
        }

        if (!env.SUPABASE_URL) {
          return json({
            error: "SUPABASE_URL is not configured in the Worker."
          }, 500, corsHeaders);
        }

        if (!env.SUPABASE_SERVICE_ROLE_KEY) {
          return json({
            error: "SUPABASE_SERVICE_ROLE_KEY is not configured in the Worker."
          }, 500, corsHeaders);
        }

        const duration = Number(body.duration || 5);
        const ratio = String(body.ratio || "16:9");

        const allowedRatios = [
          "16:9", "4:3", "1:1", "3:4",
          "9:16", "2:3", "3:2", "21:9"
        ];

        if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
          return json({
            error: "Video duration must be between 1 and 15 seconds."
          }, 400, corsHeaders);
        }

        if (!allowedRatios.includes(ratio)) {
          return json({
            error: "Unsupported video ratio."
          }, 400, corsHeaders);
        }

        try {
          /*
           * IMPORTANT:
           * Wan2.1-T2V-1.3B is NOT served by the hf-inference
           * provider for text-to-video.
           *
           * Hugging Face currently maps this model to fal-ai.
           */
          const hf = new HfInference(env.HF_TOKEN);

          const video = await hf.textToVideo({
            model: "Wan-AI/Wan2.1-T2V-1.3B",
            provider: "fal-ai",
            inputs: prompt.slice(0, 2048),
            parameters: {
              num_inference_steps: 5
            }
          });

          if (!video) {
            throw new Error("Hugging Face returned no video data.");
          }

          const videoBytes = await video.arrayBuffer();

          if (!videoBytes || videoBytes.byteLength === 0) {
            throw new Error("Hugging Face returned an empty video.");
          }

          const path =
            "videos/" +
            Date.now() +
            "-" +
            crypto.randomUUID() +
            ".mp4";

          const baseUrl = env.SUPABASE_URL.replace(/\/$/, "");

          const uploadUrl =
            baseUrl +
            "/storage/v1/object/promptpix-images/" +
            path;

          const upload = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Content-Type": "video/mp4",
              "x-upsert": "false"
            },
            body: videoBytes
          });

          if (!upload.ok) {
            const detail = await upload.text();

            console.error(
              "Supabase video upload failed:",
              upload.status,
              detail
            );

            return json({
              error: "Video generated but storage upload failed.",
              detail,
              uploadStatus: upload.status
            }, 502, corsHeaders);
          }

          const videoUrl =
            baseUrl +
            "/storage/v1/object/public/promptpix-images/" +
            path;

          return json({
            type: "video",
            videoUrl,
            duration,
            ratio,
            mimeType: "video/mp4",
            model: "Wan-AI/Wan2.1-T2V-1.3B",
            provider: "fal-ai"
          }, 200, corsHeaders);

        } catch (error) {
          console.error("Hugging Face video generation failed:", error);

          return json({
            error: "Hugging Face video generation failed.",
            detail: error?.message || String(error),
            model: "Wan-AI/Wan2.1-T2V-1.3B",
            provider: "fal-ai"
          }, 502, corsHeaders);
        }
      }

      // Existing image generation path.
      const result = await env.AI.run(
        "@cf/black-forest-labs/flux-1-schnell",
        {
          prompt: prompt.slice(0, 2048),
          steps: 4
        }
      );

      if (!result?.image) {
        return json({
          error: "No image was generated."
        }, 500, corsHeaders);
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
