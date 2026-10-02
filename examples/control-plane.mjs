import openmesh from '../index.mjs';
import { controlPlane } from '../services/index.mjs';
const token = process.env.OPENMESH_TOKEN;
if (!token) throw new Error('Set OPENMESH_TOKEN to at least 16 characters before starting the control plane');
const app = openmesh().register(controlPlane({ token }));
const address = await app.listen({ port: Number(process.env.PORT || 4000), host: process.env.HOST || '127.0.0.1' });
console.log(`Control plane listening on port ${address.port}; API prefix: /_mesh`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().catch(console.error));
