#!/usr/bin/env node
/**
 * model-router doctor —— 升级后自检
 *
 * 用法：
 *   node doctor.js            完整检查（扫描 claude.exe + 查 transcript 实测），全程不联网、不读凭据
 *   node doctor.js --gateway  另外用 settings 里的凭据问网关有没有同族新版模型（模型换代时用）
 *   node doctor.js --quick    快速检查（只读 settings.json，毫秒级，适合挂 SessionStart hook）
 *   node doctor.js --quiet    只在发现问题时输出（配合 --quick 用）
 *
 * 设计要点：所有从二进制提取的模式都基于**数据字面量**（模型别名、字段名、档位名），
 * 不依赖 minify 后的变量名 —— 变量名每次构建都会变，数据不会。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUICK = process.argv.includes('--quick');
const QUIET = process.argv.includes('--quiet');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const STATE_FILE = path.join(__dirname, '.last-check.json');

// 本方案依赖的东西，集中在这里，改方案时改这里
const EXPECTED = {
  // null = 不强制特定主模型，只校验它是合法别名。用户可自由 /model 切换
  model: null,
  aliases: ['sonnet', 'fable', 'opus', 'haiku'],
  efforts: ['high', 'xhigh', 'low'],
  // model: null 表示这个文件不该有 model 字段（斜杠命令的 model 实测不生效）
  files: [
    { p: path.join(CLAUDE_DIR, 'agents', 'planner-fable.md'), model: 'fable' },
    { p: path.join(CLAUDE_DIR, 'agents', 'code-reviewer.md'), model: 'opus' },
    { p: path.join(CLAUDE_DIR, 'commands', 'plan-fable.md'), model: null },
    { p: path.join(CLAUDE_DIR, 'commands', 'route.md'), model: null },
  ],
};

const results = [];
const add = (level, msg, fix) => results.push({ level, msg, fix });
const ok = (m) => add('ok', m);
const warn = (m, fix) => add('warn', m, fix);
const err = (m, fix) => add('err', m, fix);

// ---------- 定位 claude.exe ----------
function findClaudeBinary() {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'claude.exe' : 'claude';
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin', exe),
    path.join(HOME, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin', exe),
    path.join(HOME, '.local/share/claude-code/bin', exe),
    path.join(HOME, '.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin', exe),
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/' + exe,
  ];
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) return c; } catch { /* 继续找 */ }
  }
  // 兜底：顺着 PATH 里的 claude 启动脚本找
  try {
    const { execSync } = require('child_process');
    const cmd = isWin ? 'where claude' : 'which claude';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const guess = path.join(path.dirname(line.trim()),
        'node_modules/@anthropic-ai/claude-code/bin', exe);
      try { if (fs.statSync(guess).isFile()) return guess; } catch { /* 下一个 */ }
      // macOS / Linux：PATH 里的 claude 是符号链接，顺着找到本体（原生安装在 ~/.local/share/claude/versions/<版本>，
      // npm 安装在 <前缀>/lib/node_modules/…）。启动脚本只有几 KB，按体积排除，免得把脚本当二进制扫
      try { const real = fs.realpathSync(line.trim()); if (fs.statSync(real).size > 1e6) return real; } catch { /* 下一个 */ }
    }
  } catch { /* 没有 claude 也不致命 */ }
  return null;
}

/**
 * 分块扫描二进制。337MB 一次性转字符串会撞 node 的 string 上限，
 * 所以按块读 + 块间重叠，避免模式被块边界切断。
 */
