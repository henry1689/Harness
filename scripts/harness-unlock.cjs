/**
 * scripts/harness-unlock.cjs — Harness 管理员解锁
 * ===============================================
 * 用户在终端运行此脚本，输入管理员密码后签发 30 分钟解锁令牌。
 * 解锁后，Agent 方可通过流水线修改 Harness 自身代码。
 *
 * 用法:
 *   node scripts/harness-unlock.cjs                       # 交互式解锁
 *   node scripts/harness-unlock.cjs --password <密码>      # 命令行传密码（不推荐，会留在 shell 历史）
 *   node scripts/harness-unlock.cjs --status               # 查看当前解锁状态
 *   node scripts/harness-unlock.cjs --lock                 # 手动锁定（立即使解锁失效）
 *
 * 本模块可被其他脚本 require（export verifyPassword / checkUnlockStatus），
 * 交互代码仅在作为主模块运行时执行。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const passCore = require('./pass-core.cjs');
const { PASS_FILE, verifyPassword } = passCore;

const HARNESS_DIR = path.resolve(__dirname, '..');
const UNLOCK_FILE = path.join(HARNESS_DIR, 'data', 'sessions', 'harness-admin-unlock.json');
const SESSIONS_DIR = path.join(HARNESS_DIR, 'data', 'sessions');

// ── HMAC 签名（防伪造解锁令牌）──
// 解锁令牌签名 key：优先 HARNESS_TOKEN_SECRET 环境变量，否则用密码文件里的 hash 派生。
// C4-fix: 统一从 pass-core.getSignKey() 取签名 key（env secret → data/.harness-secret）
function getSignKey() {
  return passCore.getSignKey();
}

/**
 * 🔴 C3-fix + HIGH-1-fix: 签名覆盖「身份字段 + expires_at」。
 * unlock_id/created_at/source 不可变 → 防伪造；expires_at 参与签名 → 防重放
 * （攻击者把 consumed→false、expires_at→未来 时签名失效）。
 * consumed/consumed_at 仍不参与签名，因为消费是终态（lockNow 直接删文件），无需防篡改。
 * 续期（改 expires_at）必须重签：调用方负责在改完 expires_at 后调 signToken 更新 sig。
 * M3-fix: 用 pass-core.stableStringify（排序键）保证跨进程一致。
 */
function signToken(token) {
  const key = getSignKey();
  if (!key) {
    // C4-fix: 无 secret → 无法签名 → fail-closed（签发方会收到 null 签名而拒绝）
    return null;
  }
  const body = {
    unlock_id: String(token.unlock_id),
    created_at: String(token.created_at),
    source: String(token.source),
    expires_at: token.expires_at,
  };
  return crypto.createHmac('sha256', key).update(passCore.stableStringify(body)).digest('hex');
}

/** 验证令牌签名；返回 true/false */
function verifyTokenSig(token) {
  if (!token || !token.sig) return false;
  const expect = signToken(token);
  // 无 secret 时 signToken 返回 null → 拒绝（避免 null===null 误判通过）
  if (!expect) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token.sig, 'utf8'), Buffer.from(expect, 'utf8'));
  } catch (_) { return token.sig === expect; }
}

function checkUnlockStatus() {
  if (!fs.existsSync(UNLOCK_FILE)) return { unlocked: false, reason: '未解锁' };
  try {
    const token = JSON.parse(fs.readFileSync(UNLOCK_FILE, 'utf-8'));
    if (token.consumed) return { unlocked: false, reason: '令牌已使用' };
    // 🔴 S2-安全收紧 ②: 校验 HMAC 签名——伪造的解锁文件无法通过验签
    if (!verifyTokenSig(token)) {
      return { unlocked: false, reason: '令牌签名无效（可能被伪造或篡改）' };
    }
    const remaining = Math.round((token.expires_at - Date.now()) / 60000);
    if (remaining <= 0) return { unlocked: false, reason: '令牌已过期' };
    return { unlocked: true, remaining_minutes: remaining, unlock_id: token.unlock_id, created_at: token.created_at };
  } catch (_) { return { unlocked: false, reason: '令牌读取失败' }; }
}

function issueUnlockToken(source = 'user-cli') {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const token = {
    unlock_id: 'hs-unlock-' + Date.now().toString(36),
    created_at: new Date().toISOString(),
    expires_at: Date.now() + 30 * 60 * 1000, // 30 分钟
    consumed: false,
    source,
  };
  token.sig = signToken(token);
  fs.writeFileSync(UNLOCK_FILE, JSON.stringify(token, null, 2), 'utf-8');
  return token;
}

function lockNow() {
  // HIGH-1-fix: 删除解锁文件而非标记 consumed。
  // 标记 consumed 会留下令牌，攻击者可改 consumed→false 重放旧解锁。
  // 删除后旧令牌彻底消失，重放不可能。
  if (fs.existsSync(UNLOCK_FILE)) {
    try { fs.unlinkSync(UNLOCK_FILE); } catch (_) {}
  }
  console.log('🔒 Harness 管理员已锁定。Agent 无法修改 Harness 自身代码。');
}

// 导出供其他模块复用
module.exports = {
  verifyPassword,
  checkUnlockStatus,
  verifyTokenSig,
  signToken,
  issueUnlockToken,
  lockNow,
  UNLOCK_FILE,
};

// ── 仅主模块执行：CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    const status = checkUnlockStatus();
    if (status.unlocked) {
      console.log(`🔓 Harness 已解锁 — 剩余 ${status.remaining_minutes} 分钟`);
      console.log(`   解锁ID: ${status.unlock_id}`);
      console.log(`   创建时间: ${status.created_at}`);
    } else {
      console.log(`🔒 Harness 已锁定 — ${status.reason}`);
    }
    process.exit(0);
  }

  if (args.includes('--lock')) {
    lockNow();
    process.exit(0);
  }

  // ── 交互式解锁 ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('═══════════════════════════════════════');
  console.log('  🔓 Harness 管理员解锁');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log('解锁后 30 分钟内，Agent 可以修改 Harness 自身代码。');
  console.log('');

  function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
  }

  (async () => {
    const status = checkUnlockStatus();
    if (status.unlocked) {
      console.log(`⚠️ Harness 当前已解锁（剩余 ${status.remaining_minutes} 分钟）`);
      const extend = await ask('是否刷新解锁时间？(y/n): ');
      if (extend.toLowerCase() !== 'y') {
        console.log('操作取消');
        rl.close();
        process.exit(0);
      }
    }

    let password;
    const pwdIdx = args.indexOf('--password');
    if (pwdIdx !== -1 && args[pwdIdx + 1]) {
      password = args[pwdIdx + 1];
      console.log('(从命令行参数读取密码)');
    } else {
      password = await ask('请输入 Harness 管理员密码: ');
      console.log('');
    }

    if (!verifyPassword(password)) {
      console.log('❌ 密码错误！访问被拒绝。');
      rl.close();
      process.exit(1);
    }

    const token = issueUnlockToken('user-cli');
    console.log('✅ 解锁成功！');
    console.log(`   解锁ID: ${token.unlock_id}`);
    console.log(`   有效期: 30 分钟 (至 ${new Date(token.expires_at).toLocaleTimeString('zh-CN')})`);
    console.log('');
    console.log('📋 现在你可以告诉 Agent: "Harness 已解锁，请进行维护操作"');
    rl.close();
  })();
}
