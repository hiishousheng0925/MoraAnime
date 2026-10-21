/**
 * 密码哈希：Node 内置 scrypt，加盐，存成 `scrypt$N$r$p$盐$哈希`（参数跟着存，以后调强度旧密码照样能验）。
 * 不依赖 db / auth，迁移脚本也能直接用。
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, LEN = 32;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(String(pw), salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored ?? '');
  if (!m) {
    // 没设密码的账号也走一遍等量计算 —— 不让耗时泄露「这个账号有没有密码」
    scryptSync(String(pw), 'pad', LEN, { N, r: R, p: P });
    return false;
  }
  const want = Buffer.from(m[5], 'base64url');
  const got = scryptSync(String(pw), Buffer.from(m[4], 'base64url'), want.length, { N: +m[1], r: +m[2], p: +m[3] });
  return timingSafeEqual(got, want);
}
