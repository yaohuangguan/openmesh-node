'use strict';
const { OpenMesh, Context, HttpError, definePlugin } = require('./lib/app.cjs');
function openmesh(options) { return new OpenMesh(options); }
module.exports = openmesh;
Object.assign(module.exports, { openmesh, OpenMesh, Context, HttpError, definePlugin });
