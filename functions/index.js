const {onCall,HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const OpenAI = require("openai");

initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_EMAIL = "shanpalia786@gmail.com";

exports.generatePromptPixImage = onCall(
  {secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: "1GiB"},
  async (request) => {
    const user = request.auth;
    if (!user || user.token.email !== ADMIN_EMAIL || user.token.email_verified !== true) {
      throw new HttpsError("permission-denied", "Only the PromptPix administrator can generate images.");
    }

    const prompt = String(request.data?.prompt || "").trim();
    if (!prompt) throw new HttpsError("invalid-argument", "A prompt is required.");
    if (prompt.length > 10000) throw new HttpsError("invalid-argument", "Prompt is too long.");

    try {
      const client = new OpenAI({apiKey: OPENAI_API_KEY.value()});
      const result = await client.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024"
      });

      const b64 = result?.data?.[0]?.b64_json;
      if (!b64) throw new Error("The image provider returned no image.");

      return {imageBase64: b64, mimeType: "image/png"};
    } catch (error) {
      console.error("PromptPix image generation failed:", error);
      throw new HttpsError("internal", error?.message || "Image generation failed.");
    }
  }
);
