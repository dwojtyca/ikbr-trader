import { databaseNameFromUrl, RESEARCH_DATABASE_NAME } from "./research-dataset-schema.js";
import type { FastifyInstance } from "fastify";

export const PROTECTED_RESEARCH_ROUTES = [
  "/backtest/history",
  "/backtest/history/symbols",
  "/backtest/history/resume",
  "/backtest/run",
] as const;

export function protectedResearchRouteRejection(
  connectionString: string,
  route: string,
): { error: string; message: string } | null {
  if (databaseNameFromUrl(connectionString) !== RESEARCH_DATABASE_NAME) return null;
  if (!(PROTECTED_RESEARCH_ROUTES as readonly string[]).includes(route)) return null;
  return {
    error: "research_dataset_immutable",
    message: "Mutable history and run routes are disabled for the PR15.5C research database.",
  };
}

export function installProtectedResearchRouteGuard(
  app: FastifyInstance,
  connectionString: string,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?", 1)[0];
    const rejection = protectedResearchRouteRejection(connectionString, path);
    if (rejection) return reply.code(423).send(rejection);
  });
}
