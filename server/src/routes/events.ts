import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@kuvert/shared';
import type { ModuleContext } from '../core/module.js';

/** Server-Sent Events: Echtzeit-Benachrichtigungen an den Browser. */
export async function eventRoutes(app: FastifyInstance, ctx: ModuleContext) {
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: ServerEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: 'hello', time: new Date().toISOString() });
    const unsubscribe = ctx.bus.subscribe(req.user.id, send);
    const ping = setInterval(() => send({ type: 'ping', time: new Date().toISOString() }), 25_000);
    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
