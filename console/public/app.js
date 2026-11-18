/* QQ 控制台前端：原生 JS，无框架、无外部依赖。 */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ESC_MAP[ch]);

const state = {
    page: 'status',
    busy: false,
    status: null,
    topology: null,
    shadow: null,
    cfg: null,
    mediaVideo: null,
    nightQuiet: null,
    cfgDraft: null,
    logComponents: [],
    logId: '',
    logAuto: false,
    char: null,
    charEditing: false,
    bili: null,
    selfIter: null,
    selfIterBusy: false,
    biliPage: 1,
    biliBusy: false,
    timers: {},
    topoView: null,
};

const TOPO_MIN_ZOOM = 0.3;
const TOPO_MAX_ZOOM = 3;
let topoDraggedAt = 0;

const PAGES = {
    status: { title: '状态', hint: '各组件存活与关键配置' },
    shadow: { title: '影子', hint: '判定结果、规则分布与「如果回会回什么」' },
    config: { title: '配置', hint: '与热重载共用同一套校验，非法拒绝写入' },
    groups: { title: '群白名单', hint: '写旧栈 cordis.patch.yml；AstrBot 服务方见状态页' },
    logs: { title: '日志', hint: '按组件查看日志尾部，不整文件读入' },
    bili: { title: 'B 站', hint: '观看记录可翻页 · 独立账号绑定（只认手填 SESSDATA）' },
    character: { title: '人格', hint: 'character.md 只读预览，确认后才保存' },
    selfiter: { title: '自迭代', hint: '闲时反思：真实调用 · 笔记自动入库 · 人格改动待审' },
};

/* ---------------------------------------------------------------- 请求封装 */

class ApiError extends Error {
    constructor(message, data, status) {
        super(message);
        this.name = 'ApiError';
        this.data = data;
        this.status = status;
    }
}

async function api(path, options = {}) {
    let response;
    try {
        response = await fetch(path, {
            ...options,
            headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        });
    }
    catch (error) {
        throw new ApiError('连接不到控制台服务（127.0.0.1:1242）：' + String(error?.message ?? error), null, 0);
    }
    const text = await response.text();
    let data = null;
    try {
        data = text === '' ? null : JSON.parse(text);
    }
    catch {
        // 200/502/503 却拿不到 JSON，通常是服务没起来或代理返回了错误页，直接说「离线」。
        const offline = response.status === 200 || response.status === 502
            || response.status === 503 || /^\s*</.test(text);
        const prefix = offline
            ? '控制台离线（127.0.0.1:1242 没有返回 JSON）'
            : '服务返回了非 JSON 内容（HTTP ' + response.status + '）';
        throw new ApiError(prefix + '：' + text.slice(0, 200), null, response.status);
    }
    if (data === null)
        throw new ApiError('控制台离线（127.0.0.1:1242 返回了空响应）', null, response.status);
    // 只有「HTTP 失败」或「业务失败且带 error 文案」才算失败。
    // 状态页这类诊断载荷会用 ok/healthy/counts 表达健康度，不能因 warn 抛错。
    if (!response.ok || (data && data.ok === false && typeof data?.error === 'string')) {
        const message = data?.error || ('请求失败（HTTP ' + response.status + '）');
        throw new ApiError(message, data, response.status);
    }
    return data;
}

/* ---------------------------------------------------------------- 通用渲染 */

function showBanner(kind, message) {
    const banner = $('#banner');
    banner.className = 'banner ' + kind;
    banner.textContent = message;
    banner.classList.remove('hidden');
}

function hideBanner() {
    $('#banner').classList.add('hidden');
}

function fmtTime(value) {
    if (!value)
        return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return '刚刚';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1)
        return '刚刚';
    if (minutes < 60)
        return minutes + ' 分钟';
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分';
}

function fmtBytes(size) {
    if (!size && size !== 0)
        return '—';
    if (size < 1024)
        return size + ' B';
    if (size < 1024 * 1024)
        return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(2) + ' MB';
}

const pct = value => (value === null || value === undefined ? '—' : (value * 100).toFixed(1) + '%');
const stateLabel = value => ({ ok: '正常', warn: '告警', idle: '静默', down: '离线', disabled: '已停用', unknown: '未知' }[value] ?? value);

function pageError(title, error, hint) {
    const detail = error instanceof ApiError && error.data?.errors?.length
        ? '<ul>' + error.data.errors.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
        : '';
    return `
    <div class="panel">
        <div class="panel-head"><h2>${esc(title)}</h2></div>
        <div class="result-box error"><strong>${esc(error?.message ?? String(error))}</strong>${detail}</div>
        ${hint ? '<p class="muted">' + esc(hint) + '</p>' : ''}
        <div class="row end" style="margin-top:14px"><button data-retry>重试</button></div>
    </div>`;
}

function clearTimers() {
    for (const key of Object.keys(state.timers)) {
        clearInterval(state.timers[key]);
        delete state.timers[key];
    }
}

/* ---------------------------------------------------------------- 路由 */

function navigate(page) {
    if (!PAGES[page])
        page = 'status';
    // 切页先收掉残留弹层：避免旧弹窗盖住新页面，也避免遮罩挡住导航。
    closeModal();
    closeDrawer();
    if (location.hash.slice(1) !== page)
        location.hash = page;
    state.page = page;
    state.charEditing = false;
    clearTimers();
    hideBanner();
    $('#view').classList.remove('status-view');
    $$('#nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
    $('#pageTitle').textContent = PAGES[page].title;
    $('#pageHint').textContent = PAGES[page].hint;
    $('#view').innerHTML = '<div class="empty">加载中…</div>';
    if (page === 'status')
        void loadStatus();
    else if (page === 'shadow')
        void loadShadow();
    else if (page === 'config')
        void loadConfig();
    else if (page === 'groups')
        void loadGroups();
    else if (page === 'logs')
        void loadLogs();
    else if (page === 'bili')
        void loadBili(1);
    else if (page === 'character')
        void loadCharacter();
    else if (page === 'selfiter')
        void loadSelfIter();
}

/* ---------------------------------------------------------------- 状态页 */

async function loadStatus() {
    try {
        // 拓扑和状态各自独立：拓扑接口失败时，上面的汇总格子仍然要能看。
        const [data, topology, quiet] = await Promise.all([
            api('/api/status'),
            api('/api/topology').catch(() => null),
            api('/api/night-quiet?limit=8').catch(() => null),
        ]);
        state.status = data;
        state.topology = topology;
        state.nightQuiet = quiet;
        renderStatus(data, topology);
    }
    catch (error) {
        $('#view').innerHTML = pageError('状态加载失败', error, '确认控制台服务仍在运行，且本机端口 8094/1240/3001 没有被安全软件拦截。');
    }
}

function renderMachineBar(topology) {
    const res = topology?.resources;
    const machine = res?.machine;
    if (!machine) {
        return `<div class="machine-bar"><span class="mb-warn">资源采样不可用：${esc(res?.error ?? '拓扑接口未返回资源数据')}</span></div>`;
    }
    const gb = mb => (Number(mb || 0) / 1024).toFixed(1);
    const meter = (percent, tone = '') => {
        const width = Math.max(0, Math.min(100, Number(percent) || 0));
        return `<span class="meter ${tone}"><span style="width:${width.toFixed(1)}%"></span></span>`;
    };
    const gpu = machine.gpu;
    const gpuPercent = gpu?.totalMB ? (gpu.usedMB / gpu.totalMB) * 100 : 0;
    return `<div class="machine-bar">
        <div class="mb-item"><span class="mb-k">CPU</span><span class="mb-v">${esc(machine.cpuPercent)}%</span>${meter(machine.cpuPercent, machine.cpuPercent > 85 ? 'bad' : '')}</div>
        <div class="mb-item"><span class="mb-k">内存</span><span class="mb-v">${gb(machine.memUsedMB)} / ${gb(machine.memTotalMB)} GB</span>${meter(machine.memPercent, machine.memPercent > 90 ? 'bad' : '')}</div>
        <div class="mb-item"><span class="mb-k">GPU 显存</span><span class="mb-v">${gpu ? gb(gpu.usedMB) + ' / ' + gb(gpu.totalMB) + ' GB' : '—'}</span>${meter(gpuPercent)}</div>
        <div class="mb-item"><span class="mb-k">Y: 剩余</span><span class="mb-v">${esc(machine.disk?.freeGB ?? 0)} / ${esc(machine.disk?.totalGB ?? 0)} GB</span>${meter(machine.disk?.usedPercent, (machine.disk?.freeGB ?? 0) < 20 ? 'bad' : '')}</div>
        <span class="mb-src">Get-Process · netstat · WMI · nvidia-smi · 采样 ${esc(res.sampleMs)}ms · ${esc(fmtTime(res.sampledAt))}</span>
    </div>`;
}

function nightQuietBlock() {
    const data = state.nightQuiet;
    if (!data)
        return '';
    if (data.found !== true || !data.config) {
        return `<div class="win-metric warn"><span class="dot warn"></span><div>
            <strong>夜间静默：配置读不到</strong>
            <p class="muted">查不到 ${esc(data.configPath ?? 'xzy-config.json')} 的 night_quiet 段，
                既不能判定现在是否在窗口内，也不把「没有记录」当成 0 条。</p></div></div>`;
    }
    const cfg = data.config;
    const now = data.now ?? {};
    const window = (cfg.start ?? '—') + '–' + (cfg.end ?? '—');
    const inWindow = now.inWindow;
    const title = cfg.enabled !== true
        ? '夜间静默：已关闭（night_quiet.enabled=false）'
        : inWindow === true
            ? '夜间静默：静默中 · ' + window
            : inWindow === false
                ? '夜间静默：不在窗口内 · ' + window
                : '夜间静默：窗口时间解析失败 · ' + window;
    const tone = cfg.enabled === true && inWindow === true ? 'warn' : 'ok';
    const threshold = cfg.longVideoSec === null || cfg.longVideoSec === undefined
        ? '长视频阈值未配置'
        : '长视频阈值 ' + Number(cfg.longVideoSec) + 's';
    const cooldown = cfg.auditCooldownSec === null || cfg.auditCooldownSec === undefined
        ? '审计冷却未配置'
        : '审计冷却 ' + Number(cfg.auditCooldownSec) + 's';
    const rows = Array.isArray(data.rows) ? data.rows : [];
    // localAt 带微秒和 +08:00，直接切前 19 个字符，避免 Date 解析不出微秒。
    const stamp = value => {
        const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(value ?? ''));
        return match ? match[1] + ' ' + match[2] : (String(value ?? '') || '—');
    };
    const records = rows.length === 0
        ? `<p class="muted">暂无记录：${data.exists === true
            ? 'night-quiet.jsonl 里还没有拦截/降级写入'
            : '还没有 night-quiet.jsonl 文件'} · source: ${esc(data.source)}</p>`
        : '<ul>' + rows.map(row => {
            const suppressed = Number(row.suppressed ?? 0);
            return '<li>' + esc(stamp(row.localAt)) + ' · ' + esc(row.task ?? '—')
                + ' · ' + esc(row.caller ?? '—') + ' · ' + esc(row.action ?? '—')
                + (Number.isFinite(suppressed) && suppressed > 0 ? ' · 合并 ' + suppressed + ' 次' : '')
                + '<div class="muted">' + esc(row.reason ?? '查不到原因') + '</div></li>';
        }).join('') + '</ul>';
    return `<div class="win-metric ${tone}"><span class="dot ${tone}"></span><div>
        <strong>${esc(title)}</strong>
        <p class="muted">${esc(now.timezone ?? cfg.timezone ?? '时区未配置')} 现时 ${esc(now.hhmm ?? '—')}
            · ${esc(threshold)} · ${esc(cooldown)}（来源 xzy-config.json 的 night_quiet 段）。</p>
        ${rows.length === 0 ? '' : `<p class="muted">最近 ${rows.length} 条拦截/降级记录 · source: ${esc(data.source)}`
            + ` · 文件修改 ${esc(fmtTime(data.mtime))}</p>`}
        ${records}</div></div>`;
}

function renderStatus(data, topology) {
    $('#view').classList.add('status-view');
    const label = data.counts.down > 0
        ? data.counts.down + ' 个组件离线'
        : (data.counts.warn > 0 ? data.counts.warn + ' 个组件告警' : '全部在线');
    // 组件卡都是旧栈进程的健康；真实服务方只认 cutover.json，避免“全部在线”被读成旧栈在服务。
    const cut = topology?.cutover ?? null;
    const servingNote = cut
        ? (cut.oldStackServing === false
            ? ' · 真实流量：AstrBot 服务（旧栈未服务）'
            : cut.oldStackServing === true ? ' · 真实流量：旧栈仍在服务' : ' · 真实流量服务方：未核实')
        : '';
    const tone = data.counts.down > 0 ? 'down' : (data.counts.warn > 0 ? 'warn' : 'ok');
    const cards = data.components.map(component => {
        const log = component.log
            ? (component.log.id
                ? `<button class="log-link" data-log="${esc(component.log.id)}" title="日志：${esc(component.log.label)}（点击打开）">日志：${esc(component.log.label)}</button>`
                : `<p class="log-path" title="日志：${esc(component.log.label)}">日志：${esc(component.log.label)}</p>`)
            : '';
        return `
        <article class="card ${component.state}">
            <div class="card-head">
                <span class="dot ${component.state}"></span>
                <div class="card-title">
                    <h2>${esc(component.label)}</h2>
                    <span class="role" title="${esc(component.role)}">${esc(component.role)}</span>
                </div>
                <span class="chip ${component.state}">${esc(stateLabel(component.state))}</span>
            </div>
            <p class="card-summary" title="${esc(component.summary)}">${esc(component.summary)}</p>
            <dl class="facts">
                ${component.facts.map(item => `<div><dt title="${esc(item.label)}">${esc(item.label)}</dt><dd title="${esc(item.value)}">${esc(item.value)}</dd></div>`).join('')}
            </dl>
            ${component.detail ? '<p class="card-detail">' + esc(component.detail) + '</p>' : ''}
            ${log}
        </article>`;
    }).join('');

    const win = data.windows ?? null;
    let winBlock = '';
    if (win) {
        if (win.visibleConsoleCount === null || win.visibleConsoleCount === undefined) {
            winBlock = `<div class="win-metric warn"><span class="dot warn"></span><div>
                <strong>可见控制台窗口：未知</strong>
                <p class="muted">${esc(win.error ?? '窗口自检没有返回结果')}</p></div></div>`;
        }
        else if (win.visibleConsoleCount === 0) {
            winBlock = `<div class="win-metric ok"><span class="dot ok"></span><div>
                <strong>可见控制台窗口：0</strong>
                <p class="muted">EnumWindows 实测 ${esc(fmtTime(win.checkedAt))}：目标进程均没有可被用户关掉的控制台窗口。</p></div></div>`;
        }
        else {
            const items = win.violations.map(item => `<li>${esc(item.name)} pid=${esc(item.pid)} · ${esc(item.windowClass)}
                · ${esc(item.title || '(无标题)')} · <code>${esc(item.commandLine)}</code></li>`).join('');
            winBlock = `<div class="win-metric warn"><span class="dot warn"></span><div>
                <strong>可见控制台窗口：${win.visibleConsoleCount}</strong>
                <p class="muted">这些窗口用户可以直接关掉，关掉会连带杀死对应子进程：</p>
                <ul>${items}</ul></div></div>`;
        }
    }

    const defer = data.defer ?? null;
    let deferBlock = '';
    if (defer) {
        const entries = Object.entries(defer.groups ?? {});
        const rows = entries.map(([groupId, info]) => `<li>群 ${esc(groupId)}：${esc(info.pending)} 条 · 最老 ${esc(fmtDuration(info.oldestAgeMs))}</li>`).join('');
        deferBlock = `<div class="win-metric ${entries.length > 0 ? 'warn' : 'ok'}"><span class="dot ${entries.length > 0 ? 'warn' : 'ok'}"></span><div>
            <strong>延迟队列：${entries.length > 0 ? esc(defer.totalPending) + ' 条积压' : '没有积压'}</strong>
            <p class="muted">${entries.length > 0
                ? '低专注时攒下的群消息，默认超过 30 分钟会直接丢弃（defer.ttlMin）；最老一条已等 ' + esc(fmtDuration(defer.oldestAgeMs)) + '。'
                : '专注度低时消息会先攒在这里，默认不回复，只在有未回答的具体问题时补一句。'}</p>
            ${entries.length > 0 ? '<ul>' + rows + '</ul>' : ''}</div></div>`;
    }

    const batch = data.batch ?? null;
    let batchBlock = '';
    if (batch) {
        const entries = Object.entries(batch.groups ?? {});
        const rows = entries.map(([chatId, info]) => `<li>${esc(chatId)}：${esc(info.pending)} 条 · 已攒 ${esc(fmtDuration(info.waitMs))}</li>`).join('');
        const last = batch.lastBatch;
        const lastText = last
            ? '上次合批：' + esc(last.size) + ' 条合成 1 次投递，等了 ' + esc(fmtDuration(last.waitMs)) + '（' + esc(last.reason) + '）'
            : '本次启动后还没有合批记录。';
        batchBlock = `<div class="win-metric ${entries.length > 0 ? 'warn' : 'ok'}"><span class="dot ${entries.length > 0 ? 'warn' : 'ok'}"></span><div>
            <strong>攒批：${entries.length > 0 ? esc(batch.totalPending) + ' 条待投递' : '没有待投递'}</strong>
            <p class="muted">${entries.length > 0
                ? '同群连发先攒住，该群空闲就整批投递；阈值由实现侧配置决定（旧栈 config.json debounce / AstrBot xzy-config.json debounce），本页不写死。最老一条已等 ' + esc(fmtDuration(batch.oldestWaitMs)) + '。'
                : '同群连发会攒成一条一起投给模型，避免每个请求都去排队。'} ${lastText}${batch.updatedAt ? ' · 状态文件最后写入 ' + esc(fmtTime(batch.updatedAt)) : ''}</p>
            ${entries.length > 0 ? '<ul>' + rows + '</ul>' : ''}</div></div>`;
    }

    const latch = data.latch ?? null;
    const latchBlock = latch?.active
        ? `<div class="win-metric down"><span class="dot down"></span><div>
            <strong>引擎已闩锁：等自愈无效，需重启引擎</strong>
            <p class="muted">两条同时成立：GET /health = ${esc(latch.engineHealth?.httpStatus ?? '未知')}（${esc(latch.engineHealth?.status ?? '未知')}），引擎日志里出现 worker crash。此时 8094 仍在听、/v1/models 仍 200，但所有 completion 都是 503。</p>
            <pre>${esc(latch.evidence ?? '(日志行未取到)')}</pre>
            <p class="muted">同一条出口：<code>${esc(latch.control ?? '')}</code>（日志 ${esc(latch.log ?? '未知')}）</p>
            <p><button class="danger" data-engine-restart>重启引擎</button>
                <span class="muted">只重启引擎，proxy 与宿主不动；执行中会占用操作锁。</span></p>
        </div></div>`
        : '';

    const policy = data.launchPolicy ?? null;
    const taskRows = Array.isArray(policy?.scheduledTasks) ? policy.scheduledTasks : null;
    // xzy-host-watchdog 是唯一允许启用的计划任务（宿主守护）；其余计划任务仍要求 disabled + 0 触发器。
    const watchdog = taskRows?.find(item => /xzy-host-watchdog/i.test(item.name)) ?? null;
    const otherTasksOk = taskRows !== null
        && taskRows.filter(item => item !== watchdog).every(item => /disabled/i.test(item.state) && item.triggers === 0);
    const watchdogOk = watchdog === null || /ready|running/i.test(watchdog.state);
    const policyOk = taskRows !== null && otherTasksOk && watchdogOk;
    const policyTone = policyOk ? 'ok' : 'warn';
    const policyBlock = `<div class="win-metric ${policyTone}"><span class="dot ${policyTone}"></span><div>
        <strong>${watchdog
            ? '启停只走脚本；另有宿主守护计划任务 xzy-host-watchdog（无窗口，仅负责拉起宿主）'
            : '启停只走脚本：无计划任务、开机不自启、仅脚本触发'}</strong>
        <p class="muted">顶部按钮调用 ${esc(policy?.startScript ?? 'start-bot.ps1')} / ${esc(policy?.stopScript ?? 'stop-dsh.ps1')}，页面不另做一套实现。
        计划任务实况：${taskRows === null
            ? '未知（查询失败）'
            : taskRows.map(item => esc(item.name) + ' = ' + esc(item.state) + '、' + esc(item.triggers) + ' 个触发器').join('；')}
        ${policy?.scheduledTasksCheckedAt ? '（查询于 ' + esc(fmtTime(policy.scheduledTasksCheckedAt)) + '，60 秒内复用）' : ''}。</p>
        <p class="muted">退出码口径：0 = 核心项全就绪（允许警告 / 跳过）；1 = 核心项失败。核心项 = 引擎 8094 / TTS 5000 / proxy 1240 / bridge / AstrBot 6199+6299 / qq-console 1242；
        QQ·SnowLuma、插件 WS、Harness 宿主未出现、ComfyUI 8188 未就绪都只是警告，不改变退出码。日志里警告/失败分别以 [WARN] / [FAIL] 标出，收尾固定「失败项 / 警告项 / 跳过项」三行。</p></div></div>`;

    const winTone = win && win.visibleConsoleCount === 0 ? 'ok' : 'warn';
    const winText = !win ? ''
        : (win.visibleConsoleCount === null || win.visibleConsoleCount === undefined
            ? '未知'
            : (win.visibleConsoleCount === 0 ? '0' : win.visibleConsoleCount + ' 个'));
    const deferEntries = Object.entries(defer?.groups ?? {});
    const deferTone = deferEntries.length > 0 ? 'warn' : 'ok';
    const deferText = !defer ? '' : (deferEntries.length > 0 ? defer.totalPending + ' 条' : '无积压');
    const batchEntries = Object.entries(batch?.groups ?? {});
    const batchTone = batchEntries.length > 0 ? 'warn' : 'ok';
    const batchText = !batch ? '' : (batchEntries.length > 0 ? batch.totalPending + ' 条' : '无投递');

    $('#view').innerHTML = `
        ${renderMachineBar(topology)}
        ${latchBlock}
        <div class="status-bar">
            <div class="sb-health"><span class="dot ${tone}"></span><strong>${esc(label + servingNote)}</strong></div>
            ${win ? `<button type="button" class="sb-item ${winTone}" data-status-expand="win" title="可见控制台窗口自检详情">
                <span class="dot ${winTone}"></span><span class="sb-k">窗口</span><span class="sb-v">${esc(winText)}</span>
            </button>` : ''}
            ${defer ? `<button type="button" class="sb-item ${deferTone}" data-status-expand="defer" title="延迟队列详情">
                <span class="dot ${deferTone}"></span><span class="sb-k">延迟队列</span><span class="sb-v">${esc(deferText)}</span>
            </button>` : ''}
            ${batch ? `<button type="button" class="sb-item ${batchTone}" data-status-expand="batch" title="攒批详情">
                <span class="dot ${batchTone}"></span><span class="sb-k">攒批</span><span class="sb-v">${esc(batchText)}</span>
            </button>` : ''}
            <div class="sb-meta">最后刷新 ${esc(fmtTime(data.generatedAt))} · 每 10 秒自动刷新
                <button class="mini" data-refresh-status>立即刷新</button>
            </div>
            <div class="status-detail-pop" data-status-pop>
                ${win ? `<div data-detail="win" hidden>${winBlock}</div>` : ''}
                ${defer ? `<div data-detail="defer" hidden>${deferBlock}</div>` : ''}
                ${batch ? `<div data-detail="batch" hidden>${batchBlock}</div>` : ''}
            </div>
        </div>
        ${policyBlock}
        ${nightQuietBlock()}
        <div class="status-shell">
            <aside class="status-side"><div class="cards">${cards}</div></aside>
            ${topology
                ? renderTopology(topology)
                : '<div class="win-metric warn"><span class="dot warn"></span><div><strong>拓扑数据没有返回</strong>'
                    + '<p class="muted">/api/topology 请求失败，上面的组件卡片仍是实时状态；拓扑只影响链路视图。</p></div></div>'}
        </div>`;

    $('#view').querySelector('[data-refresh-status]').addEventListener('click', () => loadStatus());
    // 闩锁横幅里的重启入口：和顶部按钮同一条动作链（engine-control.ps1 -Action restart）。
    const engineRestartButton = $('#view').querySelector('[data-engine-restart]');
    if (engineRestartButton)
        engineRestartButton.addEventListener('click', () => runAction('engine-restart'));
    const statusBar = $('#view').querySelector('.status-bar');
    const statusPop = $('#view').querySelector('[data-status-pop]');
    const closeStatusDetail = () => {
        statusPop.classList.remove('open');
        $$('[data-status-expand]', $('#view')).forEach(item => item.classList.remove('active'));
    };
    $$('[data-status-expand]', $('#view')).forEach(button => {
        button.addEventListener('click', () => {
            const target = statusPop.querySelector(`[data-detail="${button.dataset.statusExpand}"]`);
            if (!target)
                return;
            const reopen = !(statusPop.classList.contains('open') && !target.hidden);
            statusPop.querySelectorAll('[data-detail]').forEach(item => { item.hidden = true; });
            $$('[data-status-expand]', $('#view')).forEach(item => item.classList.toggle('active', reopen && item === button));
            target.hidden = !reopen;
            statusPop.classList.toggle('open', reopen);
        });
    });
    statusBar.addEventListener('click', event => {
        if (event.target.closest('[data-status-expand]') || event.target.closest('[data-status-pop]'))
            return;
        closeStatusDetail();
    });
    $$('[data-log]', $('#view')).forEach(button => {
        button.addEventListener('click', () => {
            state.logId = button.dataset.log;
            navigate('logs');
        });
    });
    bindTopologyNodes(topology);
    bindTopoZoom();
    clearTimers();
    state.timers.status = setInterval(() => {
        if (state.page === 'status' && !document.hidden)
            void loadStatus();
    }, 10000);
}

