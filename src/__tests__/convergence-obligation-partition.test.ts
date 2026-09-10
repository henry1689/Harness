/**
 * P0-A 回归测试 — S4.5 义务/确认簿记 与 内容违规 分流
 * ===================================================
 * 用 2026-09-08 run_mtrksrpx_krvn（chat.ts 9 文件重构 21/20 轮锁死）的真实 S4 blocker 验证：
 *   1. 簿记/确认类（[确认缺失:*]、[文档·强制] 等）全部判为 obligation，不再进入设计标准文本计分；
 *   2. 真实内容违规（[归类·拦截] CLASSIFY_FALSE_SPECIFIC、REVIEW_INVARIANT、FG 红线 UUID 语义）保留在 content。
 */
import { describe, it, expect } from 'vitest';
import { isProcessObligation, partitionReviewViolations } from '../ConvergenceGate.js';

/** 今晚锁死 run 的真实 8 条 S4 reject_reason */
const TONIGHT_BLOCKERS = [
  '[确认缺失:COUPLING_MEETING_NAME_POINTS] [耦合·会晤] 涉及会晤模式相关文件，需确认 _meetingEntityName 传播点以 chat.ts 内 MEETING_PROP_POINTS 编目（V15，当前 14 点 L0-L13）为准完整同步（防止角色信息泄漏）',
  '[确认缺失:PERSIST_FLUSH_SAVE] [持久化] 修改存储逻辑需确认 scheduleFlush 防抖落盘逻辑完整，save() 调用未被删除（否则重启数据丢失）',
  '[文档·强制] 🔴 本次判定为架构级改动（涉及跨模块接口/数据模型/管线重构/高风险文件）。必须同步输出白皮书+蓝皮书文档更新摘要（至少标题+条目列表）。无配套文档内容直接判定本维不通过，打回 S3 补充。',
  '[确认缺失:DOC_SERVICE] [文档·蓝皮书] 服务层变更需更新：部署拓扑、启动流程、配置项清单',
  '[确认缺失:DOC_STORAGE] [文档·白皮书] 存储层变更需更新：白皮书持久化章节（表结构、防抖save机制）、蓝皮书数据回滚方案',
];

describe('isProcessObligation / partitionReviewViolations (P0-A)', () => {
  it('今晚锁死 run 的全部 5 条 blocker 均判为义务/簿记（不进文本计分）', () => {
    for (const b of TONIGHT_BLOCKERS) {
      expect(isProcessObligation(b), b.slice(0, 40)).toBe(true);
    }
  });

  it('内容违规保留在 content 通道', () => {
    const contentSamples = [
      '[归类·拦截] 🔴 文件路径反向核验：修改文件位于系统公共内核区域，但 S2 方案将其归类为「个性局部特例修改」。判定为共性底层问题虚假归类为个性特例',
      'REVIEW_INVARIANT: REVIEW_DETAILS_MISSING: S4 未携带结构化 review_details',
    ];
    for (const s of contentSamples) {
      expect(isProcessObligation(s), s.slice(0, 40)).toBe(false);
    }
  });

  it('partition 把今晚混合输入正确分流 content=0 / confirmations + unconditional', () => {
    const { content, confirmations, unconditional } = partitionReviewViolations([...TONIGHT_BLOCKERS]);
    expect(content).toHaveLength(0);                    // 纯簿记 run：无内容违规 → 文本分不再被拖
    expect(confirmations.length + unconditional.length).toBe(TONIGHT_BLOCKERS.length);
    // [文档·强制] 属无条件义务（不入硬闸门），[确认缺失:*] 属可声明确认（入硬闸门）
    expect(confirmations.some(c => c.includes('COUPLING_MEETING_NAME_POINTS'))).toBe(true);
    expect(unconditional.some(u => u.startsWith('[文档·强制]'))).toBe(true);
  });

  it('REVIEW_INVARIANT 机器码违规绝不落入义务通道（fail-closed 保持）', () => {
    const { content, confirmations, unconditional } = partitionReviewViolations([
      'REVIEW_INVARIANT: REVIEW_DETAILS_RR_BLOCKING_MISMATCH: reject_reason(1) 与 blocking(2) 数量不一致',
    ]);
    expect(content).toHaveLength(1);
    expect(confirmations).toHaveLength(0);
    expect(unconditional).toHaveLength(0);
  });

  it('FG 红线确认缺失（声明即清除）走确认通道，但真实 uuid 缺陷由 CK-04/metrics 兜底不受此影响', () => {
    const fg = '[确认缺失:FG_REDLINE_8] [FG·红线8] 涉及记忆/对话文件，需确认 belong_entity_uuid 标注完整（无未标注记录）';
    const { content, confirmations } = partitionReviewViolations([fg]);
    expect(content).toHaveLength(0);
    expect(confirmations).toHaveLength(1);
  });
});
