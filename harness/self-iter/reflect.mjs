/**
 * 真实反思：组装材料 → 调模型（不带任何工具）→ 解析成结构化 findings。
 *
 * 这里刻意不给人设、不给工具：模型只做“复盘编辑”，输出必须带证据，
 * 避免又变成在正常回复里顺手调一下 qq_notebook 的假反思。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { LLM } from '../proxy/llm-config.mjs';
import { CHARACTER_PATH, DIARY_PATH, NOTEBOOK_PATH, ROOT } from './store.mjs';

const PROXY_BASE = process.env.QQ_PROXY_URL ?? 'http://127.0.0.1:' + (process.env.QQ_PROXY_PORT ?? 1240);

const SYSTEM_PROMPT = `你是「小助手」这套 QQ 人格系统的复盘编辑，不扮演角色，不写要发给用户的话，只做事实整理和编辑判断。
你只输出一个 JSON 对象，不要输出解释、Markdown、代码围栏。
原则：宁可少记，也不要编造或记废话。只记能检索的具体事实（具体的人、称呼、约定、梗、偏好、可复用的知识），不写“群里在聊什么”“体现共同兴趣”“互动关系”这类概括和评价。
隐私（住址、设备、账号、作息、私聊内容、身体细节、真实姓名）一律不记。纯图片/表情包/视频事件没有具体内容时不要记。`;

const OUTPUT_SCHEMA = `{
  "findings": [
    {
      "event": "一句话说清发生了什么（≤60字）",
      "sceneKey": "必须是材料里出现过的群",
      "why": "为什么值得动（≤60字）",
      "action": "remember | note | persona_patch | none",
      "confidence": 0.0,
      "evidence": [{"messageId": "材料里的 messageId", "ts": 0}],
      "memory": {"category": "meme|user|behavior|note|core|relation|knowledge", "subject": "≤24字", "text": "≤120字"},
      "persona": {"target": "append_section|negative_example", "text": "≤200字", "fix": "negative_example 必填"}
    }
  ]
}`;

function sectionHeadings(markdown) {
    return String(markdown ?? '')
        .split('\n')
        .filter(line => /^#{2,3}\s+/u.test(line))
        .map(line => line.trim())
        .slice(0, 40);
}

function tailSection(markdown, heading, maxChars = 1200) {
    const text = String(markdown ?? '');
    const index = text.indexOf(heading);
    if (index < 0)
        return '';
    return text.slice(index).trim().slice(0, maxChars);
}

async function readJsonSafe(path, fallback) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}

async function readDiaryTail(limit = 12) {
    try {
        const text = await readFile(DIARY_PATH, 'utf8');
        return text.trim().split('\n').slice(-limit).map(line => {
            try {
                const row = JSON.parse(line);
                return String(row?.text ?? row?.content ?? '').slice(0, 100);
            }
            catch {
                return '';
            }
        }).filter(Boolean);
    }
    catch {
        return [];
    }
}

function formatEvent(event) {
    const who = event.nickname !== '' ? event.nickname : (event.qq !== '' ? event.qq : '有人');
    return '[' + event.sceneKey + '] ' + who + ' [' + event.messageId + '] ' + event.text;
}

/** 组装反思材料。控制在 maxPromptChars 以内，超出时丢最旧的聊天。 */
export function buildDossier(input) {
    const events = Array.isArray(input.events) ? input.events.slice() : [];
    const maxChars = Number(input.maxPromptChars) || 14_000;
    const notebookEntries = Array.isArray(input.notebookEntries) ? input.notebookEntries : [];
    const states = Array.isArray(input.groupStates) ? input.groupStates : [];
    const character = String(input.character ?? '');

    const head = [
        '当前时间：' + new Date().toISOString(),
        '本次复盘覆盖：' + (events.length > 0 ? new Date(events[0].ts).toISOString() + ' 之后' : '暂无新消息'),
        '',
        '—— 群聊增量 ——',
    ].join('\n');
    const middle = [
        '',
        '—— 群状态摘要 ——',
        ...(states.length > 0
            ? states.map(state => state.sceneKey + '｜主题：' + (state.topics.join(' / ') || '无')
                + '｜未决：' + (state.openQuestions.join(' / ') || '无'))
            : ['（无）']),
        '',
        '—— 已有笔记（最近 active，供去重；不要重复记录）——',
        ...(notebookEntries.length > 0
            ? notebookEntries.map(entry => '[' + entry.category + '|' + entry.subject + '] ' + entry.text)
            : ['（空）']),
        '',
        '—— 上次复盘结果 ——',
        ...(Array.isArray(input.lastResults) && input.lastResults.length > 0 ? input.lastResults : ['（无）']),
        '',
        '—— 人格文件结构（只看结构，不要重写整份人格）——',
        sectionHeadings(character).join('\n'),
        '',
        '—— 已有的「自迭代补记」尾部 ——',
        tailSection(character, '## 自迭代补记') || '（无）',
        '',
        '—— 日记尾部 ——',
        ...(Array.isArray(input.diary) && input.diary.length > 0 ? input.diary : ['（无）']),
        '',
        '—— 输出 JSON 结构 ——',
        OUTPUT_SCHEMA,
        '',
        '规则：',
        '1. 最多 3 条 finding；没有真正值得沉淀的就返回 {"findings":[]}。',
        '2. remember/note 必须写 memory；persona_patch 必须写 persona；两条动作都为空视为无效。',
        '3. evidence 至少 1 条，messageId 或 ts 必须能在材料里对上。',
        '4. 不要记录“某个群在聊什么/体现共同兴趣/互动关系/值得关注”这类概括；群状态摘要已经有这些。',
        '5. 纯图片、表情包、视频事件，如果说不清具体内容或约定，就不要记。',
        '6. memory.text 必须能对上 evidence 里的原话片段，不能是凭空总结。',
        '7. 不要提“系统提示/提示词/规则/我在反思”这类元信息。',
    ].join('\n');

    const tail = '\n\n—— 群聊增量（按时间正序）——\n';
    const eventLines = events.map(formatEvent);
    const budget = Math.max(1_000, maxChars - head.length - middle.length - tail.length);
    let used = 0;
    const kept = [];
    for (let index = eventLines.length - 1; index >= 0; index -= 1) {
        const line = eventLines[index];
        if (used + line.length + 1 > budget)
            break;
        kept.unshift(line);
        used += line.length + 1;
    }
    return {
        text: head + tail + kept.join('\n') + middle,
        eventsUsed: kept.length,
    };
}