/* ---------------------------------------------------------------- 拓扑视图 */

const MIGRATION_LABEL = { done: '已迁', partial: '部分', missing: '未迁', unverified: '未验证', unknown: '未知' };

function topoEdgeWidth(edge) {
    if (edge.flow === null || edge.flow === undefined)
        return 1.3;
    return Math.min(9, Math.max(1.3, 1.3 + Math.log2(1 + Math.max(0, edge.flow)) * 1.7));
}

function topoPath(from, to, offset) {
    // 兼容旧载荷：没有 points 时退化成「下出上入」的两段正交折线。
    const x1 = from.x;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y - to.h / 2;
    const my = (y1 + y2) / 2 + offset;
    return { points: [[x1, y1], [x1, my], [x2, my], [x2, y2]] };
}

/* 正交折线 + 统一箭头：points / labelAt 由服务端布局给出，前端不再自己算走线。 */
function topoEdgePoints(edge, from, to) {
    if (Array.isArray(edge.points) && edge.points.length > 1)
        return edge.points;
    return topoPath(from, to, edge.offset ?? 0).points;
}

function topoLabelPoint(points, fallback) {
    if (!points || points.length < 2)
        return fallback;
    let best = { len: -1, x: 0, y: 0 };
    for (let i = 1; i < points.length; i += 1) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len > best.len)
            best = { len, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
    return best;
}

const TOPO_ARROW_COLORS = { ok: '#3d86d8', warn: '#f2b134', idle: '#465468', down: '#ff6161', unknown: '#6b5a86' };

function topoSvgMarkup(topo) {
    const view = topo.viewBox ?? { width: 900, height: 790 };
    const nodes = (topo.nodes ?? []).map(node => ({ ...node, w: node.w ?? 200, h: node.h ?? 70 }));
    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const edges = topo.edges ?? [];

    const defs = `<defs>${Object.entries(TOPO_ARROW_COLORS).map(([state, color]) => `
        <marker id="topo-arrow-${state}" viewBox="0 0 10 10" refX="10" refY="5"
                markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="${color}"></path>
        </marker>`).join('')}</defs>`;

    const edgeSvg = edges.map(edge => {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to)
            return '';
        const points = topoEdgePoints(edge, from, to);
        if (!points || points.length < 2)
            return '';
        const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ');
        const at = Array.isArray(edge.labelAt)
            ? { x: Number(edge.labelAt[0]), y: Number(edge.labelAt[1]) }
            : topoLabelPoint(points);
        const width = topoEdgeWidth(edge);
        const degradeText = edge.degrade
            ? `｜降级起始 ${fmtTime(edge.degrade.since)} · 持续 ${fmtDuration(edge.degrade.forMs)} · ${edge.degrade.clearWhen}`
            : '';
        const title = `${from.label} → ${to.label}｜${edge.label}｜${stateLabel(edge.state)}${degradeText}`;
        return `<g class="topo-edge ${edge.state} kind-${esc(edge.kind)}">
            <title>${esc(title)}</title>
            <path d="${d}" stroke-width="${width.toFixed(2)}" marker-end="url(#topo-arrow-${esc(edge.state)})"></path>
            <text class="topo-edge-label" x="${at.x.toFixed(1)}" y="${(at.y - 4).toFixed(1)}">${esc(edge.label)}</text>
        </g>`;
    }).join('');

    const nodeSvg = nodes.map(node => {
        const left = node.x - node.w / 2;
        const top = node.y - node.h / 2;
        const resourceText = node.resource
            ? `CPU ${node.resource.cpu}% · ${node.resource.memMB}MB`
            : '';
        const migLabel = MIGRATION_LABEL[node.migration] ?? MIGRATION_LABEL.unknown;
        const migWidth = migLabel.length * 10 + 10;
        const migX = left + node.w - 10 - migWidth;
        const mig = `<g class="topo-mig ${node.migration ?? 'unknown'}">
            <rect x="${migX.toFixed(1)}" y="${(top + 8).toFixed(1)}" width="${migWidth}" height="16" rx="8"></rect>
            <text x="${(migX + migWidth / 2).toFixed(1)}" y="${(top + 19.5).toFixed(1)}">${esc(migLabel)}</text>
        </g>`;
        return `
        <g class="topo-node ${node.state} layer-${esc(node.layer ?? '')} mig-${esc(node.migration ?? 'unknown')}"
           data-node="${esc(node.id)}" tabindex="0" role="button"
           aria-label="${esc(node.label)}：${esc(node.role)} · 迁移 ${esc(migLabel)} · 运行 ${esc(stateLabel(node.state))}">
            <rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${node.w}" height="${node.h}" rx="9"></rect>
            <circle class="topo-state" cx="${(left + 16).toFixed(1)}" cy="${(top + 20).toFixed(1)}" r="4.5"></circle>
            <text class="topo-label" x="${(left + 27).toFixed(1)}" y="${(top + 25).toFixed(1)}">${esc(node.label)}</text>
            ${mig}
            <text class="topo-role" x="${(left + 14).toFixed(1)}" y="${(top + 45).toFixed(1)}">${esc(node.role)}</text>
            ${resourceText
                ? `<text class="topo-res" x="${(left + 14).toFixed(1)}" y="${(top + 62).toFixed(1)}">${esc(resourceText)}</text>`
                : ''}
        </g>`;
    }).join('');

    const bands = `
        <g class="topo-bands">
            ${(topo.bands ?? []).map(band => {
                if (band.kind === 'line')
                    return `<line x1="18" y1="${band.y}" x2="${view.width - 18}" y2="${band.y}"></line>`;
                if (band.kind === 'vline')
                    return `<line x1="${band.x}" y1="${band.y1}" x2="${band.x}" y2="${band.y2}"></line>`;
                return `<text class="topo-band-label" x="${Number(band.x) || 18}" y="${band.y}">${esc(band.text)}</text>`;
            }).join('')}
        </g>`;

    // 配色取 display（文件里写明的 mode/stage）；静态快照不按新鲜度降级，只有读不到才 unknown。
    const display = topo.cutover?.display ?? topo.cutover?.effective ?? 'unknown';
    return `<svg class="topo-svg cutover-${esc(display)}" viewBox="0 0 ${view.width} ${view.height}" preserveAspectRatio="xMidYMid meet" role="img"
                 aria-label="AstrBot 目标架构 · 真实流量 ${esc(display)}">
                ${defs}
                ${bands}
                <g class="topo-edges">${edgeSvg}</g>
                <g class="topo-nodes">${nodeSvg}</g>
            </svg>`;
}

const CUTOVER_VIEW = {
    old: { cls: 'old', title: '未切换：旧栈仍在服务真实 QQ 消息' },
    split: { cls: 'split', title: '部分会话已切：AstrBot 在服务，旧栈未服务' },
    private: { cls: 'private', title: '仅私聊已切：AstrBot 服务私聊；群不在本次切换范围' },
    astrbot: { cls: 'astrbot', title: '已切换：真实 QQ 消息由 AstrBot 服务' },
    none: { cls: 'none', title: '已暂停：手动全停，没有一方在服务真实流量' },
    'rolled-back': { cls: 'rolled-back', title: '已回滚：旧栈重新接管真实流量' },
    'rollback-failed': { cls: 'rollback-failed', title: '回滚失败：服务方未知，需人工确认' },
    unknown: { cls: 'unknown', title: '服务方未知：cutover.json 缺失 / 损坏 / 字段不可解析' },
};
const FLOW_LABEL = { yes: '服务中', no: '未服务', partial: '部分服务', unknown: '未知' };
const STAGE_LABEL = {
    prepare: '准备',
    private: '私聊',
    'one-group': '单群（cutover 脚本阶段值，实际会话见 note）',
    all: '全部会话',
    done: '完成',
    paused: '已暂停（手动全停）',
    'rolled-back': '已回滚',
    'rollback-failed': '回滚失败',
};

function cutoverCard(cut) {
    const view = CUTOVER_VIEW[cut.effective] ?? CUTOVER_VIEW.unknown;
    // 标题只描述“谁在服务”，不假设双栈并行：旧栈是否服务以 oldStackServing 为准。
    const title = cut.effective !== 'split' && cut.effective !== 'private'
        ? view.title
        : cut.oldStackServing === false
            ? (cut.effective === 'split'
                ? '部分会话已切：AstrBot 在服务，旧栈未服务'
                : '仅私聊已切：AstrBot 服务私聊；群不在本次切换范围，旧栈未服务')
            : (cut.effective === 'split'
                ? '部分会话已切：旧栈与 AstrBot 同时服务'
                : '仅私聊已切：AstrBot 服务私聊；群仍由旧栈服务');
    const flag = value => (value === true
        ? '<b class="good">是</b>'
        : value === false ? '<b class="bad">否</b>' : '<b class="warn">未知</b>');
    const updated = cut.updatedAt && Number.isFinite(cut.updatedMs)
        ? `${esc(fmtTime(new Date(cut.updatedMs).toISOString()))}（${cut.ageMs === null ? '无法解析' : Math.max(0, Math.round(cut.ageMs / 60_000)) + ' 分钟前'}）`
        : '未知';
    return `<div class="cutover-card ${view.cls}">
        <div class="cutover-head">
            <strong>真实流量切换</strong>
            <span class="cutover-badge">${esc(title)}</span>
        </div>
        <dl class="cutover-facts">
            <div><dt>阶段</dt><dd>${esc(STAGE_LABEL[cut.stage] ?? '未知')}${cut.stage ? ` <code>${esc(cut.stage)}</code>` : ''}</dd></div>
            <div><dt>最近更新</dt><dd>${updated}</dd></div>
            <div><dt>astrbotPid</dt><dd>${cut.astrbotPid ?? '未知'}</dd></div>
            <div><dt>旧栈是否仍在服务</dt><dd>${flag(cut.oldStackServing)}</dd></div>
            <div class="wide"><dt>note</dt><dd>${cut.note ? esc(cut.note) : '<span class="muted">未提供</span>'}</dd></div>
        </dl>
        ${cut.rollbackCommand
            ? `<div class="cutover-cmd"><span>回滚命令（仅供人看，未绑定按钮）</span><code>${esc(cut.rollbackCommand)}</code></div>`
            : '<p class="muted">回滚命令：未提供</p>'}
        ${cut.error ? `<p class="cutover-err">${esc(cut.error)}</p>` : ''}
        <p class="muted">数据源：${esc(cut.source ?? 'state/cutover.json')}（只读静态快照；不按新鲜度判未知，读不到才显示未知）</p>
    </div>`;
}

