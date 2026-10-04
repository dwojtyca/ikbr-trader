import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,symlink,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {OperatorClient,operatorOrigin,OperatorRequestError} from './operator-client.js';
import {runOperatorCli,writeDiagnosticExport} from './operator-cli.js';
const now='2026-10-04T10:00:00.000Z';
const query={mode:'status' as const,from:now,to:now,limit:200};
const report={schemaVersion:1,mode:'status',generatedAt:now,interval:{from:now,to:now},coverage:[],events:[],sections:[],counters:[],truncated:false,omissions:[]};
test('normal reports only GET fixed authenticated local origin and never follow redirects',async()=>{
 for(const url of ['https://evil.test:3103','http://127.0.0.1:3103@evil.test/','http://localhost:80','http://localhost:3103/x','http://localhost:3103?x=y']) assert.throws(()=>operatorOrigin(url));
 let method:string|undefined,path='',auth='';
 const client=new OperatorClient({token:'fixture-secret',fetchImpl:(async(url,options)=>{
  path=String(url);method=options?.method;auth=(options?.headers as Record<string,string>).Authorization;
  assert.equal(options?.redirect,'error');return new Response(JSON.stringify(report));
 }) as typeof fetch});
 await client.report(query);assert.equal(method,'GET');assert.ok(path.startsWith('http://127.0.0.1:3103/execution/diagnostics?'));assert.equal(auth,'Bearer fixture-secret');
});
test('controls preserve endpoint shapes and unknown POST is never automatically retried',async()=>{
 const calls:Array<{url:string;body:unknown}>=[];
 const client=new OperatorClient({token:'fixture',fetchImpl:(async(url,options)=>{calls.push({url:String(url),body:JSON.parse(String(options?.body))});return new Response('{}');}) as typeof fetch});
 await client.control({action:'pause',reason:'przerwa'});
 await client.control({action:'close',proposalId:'42',requestId:'a2445000-0010-4000-8000-000000000001',limitPrice:10});
 assert.deepEqual(calls[0].body,{reason:'przerwa'});assert.deepEqual(calls[1].body,{requestId:'a2445000-0010-4000-8000-000000000001',limitPrice:10});
 let attempts=0;
 const unknown=new OperatorClient({token:'fixture',fetchImpl:(async()=>{attempts++;throw Error('secret in response');}) as typeof fetch});
 await assert.rejects(unknown.control({action:'reconcile',proposalId:'42'}),(error:unknown)=>error instanceof OperatorRequestError&&error.mutation&&!error.message.includes('secret'));
 assert.equal(attempts,1);
});
test('oversized response is rejected without publishing body or credentials',async()=>{
 const client=new OperatorClient({token:'fixture',fetchImpl:(async()=>new Response('s'.repeat(3*1024*1024))) as typeof fetch});
 await assert.rejects(client.report(query),/OPERATOR_RESPONSE_TOO_LARGE/);
});
test('export refuses overwrite and symlink and writes private bounded file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pp6-export-'));
 try {const path=join(dir,'diagnostics.txt');await writeDiagnosticExport(path,'anonimowe');assert.equal((await stat(path)).mode&0o777,0o600);
  await assert.rejects(writeDiagnosticExport(path,'overwritten'));assert.equal(await readFile(path,'utf8'),'anonimowe');
  await symlink(path,join(dir,'link'));await assert.rejects(writeDiagnosticExport(join(dir,'link'),'bad'));
  await assert.rejects(writeDiagnosticExport(join(dir,'large'),'x'.repeat(1024*1024+1)),/SIZE_LIMIT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI reads credentials and exports relative to pnpm caller, preserving direct and absolute paths',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pp6-caller-'));
 const credentialFile=join(dir,'fixture.env');
 let reads=0;
 t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
  assert.equal(options.method,'GET');
  assert.equal((options.headers as Record<string,string>).Authorization,'Bearer synthetic-caller-token');
  reads++;return new Response(JSON.stringify({...report,mode:'events'}));
 });
 t.mock.method(process.stdout,'write',()=>true);
 try {
  await writeFile(credentialFile,'EXECUTION_API_TOKEN=synthetic-caller-token\n',{mode:0o600});
  const cases=[
   {env:{INIT_CWD:dir},input:'fixture.env',output:'caller.json'},
   {env:{},input:credentialFile,output:join(dir,'absolute.json')},
   {env:{},input:relative(process.cwd(),credentialFile),output:relative(process.cwd(),join(dir,'direct.json'))},
  ];
  for(const item of cases) {
   await runOperatorCli(['--env-file',item.input,'export','--from',now,'--to',now,'--output',item.output,'--json'],item.env);
  }
  for(const name of ['caller.json','absolute.json','direct.json']) {
   const path=join(dir,name);assert.equal((await stat(path)).mode&0o777,0o600);
   assert.equal(JSON.parse(await readFile(path,'utf8')).mode,'events');
   assert.doesNotMatch(await readFile(path,'utf8'),/synthetic-caller-token/);
  }
  assert.equal(reads,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('documented root pnpm invocation passes env-file to CLI rather than Node, without credentials or HTTP',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const dir=await mkdtemp(join(root,'.pp6-invocation-'));
 const path=join(dir,'fixture.env');
 const env={...process.env};delete env.EXECUTION_API_TOKEN;delete env.PAPER_OPS_BASE_URL;delete env.INIT_CWD;
 try {
  await writeFile(path,'EXECUTION_API_TOKEN=\n',{mode:0o600});
  await assert.rejects(promisify(execFile)('pnpm',['paper:ops','--env-file',relative(root,path),'status'],{cwd:root,env,timeout:15000}),
   (error:unknown)=>{
    assert.match(String((error as {stderr?:string}).stderr),/Nie można wykonać polecenia\. OPERATOR_TOKEN_REQUIRED/);
    return true;
   });
 }finally{await rm(dir,{recursive:true,force:true});}
});
