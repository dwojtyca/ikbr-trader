import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import type { request } from 'node:https';
import { ResearchSourceFailure } from '@ikbr/shared/instrument-research';
import { fetchBoundedResearchUrl } from './research-fetch.js';

async function localFetch(handler: RequestListener, run: (fetch: (ms?: number, maxBytes?: number) => ReturnType<typeof fetchBoundedResearchUrl>) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port:number}).port;
  const transport = ((_url: URL, options: any, callback: any) => httpRequest({ ...options, protocol:'http:', hostname:'127.0.0.1', port, lookup:undefined }, callback)) as typeof request;
  try {
    await run((ms = 1000, maxBytes) => fetchBoundedResearchUrl(new URL('https://api.marketaux.com/news?api_token=synthetic-private'), new Date(Date.now()+ms).toISOString(), 'application/json', {
      resolveAddress: async () => ({address:'8.8.8.8',family:4}), httpsRequest:transport, readJsonError:true, privacy:{secrets:['synthetic-private']},
    }, maxBytes));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function original(error: unknown): ResearchSourceFailure {
  assert.ok(error instanceof ResearchSourceFailure); return error;
}

test('native Node signal timeout preserves AbortError and ABORT_ERR without replay', async () => {
  let calls=0;
  await localFetch(() => { calls++; }, async fetch => {
    await assert.rejects(fetch(150), error => {
      const failure=original(error); assert.equal(failure.message,'RESEARCH_SOURCE_TIMEOUT');
      assert.equal(failure.sourceError.name,'AbortError'); assert.equal(failure.sourceError.code,'ABORT_ERR');
      assert.equal(failure.sourceError.message,'The operation was aborted'); return true;
    });
  });
  assert.equal(calls,1);
});

test('known HTTP 401 survives native abort while collecting error body', async () => {
  await localFetch((_req,res) => {res.writeHead(401, 'Unauthorized', {'content-type':'application/json'}); res.write('{');}, async fetch => {
    await assert.rejects(fetch(150), error => {
      const failure=original(error); assert.equal(failure.message,'RESEARCH_SOURCE_HTTP_401');
      assert.equal(failure.sourceError.httpStatus,401); assert.equal(failure.sourceError.httpStatusMessage,'Unauthorized');
      assert.equal(failure.sourceError.providerMessage,undefined); return true;
    });
  });
});

test('HTTP envelope preserves provider fields and strips secrets, URLs, and controls', async () => {
  await localFetch((_req,res) => {res.writeHead(429,'Too Many Requests',{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'quota_reached',message:'Limit synthetic-private https://x.invalid/?token=synthetic-private\n\u001b[31m'},raw:'NEVER COPY'}));}, async fetch => {
    await assert.rejects(fetch(), error => {
      const failure=original(error), serialized=JSON.stringify(failure);
      assert.equal(failure.sourceError.httpStatus,429); assert.equal(failure.sourceError.providerCode,'quota_reached');
      assert.equal(failure.sourceError.name,null); assert.equal(failure.sourceError.code,null);
      assert.match(failure.sourceError.providerMessage!, /Limit/);
      for(const secret of ['synthetic-private','https://','NEVER COPY']) assert.ok(!serialized.includes(secret));
      assert.ok(!/[\n\u001b]/.test(failure.sourceError.providerMessage!)); return true;
    });
  });
});

test('unsupported, invalid, oversized and truncated error bodies keep status without excerpts', async () => {
  for(const mode of ['html','invalid','oversized','declared','truncated'] as const) {
    await localFetch((_req,res) => {
      res.writeHead(503,'Service Unavailable',{'content-type':mode==='html'?'text/html':'application/json',...(mode==='declared'?{'content-length':'20000'}:{})});
      if(mode==='truncated'){res.write('{');setImmediate(()=>res.destroy());return;}
      res.end(mode==='oversized'?'x'.repeat(17000):mode==='invalid'?'not-json':'private body');
    }, async fetch => {
      await assert.rejects(fetch(), error => {const failure=original(error);assert.equal(failure.message,'RESEARCH_SOURCE_HTTP_503');assert.equal(failure.sourceError.providerMessage,undefined);assert.ok(!JSON.stringify(failure).includes('private body'));return true;});
    });
  }
});