function renderTopology(topo) {
    const edges = topo.edges ?? [];
    const edgeDown = edges.filter(edge => edge.state === 'down').length;
    const edgeWarn = edges.filter(edge => edge.state === 'warn').length;
    const edgeIdle = edges.filter(edge => edge.state === 'idle').length;
    const edgeLive = edges.filter(edge => edge.state === 'ok').length;
    const edgeUnknown = edges.filter(edge => edge.state === 'unknown').length;

    const target = topo.target ?? {};
    const traffic = topo.traffic ?? {};
    const counts = topo.counts ?? {};
    const cut = topo.cutover ?? { effective: 'unknown', error: '接口没有 cutover 字段', serving: {} };
    const cutView = CUTOVER_VIEW[cut.effective] ?? CUTOVER_VIEW.unknown;
    const flow = cut.serving ?? {};
    const flowPill = (label, state) => `<span class="flow-pill ${esc(state ?? 'unknown')}">${esc(label)}：${esc(FLOW_LABEL[state] ?? '未知')}</span>`;
    const cutUpdated = cut.updatedAt && Number.isFinite(cut.updatedMs)
        ? fmtTime(new Date(cut.updatedMs).toISOString())
        : '未知';

    return `
    <section class="topo-panel">
        <div class="topo-head">
            <div>
                <h2>目标架构 · ${esc(target.name ?? 'AstrBot')}</h2>
                <p class="muted">入口 → 判定/防抖 → 工具层 → 引擎 → 出站闸 → 回流到 QQ
                    · 旁路能力在右侧独立列（箭头指回所服务的环节）
                    · 节点 ${counts.nodes ?? '?'}（正常 ${counts.ok ?? '?'} / 告警 ${counts.warn ?? '?'} / 静默 ${counts.idle ?? '?'} / 断链 ${counts.down ?? '?'} / 未知 ${counts.unknown ?? '?'}）
                    · 连线 ${counts.edges ?? '?'}（正常 ${edgeLive} / 告警 ${edgeWarn} / 静默 ${edgeIdle} / 断链 ${edgeDown} / 未知 ${edgeUnknown}）
                    · 生成于 ${esc(fmtTime(topo.generatedAt))}</p>
            </div>
            <div class="topo-legend">
                <span><i class="lg ok"></i>运行正常</span>
                <span><i class="lg warn"></i>告警</span>
                <span><i class="lg idle"></i>静默</span>
                <span><i class="lg down"></i>断链</span>
                <span><i class="lg unknown"></i>未知</span>
                <span class="lg-sep">接线（运行时探针）：</span>
                <span><i class="lg mig-done"></i>已迁</span>
                <span><i class="lg mig-partial"></i>部分</span>
                <span><i class="lg mig-missing"></i>未迁</span>
                <span><i class="lg mig-unverified"></i>未验证</span>
                <span><i class="lg mig-unknown"></i>未知（读不到来源）</span>
            </div>
            <div class="topo-actions">
                <button type="button" class="mini" data-topo-out title="缩小">−</button>
                <span class="topo-zoom" data-topo-zoom>100%</span>
                <button type="button" class="mini" data-topo-in title="放大">+</button>
                <button type="button" class="mini" data-topo-reset title="整张图回到视野内">适应视图</button>
            </div>
        </div>
        <div class="topo-notice cutover-${esc(cutView.cls)}">
            <strong>${esc(cutView.title)}</strong>
            <span>${cut.note ? esc(cut.note) : 'note 未提供'}</span>
            <span class="muted">阶段 ${esc(STAGE_LABEL[cut.stage] ?? '未知')}
                · 更新 ${esc(cutUpdated)} · astrbotPid ${esc(cut.astrbotPid ?? '未知')}
                · 旧栈仍在服务 ${cut.oldStackServing === true ? '是' : cut.oldStackServing === false ? '否' : '未知'}
                ${cut.error ? ' · ' + esc(cut.error) : ''}</span>
            <span class="muted">实例 <code>${esc(target.root ?? '未知')}</code>
                · 面板 ${esc(target.dashboardPort ?? '未知')} · OneBot ${esc(target.reversePort ?? '未知')}
                · 平台 ${esc(target.platformId ?? '未知')}</span>
        </div>
        <div class="topo-flow">
            <span class="flow-label">真实流量走向</span>
            ${flowPill('旧栈路径（qq-persona → dsh-onebot → ninfer）', flow.old)}
            ${flowPill('AstrBot 路径（OneBot → xzy → 引擎）', flow.astrbot)}
            <span class="muted">高亮 = 正在服务 · 灰 = 未服务 · 黄 = 部分会话；据此高亮图上的目标链</span>
        </div>
        <div class="topo-traffic">
            <span>AstrBot 入站（15m）<b class="good">${esc(traffic.evalInbound15 ?? '未知')}</b> 条</span>
            <span>旧栈入站（15m）<b>${esc(traffic.oldInbound15 ?? '未知')}</b> 条</span>
            <span>AstrBot 回合（15m） <b>${esc(traffic.evalTurns15 ?? '未知')}</b></span>
            <span>模型请求（15m） <b>${esc(traffic.evalLlm15 ?? '未知')}</b></span>
            <span>AstrBot 出站（15m） <b>${esc(traffic.evalOutbound15 ?? '未知')}</b></span>
            <span>最后 AstrBot 写入 ${traffic.lastEvalAt ? esc(fmtTime(new Date(traffic.lastEvalAt).toISOString())) : '未知'}</span>
            <span>旧栈最后入站 ${traffic.oldLastInboundAt ? esc(fmtTime(new Date(traffic.oldLastInboundAt).toISOString())) : '未记录'}</span>
            <span>线宽 = 流量（对数），颜色 = 状态；点节点看指标与日志 · 滚轮缩放 / 拖拽平移</span>
        </div>
        <div class="topo-wrap">${topoSvgMarkup(topo)}</div>
        ${cutoverCard(cut)}
        ${renderMigrationProgress(topo)}
        ${renderAstrbotRuntime(topo.astrbotRuntime)}
        <p class="muted topo-foot">数据：AstrBot cmd_config.json + xzy/audit/*.jsonl + astrbot.log + 引擎 /v1/models + state/cutover.json；
            迁移对照表逐项读 spec 的功能对照表小节与 evidence/tools.md（文档口径）；节点徽标读运行时探针；真实流量服务方只认 cutover.json（静态快照，不按新鲜度判未知，读不到才显示未知）；
            端口只探测 TCP 存活。旧栈节点不在本图中，用“真实流量走向”两条路径的明暗表示谁在服务；
            旧栈历史资料（2026-11-11/12/13、qq-watch、qq-persona 的 tests/tmp/patches/备份/旧日志）已归档到 Y:\\dsh\\归档，不参与运行。</p>
    </section>`;
}

function migrationChipName(name) {
    return String(name ?? '').replace(/（[^）]*）\s*$/, '').trim();
}

/** AstrBot 链路实况：全部字段来自服务端现读的文件，缺失就显示“未核实”，不猜。 */
function renderAstrbotRuntime(rt) {
    if (!rt || !rt.ok) {
        return `<div class="rt-panel">
            <div class="rt-head"><strong>AstrBot 链路实况：未核实</strong>
                <span class="muted">xzy-config.json / cmd_config.json 读不到</span></div>
        </div>`;
    }
    const num = (value, unit = '') => (value === null || value === undefined ? '未核实' : value + unit);
    const ms = value => (value === null || value === undefined ? '未核实' : (value / 1000) + 's');
    const when = value => (value ? fmtTime(new Date(value)) : '时间未知');

    const rulesOk = rt.rules?.hits === rt.rules?.total;
    const ruleLine = rulesOk
        ? `R1 @/引用别人 → 静默 · R2 机器人刚提问 ≤${ms(rt.judge?.windowMs)} → 接话 · `
            + `R3 超窗至 ${ms(rt.judge?.staleMs)} → 灰区问模型 · R4 无提问时刻 → 灰区 · R5 其余 → 进模型`
        : `规则表只对上 ${rt.rules?.hits ?? 0}/${rt.rules?.total ?? 5} 条（continuation.py 有改动，未核实）`;

    const deb = rt.debounce;
    const debLine = deb
        ? `${deb.enabled ? '开' : '关'} · 空@ ${ms(deb.emptyMentionMs)} · 群 ${ms(deb.groupMs)} · 基础 ${ms(deb.baseMs)} · 图片 ${ms(deb.imageMs)}`
            + `${deb.profile ? '（' + esc(deb.profile) + '）' : ''}`
        : '未核实';

    const lv = rt.emptyMentionWaiting;
    const emptyLine = lv === false
        ? '已关（原生 60s 抢占不再生效，纯 @ 走 xzy 自己的 10s 窗口）'
        : lv === true ? '开启（原生 60s 等待仍生效，会抢占纯 @）' : '未核实';

    const draw = rt.draw;
    // 允许中间多出 precheck 之类的步骤，只要求 4 个关键 phase 的相对顺序正确。
    const order = ['unloaded', 'tts-released', 'restored', 'tts-restored'];
    const seq = Array.isArray(draw?.phases) ? draw.phases.filter(p => order.includes(p)) : [];
    const drawOk = seq.join(',') === order.join(',');
    const drawLine = draw?.phases?.length
        ? `${drawOk ? '硬序正确' : '顺序与约定不同：' + esc(draw.phases.join(' → '))} · `
            + `卸载引擎 → tts release → 出图 → 引擎 restore → tts restore`
            + `${draw.roundSeconds !== null ? ' · 最近一轮 ' + draw.roundSeconds + 's' : ''}`
            + `（${when(draw.at)}）`
        : '未核实（media/state/engine-switch.jsonl 无记录）';

    const steady = draw && draw.steadyUsedMb !== null
        ? `used ${draw.steadyUsedMb.toLocaleString('en-US')} / free ${draw.steadyFreeMb.toLocaleString('en-US')} MiB（${when(draw.steadyAt)}，tts restore 后）`
        : '未核实';

    const c8188 = rt.comfy?.port8188;
    const comfy8188 = c8188 === 'listening' ? '在监听' : c8188 === 'down' ? '未监听' : '未核实';
    return `<div class="rt-panel">
        <div class="rt-head"><strong>AstrBot 链路实况</strong>
            <span class="muted">逐项读当前文件 · 读不到写“未核实” · 历史峰值 14,071/1,980 MiB 与整轮 55s 无现行日志，标未核实（本页不探测）</span></div>
        <dl class="facts rt-facts">
            <div><dt>判定规则</dt><dd>${ruleLine}</dd></div>
            <div><dt>防抖窗口</dt><dd>${debLine}</dd></div>
            <div><dt>空 @ 等待</dt><dd>${emptyLine}</dd></div>
            <div><dt>去重 / 幂等</dt><dd>同轮同文 ${num(rt.dedup?.windowSec, 's')} 去重
                · 幂等台账 ${rt.dedup?.ledger ? '启用' : '未核实'}（一条入站最多一次文本出站）</dd></div>
            <div><dt>记忆注入</dt><dd>notebook ${rt.memory?.notebook ? '在' : '未核实'} · diary ${rt.memory?.diary ? '在' : '未核实'}
                · 同池检索 ${rt.memory?.limit ? 'limit ' + esc(rt.memory.limit) : '未核实'}</dd></div>
            <div><dt>引擎容量</dt><dd>--kv-capacity ${rt.engine?.kvCapacity ? rt.engine.kvCapacity.toLocaleString('en-US') : '未核实'}
                ${rt.engine?.pages ? '≈ ' + rt.engine.pages.toLocaleString('en-US') + ' 页（' + rt.engine.pageTokens + ' token/页）' : ''}
                · 稳态 ${steady}</dd></div>
            <div><dt>出图链路</dt><dd>${drawLine}</dd></div>
            <div><dt>ComfyUI</dt><dd>8188 ${comfy8188} · 8299 未核实（本页不探测 8299）
                · 归用户自管，脚本不 kill（stop-dsh.ps1 明示不触碰）</dd></div>
        </dl>
        <p class="muted rt-src">来源：${esc(rt.source?.xzy ?? 'xzy-config.json')} · ${esc(rt.source?.cmd ?? 'cmd_config.json')}
            · ${esc(rt.source?.engine ?? 'start-ninfer.ps1')} · ${esc(rt.source?.audit ?? 'engine-switch.jsonl')}</p>
    </div>`;
}

function renderMigrationProgress(topo) {
    const migration = topo.migration;
    if (!migration || !migration.ok) {
        return `<div class="mig-panel unknown">
            <div class="mig-head"><strong>迁移进度：未知</strong><span>${esc(migration?.error ?? '没有迁移数据')}</span></div>
            <p class="muted">数据源：${esc(migration?.source ?? 'spec.md / evidence/tools.md')}（读不到就显示未知，不做推测）</p>
        </div>`;
    }
    const counts = migration.counts ?? {};
    const items = migration.items ?? [];
    const tools = migration.tools ?? {};
    const deploy = migration.deployment ?? {};
    const chips = items.map(item => `<span class="mig-chip ${esc(item.status)}"
        title="#${item.id} ${esc(item.origin)}｜${esc(item.rawStatus)}">${item.id}. ${esc(migrationChipName(item.name))}</span>`).join('');
    // 最近半天新增/改动的条目（#10 身份索引、#23–#28）直接把 spec 里的证据原文摊开，
    // 避免只看到绿点却不知道凭什么绿；没写证据的条目不渲染。
    const evidenceRows = items.filter(item => item.evidence && (item.id === 10 || item.id >= 23));
    const evidenceBlock = evidenceRows.length > 0
        ? `<details class="mig-evidence">
            <summary>最近变更的现行证据（spec §6 原文，${evidenceRows.length} 项）</summary>
            ${evidenceRows.map(item => `<div class="mig-evidence-row">
                <b>#${item.id} ${esc(migrationChipName(item.name))}</b>
                <span class="mig-gap ${esc(item.status)}">${esc(item.rawStatus)}</span>
                <div class="muted">${esc(item.evidence)}</div>
            </div>`).join('')}
        </details>`
        : '';

    // 三个字段相互独立：实现数 / 真机验证数 / 注册数；注册数以实例日志为准，文档记账只作对照。
    const runtimeCount = Number.isFinite(tools.runtimeDeclared) ? tools.runtimeDeclared : null;
    const docCount = Number.isFinite(tools.declaredEvidence) ? tools.declaredEvidence : null;
    const declaredCount = runtimeCount ?? docCount;
    const outOfCatalog = (declaredCount !== null && Number.isFinite(tools.total))
        ? declaredCount - tools.total
        : (tools.runtimeOutOfCatalog ?? []).length;
    const docCaveat = docCount !== null && runtimeCount !== null && docCount !== runtimeCount
        ? `<span class="muted">tools.md 记 ${docCount}，实例日志 ${runtimeCount}（以 astrbot.log 为准）</span>`
        : '';
    const toolLine = tools.ok
        ? `<div class="mig-tools">
            <span>实现数 <b>${tools.implementedDone ?? '未知'} / ${tools.implementedTotal ?? '未知'}</b>（tools.md）</span>
            <span>真机验证数 <b>${tools.verifiedDone ?? '未知'} / ${tools.verifiedTotal ?? '未知'}</b>${Number.isFinite(tools.verifiedRecorded) && tools.verifiedRecorded !== tools.verifiedDone
                    ? `<span class="muted">（tools.md 记账 ${tools.verifiedRecorded} + 补验 ${tools.verifiedDone - tools.verifiedRecorded}）</span>`
                    : ''}</span>
            <span>注册数 <b>${declaredCount ?? '未知'}</b>（声明 = 注册；清单内 ${tools.total ?? '未知'}，清单外 ${outOfCatalog ?? '未知'}，其中 <code>self_iter_*</code> ${(tools.runtimeOutOfCatalog ?? []).filter(name => name.startsWith('self_iter_')).length || '未知'} 个不在清单内）</span>
            ${docCaveat}
        </div>
        <div class="mig-gaps">
            <span class="mig-gap partial">部分验证 ${tools.partial?.count ?? '未知'}${Number(tools.partial?.count) > 0 && (tools.partial?.names ?? []).length ? '：' + esc(tools.partial.names.join(' / ')) : ''}</span>
            <span class="mig-gap missing">待授权写操作 ${tools.pendingAuth?.count ?? '未知'}${Number(tools.pendingAuth?.count) > 0 && (tools.pendingAuth?.names ?? []).length ? '：' + esc(tools.pendingAuth.names.join(' / ')) : ''}</span>
            <span class="mig-gap missing">暂缓 ${tools.deferred?.count ?? '未知'}${Number(tools.deferred?.count) > 0 && (tools.deferred?.names ?? []).length ? '：' + esc(tools.deferred.names.join(' / ')) : ''}</span>
            ${(tools.verifiedExtra ?? []).length
                    ? `<span class="mig-gap done">补验通过 ${tools.verifiedExtra.length}：${esc(tools.verifiedExtra.join(' / '))}</span>`
                    : ''}
        </div>`
        : `<p class="muted">工具进度未知：${esc(tools.error ?? '数据源缺失')}</p>`;

    const deployText = deploy?.note
        ? `<p class="mig-deploy ${Number.isFinite(deploy.toolCallTimeout) && Number.isFinite(deploy.suggestedMinSec) && deploy.toolCallTimeout < deploy.suggestedMinSec ? 'bad' : ''}">
            部署口径：${esc(deploy.note)}</p>`
        : '';

    // 运行时核对：这些项此前被 spec 的静态证据记成「部分/未修」，直接读当前配置与审计台账补正。
    const live = migration.live ?? null;
    const liveBlock = live
        ? `<div class="mig-gaps" style="margin-top:10px">
            <span class="mig-gap ${live.defaultPersonality === '' ? 'done' : 'partial'}">default_personality：${live.defaultPersonality === ''
                ? '空（已清空，不再指向 eval-persona）'
                : esc(live.defaultPersonality)}</span>
            <span class="mig-gap ${live.tempRootIncluded ? 'done' : 'missing'}">media_roots：${live.tempRootIncluded
                ? '含 data\\temp（入站单图 read_image 可用）'
                : '缺 data\\temp'}</span>
            ${live.toolRounds
                ? `<span class="mig-gap ${live.toolRounds.dropped === live.toolRounds.total ? 'done' : 'partial'}">带 tool_calls 的 content：${live.toolRounds.dropped}/${live.toolRounds.total} 条台账 dropped（不出站、不占幂等键）</span>`
                : '<span class="mig-gap unknown">tool_calls 台账：读不到</span>'}
            ${live.imagePrep && live.imagePrep.at
                ? `<span class="mig-gap done">入站单图预处理：最近 ${esc(fmtTime(live.imagePrep.at))} ${esc(live.imagePrep.result)}</span>`
                : ''}
            <span class="muted" style="width:100%">以上为运行时核对（读当前配置 / 审计台账），不依赖 spec 的静态证据。</span>
        </div>`
        : '';

    return `<div class="mig-panel">
        <div class="mig-head">
            <strong>迁移对照表：spec 文档口径（附运行时核对）</strong>
            <span>文档状态：${counts.done ?? '?'} / ${migration.total ?? '?'} 已实现 · 部分 ${counts.partial ?? '?'} · 未实现 ${counts.missing ?? '?'} · 未验证 ${counts.unverified ?? '?'}（状态=代码/配置就位，不等于真机跑过；真机验证数见下方工具行）</span>
        </div>
        <div class="mig-chips">${chips || '<span class="muted">清单为空</span>'}</div>
        ${evidenceBlock}
        ${toolLine}
        ${liveBlock}
        ${deployText}
        <p class="muted">能力清单：spec.md 的「功能对照表」小节（${esc(migration.mtime ? fmtTime(migration.mtime) : '时间未知')}）
            · 该表随迁移更新，但仍是文档口径，不等于运行时探针；当前节点徽标以运行时探针为准
            · 工具：${esc(tools.source ?? '—')} · 运行时：${esc(tools.runtimeSource ?? '未知')}</p>
    </div>`;
}

/* 拓扑缩放/平移：只改 viewBox，不动渲染器，也不引入额外图库 */
function topoBoxFromState(base) {
    const source = state.topoView;
    const rawZ = Number(source?.z);
    const z = Math.min(TOPO_MAX_ZOOM, Math.max(TOPO_MIN_ZOOM, Number.isFinite(rawZ) ? rawZ : 1));
    const w = base.w / z;
    const h = base.h / z;
    const cx = Number.isFinite(source?.cx) ? source.cx : base.x + base.w / 2;
    const cy = Number.isFinite(source?.cy) ? source.cy : base.y + base.h / 2;
    // 放大时把视野夹在原始画布内；缩到比画布还小时居中，避免飘走
    const x = w >= base.w
        ? base.x + (base.w - w) / 2
        : Math.min(base.x + base.w - w, Math.max(base.x, cx - w / 2));
    const y = h >= base.h
        ? base.y + (base.h - h) / 2
        : Math.min(base.y + base.h - h, Math.max(base.y, cy - h / 2));
    return { z, cx: x + w / 2, cy: y + h / 2, x, y, w, h };
}

