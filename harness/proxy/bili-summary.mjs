/**
 * 视频级总结：优先用 B 站 CC 字幕，字幕拿不到才退到加密画面采样（并明确标注降级）。
 *
 * 输出固定三段：讲了什么 / 值得看的点 / 适合谁看。
 * 只输出给人看的总结，不做逐帧列举；分享文案与「聊到带出」共用这一份。
 */
import { LLM, chatCompletionsPath, normalizePayload } from './llm-config.mjs';

const SUMMARY_URL = process.env.QQ_SUMMARY_URL ?? (new URL(LLM.baseUrl).origin + chatCompletionsPath());
const SUMMARY_MODEL = process.env.QQ_SUMMARY_MODEL ?? LLM.model;
const SUMMARY_TIMEOUT_MS = Number(process.env.QQ_SUMMARY_TIMEOUT_MS) || 120_000;
// 字幕全量可能上万字：按比例取开头/中段/结尾，控制在 12000 字以内。
const MAX_SUBTITLE_CHARS = 12_000;

function trimSubtitle(text) {
    const value = String(text ?? '');
    if (value.length <= MAX_SUBTITLE_CHARS)
        return value;
    const part = Math.floor(MAX_SUBTITLE_CHARS / 3);
    return value.slice(0, part)
        + '\n……\n' + value.slice(Math.floor(value.length / 2) - Math.floor(part / 2), Math.floor(value.length / 2) + Math.floor(part / 2))
        + '\n……\n' + value.slice(-part);
}

function stripJsonFence(text) {
    const match = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
    return match === null ? text : match[1];
}

function render(summary, source) {
    const gist = String(summary?.gist ?? '').trim();
    const highlights = Array.isArray(summary?.highlights)
        ? summary.highlights.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 3)
        : [];
    const audience = String(summary?.audience ?? '').trim();
    if (gist === '')
        return '';
    const lines = ['讲了什么：' + gist];
    if (highlights.length > 0) {
        const marks = ['①', '②', '③'];
        lines.push('值得看的点：' + highlights.map((item, index) => marks[index] + item).join(' '));
    }
    if (audience !== '')
        lines.push('适合谁看：' + audience);
    // 信源与置信度只写结构化字段（source/summarySource），正文不再挂任何限定语。
    return lines.join('\n');
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.owner
 * @param {number} input.duration
 * @param {{ok:boolean, lang?:string, chars?:number, text?:string, reason?:string}} input.subtitle
 * @param {{ok:boolean, model?:string, chars?:number, text?:string}} input.asr 本地转写（无字幕时）
 * @param {{hints?:string[]}} input.structure 音频结构摘要
 * @param {string[]} input.captions 画面观察（辅助证据）
 */
export async function summarizeVideo({ title, owner, duration, subtitle, asr, structure, captions } = {}) {
    const started = Date.now();
    const useSubtitle = subtitle?.ok === true && String(subtitle.text ?? '').trim() !== '';
    const useAsr = !useSubtitle && asr?.ok === true && String(asr.text ?? '').trim() !== '';
    const material = useSubtitle
        ? '以下是视频字幕（时间轴 + 正文）：\n' + trimSubtitle(subtitle.text)
        : useAsr
            ? '以下是视频语音内容（时间轴 + 正文，可能有同音错字）：\n' + trimSubtitle(asr.text)
            : '以下是按画面变化率抽帧得到的画面观察（只记录画面里发生了什么）：\n'
                + (captions ?? []).map((text, index) => (index + 1) + '. ' + text).join('\n');
    const source = useSubtitle ? 'subtitle' : useAsr ? 'asr' : 'frames';
    const hints = Array.isArray(structure?.hints) ? structure.hints.filter(Boolean).slice(0, 10) : [];
    const structureBlock = hints.length === 0
        ? ''
        : '\n\n音频结构（可作为「值得看的点」的依据，说人话，不要堆参数）：\n- ' + hints.join('\n- ');
    if (captions?.length === 0 && !useSubtitle && !useAsr)
        return { ok: false, source, reason: '既没有字幕、转写也没有画面观察', text: '', chars: 0, ms: Date.now() - started };

    const headers = { 'content-type': 'application/json' };
    if (LLM.apiKey !== '')
        headers.authorization = 'Bearer ' + LLM.apiKey;
    const minutes = Math.max(1, Math.round(Number(duration ?? 0) / 60));
    const payload = normalizePayload({
        model: SUMMARY_MODEL,
        stream: false,
        temperature: 0.2,
        max_tokens: 700,
        reasoning_effort: 'none',
        messages: [
            {
                role: 'system',
                content: '你是视频编辑。只根据给定材料写一份给人看的视频总结，不编造材料里没有的情节。'
                    + '不要逐帧罗列画面，不要空话（如“质量很高”“非常精彩”）。'
                    + '音频结构只在能说明「这一段为什么值得看」时自然带一句，不要罗列 BPM/分贝等参数。',
            },
            {
                role: 'user',
                content: '视频：《' + String(title ?? '') + '》\nUP：' + String(owner ?? '') + '\n时长：约 ' + minutes + ' 分钟\n\n'
                    + material
                    + structureBlock
                    + '\n\n请输出 JSON（不要额外文字）：\n'
                    + '{"gist":"2-4 句连贯的话，说清主题和脉络","highlights":["具体的内容点 1","具体的内容点 2"],'
                    + '"audience":"一句话：适合谁看"}\n'
                    + 'gist 不超过 160 字，highlights 每条不超过 40 字、最多 3 条，audience 不超过 40 字。',
            },
        ],
    });
    try {
        const response = await fetch(SUMMARY_URL, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
            body: JSON.stringify(payload),
        });
        if (!response.ok)
            return { ok: false, source, reason: '总结模型 HTTP ' + response.status, text: '', chars: 0, ms: Date.now() - started };
        const data = await response.json();
        const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
        let parsed;
        try {
            parsed = JSON.parse(stripJsonFence(raw));
        }
        catch {
            parsed = { gist: raw.replace(/\s+/gu, ' ').slice(0, 220) };
        }
        const text = render(parsed, source);
        if (text === '')
            return { ok: false, source, reason: '模型没有给出可用总结', text: '', chars: 0, ms: Date.now() - started };
        // 真正的降级只留在结构化字段里（面板/日志用），不进总结正文。
        const degraded = source !== 'frames'
            ? (source === 'asr' && Number(asr?.chars ?? 0) < 200 ? 'asr-short' : '')
            : 'frames-only';
        return {
            ok: true,
            source,
            degraded,
            text,
            chars: text.length,
            subtitleLang: subtitle?.lang ?? '',
            subtitleChars: Number(subtitle?.chars ?? 0),
            asrModel: useAsr ? String(asr?.model ?? '') : '',
            asrChars: useAsr ? Number(asr?.chars ?? 0) : 0,
            ms: Date.now() - started,
        };
    }
    catch (error) {
        return { ok: false, source, reason: String(error?.message ?? error), text: '', chars: 0, ms: Date.now() - started };
    }
}
