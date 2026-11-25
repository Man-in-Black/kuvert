import { config } from './config.js';
import { buildServer } from './server.js';

const { app } = await buildServer();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`${config.appName} läuft auf ${config.publicUrl}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} empfangen – fahre herunter`);
    await app.close().catch(() => undefined);
    process.exit(0);
  });
}
