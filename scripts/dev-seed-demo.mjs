// hande_dev(jnpbuulrmgdkzbiywjtd) 전용 시연 데이터 생성 스크립트.
// - src/data/client.mjs 공개 함수만 호출한다. 권한·상태 규칙은 DB 함수가 판단한다.
//   (Storage 파일 올리기만 프론트와 같은 방식으로 supabase.storage를 직접 쓴다.)
// - publishable/anon 키 + signUp만 사용한다. service_role/secret 키는 거부한다.
// - 계정 비밀번호와 생성한 ID는 .local/dev-demo-seed.json(.gitignore)에만 저장한다.
// - 다시 실행하면 이미 끝난 단계는 건너뛴다. 로펌 승인 전이면 승인 SQL을 안내하고 멈춘다.
// 모든 이름·문장은 [예시] 가상 데이터다.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import { analyze, draftGroup } from '@team-apple/hande-ai';
import { createBackendClient } from '../src/data/client.mjs';

const DEV_REF = 'jnpbuulrmgdkzbiywjtd';
const PROD_REF = 'nchmitaoxqodsjmhmphi';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, '.local', 'dev-demo-seed.json');

// ---------------------------------------------------------------- 연결값 · 안전장치
const envPath = join(root, '.env');
if (!existsSync(envPath)) fail('backend/.env가 없습니다. .env.example을 복사해 SUPABASE_URL, SUPABASE_ANON_KEY를 채우세요.');
process.loadEnvFile(envPath);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = process.env;
if (!url || !key) fail('.env에 SUPABASE_URL, SUPABASE_ANON_KEY가 필요합니다.');
if (url.includes(PROD_REF)) fail('운영 프로젝트 URL입니다. 실행하지 않습니다.');
if (url.replace(/\/+$/, '') !== `https://${DEV_REF}.supabase.co`) fail(`SUPABASE_URL은 https://${DEV_REF}.supabase.co(hande_dev)여야 합니다.`);
if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') fail('service_role/secret 키는 쓰지 않습니다. publishable(anon) 키를 넣으세요.');
const DEMO_END = new Date('2026-11-30T18:00:00+09:00'); // 시연 종료 기준
const firmVoteClosesAt = new Date(process.env.DEMO_FIRM_VOTE_CLOSES_AT || '2026-12-01T18:00:00+09:00');
const group3ProposalDeadline = new Date(process.env.DEMO_G3_PROPOSAL_DEADLINE || '2026-12-01T18:00:00+09:00');
if (!(firmVoteClosesAt > DEMO_END)) fail('DEMO_FIRM_VOTE_CLOSES_AT은 2026-11-30 18:00(KST) 이후여야 합니다.');
if (!(group3ProposalDeadline > DEMO_END)) fail('DEMO_G3_PROPOSAL_DEADLINE은 2026-11-30 18:00(KST) 이후여야 합니다.');
const proposalWindowSec = Number(process.env.DEMO_PROPOSAL_WINDOW_SEC || 120);

function jwtRole(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; } catch { return undefined; }
}
function fail(message) { console.error(`중단: ${message}`); process.exit(1); }

// ---------------------------------------------------------------- [예시] 데이터 정의
// 회사명 칸은 ○○·△△·□□ 표기만 쓴다(실제 회사일 수 없음). hande-ai가 [예시]를 떼고 회사명을 뽑고,
// DB join_group은 회사명을 그대로 비교하므로 [예시]는 그룹 이름 앞에만 붙인다.
const SHOP = '○○쇼핑몰';
const TELECOM = '△△통신';
const CARD = '□□카드';
const EXAMPLE = '[예시] ';
const month = m => ({ from: `2026-${m}-01`, to: `2026-${m}-${new Date(2026, Number(m), 0).getDate()}`, precision: 'month' });
// fields: 확인 화면에서 사용자가 확정할 값. AI가 못 찾았거나 확인 필요이거나 값이 다른 항목만 이 값으로 바꾼다.
const victim = (id, company, notice, text, leaked, secondary, card = 'no') => ({ id, role: 'user', email: `demo-victim-${id}@example.invalid`,
  nickname: `[예시] 피해자${id.toUpperCase()}`, phone: `0100000${String(id.charCodeAt(0) - 96).padStart(4, '0')}`, text,
  fields: company && { company, type: 'privacy_leak', notice_date: month(notice), leaked, secondary, card } });
