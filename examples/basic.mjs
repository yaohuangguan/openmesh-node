import openmesh from '../index.mjs';
import { jsonBody, requestContext, health } from '../plugins/index.mjs';

const app = openmesh();
app.use(requestContext({ service: 'hello-service' }));
app.use(jsonBody());
app.register(health());
app.get('/', () => ({ hello: 'OpenMesh' }));
app.get('/users/:id', ctx => ({ id: ctx.params.id, requestId: ctx.state.requestId }));
app.post('/echo', ctx => ctx.requestBody);

const address = await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1' });
console.log(`OpenMesh listening on http://${address.address}:${address.port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exitCode = 0; });
