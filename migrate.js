#!/usr/bin/env node
'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const readline = require('node:readline');
const mysql = require('mysql2/promise');

function loadKey() {
  const raw = process.env.CRYPTO_SECRET_KEY;
  if (!raw) {
    console.error('ERROR: CRYPTO_SECRET_KEY가 .env에 없습니다.');
    process.exit(1);
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    console.error(
      `ERROR: CRYPTO_SECRET_KEY는 32바이트 hex(64자)여야 합니다. 현재 ${key.length}바이트.`,
    );
    process.exit(1);
  }
  return key;
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

function decrypt(ciphertext, key) {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('포맷 오류: iv.authTag.ciphertext 형태여야 함');
  }
  const [ivB, tagB, encB] = parts;
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const enc = Buffer.from(encB, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    'utf-8',
  );
}

async function connectDb() {
  const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE } =
    process.env;
  if (!DB_HOST || !DB_DATABASE) {
    console.error('ERROR: DB 환경변수가 누락되었습니다. .env를 확인하세요.');
    process.exit(1);
  }
  return mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT) || 3306,
    user: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_DATABASE,
  });
}

const SELECT_PLAINTEXT_ROWS = `
  SELECT ACCOUNTID, USERID, USERNAME, TOTPSECRET, LENGTH(TOTPSECRET) AS LEN
  FROM TUSERACCOUNT
  WHERE TOTPSECRET IS NOT NULL AND TOTPSECRET != ''
    AND TOTPSECRET NOT LIKE '%.%.%'
`;

function buildFilterClause(filter) {
  if (!filter) return { sql: '', params: [] };
  if (filter.accountId !== undefined) {
    return { sql: ' AND ACCOUNTID = ?', params: [filter.accountId] };
  }
  if (filter.userId !== undefined) {
    return { sql: ' AND USERID = ?', params: [filter.userId] };
  }
  return { sql: '', params: [] };
}

async function cmdList() {
  const conn = await connectDb();
  try {
    const [rows] = await conn.execute(SELECT_PLAINTEXT_ROWS);
    if (rows.length === 0) {
      console.log('✅ 평문 TOTPSECRET 보유 계정 없음');
      return;
    }
    console.log(`평문 TOTPSECRET 보유 계정: ${rows.length}건\n`);
    console.table(rows);
  } finally {
    await conn.end();
  }
}

async function cmdEncrypt(plain) {
  if (!plain) {
    console.error('사용법: node migrate.js encrypt <plaintext>');
    process.exit(1);
  }
  const key = loadKey();
  const ct = encrypt(plain, key);
  console.log('암호문:');
  console.log(ct);
  console.log('\n검증(복호화):');
  console.log(decrypt(ct, key));
}

async function cmdDecrypt(ct) {
  if (!ct) {
    console.error('사용법: node migrate.js decrypt <ciphertext>');
    process.exit(1);
  }
  const key = loadKey();
  console.log(decrypt(ct, key));
}

async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question(`${message} (yes/N): `, resolve),
  );
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function cmdMigrate(options) {
  const key = loadKey();
  const conn = await connectDb();
  try {
    const { sql: filterSql, params: filterParams } = buildFilterClause(
      options.filter,
    );
    const [rows] = await conn.execute(
      SELECT_PLAINTEXT_ROWS + filterSql,
      filterParams,
    );
    if (rows.length === 0) {
      if (options.filter) {
        console.log(
          '✅ 지정한 ID로 암호화 대상이 없습니다. (이미 암호화되었거나 존재하지 않음)',
        );
      } else {
        console.log('✅ 마이그레이션 대상 없음');
      }
      return;
    }

    const plan = rows.map((r) => ({
      ...r,
      CIPHERTEXT: encrypt(r.TOTPSECRET, key),
    }));

    console.log(`대상 ${plan.length}건:\n`);
    console.table(
      plan.map((p) => ({
        ACCOUNTID: p.ACCOUNTID,
        USERID: p.USERID,
        USERNAME: p.USERNAME,
        BEFORE: p.TOTPSECRET,
        AFTER_PREVIEW: p.CIPHERTEXT.slice(0, 40) + '...',
      })),
    );

    if (options.dryRun) {
      console.log(
        '\n[DRY RUN] 실제 UPDATE는 수행하지 않았습니다. 반영하려면 --dry-run 빼고 다시 실행.',
      );
      return;
    }

    const ok = await confirm(`\n위 ${plan.length}건을 실제로 UPDATE 할까요?`);
    if (!ok) {
      console.log('취소됨. 변경 없음.');
      return;
    }

    let success = 0;
    for (const p of plan) {
      const [result] = await conn.execute(
        'UPDATE TUSERACCOUNT SET TOTPSECRET = ? WHERE ACCOUNTID = ?',
        [p.CIPHERTEXT, p.ACCOUNTID],
      );
      if (result.affectedRows === 1) {
        success += 1;
        console.log(`✅ ${p.ACCOUNTID} (${p.USERID}) 업데이트 완료`);
      } else {
        console.warn(
          `⚠️  ${p.ACCOUNTID} (${p.USERID}) 영향 행 ${result.affectedRows} — 확인 필요`,
        );
      }
    }
    console.log(`\n총 ${success}/${plan.length}건 반영 완료`);
  } finally {
    await conn.end();
  }
}

function usage() {
  console.log(`TOTP 마이그레이션 도구

사용법:
  node migrate.js list                     평문 TOTPSECRET 보유 계정 조회
  node migrate.js encrypt <plaintext>      평문 → 암호문 (DB 미접근)
  node migrate.js decrypt <ciphertext>     암호문 → 평문 (검증, DB 미접근)
  node migrate.js migrate [options]        DB 평문 계정 암호화 + UPDATE

migrate 옵션:
  --dry-run                  실제 UPDATE 없이 미리보기만
  --account-id <id>          해당 ACCOUNTID 한 건만 대상
  --user-id <id>             해당 USERID 한 건만 대상
  (--account-id와 --user-id는 함께 쓸 수 없음)

예시:
  node migrate.js migrate --account-id 1024
  node migrate.js migrate --user-id jongdeug --dry-run

환경변수 (.env):
  CRYPTO_SECRET_KEY    ims-nest/contact-center와 동일한 64자 hex
  DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
`);
}

function parseMigrateArgs(args) {
  const options = { dryRun: false, filter: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') {
      options.dryRun = true;
    } else if (a === '--account-id') {
      const v = args[i + 1];
      if (!v) throw new Error('--account-id 값이 필요합니다.');
      options.filter = { ...(options.filter || {}), accountId: v };
      i += 1;
    } else if (a === '--user-id') {
      const v = args[i + 1];
      if (!v) throw new Error('--user-id 값이 필요합니다.');
      options.filter = { ...(options.filter || {}), userId: v };
      i += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${a}`);
    }
  }
  if (
    options.filter &&
    options.filter.accountId !== undefined &&
    options.filter.userId !== undefined
  ) {
    throw new Error('--account-id와 --user-id는 함께 사용할 수 없습니다.');
  }
  return options;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
      await cmdList();
      break;
    case 'encrypt':
      await cmdEncrypt(rest[0]);
      break;
    case 'decrypt':
      await cmdDecrypt(rest[0]);
      break;
    case 'migrate':
      await cmdMigrate(parseMigrateArgs(rest));
      break;
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
