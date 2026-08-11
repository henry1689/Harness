/**
 * scripts/harness-passwd.cjs — Harness 管理员密码管理
 * ====================================================
 * 修改 Harness 的管理员密码。密码用于解锁 Harness 自身代码的修改权限。
 *
 * 用法:
 *   node scripts/harness-passwd.cjs                      # 交互式修改密码
 *   node scripts/harness-passwd.cjs --verify <password>  # 验证密码是否正确
 *   node scripts/harness-passwd.cjs --show               # 显示当前密码文件信息（不含密码）
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

const passCore = require('./pass-core.cjs');
const { PASS_FILE, readPassFile, writePassFile, verifyPassword } = passCore;

// ── 交互式修改密码 ──

const args = process.argv.slice(2);

if (args.includes('--verify')) {
  const idx = args.indexOf('--verify');
  const pwd = args[idx + 1];
  if (!pwd) { console.error('用法: node harness-passwd.cjs --verify <密码>'); process.exit(1); }
  if (verifyPassword(pwd)) {
    console.log('✅ 密码正确');
    process.exit(0);
  } else {
    console.log('❌ 密码错误');
    process.exit(1);
  }
}

if (args.includes('--show')) {
  const cur = readPassFile();
  if (!cur) {
    console.log('⚠️ 密码文件不存在: ' + PASS_FILE);
    process.exit(0);
  }
  console.log(`密码文件: ${PASS_FILE}`);
  console.log(`版本: ${cur.version || 1}`);
  console.log(`算法: ${cur.algorithm || 'sha256'}`);
  if (cur.salt) console.log(`盐: ${cur.salt}`);
  if (cur.iterations) console.log(`迭代: ${cur.iterations}`);
  console.log(`创建时间: ${cur.created_at}`);
  process.exit(0);
}

// 交互式修改
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('═══════════════════════════════════');
console.log('  Harness 管理员密码修改');
console.log('═══════════════════════════════════');
console.log('');

const current = readPassFile();
if (current) {
  console.log(`当前密码: ${(current.version || 1) === 1 ? 'v1 sha256 (旧格式，建议升级)' : 'v2 PBKDF2 (已加盐)'}`);
  console.log(`创建时间: ${current.created_at}`);
  console.log('');
}

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

(async () => {
  // 如果已有密码，先验证
  if (current) {
    const oldPwd = await ask('请输入当前密码: ');
    if (!verifyPassword(oldPwd)) {
      console.log('❌ 当前密码错误，操作取消');
      rl.close();
      process.exit(1);
    }
    console.log('✅ 当前密码验证通过');
    console.log('');
  }

  const newPwd = await ask('请输入新密码: ');
  if (newPwd.length < 8) {
    console.log('❌ 密码至少需要 8 位字符');
    rl.close();
    process.exit(1);
  }

  const confirm = await ask('请再次输入新密码: ');
  if (newPwd !== confirm) {
    console.log('❌ 两次输入的密码不一致');
    rl.close();
    process.exit(1);
  }

  // v2 PBKDF2 加盐写入
  const record = passCore.hashPassword(newPwd);
  writePassFile(record);
  console.log('✅ 管理员密码已更新 (v2 PBKDF2 加盐)');
  console.log('');
  console.log('⚠️ 请妥善保管新密码。忘记密码只能通过直接编辑 .harness-pass 文件来重置。');
  rl.close();
})();
