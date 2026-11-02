---
id: attack-the-premise
title: 同一前提下两次修复失败就先核对前提
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
    excerpt: 同一前提下的两次修复都过不了同一道检查时,先把前提写成一句话并拆掉,再试下一个修复
verifier:
  type: replay
  ref: cases/attack-the-premise/
---

**做**:两次修复建立在同一个前提上、又在同一道检查上失败时,停下来把这个前提写成一句话并核对它是否成立;推翻或确认之前,不尝试第三个修复。
**为什么**:在错误前提上反复打补丁,每次看起来都合理,实际是在扩大改动、拖长排查。
**怎么验**:回放用例:两次失败之后,轨迹里先出现对前提的一句话陈述与核对,然后才有下一次代码改动。
