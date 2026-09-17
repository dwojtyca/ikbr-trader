import { config } from "./config.js";
import { loadResearchActiveContractProjection } from "./research-active-contract-projector.js";
import { loadRegisteredResearchDataset } from "./research-dataset-loader.js";
import {
  REGISTERED_ES_V2_PROJECTION,
} from "./research-v2-run-request.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_PROVENANCE_ID,
} from "./research-run-request.js";

const identity = await loadRegisteredResearchDataset(
  config.BACKTEST_RESEARCH_POSTGRES_URL,
  {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  },
);
const projection = await loadResearchActiveContractProjection(
  config.BACKTEST_RESEARCH_POSTGRES_URL,
  identity,
  REGISTERED_ES_V2_PROJECTION,
);
process.stdout.write(`${JSON.stringify(projection.evidence, null, 2)}\n`);