function bindTopoZoom() {
    const svg = $('.topo-svg', $('#view'));
    const vb = svg?.viewBox?.baseVal;
    if (!svg || !vb || !vb.width || !vb.height)
        return;
    const base = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    const zoomLabel = $('[data-topo-zoom]', $('#view'));
    let box = topoBoxFromState(base);
    const sync = () => {
        svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
        if (zoomLabel)
            zoomLabel.textContent = Math.round(box.z * 100) + '%';
    };
    const geometry = () => {
        const rect = svg.getBoundingClientRect();
        const scale = Math.min(rect.width / box.w, rect.height / box.h);
        return { rect, scale, offX: (rect.width - box.w * scale) / 2, offY: (rect.height - box.h * scale) / 2 };
    };
    sync();

    // 按钮缩放：以当前视野中心为锚点，和滚轮共用同一套 state
    const zoomBy = factor => {
        const z = Math.min(TOPO_MAX_ZOOM, Math.max(TOPO_MIN_ZOOM, box.z * factor));
        if (Math.abs(z - box.z) < 1e-4)
            return;
        state.topoView = { z, cx: box.cx, cy: box.cy };
        box = topoBoxFromState(base);
        sync();
    };
    $('[data-topo-in]', $('#view'))?.addEventListener('click', () => zoomBy(1.25));
    $('[data-topo-out]', $('#view'))?.addEventListener('click', () => zoomBy(1 / 1.25));

    svg.addEventListener('wheel', event => {
        event.preventDefault();
        const { rect, scale, offX, offY } = geometry();
        const px = event.clientX - rect.left - offX;
        const py = event.clientY - rect.top - offY;
        const u = box.x + px / scale;
        const v = box.y + py / scale;
        const factor = Math.exp(-event.deltaY * 0.0015);
        const z = Math.min(TOPO_MAX_ZOOM, Math.max(TOPO_MIN_ZOOM, box.z * factor));
        if (z === box.z)
            return;
        const w = base.w / z;
        const h = base.h / z;
        // 以光标为锚点：缩放前后光标下的 SVG 坐标保持不动
        const s2 = Math.min(rect.width / w, rect.height / h);
        const x = u - px / s2;
        const y = v - py / s2;
        state.topoView = { z, cx: x + w / 2, cy: y + h / 2 };
        box = topoBoxFromState(base);
        sync();
    }, { passive: false });

    svg.addEventListener('pointerdown', event => {
        if (event.button !== 0)
            return;
        const start = { x: event.clientX, y: event.clientY, cx: box.cx, cy: box.cy, moved: false };
        const { scale } = geometry();
        const move = e => {
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4)
                return;
            start.moved = true;
            svg.classList.add('dragging');
            state.topoView = { z: box.z, cx: start.cx - dx / scale, cy: start.cy - dy / scale };
            box = topoBoxFromState(base);
            sync();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            svg.classList.remove('dragging');
            if (start.moved)
                topoDraggedAt = Date.now();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });

    $('[data-topo-reset]', $('#view'))?.addEventListener('click', () => {
        state.topoView = null;
        box = topoBoxFromState(base);
        sync();
    });
}

function bindTopologyNodes(topology) {
    if (!topology)
        return;
    const nodeMap = new Map((topology.nodes ?? []).map(node => [node.id, node]));
    $$('[data-node]', $('#view')).forEach(element => {
        const open = () => {
            if (Date.now() - topoDraggedAt < 300)
                return;
            const node = nodeMap.get(element.dataset.node);
            if (node)
                openTopologyNode(node);
        };
        element.addEventListener('click', open);
        element.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });
    });
}

function openTopologyNode(node) {
    const migLabel = MIGRATION_LABEL[node.migration] ?? MIGRATION_LABEL.unknown;
    const facts = [
        `<div><dt>迁移状态</dt><dd>${esc(migLabel)}</dd></div>`,
        `<div><dt>迁移依据</dt><dd>${esc(node.migrationSource ?? '未知（节点未返回来源字段）')}</dd></div>`,
        ...(node.metrics ?? []).map(item => `<div><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`),
    ].join('');
    const log = node.log?.id
        ? `<button class="log-link" data-node-log="${esc(node.log.id)}" title="在日志页打开">日志：${esc(node.log.label)}</button>`
        : `<p class="log-path">日志：${esc(node.log?.label ?? '—')}</p>`;
    openModal(node.label, `
        <div class="topo-detail">
            <p><span class="chip ${node.state}">${esc(stateLabel(node.state))}</span>
                <span class="muted">${esc(node.role)}</span></p>
            <dl class="facts topo-facts">${facts || '<div><dt>指标</dt><dd>—</dd></div>'}</dl>
            <p class="muted">数据来源：${esc(node.source)}</p>
            ${log}
        </div>`);
    const button = $('#modalBody').querySelector('[data-node-log]');
    if (button) {
        button.addEventListener('click', () => {
            state.logId = button.dataset.nodeLog;
            closeModal();
            navigate('logs');
        });
    }
}

/* ---------------------------------------------------------------- 影子页 */

function shadowQuery() {
    const scope = $('#shadowScope')?.value ?? 'all';
    const chatId = ($('#shadowChat')?.value ?? '').trim();
    const limit = $('#shadowLimit')?.value ?? '30';
    const excludeSamples = $('#shadowExclude')?.checked ? '1' : '0';
    return { scope, chatId, limit, excludeSamples };
}

async function loadShadow() {
    try {
        $('#view').innerHTML = renderShadowShell();
        bindShadowEvents();
        await refreshShadow();
    }
    catch (error) {
        $('#view').innerHTML = pageError('影子页加载失败', error, '检查 logs/shadow.jsonl 是否存在且为 JSONL。');
    }
}

function renderShadowShell() {
    return `
    <div class="panel">
        <div class="row">
            <label class="field" style="min-width:150px">场景
                <select id="shadowScope">
                    <option value="all">全部</option>
                    <option value="group">群聊</option>
                    <option value="dm">私聊</option>
                </select>
            </label>
            <label class="field" style="min-width:200px">群号 / QQ（可选）
                <input id="shadowChat" placeholder="例如 100000004">
            </label>
            <label class="field" style="min-width:110px">最近条数
                <select id="shadowLimit">
                    <option value="20">20</option>
                    <option value="30" selected>30</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                </select>
            </label>
            <label class="field check" style="align-self:flex-end">
                <input type="checkbox" id="shadowExclude">排除样例
            </label>
            <button id="shadowRefresh" style="align-self:flex-end">刷新</button>
            <button id="shadowCompare" class="accent" style="align-self:flex-end">调出 compare-shadow 统计</button>
        </div>
        <p class="muted">本页读旧栈 qq-onebot 插件写出的 logs/shadow.jsonl，只作新旧判定对照；真实流量服务方以状态页 cutover.json 为准，这里不参与真实回复。</p>
    </div>
    <div id="r6Body"></div>
    <div id="shadowBody"><div class="empty">读取 shadow.jsonl…</div></div>`;
}

function bindShadowEvents() {
    $('#shadowRefresh').addEventListener('click', () => refreshShadow());
    $('#shadowScope').addEventListener('change', () => refreshShadow());
    $('#shadowLimit').addEventListener('change', () => refreshShadow());
    $('#shadowExclude').addEventListener('change', () => refreshShadow());
    $('#shadowChat').addEventListener('keydown', event => {
        if (event.key === 'Enter')
            void refreshShadow();
    });
    $('#shadowCompare').addEventListener('click', () => void openCompare());
}

async function refreshShadow() {
    const { scope, chatId, limit, excludeSamples } = shadowQuery();
    const body = $('#shadowBody');
    if (!body)
        return;
    try {
        const data = await api('/api/shadow?' + new URLSearchParams({ scope, chatId, limit, excludeSamples }));
        state.shadow = data;
        renderShadow(data);
        void refreshR6();
    }
    catch (error) {
        body.innerHTML = `<div class="result-box error"><strong>读取影子日志失败</strong><p>${esc(error.message)}</p></div>
            <div class="row end" style="margin-top:12px"><button data-retry-shadow>重试</button></div>`;
        body.querySelector('[data-retry-shadow]').addEventListener('click', () => refreshShadow());
    }
}

function renderShadow(data) {
    const stats = data.stats;
    const ruleMax = Math.max(1, ...data.rules.map(rule => rule.total));
    const rules = data.rules.length === 0
        ? '<p class="empty">还没有判定记录。</p>'
        : data.rules.map(rule => `
            <div class="rulebar">
                <span class="name" title="${esc(rule.rule)}">${esc(rule.rule)}</span>
                <span class="bar"><i style="width:${Math.round(rule.total / ruleMax * 100)}%"></i></span>
                <span class="cnt">${rule.total} 条 · 回 ${rule.reply}</span>
            </div>`).join('');

    const items = data.items.length === 0
        ? '<p class="empty">当前筛选条件下没有判定记录。</p>'
        : data.items.map(item => renderDecision(item)).join('');

    const sampleNote = stats.samples > 0 && stats.samples === data.stats.allDecisions
        ? '<p class="muted">当前日志全部是样例（sample=true），只用于验证页面口径。</p>'
        : (stats.samples > 0 ? '<p class="muted">其中含 ' + stats.samples + ' 条样例数据。</p>' : '');

    $('#shadowBody').innerHTML = `
        <div class="tiles">
            <div class="tile"><div class="k">判定总数</div><div class="v">${stats.decisions}</div><div class="s">群 ${stats.group} · 私 ${stats.dm}</div></div>
            <div class="tile"><div class="k">判定为回复</div><div class="v">${stats.reply}</div><div class="s">占 ${pct(stats.decisions ? stats.reply / stats.decisions : null)}</div></div>
            <div class="tile"><div class="k">已观测旧插件</div><div class="v">${stats.observed}</div><div class="s">覆盖率 ${pct(stats.coverage)}</div></div>
            <div class="tile"><div class="k">一致性</div><div class="v ${stats.consistency === null ? '' : (stats.consistency >= 0.9 ? 'ok' : 'warn')}">${pct(stats.consistency)}</div><div class="s">TP+TN / 已观测</div></div>
            <div class="tile"><div class="k">假阴性 FN</div><div class="v ${stats.fn > 0 ? 'warn' : ''}">${stats.fn}</div><div class="s">新不回 / 旧回</div></div>
            <div class="tile"><div class="k">假阳性 FP</div><div class="v ${stats.fp > 0 ? 'warn' : ''}">${stats.fp}</div><div class="s">新回 / 旧不回</div></div>
            <div class="tile"><div class="k">影子回合</div><div class="v">${stats.wouldReply}</div><div class="s">失败 ${stats.wouldReplyFailed} · 平均 ${stats.avgMs === null ? '—' : stats.avgMs + ' ms'}</div></div>
        </div>
        <div class="panel">
            <div class="panel-head"><h2>按规则分布</h2><span class="muted">${esc(data.path)}${data.truncated ? '（只读了文件尾部）' : ''}</span></div>
            ${rules}
            ${sampleNote}
        </div>
        <div class="panel">
            <div class="panel-head"><h2>最近判定</h2><span class="muted">显示 ${data.returned} / 命中 ${data.matched} · 点开看「如果回会回什么」</span></div>
            ${items}
        </div>`;
}

/* R6 撤回对账：读取 watch-r6.mjs 写出的最近一次结论，只读展示。 */
async function refreshR6() {
    const body = $('#r6Body');
    if (!body)
        return;
    try {
        const data = await api('/api/r6');
        renderR6(body, data);
    }
    catch (error) {
        body.innerHTML = '<div class="result-box error">读取 R6 对账结果失败：' + esc(error.message) + '</div>';
    }
}

function renderR6(body, data) {
    if (data.exists !== true || data.result === null || data.result === undefined) {
        body.innerHTML = `
        <div class="panel">
            <div class="panel-head"><h2>R6 撤回对账</h2><span class="muted">还没有结果</span></div>
            <p class="muted">先在 QQ 里做一次真实动作（群 @机器人 后 60 秒内撤回，或私聊 /撤回）。
            后台脚本 watch-r6.mjs 每 2 秒轮询三个日志，出现 would_recall 就把结论写到这里；
            若脚本没在跑，用 <code>node Y:\\dsh\\归档\\2026-11-11\\onebot-plugin\\work\\watch-r6.mjs</code> 启动（该目录已归档，仅作离线核对）。</p>
        </div>`;
        return;
    }
    const result = data.result;
    const tone = result.verdict === 'PASS' ? 'ok' : ((result.verdict === 'SAMPLE' || result.verdict === 'PENDING') ? 'warn' : 'down');
    const boxClass = tone === 'ok' ? 'success' : (tone === 'warn' ? 'warn' : 'error');
    const checks = (result.checks ?? []).map(item => {
        const mark = item.id === 'memory' && result.verdict === 'PENDING' ? '… ' : (item.pass ? '✓ ' : '✗ ');
        return '<li>' + mark + esc(item.label) + '：' + esc(item.detail) + '</li>';
    }).join('');
    const recall = result.wouldRecall ?? {};
    const reply = result.wouldReply;
    const origin = result.origin ?? {};
    const safety = result.sendDelete ?? {};
    const memory = result.memory ?? {};

    body.innerHTML = `
    <div class="panel">
        <div class="panel-head">
            <h2>R6 撤回对账</h2>
            <span class="muted">${esc(fmtTime(result.generatedAt))} · 自动对账最近一条 would_recall</span>
        </div>
        <p><span class="chip ${tone}">${esc(result.verdict ?? '')}</span> ${esc(result.headline ?? '')}</p>
        <div class="kv">
            <span>would_reply <b>${esc(reply === null || reply === undefined ? '未匹配' : reply.id)}</b></span>
            <span>would_recall.targetId <b>${esc(recall.targetId ?? '—')}</b></span>
            <span>来源 <b>${esc(recall.source ?? '—')}</b></span>
            <span>规则 <b>${esc(recall.rule ?? '—')}</b></span>
            <span>原 messageId <b>${esc(origin.messageId ?? '未找到')}</b></span>
            <span>shadowOnly <b>${esc(String(safety.shadowOnly ?? '—'))}</b></span>
            <span>send/delete <b>${esc(String(safety.pluginHits ?? 0))}</b>（proxy ${esc(String(safety.proxyHits ?? 0))}）</span>
            <span>记忆 <b>${esc(memory.state ?? '—')}</b> · source-revoked ${esc(String(memory.revokedRows ?? 0))}</span>
        </div>
        <div class="result-box ${boxClass}"><ul>${checks}</ul></div>
    </div>`;
}

function renderDecision(item) {
    const sceneText = item.kind === 'group' ? '群 ' + item.chatId : '私聊 ' + item.chatId;
    const replyChip = item.reply
        ? '<span class="chip ok">判定回</span>'
        : '<span class="chip">判定不回</span>';
    const sampleChip = item.sample ? '<span class="chip warn">样例</span>' : '';
    const legacyText = item.legacy === null || item.legacy.replied === null
        ? '未观测'
        : (item.legacy.replied ? '旧插件回了' : '旧插件没回');
    const would = item.wouldReply === null
        ? '<p class="muted">没有生成拟回复（判定为不回，或 dryRunModel 关闭）。</p>'
        : '<pre>' + esc(item.wouldReply.text || '(空)') + '</pre>'
        + (item.wouldReply.error ? '<p class="result-box error">生成失败：' + esc(item.wouldReply.error) + '</p>' : '');

    return `
    <details class="decision">
        <summary>
            <span class="time">${esc(fmtTime(item.ts))}</span>
            <span class="scene">${esc(sceneText)}</span>
            ${replyChip}${sampleChip}
            <span class="preview" title="${esc(item.textPreview)}">${esc(item.textPreview)}</span>
        </summary>
        <div class="body">
            <div class="kv">
                <span>发送者 <b>${esc(item.sender.nickname || '')}(${esc(item.sender.qq || '')})</b></span>
                <span>规则 <b>${esc(item.rule)}</b></span>
                <span>原因 <b>${esc(item.reason)}</b></span>
                <span>合并消息 <b>${item.messageCount}</b> 条</span>
                <span>被直接指向 <b>${item.addressed ? '是' : '否'}</b></span>
                <span>旧插件 <b>${esc(legacyText)}</b></span>
                <span>耗时 <b>${item.wouldReply ? item.wouldReply.ms + ' ms' : '—'}</b></span>
            </div>
            <h4>入站原文</h4>
            <pre>${esc(item.textPreview || '(空)')}</pre>
            <h4>如果回，会回什么（未发送）</h4>
            ${would}
        </div>
    </details>`;
}

async function openCompare() {
    const excludeSamples = $('#shadowExclude')?.checked === true;
    openModal('compare-shadow 统计', '<div class="status-line"><span class="spinner"></span>正在运行 compare-shadow.mjs…</div>');
    try {
        const data = await api('/api/shadow/compare', {
            method: 'POST',
            body: JSON.stringify({ excludeSamples }),
        });
        const report = data.report;
        const m = report.matrix;
        const summary = `
            <div class="tiles" style="margin:14px 0">
                <div class="tile"><div class="k">decision</div><div class="v">${report.sample.decisions}</div><div class="s">sample ${report.sample.sample}</div></div>
                <div class="tile"><div class="k">可观测</div><div class="v">${report.coverage.observed}</div><div class="s">覆盖率 ${pct(report.coverage.ratio)}</div></div>
                <div class="tile"><div class="k">假阴性率</div><div class="v ${m.fnRate === null ? '' : (m.fnRate > 0.1 ? 'warn' : 'ok')}">${pct(m.fnRate)}</div><div class="s">FN ${m.fn} / 分母 ${m.tp + m.fn}</div></div>
                <div class="tile"><div class="k">假阳性率</div><div class="v ${m.fpRate === null ? '' : (m.fpRate > 0.1 ? 'warn' : 'ok')}">${pct(m.fpRate)}</div><div class="s">FP ${m.fp} / 分母 ${m.tp + m.fp}</div></div>
            </div>`;
        $('#modalBody').innerHTML = summary
            + '<div class="muted" style="margin-bottom:8px">脚本原始输出：</div>'
            + '<pre>' + esc(data.markdown || '(无输出)') + '</pre>';
    }
    catch (error) {
        const detail = error.data?.errors?.length
            ? '<ul>' + error.data.errors.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
            : '';
        $('#modalBody').innerHTML = '<div class="result-box error"><strong>' + esc(error.message) + '</strong>' + detail + '</div>';
    }
}

/* ---------------------------------------------------------------- 弹层 */

function openModal(title, html) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modal').classList.remove('hidden');
}

function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalBody').innerHTML = '';
}

