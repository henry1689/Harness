/**
 * token-canonicalize.ts — Token 稳定序列化 (P4-AB)
 * ==================================================
 * 确保相同语义的 Token SigningPayload 产生相同签名。
 * 无论对象 key 顺序如何，只要内容相同，序列化结果就相同。
 *
 * 规则:
 *   1. 对象 key 按字母排序
 *   2. 数组保持原始顺序
 *   3. undefined 字段在对象中被丢弃 (不序列化)
 *   4. null 序列化为 "null"
 *   5. 字符串用 JSON.stringify 转义
 *   6. 数字/布尔值原样
 */

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 对任意值做稳定 JSON 序列化。
 * 用于 Token SigningPayload 的 canonicalization。
 *
 * @throws 如果遇到不支持的类型 (function, symbol, bigint, 循环引用)
 */
export function stableStringify(value: unknown): string {
  return _stringify(value);
}

// ════════════════════════════════════════════════════════════════════
// 内部实现
// ════════════════════════════════════════════════════════════════════

function _stringify(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);

  if (typeof value === 'undefined') {
    // 顶层 undefined → null
    return 'null';
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => _stringify(item)).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();

    const pairs = keys
      .filter((key) => typeof obj[key] !== 'undefined')
      .map((key) => JSON.stringify(key) + ':' + _stringify(obj[key]));

    return '{' + pairs.join(',') + '}';
  }

  // 不支持的类型: function, symbol, bigint, 循环引用
  throw new Error(
    `[token-canonicalize] Unsupported value type: ${typeof value}`
  );
}
