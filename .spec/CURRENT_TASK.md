# Current task

Conversational AI Mixologist — phase 1 only: safe temporary Guest saves for AI-generated cocktails.

## In this phase

- Additive nullable `cocktails.expires_at`. NULL means permanent.
- Keeper AI saves stay permanent. Guest AI saves expire about 24 hours after the server writes them.
- Narrow `POST /api/cocktails/generated` route. Guests cannot set `id`, `collection`, `expires_at`, `bartender_fav`, `image_url`, `source_url`, or update an existing cocktail.
- Existing Keeper cocktail CRUD stays behind `requireAdmin`.
- Cocktail list/read paths exclude expired rows. Opportunistic cleanup deletes expired Guest rows only.
- Generated-recipe UI shows Save cocktail for Guest and Keeper, with “Saved for 24 hours” vs “Saved to cocktails”, plus a restrained temporary label on library/detail cards.

## Not in this phase

- Try another / Retry
- Conversational refinement
- AI chat history
- New LLM providers, React Router, cocktail image-search changes, or unrelated cocktail UI redesigns
