import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OperatorClient,operatorOrigin,OperatorRequestError} from './operator-client.js';
import {writeDiagnosticExport} from './operator-cli.js';
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
