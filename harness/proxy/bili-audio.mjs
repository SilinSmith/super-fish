/**
 * 音频层：抽音轨 → ASR 转写 → 结构分析（人声/音乐/静音、BPM、响度、留白）。
 *
 * 只产出可复查的中间结果，不发消息；调度与让路由 bili.mjs 负责（三者串行）。
 * 依赖：系统 ffmpeg；faster-whisper 跑在 tmp/asr/venv 里（CPU int8 + VAD）。
 */
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceHw, HW_ON, logHwFallback, withHwAccel } from './ffmpeg-hw.mjs';

const HOME = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.QQ_ASR_PYTHON ?? join(HOME, 'tmp', 'asr', 'venv', 'Scripts', 'python.exe');
const ASR_SCRIPT = join(HOME, 'bili-asr.py');
const AUDIO_SCRIPT = join(HOME, 'bili-audio.py');
const ASR_TIMEOUT_MS = Number(process.env.QQ_ASR_TIMEOUT_MS) || 15 * 60_000;

function runProcess(command, args, { timeoutMs = 60_000, onSpawn } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('PROCESS_TIMEOUT'));
        }, timeoutMs);
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        onSpawn?.(child);
    });
}

/** 抽 16k 单声道 wav：ASR 与结构分析共用这一份。
 *  带 -vn，实际不解码视频；仍按统一策略走核显参数，失败回落软解并留日志。 */