/* ---------------------------------------------------------------- 配置页 */

function rawAt(path) {
    let cursor = state.cfg?.raw;
    for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined)
            return undefined;
        cursor = cursor[key];
    }
    return cursor;
}

function effDefaultAt(path) {
    let cursor = state.cfg?.effective?.default;
    for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined)
            return undefined;
        cursor = cursor[key];
    }
    return cursor;
}

function defaultPlaceholder(path) {
    const value = effDefaultAt(path);
    if (value === undefined || value === null || value === '')
        return '继承内置默认';
    if (Array.isArray(value))
        return value.length === 0 ? '继承内置默认（空）' : '默认 ' + value.join(', ');
    return '默认 ' + value;
}

function textField(label, path, { value, placeholder = '', kind = 'text', attrs = '', wide = false } = {}) {
    return `<label class="field${wide ? ' wide' : ''}"><span>${esc(label)}</span>
        <input data-path="${esc(path)}" data-kind="${esc(kind)}"
            type="${kind === 'number' ? 'number' : 'text'}"
            value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${attrs}></label>`;
}

function selectField(label, path, options, { value, wide = false } = {}) {
    const html = options.map(option =>
        `<option value="${esc(option.value)}"${String(option.value) === String(value ?? '') ? ' selected' : ''}>${esc(option.label)}</option>`
    ).join('');
    return `<label class="field${wide ? ' wide' : ''}"><span>${esc(label)}</span>
        <select data-path="${esc(path)}" data-kind="select">${html}</select></label>`;
}

function boolSelect(label, path, value) {
    const current = typeof value === 'boolean' ? String(value) : '';
    return `<label class="field"><span>${esc(label)}</span>
        <select data-path="${esc(path)}" data-kind="boolselect">
            <option value=""${current === '' ? ' selected' : ''}>继承默认</option>
            <option value="true"${current === 'true' ? ' selected' : ''}>开</option>
            <option value="false"${current === 'false' ? ' selected' : ''}>关</option>
        </select></label>`;
}

