import { createHash, timingSafeEqual } from 'node:crypto';

export function secretsEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(provided, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest());
}

export function bearerAuthorized(header: unknown, token: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer ([^\s,]+)$/i.exec(header);
  return !!match && secretsEqual(match[1], token);
}

export const SIGNAL_MUTATING_READS = ['/signals/outcomes/summary', '/signals/report', '/signals/strategies'] as const;

interface AuthRequest {
  method: string;
  headers: { authorization?: string };
  raw: { rawHeaders: string[] };
  routeOptions: { url?: string };
}
interface AuthReply { code(status: number): { send(body: unknown): unknown } }

export function createMutationAuth(token: string, mutatingReads: readonly string[] = []) {
  return async (request: AuthRequest, reply: AuthReply): Promise<void> => {
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (safe && !mutatingReads.includes(request.routeOptions.url ?? '')) return;
    const headerCount = request.raw.rawHeaders.filter((_, index, headers) =>
      index % 2 === 0 && headers[index].toLowerCase() === 'authorization').length;
    if (headerCount !== 1 || !bearerAuthorized(request.headers.authorization, token)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export function operatorSafeLogger(level: string) {
  return {
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["proxy-authorization"]'],
    serializers: {
      req(request: { method?: string; routeOptions?: { url?: string } }) {
        return { method: request.method, route: request.routeOptions?.url ?? 'unmatched' };
      },
      err(error: { name?: string; code?: string; statusCode?: number }) {
        return { type: error.name ?? 'Error', message: 'request or service error', stack: '', code: error.code, statusCode: error.statusCode };
      },
    },
  };
}

export function logSafeResponse(
  request: { method: string; routeOptions: { url?: string }; log: { info: (fields: unknown, message: string) => void } },
  reply: { statusCode: number },
  done: () => void,
): void {
  request.log.info({ method: request.method, route: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode }, 'request completed');
  done();
}