const shop = (id, text, leaked, secondary) => victim(id, SHOP, '10', text, leaked, secondary);
const telecom = (id, text, leaked, secondary) => victim(id, TELECOM, '09', text, leaked, secondary);
const card = (id, text, leaked, secondary, cardLeak) => victim(id, CARD, '11', text, leaked, secondary, cardLeak);
const PEOPLE = [
  { ...victim('a'), text: null }, // 계정·프로필만. 시연 때 직접 피해 등록.
  shop('b', '2026년 10월에 [예시] ○○쇼핑몰에서 개인정보 유출 안내 문자를 받았어요. 이름, 전화번호, 주소가 유출됐다고 합니다. 그 뒤로 택배 사칭 스미싱 문자가 여러 번 왔어요.', ['이름', '전화번호', '주소'], 'yes'),
  shop('c', '[예시] ○○쇼핑몰 회원정보 유출 안내 메일을 2026년 10월에 받았습니다. 이름, 이메일, 아이디가 포함됐대요. 아직 이상한 연락은 없었어요.', ['이름', '이메일', '아이디'], 'no'),
  shop('d', '2026년 10월 [예시] ○○쇼핑몰에서 유출 통지 문자가 왔어요. 이름, 전화번호, 생년월일이 나갔다고 해요. 며칠 뒤 대출 권유 스팸 전화가 계속 왔습니다.', ['이름', '전화번호', '생년월일'], 'yes'),
  shop('e', '[예시] ○○쇼핑몰 공지로 2026년 10월에 유출 사실을 알게 됐어요. 이름, 주소, 전화번호, 이메일이 포함됐습니다. 2차 피해는 아직 잘 모르겠어요.', ['이름', '주소', '전화번호', '이메일'], 'unknown'),
  shop('f', '2026년 10월에 [예시] ○○쇼핑몰 유출 안내 문자를 받았습니다. 이름과 전화번호가 유출됐대요. 이후 결제 승인 사칭 스미싱 문자를 받았어요.', ['이름', '전화번호'], 'yes'),
  shop('g', '[예시] ○○쇼핑몰에서 2026년 10월 개인정보 유출 메일이 왔어요. 이메일, 아이디, 비밀번호가 유출됐다고 합니다. 다른 사이트 로그인 시도 알림을 받았어요.', ['이메일', '아이디', '비밀번호'], 'yes'),
  shop('h', '2026년 10월 [예시] ○○쇼핑몰 유출 안내를 문자로 받았어요. 이름, 주소가 포함됐습니다. 특별한 피해는 없었어요.', ['이름', '주소'], 'no'),
  shop('i', '[예시] ○○쇼핑몰에서 2026년 10월에 유출 통지를 받았습니다. 이름, 전화번호, 주소, 생년월일이 나갔대요. 택배 사칭 문자가 한두 번이 아니게 왔어요.', ['이름', '전화번호', '주소', '생년월일'], 'yes'),
  shop('j', '2026년 10월에 [예시] ○○쇼핑몰 유출 안내 메일을 받았어요. 이메일, 전화번호가 유출됐다고 합니다. 아직 피해는 없었어요.', ['이메일', '전화번호'], 'no'),
  shop('k', '[예시] ○○쇼핑몰 유출 안내 문자가 2026년 10월에 왔어요. 이름, 전화번호, 이메일이 포함됐대요. 피싱 전화를 한 번 받았어요.', ['이름', '전화번호', '이메일'], 'yes'),
  telecom('l', '2026년 9월에 [예시] △△통신에서 고객정보 유출 통지 문자를 받았어요. 이름, 전화번호, 생년월일이 유출됐대요. 이후 통신사 사칭 스미싱 문자가 왔습니다.', ['이름', '전화번호', '생년월일'], 'yes'),
  telecom('m', '[예시] △△통신 유출 안내 메일을 2026년 9월에 받았습니다. 이름, 주소, 이메일이 포함됐어요. 아직 이상한 연락은 없었어요.', ['이름', '주소', '이메일'], 'no'),
  telecom('n', '2026년 9월 [예시] △△통신 공지로 유출 사실을 알았어요. 이름, 전화번호가 나갔다고 합니다. 2차 피해는 잘 모르겠어요.', ['이름', '전화번호'], 'unknown'),
  card('o', '2026년 11월에 [예시] □□카드에서 회원정보 유출 안내 문자를 받았어요. 이름, 전화번호, 생년월일이 유출됐대요. 카드번호 일부도 포함됐다고 합니다. 이후 결제 사칭 스미싱 문자가 왔어요.', ['이름', '전화번호', '생년월일'], 'yes', 'yes'),
  card('p', '[예시] □□카드 유출 안내 메일을 2026년 11월에 받았습니다. 이름, 이메일, 주소가 포함됐어요. 카드 정보는 대상에서 빠졌대요. 아직 이상한 연락은 없었어요.', ['이름', '이메일', '주소'], 'no', 'no'),
  card('q', '2026년 11월 [예시] □□카드 공지로 유출 사실을 알았어요. 이름, 전화번호가 나갔고 카드번호와 유효기간도 유출됐대요. 해외 결제 시도 알림을 받았어요.', ['이름', '전화번호'], 'yes', 'yes'),
  card('r', '[예시] □□카드에서 2026년 11월에 개인정보 유출 통지를 받았어요. 이름, 생년월일, 주소가 포함됐습니다. 2차 피해는 아직 모르겠어요.', ['이름', '생년월일', '주소'], 'unknown', 'no'),
  card('s', '2026년 11월에 [예시] □□카드 유출 안내 문자가 왔어요. 이름, 전화번호, 이메일이 유출됐대요. 카드번호도 포함됐다고 해서 재발급 신청했어요. 카드사 사칭 전화를 받았어요.', ['이름', '전화번호', '이메일'], 'yes', 'yes'),
  card('t', '[예시] □□카드 회원정보 유출 메일을 2026년 11월에 받았어요. 아이디, 비밀번호, 이메일이 유출됐다고 합니다. 특별한 피해는 없었어요.', ['아이디', '비밀번호', '이메일'], 'no', 'no'),
  card('u', '2026년 11월 [예시] □□카드에서 유출 통지 문자를 받았습니다. 이름, 전화번호, 주소가 나갔대요. 카드번호 일부도 포함됐대요. 결제 승인 사칭 문자가 계속 와요.', ['이름', '전화번호', '주소'], 'yes', 'yes'),
  card('v', '[예시] □□카드 공지로 2026년 11월에 유출을 알게 됐어요. 이름, 생년월일이 포함됐습니다. 카드 정보는 포함되지 않았대요. 아직 피해는 없었어요.', ['이름', '생년월일'], 'no', 'no'),
  card('w', '2026년 11월에 [예시] □□카드 유출 안내 메일을 받았어요. 이름, 전화번호, 계좌가 유출됐대요. 대출 권유 스팸 문자가 늘었어요.', ['이름', '전화번호', '계좌'], 'yes', 'no'),
  card('x', '[예시] □□카드에서 2026년 11월 유출 안내 문자가 왔어요. 이름, 이메일, 전화번호가 포함됐대요. 카드번호도 유출됐다고 합니다. 2차 피해는 잘 모르겠어요.', ['이름', '이메일', '전화번호'], 'unknown', 'yes'),
  // 사업자번호는 국세청 검증번호 규칙에 맞지 않는 [예시] 번호라 실제 사업자와 겹치지 않는다.
  { id: 'firm-c', role: 'firm', email: 'demo-firm-c@example.invalid', nickname: '[예시] 로펌C 담당자',
    firm: { firmName: '[예시] 로펌 C (가상)', bizNo: '9990000011', repName: '[예시] 대표C', openDate: '2019-03-04' },
    proposal: { retainerFee: 300000, successFeePct: 15, period: '[예시] 약 12개월', strategy: '[예시] 공동소송으로 손해배상을 청구하고, 유출 경위 자료를 먼저 확보합니다.', lawyerCount: 4, leadLawyer: '[예시] 변호사C' } },
  { id: 'firm-d', role: 'firm', email: 'demo-firm-d@example.invalid', nickname: '[예시] 로펌D 담당자',
    firm: { firmName: '[예시] 로펌 D (가상)', bizNo: '9990000022', repName: '[예시] 대표D', openDate: '2021-07-01' },
    proposal: { retainerFee: 0, successFeePct: 25, period: '[예시] 약 18개월', strategy: '[예시] 착수금 없이 성공보수로 진행하고, 2차 피해자를 우선 정리해 위자료를 청구합니다.', lawyerCount: 2, leadLawyer: '[예시] 변호사D' } },
];
const byId = Object.fromEntries(PEOPLE.map(p => [p.id, p]));
// members[0]이 개설자이자 대표자 당선자. 대표자 선거는 활성 참여자 10명 이상(DB 규칙).
const GROUPS = {
  g1: { company: SHOP, members: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
    candidates: ['b', 'e'], repVotes: { b: 'b', c: 'b', d: 'b', f: 'b', g: 'b', h: 'b', i: 'b', e: 'e', j: 'e' }, // k 기권
    methodVotes: { b: 'suit', c: 'suit', d: 'suit', e: 'suit', f: 'suit', g: 'suit', h: 'suit', i: 'collective', j: 'collective', k: 'med' } },
  g2: { company: TELECOM, members: ['l', 'm', 'n'] },
  g3: { company: CARD, members: ['o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x'],
    candidates: ['o', 's'], repVotes: { o: 'o', p: 'o', q: 'o', r: 'o', t: 'o', u: 'o', s: 's', v: 's' }, // w, x 기권
    methodVotes: { o: 'suit', p: 'suit', q: 'suit', r: 'suit', s: 'suit', t: 'suit', u: 'consumer', v: 'collective', w: 'suit', x: 'med' } },
};
const VICTIMS = Object.values(GROUPS).flatMap(g => g.members);
const EVIDENCE = { b: ['notice', 'smishing'], d: ['notice'], f: ['smishing'], h: ['notice'], o: ['notice', 'payment'], q: ['payment'] };
const FIRMS = ['firm-c', 'firm-d'];

