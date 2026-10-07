import assert from "node:assert/strict";
import { chmodSync, realpathSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeTradingConfigurationHash, parseTradingConfiguration } from "@ikbr/shared/trading-config";
import { readFileSync } from "node:fs";
import { retainedRecoveryCommand } from "./retained-state-recovery-cli.js";
const env={IBKR_ENVIRONMENT:"paper",TRADING_ENABLED:"false",EXECUTION_ENTRIES_PAUSED:"true",TRADING_LOOP_ENABLED:"false",LLM_AGENT_ENABLED:"false",POSTGRES_URL:"postgresql://unused"};
const never=()=>{throw Error("database must not be opened");};
test("recovery CLI refuses switch ambiguity, unsafe output and symlink evidence before database access",async()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),"retained-cli-")));chmodSync(dir,0o700);
  try{
    const out=join(dir,"out.json"),proof=join(dir,"proof.json");writeFileSync(proof,"{}",{mode:0o600});
    for(const change of [{TRADING_ENABLED:"true"},{IBKR_ENVIRONMENT:"live"},{EXECUTION_ENTRIES_PAUSED:"false"},{TRADING_LOOP_ENABLED:undefined},{LLM_AGENT_ENABLED:undefined}])
      await assert.rejects(()=>retainedRecoveryCommand(["inspect","--legacy-evidence",proof,"--out",out],{...env,...change},never),/DISABLED_PAPER_REQUIRED/);
    chmodSync(dir,0o755);await assert.rejects(()=>retainedRecoveryCommand(["inspect","--legacy-evidence",proof,"--out",out],env,never),/PRIVATE_FILE_INVALID/);chmodSync(dir,0o700);
    const config=join(dir,"config.json");copyFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),config);chmodSync(config,0o600);
    const parsed=parseTradingConfiguration(readFileSync(config,"utf8"));if(!parsed.ok)throw Error("fixture");
    const configEnv={...env,TRADING_CONFIG_MODE:"bundle",TRADING_CONFIG_PATH:config,TRADING_CONFIG_EXPECTED_HASH:computeTradingConfigurationHash(parsed.configuration)};
    const review=join(dir,"review.json");
    for(const value of [null,false,0,"",[],{}]){
      writeFileSync(review,JSON.stringify(value),{mode:0o600});
      await assert.rejects(()=>retainedRecoveryCommand(["recover","--legacy-evidence",proof,"--inspection",review,"--out",out],configEnv,never),/INSPECTION_REQUIRED/);
    }
    const link=join(dir,"link.json");symlinkSync(config,link);
    await assert.rejects(()=>retainedRecoveryCommand(["inspect","--legacy-evidence",proof,"--out",out],{...env,TRADING_CONFIG_MODE:"bundle",TRADING_CONFIG_PATH:link,TRADING_CONFIG_EXPECTED_HASH:"a".repeat(64)},never),/CONFIG_FILE_UNAVAILABLE/);
    writeFileSync(out,"preserve",{mode:0o600});await assert.rejects(()=>retainedRecoveryCommand(["inspect","--legacy-evidence",proof,"--out",out],env,never),/OUTPUT_EXISTS/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
