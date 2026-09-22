# PromptPix

Real-data-only Firebase-ready website for PromptPix by PaliaAPK HUB.

## Important
This version contains **no hard-coded demo prompts, emoji images, fake cards, or demo login**. Until Firebase is connected and published documents exist, the homepage intentionally shows an empty/setup state.

## Firebase setup
1. Create a Firebase project.
2. Enable Authentication → Email/Password.
3. Create Firestore Database.
4. Replace the `firebaseConfig` values in `index.html` with your real Firebase Web App configuration.
5. Create a `prompts` collection. Each published document should contain:
   - `title` string
   - `category` string
   - `prompt` string
   - `imageUrl` string (real Firebase Storage download URL or another real image URL)
   - `published` boolean (`true`)
   - `createdAt` timestamp
   - `createdBy` string

## Hidden admin entry
Tap/click the **PromptPix title exactly 5 times quickly**. This opens Firebase Login. Firebase Authentication is still required; the 5 taps are only a hidden entry point.

## Real AI generation
The browser must not contain an AI provider secret key. The production flow should be:
`Admin prompt → secure Cloud Function/server → AI image provider → Firebase Storage → Firestore → Publish → Homepage`

The current admin panel can publish a real generated image URL into Firestore. The secure AI generation endpoint should be connected next.
