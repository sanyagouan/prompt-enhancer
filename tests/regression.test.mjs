// prompt-enhancer 回归用例（v1.0.9 固化）
// 跑法：node tests/regression.test.mjs
// 覆盖 v1.0.5-v1.0.8 四类已修 bug 的复现断言 + 模板行为用例。
// 状态层逻辑从 plugin.js 抽取为纯函数镜像（plugin.js 的 stateByEditor/seq 模式），
// plugin.js 改动状态机时必须同步本文件并全量重跑。

import assert from 'node:assert'

// ── 被测逻辑的纯函数镜像（与 plugin.js 保持同步） ──
function createStateStore() {
  const stateByEditor = new Map() // 测试用 Map 替代 WeakMap，以 editorId 为键
  function editorState(id) {
    if (!stateByEditor.has(id)) stateByEditor.set(id, { phase: 'idle', backup: '', lastApplied: '', seq: 0 })
    return stateByEditor.get(id)
  }
  return { editorState, stateByEditor }
}

function isRateLimited(err) {
  return /429|rate.?limit/i.test(`${err?.message ?? ''} ${err?.name ?? ''} ${String(err)}`)
}

const RETRY_DELAYS_MS = [3000, 5000] // 测试中缩水为 [1,1]，断言调用次数而非等待

// 模拟 gw.request 的重试包装（与 plugin.js runEnhance 内循环同构）
async function callWithRetry(mockFn, delays = [1, 1]) {
  let res = null
  for (let attempt = 0; ; attempt++) {
    try {
      res = await mockFn(); break
    } catch (e) {
      if (attempt < delays.length && isRateLimited(e)) {
        await new Promise((r) => setTimeout(r, delays[attempt]))
        continue
      }
      throw e
    }
  }
  return res
}

// ── 用例集 ──
const results = []
function test(name, fn) {
  try { fn(); results.push([name, 'PASS']) }
  catch (e) { results.push([name, `FAIL: ${e.message}`]) }
}
async function atest(name, fn) {
  try { await fn(); results.push([name, 'PASS']) }
  catch (e) { results.push([name, `FAIL: ${e.message}`]) }
}

// [bug#1 v1.0.5] 429 一次即败 → 重试后成功
await atest('R1: 429 重试后成功（v1.0.5 bug 复现防护）', async () => {
  let calls = 0
  const res = await callWithRetry(() => {
    calls++
    if (calls < 2) { const e = new Error('one-shot generation failed: Error code: 429'); e.name = 'JsonRpcGatewayError'; throw e }
    return 'OK'
  })
  assert.equal(res, 'OK'); assert.equal(calls, 2)
})

// [bug#1 伴生] 非 429 不重试
await atest('R2: 非 429 错误不重试', async () => {
  let calls = 0
  try {
    await callWithRetry(() => { calls++; throw new Error('empty') })
    assert.fail('should throw')
  } catch (e) { assert.equal(e.message, 'empty'); assert.equal(calls, 1) }
})

// [bug#1 伴生] 连续 429 耗尽后抛出
await atest('R3: 重试耗尽后抛出原始错误', async () => {
  let calls = 0
  try {
    await callWithRetry(() => { calls++; throw new Error('Error code: 429') })
    assert.fail('should throw')
  } catch (e) { assert.equal(e.message, 'Error code: 429'); assert.equal(calls, 3) }
})

// [bug#2 v1.0.7] 全局状态导致跨会话取消作废 → seq 必须按实例隔离
test('R4: seq 按 editor 实例隔离，B 取消不作废 A（v1.0.7 bug 防护）', () => {
  const { editorState } = createStateStore()
  const a = editorState('A'); a.seq++; a.phase = 'enhancing'
  const b = editorState('B')
  const bSeq = ++b.seq; b.phase = 'enhancing'
  // B 点取消：作废的是 B 自己的 in-flight 请求
  b.seq++
  assert.equal(a.phase, 'enhancing', 'A 不受 B 取消影响')
  assert.equal(a.seq === editorState('A').seq, true, 'A 的请求仍有效')
  // B 的取消守卫：捕获的 bSeq 已落后于当前 seq → B 的迟到结果作废
  assert.equal(bSeq !== b.seq, true, 'B 的请求已作废（B 自己的 seq 已 bump）')
  // 全局共享 seq 的旧 bug 形态：若 seq 是共享计数，B 的 ++ 会让 a.seq !== 全局值 → A 被误作废。
  // 隔离后 A 的 seq 独立，不受 B 的任何操作影响。
  assert.equal(editorState('A').seq, 1, 'A 的 seq 独立计数，未被 B 的 bump 波及')
})

// [bug#2 伴生] 状态隔离：A 完成 B 仍转圈
test('R5: 并发增强状态互不干扰', () => {
  const { editorState } = createStateStore()
  const a = editorState('A'); a.phase = 'enhancing'
  const b = editorState('B'); b.phase = 'enhancing'
  a.phase = 'enhanced'
  assert.equal(b.phase, 'enhancing')
  assert.equal(a.phase, 'enhanced')
})

