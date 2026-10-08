---
id: negative-assertion-needs-positive-control
title: 负向断言旁边必须钉一个正向前提
layer: team
strength: should
applies_to: [all]
paths: ['**/*.test.*', '**/*.spec.*']
kind: practice
volatility: stable
status: proposed
owner: '@owner-handle'
created: 2026-10-08
review_by: 2027-01-08
evidence:
  - type: memory
    ref: 'sha256:0000000000000000000000000000000000000000000000000000000000000001'
    excerpt: 变异后存量 13 条负向断言全绿,一条不红
verifier:
  type: replay
  ref: cases/negative-assertion-needs-positive-control/
signature:
  type: path
  pattern: '**/*.{test,spec}.*'
escalation_level: 1
origin: proposal/2026-10-08-003
---

**做**:写 `not.toContain` / `toBeUndefined` 一类负向断言时,同一用例里先断言一个必然成立的正向前提。
**为什么**:前提失效时负向断言会静默变空,变异后依然全绿。
**怎么验**:把被测输入改成空集,该用例必须变红。
