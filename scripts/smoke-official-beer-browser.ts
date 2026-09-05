#!/usr/bin/env node
/**
 * CLI entry: read-only official brewery browser / discovery smoke.
 * See docs/official-brewery-beer-browser-task.md
 */
import { mainSmokeOfficialBeerBrowser } from "../src/smoke_official_beer_browser.js";

const code = await mainSmokeOfficialBeerBrowser(process.argv.slice(2));
process.exit(code);
