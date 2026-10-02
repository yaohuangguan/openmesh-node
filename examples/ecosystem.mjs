import openmesh from '../index.mjs';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';

const app = openmesh();
app.useExpress(helmet());
app.useExpress(cors({ origin: 'https://example.com' }));
app.get('/', () => ({ framework: 'OpenMesh', routes: ['/express/hello', '/fastify/hello'] }));

const legacy = express();
legacy.get('/hello', (req, res) => res.json({ engine: 'express' }));
app.mount('/express', legacy);

// Plugins execute inside an actual Fastify instance, preserving its hooks/schema API.
app.fastify('/fastify', async host => {
  await host.register(fastifyCors, { origin: 'https://example.com' });
  await host.register(fastifyHelmet);
  host.get('/hello', { schema: { response: { 200: { type: 'object', properties: { engine: { type: 'string' } } } } } },
    async () => ({ engine: 'fastify' }));
});
const address = await app.listen({ port: Number(process.env.PORT || 3000) });
console.log(`Ecosystem example: http://127.0.0.1:${address.port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().catch(console.error));
