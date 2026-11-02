---
id: quality-gates-on-changed-code
title: 改动的代码要过复杂度、重复与变异门禁
layer: org
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@chovizzz'
created: 2026-11-01
review_by: 2027-02-01
evidence:
  - type: memory
    ref: 'sha256:dd53c1e887fe79f79e5d927686298c2002331f53fc925c2dfbd39b3bc2af9cd1'
    excerpt: substrate 试跑:全仓 5967 个函数中 1175 个复杂度不低于 10、1197 对疑似重复,全量设门槛不可行,只能卡改动部分
verifier:
  type: replay
  ref: cases/quality-gates-on-changed-code/
---

**做**:项目能运行 crapper、dryer、mutator 时,只对本次改动涉及的文件运行(范围为空不算通过):CRAP 不低于 10 的函数拆分或补测试,结构相似度不低于 0.8 的重复要消除,存活的变异体补测试杀掉;不修的写明理由。工具不可用就写「未运行」,不阻塞。
**为什么**:评审看不出数字上的退化,确定性工具对每次改动用同一把尺子。
**怎么验**:回放用例:汇报里有三个工具的结果或「未运行」说明,超线项都有处理或理由。