// [bug#3 v1.0.7] 全局 atom 让所有窗口转圈 → phase 不能是模块级单例
test('R6: 不同 editor 的初始态互不共享', () => {
  const { editorState, stateByEditor } = createStateStore()
  editorState('A').phase = 'enhancing'
  assert.equal(editorState('B').phase, 'idle', 'B 初始必须是 idle（全局 atom 时代 B 会跟着 enhancing）')
  assert.equal(stateByEditor.size, 2)
})

// [模板 v1.0.8] 语音错字修正指令存在且含示例锚点
test('R7: SYSTEM_TEMPLATE 含语音纠错原则与全休→全修示例', () => {
  // 用例读磁盘 plugin.js，防模板被改丢
  const fs = await_import_fs()
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const m = src.match(/const SYSTEM_TEMPLATE = `(.*?)`/s)
  assert.ok(m, 'SYSTEM_TEMPLATE 存在')
  assert.ok(/dictado por voz/.test(m[1]), '含语音输入纠错 (dictado por voz)')
  assert.ok(/«todabia»/.test(m[1]) && /«todavía»/.test(m[1]), '含同音字示例锚点 (todabia→todavía)')
  assert.ok(/déjalo tal cual/.test(m[1]), '含过度改写护栏 (fork es)')
})

// [取消语义] WorkBuddy parity：转圈可点=取消，取消后迟到大结果丢弃
await atest('R8: 等待中取消 → 迟到结果被丢弃', async () => {
  const { editorState } = createStateStore()
  const a = editorState('A')
  a.seq++; const seq = a.seq; a.phase = 'enhancing'
  // 模拟慢请求期间用户取消
  a.seq++; a.phase = 'idle'
  // 迟到结果守卫（与 plugin.js: if (seq !== st.seq) return 同构）
  const guard = seq !== a.seq ? 'DISCARDED' : 'APPLIED'
  assert.equal(guard, 'DISCARDED')
})

// helper：node ESM 里同步读文件
function await_import_fs() {
  // eslint-disable-next-line no-undef
  return process.getBuiltinModule('fs')
}


// [v1.6.0] chip 保真改由官方 setDraft 水化负责（旧 DOM 写回层已随 #121246 审查删除）
test('R9: chip token 走草稿文本保护，模板含 token 保真约束', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  // 识别在 getDraft 返回的文本上（不是 DOM 查询）
  assert.ok(/CHIP_REF_RE\.test\(text\)/.test(src), 'hasChips 走文本正则')
  assert.ok(!/querySelector\('\[data-ref-text\]'\)/.test(src), '不再查 chip DOM')
  // chip 存在时，模板追加 token 保真约束（用户核心诉求：引用标记不丢）
  assert.ok(/Restricción adicional estricta[\s\S]*consérvalos tal cual/.test(src), '模板含 token 原样保留约束 (fork es)')
  const m = src.match(/const SYSTEM_TEMPLATE = `(.*?)`/s)
  assert.ok(m && !/输出格式防误识别/.test(m[1]), '模板无防误识别约束（已回滚）')
})