function checkField(label, path, checked) {
    return `<label class="field check"><input type="checkbox" data-path="${esc(path)}" data-kind="bool"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
}

const MODE_OPTIONS_INHERIT = [
    { value: '', label: '继承默认' },
    { value: 'at', label: 'at · 被 @ 才回' },
    { value: 'keyword', label: 'keyword · 关键词' },
    { value: 'regex', label: 'regex · 正则' },
    { value: 'random', label: 'random · 随机' },
    { value: 'reply', label: 'reply · 回复机器人' },
    { value: 'always', label: 'always · 都回' },
];
const ACTIVITY_OPTIONS = [
    { value: '', label: '继承（默认 quiet）' },
    { value: 'quiet', label: 'quiet · 只认 @/回复' },
    { value: 'casual', label: 'casual · 偶聊（0.15 / 180s / 3 条每小时）' },
    { value: 'chatty', label: 'chatty · 话痨（0.5 / 20s / 10 条每小时）' },
];

async function loadConfig() {
    try {
        const data = await api('/api/config');
        state.cfg = data;
        renderConfig();
    }
    catch (error) {
        $('#view').innerHTML = pageError('配置加载失败', error, '检查 config.json 是否存在、是否为合法 JSON。');
    }
}

function renderConfig() {
    const cfg = state.cfg;
    const raw = cfg.raw ?? {};
    const defaultLayer = raw.default ?? {};
    const water = defaultLayer.water ?? {};
    const groups = raw.groups ?? {};
    const dm = raw.dm ?? {};
    const modeValue = defaultLayer.trigger?.mode ?? '';

    const groupCards = Object.keys(groups).length === 0
        ? '<p class="muted">没有群级覆盖，所有群使用默认层。</p>'
        : Object.keys(groups).map(gid => renderGroupCard(gid, groups[gid] ?? {})).join('');

    const validation = cfg.validation.ok
        ? '<span class="chip ok">当前配置有效</span>'
        : '<span class="chip down">当前配置无效</span>';
    const warnings = cfg.validation.warnings.length > 0
        ? '<div class="result-box warn"><strong>告警</strong><ul>'
        + cfg.validation.warnings.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul></div>'
        : '';

    $('#view').innerHTML = `
    <div class="panel">
        <div class="panel-head">
            <h2>配置文件</h2>
            <span class="muted">${esc(cfg.path)} · ${fmtBytes(cfg.size)} · 修改于 ${esc(fmtTime(cfg.mtime))}</span>
        </div>
        <div class="row">${validation}
            <span class="muted">保存前用 validateConfig 整份校验；非法直接拒绝，合法才原子写入，插件 watch 会自动热重载。</span>
        </div>
        ${warnings}
    </div>

    <div class="panel">
        <div class="panel-head"><h2>默认层</h2><span class="muted">所有群与私信的基础值；留空 = 继承内置默认</span></div>
        <div class="grid3">
            ${selectField('触发方式', 'default.trigger.mode', MODE_OPTIONS_INHERIT, { value: modeValue })}
            ${textField('触发概率 chance', 'default.trigger.chance', { value: defaultLayer.trigger?.chance, placeholder: defaultPlaceholder('trigger.chance'), kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${textField('回复概率 replyChance', 'default.replyChance', { value: defaultLayer.replyChance, placeholder: defaultPlaceholder('replyChance'), kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${textField('关键词（逗号分隔）', 'default.trigger.keywords', { value: (defaultLayer.trigger?.keywords ?? []).join(', '), placeholder: defaultPlaceholder('trigger.keywords'), kind: 'list', wide: true })}
            ${textField('正则', 'default.trigger.regex', { value: defaultLayer.trigger?.regex, placeholder: defaultPlaceholder('trigger.regex'), wide: true })}
            ${textField('提及名（逗号分隔）', 'default.trigger.mentionNames', { value: (defaultLayer.trigger?.mentionNames ?? []).join(', '), placeholder: defaultPlaceholder('trigger.mentionNames'), kind: 'list', wide: true })}
            ${checkField('回复机器人消息', 'default.trigger.replyToBot', defaultLayer.trigger?.replyToBot ?? effDefaultAt('trigger.replyToBot') === true)}
            ${checkField('允许打趣 banter', 'default.trigger.banter', defaultLayer.trigger?.banter ?? effDefaultAt('trigger.banter') === true)}
            ${checkField('开启审校 review', 'default.review', defaultLayer.review ?? effDefaultAt('review') === true)}
        </div>
        <div class="divider"></div>
        <div class="grid3">
            ${textField('每分钟上限', 'default.limits.perMinute', { value: defaultLayer.limits?.perMinute, placeholder: defaultPlaceholder('limits.perMinute'), kind: 'number', attrs: 'min="0"' })}
            ${textField('每小时上限（0=不限）', 'default.limits.perHour', { value: defaultLayer.limits?.perHour, placeholder: defaultPlaceholder('limits.perHour'), kind: 'number', attrs: 'min="0"' })}
            ${textField('每天上限（0=不限）', 'default.limits.perDay', { value: defaultLayer.limits?.perDay, placeholder: defaultPlaceholder('limits.perDay'), kind: 'number', attrs: 'min="0"' })}
            ${textField('冷却秒', 'default.limits.cooldownSec', { value: defaultLayer.limits?.cooldownSec, placeholder: defaultPlaceholder('limits.cooldownSec'), kind: 'number', attrs: 'min="0"' })}
            ${textField('免打扰开始 HH:MM', 'default.dnd.start', { value: defaultLayer.dnd?.start, placeholder: defaultPlaceholder('dnd.start') })}
            ${textField('免打扰结束 HH:MM', 'default.dnd.end', { value: defaultLayer.dnd?.end, placeholder: defaultPlaceholder('dnd.end') })}
            ${textField('时区', 'default.dnd.timezone', { value: defaultLayer.dnd?.timezone, placeholder: defaultPlaceholder('dnd.timezone') })}
        </div>
        <div class="divider"></div>
        <div class="grid3">
            ${textField('上下文预算 tokens', 'default.context.budgetTokens', { value: defaultLayer.context?.budgetTokens, placeholder: defaultPlaceholder('context.budgetTokens'), kind: 'number', attrs: 'min="0"' })}
            ${textField('上下文最多消息条数', 'default.context.maxMessages', { value: defaultLayer.context?.maxMessages, placeholder: defaultPlaceholder('context.maxMessages'), kind: 'number', attrs: 'min="0"' })}
            ${selectField('私信准入策略', 'default.access.dmPolicy', [
                { value: '', label: '继承内置默认' },
                { value: 'allowlist', label: 'allowlist · 白名单' },
                { value: 'open', label: 'open · 所有人' },
                { value: 'disabled', label: 'disabled · 关闭' },
            ], { value: defaultLayer.access?.dmPolicy })}
            ${selectField('群准入策略', 'default.access.groupPolicy', [
                { value: '', label: '继承内置默认' },
                { value: 'allowlist', label: 'allowlist · 白名单' },
                { value: 'open', label: 'open · 所有人' },
                { value: 'disabled', label: 'disabled · 关闭' },
            ], { value: defaultLayer.access?.groupPolicy })}
            ${checkField('允许所有人（allowAll）', 'default.access.allowAll', defaultLayer.access?.allowAll ?? effDefaultAt('allowAll') === true)}
            ${textField('允许的用户（逗号分隔）', 'default.access.allowUsers', { value: (defaultLayer.access?.allowUsers ?? []).join(', '), placeholder: defaultPlaceholder('access.allowUsers'), kind: 'list', wide: true })}
            ${textField('拒绝的用户（逗号分隔）', 'default.access.denyUsers', { value: (defaultLayer.access?.denyUsers ?? []).join(', '), placeholder: defaultPlaceholder('access.denyUsers'), kind: 'list', wide: true })}
            ${textField('拒绝的群（逗号分隔）', 'default.access.denyGroups', { value: (defaultLayer.access?.denyGroups ?? []).join(', '), placeholder: defaultPlaceholder('access.denyGroups'), kind: 'list', wide: true })}
        </div>
    </div>

    <div class="panel">
        <div class="panel-head"><h2>水群模式</h2><span class="muted">主人 @ 机器人开启；只放宽「是否该回」，静默/清洗/审校/权限不变</span></div>
        <div class="grid3">
            ${textField('默认时长（分钟）', 'default.water.defaultMinutes', { value: water.defaultMinutes, placeholder: defaultPlaceholder('water.defaultMinutes'), kind: 'number', attrs: 'min="1" max="1440"' })}
            ${textField('单次上限（分钟）', 'default.water.maxMinutes', { value: water.maxMinutes, placeholder: defaultPlaceholder('water.maxMinutes'), kind: 'number', attrs: 'min="1" max="1440"' })}
            ${textField('接话概率 chance', 'default.water.chance', { value: water.chance, placeholder: defaultPlaceholder('water.chance'), kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${textField('两条最小间隔（秒）', 'default.water.minIntervalSec', { value: water.minIntervalSec, placeholder: defaultPlaceholder('water.minIntervalSec'), kind: 'number', attrs: 'min="0"' })}
            ${textField('每小时上限', 'default.water.perHour', { value: water.perHour, placeholder: defaultPlaceholder('water.perHour'), kind: 'number', attrs: 'min="0"' })}
            ${textField('每天上限', 'default.water.perDay', { value: water.perDay, placeholder: defaultPlaceholder('water.perDay'), kind: 'number', attrs: 'min="0"' })}
            ${textField('连续被无视几次降温', 'default.water.quietAfterIgnored', { value: water.quietAfterIgnored, placeholder: defaultPlaceholder('water.quietAfterIgnored'), kind: 'number', attrs: 'min="0"' })}
            ${textField('降温时长（分钟）', 'default.water.quietMinutes', { value: water.quietMinutes, placeholder: defaultPlaceholder('water.quietMinutes'), kind: 'number', attrs: 'min="0"' })}
            ${textField('单条字数上限', 'default.water.maxChars', { value: water.maxChars, placeholder: defaultPlaceholder('water.maxChars'), kind: 'number', attrs: 'min="1" max="1000"' })}
            ${checkField('开启时回一句确认', 'default.water.ackOnOpen', water.ackOnOpen ?? effDefaultAt('water.ackOnOpen') === true)}
        </div>
        <p class="muted">判定与节流由 qq-persona/water-mode.mjs 共享执行；每条判定写入 shadow.jsonl（mode:"water"），可按 hourLocal 聚合。</p>
    </div>

    <div class="panel">
        <div class="panel-head"><h2>群级覆盖</h2><span class="muted">只允许行为字段；留空 = 继承默认层</span></div>
        <div id="groupCards">${groupCards}</div>
        <div class="row" style="margin-top:8px">
            <input id="newGroupId" placeholder="新增群号（5-12 位数字）" style="max-width:240px">
            <button id="addGroup">添加群</button>
        </div>
    </div>

    <div class="panel">
        <div class="panel-head"><h2>私信</h2><span class="muted">私信默认 always、不审校</span></div>
        <div class="grid3">
            ${selectField('触发方式', 'dm.trigger.mode', MODE_OPTIONS_INHERIT, { value: dm.trigger?.mode })}
            ${textField('回复概率', 'dm.replyChance', { value: dm.replyChance, placeholder: '继承默认', kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${boolSelect('审校', 'dm.review', dm.review)}
        </div>
    </div>

    <div class="row end" style="margin-bottom:16px">
        <button id="cfgReload">重新读取</button>
        <button id="cfgValidate">仅校验</button>
        <button id="cfgSave" class="accent">校验并保存</button>
    </div>
    <div id="cfgResult" class="result-box"></div>

    <details class="panel" id="cfgAdvanced">
        <summary style="cursor:pointer;font-size:14px;font-weight:600">高级：原始 JSON（保存同样走整份校验）</summary>
        <p class="muted">适合编辑表单没覆盖的字段（runtime/shadow/samples 等）。打开时会用当前表单内容生成。</p>
        <textarea id="cfgJson" rows="18" spellcheck="false"></textarea>
        <div class="row end" style="margin-top:10px">
            <button id="cfgJsonValidate">校验 JSON</button>
            <button id="cfgJsonSave" class="accent">保存 JSON</button>
        </div>
    </details>`;

    bindConfigEvents();
}

/* ------------------------------------------------------- 群白名单（旧栈） */

async function loadGroups() {
    try {
        renderGroups(await api('/api/groups'));
    }
    catch (error) {
        $('#view').innerHTML = pageError('群白名单读取失败', error, '检查 cordis.patch.yml 是否存在、是否有 dsh-onebot 条目。');
    }
}

// 群白名单只写旧栈 cordis.patch.yml；真实服务方从 cutover.json 现读，避免页面按旧口径写成“旧栈在服务”。
function groupsCutoverNote(cut) {
    if (!cut)
        return '真实流量服务方：未核实（/api/groups 未返回 cutover）。';
    const mode = esc(cut.mode ?? '未知');
    const stage = esc(cut.stage ?? '未知');
    if (cut.oldStackServing === false)
        return '真实流量服务方：旧栈未服务（cutover mode=' + mode + ' · stage=' + stage + '）；此表只影响旧栈进程，不改变 AstrBot 的群放行。';
    if (cut.oldStackServing === true)
        return '真实流量服务方：旧栈仍在服务（cutover mode=' + mode + ' · stage=' + stage + '）。';
    return '真实流量服务方：未核实（cutover oldStackServing 不可解析）。';
}

function renderGroups(data) {
    const policyOptions = (data.policies ?? ['open', 'allowlist', 'disabled'])
        .map(value => `<option value="${esc(value)}"${value === data.policy ? ' selected' : ''}>${esc(value)}</option>`)
        .join('');
    const groups = Array.isArray(data.groups) ? data.groups : [];
    $('#view').innerHTML = `
    <div class="panel">
        <div class="panel-head"><h2>旧栈群白名单</h2><span class="muted">${esc(data.path)} · 修改于 ${esc(fmtTime(data.mtime))}</span></div>
        <p class="muted">这是 dsh-onebot（旧栈）实际生效的名单。保存会先备份、再原子替换 cordis.patch.yml，<b>重启 dsh 后生效</b>。
            ${groupsCutoverNote(data.cutover)}</p>
        <div class="grid3">
            <label class="field"><span>群准入策略</span><select id="groupsPolicy">${policyOptions}</select></label>
        </div>
        <label class="field wide"><span>允许的群（逗号或换行分隔）</span>
            <input id="groupsAllow" data-kind="list" value="${esc(groups.join(', '))}" placeholder="例如 100000001, 100000002">
        </label>
        <p class="muted">当前 ${groups.length} 个群；只有 allowlist 策略下这张表才生效。</p>
    </div>
    <div class="row end" style="margin-bottom:16px"><button id="groupsSave" class="accent">校验并保存</button></div>
    <div id="groupsResult" class="result-box"></div>`;
    $('#groupsSave').addEventListener('click', () => void saveGroups());
}

async function saveGroups() {
    const box = $('#groupsResult');
    const policy = $('#groupsPolicy').value;
    const groups = $('#groupsAllow').value.split(/[\s,，]+/u).filter(Boolean);
    box.className = 'result-box';
    box.textContent = '正在写入…';
    try {
        const data = await api('/api/groups', {
            method: 'POST',
            body: JSON.stringify({ policy, groups }),
        });
        box.className = 'result-box success';
        box.innerHTML = esc(data.message ?? '已保存')
            + '<br><span class="muted">备份：' + esc(data.backup ?? '—') + ' · 重启 dsh 后生效</span>';
    }
    catch (error) {
        box.className = 'result-box error';
        box.textContent = error.message;
    }
}

function renderGroupCard(gid, group) {
    const trigger = group.trigger ?? {};
    const limits = group.limits ?? {};
    const dnd = group.dnd ?? {};
    const activity = typeof group.activity === 'string' ? group.activity : (group.activity?.level ?? '');
    return `
    <div class="group-card" data-gid="${esc(gid)}">
        <div class="group-head">
            <h3>群 ${esc(gid)}</h3>
            <button class="mini danger" data-remove-group="${esc(gid)}">移除覆盖</button>
        </div>
        <div class="grid3">
            ${selectField('触发方式', 'groups.' + gid + '.trigger.mode', MODE_OPTIONS_INHERIT, { value: trigger.mode })}
            ${textField('触发概率', 'groups.' + gid + '.trigger.chance', { value: trigger.chance, placeholder: '继承默认', kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${textField('回复概率', 'groups.' + gid + '.replyChance', { value: group.replyChance, placeholder: '继承默认', kind: 'number', attrs: 'min="0" max="1" step="0.05"' })}
            ${textField('每分钟上限', 'groups.' + gid + '.limits.perMinute', { value: limits.perMinute, placeholder: '继承默认', kind: 'number', attrs: 'min="0"' })}
            ${textField('冷却秒', 'groups.' + gid + '.limits.cooldownSec', { value: limits.cooldownSec, placeholder: '继承默认', kind: 'number', attrs: 'min="0"' })}
            ${boolSelect('审校', 'groups.' + gid + '.review', group.review)}
            ${selectField('活跃度', 'groups.' + gid + '.activity', ACTIVITY_OPTIONS, { value: activity })}
            ${textField('免打扰开始', 'groups.' + gid + '.dnd.start', { value: dnd.start, placeholder: '继承默认' })}
            ${textField('免打扰结束', 'groups.' + gid + '.dnd.end', { value: dnd.end, placeholder: '继承默认' })}
        </div>
        <p class="muted">活跃度：quiet=只认 @；casual/chatty 走水群同一套候选与节流。群级数值覆盖可在高级 JSON 里写对象，如 {"level":"casual","chance":0.2,"perHour":4}。</p>
    </div>`;
}

function setDeep(target, path, value) {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        if (cursor[parts[index]] === null || typeof cursor[parts[index]] !== 'object')
            cursor[parts[index]] = {};
        cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
}

function delDeep(target, path) {
    const parts = path.split('.');
    let cursor = target;
    const chain = [];
    for (let index = 0; index < parts.length - 1; index += 1) {
        if (cursor === null || typeof cursor !== 'object')
            return;
        chain.push([cursor, parts[index]]);
        cursor = cursor[parts[index]];
    }
    if (cursor === null || typeof cursor !== 'object')
        return;
    delete cursor[parts[parts.length - 1]];
    // 清理因此变空的中间对象，保持配置文件稀疏、可读
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const [parent, key] = chain[index];
        if (parent[key] && typeof parent[key] === 'object'
            && !Array.isArray(parent[key]) && Object.keys(parent[key]).length === 0)
            delete parent[key];
    }
}

function collectFields(root, draft) {
    $$('[data-path]', root).forEach(element => {
        const path = element.dataset.path;
        const kind = element.dataset.kind;
        if (kind === 'bool') {
            setDeep(draft, path, element.checked);
            return;
        }
        const value = element.value.trim();
        if (kind === 'select') {
            if (value === '')
                delDeep(draft, path);
            else {
                // 形如 { level, chance, perHour } 的对象只改 level，保留手工写的数值覆盖。
                const original = rawAt(path);
                if (original !== null && typeof original === 'object' && !Array.isArray(original)
                    && Object.hasOwn(original, 'level'))
                    setDeep(draft, path, { ...original, level: value });
                else
                    setDeep(draft, path, value);
            }
            return;
        }
        if (kind === 'boolselect') {
            if (value === '')
                delDeep(draft, path);
            else
                setDeep(draft, path, value === 'true');
            return;
        }
        if (value === '') {
            // 原文里本来就有的空值（regex:"" / dnd:"" / 空数组）保留，避免无改动保存也产生 diff。
            const original = rawAt(path);
            if (typeof original === 'string')
                setDeep(draft, path, '');
            else if (Array.isArray(original))
                setDeep(draft, path, []);
            else
                delDeep(draft, path);
            return;
        }
        if (kind === 'number')
            setDeep(draft, path, Number(value));
        else if (kind === 'list')
            setDeep(draft, path, value.split(/[,，]/).map(item => item.trim()).filter(Boolean));
        else
            setDeep(draft, path, value);
    });
    return draft;
}

function buildDraft() {
    const draft = structuredClone(state.cfg?.raw ?? {});
    collectFields($('#view'), draft);
    // 空覆盖的群也要保留条目：删空字段不应把群从列表里抹掉。
    const knownGroups = Object.keys(state.cfg?.raw?.groups ?? {});
    if (knownGroups.length > 0) {
        draft.groups = draft.groups ?? {};
        for (const gid of knownGroups) {
            if (draft.groups[gid] === null || typeof draft.groups[gid] !== 'object')
                draft.groups[gid] = {};
        }
    }
    return draft;
}

function bindConfigEvents() {
    $('#cfgReload').addEventListener('click', () => void loadConfig());
    $('#cfgValidate').addEventListener('click', () => void submitConfig(buildDraft(), true));
    $('#cfgSave').addEventListener('click', () => void submitConfig(buildDraft(), false));
    $('#addGroup').addEventListener('click', () => {
        const input = $('#newGroupId');
        const gid = input.value.trim();
        if (!/^\d{5,12}$/.test(gid)) {
            showCfgResult('error', ['群号必须是 5-12 位数字']);
            return;
        }
        const draft = buildDraft();
        draft.groups = draft.groups ?? {};
        if (draft.groups[gid]) {
            showCfgResult('error', ['群 ' + gid + ' 已存在']);
            return;
        }
        draft.groups[gid] = {};
        state.cfg.raw = draft;
        renderConfig();
    });
    $$('[data-remove-group]').forEach(button => {
        button.addEventListener('click', () => {
            const gid = button.dataset.removeGroup;
            if (!confirm('移除群 ' + gid + ' 的覆盖？（保存后才写入磁盘）'))
                return;
            const draft = buildDraft();
            if (draft.groups)
                delete draft.groups[gid];
            state.cfg.raw = draft;
            renderConfig();
        });
    });
    const advanced = $('#cfgAdvanced');
    advanced.addEventListener('toggle', () => {
        if (advanced.open)
            $('#cfgJson').value = JSON.stringify(buildDraft(), null, 2);
    });
    $('#cfgJsonValidate').addEventListener('click', () => {
        try {
            void submitConfig(JSON.parse($('#cfgJson').value), true);
        }
        catch (error) {
            showCfgResult('error', ['JSON 解析失败：' + String(error?.message ?? error)]);
        }
    });
    $('#cfgJsonSave').addEventListener('click', () => {
        try {
            void submitConfig(JSON.parse($('#cfgJson').value), false);
        }
        catch (error) {
            showCfgResult('error', ['JSON 解析失败：' + String(error?.message ?? error)]);
        }
    });
}

function showCfgResult(kind, errors, warnings, message) {
    const box = $('#cfgResult');
    if (!box)
        return;
    box.className = 'result-box ' + kind;
    box.innerHTML = (message ? '<strong>' + esc(message) + '</strong>' : '')
        + (errors && errors.length
            ? '<ul>' + errors.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
            : '')
        + (warnings && warnings.length
            ? '<p class="muted">告警（不阻止保存）：</p><ul>'
            + warnings.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
            : '');
}

async function submitConfig(raw, dryRun) {
    if (!raw || typeof raw !== 'object') {
        showCfgResult('error', ['配置必须是 JSON 对象']);
        return;
    }
    showCfgResult('warn', [], [], dryRun ? '校验中…' : '校验并写入中…');
    try {
        const data = await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ config: raw, dryRun }),
        });
        if (dryRun) {
            showCfgResult(data.errors.length ? 'error' : 'success', data.errors, data.warnings,
                data.errors.length ? '校验未通过（未写入）' : '校验通过（未写入）');
            return;
        }
        const changed = Array.isArray(data.changed) && data.changed.length
            ? '　变更字段：' + data.changed.join('、')
            : '';
        showBanner('success', data.message + changed + (data.backup ? '　备份：' + data.backup : ''));
        await loadConfig();
    }
    catch (error) {
        showCfgResult('error', error.data?.errors ?? [error.message], error.data?.warnings,
            error.data?.error ?? '保存失败');
    }
}

/* ---------------------------------------------------------------- 日志页 */

async function loadLogs() {
    try {
        const data = await api('/api/logs');
        state.logComponents = data.components;
        if (!state.logComponents.some(item => item.id === state.logId))
            state.logId = state.logComponents[0]?.id ?? '';
        renderLogs();
        await loadLogContent();
    }
    catch (error) {
        $('#view').innerHTML = pageError('日志列表加载失败', error, '检查插件 logs 目录与 persona 目录是否存在。');
    }
}

function renderLogs() {
    const options = state.logComponents.map(item =>
        `<option value="${esc(item.id)}"${item.id === state.logId ? ' selected' : ''}>${esc(item.label)}${item.exists ? '' : '（缺失）'}</option>`
    ).join('');

    $('#view').innerHTML = `
    <div class="panel">
        <div class="row">
            <label class="field" style="flex:1;min-width:280px">日志组件
                <select id="logSelect">${options}</select>
            </label>
            <label class="field" style="min-width:110px">行数
                <select id="logLines">
                    <option value="50">50</option>
                    <option value="200" selected>200</option>
                    <option value="500">500</option>
                    <option value="1000">1000</option>
                </select>
            </label>
            <label class="field" style="flex:1;min-width:200px">关键词过滤
                <input id="logQuery" placeholder="包含该关键词的行">
            </label>
            <label class="field check" style="align-self:flex-end">
                <input type="checkbox" id="logAuto">自动刷新 5s
            </label>
            <button id="logRefresh" style="align-self:flex-end">刷新</button>
        </div>
        <p class="muted" style="margin:12px 0 0">只读取文件尾部 512KB，不会把超大日志整体载入内存。</p>
    </div>
    <div class="char-meta" id="logMeta">—</div>
    <pre class="log" id="logText">加载中…</pre>`;

    $('#logRefresh').addEventListener('click', () => void loadLogContent());
    $('#logSelect').addEventListener('change', event => {
        state.logId = event.target.value;
        void loadLogContent();
    });
    $('#logLines').addEventListener('change', () => void loadLogContent());
    $('#logQuery').addEventListener('keydown', event => {
        if (event.key === 'Enter')
            void loadLogContent();
    });
    $('#logAuto').addEventListener('change', event => {
        state.logAuto = event.target.checked;
        clearTimers();
        if (state.logAuto)
            state.timers.logs = setInterval(() => void loadLogContent(), 5000);
    });
}

async function loadLogContent() {
    if (!state.logId) {
        $('#logText').textContent = '没有可用的日志文件。';
        return;
    }
    const lines = $('#logLines')?.value ?? '200';
    const keyword = $('#logQuery')?.value ?? '';
    try {
        const data = await api('/api/logs/content?' + new URLSearchParams({ id: state.logId, lines, q: keyword }));
        $('#logMeta').textContent = data.path + ' · ' + fmtBytes(data.size) + ' · 修改于 ' + fmtTime(data.mtime)
            + ' · 窗口内 ' + data.totalInWindow + ' 行 · 命中 ' + data.matched + ' · 显示 ' + data.returned + ' 行'
            + (data.fileTruncated ? ' · 只读尾部' : '');
        const text = data.text === '' ? '(没有匹配的行)' : data.text;
        $('#logText').innerHTML = highlight(text, keyword.trim());
        $('#logText').scrollTop = $('#logText').scrollHeight;
    }
    catch (error) {
        $('#logMeta').textContent = '读取失败';
        $('#logText').textContent = error.message;
    }
}

function highlight(text, keyword) {
    if (!keyword)
        return esc(text);
    const lower = text.toLowerCase();
    const needle = keyword.toLowerCase();
    let out = '';
    let cursor = 0;
    while (true) {
        const index = lower.indexOf(needle, cursor);
        if (index < 0) {
            out += esc(text.slice(cursor));
            break;
        }
        out += esc(text.slice(cursor, index)) + '<mark>' + esc(text.slice(index, index + needle.length)) + '</mark>';
        cursor = index + needle.length;
    }
    return out;
}

/* ---------------------------------------------------------------- 人格页 */

async function loadCharacter() {
    try {
        const data = await api('/api/character');
        state.char = data;
        state.charEditing = false;
        renderCharacter();
    }
    catch (error) {
        $('#view').innerHTML = pageError('人格文件读取失败', error, '检查 E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona\\character.md 是否存在。');
    }
}

function renderCharacter() {
    const data = state.char;
    $('#view').innerHTML = `
    <div class="panel">
        <div class="panel-head">
            <h2>人格文件</h2>
            <span class="muted">改动会直接作用于人格注入，保存前需要确认</span>
        </div>
        <div class="char-bar">
            <span class="char-meta">${esc(data.path)} · ${fmtBytes(data.size)} · 修改于 ${esc(fmtTime(data.mtime))}</span>
            <span class="row">
                <button id="charEdit">编辑</button>
                <button id="charCancel" class="hidden">取消</button>
                <button id="charSave" class="accent hidden">确认保存</button>
            </span>
        </div>
        <textarea id="charText" class="char" spellcheck="false" readonly>${esc(data.text)}</textarea>
        <p class="muted" style="margin:10px 0 0">只读预览；点「编辑」解锁。保存会把旧文件备份到 home/qq-console/backups/。</p>
    </div>`;

    const textarea = $('#charText');
    $('#charEdit').addEventListener('click', () => {
        textarea.readOnly = false;
        textarea.focus();
        state.charEditing = true;
        $('#charCancel').classList.remove('hidden');
        $('#charSave').classList.remove('hidden');
        $('#charEdit').classList.add('hidden');
    });
    $('#charCancel').addEventListener('click', () => {
        textarea.value = state.char.text;
        textarea.readOnly = true;
        state.charEditing = false;
        $('#charCancel').classList.add('hidden');
        $('#charSave').classList.add('hidden');
        $('#charEdit').classList.remove('hidden');
    });
    $('#charSave').addEventListener('click', async () => {
        if (!state.charEditing)
            return;
        if (!confirm('确认覆盖 character.md？旧文件会备份到 backups/。'))
            return;
        try {
            const data = await api('/api/character', {
                method: 'PUT',
                body: JSON.stringify({ text: textarea.value, confirm: true }),
            });
            showBanner('success', data.message + '（' + fmtBytes(data.size) + '）');
            state.char = { ...state.char, text: textarea.value, mtime: data.mtime, size: data.size };
            renderCharacter();
        }
        catch (error) {
            showBanner('error', '保存失败：' + error.message);
        }
    });
}

/* ---------------------------------------------------------------- B 站页 */

async function loadBili(page = 1) {
    state.biliPage = page;
    try {
        const [data, local] = await Promise.all([
            api('/api/bili?page=' + page + '&size=20'),
            api('/api/media-video').catch(() => null),
        ]);
        state.bili = data;
        state.mediaVideo = local;
        renderBili();
    }
    catch (error) {
        $('#view').innerHTML = pageError('B 站记录读取失败', error,
            '确认控制台能读 E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona\\bili-state.json；账号校验需要能访问 api.bilibili.com。');
    }
}

function videoFrameCard() {
    const data = state.mediaVideo;
    if (!data || data.ok !== true)
        return '';
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const last = rows[0] ?? null;
    const head = '<div class="panel-head"><h2>跨片取帧</h2><span class="muted">最近一条 · media_video.jsonl 最后一行</span></div>';
    if (!last) {
        return `<div class="panel" style="margin-top:18px">${head}
            <p class="empty">暂无记录：还没有视频被抽帧。</p>
            <p class="muted">来源：${esc(data.source)}</p></div>`;
    }
    const file = String(last.path || '');
    const name = file.split(/[\\/]/).pop() || file || '—';
    // observedAt 才是真正送进视觉的时间点；frames 是抽出到磁盘的帧数，两者不等很正常。
    const observed = Array.isArray(last.observedAt) ? last.observedAt : null;
    const sentText = observed === null
        ? '未记录（这一行没有 observedAt）'
        : observed.length === 0
            ? '0 帧（observedAt 是空数组）'
            : observed.map(value => Number(value).toFixed(1) + 's').join(' · ')
                + '（' + observed.length + ' 帧）';
    const numberText = (value, unit) => value === undefined || value === null ? '未记录' : Number(value) + unit;
    const elapsedText = last.elapsedMs === undefined || last.elapsedMs === null
        ? '未记录'
        : (Math.round(Number(last.elapsedMs) / 100) / 10) + 's';
    const summaryText = last.summarySource === undefined || last.summarySource === null || last.summarySource === ''
        ? '未记录'
        : String(last.summarySource);
    const nightFlag = last.nightQuiet;
    const degradedFlag = last.degraded;
    // 只有插件真的写了字段才展示；没写就写「未记录」，不推断成「没降级」。
    const flagText = (nightFlag === undefined && degradedFlag === undefined)
        ? '未记录（这一行没有 nightQuiet / degraded）'
        : 'nightQuiet=' + (nightFlag === undefined ? '未记录' : String(nightFlag))
            + ' · degraded=' + (degradedFlag === undefined ? '未记录' : JSON.stringify(degradedFlag));
    const chips = [];
    if (nightFlag === true)
        chips.push('<span class="chip warn">夜间降级</span>');
    if (degradedFlag !== undefined && degradedFlag !== null && degradedFlag !== false)
        chips.push('<span class="chip warn">degraded=' + esc(JSON.stringify(degradedFlag)) + '</span>');
    const facts = [
        factRow('视频', name + ' · ' + fmtTime(last.wall)),
        factRow('抽取帧数', numberText(last.frames, ' 帧')),
        factRow('送入视觉', sentText),
        factRow('caption 数', numberText(last.captions, ' 条')),
        factRow('耗时', elapsedText),
        factRow('摘要来源', summaryText),
        factRow('夜间降级', flagText),
    ];
    return `<div class="panel" style="margin-top:18px">${head}
        ${chips.length > 0 ? '<span class="row">' + chips.join('') + '</span>' : ''}
        <dl class="facts">${facts.join('')}</dl>
        <p class="muted" style="margin:8px 0 0">observedAt 是实际送进视觉的帧时间点；抽取帧数是落到 frameDir 的帧数，
            两者不相等说明抽出来的帧被后续挑选裁掉了。来源：${esc(data.source)} · 文件修改 ${esc(fmtTime(data.mtime))}</p>
    </div>`;
}

function localVideoCard() {
    const data = state.mediaVideo;
    if (!data)
        return '';
    const head = '<div class="panel-head"><h2>群内视频阅读</h2><span class="muted">qq_read_video · 最近 100 条</span></div>';
    if (data.ok !== true) {
        return `<div class="panel" style="margin-top:18px">${head}
            <p class="empty">${esc(data.error || '查不到')}</p>
            <p class="muted">来源：${esc(data.source || '查不到')}</p></div>`;
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) {
        return `<div class="panel" style="margin-top:18px">${head}
            <p class="empty">还没有记录：qq_read_video 成功后会在 media_video.jsonl 落一行。</p>
            <p class="muted">来源：${esc(data.source)}</p></div>`;
    }
    const body = rows.map(row => {
        const file = String(row.path || '');
        const name = file.split(/[\\/]/).pop() || file || '—';
        const seconds = Number(row.durationSec ?? 0);
        const clock = Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
        const result = row.ok === true
            ? '<span class="chip ok">成功</span>'
            : '<span class="chip down">失败</span><div class="muted">' + esc(row.reason || '查不到原因') + '</div>';
        const source = row.ok === true
            ? esc(row.summarySource || '查不到') + '<div class="muted">帧 ' + esc(row.frames ?? 0)
                + ' · 字幕 ' + esc(row.captions ?? 0) + ' · 转写 ' + esc(row.transcriptChars ?? 0) + ' 字</div>'
            : '<span class="muted">—</span>';
        return `
        <tr>
            <td class="mono">${esc(fmtTime(row.wall))}</td>
            <td class="mono">${esc(row.groupId || '—')}</td>
            <td class="mono">${esc(row.senderId || '—')}</td>
            <td class="title" title="${esc(file)}">${esc(name)}<div class="muted">${esc(fmtBytes(row.fileSize))}</div></td>
            <td class="mono">${esc(clock)}</td>
            <td>${result}</td>
            <td>${source}</td>
            <td class="mono">${row.elapsedMs === undefined ? '—' : (Math.round(Number(row.elapsedMs) / 100) / 10) + 's'}</td>
        </tr>`;
    }).join('');
    return `<div class="panel" style="margin-top:18px">${head}
        <div class="table-scroll">
        <table class="bili-table">
            <thead><tr>
                <th>时间</th><th>群</th><th>发送者</th><th>视频</th><th>时长</th>
                <th>结果</th><th>摘要来源</th><th>耗时</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>
        </div>
        <p class="muted" style="margin:8px 0 0">来源：${esc(data.source)} · 文件修改 ${esc(fmtTime(data.mtime))}</p>
    </div>`;
}

function factRow(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value === '' || value === undefined || value === null ? '—' : value) + '</dd></div>';
}

function biliAccountCard() {
    const account = state.bili?.account ?? {};
    const bound = account.bound === true;
    const step = account.status === 'ok' ? 'ok' : (account.status === 'invalid' ? 'down' : 'warn');
    const label = account.status === 'ok'
        ? '已绑定'
        : (account.status === 'invalid' ? '已失效 · 已降级' : '未绑定（匿名 720p）');
    const rows = [
        factRow('当前身份', account.status === 'ok'
            ? (account.uname || '未知') + '（mid ' + (account.mid ?? '—') + '）'
                + (account.vip ? ' · 大会员' : '') + (account.level ? ' · LV' + account.level : '')
            : '未登录'),
        factRow('SESSDATA', bound ? account.masked : '—'),
        factRow('最近校验', account.checkedAt ? fmtTime(account.checkedAt) : '—'),
        factRow('状态', account.note ?? '—'),
    ];
    if (account.status === 'invalid' && account.error)
        rows.push(factRow('失效原因', account.error));
    return `
    <div class="panel">
        <div class="panel-head">
            <h2>独立账号绑定</h2>
            <span class="chip ${step}">${esc(label)}</span>
        </div>
        <p class="muted">只认你在这里粘贴的 SESSDATA：不读浏览器 Cookie、不读 QQ 本地数据、不复用其它登录态。
            失效会明确报错并自动降级为未登录（720p），不会静默当成已登录。</p>
        <dl class="facts">${rows.join('')}</dl>
        <div class="bili-form">
            <input id="biliSessdata" type="password" autocomplete="off" spellcheck="false"
                placeholder="粘贴 SESSDATA（只填这一个值，或 SESSDATA=...）">
            <button id="biliBind" class="accent" ${state.biliBusy ? 'disabled' : ''}>${bound ? '更换绑定' : '绑定'}</button>
            <button id="biliVerify" ${!bound || state.biliBusy ? 'disabled' : ''}>重新验证</button>
            <button id="biliUnbind" class="danger" ${!bound || state.biliBusy ? 'disabled' : ''}>解绑</button>
        </div>
        <p class="muted" id="biliHint">绑定时会立刻用 /x/web-interface/nav 验证身份；验证失败不保存。</p>
    </div>`;
}

function biliTable() {
    const data = state.bili;
    if (!data || Number(data.total) === 0)
        return '<p class="empty">还没有观看记录。模型调 qq_bili_watch 看过的视频会出现在这里。</p>';
    const rows = data.items.map(row => {
        const summaryText = String(row.summary ?? '');
        const sampling = row.sampling ?? {};
        const samplingLabel = sampling.mode === 'adaptive'
            ? '自适应采样 · ' + Number(sampling.cuts ?? 0) + ' 切镜 · 采 ' + Number(sampling.kept ?? 0) + ' 帧'
                + (Number(sampling.trimmed ?? 0) > 0 ? '（预算裁 ' + Number(sampling.trimmed) + ' 帧）' : '')
            : sampling.mode === 'asr'
                ? 'ASR ' + String(sampling.model ?? '') + ' · ' + Number(sampling.threads ?? 0) + ' 线程 · '
                    + Number(sampling.chars ?? 0) + ' 字 / ' + Math.round(Number(sampling.wallMs ?? 0) / 1000) + 's'
                : (sampling.mode === 'subtitle' ? '字幕' : '');
        // 信源与是否为真降级只在面板展示；给模型的文本里没有任何这类限定语。
        const sourceLabel = row.summarySource === 'subtitle'
            ? '字幕总结'
            : row.summarySource === 'asr'
                ? 'ASR 总结 · ' + String(row.asrModel ?? '')
                : '画面总结';
        const degradedLabel = row.summaryDegraded === 'frames-only'
            ? ' · 仅抽帧'
            : row.summaryDegraded === 'asr-short'
                ? ' · 转写偏短'
                : '';
        // ASR 与音频结构单独一行：回溯时能看清这条是字幕、转写还是画面跑出来的。
        const asrLine = row.asrModel === undefined || row.asrModel === ''
            ? ''
            : 'ASR ' + String(row.asrModel) + ' · ' + Number(row.asrChars ?? 0) + ' 字 / '
                + Math.round(Number(row.asrMs ?? 0) / 1000) + 's';
        const coverage = row.audioCoverage ?? {};
        const coverageLine = coverage['人声'] === undefined
            ? ''
            : '音频：人声 ' + Number(coverage['人声'] ?? 0) + '% · 音乐 '
                + (Number(coverage['音乐'] ?? 0) + Number(coverage['人声+音乐'] ?? 0)).toFixed(1)
                + '% · 静音 ' + Number(coverage['静音'] ?? 0) + '%';
        const summaryCell = summaryText === ''
            ? '<span class="muted">' + esc(row.summaryReason || '无总结') + '</span>'
            : '<details><summary>' + esc(sourceLabel + degradedLabel)
                + ' · ' + summaryText.length + ' 字</summary><div class="muted" style="white-space:pre-wrap">'
                + esc(summaryText) + '</div></details>';
        const traceCell = [samplingLabel, asrLine, coverageLine].filter(Boolean).map(esc).join(' · ');
        return `
        <tr>
            <td class="mono">${esc(fmtTime(row.at))}</td>
            <td class="mono">${esc(row.bvid ?? '—')}</td>
            <td class="title" title="${esc(row.title ?? '')}">${esc(row.title ?? '—')}</td>
            <td>${esc(row.owner ?? '—')}</td>
            <td class="mono">${row.keyframes ?? '—'}</td>
            <td class="mono">${row.rescued ?? 0}</td>
            <td class="mono">${row.totalMs === undefined ? '—' : (Math.round(Number(row.totalMs) / 100) / 10) + 's'}</td>
            <td>${summaryCell}<div class="muted">${traceCell}</div></td>
            <td><span class="chip ${row.mode === 'proactive' ? 'ok' : ''}">${row.mode === 'proactive' ? '主动' : '被要求'}</span></td>
            <td class="mono">${esc(row.triggeredBy ?? row.chatId ?? '—')}</td>
        </tr>`;
    }).join('');
    return `
    <div class="table-scroll">
    <table class="bili-table">
        <thead>
            <tr>
                <th>时间</th><th>BV</th><th>标题</th><th>UP</th>
                <th>关键帧</th><th>救回</th><th>耗时</th><th>总结 / 采样</th><th>模式</th><th>触发来源</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>
    </div>
    <div class="bili-pager">
        <span>共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页</span>
        <button data-bili-page="${Number(data.page) - 1}" ${Number(data.page) <= 1 ? 'disabled' : ''}>上一页</button>
        <button data-bili-page="${Number(data.page) + 1}" ${Number(data.page) >= Number(data.pages) ? 'disabled' : ''}>下一页</button>
    </div>`;
}

function biliProactiveCard() {
    const p = state.bili?.proactive;
    if (p === null || p === undefined)
        return '';
    const today = p.today ?? {};
    const last = p.lastRun ?? null;
    const abort = p.lastAbort ?? null;
    const gate = p.lastGate ?? null;
    const share = p.lastShare ?? null;
    const targets = Array.isArray(p.targets) ? p.targets : [];
    const seconds = ms => (Math.round(Number(ms) / 100) / 10) + 's';
    const nextAt = p.nextEligibleAt ? Date.parse(p.nextEligibleAt) : 0;
    const backoffAt = p.backoffUntil ? Date.parse(p.backoffUntil) : 0;
    const backoffActive = p.backoffActive === true && backoffAt > Date.now();
    const backoffLeftMin = backoffActive ? Math.ceil((backoffAt - Date.now()) / 60000) : 0;
    const summarySource = last?.summarySource === 'subtitle'
        ? '字幕'
        : last?.summarySource === 'asr'
            ? 'ASR' + (last?.summaryDegraded === 'asr-short' ? '（转写偏短）' : '')
            : last?.summarySource
                ? '画面' + (last?.summaryDegraded === 'frames-only' ? '（仅抽帧）' : '')
                : '—';
    const rows = [
        factRow('开启状态', p.enabled ? '已开启（bili_proactive.enabled=true）' : '已关闭（bili_proactive.enabled=false）'),
        factRow('运行状态', p.paused
            ? '已暂停（面板写回插件状态文件）'
            : (backoffActive ? '退避中（看片失败后等待）' : (p.enabled ? '等待闸门' : '不运行'))),
        factRow('阈值', '每 ' + Number(p.pollSeconds ?? 60) + ' 秒检查 · 闲置 ≥' + Number(p.idleMinutes ?? 10)
            + ' 分钟 · 间隔 ≥' + Number(p.minGapMinutes ?? 30) + ' 分钟 · 每小时 ≤' + Number(p.maxPerHour ?? 2) + ' 条'),
        factRow('退避', backoffActive
            ? '第 ' + Number(p.failStreak ?? 0) + ' 次失败 · 至 ' + fmtTime(p.backoffUntil)
                + '（剩 ' + backoffLeftMin + ' 分钟 · backoff ' + Number(p.backoffSec ?? 0) + ' 秒）'
            : '无（failStreak=' + Number(p.failStreak ?? 0) + '）'),
        factRow('今日主动刷', Number(today.count ?? 0) + ' 条'),
        factRow('今日主动流量', fmtBytes(today.bytes)),
        factRow('主动平均耗时', Number(today.avgMs ?? 0) > 0 ? seconds(today.avgMs) : '—'),
        factRow('这一小时', Number(p.hourly ?? 0) + ' / ' + Number(p.maxPerHour ?? 2) + ' 条'),
        factRow('上次主动刷', last === null
            ? '—'
            : fmtTime(last.at) + ' · ' + esc(last.pick ?? last.bvid ?? '—') + ' · ' + esc(last.title ?? '')
                + ' · ' + Number(last.frames ?? 0) + ' 帧 · ' + seconds(last.totalMs)),
        factRow('上次总结', last === null
            ? '—'
            : summarySource + ' · ' + Number(last.summaryChars ?? 0) + ' 字'),
        factRow('上次分享', share === null
            ? '—'
            : fmtTime(share.at) + ' · ' + esc(share.target ?? '—')
                + (targets.find(t => t.key === share.target)?.name
                    ? '（' + esc(targets.find(t => t.key === share.target).name) + '）'
                    : '')
                + ' · ' + (share.ok === false ? '失败' : '成功')
                + ' · ' + Number(share.chars ?? String(share.text ?? '').length) + ' 字'),
        factRow('上次让路', abort === null
            ? '—'
            : fmtTime(abort.at) + ' · ' + esc(abort.reason ?? '—') + '（' + esc(abort.where ?? '—') + '）'),
        factRow('闸门最近状态', gate === null
            ? '—'
            : (gate.ok === false ? '被拦：' + esc(gate.reason ?? '') : '通过')),
        factRow('下次可刷', nextAt === 0
            ? '—'
            : (nextAt <= Date.now() ? '已过最短间隔（仍受闲置/配额约束）' : fmtTime(p.nextEligibleAt))),
        factRow('分享配额', targets.length === 0
            ? '—'
            : targets.map(t => esc(t.name) + ' ' + (Number(t.perDay ?? 0) === 0 ? '不限' : Number(t.remaining ?? 0) + '/' + t.perDay)).join(' · ')),
        factRow('分享记录', Number(p.sharesToday ?? 0) + ' 次 · 已主动分享视频 '
            + Number(p.shareVideos ?? 0) + ' 个（全局只提一次，不影响对话中接话）'),
        factRow('状态文件', p.updatedAt ? '更新于 ' + fmtTime(p.updatedAt) + ' · ' + esc(p.statePath ?? '') : esc(p.statePath ?? '—')),
    ];
    const lastSummary = String(share?.text ?? '');
    return `
    <div class="panel" style="margin-top:18px">
        <div class="panel-head">
            <h2>主动刷</h2>
            <span class="row">
                <span class="chip ${p.enabled ? 'ok' : 'down'}">${p.enabled ? '已开启' : '已关闭'}</span>
                ${p.paused ? '<span class="chip warn">已暂停</span>' : ''}
                ${backoffActive ? '<span class="chip warn">退避中</span>' : ''}
                <button id="biliProactiveRun" disabled title="主动刷由 AstrBot 插件调度，控制台不再另起旧引擎">立即刷一次</button>
                <button id="biliProactivePause" ${p.enabled ? '' : 'disabled'}>${p.paused ? '恢复' : '暂停'}</button>
            </span>
        </div>
        <p class="muted">由 AstrBot 插件内置定时器执行：每 ${Number(p.pollSeconds ?? 60)} 秒问一次闸门，闲置 ≥${Number(p.idleMinutes ?? 10)} 分钟、
            距上次 ≥${Number(p.minGapMinutes ?? 30)} 分钟才选片，每小时 ≤${Number(p.maxPerHour ?? 2)} 条；后端 8094 不可用时直接跳过（engine_ready 前置探测）。
            看片失败按 10 分钟起、连续翻倍、封顶 60 分钟退避，成功清零。面板只读展示，暂停/恢复写回插件状态文件；动作日志：${esc(p.logPath ?? '—')}</p>
        <dl class="facts">${rows.join('')}</dl>
        ${lastSummary === '' ? '' : `<details><summary>上次分享的正文</summary><div class="muted" style="white-space:pre-wrap">${esc(lastSummary)}</div></details>`}
    </div>`;
}

function renderBili() {
    const data = state.bili;
    const today = data?.today ?? {};
    const disk = data?.disk ?? {};
    const paused = disk.paused === true;
    const avgMs = Number(today.avgMs ?? 0);
    const proactiveToday = Number(data?.byMode?.proactive?.count ?? 0);
    const requestedToday = Number(data?.byMode?.requested?.count ?? 0);
    const diskBlock = paused
        ? `<div class="win-metric warn" style="margin-top:14px"><span class="dot warn"></span><div>
            <strong>下载已暂停：磁盘空间不足</strong>
            <p class="muted">工作盘可用 ${fmtBytes(disk.freeBytes)}，低于 ${fmtBytes(disk.thresholdBytes)} 阈值；
            清理空间后自动继续，不需要手动恢复。</p></div></div>`
        : (disk.freeBytes === null || disk.freeBytes === undefined
            ? `<div class="win-metric warn" style="margin-top:14px"><span class="dot warn"></span><div>
                <strong>磁盘空间未知</strong><p class="muted">${esc(disk.reason ?? '检测没有返回结果')}</p></div></div>`
            : '');
    $('#view').innerHTML = `
    <div class="summary">
        <div class="lead"><span class="dot ${paused ? 'warn' : 'ok'}"></span>今日已看 <b>${Number(today.count ?? 0)}</b> 条</div>
        <div class="meta">
            今日流量 ${fmtBytes(today.bytes)} · 平均 ${avgMs > 0 ? (Math.round(avgMs / 100) / 10) + 's' : '—'}
            · 主动 ${proactiveToday} 条 / 被要求 ${requestedToday} 条
            · 累计 ${Number(data?.total ?? 0)} 条
            ${disk.freeBytes === null || disk.freeBytes === undefined ? '' : ' · 工作盘剩 ' + fmtBytes(disk.freeBytes)}
        </div>
    </div>
    ${diskBlock}
    ${biliProactiveCard()}
    ${biliAccountCard()}
    <div class="panel" style="margin-top:18px">
        <div class="panel-head"><h2>观看记录</h2><span class="muted">时间倒序 · 每页 20 条</span></div>
        ${biliTable()}
    </div>
    ${videoFrameCard()}
    ${localVideoCard()}`;
    bindBiliEvents();
}

function bindBiliEvents() {
    const bind = $('#biliBind');
    if (bind)
        bind.addEventListener('click', () => void submitBiliBind());
    const verify = $('#biliVerify');
    if (verify)
        verify.addEventListener('click', () => void verifyBiliAccount());
    const unbind = $('#biliUnbind');
    if (unbind)
        unbind.addEventListener('click', () => void unbindBiliAccount());
    $$('[data-bili-page]').forEach(button => {
        button.addEventListener('click', () => {
            const page = Number(button.dataset.biliPage);
            if (page > 0)
                void loadBili(page);
        });
    });
    const runButton = $('#biliProactiveRun');
    if (runButton)
        runButton.addEventListener('click', () => void runBiliProactiveNow());
    const pauseButton = $('#biliProactivePause');
    if (pauseButton)
        pauseButton.addEventListener('click', () => void toggleBiliProactive());
}

async function runBiliProactiveNow() {
    showBanner('info', '主动刷开始了：取流 → 关键帧 → 打标 → 分享，完成后会自动刷新');
    try {
        const data = await api('/api/bili/proactive', { method: 'POST', body: JSON.stringify({ action: 'run' }) });
        showBanner('success', '主动刷完成：《' + data.title + '》' + data.frames + ' 帧，'
            + (Math.round(Number(data.totalMs) / 100) / 10) + 's'
            + (data.share?.ok ? '；已分享到 ' + (data.share.name || data.share.target) : '；未分享：' + (data.share?.reason ?? '无')));
        await loadBili(state.biliPage ?? 1);
    }
    catch (error) {
        showBanner('error', '主动刷没有执行：' + error.message);
        await loadBili(state.biliPage ?? 1);
    }
}

async function toggleBiliProactive() {
    const paused = state.bili?.proactive?.paused === true;
    try {
        const data = await api('/api/bili/proactive', {
            method: 'POST',
            body: JSON.stringify({ action: paused ? 'resume' : 'pause' }),
        });
        showBanner('success', data.paused ? '已暂停主动刷' : '已恢复主动刷');
        await loadBili(state.biliPage ?? 1);
    }
    catch (error) {
        showBanner('error', '切换失败：' + error.message);
    }
}

async function submitBiliBind() {
    if (state.biliBusy)
        return;
    const input = $('#biliSessdata');
    const sessdata = input === null ? '' : input.value.trim();
    if (sessdata === '') {
        showBanner('error', '先粘贴 SESSDATA（只填这一个值，不要整段 Cookie）');
        return;
    }
    state.biliBusy = true;
    const hint = $('#biliHint');
    if (hint)
        hint.textContent = '正在向 B 站验证身份…';
    try {
        const data = await api('/api/bili/account', { method: 'POST', body: JSON.stringify({ sessdata }) });
        state.biliBusy = false;
        state.bili.account = data.account;
        showBanner('success', data.message);
        renderBili();
    }
    catch (error) {
        state.biliBusy = false;
        showBanner('error', '绑定失败：' + error.message);
        if (hint)
            hint.textContent = '未保存：' + error.message;
    }
}

async function verifyBiliAccount() {
    if (state.biliBusy)
        return;
    state.biliBusy = true;
    try {
        const data = await api('/api/bili/account/verify', { method: 'POST' });
        state.biliBusy = false;
        state.bili.account = data.account;
        renderBili();
        showBanner('success', data.message);
    }
    catch (error) {
        state.biliBusy = false;
        if (error.data?.account)
            state.bili.account = error.data.account;
        renderBili();
        showBanner('error', error.message);
    }
}

async function unbindBiliAccount() {
    if (state.biliBusy)
        return;
    if (!confirm('解绑后会回到未登录（720p），确认？'))
        return;
    state.biliBusy = true;
    try {
        const data = await api('/api/bili/account', { method: 'DELETE' });
        state.biliBusy = false;
        showBanner('success', data.message);
        void loadBili(1);
    }
    catch (error) {
        state.biliBusy = false;
        showBanner('error', '解绑失败：' + error.message);
    }
}

/* ---------------------------------------------------------------- 操作区 */

const ACTION_LABELS = { start: '启动', stop: '停止', restart: '重启', reload: '重载配置', 'engine-restart': '重启引擎' };

function openDrawer(title) {
    $('#drawerTitle').textContent = title;
    $('#drawerBody').innerHTML = '<div class="status-line"><span class="spinner"></span>执行中…</div>';
    $('#drawer').classList.remove('hidden');
}

function closeDrawer() {
    $('#drawer').classList.add('hidden');
}

async function runAction(name) {
    const label = ACTION_LABELS[name];
    if (!label)
        return;
    if ((name === 'stop' || name === 'restart')
        && !confirm('将' + label + ' QQ 侧 / proxy / 引擎（调用现有 ps1）。确认继续？'))
        return;
    if (name === 'engine-restart'
        && !confirm('将重启引擎（engine-control.ps1 -Action restart），proxy 与宿主不动。确认继续？'))
        return;
    if (name === 'reload')
        openDrawer('重载配置');
    else
        openDrawer(label + '中');
    const scriptText = name === 'start' ? 'start-dsh.ps1'
        : (name === 'stop' ? 'stop-dsh.ps1'
            : (name === 'restart' ? 'stop-dsh.ps1 → start-dsh.ps1'
                : (name === 'engine-restart' ? 'engine-control.ps1 -Action restart' : '配置原子重写')));
    $('#drawerBody').innerHTML = '<div class="status-line"><span class="spinner"></span>正在执行「' + esc(label) + '」…</div>'
        + '<p class="muted">调用 ' + esc(scriptText) + '，不另做一套实现。</p>';

    try {
        const data = await api('/api/action', { method: 'POST', body: JSON.stringify({ name }) });
        $('#drawerBody').innerHTML = `
            <div class="status-line"><span class="dot ok"></span><strong>${esc(label)}成功</strong>
                <span class="muted">${Math.round((data.durationMs ?? 0) / 100) / 10} 秒</span></div>
            ${data.message ? '<p>' + esc(data.message) + '</p>' : ''}
            <h4 class="muted">执行输出</h4>
            <pre>${esc(data.output || '(无输出)')}</pre>
            ${data.logTail ? '<h4 class="muted">相关日志尾部</h4><pre>' + esc(data.logTail) + '</pre>' : ''}
            ${data.log ? '<p class="muted">日志组件：' + esc(data.log) + '</p>' : ''}`;
        showBanner('success', label + '完成。');
        if (state.page === 'status')
            void loadStatus();
    }
    catch (error) {
        const data = error.data ?? {};
        $('#drawerBody').innerHTML = `
            <div class="status-line"><span class="dot down"></span><strong>${esc(label)}失败</strong></div>
            <p class="result-box error">${esc(error.message)}</p>
            ${Array.isArray(data.errors) && data.errors.length
                ? '<ul class="result-box error">' + data.errors.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>'
                : ''}
            <h4 class="muted">执行输出</h4>
            <pre>${esc(data.output || '(无输出)')}</pre>
            ${data.logTail ? '<h4 class="muted">相关日志尾部</h4><pre>' + esc(data.logTail) + '</pre>' : ''}`;
        showBanner('error', label + '失败：' + error.message);
    }
}

/* ---------------------------------------------------------------- 自迭代 */

function siValue(value, suffix = '') {
    return value === null || value === undefined || value === '' ? '—' : String(value) + suffix;
}

function siStatusChip(run) {
    if (!run)
        return '<span class="chip warn">从未运行</span>';
    const map = {
        ok: ['ok', '正常'],
        empty: ['warn', '无产出'],
        aborted: ['warn', '让路中断'],
        skipped: ['warn', '跳过'],
        'parse-error': ['down', '解析失败'],
        error: ['down', '失败'],
    };
    let pair = map[run.status];
    if (!pair) {
        // 插件自动触发的 ledger 行只有 ok/reason，没有 status；这里按 ok+reason 归一，
        // 真正读不懂时才显示「未知（status=…）」，不再把有数据的行混成未知。
        if (run.ok === true)
            pair = ['ok', '正常'];
        else if (run.ok === false && run.reason)
            pair = ['warn', '跳过（' + run.reason + '）'];
        else
            pair = ['warn', '未知（status=' + (run.status ?? '缺字段') + '）'];
    }
    const [kind, label] = pair;
    return '<span class="chip ' + kind + '">' + esc(label) + '</span>';
}

function siMetricCells(run) {
    const model = run.model ?? {};
    const gpu = run.gpu ?? {};
    const gate = run.gate ?? {};
    const output = run.output ?? {};
    const yielded = run.yielded ?? {};
    return [
        esc(fmtTime(run.startedAt ?? run.ts)),
        siStatusChip(run),
        esc(run.trigger ?? run.action ?? '—'),
        esc(siValue(run.durationMs, 'ms')),
        esc(siValue(model.promptTokens)),
        esc(siValue(model.completionTokens)),
        esc(siValue(model.tokensPerSec)),
        esc(siValue(gpu.beforeMB) + ' → ' + siValue(gpu.peakMB) + ' → ' + siValue(gpu.afterMB)),
        yielded.aborted ? esc('是 · ' + (yielded.reason || '—')) : '否',
        esc((output.accepted ?? 0) + ' 条 / 自动 ' + (gate.autoApplied ?? 0) + ' / 待审 ' + (gate.pending ?? 0)),
        esc(run.error || (gate.reasons?.length ? gate.reasons.join(',') : '—')),
    ];
}

async function loadSelfIter() {
    try {
        state.selfIter = await api('/api/self-iter');
        renderSelfIter();
    }
    catch (error) {
        $('#view').innerHTML = pageError('自迭代数据读取失败', error,
            '确认控制台已重启，且 AstrBot 数据根下的 persona/self-iter 模块可加载。');
    }
}

function renderSelfIter() {
    const data = state.selfIter;
    if (!data) {
        $('#view').innerHTML = '<p class="empty">还没有数据。</p>';
        return;
    }
    const config = data.config ?? {};
    const stateInfo = data.state ?? {};
    const counts = data.counts ?? {};
    const last = data.lastRun;
    const runs = [...(data.recentRuns ?? [])].reverse();
    const pending = data.pending ?? [];
    const recent = data.recentProposals ?? [];
    const chip = config.enabled ? '<span class="chip ok">运行中</span>' : '<span class="chip down">已暂停</span>';
    const plugin = data.plugin ?? null;
    const pluginState = plugin?.state ?? 'missing';
    const pluginMissing = pluginState === 'missing';
    const pluginNever = pluginState === 'never';
    const lastDecision = plugin?.lastDecision ?? null;
    const lastStatus = pluginMissing
        ? '<span class="chip warn">查不到</span>'
        : pluginNever
            ? '<span class="chip warn">从未运行</span>'
            : siStatusChip(lastDecision);
    // 自动触发的「下次最早」只看插件 auto-state 的 lastRunMs + gapHours；
    // 旧模块 state.lastRunAt 不随自动触发更新，不再拿它推算。
    const nextAllowed = plugin?.nextEarliestAt || '';

    const model = last?.model ?? {};
    const gpu = last?.gpu ?? {};
    const util = (gpu.utilSamples ?? []).map(item => siValue(item.utilPct, '%')).slice(0, 16).join(' / ');

    const pendingHtml = pending.length === 0
        ? '<p class="empty">没有待审提案。人格改动只会在这里等你批准。</p>'
        : pending.map(item => `
            <div class="panel" style="margin-bottom:12px">
                <div class="panel-head">
                    <h2>${esc(item.title || item.id)}</h2>
                    <span class="chip ${item.kind === 'character' ? 'warn' : 'ok'}">${item.kind === 'character' ? '人格' : '笔记'}</span>
                </div>
                <p class="muted">${esc(item.reason || '—')} · 置信度 ${esc(siValue(item.confidence))} · ${esc(item.sceneKey || '—')}</p>
                <p class="muted">证据：${esc((item.evidence ?? []).map(e => e.messageId || e.ts).join(', ') || '—')}</p>
                <pre style="white-space:pre-wrap;background:#0f1720;border:1px solid #243040;border-radius:8px;padding:10px;font-size:12px;max-height:220px;overflow:auto">${esc(item.diff || '')}</pre>
                <div class="row" style="margin-top:10px">
                    <button class="accent" data-si-act="approve" data-si-id="${esc(item.id)}">批准并写入</button>
                    <button class="danger" data-si-act="reject" data-si-id="${esc(item.id)}">拒绝</button>
                </div>
            </div>`).join('');

    const recentRows = recent.length === 0
        ? '<tr><td colspan="5" class="empty">暂无</td></tr>'
        : recent.map(item => `
            <tr>
                <td>${esc(fmtTime(item.ts))}</td>
                <td>${esc(item.kind === 'character' ? '人格' : '笔记')}</td>
                <td>${esc(item.status)}</td>
                <td class="si-title">${esc(item.title || '')}</td>
                <td>${item.status === 'applied'
                    ? `<button class="mini" data-si-act="rollback" data-si-id="${esc(item.id)}">回滚</button>`
                    : esc(item.rejectedReason || '')}</td>
            </tr>`).join('');

    $('#view').innerHTML = `
    <div class="panel">
        <div class="panel-head">
            <h2>闲时自迭代</h2>
            <span class="row">${chip}<span class="chip">${esc(config.mode ?? '—')}</span>${lastStatus}</span>
        </div>
        <p class="muted">按 self-iter 自动轮询间隔（配置项 pollSeconds，默认 60 秒），与任何 QQ 消息无关；只有队列空闲、无出图租约时才会真的调模型。
            群消息一来就中断本轮；自动路径只写提案，notebook 也不自动入库，apply 只在主人手动批准时发生。</p>
        <div class="grid3">
            <div class="panel">
                <div class="panel-head"><h2>节奏</h2></div>
                <dl class="facts">
                    ${factRow('今日运行', pluginMissing ? '查不到' : pluginNever ? '0（从未运行）' : (plugin.runsToday + ' 次（auto-run）'))}
                    ${factRow('上次运行', pluginMissing ? '查不到' : pluginNever ? '从未运行' : (plugin.lastRunAt ? fmtTime(plugin.lastRunAt) : '查不到'))}
                    ${factRow('上次结果', pluginMissing ? '查不到' : pluginNever ? '从未运行' : (plugin.lastResult || (lastDecision?.reason ? '跳过（' + lastDecision.reason + '）' : '查不到')))}
                    ${factRow('最近判定', pluginMissing ? '查不到' : pluginNever ? '从未运行' : (lastDecision ? (lastDecision.status === 'ok' ? '正常' : '跳过（' + (lastDecision.reason || '?') + '）') + ' · ' + fmtTime(lastDecision.ts) : '查不到'))}
                    ${factRow('最早下次', nextAllowed ? (fmtTime(nextAllowed) + '（gapHours=' + (plugin?.gapHours ?? '?') + ' 推算）') : (pluginNever ? '从未运行' : '查不到'))}
                    ${factRow('自动间隔', pluginMissing ? '查不到' : (plugin?.gapHours ?? '?') + ' 小时')}
                    ${factRow('待审提案', pluginMissing ? '查不到' : ((plugin?.pendingCount ?? 0) + ' 个'))}
                    ${factRow('待审 id', pluginMissing ? '查不到' : (plugin?.pending?.length ? plugin.pending.map(item => item.id).join(', ') : '无'))}
                    ${factRow('人格改动累计', counts.characterChangedTotal ?? 0)}
                </dl>
            </div>
            <div class="panel">
                <div class="panel-head"><h2>本轮算力</h2></div>
                <dl class="facts">
                    ${factRow('耗时', siValue(last?.durationMs, 'ms'))}
                    ${factRow('prompt tokens', siValue(model.promptTokens))}
                    ${factRow('completion tokens', siValue(model.completionTokens))}
                    ${factRow('tokens/s', siValue(model.tokensPerSec))}
                    ${factRow('GPU MB', (siValue(gpu.beforeMB) + ' → ' + siValue(gpu.peakMB) + ' → ' + siValue(gpu.afterMB)))}
                    ${factRow('GPU util 采样', util || '—')}
                    ${factRow('让路', last?.yielded?.aborted ? ('是 · ' + (last.yielded.reason || '')) : '否')}
                </dl>
            </div>
            <div class="panel">
                <div class="panel-head"><h2>产出与闸门</h2></div>
                <dl class="facts">
                    ${factRow('findings', siValue(last?.output?.findings))}
                    ${factRow('通过校验', siValue(last?.output?.accepted))}
                    ${factRow('笔记自动入库', siValue(last?.gate?.autoApplied))}
                    ${factRow('人格待审', siValue(last?.output?.character))}
                    ${factRow('被闸拦下', siValue(last?.gate?.rejected))}
                    ${factRow('拦下原因', (last?.gate?.reasons ?? []).join(', ') || '—')}
                    ${factRow('characterChanged', last?.characterChanged ? 'true' : 'false')}
                </dl>
            </div>
        </div>
        <div class="row" style="margin-top:12px">
            <button id="siRun" class="accent" ${state.selfIterBusy ? 'disabled' : ''}>立即跑一轮</button>
            <button id="siToggle" class="${config.enabled ? 'danger' : ''}">${config.enabled ? '暂停' : '启用'}</button>
            <button id="siRefresh">刷新</button>
            <span class="muted">${state.selfIterBusy ? '正在调用模型，等返回…' : '强制运行只跳过节奏，仍然会在群消息到来时让路。'}</span>
        </div>
        ${last?.error ? `<div class="win-metric warn" style="margin-top:12px"><span class="dot warn"></span><div><strong>最近一次错误</strong><p class="muted">${esc(last.error)}</p></div></div>` : ''}
    </div>

    <div class="panel">
        <div class="panel-head"><h2>最近运行</h2><span class="muted">metrics.jsonl 最后 10 条</span></div>
        <div class="table-scroll">
        <table class="si-table">
            <thead><tr><th>时间</th><th>状态</th><th>触发</th><th>耗时</th><th>prompt</th><th>completion</th><th>tok/s</th><th>GPU MB</th><th>让路</th><th>产出</th><th>备注</th></tr></thead>
            <tbody>${runs.length === 0
                ? '<tr><td colspan="11" class="empty">还没有运行记录</td></tr>'
                : runs.map(run => '<tr>' + siMetricCells(run).map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('')}</tbody>
        </table>
        </div>
    </div>

    <div class="panel">
        <div class="panel-head"><h2>待审提案</h2><span class="muted">${pending.length} 条</span></div>
        ${pendingHtml}
    </div>

    <div class="panel">
        <div class="panel-head"><h2>最近提案</h2><span class="muted">含已应用 / 已拒绝 / 已回滚</span></div>
        <div class="table-scroll">
        <table class="si-table">
            <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th><th>操作 / 原因</th></tr></thead>
            <tbody>${recentRows}</tbody>
        </table>
        </div>
    </div>`;

    $('#siRun').addEventListener('click', () => void runSelfIterNow());
    $('#siToggle').addEventListener('click', () => void toggleSelfIter());
    $('#siRefresh').addEventListener('click', () => void loadSelfIter());
    $$('[data-si-act]').forEach(button => {
        button.addEventListener('click', () => void actOnProposal(button.dataset.siId, button.dataset.siAct));
    });
}

async function runSelfIterNow() {
    if (state.selfIterBusy)
        return;
    state.selfIterBusy = true;
    renderSelfIter();
    try {
        const data = await api('/api/self-iter', {
            method: 'POST',
            body: JSON.stringify({ action: 'run', force: true }),
        });
        state.selfIterBusy = false;
        state.selfIter = data.status ?? state.selfIter;
        renderSelfIter();
        if (data.ok)
            showBanner('success', '自迭代完成：' + data.status + '，' + (data.proposals?.length ?? 0) + ' 条提案（' + data.runId + '）');
        else
            showBanner('info', '本轮没跑：' + (data.reason || '未知原因'));
    }
    catch (error) {
        state.selfIterBusy = false;
        renderSelfIter();
        showBanner('error', '自迭代失败：' + error.message);
    }
}

async function toggleSelfIter() {
    const enabled = state.selfIter?.config?.enabled === true;
    try {
        const data = await api('/api/self-iter', {
            method: 'POST',
            body: JSON.stringify({ action: enabled ? 'pause' : 'resume' }),
        });
        state.selfIter = data;
        renderSelfIter();
        showBanner('success', enabled ? '已暂停：不再 tick，也不会写任何文件。' : '已启用：下次 tick 起恢复判定。');
    }
    catch (error) {
        showBanner('error', '切换失败：' + error.message);
    }
}

async function actOnProposal(id, action) {
    if (!id)
        return;
    const verb = action === 'approve' ? '批准并写入' : (action === 'reject' ? '拒绝' : '回滚');
    if (!confirm('确认' + verb + '提案 ' + id + '？操作会记审计日志。'))
        return;
    try {
        const data = await api('/api/self-iter', {
            method: 'POST',
            body: JSON.stringify({ action, id, reason: action === 'reject' ? 'master-reject' : undefined }),
        });
        if (data.status)
            state.selfIter = data.status;
        renderSelfIter();
        showBanner('success', verb + '成功（' + id + '）');
    }
    catch (error) {
        showBanner('error', verb + '失败：' + error.message);
        void loadSelfIter();
    }
}

function init() {
    $$('#nav button').forEach(button => {
        button.addEventListener('click', () => navigate(button.dataset.page));
    });
    $('#actions').addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (button)
            void runAction(button.dataset.action);
    });
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', event => {
        if (event.target === $('#modal'))
            closeModal();
    });
    $('#view').addEventListener('click', event => {
        if (event.target.closest('[data-retry]'))
            navigate(state.page);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeModal();
            closeDrawer();
        }
    });
    window.addEventListener('hashchange', () => {
        const page = location.hash.slice(1);
        if (page !== state.page)
            navigate(page);
    });
    navigate(location.hash.slice(1) || 'status');
}

init();
