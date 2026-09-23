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
           * IMPORTANT:
           * hf-inference does NOT support this text-to-video model.
           * Hugging Face currently exposes Wan2.1-T2V-1.3B through fal-ai.
           *
           * Provider-specific model:
           * fal-ai/wan/v2.1/1.3b/text-to-video
           *
           * The queue subdomain is used because video generation is asynchronous.
           */
          const submitUrl =
            "https://router.huggingface.co/fal-ai/fal-ai/wan/v2.1/1.3b/text-to-video?_subdomain=queue";

          const submitResponse = await fetch(submitUrl, {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.HF_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              prompt: safePrompt
            })
          });

          const submitText = await submitResponse.text();

          if (!submitResponse.ok) {
            console.error(
              "HF/Fal submit error:",
              submitResponse.status,
              submitText
            );

            return json({
              error: "Hugging Face video submission failed.",
              status: submitResponse.status,
              detail: submitText.slice(0, 4000)
            }, 502, corsHeaders);
          }

          let job;
          try {
            job = JSON.parse(submitText);
          } catch {
            return json({
              error: "Hugging Face returned an invalid queue response.",
              detail: submitText.slice(0, 4000)
            }, 502, corsHeaders);
          }

          console.log("PromptPix HF/Fal queue response:", job);

          const requestId = job.request_id || job.requestId;
          const statusUrl = job.status_url || job.statusUrl;
          const responseUrl = job.response_url || job.responseUrl;

          if (!requestId || !statusUrl || !responseUrl) {
            return json({
              error: "Hugging Face returned no usable video queue URLs.",
              detail: JSON.stringify(job).slice(0, 4000)
            }, 502, corsHeaders);
          }

          /*
           * Poll the provider queue. Cloudflare Workers allow the request
           * to remain open while the provider is processing the video.
           */
          const maxPolls = 60;
          let finalResponse = null;

          for (let i = 0; i < maxPolls; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const statusResponse = await fetch(statusUrl, {
              method: "GET",
              headers: {
                "Authorization": "Bearer " + env.HF_TOKEN
              }
            });

            const statusText = await statusResponse.text();

            if (!statusResponse.ok) {
              console.error(
                "HF/Fal status error:",
                statusResponse.status,
                statusText
              );

              return json({
                error: "Hugging Face video status check failed.",
                status: statusResponse.status,
                detail: statusText.slice(0, 4000)
              }, 502, corsHeaders);
            }

            let statusData;
            try {
              statusData = JSON.parse(statusText);
            } catch {
              return json({
                error: "Invalid Hugging Face status response.",
                detail: statusText.slice(0, 4000)
              }, 502, corsHeaders);
            }

            console.log(
              "PromptPix HF/Fal status:",
              statusData.status || statusData
            );

            if (
              statusData.status === "COMPLETED" ||
              statusData.status === "completed" ||
              statusData.status === "succeeded"
            ) {
              finalResponse = await fetch(responseUrl, {
                method: "GET",
                headers: {
                  "Authorization": "Bearer " + env.HF_TOKEN
                }
              });
              break;
            }

            if (
              statusData.status === "FAILED" ||
              statusData.status === "failed" ||
              statusData.status === "CANCELLED" ||
              statusData.status === "cancelled"
            ) {
              return json({
                error: "Hugging Face/Fal video generation failed.",
                detail: JSON.stringify(statusData).slice(0, 4000)
              }, 502, corsHeaders);
            }
          }

          if (!finalResponse) {
            return json({
              error: "Video generation timed out while waiting for Hugging Face/Fal.",
              requestId
            }, 504, corsHeaders);
          }

          if (!finalResponse.ok) {
            const detail = await finalResponse.text();

            return json({
              error: "Hugging Face/Fal video result failed.",
              status: finalResponse.status,
              detail: detail.slice(0, 4000)
            }, 502, corsHeaders);
          }

          const contentType =
            finalResponse.headers.get("content-type") || "";

          let videoBytes;

          if (contentType.includes("video/")) {
            videoBytes = await finalResponse.arrayBuffer();
          } else {
            const resultText = await finalResponse.text();

            let resultData;
            try {
              resultData = JSON.parse(resultText);
            } catch {
              return json({
                error: "Hugging Face returned an unexpected video result.",
                detail: resultText.slice(0, 4000)
              }, 502, corsHeaders);
            }

            /*
             * Some provider responses return a video URL rather than raw MP4.
             * Follow common URL fields before falling back to a nested video URL.
             */
            const providerVideoUrl =
              resultData.video_url ||
              resultData.videoUrl ||
              resultData.url ||
              resultData.video?.url ||
              resultData.data?.video_url ||
              resultData.data?.videoUrl ||
              resultData.data?.url;

            if (!providerVideoUrl) {
              return json({
                error: "Hugging Face returned no video URL.",
                detail: JSON.stringify(resultData).slice(0, 4000)
              }, 502, corsHeaders);
            }

            const providerVideoResponse = await fetch(providerVideoUrl);

            if (!providerVideoResponse.ok) {
              const detail = await providerVideoResponse.text();

              return json({
                error: "Could not download generated video from provider.",
                status: providerVideoResponse.status,
                detail: detail.slice(0, 4000)
              }, 502, corsHeaders);
            }

            videoBytes = await providerVideoResponse.arrayBuffer();
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
