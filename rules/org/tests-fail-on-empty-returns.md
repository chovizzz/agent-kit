---
id: tests-fail-on-empty-returns
title: 函数全返回空也能通过的测试要删或重写
layer: org
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@chovizzz'
created: 2026-11-01
review_by: 2027-02-01
evidence:
  - type: external
    ref: 'sha256:4120873db2e3681ea9b7de4d7105fc9d3406657c9ada91ce77b9b3c4962f3202'
    excerpt: 如果所有函数都什么也不返回时测试仍能通过,就删掉这个测试
verifier:
  type: replay
  ref: cases/tests-fail-on-empty-returns/
---

**做**:测试按调用方的方式调用代码,并断言调用方能看到的结果。把被测函数都换成什么也不返回之后测试仍能通过,就删掉或重写它。
**为什么**:这类测试只证明代码能跑,不证明结果对,会让覆盖率与「测试通过」失去意义。
**怎么验**:回放用例:把 fixture 的被测函数换成空实现后运行新增测试,测试必须失败。
