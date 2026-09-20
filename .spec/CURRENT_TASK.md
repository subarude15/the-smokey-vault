# Current task

Conversational AI Mixologist — phase 3 only: revise the cocktail currently on screen.

## In this phase

- `POST /api/ai/mixologist` accepts `mode: "refine"` with the original prompt, the current recipe, and one refinement. Generate and retry stay as they are.
- The original prompt is not replaced by the follow-up. Try another still uses that prompt and the latest visible recipe.
- A failed refinement leaves the recipe and the typed change in place. A successful one replaces the recipe, clears the saved label, and clears the box.
- Save, Try another, Create, and Update drink share one busy lock.

## Not in this phase

- Persistent AI chat history, accounts, or a chat transcript
- New LLM providers, React Router, cocktail image-search changes, or an unrelated Mixologist redesign
- Changes to the 24-hour Guest save architecture
- Automatic edits of a cocktail that was already saved
