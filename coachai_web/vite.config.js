
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    return {
      root: '.',
      base: './',
      build: { outDir: 'dist', emptyOutDir: true }
    };
  }

  const env = loadEnv(mode, process.cwd(), 'COACHAI_');

  const apiUrl = env.COACHAI_DEV_API_URL;
  const token = env.COACHAI_DEV_TOKEN;

  if (!apiUrl || !token) {
    throw new Error(
      'Configura COACHAI_DEV_API_URL e COACHAI_DEV_TOKEN in .env.local'
    );
  }

  const target = new URL(apiUrl);

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('COACHAI_DEV_API_URL deve usare HTTP o HTTPS');
  }

  return {
    root: '.',
    base: './',

    build: {
      outDir: 'dist',
      emptyOutDir: true
    },

    server: {
      host: '127.0.0.1',

      proxy: {
        '/api': {
          target: target.origin,
          changeOrigin: true,

          configure(proxy) {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader(
                'Authorization',
                `Bearer ${token}`
              );
            });
          }
        }
      }
    },

    plugins: [
      {
        name: 'coachai-dev-readonly',

        configureServer(server) {
          server.middlewares.use('/api', (req, res, next) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              return next();
            }

            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Scrittura disabilitata in sviluppo'
            }));
          });
        }
      }
    ]
  };
});
