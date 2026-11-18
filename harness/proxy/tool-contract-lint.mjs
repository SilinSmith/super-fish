// 33 个工具的启动契约闸（优化 #1）。
//
// 定义不在这里发明，全部来自插件侧真实实现（只读引用）：
//   C:\Users\user\.dsh\profiles\desktop\node_modules\dsh-onebot-qq\lib\tool-result.js
//     - 四态 RESULT_STATES = ok/done/failed/blocked
//     - 原因码 → 默认 next / retry（CODE_NEXT / RETRY_OF）
//     - 唯一渲染 renderResult()；统一输出 toolOutput()
//   ...\lib\tools.js 里的 33 个 defineTool() 定义。
//
// 运行方式：用 stub ctx 空跑插件真实的 registerTools()，把 33 个工具对象真造出来再检查。
// 为了不被线上开关（常驻/贴纸/空间写）裁掉工具，本脚本把 QQ_PROXY_ROOT 指到临时沙箱目录，
// 在沙箱里写「全常驻 + 全开关打开」的配置；真实配置只读不动。
//
// 检查项：
//   A schema meta：name/description/parameters 形状与类型、output.schema 类型白名单
//     （宿主不认 `json`，会被打崩）、output.render 必返非空 text 段。
//   B 四态契约：四种状态渲染前缀正确、原因码都有 next、retry 合法、
//     null 返回必须落成 failed/internal。
//   C 原因码字面量：tools.js 里 resultDone/Fail/Blocked 的第一个参数字面量必须已知。
//   D 清单完整性：源码声明 33 个，实际注册必须覆盖全部，且不许多出未声明工具。
//
// 任一失败 → 非零退出。proxy 在 listen 之前以子进程方式调用它，失败即退出（fail-closed）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_LIB = 'C:/Users/user/.dsh/profiles/desktop/node_modules/dsh-onebot-qq/lib';
const LIB = (process.env.DSH_ONEBOT_LIB ?? DEFAULT_LIB).replace(/\\/g, '/');

const HOST_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const RETRY_VALUES = new Set(['no', 'changed-args', 'later']);
const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/u;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]*$/u;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 源码里声明的工具名（defineTool 的 name 字段）。 */
function declaredToolNames() {
    const source = readFileSync(LIB + '/tools.js', 'utf8');
    return {
        source,
        names: [...source.matchAll(/\bname:\s*'((?:qq|memory)_[a-z0-9_]+)'/gu)].map(match => match[1]),
    };
}

/** 在临时根目录里把开关全部打开，保证 33 个工具都会走到注册路径。 */
function makeSandboxRoot(names) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-lint-'));
    const limits = { maxLoadsPerTurn: 99, loadWindowMs: 60_000 };
    writeFileSync(join(dir, 'tool-resident.json'), JSON.stringify({ enabled: true, resident: names, limits }, null, 2));
    writeFileSync(join(dir, 'write-tools.json'), JSON.stringify({
        enabled: true,
        tools: Object.fromEntries(['qq_qzone_post', 'qq_qzone_like', 'qq_qzone_extra', 'qq_napcat_api'].map(name => [name, true])),
        napcatApi: true,
    }, null, 2));
    writeFileSync(join(dir, 'stickers.json'), JSON.stringify({ enabled: true }, null, 2));
    return dir;
}

