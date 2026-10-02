# OpenMesh for Node.js

**Fast HTTP. Small core. Connected nodes.**

[![CI](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml/badge.svg)](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522-green)
![License](https://img.shields.io/badge/license-MIT-blue)

[English](README.en.md) · [API](docs/api.md) · [插件](docs/plugins.md) · [分布式](docs/distributed.md) · [实测性能](docs/performance.md)

一个面向微服务和 HTTP 节点网络的 Node.js 框架：轻量 HTTP 核心、洋葱中间件，以及按需加载的节点客户端。项目与 Openmesh Network 无关联，仓库和包名为 `openmesh-node`。

## 为什么做它

写一个服务很简单，把一组服务连起来还需要处理节点选择、故障切换、超时和追踪。OpenMesh 把这些能力做成独立模块，同时保留简单的服务端 API。

- **核心零运行时依赖**：静态路由快速查找、参数路由、异步处理、流响应、优雅关闭。
- **熟悉的中间件**：`async (ctx, next)`，支持请求前后处理和插件作用域。
- **接入现有生态**：直接使用 Node/Express 中间件、挂载完整 Express 应用；Fastify 插件在真实 Fastify 实例内运行。
- **连接多个节点**：稳定的键路由、有限重试、熔断、总请求期限、并发受控广播，以及服务发现回调。
- **请求可追踪**：请求 ID 和 `traceparent` 传递；ESM、CommonJS 与 TypeScript 声明。

当前版本 **0.1.0，实验阶段**。P2P 能力指已知 HTTP 节点之间的通信；NAT 穿透、DHT、gossip 和共识协议尚未实现。性能目标以可复现的报告衡量。[查看测试条件与结果](docs/performance.md)。

## 30 秒启动

需要 Node.js 22 或更高版本。目前通过 GitHub 安装，尚未发布到 npm。

```sh
npm install github:yaohuangguan/openmesh-node
```

保存为 `server.mjs`：

```js
import openmesh from 'openmesh-node';
import { jsonBody } from 'openmesh-node/plugins';

const app = openmesh();
app.use(jsonBody({ limit: 1024 * 1024 }));
app.get('/', () => ({ hello: 'OpenMesh' }));
app.get('/users/:id', ctx => ({ id: ctx.params.id }));
app.post('/echo', ctx => ctx.requestBody);

await app.listen({ port: 3000 });
console.log('http://127.0.0.1:3000');
process.once('SIGTERM', () => app.close());
process.once('SIGINT', () => app.close());
```

```sh
node server.mjs
curl http://127.0.0.1:3000/users/42
```

CommonJS：`const openmesh = require('openmesh-node');`。默认监听 `127.0.0.1`；容器内可显式传入 `host: '0.0.0.0'`。

## 把服务连起来

```js
import { PeerPool } from 'openmesh-node/mesh';
import { requestContext } from 'openmesh-node/plugins';

const peers = new PeerPool({
  peers: [
    { id: 'users-a', url: 'http://127.0.0.1:4001' },
    { id: 'users-b', url: 'http://127.0.0.1:4002' }
  ],
  timeout: 1500,
  retries: 1
});
app.use(requestContext({ service: 'gateway' }));
app.get('/profile/:id', async ctx => {
  const response = await peers.request(`/users/${encodeURIComponent(ctx.params.id)}`, {
    key: ctx.params.id,
    headers: ctx.state.outboundHeaders
  });
  ctx.status = response.statusCode;
  return response.json();
});
app.onClose(() => peers.close());
```

在 `ready()` / `listen()` 前完成配置。相同键优先选择相同节点；连接失败或 5xx 时，幂等请求可在总期限内切换节点。POST 默认只发送一次。开启非幂等重试需要显式设置和服务端去重。[语义与限制](docs/distributed.md)。

直接体验三节点故障切换：

```sh
git clone https://github.com/yaohuangguan/openmesh-node.git
cd openmesh-node
npm ci --ignore-scripts
npm run demo:cluster
```

示例创建三个独立监听端口和一个网关，调用一次后关闭选中的节点，再验证切换并输出广播结果。`npm run example:cluster` 启动持续运行的版本。

## 保留现有插件

```js
import cors from 'cors';
import express from 'express';

app.useExpress(cors());
const legacy = express();
legacy.get('/hello', (req, res) => res.json({ engine: 'express' }));
app.mount('/legacy', legacy);

app.fastify('/validated', async host => {
  host.get('/hello', async () => ({ engine: 'fastify' }));
});
```

使用 Fastify 桥接时安装 `fastify@5`，Express 示例需安装 `express cors`。Fastify 的 hooks、schema、装饰器和插件封装由真实 Fastify 处理。原生插件使用 OpenMesh API，两套插件接口有各自的作用域。[插件指南](docs/plugins.md)。

## 验证与贡献

```sh
npm test              # 真实 HTTP、Express/Fastify 插件、多节点测试
npm run test:types    # ESM / CommonJS 类型检查
npm run demo:cluster  # 完整故障切换示例
npm run bench         # 四个框架、五个场景、三轮实测
```

欢迎提交插件示例、独立机器的压测结果和服务发现适配器。[贡献指南](CONTRIBUTING.md) · [推广素材与路线](docs/launch.md)。MIT License。
