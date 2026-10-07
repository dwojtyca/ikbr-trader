import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadTradingConfiguration, retainedStateRecovery, type RetainedStateInspection, type RetainedStateRecoveryInput,
  type TradingConfigurationPool } from "@ikbr/shared/trading-config";
import { privateFile } from "./accounting/config.js";

const fail = (reason: string): never => { throw new Error(`RETAINED_RECOVERY_${reason}`); };
export async function retainedRecoveryCommand(args: string[], env: NodeJS.ProcessEnv = process.env,
  createPool: (url: string) => TradingConfigurationPool & { end(): Promise<void> } = url => new Pool({ connectionString: url })): Promise<unknown> {
  const [command, ...options] = args[0] === "--" ? args.slice(1) : args, values = new Map<string,string>();
  for (let i=0;i<options.length;i+=2) {
    if (!options[i]?.startsWith("--") || !options[i+1] || values.has(options[i])) fail("CLI_ARGUMENT_INVALID");
    values.set(options[i],options[i+1]);
  }
  const expected = command === "inspect" ? ["--legacy-evidence","--out"] : command === "recover" ? ["--legacy-evidence","--inspection","--out"] : [];
  if (!expected.length || values.size!==expected.length || expected.some(key=>!values.has(key))) fail("CLI_ARGUMENT_INVALID");
  const path = values.get("--out")!, parent = dirname(path), stat = lstatSync(parent);
  if (!isAbsolute(path) || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777)!==0o700 || realpathSync(parent)!==resolve(parent)) fail("PRIVATE_FILE_INVALID");
  try { lstatSync(path); fail("OUTPUT_EXISTS"); } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  if (env.IBKR_ENVIRONMENT!=="paper" || env.TRADING_ENABLED!=="false" || env.EXECUTION_ENTRIES_PAUSED!=="true" ||
    env.TRADING_LOOP_ENABLED!=="false" || env.LLM_AGENT_ENABLED!=="false") fail("DISABLED_PAPER_REQUIRED");
  if (!env.POSTGRES_URL) fail("DATABASE_REQUIRED");
  const loaded = loadTradingConfiguration(env, { readFile: file => privateFile(file,1024*1024).toString("utf8") });
  const legacyEvidence = JSON.parse(privateFile(values.get("--legacy-evidence")!,2*1024*1024).toString("utf8")) as RetainedStateRecoveryInput["legacyEvidence"];
  const reviewed = command === "recover" ? JSON.parse(privateFile(values.get("--inspection")!,32_768).toString("utf8")) as RetainedStateInspection : undefined;
  if (command === "recover" && (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed) || reviewed.schemaVersion!==1 || reviewed.eligible!==true || !Array.isArray(reviewed.reasons) || reviewed.reasons.length)) fail("INSPECTION_REQUIRED");
  const pool = createPool(env.POSTGRES_URL!);
  try {
    const result = await retainedStateRecovery(pool, { loaded, environment: env.IBKR_ENVIRONMENT!, tradingEnabled:false, entriesPaused:true,
      tradingLoopEnabled:false, aiWorkerEnabled:false, accountId:env.IBKR_ACCOUNT_ID??"",
      allowedPaperAccounts:(env.ALLOWED_PAPER_ACCOUNTS??"").split(",").map(s=>s.trim()).filter(Boolean), legacyEvidence }, reviewed);
    writeFileSync(path,JSON.stringify(result,null,2)+"\n",{mode:0o600,flag:"wx"});
    return result;
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  retainedRecoveryCommand(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+"\n")).catch(error=>{
    process.stderr.write(error instanceof Error && /^RETAINED_RECOVERY_[A-Z_]+$/.test(error.message) ? error.message+"\n" : "RETAINED_RECOVERY_CLI_FAILED\n");
    process.exitCode=1;
  });
}