export async function runToolContractLint() {
    const failures = [];
    const fail = (where, message) => failures.push(where + '：' + message);

    const { source, names } = declaredToolNames();
    for (const name of names)
        if (NAME_RE.test(name) !== true)
            fail(name, '工具名不合法');

    // 沙箱根必须在导入 tools.js 之前生效（模块顶层会算 PERSONA_ROOT）。
    const sandbox = makeSandboxRoot(names);
    process.env.QQ_PROXY_ROOT = sandbox;
    try {
        const result = await import(pathToFileURL(LIB + '/tool-result.js').href);
        const { registerTools } = await import(pathToFileURL(LIB + '/tools.js').href);

        /* ---------- A. schema meta + 输出契约 ---------- */
        const validated = new Set();
        const lintSchema = (schema, where) => {
            if (!isPlainObject(schema)) {
                fail(where, 'schema 不是对象');
                return;
            }
            const types = Array.isArray(schema.type) ? schema.type : [schema.type];
            if (types.length === 0 || types.some(type => typeof type !== 'string' || HOST_SCHEMA_TYPES.has(type) !== true)) {
                fail(where, 'schema type 非法：' + JSON.stringify(schema.type));
                return;
            }
            if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
                fail(where, 'additionalProperties 必须是布尔');
            if (isPlainObject(schema.properties))
                for (const [key, child] of Object.entries(schema.properties))
                    lintSchema(child, where + '.' + key);
            if (types.includes('array')) {
                if (schema.items === undefined)
                    fail(where, 'array 缺少 items');
                else
                    lintSchema(schema.items, where + '[]');
            }
        };
        const lintParameters = (parameters, name) => {
            if (parameters === undefined)
                return;
            if (!isPlainObject(parameters)) {
                fail(name, 'parameters 不是对象');
                return;
            }
            // defineTool 已把"参数名 → 描述符"编译成 JSON Schema；两种形态都接受。
            const schemaForm = parameters.type === 'object' && isPlainObject(parameters.properties);
            const specOf = schemaForm ? parameters.properties : parameters;
            if (schemaForm && parameters.required !== undefined) {
                if (!Array.isArray(parameters.required))
                    fail(name, 'parameters.required 必须是数组');
                else
                    for (const key of parameters.required)
                        if (Object.hasOwn(specOf, key) !== true)
                            fail(name, 'required 里的 ' + String(key) + ' 不在 properties 中');
            }
            for (const [key, spec] of Object.entries(specOf)) {
                const where = name + '.' + key;
                if (PARAM_KEY_RE.test(key) !== true)
                    fail(where, '参数名不合法');
                if (!isPlainObject(spec)) {
                    fail(where, '参数描述符不是对象');
                    continue;
                }
                if (PARAM_TYPES.has(spec.type) !== true)
                    fail(where, '参数 type 非法：' + String(spec.type));
                if (typeof spec.description !== 'string' || spec.description.trim() === '')
                    fail(where, '缺少 description（模型看不到这个参数是干什么的）');
                if (schemaForm !== true && spec.required !== undefined && typeof spec.required !== 'boolean')
                    fail(where, 'required 必须是布尔');
                if (spec.type === 'array' && (!isPlainObject(spec.items) || PARAM_TYPES.has(spec.items.type) !== true))
                    fail(where, 'array 的 items.type 非法');
            }
        };
        const lintTool = (tool) => {
            if (!isPlainObject(tool)) {
                fail('<unknown>', '工具不是对象');
                return;
            }
            const name = typeof tool.name === 'string' ? tool.name : '';
            if (NAME_RE.test(name) !== true) {
                fail(name || '<无名>', 'name 不合法');
                return;
            }
            if (validated.has(name))
                return;
            if (typeof tool.description !== 'string' || tool.description.trim().length < 8)
                fail(name, 'description 缺失或过短');
            if (typeof tool.execute !== 'function')
                fail(name, 'execute 不是函数');
            lintParameters(tool.parameters, name);
            if (!isPlainObject(tool.output)) {
                fail(name, '缺少 output 契约');
            }
            else {
                lintSchema(tool.output.schema, name + '.output.schema');
                if (isPlainObject(tool.output.schema)) {
                    if (tool.output.schema.type !== 'object')
                        fail(name + '.output.schema', '必须是 type=object');
                    if (tool.output.schema.additionalProperties !== true)
                        fail(name + '.output.schema', '必须 additionalProperties=true');
                }
                if (typeof tool.output.render !== 'function') {
                    fail(name, 'output.render 不是函数');
                }
                else {
                    let parts;
                    try {
                        parts = tool.output.render({}, { ok: true });
                    }
                    catch (error) {
                        fail(name, 'output.render 抛错：' + String(error?.message ?? error));
                    }
                    if (parts !== undefined) {
                        if (!Array.isArray(parts) || parts.length === 0)
                            fail(name, 'output.render 没返回文本段');
                        else
                            for (const part of parts)
                                if (!isPlainObject(part) || part.type !== 'text' || typeof part.text !== 'string' || part.text.trim() === '')
                                    fail(name, 'output.render 返回空/非 text 段');
                    }
                    try {
                        tool.output.render({}, null);
                    }
                    catch (error) {
                        fail(name, 'output.render 对空结果抛错（静默成功必须渲染成 failed）：' + String(error?.message ?? error));
                    }
                }
            }
            validated.add(name);
        };

        const ctx = {
            tools: {
                register: (tool) => {
                    lintTool(tool);
                    return () => {};
                },
                restrict: () => () => {},
            },
        };
        const bridge = {
            chats: new Map(),
            chatForSession: () => undefined,
            deps: { config: {} },
            traceIdFor: () => null,
        };
        registerTools(ctx, bridge, {}, { maxImageBytes: 1, maxVoiceBytes: 1, maxFileBytes: 1 });

        /* ---------- B. 四态契约 ---------- */
        if (result.RESULT_STATES.join(',') !== 'ok,done,failed,blocked')
            fail('contract', 'RESULT_STATES 变了：' + result.RESULT_STATES.join(','));
        const cases = [
            { label: 'ok', value: result.resultOk('已完成'), prefix: '已完成' },
            { label: 'done', value: result.resultDone('no-result', '没有条目'), prefix: '没查到' },
            { label: 'failed', value: result.resultFail('timeout', '超时'), prefix: '没有成功：' },
            { label: 'blocked', value: result.resultBlocked('disabled', '已停用'), prefix: '没有执行：' },
        ];
        for (const item of cases) {
            const value = item.value;
            if (result.RESULT_STATES.includes(value.state) !== true)
                fail('contract', item.label + ' 构造器产出了非法 state');
            if (typeof value.why !== 'string' || value.why.trim() === '')
                fail('contract', item.label + ' 的 why 为空');
            if (RETRY_VALUES.has(value.retry) !== true)
                fail('contract', item.label + ' 的 retry 非法：' + String(value.retry));
            if (item.label !== 'ok' && (typeof value.next !== 'string' || value.next.trim() === ''))
                fail('contract', item.label + ' 的 next 为空（模型没有下一步指引）');
            const text = result.renderResult(value);
            if (typeof text !== 'string' || text.trim() === '')
                fail('contract', item.label + ' 渲染为空');
            else if (text.startsWith(item.prefix) !== true)
                fail('contract', item.label + ' 渲染前缀不是「' + item.prefix + '」：' + text.slice(0, 40));
        }
        const silent = result.normalizeResult(null);
        if (silent.state !== 'failed' || silent.code !== 'internal')
            fail('contract', '空返回没有落成 failed/internal');
        if (result.failFromError(new Error('请求超时')).code !== 'timeout')
            fail('contract', '超时错误没有分类成 timeout');

        /* ---------- C. 源码原因码 ---------- */
        // 已知原因码一定有默认 next；未知原因码 next 为空，模型就断了指引。
        for (const match of source.matchAll(/\bresult(?:Done|Fail|Blocked)\(\s*'([a-z0-9-]+)'(?!\s*\+)/gu)) {
            const code = match[1];
            if (result.resultBlocked(code, 'x').next.trim() === '' && result.resultDone(code, 'x').next.trim() === '')
                fail('tools.js', '使用了未定义的原因码 ' + code);
        }

        /* ---------- D. 清单完整性 ---------- */
        const declaredSet = new Set(names);
        if (declaredSet.size !== names.length)
            fail('inventory', '源码里工具名有重复');
        for (const name of declaredSet)
            if (validated.has(name) !== true)
                fail('inventory', '源码声明了 ' + name + '，注册路径没有产出');
        for (const name of validated)
            if (declaredSet.has(name) !== true)
                fail('inventory', '注册出了源码清单里没有的工具 ' + name);

        if (failures.length > 0) {
            const error = new Error('[tool-contract-lint] 未通过（' + failures.length + ' 项）：' + failures.slice(0, 12).join('；'));
            error.failures = failures;
            throw error;
        }
        return { declared: names.length, validated: validated.size, names: [...validated] };
    }
    finally {
        try {
            rmSync(sandbox, { recursive: true, force: true });
        }
        catch { /* 临时目录清理失败不影响结论 */ }
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const report = await runToolContractLint();
        console.log('PASS 声明=' + report.declared + ' 校验=' + report.validated);
        console.log('工具：' + report.names.join(', '));
    }
    catch (error) {
        console.error('FAIL ' + (error?.message ?? String(error)));
        process.exitCode = 1;
    }
}
