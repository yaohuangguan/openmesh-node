import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        home: resolve(root, 'index.html'),
        docs: resolve(root, 'docs/index.html'),
        guides: resolve(root, 'guides/index.html'),
        serviceRuntime: resolve(root, 'guides/nodejs-service-runtime/index.html'),
        appMesh: resolve(root, 'guides/application-native-service-mesh/index.html'),
        serviceDiscovery: resolve(root, 'guides/service-discovery/index.html'),
        peerRouting: resolve(root, 'guides/peer-routing/index.html'),
        workloadIdentity: resolve(root, 'guides/workload-identity-mtls/index.html')
      }
    }
  }
});
