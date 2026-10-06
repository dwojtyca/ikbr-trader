import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getExecutionAuthContext } from './auth.js';
import type { PaperPolicyAuthority } from './paper-policy-authority.js';
export function registerPaperPolicyControl(app: FastifyInstance, deps: { authority: PaperPolicyAuthority; account(): string }) {
  const common = { requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(240) };
  app.get('/execution/paper-policy', async () => deps.authority.read(deps.account()));
  for (const action of ['schedule', 'cancel', 'adopt'] as const) {
    const schema = action === 'schedule' ? z.object({ ...common, priorManifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() : z.object(common).strict();
    app.post(`/execution/paper-policy/${action}`, async (request, reply) => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_paper_policy_request' });
      return deps.authority.change(deps.account(), action.toUpperCase() as 'SCHEDULE' | 'CANCEL' | 'ADOPT', parsed.data,
        `operator:${getExecutionAuthContext(request)?.tokenFingerprint ?? 'unknown'}`);
    });
  }
}
