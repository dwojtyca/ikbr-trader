import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { operatorProxyPlugin } from './server/operator-proxy.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '../..', ''), ...process.env };
  const host = env.UI_HOST ?? '127.0.0.1';
  const port = Number(env.UI_PORT ?? 5173);
  return {
    plugins: [operatorProxyPlugin(env), react()],
    server: { host, port, strictPort: true, hmr: false, cors: false },
    preview: { host, port, strictPort: true, cors: false },
  };
});