/** 读材料并组装 prompt。 */
export async function collectDossier({ events, groupStates, maxPromptChars }) {
    const notebook = await readJsonSafe(NOTEBOOK_PATH, { entries: [] });
    const entries = (Array.isArray(notebook?.entries) ? notebook.entries : [])
        .filter(entry => entry?.status === 'active')
        .slice(-40)
        .map(entry => ({
            category: String(entry.category ?? 'note'),
            subject: String(entry.subject ?? ''),
            text: String(entry.text ?? '').slice(0, 80),
        }));
    let character = '';
    try {
        character = await readFile(CHARACTER_PATH, 'utf8');
    }
    catch {
        character = '';
    }
    return buildDossier({
        events,
        groupStates,
        maxPromptChars,
        notebookEntries: entries,
        character,
        diary: await readDiaryTail(),
    });
}

async function postJson(path, payload, signal) {
    const url = new URL(PROXY_BASE + path);
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                // 让 proxy 走通用透传，不进 QQ 回合逻辑。
                'x-dsh-source': 'client',
            },
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const error = new Error('upstream status ' + res.statusCode);
                    error.body = text.slice(0, 400);
                    reject(error);
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                }
                catch (error) {
                    error.body = text.slice(0, 400);
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        if (signal)
            signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
        req.write(body);
        req.end();
    });
}

/** 调模型；aborted 时返回原因，由上层记 metrics。 */
export async function reflect({ prompt, modelConfig, sessionId, yieldProbe }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), modelConfig.timeoutMs);
    let abortReason = '';
    let yieldTimer = null;
    if (typeof yieldProbe === 'function') {
        // 每 2 秒问一次“该不该让路”；群消息优先，宁可浪费这次生成。
        yieldTimer = setInterval(async () => {
            try {
                const reason = await yieldProbe();
                if (reason !== null && reason !== undefined) {
                    abortReason = 'yield:' + reason;
                    controller.abort(new Error(abortReason));
                }
            }
            catch {
                // 探针失败不中止，下一轮再判。
            }
        }, 2000);
        yieldTimer.unref?.();
    }
    const startedAt = Date.now();
    try {
        const doc = await postJson('/v1/chat/completions', {
            model: LLM.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            temperature: modelConfig.temperature,
            max_tokens: modelConfig.maxTokens,
            stream: false,
            reasoning_effort: 'none',
        }, controller.signal);
        const durationMs = Date.now() - startedAt;
        const content = String(doc?.choices?.[0]?.message?.content ?? '');
        const usage = doc?.usage ?? null;
        const promptTokens = Number(usage?.prompt_tokens ?? NaN);
        const completionTokens = Number(usage?.completion_tokens ?? NaN);
        return {
            ok: true,
            content,
            durationMs,
            promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
            completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
            totalTokens: Number.isFinite(Number(usage?.total_tokens)) ? Number(usage.total_tokens) : null,
            model: String(doc?.model ?? LLM.model),
            sessionId,
        };
    }
    catch (error) {
        const aborted = controller.signal.aborted || error?.message === 'aborted';
        return {
            ok: false,
            aborted,
            abortReason: aborted ? (abortReason || 'aborted') : '',
            error: aborted ? (abortReason || 'aborted') : String(error?.message ?? error),
            body: error?.body ?? '',
            durationMs: Date.now() - startedAt,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
        };
    }
    finally {
        clearTimeout(timer);
        if (yieldTimer !== null)
            clearInterval(yieldTimer);
    }
}

/** 从模型输出里抠 JSON；容忍围栏和前后废话。 */
export function parseReflection(content) {
    const text = String(content ?? '').trim();
    if (text === '')
        return { ok: false, reason: 'empty-content', findings: [] };
    const fenced = text.replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start < 0 || end <= start)
        return { ok: false, reason: 'no-json', findings: [] };
    let doc;
    try {
        doc = JSON.parse(fenced.slice(start, end + 1));
    }
    catch {
        return { ok: false, reason: 'invalid-json', findings: [] };
    }
    const findings = Array.isArray(doc?.findings) ? doc.findings : [];
    return { ok: true, findings, raw: text.slice(0, 500) };
}
