var _a, _b, _c, _d, _e, _f;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var host = (_a = process.env.UI_HOST) !== null && _a !== void 0 ? _a : '127.0.0.1';
var port = Number((_b = process.env.UI_PORT) !== null && _b !== void 0 ? _b : 5173);
var ingestionProxyTarget = (_c = process.env.INGESTION_PROXY_TARGET) !== null && _c !== void 0 ? _c : 'http://127.0.0.1:3101';
var signalProxyTarget = (_d = process.env.SIGNAL_PROXY_TARGET) !== null && _d !== void 0 ? _d : 'http://127.0.0.1:3102';
var executionProxyTarget = (_e = process.env.EXECUTION_PROXY_TARGET) !== null && _e !== void 0 ? _e : 'http://127.0.0.1:3103';
var backtestProxyTarget = (_f = process.env.BACKTEST_PROXY_TARGET) !== null && _f !== void 0 ? _f : 'http://127.0.0.1:3104';
export default defineConfig({
    plugins: [react()],
    server: {
        host: host,
        port: port,
        proxy: {
            '/api/ingestion': {
                target: ingestionProxyTarget,
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api\/ingestion/, ''); }
            },
            '/api/signal': {
                target: signalProxyTarget,
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api\/signal/, ''); }
            },
            '/api/execution': {
                target: executionProxyTarget,
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api\/execution/, ''); }
            },
            '/api/backtest': {
                target: backtestProxyTarget,
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api\/backtest/, ''); }
            }
        }
    }
});