// R10 (v1.1.0 slash-chip snapshot mirror) removed in v1.6.0: the snapshot/
// write-back layer was deleted with the catalog review #121246 — chip
// hydration is now entirely the official setDraft's job. sdk-only.test.mjs
// pins the new contract.
// [M2] ⌘+click 开关浮层：官方列表 + 我们自己的自定义模型开关；编辑模型
// 入口由宿主 showEditModels: false 隐藏（列表本身已是可见模型列表）。
test('R11: ⌘+click 浮层齐备（开关 / oneshot 透传 / 存储 / 官方菜单）', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/if \(e\?\.metaKey \|\| e\?\.ctrlKey\) return/.test(src), '⌘/Ctrl+click 分流存在（普通点击不中断增强）')
  assert.ok(/const pin = effectivePin\(\)/.test(src), '调用前算 effective pin（开+选齐才生效）')
  assert.ok(!/req\.session_id/.test(src) || /if \(pin\)/.test(src), '裸请求不带 session_id（关=主模型）')
  assert.ok(/req\.provider = pin\.provider/.test(src) && /req\.model = pin\.model/.test(src),
    'oneshot 透传 provider/model（宿主 llm.oneshot 透传补丁配套）')
  assert.ok(/SegmentedControl/.test(src) && /menu\.custom/.test(src) && /menu\.off/.test(src),
    '浮层里有我们自己的 关/开 开关')
  assert.ok(/select: \(model, provider\) => \{ setModelPin\(\{ enabled: true,/.test(src),
    '选模型自动打开开关')
  assert.ok(/showEditModels: false/.test(src), '编辑模型入口隐藏（列表本身已是可见列表）')
  assert.ok(/storageApi\?\.set\('enhanceModel'/.test(src), 'pin 走 ctx.storage 持久化（开关状态同存）')
  assert.ok(/onPointerDownCapture/.test(src) && /metaGesture/.test(src) && /onOpenChange/.test(src),
    'capture 相位记录 metaKey，onOpenChange 否决普通点击开菜单')
  assert.ok(/ModelCatalogMenu/.test(src), '用官方模型选择器组件')
  // menu.follow 已被开关取代，不应残留引用
  assert.ok(!/menu\.follow/.test(src), '旧「清除固定」项已删除')
})

// [M2 伴生] pin 开关语义同构镜像：选模型自动开、关保留选择、effective 判定
test('R12: pin 开关语义（同构镜像）', () => {
  const store = new Map()
  const storageApi = {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k)
  }
  let modelPin = null
  const pinListeners = new Set()
  function loadPin() {
    const v = storageApi?.get('enhanceModel')
    if (v && typeof v === 'object') {
      const provider = typeof v.provider === 'string' ? v.provider : ''
      const model = typeof v.model === 'string' ? v.model : ''
      return { enabled: v.enabled !== false, provider, model }
    }
    return null
  }
  function setModelPin(patch) {
    modelPin = { enabled: false, provider: '', model: '', ...(modelPin ?? {}), ...patch }
    storageApi?.set('enhanceModel', modelPin)
    for (const fn of pinListeners) { fn(modelPin) }
  }
  function effectivePin() {
    return modelPin?.enabled && modelPin.provider && modelPin.model ? modelPin : null
  }
  const seen = []
  pinListeners.add(v => seen.push(v))
  // 选模型 → 自动开
  setModelPin({ enabled: true, model: 'deepseek-flash', provider: 'deepseek' })
  assert.equal(effectivePin().model, 'deepseek-flash', '开+选齐 → 生效')
  assert.equal(loadPin().enabled, true, '开关状态持久化')
  // 关 → 不生效但保留选择
  setModelPin({ enabled: false })
  assert.equal(effectivePin(), null, '关 → 回主模型')
  assert.equal(loadPin().model, 'deepseek-flash', '关保留已选模型')
  assert.equal(seen.length, 2, '两次变更都广播')
  // 旧格式（无 enabled 字段）迁移为开
  store.set('enhanceModel', { provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(loadPin().enabled, true, '旧格式迁移为开')
  // 坏数据 → 默认
  store.set('enhanceModel', { model: 42 })
  assert.equal(loadPin().provider, '', '坏数据归一化，不崩溃')
})
// [fork es] Perfiles + contexto de sesión + cláusula de rigor
test('R13: perfiles (ciclo, storage, sufijos) y session.history presentes', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.ok(/PROFILE_ORDER = \['general', 'tecnico', 'conciso', 'razonamiento'\]/.test(src), 'orden de perfiles')
  assert.ok(/storageApi\?\.set\('enhanceProfile'/.test(src), 'perfil persistido en ctx.storage')
  assert.ok(/PROFILE_SUFFIX\[profileCurrent\]/.test(src), 'sufijo de perfil inyectado en instructions')
  assert.ok(/session\.history/.test(src) && /session_id: sessionId/.test(src), 'contexto vía session.history')
  // Espejo funcional de buildContextBlock (solo lo esencial)
  const CTX_MAX_ROWS = 8, CTX_MAX_ROW_CHARS = 500
  function buildContextBlock(messages) {
    const rows = (Array.isArray(messages) ? messages : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.text === 'string' && m.text.trim() && m?.display_kind !== 'hidden')
      .slice(-CTX_MAX_ROWS)
      .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, CTX_MAX_ROW_CHARS)}`)
    if (!rows.length) return ''
    return rows.join('\n---\n')
  }
  assert.equal(buildContextBlock(undefined), '')
  assert.equal(buildContextBlock([{ role: 'tool', text: 'x' }, { role: 'user', text: '', display_kind: 'visible' }]), '')
  const out = buildContextBlock([
    { role: 'tool', text: 'ignorar' },
    { role: 'user', text: 'hola\n mundo', display_kind: 'visible' },
    { role: 'assistant', text: 'que tal  '.repeat(60) },
    { role: 'user', text: 'última', display_kind: 'hidden' }
  ])
  const lines = out.split('\n---\n')
  assert.equal(lines.length, 2, 'solo user/assistant visibles con texto')
  assert.ok(lines[0].startsWith('Usuario: hola mundo'))
  assert.ok(lines[1].length <= 'Asistente: '.length + CTX_MAX_ROW_CHARS, 'fila recortada a 500 chars')
})
test('R14: cláusula de rigor implícita en SYSTEM_TEMPLATE', () => {
  const fs = process.getBuiltinModule('fs')
  const src = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const m = src.match(/const SYSTEM_TEMPLATE = `(.*?)`/s)
  assert.ok(m, 'SYSTEM_TEMPLATE existe')
  assert.ok(/contrastar antes de afirmar/.test(m[1]), 'exigencia de contraste')
  assert.ok(/admitir lo que se desconozca/.test(m[1]), 'admitir ignorancia')
  assert.ok(/no fuerces esa exigencia/.test(m[1]), 'no forzar en prompts triviales/creativos')
})
// ── 汇总 ──
let fail = 0
for (const [name, r] of results) {
  console.log(`${r === 'PASS' ? '✅' : '❌'} ${name}  ${r === 'PASS' ? '' : r}`)
  if (r !== 'PASS') fail++
}
console.log(`\n${results.length - fail}/${results.length} passed`)
process.exit(fail ? 1 : 0)
