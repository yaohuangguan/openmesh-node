import openmesh = require('openmesh-node');
import plugins = require('openmesh-node/plugins');
import mesh = require('openmesh-node/mesh');
const app = openmesh();
app.use(plugins.jsonBody());
app.get('/', (ctx: openmesh.Context) => ({ method: ctx.method }));
const pool = new mesh.PeerPool();
pool.close();
