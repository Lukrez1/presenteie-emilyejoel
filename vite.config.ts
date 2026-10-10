import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento, serve as funções de /api (que no Vercel viram serverless) pelo próprio Vite.
function localApi(): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      // O Vite reinicia no mesmo processo quando o .env muda: remove o que carregamos antes para não sobrar valor velho
      const g = globalThis as { __localApiEnvKeys?: string[] };
      for (const key of g.__localApiEnvKeys || []) delete process.env[key];
      const fileEnv = loadEnv(server.config.mode, process.cwd(), '');
      const loaded = Object.keys(fileEnv).filter(k => !(k in process.env));
      for (const key of loaded) process.env[key] = fileEnv[key];
      g.__localApiEnvKeys = loaded;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.includes('_lib')) return next();
        try {
          const mod = await server.ssrLoadModule(`/api${url.pathname.slice(4)}.js`);
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const vreq = Object.assign(req, {
            query: Object.fromEntries(url.searchParams),
            body: raw ? JSON.parse(raw) : undefined,
          });
          const vres = Object.assign(res, {
            status(code: number) { res.statusCode = code; return vres; },
            json(obj: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
          });
          await mod.default(vreq, vres);
        } catch (err) {
          console.error(err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Erro interno' }));
        }
      });
    },
  };
}

export default defineConfig({ plugins: [react(), localApi()] });
