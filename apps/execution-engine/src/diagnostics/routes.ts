import type { FastifyInstance } from 'fastify';
import { createMutationAuth } from '@ikbr/shared/http-auth';
import { boundDiagnosticReport, parseDiagnosticQuery, sanitizeDiagnosticReport, type DiagnosticPrivacy, type DiagnosticQuery, type DiagnosticReport } from '@ikbr/shared/diagnostics';
export function registerDiagnosticRoutes(app:FastifyInstance,deps:{token:string;read(query:DiagnosticQuery):Promise<DiagnosticReport>;privacy():DiagnosticPrivacy;now?:()=>number}):void {
  app.get('/execution/diagnostics',{preHandler:createMutationAuth(deps.token,['/execution/diagnostics'])},async(request,reply)=>{
    let query:DiagnosticQuery;
    try { query=parseDiagnosticQuery(request.query,deps.now?.()??Date.now()); }
    catch { return reply.code(400).send({error:'DIAGNOSTIC_QUERY_INVALID'}); }
    try {
      const report=await deps.read(query);
      return reply.header('Cache-Control','no-store').send(boundDiagnosticReport(sanitizeDiagnosticReport(report,deps.privacy())));
    } catch { return reply.code(503).send({error:'DIAGNOSTIC_SOURCE_UNAVAILABLE'}); }
  });
}