export async function extractAudio(video, wav) {
    const started = Date.now();
    announceHw();
    const softArgs = ['-y', '-hide_banner', '-loglevel', 'error',
        '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav];
    let result = null;
    if (HW_ON) {
        result = await runProcess('ffmpeg', withHwAccel(softArgs), { timeoutMs: 180_000 });
        if (result.code !== 0) {
            logHwFallback(video, '抽音频', { stderr: result.stderr });
            await rm(wav, { force: true });
            result = await runProcess('ffmpeg', softArgs, { timeoutMs: 180_000 });
        }
    }
    else {
        result = await runProcess('ffmpeg', softArgs, { timeoutMs: 180_000 });
    }
    if (result.code !== 0)
        throw new Error('抽音轨失败：' + result.stderr.slice(-200));
    return { ms: Date.now() - started };
}

/**
 * 本地转写。shouldYield 命中时写 cancel 文件，Python 每段检查一次后退出（部分结果落盘）。
 * 中止情况抛 BILI_YIELD，让上层按放弃处理并清临时目录。
 */
export async function transcribe({ wav, model = 'medium', threads = 4, initialPrompt = '',
    out, cancelFile, shouldYield }) {
    const args = [ASR_SCRIPT, '--audio', wav, '--model', model, '--threads', String(threads),
        '--out', out, '--cancel', cancelFile];
    if (String(initialPrompt).trim() !== '')
        args.push('--prompt', String(initialPrompt).trim());
    let yieldReason = '';
    const timer = typeof shouldYield === 'function'
        ? setInterval(() => {
            const reason = shouldYield();
            if (reason !== false && reason !== undefined && reason !== null && reason !== '') {
                yieldReason = String(reason);
                writeFile(cancelFile, '1', 'utf8').catch(() => undefined);
            }
        }, 500)
        : null;
    timer?.unref?.();
    const started = Date.now();
    let result;
    try {
        result = await runProcess(PYTHON, args, { timeoutMs: ASR_TIMEOUT_MS });
    }
    finally {
        if (timer !== null)
            clearInterval(timer);
    }
    await rm(cancelFile, { force: true });
    let doc = null;
    try {
        doc = JSON.parse(await readFile(out, 'utf8'));
    }
    catch {
        doc = null;
    }
    if (yieldReason !== '') {
        const error = new Error('BILI_YIELD:' + yieldReason + '（ASR 中）');
        error.code = 'BILI_YIELD';
        error.reason = yieldReason;
        error.where = 'ASR 中';
        throw error;
    }
    if (doc === null || result.code === 3)
        return { ok: false, aborted: true, reason: '转写被中止', ms: Date.now() - started };
    if (result.code !== 0)
        return { ok: false, reason: '转写进程失败（' + result.code + '）：' + result.stderr.slice(-200), ms: Date.now() - started };
    // 短片的字数阈值按比例放：69s 的视频 70 多字也是完整转写。
    const text = (doc.transcript ?? [])
        .map(row => '[' + Math.floor(row.start / 60).toString().padStart(2, '0') + ':'
            + Math.floor(row.start % 60).toString().padStart(2, '0') + '] ' + row.text)
        .join('\n');
    const enough = doc.chars >= 30 && doc.chars >= Number(doc.audio_duration_sec ?? 0) * 0.4;
    return {
        ok: enough && text !== '',
        model: doc.model,
        threads: doc.threads,
        chars: doc.chars,
        segments: doc.segments,
        wallMs: doc.wall_ms,
        rtf: doc.rtf,
        peakRssMb: doc.peak_rss_mb,
        text,
        ms: Date.now() - started,
        reason: enough ? '' : '转写字数过少',
    };
}

/** 结构分析：分段 + 特征 + 粗标签，回传紧凑摘要与可直接进提示词的结构行。 */
export async function analyzeStructure(wav, out) {
    const started = Date.now();
    const { code, stderr } = await runProcess(PYTHON, [AUDIO_SCRIPT, '--audio', wav, '--out', out],
        { timeoutMs: 180_000 });
    if (code !== 0)
        return { ok: false, reason: '结构分析失败：' + stderr.slice(-200), ms: Date.now() - started };
    const doc = JSON.parse(await readFile(out, 'utf8'));
    const segments = Array.isArray(doc.segments) ? doc.segments : [];
    const music = segments.filter(seg => seg.kind === '音乐' || seg.kind === '人声+音乐');
    const silence = segments.filter(seg => seg.kind === '静音');
    const swells = segments.filter(seg => seg.tag === '渐强');
    // 音乐块：合并相邻音乐段（间隔 ≤2.5s），用于「结尾是 BPM 171 的快剪」这类描述。
    const blocks = [];
    for (const seg of music) {
        const last = blocks.at(-1);
        if (last !== undefined && seg.start - last.end <= 2.5) {
            last.end = seg.end;
            last.bpm = seg.bpm ?? last.bpm;
            last.rms = Math.max(last.rms, seg.rms_db);
            last.tags.add(seg.tag);
        }
        else {
            blocks.push({ start: seg.start, end: seg.end, bpm: seg.bpm, rms: seg.rms_db, tags: new Set([seg.tag]) });
        }
    }
    const fmt = value => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
    const hints = [];
    for (const block of blocks.filter(item => item.end - item.start >= 2).slice(0, 6)) {
        const tags = [...block.tags].filter(tag => tag !== '未知');
        hints.push('音乐 ' + fmt(block.start) + '-' + fmt(block.end)
            + (block.bpm ? '（BPM ' + block.bpm + '）' : '') + (tags.length > 0 ? '，听感' + tags.join('/') : ''));
    }
    for (const seg of silence.slice(0, 4))
        hints.push('静音留白 ' + fmt(seg.start) + '-' + fmt(seg.end));
    for (const seg of swells.slice(0, 3))
        hints.push('响度渐强 ' + fmt(seg.start) + '-' + fmt(seg.end));
    if (hints.length === 0) {
        // 没有成块的音乐/静音时也要给一句结构：全片什么为主，别让总结凭空描述配乐。
        const coverage = doc.coverage_pct ?? {};
        const musicShare = Number(coverage['音乐'] ?? 0) + Number(coverage['人声+音乐'] ?? 0);
        hints.push('全片以人声为主：人声 ' + Number(coverage['人声'] ?? 0) + '%，音乐 '
            + musicShare.toFixed(1) + '%，静音 ' + Number(coverage['静音'] ?? 0) + '%，'
            + (musicShare >= 10 ? '音乐只出现在零星短片段' : '没有成段配乐'));
    }
    return {
        ok: true,
        coveragePct: doc.coverage_pct ?? {},
        segments: segments.length,
        musicBlocks: blocks.length,
        silenceCount: silence.length,
        timingMs: doc.timing_ms?.total ?? (Date.now() - started),
        hints,
        doc,
        ms: Date.now() - started,
    };
}