function scanBinary(binPath, patterns) {
  const CHUNK = 32 * 1024 * 1024;
  const OVERLAP = 4096;
  const found = Object.fromEntries(Object.keys(patterns).map((k) => [k, new Set()]));
  const fd = fs.openSync(binPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0, tail = '';
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      // latin1：字节值 1:1 映射到码点，ASCII 模式匹配安全且不会抛错
      const text = tail + buf.subarray(0, n).toString('latin1');
      for (const [key, re] of Object.entries(patterns)) {
        const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let m;
        while ((m = rx.exec(text)) !== null) found[key].add(m[0]);
      }
      tail = text.slice(-OVERLAP);
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

// ---------- 检查 1：settings.json（quick 模式只做这些） ----------
let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  err(`settings.json 读不了或不是合法 JSON：${e.message}`,
      `检查 ${SETTINGS}，或从 settings.json.pre-model-router.* 备份恢复`);
}

if (settings) {
  const env = settings.env || {};

  // 最关键的一条：这个变量会短路掉子代理 frontmatter 的 model，且失效是静默的
  if (env.CLAUDE_CODE_SUBAGENT_MODEL && env.CLAUDE_CODE_SUBAGENT_MODEL !== 'inherit') {
    err(`env.CLAUDE_CODE_SUBAGENT_MODEL 又出现了（= "${env.CLAUDE_CODE_SUBAGENT_MODEL}"）`,
        'code-reviewer 的 model: opus 正在被静默降级。从 settings.json 的 env 里删掉这一行。' +
        '（zh-cn 插件的 install.ps1 覆盖配置时可能把它带回来）');
  } else {
    ok('CLAUDE_CODE_SUBAGENT_MODEL 未设置，子代理 frontmatter 的 model 生效');
  }

  // 主模型是什么由用户自己定，这里只报告实际生效的那个，不指手画脚。
  // 解析优先级（已核对 claude.exe）：--model > agent frontmatter > env.ANTHROPIC_MODEL > settings.model
  // 会话内 /model 切换优先级最高，但那是运行时状态，配置文件里看不到。
  if (env.ANTHROPIC_MODEL) {
    ok(`主模型 = "${env.ANTHROPIC_MODEL}"（来自 env.ANTHROPIC_MODEL）`);
    if (settings.model) {
      warn(`settings.model = "${settings.model}" 被 env.ANTHROPIC_MODEL 盖掉了，不生效`,
           '两者留一个：想用 settings.model 就删掉 env.ANTHROPIC_MODEL');
    }
  } else if (settings.model) {
    ok(`主模型 = "${settings.model}"（来自 settings.model）`);
  } else {
    ok('未设主模型，回落网关默认（会话内 /model 的选择优先于配置文件）');
  }

  if (settings.modelSettings && Object.keys(settings.modelSettings).length) {
    ok(`modelSettings 已配置：${Object.keys(settings.modelSettings).join(', ')}`);

    // 换代遗留：/effort 会把完整模型 ID 写成键，模型换代后旧键就成了孤儿，不报错也不生效
    const strip = (s) => String(s).replace(/\[\d+m\]$/i, '').toLowerCase();
    const inUse = new Map();  // 完整 ID → 别名
    for (const [k, v] of Object.entries(env)) {
      const mm = k.match(/^ANTHROPIC_DEFAULT_(\w+)_MODEL$/);
      if (mm) inUse.set(strip(v), mm[1].toLowerCase());
    }
    for (const key of Object.keys(settings.modelSettings)) {
      if (!/^claude-/i.test(key)) continue;
      const alias = inUse.get(strip(key));
      if (!alias) {
        warn(`modelSettings.${key} 对应的模型现在没有被任何 ANTHROPIC_DEFAULT_*_MODEL 使用`,
             '多半是模型换代后的遗留（/effort 写的是完整 ID）。不生效也不报错，可以删掉');
      } else if (settings.modelSettings[alias]) {
        // 09-20 实测：opus + claude-opus-5 两条并存时，transcript 记录的实际 effort 是别名那条
        warn(`modelSettings 里 ${alias} 和 ${key} 指向同一个模型，各写了一个 effort`,
             '两条并存时实际生效哪条容易误判（09-20 实测是别名那条）。只留一条');
      }
    }
  } else {
    warn('settings.json 里没有 modelSettings，各模型的 effort 分档没生效',
         '参考 README「安装」一节补回来');
  }

  // 缓存 TTL：主会话 1h 实测划算，子代理 1h 实测更贵（usage-audit --ttl-sim）
  const subTtl = env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL || settings.subagentPromptCacheTtl ||
                 (env.ENABLE_PROMPT_CACHING_1H ? '1h' : undefined);
  const mainTtl = env.CLAUDE_CODE_PROMPT_CACHE_TTL || settings.promptCacheTtl ||
                  (env.ENABLE_PROMPT_CACHING_1H ? '1h' : undefined);
  if (env.FORCE_PROMPT_CACHING_5M) {
    warn('env.FORCE_PROMPT_CACHING_5M 已设置，所有 TTL 配置都被强制成 5 分钟', '不是有意为之就删掉');
  } else {
    ok(`缓存 TTL：主会话 ${mainTtl || '5m（默认）'} · 子代理 ${subTtl || '5m（默认）'}`);
    if (subTtl === '1h') {
      warn('子代理的缓存 TTL 被设成了 1h',
           '实测子代理连续干活、很少停超 5 分钟，1h 只会让每次写入贵 60%。' +
           (env.ENABLE_PROMPT_CACHING_1H ? 'ENABLE_PROMPT_CACHING_1H 会同时作用于主会话和子代理，改用 settings.promptCacheTtl 只管主会话' : '删掉 subagentPromptCacheTtl'));
    }
  }

  if (!env.CLAUDE_CODE_USE_POWERSHELL_TOOL) {
    warn('未启用 CLAUDE_CODE_USE_POWERSHELL_TOOL', '想用 PowerShell 工具的话设为 "1"');
  }
}

// ---------- 检查 2：命令与子代理文件 ----------
for (const f of EXPECTED.files) {
  const rel = f.p.replace(HOME, '~');
  if (!fs.existsSync(f.p)) {
    err(`缺文件：${rel}`, '从 plugins/model-router/{commands,agents}/ 复制一份回去');
    continue;
  }
  const head = fs.readFileSync(f.p, 'utf8').slice(0, 800);
  const m = head.match(/^model:\s*(\S+)\s*$/m);
  if (f.model === null) {
    // 斜杠命令的 model 字段实测不生效，留着只会让人以为规划真跑在 fable 上
    if (m) warn(`${rel} 里有 model: ${m[1]}，但斜杠命令的 model 不生效`,
                '删掉这个字段；要指定模型得走 agent 路径');
    else ok(`${rel} 存在（入口命令，无 model 字段，符合预期）`);
    continue;
  }
  if (!m) err(`${rel} 的 frontmatter 里没有 model 字段`, `补上 model: ${f.model}`);
  else if (m[1] !== f.model) warn(`${rel} 的 model = ${m[1]}，预期 ${f.model}`);
  else ok(`${rel} → ${m[1]}`);
}

// 流程文件里写死的版本号：新模型上线后这些地方不会跟着切，而且不报错
const PINNED = /claude-(?:opus|sonnet|fable|haiku)-\d[\w.-]*/g;
const pinnedHits = [];
for (const f of EXPECTED.files) {
  let lines; try { lines = fs.readFileSync(f.p, 'utf8').split('\n'); } catch { continue; }
  lines.forEach((l, i) => { for (const hit of l.match(PINNED) || []) pinnedHits.push(`${path.basename(f.p)}:${i + 1} ${hit}`); });
}
if (pinnedHits.length) {
  warn(`流程文件里写死了 ${pinnedHits.length} 处模型版本号：${pinnedHits.slice(0, 5).join('，')}${pinnedHits.length > 5 ? ' …' : ''}`,
       '只写别名（fable / opus / sonnet），版本交给 settings.json 的 ANTHROPIC_DEFAULT_*_MODEL；说明文字里要提版本也改成「由 env 决定」');
} else {
  ok('流程文件里没有写死模型版本号（只用别名）');
}
if (!fs.existsSync(path.join(__dirname, 'route-check.js'))) {
  err('缺 route-check.js', '/route 靠它核实每个子代理实际跑的模型，从插件仓库恢复');
}

// usage-audit 的单价表跟不上换代：没进表的模型按 _default 估，账面会偏（10-09 sonnet-5-5 虚高 22% 一周没人发现）
// 只读 usage-audit.js 的文本、取 PRICE 的键，不执行它
{
  let priceKeys = null;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'usage-audit.js'), 'utf8');
    const block = (src.match(/const PRICE = \{([\s\S]*?)\n\};/) || [])[1];
    if (block) priceKeys = new Set([...block.matchAll(/'([^']+)'\s*:/g)].map((x) => x[1]));
  } catch { /* 没有 usage-audit.js 就不查 */ }
  if (priceKeys && settings) {
    const unpriced = Object.entries(settings.env || {})
      .filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(k))
      .map(([, v]) => String(v).replace(/\[\d+m\]$/i, '').replace(/^claude-/, ''))
      .filter((key) => !priceKeys.has(key) && !priceKeys.has(key.replace(/-\d{8}$/, '')));
    if (unpriced.length) {
      warn(`usage-audit 的单价表里没有 ${[...new Set(unpriced)].join('、')}，花费会按默认价估`,
           '在 usage-audit.js 的 PRICE 里补一行；拿不到账单就先按同族上一代的价，注释写明是估的');
    } else {
      ok('env 钉的模型在 usage-audit 单价表里都有价');
    }
  }
}

