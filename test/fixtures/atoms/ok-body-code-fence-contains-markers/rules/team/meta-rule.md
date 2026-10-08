---
id: meta-rule
title: 示例规则
layer: team
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@owner-handle'
created: 2026-10-08
review_by: 2027-01-08
evidence:
  - type: memory
    ref: 'sha256:0000000000000000000000000000000000000000000000000000000000000001'
    excerpt: 合成的证据摘录
verifier:
  type: replay
  ref: cases/x/
---

**做**:原子正文按下面的模板写:

```markdown
**做**:示例
**为什么**:示例
**怎么验**:示例
```

**为什么**:模板固定才能被机械检查。
**怎么验**:lint 通过。
