import { config } from "./config.js";
import { importResearchDataset } from "./research-dataset-importer.js";

const bundleDirectory = process.argv[2];
if (!bundleDirectory) throw new Error("Usage: research:import <bundle-directory>");

const result = await importResearchDataset(
  config.BACKTEST_RESEARCH_POSTGRES_URL,
  config.BACKTEST_POSTGRES_ADMIN_URL,
  bundleDirectory,
  config.futuresCalendars,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