// 几个别名钉同一个模型（比如第三方供应商全映射到一个模型省钱）：CLI 分不清子代理是哪个角色，
// 各角色的 effort 会套成同一档（10-26 DeepSeek 全映射 flash 实测：sonnet 配 high，实际跑 xhigh）。不是错，说一声
if (settings) {
  const byId = {};
  for (const [k, v] of Object.entries(settings.env || {})) {
    const a = (k.match(/^ANTHROPIC_DEFAULT_([A-Z]+)_MODEL$/) || [])[1];
    if (a) (byId[String(v).replace(/\[\d+m\]$/i, '')] ||= []).push(a.toLowerCase());
  }
  for (const [id, as] of Object.entries(byId)) {
    if (as.length > 1) ok(`ℹ ${as.join('/')} 都钉到 ${id}：这几个角色的 effort 分不开，会套成同一档（modelSettings 里按别名配的不同档位不起作用）`);
  }
}

// 换供应商漏映射：当前供应商不是 Claude 系（env 里有模型 ID 不以 claude- 开头），而 /route 用的别名里有没映射的，
// CLI 会拿内置的 Claude 模型 ID 去请求，那家没有这个模型，用这个别名的子代理直接失败，事前没有任何提示。
// 中转 Claude 的网关没钉别名没事（内置 ID 本来就能用），所以只在判出「非 Claude」时才查；快速模式、完整模式都跑。
// Bedrock / Bedrock Mantle / Vertex / Foundry 不查：这四个平台的模型 ID（us.anthropic.claude-…、anthropic.claude-opus-4-7、ARN）不以 claude- 开头，但 CLI 在这些平台上自己负责别名映射（用各平台自己的内置 ID），别名没映射不会失败
// 判定（thirdPartyPins 和下面的 cloudOn）在 configure.js 里有一份一模一样的（thirdPartyKeys、cloudPlatform），改要两边一起改。只打印别名和模型 ID，不打印 env 里别的值（token、URL；Bedrock 的 ARN 里有账号号码，所以云平台一律不进这段）
{
  const env = settings && settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  const CLI_ALIASES = ['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'best', 'default'];   // ANTHROPIC_MODEL 可以直接写别名（opus、sonnet[1m]…），别名不是第三方信号
  // CLI 的写法：1 / true / yes / on，不分大小写（settings.json 里写成 JSON 的 true / 1 也算：CLI 把它们转成字符串再判）。settings 的 env 里有这个键就以它为准（CLI 启动时它盖过外面 shell 里的同名变量），没有才看 shell 里的
  const truthy = (v) => (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') && ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
  const cloudOn = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some((k) => truthy(Object.prototype.hasOwnProperty.call(env, k) ? env[k] : process.env[k]));
  const pinOf = (k) => (typeof env[k] === 'string' ? env[k].replace(/\[\w+\]\s*$/, '').trim() : '');
  const thirdPartyPins = () => ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_MODEL']
    .map((k) => [k, pinOf(k)])
    .filter(([k, id]) => id && !/^claude-/i.test(id) && !(k === 'ANTHROPIC_MODEL' && CLI_ALIASES.includes(id.toLowerCase())));
  const third = cloudOn ? [] : thirdPartyPins();
  if (third.length) {
    const byId = Object.create(null);   // 依据：哪些别名（或主模型）钉到了哪个非 Claude 的模型 ID，同一个 ID 的并成一组
    for (const [k, id] of third) (byId[id] ||= []).push(k === 'ANTHROPIC_MODEL' ? '主模型' : k.replace(/^ANTHROPIC_DEFAULT_|_MODEL$/g, '').toLowerCase());
    const basis = Object.entries(byId).map(([id, ks]) => `${ks.join('/')} 钉的是 ${id}`).join('，');
    const ROLE = { fable: '规划', opus: '审查', sonnet: '实现' };
    let missed = 0;
    for (const a of ['fable', 'opus', 'sonnet', 'haiku']) {
      const key = `ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`;
      if (pinOf(key)) continue;
      missed++;
      const fix = `在 CC Switch 的卡片里把 ${key} 映射到这家的模型（没有 CC Switch 就在 settings.json 的 env 里写）`;
      if (a === 'haiku') warn(`${a} 没映射：当前供应商的模型不是 Claude（${basis}），CLI 的后台小任务用 ${a}，会去要 Claude 的模型`, fix);
      else err(`${a} 没映射：当前供应商的模型不是 Claude（${basis}），用 ${a} 的子代理（${ROLE[a]}）会去要 Claude 的模型、直接失败`, fix);
    }
    if (!missed) ok(`换供应商检查：当前供应商的模型不是 Claude（${basis}），fable / opus / sonnet / haiku 都已映射`);
  }
}

// ---------- 检查 3：CLI 版本是否变过 ----------
const bin = findClaudeBinary();
let curVersion = null;
try {
  const pkg = bin ? path.join(bin, '../../package.json') : null;
  if (pkg && fs.existsSync(pkg)) curVersion = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  else if (bin) curVersion = (bin.match(/versions[\\/](\d+\.\d+\.\d+)/) || [])[1] || null;   // 原生安装没有 package.json，版本号在路径里
} catch { /* 版本读不到不致命 */ }

let prev = null;
try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 首次运行 */ }

if (QUICK) {
  if (curVersion && prev && prev.version && prev.version !== curVersion) {
    warn(`Claude Code 从 ${prev.version} 变成了 ${curVersion}`,
         '跑一次完整检查：node ' + path.join(__dirname, 'doctor.js'));
  }
} else {
  // ---------- 检查 4：完整模式，扫二进制确认字段与别名仍被识别 ----------
  if (!bin) {
    warn('没找到 claude 可执行文件，跳过二进制校验', '手动指定路径或只跑 --quick');
  } else {
    if (!QUIET) console.log(`扫描 ${bin.replace(HOME, '~')} …\n`);
    // env 里钉的每个模型 ID 都在二进制里原样找一遍：找不到 = CLI 没有它的能力数据
    const envModelIds = Object.entries(settings?.env || {})
      .filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(k))
      .map(([k, v]) => [k, String(v).replace(/\[\d+m\]$/i, '')]);
    const idPatterns = Object.fromEntries(envModelIds.map(([k, id]) =>
      [`id:${k}`, new RegExp(`"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)]));
    const scanned = scanBinary(bin, {
      // 元素都是带引号的字符串，[^"]* 能安全吃掉 "sonnet[1m]" 里的方括号
      aliasList: /\["sonnet","opus","haiku"(?:,"[^"]*")*\]/,
      effortList: /\["low","medium","high"(?:,"[^"]*")*\]/,
      modelSettingsKey: /modelSettings/,
      effortLevelKey: /effortLevel/,
      promptCacheTtlKey: /promptCacheTtl/,
      knownModels: /\["claude-3-5-haiku"(?:,"[^"]*")*\]/,
      ...idPatterns,
    });

    // 取最长的一条作为主别名白名单
    const aliasRaw = [...scanned.aliasList].sort((a, b) => b.length - a.length)[0];
    const aliases = aliasRaw ? JSON.parse(aliasRaw) : [];
    if (!aliases.length) {
      warn('没能从二进制里提取模型别名白名单', 'CLI 内部结构可能变了，手动 /model 确认可用别名');
    } else {
      const missing = EXPECTED.aliases.filter((a) => !aliases.includes(a));
      if (missing.length) {
        err(`这些别名在当前 CLI 里已不合法：${missing.join(', ')}`,
            `当前支持：${aliases.join(', ')} —— 改用其中之一`);
      } else {
        ok(`模型别名全部有效：${EXPECTED.aliases.join(', ')}`);
      }

      // 校验实际生效的主模型。它可能是 opusplan/best 这类不在 EXPECTED.aliases 里的值，
      // 也可能是 env.ANTHROPIC_MODEL 里的完整 model ID（那种不是别名，跳过别名校验）。
      // 完整 ID 的判据是含 -（claude-opus-5-5、deepseek-flash）；不是 claude- 开头的是第三方供应商的模型，CLI 本来就不认识，不算错
      const effective = (settings && (settings.env?.ANTHROPIC_MODEL || settings.model)) || null;
      if (effective) {
        const strip = (s) => String(s).replace(/\[\d+m\]$/i, '').toLowerCase();
        const isAlias = aliases.some((a) => strip(a) === strip(effective));
        const isFullId = strip(effective).includes('-');
        if (!isAlias && !isFullId) {
          err(`主模型 "${effective}" 既不是合法别名也不像 model ID`,
              `合法别名：${aliases.join(', ')}`);
        } else if (!isAlias && !/^claude-/i.test(strip(effective))) {
          ok(`主模型 "${effective}" 是完整模型 ID（第三方模型），CLI 不校验，以供应商的模型名为准`);
        }
      }
    }

    const effRaw = [...scanned.effortList].sort((a, b) => b.length - a.length)[0];
    const efforts = effRaw ? JSON.parse(effRaw) : [];
    if (efforts.length) {
      const bad = EXPECTED.efforts.filter((e) => !efforts.includes(e));
      if (bad.length) err(`effort 档位已失效：${bad.join(', ')}`, `当前支持：${efforts.join(', ')}`);
      else ok(`effort 档位全部有效：${EXPECTED.efforts.join(', ')}`);
    }

    if (scanned.modelSettingsKey.size) ok('CLI 仍识别 modelSettings 字段');
    else err('CLI 里找不到 modelSettings 字段了',
             '这是未文档化字段，可能已被改名/移除。此时各模型的 effort 分档会静默回落到顶层 effortLevel');

    if (scanned.effortLevelKey.size) ok('CLI 仍识别 effortLevel 字段');
    else warn('CLI 里找不到 effortLevel 字段了');

    if (settings?.promptCacheTtl && !scanned.promptCacheTtlKey.size) {
      err('settings.promptCacheTtl 已设置，但当前 CLI 里找不到这个字段了',
          '字段可能被改名/移除，主会话的 1h 缓存已静默失效，回到 5 分钟');
    }

    // CLI 不认识的模型：effort/xhigh 是否支持靠默认推断，可能静默降档
    for (const [k, id] of envModelIds) {
      if (scanned[`id:${k}`]?.size) continue;
      // 第三方模型（DeepSeek 等）CLI 本来就不认识，能力要靠 <变量>_SUPPORTED_CAPABILITIES 声明：CLI 按模型 ID 识别 effort / thinking，认不出就可能不发
      if (!/^claude-/i.test(id)) {
        const caps = (settings?.env || {})[`${k}_SUPPORTED_CAPABILITIES`];
        if (caps) ok(`${k} = "${id}"：第三方模型，已声明能力 ${caps}`);
        else warn(`${k} = "${id}"：第三方模型，没声明 ${k}_SUPPORTED_CAPABILITIES`,
          'CLI 认不出它支持什么，可能不发 effort / thinking 参数，你配的 effort 档位就不生效。供应商支持的话加上，' +
          '如 effort,xhigh_effort,max_effort,thinking,adaptive_thinking（DeepSeek 10-26 实测这几种写法接口都接受）');
        continue;
      }
      warn(`${k} = "${id}"：当前 CLI 里没有这个模型的能力数据`,
           '通常是模型比 CLI 新（靠 env 透传）。effort 档位由默认规则推断，可能被静默降档——' +
           '用 transcript 里每条记录的 "effort" 字段核实实际档位，别只看配置');
    }

    // 模型更新提示：env 钉的 ID 与 CLI 已知列表比对
    const kmRaw = [...scanned.knownModels].sort((a, b) => b.length - a.length)[0];
    if (kmRaw && settings) {
      const known = JSON.parse(kmRaw);
      const envModels = Object.entries(settings.env || {})
        .filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(k));
      for (const [k, v] of envModels) {
        const family = k.match(/^ANTHROPIC_DEFAULT_(\w+)_MODEL$/)[1].toLowerCase();
        const bare = String(v).replace(/\[\d+m\]$/i, '');
        // 只放过日期后缀（claude-haiku-4-5-20251001）。
        // ⚠️ 不能用裸 startsWith：09-30 "claude-opus-5-5".startsWith("claude-opus-5") 为真，
        // 换代的新模型被当成已知、漏报。CLI 是否认识某 ID 由上面的原样搜索判定。
        const recognised = known.some((m) => bare === m || new RegExp(`^${m}-\\d{8}$`).test(bare));
        const newest = known.filter((m) => m.includes(family)).sort().pop();

        if (!recognised) {
          // 是否真的不认识已由原样搜索报过；这里只在列表层面不重复报警
        } else if (newest && newest > bare && !newest.startsWith(bare)) {
          // 例如 CLI 已知 claude-sonnet-6，而 env 还钉在 claude-sonnet-5
          warn(`${k} = "${v}"，但 CLI 已知同族更新的 ${newest}`,
               '若中转站已上线，更新此变量即可用上新模型');
        }
      }
      ok(`CLI 已知模型 ${known.length} 个，最新：${known.slice(-3).join(', ')}`);
    }
  }

  // 记下这次检查的版本
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(
      { version: curVersion, checkedAt: new Date().toISOString() }, null, 2));
  } catch { /* 写不了状态文件不致命 */ }
}

// ---------- 检查 5：实测（完整模式）——配置说了不算，看实际跑的是什么 ----------
// 09-20 教训：读代码推断 effort 生效档位，结论是反的；transcript 里的实测字段才是真相。

const bareId = (s) => String(s).replace(/\[\d+m\]$/i, '');
const famOf = (id) => (String(id).match(/^claude-([a-z]+)-/) || [])[1] || null;
// claude-opus-5-5 → [5,5]；claude-sonnet-4-5-20250929 → [4,5]（去掉日期）
const verOf = (id) => bareId(id).replace(/-\d{8}$/, '').split('-').slice(2).map(Number).filter((n) => !isNaN(n));
const cmpVer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; }
  return 0;
};
const envPins = Object.entries(settings?.env || {})
  .map(([k, v]) => [k, (k.match(/^ANTHROPIC_DEFAULT_([A-Z]+)_MODEL$/) || [])[1], bareId(v)])
  .filter(([, fam]) => fam)
  .map(([k, fam, id]) => ({ key: k, fam: fam.toLowerCase(), id }));

/**
 * 问网关有哪些模型：同族出了新版而 env 还钉旧版 → 主会话和所有子代理都还在旧版
 * 要用凭据，所以默认不跑（使用方不希望工具碰 key），加 --gateway 才跑
 */
async function checkGatewayModels() {
  if (!process.argv.includes('--gateway')) {
    ok('跳过网关新版检查（默认不读凭据；模型换代时加 --gateway 跑一次）');
    return;
  }
  const env = settings?.env || {};
  const base = (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!base || !token) return;
  let ids;
  try {
    const res = await fetch(`${base}/v1/models?limit=200`, {
      headers: { 'x-api-key': token, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ids = ((await res.json()).data || []).map((m) => m.id);
  } catch (e) {
    // 只报状态，别把请求头（含 token）带进输出
    warn(`查不到网关的模型列表（${e.name === 'TimeoutError' ? '超时' : e.message}），跳过新版检查`,
         '网络恢复后再加 --gateway 跑一次');
    return;
  }
  const fine = [];
  for (const p of envPins) {
    // 第三方模型没有「同族新版」可比，只看网关列表里有没有它
    if (!famOf(p.id)) {
      if (ids.includes(p.id)) fine.push(p.id);
      else warn(`${p.key} = "${p.id}" 不在网关的模型列表里`, `网关可用：${ids.slice(0, 20).join(', ')}`);
      continue;
    }
    const same = ids.filter((id) => famOf(id) === p.fam);
    if (!same.length) continue;
    const newest = same.sort((a, b) => cmpVer(verOf(b), verOf(a)))[0];
    if (!ids.includes(p.id)) {
      warn(`${p.key} = "${p.id}" 不在网关的模型列表里`, `网关同族可用：${same.join(', ')}`);
    } else if (cmpVer(verOf(newest), verOf(p.id)) > 0) {
      warn(`网关已上线 ${newest}，但 ${p.key} 还钉在 ${p.id}`,
           '主会话和所有用这个别名的子代理都还在旧版。改这一行（连同 _NAME 那行），保留 [1M] 后缀，下个会话生效');
    } else {
      fine.push(p.id);
    }
  }
  if (fine.length) ok(`网关模型：env 钉的已是各家族最新版（${fine.join(' / ')}）`);
}

/** 从 transcript 看子代理实际跑的版本，以及 1h 缓存是否真的在写 */
function checkTranscripts() {
  const root = path.join(CLAUDE_DIR, 'projects');
  const since = Date.now() - 14 * 864e5;
  const latestSub = {};        // 家族 → { id, ts }
  const subModelTs = new Map(); // 子代理记录里出现过的每个模型 ID（小写、去 [1m]）→ 最近一次时间；第三方钉值靠它核对，famOf 对它们返回 null
  const mainWrites = [];       // { ts, w5, w1h }
  const walk = function* (d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) yield* walk(p);
      else if (e.name.endsWith('.jsonl')) yield p;
    }
  };
  for (const f of walk(root)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const isSub = /[\\/]subagents[\\/]/.test(f);
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.indexOf('"usage"') === -1) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (!m?.usage || !m.model || m.model === '<synthetic>' || !o.timestamp) continue;
      const ts = Date.parse(o.timestamp);
      if (isSub) {
        const mid = bareId(m.model).toLowerCase();
        if (ts > (subModelTs.get(mid) || 0)) subModelTs.set(mid, ts);
        const fam = famOf(m.model);
        if (fam && (!latestSub[fam] || ts > latestSub[fam].ts)) latestSub[fam] = { id: m.model, ts };
      } else if ((m.usage.cache_creation_input_tokens || 0) > 0) {
        const cc = m.usage.cache_creation || {};
        mainWrites.push({ ts, w5: cc.ephemeral_5m_input_tokens || 0, w1h: cc.ephemeral_1h_input_tokens || 0 });
      }
    }
  }

  const day = (ts) => new Date(ts).toISOString().slice(5, 10);
  const matched = [];
  const thirdParty = new Map();   // 钉的第三方模型 ID → 钉了它的别名们
  for (const p of envPins) {
    // 钉的不是 Claude 的模型（DeepSeek 等第三方）：没有「家族最新版」可比，只看最近有没有子代理真的跑过这个 ID。
    // 不能拿 Claude 家族的最近记录去比——那会在每次切回 Claude 之后误报「子代理没跟上 env」
    if (!/^claude-/i.test(p.id)) {
      const key = p.id.toLowerCase();
      if (!thirdParty.has(key)) thirdParty.set(key, { id: p.id, fams: [] });
      thirdParty.get(key).fams.push(p.fam);
      continue;
    }
    const s = latestSub[p.fam];
    if (!s) continue;
    if (bareId(s.id) === p.id) matched.push(`${p.fam} → ${s.id}（${day(s.ts)}）`);
    else warn(`最近一次 ${p.fam} 子代理（${day(s.ts)}）实际跑的是 ${s.id}，env 现在钉的是 ${p.id}`,
              '那之后还没跑过 /route 就属正常（改 env 之前的记录）；跑过还这样 = 子代理没跟上新版，检查 agent 文件是不是写死了版本号');
  }
  if (matched.length) ok(`子代理实测版本与 env 一致：${matched.join('，')}`);
  for (const [key, t] of thirdParty) {
    const ts = subModelTs.get(key);
    if (ts) ok(`子代理实测跑过 ${t.id}（${t.fams.join('/')} 钉的第三方模型）：最近一次 ${day(ts)}`);
    else ok(`ℹ 最近 14 天还没有子代理跑过 ${t.id}（${t.fams.join('/')} 钉的第三方模型）：钉了之后还没跑过 /route 就正常`);
  }

  const mainTtl = settings?.env?.CLAUDE_CODE_PROMPT_CACHE_TTL || settings?.promptCacheTtl;
  if (mainTtl === '1h') {
    const recent = mainWrites.sort((a, b) => b.ts - a.ts).slice(0, 30);
    const hits = recent.filter((w) => w.w1h > 0).length;
    if (hits) ok(`主会话 1h 缓存实测生效（最近 ${recent.length} 次写入里 ${hits} 次是 1h）`);
    else if (recent.length) warn('配置了 1h 缓存，但最近主会话的缓存写入全是 5 分钟',
                                  '刚改完属正常（热加载，下一次写入起生效）；过一个会话还这样 = 网关忽略了 1h，删掉 promptCacheTtl 免得以为在省钱');
  }
}

// ---------- 输出 ----------
function report() {
  const errs = results.filter((r) => r.level === 'err');
  const warns = results.filter((r) => r.level === 'warn');

  if (QUIET && !errs.length && !warns.length) process.exit(0);

  const icon = { ok: '✅', warn: '⚠️ ', err: '❌' };
  if (!QUIET) {
    console.log('model-router 自检' + (QUICK ? '（快速）' : '（完整）') +
                (curVersion ? `  ·  CLI ${curVersion}` : '') + '\n');
  }
  for (const r of results) {
    if (QUIET && r.level === 'ok') continue;
    console.log(`${icon[r.level]} ${r.msg}`);
    if (r.fix) console.log(`   → ${r.fix}`);
  }

  console.log();
  if (errs.length) {
    console.log(`发现 ${errs.length} 个问题需要处理` + (warns.length ? `，另有 ${warns.length} 项提醒` : ''));
    process.exit(1);
  } else if (warns.length) {
    console.log(`${warns.length} 项提醒，核心配置正常`);
  } else {
    console.log('全部正常');
  }
}

if (QUICK) {
  report();
} else {
  (async () => {
    await checkGatewayModels();
    try { checkTranscripts(); } catch (e) { warn(`读 transcript 失败：${e.message}`); }
    report();
  })();
}
