import { writeFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseQualification, privateFile, verifyQualificationArtifacts } from "./config.js";
import { accountingError } from "./types.js";

export async function accountingCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...options] = normalizedArgs, values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    if (!options[i]?.startsWith("--") || !options[i + 1] || values.has(options[i])) throw accountingError("CLI_ARGUMENT_INVALID");
    values.set(options[i], options[i + 1]);
  }
  const expected: Record<string, string[]> = { status: [], inspect: ["--out"], qualify: ["--input", "--evidence-dir"], invalidate: ["--reason"] };
  if (!expected[command] || values.size !== expected[command].length || expected[command].some(key => !values.has(key))) throw accountingError("CLI_ARGUMENT_INVALID");
  const token = env.EXECUTION_API_TOKEN;
  if (!token || token.length < 32) throw accountingError("CLI_AUTH_REQUIRED");
  const base = new URL(env.EXECUTION_ACCOUNTING_API_URL ?? "http://127.0.0.1:3103");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || base.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw accountingError("CLI_ENDPOINT_INVALID");
  let body: unknown;
  if (command === "qualify") {
    body = parseQualification(JSON.parse(privateFile(resolve(values.get("--input")!), 32_768).toString("utf8")), Date.now());
    verifyQualificationArtifacts(body as ReturnType<typeof parseQualification>, resolve(values.get("--evidence-dir")!));
  }
  if (command === "invalidate") body = { reason: values.get("--reason") };
  const response = await fetch(new URL(`/execution/accounting/source/${command}`, base), { method: command === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw accountingError(`CLI_HTTP_${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  if (command === "inspect") {
    const path = values.get("--out")!, parent = dirname(path), st = lstatSync(parent);
    if (!isAbsolute(path) || st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o777) !== 0o700 || realpathSync(parent) !== resolve(parent)) throw accountingError("PRIVATE_FILE_INVALID");
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return { inspectionId: result.id, sourceGeneration: result.connectionGeneration, corroboration: result.corroboration, brokerReadOnly: true };
  }
  return { ...result, brokerReadOnly: true, tradingAuthorizationChanged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  accountingCommand(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + "\n")).catch(error => {
    process.stderr.write(error instanceof Error && /^ACCOUNTING_[A-Z_0-9]+$/.test(error.message) ? `${error.message}\n` : "ACCOUNTING_CLI_FAILED\n");
    process.exitCode = 1;
  });
}
