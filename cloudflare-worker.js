export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://shanpalia.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

      // =====================================================
      // VIDEO: Hugging Face Inference Provider -> fal-ai
      // =====================================================
      if (type === "video") {
        if (!env.HF_TOKEN) {
          return json({ error: "HF_TOKEN is not configured." }, 500, corsHeaders);
        }
        if (!env.SUPABASE_SERVICE_ROLE_KEY) {
          return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured." }, 500, corsHeaders);
        }
        if (!env.SUPABASE_URL) {
          return json({ error: "SUPABASE_URL is not configured." }, 500, corsHeaders);
        }

        const safePrompt = prompt.slice(0, 2048);
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
          return json({ error: "Unsupported video ratio." }, 400, corsHeaders);
        }

        try {
          /*
           * Hugging Face routes this model to Fal AI.
           * IMPORTANT: use the providerId path directly through the
           * Hugging Face router. Do NOT poll Fal's native status_url
           * with the Hugging Face token; that causes:
           * "bearer: unable to decode issuer".
           *
           * HF's text-to-video API returns the generated video as
           * raw bytes for this task.
           */
          const hfUrl =
            "https://router.huggingface.co/fal-ai/wan/v2.1/1.3b/text-to-video";

          console.log(
            "PromptPix: starting Hugging Face/Fal video generation..."
          );

          const hfResponse = await fetch(hfUrl, {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.HF_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              prompt: safePrompt,
              num_inference_steps: 20,
              aspect_ratio: ratio
            })
          });

          if (!hfResponse.ok) {
            const detail = await hfResponse.text();

            console.error(
              "HF/Fal video error:",
              hfResponse.status,
              detail
            );

            return json({
              error: "Hugging Face/Fal video generation failed.",
              status: hfResponse.status,
              detail: detail.slice(0, 4000)
            }, 502, corsHeaders);
          }

          const contentType =
            hfResponse.headers.get("content-type") || "";

          let videoBytes;

          if (contentType.includes("video/")) {
            videoBytes = await hfResponse.arrayBuffer();
          } else {
            /*
             * Some provider responses can contain a JSON object with
             * a generated video URL. Handle that as a fallback.
             */
            const resultText = await hfResponse.text();

            let resultData;

            try {
              resultData = JSON.parse(resultText);
            } catch {
              return json({
                error: "Hugging Face returned an unexpected video response.",
                detail: resultText.slice(0, 4000)
              }, 502, corsHeaders);
            }

            const providerVideoUrl =
              resultData.video_url ||
              resultData.videoUrl ||
              resultData.url ||
              resultData.video?.url ||
              resultData.output?.video_url ||
              resultData.output?.videoUrl ||
              resultData.output?.url;

            if (!providerVideoUrl) {
              return json({
                error: "Hugging Face returned no video data.",
                detail: JSON.stringify(resultData).slice(0, 4000)
              }, 502, corsHeaders);
            }

            const providerVideoResponse =
              await fetch(providerVideoUrl);

            if (!providerVideoResponse.ok) {
              const detail = await providerVideoResponse.text();

              return json({
                error: "Could not download generated video.",
                status: providerVideoResponse.status,
                detail: detail.slice(0, 4000)
              }, 502, corsHeaders);
            }

            videoBytes =
              await providerVideoResponse.arrayBuffer();
          }

          if (!videoBytes || videoBytes.byteLength === 0) {
            return json({
              error: "Hugging Face returned an empty video."
            }, 502, corsHeaders);
          }

          const supabaseUrl = env.SUPABASE_URL.replace(/\/$/, "");
          const path =
            "videos/" +
            Date.now() +
            "-" +
            crypto.randomUUID() +
            ".mp4";

          const uploadUrl =
            supabaseUrl +
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

            return json({
              error: "Video generated but Supabase Storage upload failed.",
              status: upload.status,
              detail: detail.slice(0, 4000)
            }, 502, corsHeaders);
          }

          const videoUrl =
            supabaseUrl +
            "/storage/v1/object/public/promptpix-images/" +
            path;

          return json({
            success: true,
            type: "video",
            videoUrl,
            duration,
            ratio,
            mimeType: "video/mp4",
            model: "Wan-AI/Wan2.1-T2V-1.3B",
            provider: "fal-ai"
          }, 200, corsHeaders);

        } catch (error) {
          console.error("PromptPix video error:", error);

          return json({
            error: "Hugging Face/Fal video generation failed.",
            detail: error?.message || String(error)
          }, 502, corsHeaders);
        }
      }

      // =====================================================
      // IMAGE GENERATION
      // =====================================================
      const safePrompt = prompt.slice(0, 2048);

      const result = await env.AI.run(
        "@cf/black-forest-labs/flux-1-schnell",
        {
          prompt: safePrompt,
          steps: 4
        }
      );

      if (!result?.image) {
        return json({
          error: "No image was generated."
        }, 500, corsHeaders);
      }

      return json({
        success: true,
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
