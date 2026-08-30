/**
 * Vision extraction boundary — cloud LLM parse helpers live in vision_label.ts;
 * local Ollama vision is in llm-enrichment.ts. The orchestrator sequences them.
 */
export { parseVisionLabel, VISION_LABEL_PROMPT, type VisionLabel } from "../vision_label.js";
export { labelProductWithLocalOllama } from "./llm-enrichment.js";
