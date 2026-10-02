# 推广素材与发布路线

## 项目介绍

**中文短介绍**

OpenMesh 是一个面向微服务和 HTTP 节点网络的 Node.js 框架。核心零运行时依赖，使用洋葱中间件，可接入真实 Express/Fastify 生态；独立节点客户端支持稳定键路由、超时、故障切换和熔断。仓库包含三节点故障演示和可复现压测。

**English introduction**

OpenMesh is a small Node.js HTTP framework for connected services. It combines a zero-dependency native core, onion middleware, real Express/Fastify bridges, and an optional peer client with keyed routing, deadlines, failover, and circuit breakers. Try the three-node failure demo and reproduce the checked-in benchmarks.

GitHub: https://github.com/yaohuangguan/openmesh-node

## 适合展示的演示

1. `npm run demo:cluster`：先显示服务来自哪个节点，停止该节点，再显示自动切换结果。
2. `npm run example:ecosystem`：同一个入口下运行原生、Express、Fastify 路由。
3. 分享完整性能表和运行命令，说明机器、软件版本和场景限制。

## 发布顺序

1. **验证需求**：寻找正在写 Node 微服务、想保留既有插件的开发者，请他们复现示例，收集安装失败和 API 困惑。
2. **小范围发布**：由维护者在自己的 GitHub、中文 Node 社区、掘金/V2EX 或相关开发者论坛分享一次演示。遵守各社区发布规则，按实际反馈修正入口文档。
3. **扩展证据**：收集 Linux、独立负载机、真实业务 payload 的性能数据，以及三个有实际使用者的插件/发现适配器。
4. **稳定后发 npm**：确定包名与维护策略，修复反馈，建立版本发布说明，再发布包和兼容性矩阵。

优先观察实际复现示例的人数、有效问题、重复使用和外部贡献，随后观察 stars。推广效果需要真实用户反馈验证；本仓库中的介绍文案和压测不保证推广成功。当前尚未向外部社区自动发布宣传，也未发布 npm 包。