// ---------------------------------------------------------------- 상태 파일
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { project: DEV_REF, accounts: {}, reports: {}, evidence: {}, groups: {}, polls: {}, firms: {} };
if (state.project !== DEV_REF) fail('상태 파일의 프로젝트가 hande_dev가 아닙니다.');
const save = () => { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 }); };

// ---------------------------------------------------------------- 공통 도우미
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const kst = d => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const must = (result, what) => { if (result?.error) throw Error(`${what}: ${result.error.code}`); return result.data; };
const sessions = {};
async function api(id) {
  if (sessions[id]) return sessions[id];
  const person = byId[id];
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const client = createBackendClient(supabase);
  let account = state.accounts[id];
  if (account) {
    let r = await client.signIn({ email: account.email, password: account.password });
    for (let i = 0; r.error?.code === 'AUTH_RATE_LIMIT' && i < 8; i++) { // Auth 요청 횟수 제한: 잠시 뒤 재시도
      log(`  로그인 횟수 제한, 60초 후 재시도 (${person.email})`); await sleep(60_000);
      r = await client.signIn({ email: account.email, password: account.password });
    }
    if (r.error) throw Error(`${person.email} 로그인 실패(${r.error.code}). 상태 파일과 DB가 맞지 않으면 정리 SQL 실행 후 다시 시작하세요.`);
    account.userId = r.data.user.id;
  } else {
    const password = randomBytes(18).toString('base64url');
    const r = await client.signUp({ email: person.email, password });
    if (r.error) throw Error(`${person.email} 가입 실패(${r.error.code})${r.error.code === 'ACCOUNT_EXISTS' ? ': 상태 파일 없이 계정만 남아 있습니다. 시연 데이터 정리 SQL을 먼저 실행하세요.' : ''}`);
    if (r.data.requiresEmailConfirmation) throw Error('이메일 인증이 켜져 있어 세션이 없습니다. hande_dev 설정을 확인하세요.');
    account = state.accounts[id] = { email: person.email, password, role: person.role, userId: r.data.user.id };
    save(); log(`  가입: ${person.email}`);
  }
  must(await client.completeSignup(person.role === 'user'
    ? { role: 'user', nickname: person.nickname, realName: person.nickname, phone: person.phone }
    : { role: 'firm', nickname: person.nickname }), `${person.email} 프로필`);
  return (sessions[id] = { client, supabase, userId: account.userId });
}

