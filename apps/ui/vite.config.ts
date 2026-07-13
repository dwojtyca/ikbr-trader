import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.UI_HOST ?? '127.0.0.1';
const port = Number(process.env.UI_PORT ?? 5173);
const ingestionProxyTarget = process.env.UI_INGESTION_PROXY_TARGET ?? 'http://127.0.0.1:3101';
const signalProxyTarget = process.env.UI_SIGNAL_PROXY_TARGET ?? 'http://127.0.0.1:3102';
const executionProxyTarget = process.env.UI_EXECUTION_PROXY_TARGET ?? 'http://127.0.0.1:3103';
const backtestProxyTarget = process.env.UI_BACKTEST_PROXY_TARGET ?? 'http://127.0.0.1:3104';

// Phase 1 / PR2: the UI dev server (and the built server in the docker
// image) injects the shared EXECUTION_API_TOKEN as a Bearer header on
// every /api/execution/* request. The token is read from process.env
// server-side only — Vite never inlines it into the client bundle
// because it is NOT prefixed with VITE_. The browser continues to make
// same-origin requests to /api/execution with no credentials.
const executionApiToken = process.env.EXECUTION_API_TOKEN ?? '';
if (!executionApiToken) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ui vite.config] EXECUTION_API_TOKEN is empty; ' +
      'proxied /api/execution/* requests will be rejected by the execution-engine (401).'
  );
}

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    proxy: {
      '/api/ingestion': {
        target: ingestionProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ingestion/, '')
      },
      '/api/signal': {
        target: signalProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/signal/, '')
      },
      '/api/execution': {
        target: executionProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/execution/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (executionApiToken) {
              proxyReq.setHeader('authorization', `Bearer ${executionApiToken}`);
            }
          });
        }
      },
      '/api/backtest': {
        target: backtestProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/backtest/, '')
      }
    }
  }
});
