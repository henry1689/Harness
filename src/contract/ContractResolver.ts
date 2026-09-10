// 🟡MEDIUM_SKELETON_ONLY
// 说明：本文件仅为接口/schema 骨架；尚未接入 S1-S7 正式流水线；
// 对应方案文档 M-02（结构化契约模型：10 铁律 FT-01~10 / 9 实现规则 IR-01~09 ↔ DS-01~23 显式映射）；
// 禁止在本次迭代把业务逻辑接入 DFA、gate；
// 后续迭代需移除本注释，完成实现后再接入主流程。
//
// 🟢FUTURE_L02：白皮书/三体 DNA 顶层文档自动化比对 —— 预留架构比对分析器入口（远期，不实现）。
// 🟢FUTURE_L03：CK-08 补丁嗅探增强（区分恶意补丁 vs 合法加固）——需引用本模型的 DS 扣分上下文。

/**
 * M-02 契约映射条目（从 harness_contract/core_constraint_mapping.yaml 加载）
 */
export interface ConstraintMapping {
  /** 铁律 ID：FT-01 ~ FT-10；实现规则 ID：IR-01 ~ IR-09 */
  constraint_id: string;
  title: string;
  desc: string;
  /** 显式映射到的设计标准编号（DS-xx） */
  mapped_ds: string[];
  /** 显式映射到的检查项编号（CK-xx） */
  mapped_ck: string[];
  violation_severity: 'warn' | 'fail';
}

/**
 * M-01 Overlay 契约（从 harness_contract/overlays/*.yaml 加载）
 * DS/CK 项目化规则外置，解除通用引擎与 WenStar 硬编码耦合。
 */
export interface OverlayRuleSet {
  overlay_id: string;
  milestone: string;          // P0 / P2#8 ...
  version: string;
  effective_date: string;
  ds_rules: Record<string, { weight: number; enabled: boolean; exemption_conditions: string[] }>;
  ck_rules: Record<string, { enabled: boolean; severity: 'blocking' | 'warn' }>;
}

/** 契约解析器骨架——对外 API（B0 只定义，不实现业务加载逻辑） */
export interface IContractResolver {
  /** 加载并解析 core_constraint_mapping.yaml → ConstraintMapping[] */
  loadMappings(basePath?: string): Promise<ConstraintMapping[]>;
  /** 加载指定 overlay（按 S2 声明的 milestone） */
  loadOverlay(overlayId: string, basePath?: string): Promise<OverlayRuleSet | null>;
  /** 解析某个 FT/IR 映射到的 DS/CK 集合（供 S2 预扫描风险报告） */
  resolve(constraintId: string): Promise<{ ds: string[]; ck: string[] } | null>;
}

/**
 * TODO(M-02/接入期)：实现 IContractResolver（读 yaml + 缓存 + 校验），
 * 并将 S2 契约预扫描、全阶段结构化注入接回主流水线。B0 阶段不实现。
 */
export class ContractResolver implements IContractResolver {
  private readonly _basePath?: string;
  constructor(basePath?: string) { this._basePath = basePath; }

  async loadMappings(_basePath?: string): Promise<ConstraintMapping[]> {
    throw new Error('[ContractResolver] 🟡MEDIUM_SKELETON_ONLY — M-02 骨架未接入，禁止在生产调用');
  }
  async loadOverlay(_overlayId: string, _basePath?: string): Promise<OverlayRuleSet | null> {
    throw new Error('[ContractResolver] 🟡MEDIUM_SKELETON_ONLY — M-01 骨架未接入，禁止在生产调用');
  }
  async resolve(_constraintId: string): Promise<{ ds: string[]; ck: string[] } | null> {
    throw new Error('[ContractResolver] 🟡MEDIUM_SKELETON_ONLY — 未接入');
  }
}
