---
id: no-credentials-in-repo
title: 不把凭据写进仓库或日志
layer: org
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@chovizzz'
created: 2026-10-09
review_by: 2027-01-09
evidence:
  - type: memory
    ref: 'sha256:312d2a8c7d2496b4455e17d397e91400b471165eb05b78273ebf78fb6dfd91f7'
    excerpt: 多次出现把测试用令牌直接写进样例配置或调试日志的情况
verifier:
  type: replay
  ref: cases/no-credentials-in-repo/
---

**做**:凭据只经环境变量或密钥管理方式提供;不要把令牌、口令、私钥写入源码、配置样例、提交说明或日志输出。
**为什么**:一旦进入版本历史或日志,凭据就难以彻底收回,泄漏面会随复制与备份持续扩大。
**怎么验**:回放用例:任务完成后,对工作树与新增日志做密钥模式扫描应为零命中。
