import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.UI_HOST ?? '127.0.0.1';
const port = Number(process.env.UI_PORT ?? 5173);
const ingestionProxyTarget = process.env.INGESTION_PROXY_TARGET ?? 'http://127.0.0.1:3101';
const signalProxyTarget = process.env.SIGNAL_PROXY_TARGET ?? 'http://127.0.0.1:3102';
const executionProxyTarget = process.env.EXECUTION_PROXY_TARGET ?? 'http://127.0.0.1:3103';
const backtestProxyTarget = process.env.BACKTEST_PROXY_TARGET ?? 'http://127.0.0.1:3104';

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
        rewrite: (path) => path.replace(/^\/api\/execution/, '')
      },
      '/api/backtest': {
        target: backtestProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/backtest/, '')
      }
    }
  }
});
