import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const studio = createApp(config);

studio.server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : error);
  process.exit(1);
});
studio.server.listen(config.port, config.host, () => {
  console.log(`Studio API listening on http://${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void studio.close().then(() => process.exit(0));
  });
}