// 작은 [예시] PNG(64x40, iTXt에 [예시] 표기)와 PDF.
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]);
}
function samplePng(seed) {
  const w = 64, h = 40, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, stripe = y < 8;
    raw[o] = stripe ? 40 : 230; raw[o + 1] = stripe ? 90 + seed * 30 : 235; raw[o + 2] = stripe ? 160 : 240;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('iTXt', Buffer.from('Comment\0\0\0\0[예시] 시연용 가상 증빙 이미지', 'utf8')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function samplePdf(title) {
  const text = `[SAMPLE] ${title} - fictional business registration for demo only`;
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = `BT /F1 11 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------- 사례 · 증빙 · 그룹
async function ensureReport(id) {
  const p = byId[id]; const { client } = await api(id);
  let reportId = state.reports[id];
  if (reportId) {
    const r = must(await client.getReport({ reportId }), `${id} 사례 조회`);
    if (r.finalizedAt) return reportId;
  } else {
    const ai = await analyze(p.text, { now: new Date('2026-11-26T12:00:00+09:00') });
    if (ai.error) throw Error(`${id} AI 정리 실패: ${ai.error.code}`);
    const fields = ai.data.fields.map(f => {
      if (f.key === 'secondary_detail') return f;
      const want = p.fields[f.key], now = f.source === 'user' ? f.userValue : f.aiValue;
      const norm = v => JSON.stringify(Array.isArray(v) ? [...v].sort() : v); // 유출 항목은 순서 무관
      return norm(now) === norm(want) && !f.needsCheck ? f : { ...f, userValue: want, source: 'user', needsCheck: false };
    }).filter(f => f.key !== 'secondary_detail' || p.fields.secondary === 'yes');
    reportId = must(await client.saveReport({ rawText: p.text, fields }), `${id} 사례 저장`).reportId;
    state.reports[id] = reportId; save();
  }
  must(await client.finalizeReport({ reportId }), `${id} 사례 확정`);
  log(`  사례 확정: ${p.nickname}`);
  return reportId;
}

async function ensureEvidence(id) {
  const kinds = EVIDENCE[id]; const { client, supabase } = await api(id);
  const list = state.evidence[id] ??= [];
  for (let i = 0; i < kinds.length; i++) {
    let item = list[i];
    if (item?.status === 'ready') continue;
    const bytes = samplePng(i);
    if (!item) {
      const reg = must(await client.createEvidenceUpload({ reportId: state.reports[id], kind: kinds[i],
        originalName: `예시-증빙-${kinds[i]}.png`, mimeType: 'image/png', sizeBytes: bytes.length }), `${id} 증빙 등록`);
      item = list[i] = { evidenceId: reg.evidenceId, bucketId: reg.bucketId, objectPath: reg.objectPath, status: 'pending' }; save();
    }
    let confirmed = await client.confirmEvidence({ evidenceId: item.evidenceId });
    if (confirmed.error?.code === 'CONFLICT') { // 아직 파일이 없음 → 올리고 다시 확인
      const up = await supabase.storage.from(item.bucketId).upload(item.objectPath, bytes, { contentType: 'image/png', upsert: false });
      if (up.error) throw Error(`${id} 증빙 업로드 실패: ${up.error.message}`);
      confirmed = await client.confirmEvidence({ evidenceId: item.evidenceId });
    }
    item.status = must(confirmed, `${id} 증빙 확인`).status; save();
    if (item.status !== 'ready') throw Error(`${id} 증빙 확인 결과 ${item.status}`);
    log(`  증빙 확인(ready): ${byId[id].nickname} ${kinds[i]}`);
  }
}

async function ensureGroup(key) {
  const { members, company } = GROUPS[key]; const [owner, ...rest] = members;
  const { client } = await api(owner);
  let groupId = state.groups[key];
  if (!groupId) { // 상태 파일에 없으면 같은 회사 그룹 중 개설자가 참여한 그룹을 찾아 재사용한다.
    const listed = must(await client.listGroups({ company, limit: 100 }), `${key} 목록`).items;
    for (const g of listed) if ((await client.getMyMembership({ groupId: g.id })).data?.groupId) { groupId = state.groups[key] = g.id; save(); break; }
    if (groupId) log(`  [${key}] 기존 그룹 재사용`);
  }
  if (!groupId) {
    const report = must(await client.getReport({ reportId: state.reports[owner] }), '개설자 사례');
    const draft = draftGroup({ fields: report.fields });
    if (draft.error) throw Error(`그룹 초안 실패: ${draft.error}`);
    const { needsCheck, ...input } = draft;
    const name = input.name.startsWith(EXAMPLE) ? input.name : (EXAMPLE + input.name).slice(0, 100);
    const g = must(await client.createGroup({ reportId: state.reports[owner], ...input, name, goal: 20 }), `${key} 생성`);
    groupId = state.groups[key] = g.groupId; save();
    log(`  [${key}] 그룹 생성: ${name}`);
  }
  for (const id of rest) {
    const c = (await api(id)).client;
    const mine = (await c.getMyMembership({ groupId })).data;
    if (mine?.groupId && !mine.leftAt) continue;
    must(await c.joinGroup({ groupId, reportId: state.reports[id] }), `${id} 참여`);
    log(`  [${key}] 참여: ${byId[id].nickname} → ${company}`);
  }
}

// ---------------------------------------------------------------- 투표 (그룹별)
const owner = key => GROUPS[key].members[0];
const rep = async key => (await api(owner(key))).client;
const getGroup = async key => must(await (await rep(key)).getGroup({ groupId: state.groups[key] }), `${key} 조회`);
const summary = async (key, pollId) => must(await (await rep(key)).getVoteSummary({ pollId }), `${key} 투표 조회`);

// 개설자 알림(poll_started)에서 투표 ID를 찾는다. 상태 파일에 있으면 그것을 쓴다.
async function latestPoll(key, kind) {
  const polls = state.polls[key] ??= {};
  if (polls[kind]) return polls[kind];
  const client = await rep(key); let cursor = null;
  do {
    const page = must(await client.listNotifications({ cursor, limit: 100 }), '알림 조회');
    const hit = page.items.find(n => n.type === 'poll_started' && n.groupId === state.groups[key] && n.payload?.kind === kind);
    if (hit) { polls[kind] = hit.payload.poll_id; save(); return polls[kind]; }
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

async function waitFinal(key, pollId, label) {
  for (;;) {
    const s = await summary(key, pollId);
    if (s.isFinalized) return s;
    const wait = new Date(s.closesAt) - Date.now();
    log(`  [${key}] ${label}: ${wait > 0 ? `마감까지 ${Math.ceil(wait / 1000)}초` : '마감됨, 서버 Cron 집계 대기'}…`);
    if (wait < -5 * 60_000) throw Error(`[${key}] ${label}이 마감 5분이 지나도 집계되지 않았습니다. hande-close-due-votes Cron을 확인하세요.`);
    await sleep(Math.min(Math.max(wait + 2000, 5000), 15000));
  }
}

async function openPoll(key, kind, opensAt, closesAt) {
  const pollId = must(await (await rep(key)).openPoll({ groupId: state.groups[key], kind,
    opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }), `[${key}] ${kind} 투표 개시`).pollId;
  (state.polls[key] ??= {})[kind] = pollId; save();
  return pollId;
}

async function representativeElection(key) {
  const cfg = GROUPS[key];
  const g = await getGroup(key);
  if (g.subStatus !== 'recruiting' && g.subStatus !== 'rep_election') return log(`  [${key}] 대표자 선출: 완료됨(건너뜀)`);
  let pollId = await latestPoll(key, 'representative');
  let s = pollId && await summary(key, pollId);
  if (!s || ['tied', 'no_votes', 'cancelled'].includes(s.state)) {
    const opensAt = new Date(Date.now() + 40_000), closesAt = new Date(opensAt.getTime() + 60_000);
    pollId = await openPoll(key, 'representative', opensAt, closesAt);
    log(`  [${key}] 대표자 선거 개시: 후보 신청 ~${kst(opensAt)}, 투표 마감 ${kst(closesAt)}`);
    for (const id of cfg.candidates) must(await (await api(id)).client.applyRepresentative({ pollId }), `${id} 후보 신청`);
    s = await summary(key, pollId);
  }
  if (!s.isFinalized) {
    const wait = new Date(s.opensAt) - Date.now();
    if (wait > 0) { log(`  [${key}] 투표 시작까지 ${Math.ceil(wait / 1000)}초 대기`); await sleep(wait + 1500); }
    if (new Date(s.closesAt) > Date.now()) for (const [voter, cand] of Object.entries(cfg.repVotes)) {
      const candidateUserId = (await api(cand)).userId;
      const optionId = s.options.find(o => o.candidateUserId === candidateUserId)?.optionId;
      must(await (await api(voter)).client.castRepresentativeVote({ pollId, optionId }), `${voter} 대표자 투표`);
    }
    s = await waitFinal(key, pollId, '대표자 투표');
  }
  log(`  [${key}] 대표자 투표 결과: ${s.state}`);
  if (s.state !== 'closed') throw Error(`[${key}] 대표자가 선정되지 않았습니다. 다시 실행하면 재투표를 엽니다.`);
}

async function methodVote(key) {
  const cfg = GROUPS[key];
  let g = await getGroup(key);
  if (g.method) return log(`  [${key}] 대응 방법: ${g.method}(건너뜀)`);
  let pollId = await latestPoll(key, 'method');
  let s = pollId && await summary(key, pollId);
  if (!s || ['tied', 'no_votes', 'cancelled'].includes(s.state)) {
    const closesAt = new Date(Date.now() + 75_000);
    pollId = await openPoll(key, 'method', new Date(Date.now() - 1000), closesAt);
    log(`  [${key}] 대응 방법 투표 개시: 마감 ${kst(closesAt)}`);
    s = await summary(key, pollId);
  }
  if (!s.isFinalized) {
    if (new Date(s.closesAt) > Date.now()) for (const [voter, choice] of Object.entries(cfg.methodVotes))
      must(await (await api(voter)).client.castMethodVote({ pollId, choice }), `${voter} 방법 투표`);
    s = await waitFinal(key, pollId, '방법 투표');
  }
  g = await getGroup(key);
  log(`  [${key}] 대응 방법 결과: ${s.state}, method=${g.method}`);
  if (g.method !== 'suit') throw Error(`[${key}] 공동소송(suit)이 선택되지 않았습니다.`);
}

async function electAndDecide(key) { await representativeElection(key); await methodVote(key); }

// 그룹 3: 제안 접수 기간만 열어 둔다(로펌 투표는 열지 않음). 제안이 들어오기 전까지만 변경 가능(DB 규칙).
async function group3Deadline() {
  const g = await getGroup('g3');
  if (g.proposalDeadline && new Date(g.proposalDeadline).getTime() === group3ProposalDeadline.getTime())
    return log(`  [g3] 제안 접수 마감: ${kst(g.proposalDeadline)}(건너뜀)`);
  must(await (await rep('g3')).setProposalDeadline({ groupId: state.groups.g3, deadline: group3ProposalDeadline.toISOString() }), '[g3] 제안 마감 설정');
  log(`  [g3] 제안 접수 기간 설정: ~${kst(group3ProposalDeadline)}`);
}

// 그룹 1: 로펌 C·D 승인 후 짧은 접수 기간 → 제안 제출 → 마감 → 로펌 선택 투표 개시(투표는 하지 않음).
async function group1FirmVote() {
  let g = await getGroup('g1');
  if (g.subStatus === 'firm_vote' || g.subStatus === 'connected') return log('  [g1] 로펌 투표: 이미 열림(건너뜀)');
  const owned = async id => (await (await api(id)).client.listProposals({ groupId: state.groups.g1, limit: 20 })).data?.items ?? [];
  const any = (await Promise.all(FIRMS.map(owned))).flat().length > 0;
  if (!any && (!g.proposalDeadline || new Date(g.proposalDeadline) < Date.now() + 30_000)) {
    const d = new Date(Date.now() + proposalWindowSec * 1000);
    must(await (await rep('g1')).setProposalDeadline({ groupId: state.groups.g1, deadline: d.toISOString() }), '[g1] 제안 마감 설정');
    log(`  [g1] 제안 접수 기간 설정: ~${kst(d)}`);
    g = await getGroup('g1');
  }
  for (const id of FIRMS) {
    if ((await owned(id)).length) continue;
    if (new Date(g.proposalDeadline) <= Date.now()) { log(`  [g1] ${byId[id].firm.firmName}: 제안 마감이 지나 제출하지 못함`); continue; }
    must(await (await api(id)).client.submitProposal({ groupId: state.groups.g1, proposal: byId[id].proposal }), `${id} 제안 제출`);
    log(`  [g1] 제안 제출: ${byId[id].firm.firmName}`);
  }
  const wait = new Date(g.proposalDeadline) - Date.now();
  if (wait > 0) { log(`  [g1] 제안 마감까지 ${Math.ceil(wait / 1000)}초 대기`); await sleep(wait + 2000); }
  await openPoll('g1', 'firm', new Date(Date.now() - 1000), firmVoteClosesAt);
  log(`  [g1] 로펌 선택 투표 개시: 마감 ${kst(firmVoteClosesAt)}`);
}

async function ensureFirm(id) {
  const p = byId[id]; const { client, supabase, userId } = await api(id);
  let firm = (await client.getMyFirm()).data;
  if (!firm) {
    const pdf = samplePdf(p.firm.firmName.replace(/[^\x20-\x7e]/g, '').trim() || id);
    const certPath = `${userId}/${randomUUID()}.pdf`;
    const up = await supabase.storage.from('firm-certs').upload(certPath, pdf, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw Error(`${id} 등록증 업로드 실패: ${up.error.message}`);
    firm = must(await client.createFirmApplication({ ...p.firm, certPath }), `${id} 로펌 신청`);
    log(`  로펌 신청: ${firm.firmName} (${firm.approvalStatus})`);
  }
  state.firms[id] = { firmId: firm.id, approvalStatus: firm.approvalStatus, bizStatus: firm.bizStatus }; save();
  return firm;
}

const APPROVAL_SQL = `-- hande_dev(jnpbuulrmgdkzbiywjtd) SQL Editor에서만 실행 (supabase/operations/dev-demo-approve-firms.sql과 같음)
update public.firms f set approval_status='approved', biz_status='active', biz_checked_at=now(), reviewed_at=now(), updated_at=now()
  from auth.users u where u.id=f.owner_id and u.email in ('demo-firm-c@example.invalid','demo-firm-d@example.invalid') and f.approval_status='pending';`;

async function report() {
  log('\n===== 결과 =====');
  for (const p of PEOPLE) if (state.accounts[p.id]) log(`  ${p.email.padEnd(32)} ${p.role}`);
  const anon = createBackendClient(createClient(url, key, { auth: { persistSession: false } }));
  for (const [k, gid] of Object.entries(state.groups)) {
    const g = must(await anon.getGroup({ groupId: gid }), '그룹');
    log(`그룹 ${k}: ${g.name} | ${g.status}/${g.subStatus} | 참여 ${g.memberCount}명 | method=${g.method ?? '-'} | 제안마감=${g.proposalDeadline ? kst(g.proposalDeadline) : '-'}`);
    for (const [kind, pid] of Object.entries(state.polls[k] ?? {})) {
      const s = await summary(k, pid);
      log(`  투표 ${kind}: ${s.state}${s.isFinalized ? '(확정)' : ''} | 마감 ${kst(s.closesAt)} | ${s.options.map(o => `${o.label}:${o.voteCount}`).join(', ')}`);
    }
  }
  for (const [id, f] of Object.entries(state.firms)) log(`로펌 ${byId[id].firm.firmName}: approval=${f.approvalStatus}, biz=${f.bizStatus}`);
}

// ---------------------------------------------------------------- 실행
try {
  log(`대상: hande_dev (${DEV_REF})`);
  log('[1] 계정·프로필'); for (const p of PEOPLE) await api(p.id);
  log('[2] 피해 사례 저장·확정 (A는 계정만)'); for (const id of VICTIMS) await ensureReport(id);
  log('[3] 증빙'); for (const id of Object.keys(EVIDENCE)) await ensureEvidence(id);
  log('[4] 그룹'); for (const k of Object.keys(GROUPS)) await ensureGroup(k);
  log('[5] 로펌 가입·신청'); const firms = []; for (const id of FIRMS) firms.push(await ensureFirm(id));
  log('[6] 그룹 1·3 대표자 선출 → 대응 방법 투표 (동시 진행)'); await Promise.all([electAndDecide('g1'), electAndDecide('g3')]);
  log('[7] 그룹 3 제안 접수 기간'); await group3Deadline();
  log('[8] 그룹 1 제안 접수·로펌 선택 투표');
  if (firms.every(f => f.approvalStatus === 'approved' && f.bizStatus === 'active')) await group1FirmVote();
  else { log(`  로펌 승인 대기 중. 아래 SQL을 hande_dev 대시보드에서 실행한 뒤 다시 실행하세요.\n\n${APPROVAL_SQL}\n`); process.exitCode = 2; }
  await report();
} catch (e) {
  console.error(`\n실패: ${e.message}`); process.exitCode = 1;
} finally {
  await Promise.all(Object.values(sessions).map(s => s.client.signOut()));
}
