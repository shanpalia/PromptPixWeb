const {onCall,HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getStorage} = require("firebase-admin/storage");
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
        model: "gpt-image-2",
        prompt,
        size: "1024x1024",
        quality: "auto",
        output_format: "png"
      });

      const b64 = result?.data?.[0]?.b64_json;
      if (!b64) throw new Error("The image provider returned no image.");

      const bucket = getStorage().bucket();
      const filePath = "promptpix/generated/" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".png";
      const file = bucket.file(filePath);
      await file.save(Buffer.from(b64, "base64"), {
        metadata: {contentType: "image/png", cacheControl: "public,max-age=31536000"}
      });

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "03-01-2500"
      });

      return {imageUrl: url, path: filePath};
    } catch (error) {
      console.error("PromptPix image generation failed:", error);
      throw new HttpsError("internal", error?.message || "Image generation failed.");
    }
  }
);