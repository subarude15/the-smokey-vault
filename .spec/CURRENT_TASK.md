# Current task

Conversational AI Mixologist — phase 2 only: Try another from the same request.

## In this phase

- `POST /api/ai/mixologist` accepts `mode: "retry"` with the original prompt and previous recipe. Omitted mode stays generate.
- Retry asks for a materially different cocktail. The shelf summary is rebuilt per request. Required-bottle validation is unchanged.
- MixologistPanel remembers the prompt that produced the current recipe. Later textarea edits do not change what Try another sends.
- A failed retry leaves the previous recipe up. A successful retry replaces it and clears the saved state. Save still uses the phase 1 generated-cocktail route.

## Not in this phase

- Conversational refinement
- AI chat history
- New LLM providers, React Router, cocktail image-search changes, or unrelated cocktail UI redesigns
- Changes to the 24-hour Guest save architecture
