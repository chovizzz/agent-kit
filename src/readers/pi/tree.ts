/**
 * Pi v3 会话树与 `branch_count`(docs/reader-counting-spec.md §2.3.4)。
 *
 * 节点 = 非头(`type !== "session"`)且带**字符串** `id` 的行。其余行不是树节点。
 * 活动链 = 从文件里最后一个节点沿 `parentId` 走到根;`branch_count` = 不在活动链上的节点(条目)数。
 *
 * 边界(与口径表一致):
 *  - 断链(`parentId` 指向不存在的 id)或 `parentId` 为 null/非字符串:链在该点终止;
 *  - 重复 id:后出现的条目覆盖先出现的父子关系(不报错),但每个条目各自计数;
 *  - 成环:链上最多取「节点总数 + 1」个 id,等同断链,不会死循环;
 *  - 全程迭代,无递归;内存 = 每个不同 id 一个 Map 项。
 */
export class PiTree {
  /** id → 父 id(后出现者覆盖)与该 id 出现的条目数 */
  private readonly nodes = new Map<string, { parent: string | null; entries: number }>();
  private total = 0;
  private lastId: string | undefined;

  /** 登记一个树节点。`parentId` 不是字符串的一律当作无父(根)。 */
  add(id: string, parentId: unknown): void {
    const parent = typeof parentId === 'string' ? parentId : null;
    const cur = this.nodes.get(id);
    if (cur === undefined) this.nodes.set(id, { parent, entries: 1 });
    else {
      cur.parent = parent;
      cur.entries++;
    }
    this.total++;
    this.lastId = id;
  }

  /** 非活动链条目数;没有任何节点时为 0。 */
  branchCount(): number {
    if (this.lastId === undefined) return 0;
    const limit = this.total + 1;
    const onChain = new Set<string>();
    let cur: string | null = this.lastId;
    for (let steps = 0; cur !== null && steps < limit; steps++) {
      onChain.add(cur);
      // 指向不存在的 id:该 id 已入链(无害),再往上取不到父 → 终止
      cur = this.nodes.get(cur)?.parent ?? null;
    }
    let off = 0;
    for (const [id, n] of this.nodes) if (!onChain.has(id)) off += n.entries;
    return off;
  }
}
