---
id: keep-changes-minimal
title: 变更只改任务必需的部分
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
    ref: 'sha256:0b32015d12ff5746bea50b53f2f3ac499078a3644c518d8192a6673cefdf15ef'
    excerpt: 多次出现为修一处问题而整体重写文件、引入大量无关 diff 的情况
verifier:
  type: replay
  ref: cases/keep-changes-minimal/
---

**做**:只修改完成当前任务所必需的代码;发现无关的旧问题时记录在汇报里,不顺手改动。
**为什么**:无关改动会扩大评审范围、掩盖真实变更,并增加回退与冲突的成本。
**怎么验**:回放用例:任务完成后,工作树 diff 只涉及任务指定的文件,且没有无关的格式化改动。
