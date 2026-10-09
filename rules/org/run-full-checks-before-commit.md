---
id: run-full-checks-before-commit
title: 提交前自己跑全量检查
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
    ref: 'sha256:b4dc1211bcadcf7ae7716e966537254f943c6b5507f44a6c15217e9fa47843e4'
    excerpt: 多次出现只跑局部测试就宣告完成、随后全量检查才发现牵连失败的情况
verifier:
  type: replay
  ref: cases/run-full-checks-before-commit/
---

**做**:提交或汇报完成之前,自己跑一遍项目的全量检查(类型检查、测试、静态检查、格式检查),并读退出码与失败摘要;不要只看输出末尾几行。
**为什么**:只跑改动相关的子集或只看末尾输出,容易漏掉被牵连的失败,"看起来绿"并不等于通过。
**怎么验**:回放用例:任务完成时的轨迹里应出现全量检查命令及其退出码,且汇报引用了该退出码。
