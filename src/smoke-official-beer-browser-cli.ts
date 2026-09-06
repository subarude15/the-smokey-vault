/**
 * Compiled production CLI entry for official beer browser smoke.
 * Invoked via: node dist/smoke-official-beer-browser-cli.js
 */
import { mainSmokeOfficialBeerBrowser } from "./smoke_official_beer_browser.js";

const code = await mainSmokeOfficialBeerBrowser(process.argv.slice(2));
process.exit(code);
