# Contributing

```sh
git clone https://github.com/yaohuangguan/openmesh-node.git
cd openmesh-node
npm ci --ignore-scripts
npm test
npm run test:types
npm run demo:cluster
```

Use Node.js 22 or newer. Runtime modules use only Node built-ins. Keep optional integrations outside the native request path. New behavior should have a meaningful regression test; network changes should be exercised through real HTTP sockets where possible.

Before submitting a change to routing or response handling, run `npm run bench` on the same machine before and after. Attach raw reports and the command; compare equivalent workloads. Do not infer production performance from a one-second smoke run.

Open an issue with a runnable reproduction for bugs, or explain the concrete workload for proposals. Useful early contributions: plugin examples, independent benchmark results, discovery adapters, and transport adapters. Never put credentials in examples, issues, or reports.