test('DNS deadline, native transient error and synchronous throw retain safe original causes', async () => {
  await assert.rejects(fetchBoundedResearchUrl(new URL('https://api.marketaux.com'),new Date(Date.now()+50).toISOString(),'application/json',{
    resolveAddress:()=>new Promise(()=>{}),
  }), error=>{const failure=original(error);assert.equal(failure.message,'RESEARCH_SOURCE_TIMEOUT');assert.equal(failure.sourceError.name,'AbortError');return true;});
  for(const code of ['ECONNRESET','CERT_HAS_EXPIRED']) {
    await assert.rejects(fetchBoundedResearchUrl(new URL('https://api.marketaux.com'),new Date(Date.now()+1000).toISOString(),'application/json',{
      resolveAddress:async()=>({address:'8.8.8.8',family:4}),privacy:{secrets:['private-value']},
      httpsRequest:(()=>{throw Object.assign(new Error('native private-value'),{code});}) as unknown as typeof request,
    }),error=>{const failure=original(error);assert.equal(failure.message,code==='ECONNRESET'?'RESEARCH_SOURCE_TRANSPORT_TRANSIENT':'RESEARCH_SOURCE_ACQUISITION_FAILED');assert.equal(failure.sourceError.code,code);assert.ok(!JSON.stringify(failure).includes('private-value'));assert.ok(!String(failure.cause).includes('private-value'));return true;});
  }
});

test('successful native response remains bounded and redirects never followed', async () => {
  let calls=0;
  await localFetch((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end('{}');},async fetch=>{assert.equal((await fetch()).payload.toString(),'{}');});
  assert.equal(calls,1);
  await localFetch((_req,res)=>{res.writeHead(302,{'location':'https://127.0.0.1/private'});res.end();},async fetch=>{await assert.rejects(fetch(),/RESEARCH_SOURCE_HTTP_302/);});
  await localFetch((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('too large');},async fetch=>{await assert.rejects(fetch(1000,2),/RESEARCH_SOURCE_TOO_LARGE/);});
});

test('late response end during cancellation cannot publish success', async () => {
  const {EventEmitter}=await import('node:events');let requests=0,destroyed=false;
  const transport=((_url:URL,options:any,callback:any)=>{
    requests++;const req=new EventEmitter() as any;
    req.destroy=()=>{destroyed=true;};req.end=()=>{
      const res=new EventEmitter() as any;res.statusCode=200;res.headers={'content-type':'application/json'};res.destroy=()=>{};
      callback(res);res.emit('data',Buffer.from('{}'));options.signal.addEventListener('abort',()=>res.emit('end'),{once:true});
    };return req;
  }) as typeof request;
  await assert.rejects(fetchBoundedResearchUrl(new URL('https://api.marketaux.com'),new Date(Date.now()+40).toISOString(),'application/json',{resolveAddress:async()=>({address:'8.8.8.8',family:4}),httpsRequest:transport}),/RESEARCH_SOURCE_TIMEOUT/);
  assert.equal(requests,1);assert.equal(destroyed,true);
});

for (const stage of ['dns-monotonic', 'dns-wall', 'request-return', 'before-request', 'before-end', 'shutdown-dns', 'shutdown-request', 'request-close'] as const)
  test(`dispatch guard rejects ${stage} without relying on timer callbacks`, async t => {
    const { EventEmitter } = await import('node:events');
    const wallStart = Date.now(), monoStart = performance.now();
    let wall = wallStart, mono = monoStart, requests = 0, ends = 0, destroyed = 0, checks = 0;
    const shutdown = new AbortController();
    t.mock.method(Date, 'now', () => wall); t.mock.method(performance, 'now', () => mono);
    const transport = ((_url: URL, _options: unknown, _callback: unknown) => {
      requests++;
      if (stage === 'request-return') mono += 10000;
      if (stage === 'shutdown-request') shutdown.abort();
      const req = new EventEmitter() as any;
      req.destroy = () => { destroyed++; };
      req.end = () => { ends++; throw new Error('unexpected end'); };
      if (stage === 'request-close') {
        const on = req.on.bind(req);
        req.on = (event: string, callback: (...args: unknown[]) => void) => { on(event, callback); if (event === 'close') req.emit('close'); return req; };
      }
      return req;
    }) as unknown as typeof request;
    await assert.rejects(fetchBoundedResearchUrl(new URL('https://api.marketaux.com'), new Date(wallStart + 9000).toISOString(), 'application/json', {
      monotonicDeadlineMs: monoStart + 9000,
      dispatchGuard: { signal: shutdown.signal, assertActive: () => {
        checks++;
        if (wall >= wallStart + 9000 || stage === 'before-request' && checks === 3 || stage === 'before-end' && checks === 4)
          throw new Error('RESEARCH_MARKETAUX_DEADLINE_EXPIRED');
      } },
      resolveAddress: async () => {
        if (stage === 'dns-monotonic') mono += 10000;
        if (stage === 'dns-wall') wall += 10000;
        if (stage === 'shutdown-dns') shutdown.abort();
        return { address: '8.8.8.8', family: 4 };
      }, httpsRequest: transport,
    }));
    assert.equal(ends, 0);
    assert.equal(requests, ['request-return', 'before-end', 'shutdown-request', 'request-close'].includes(stage) ? 1 : 0);
    assert.equal(destroyed, requests);
  });
