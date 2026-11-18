/**
 * 视频抽帧：纯 ffmpeg / ffprobe，不依赖平台。
 *
 * 一条链路同时给 B 站与 QQ 视频用：
 *   关键帧基线 → 可疑 GOP 定点场景检测 → 场景救回 → 选帧预算分配。
 * 入口是 collectFrames()；sceneCuts/planAdaptiveSampling/grabFrame 供降级补帧复用。
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { announceHw, D3D_ARGS, HW_ON, logHwFallback, QSV_ARGS, withHwAccel } from './ffmpeg-hw.mjs';

const run = promisify(execFile);

export const FRAME_WIDTH = 960;
export const SCENE_THRESHOLD = 0.25;
export const MIN_KEY_GAP_SEC = 0.3;
export const MAX_RESCUE_GOPS = 8;
const DENSITY_WINDOW_SEC = 10;

export async function probeVideo(file) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration', '-show_entries', 'format=duration,start_time',
        '-of', 'json', file], { maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams?.[0] ?? {};
    return {
        width: Number(stream.width ?? 0),
        height: Number(stream.height ?? 0),
        fps: String(stream.r_frame_rate ?? ''),
        duration: Number(stream.duration ?? parsed.format?.duration ?? 0),
        startTime: Number(parsed.format?.start_time ?? 0),
    };
}

export async function keyframeTable(file) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,size,flags', '-of', 'csv=p=0', file],
    { maxBuffer: 64 * 1024 * 1024 });
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.split(','));
    const keys = [];
    for (const row of rows) {
        if ((row[2] ?? row[1] ?? '').includes('K'))
            keys.push({ at: Number(row[0]), bytes: Number(row[1] ?? 0) });
    }
    return keys;
}

export async function extractKeyframes(file, dir) {
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    announceHw();
    const softArgs = ['-hide_banner', '-loglevel', 'error', '-y',
        '-skip_frame', 'nokey', '-copyts', '-i', file,
        '-fps_mode', 'passthrough', '-vf', 'scale=' + FRAME_WIDTH + ':-2',
        '-q:v', '4', join(dir, 'k-%03d.jpg')];
    // QSV 解码器不认 -skip_frame nokey（会退化成全帧解码），但 d3d11va 认；
    // 关键帧走 d3d11va 硬解 + skip_frame，只硬解关键帧，产物数量与软解一致。
    const hwArgs = withHwAccel(softArgs, D3D_ARGS);
    if (HW_ON) {
        try {
            await run('ffmpeg', hwArgs, { maxBuffer: 8 * 1024 * 1024 });
        }
        catch (error) {
            logHwFallback(file, '抽关键帧', error);
            // 硬解失败可能已经落了半套图，清掉再软解，避免混进两张不同来源的帧。
            await rm(dir, { recursive: true, force: true });
            await mkdir(dir, { recursive: true });
            await run('ffmpeg', softArgs, { maxBuffer: 8 * 1024 * 1024 });
        }
    }
    else {
        await run('ffmpeg', softArgs, { maxBuffer: 8 * 1024 * 1024 });
    }
    const names = (await readdir(dir)).filter(name => name.endsWith('.jpg')).sort();
    return { names: names.map(name => join(dir, name)), ms: Date.now() - started };
}

/** 只在给定窗口内做场景检测，窗口外不解码。 */
export async function sceneInWindow(file, startSec, lengthSec, scratch) {
    await mkdir(scratch, { recursive: true });
    const marker = 'scene-' + Math.round(startSec * 1000) + '.txt';
    await rm(join(scratch, marker), { force: true });
    announceHw();
    const softArgs = ['-hide_banner', '-loglevel', 'error', '-y',
        '-copyts', '-ss', startSec.toFixed(3), '-t', lengthSec.toFixed(3), '-i', file,
        '-vf', "scale=320:-2,select='gt(scene," + SCENE_THRESHOLD + ")',metadata=print:file=" + marker,
        '-an', '-f', 'null', '-'];
    // 全 GPU 链：帧留在显存里缩放，最后只 hwdownload 一次回到内存做 select/打分。
    const hwArgs = ['-hide_banner', '-loglevel', 'error', '-y',
        '-copyts', '-ss', startSec.toFixed(3), '-t', lengthSec.toFixed(3),
        ...QSV_ARGS, '-i', file,
        '-vf', "scale_qsv=w=320:h=180,hwdownload,format=nv12,select='gt(scene," + SCENE_THRESHOLD + ")',metadata=print:file=" + marker,
        '-an', '-f', 'null', '-'];
    if (HW_ON) {
        try {
            await run('ffmpeg', hwArgs, { cwd: scratch, maxBuffer: 8 * 1024 * 1024 });
        }
        catch (error) {
            logHwFallback(file, '窗口场景检测', error);
            await rm(join(scratch, marker), { force: true });
            await run('ffmpeg', softArgs, { cwd: scratch, maxBuffer: 8 * 1024 * 1024 });
        }
    }
    else {
        await run('ffmpeg', softArgs, { cwd: scratch, maxBuffer: 8 * 1024 * 1024 });
    }
    const text = await readFile(join(scratch, marker), 'utf8').catch(() => '');
    const times = [...text.matchAll(/pts_time:([0-9.]+)/gu)]
        .map(match => Number(match[1]))
        .map(t => (t < startSec - 1 ? t + startSec : t));
    await rm(join(scratch, marker), { force: true });
    return times;
}

function median(values) {
    if (values.length === 0)
        return 0;
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/** 关键帧字节数离群 = 画面信息量突变，值得单独做场景检测。 */
export function suspiciousGops(keys) {
    const med = median(keys.map(key => key.bytes));
    const picked = [];
    for (let i = 0; i < keys.length; i += 1) {
        const ratio = med === 0 ? 1 : keys[i].bytes / med;
        const isLast = i === keys.length - 1;
        if (ratio > 1.5 || ratio < 0.4 || (i % 4 === 3) || isLast)
            picked.push(i);
    }
    return { picked: picked.slice(0, MAX_RESCUE_GOPS), medianBytes: med };
}

export async function grabFrame(file, atSec, dest) {
    announceHw();
    const softArgs = ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', atSec.toFixed(3), '-i', file, '-frames:v', '1',
        '-vf', 'scale=' + FRAME_WIDTH + ':-2', '-q:v', '4', dest];
    if (HW_ON) {
        try {
            await run('ffmpeg', withHwAccel(softArgs, D3D_ARGS), { maxBuffer: 4 * 1024 * 1024 });
        }
        catch (error) {
            logHwFallback(file, '补帧', error);
            await rm(dest, { force: true });
            await run('ffmpeg', softArgs, { maxBuffer: 4 * 1024 * 1024 });
        }
    }
    else {
        await run('ffmpeg', softArgs, { maxBuffer: 4 * 1024 * 1024 });
    }
    return (await stat(dest)).size;
}

function evenlyPick(frames, limit) {
    if (limit <= 0 || frames.length === 0)
        return [];
    if (frames.length <= limit)
        return frames;
    const step = frames.length / limit;
    return Array.from({ length: limit }, (_, index) => frames[Math.floor(index * step)]);
}

export function selectFrames(candidates, limit) {
    const sorted = [...candidates].sort((a, b) => a.at - b.at);
    const kept = [];
    for (const frame of sorted) {
        const near = kept.find(item => Math.abs(item.at - frame.at) < MIN_KEY_GAP_SEC);
        if (near === undefined)
            kept.push(frame);
        else if (frame.why === 'scene' && near.why !== 'scene')
            kept[kept.indexOf(near)] = frame;
    }
    if (kept.length <= limit)
        return kept;
    // 一半预算留给场景救回，另一半按时间均匀铺满关键帧基线，避免整段只剩切镜。
    const scenes = evenlyPick(kept.filter(frame => frame.why === 'scene'), Math.max(1, Math.floor(limit / 2)));
    const rest = kept.filter(frame => !scenes.includes(frame));
    return [...scenes, ...evenlyPick(rest, limit - scenes.length)].sort((a, b) => a.at - b.at);
}

/** 全片场景切换点（缩到 320 宽只做检测，不解 720p）；失败就当没有切镜信号。
 *  from/to 只给 QQ 视频的 range 模式用：只解码所选区间，时间点相对 from。 */
export async function sceneCuts(file, { from = 0, to = 0 } = {}) {
    announceHw();
    const pre = ['-hide_banner', '-nostats'];
    if (from > 0)
        pre.push('-ss', from.toFixed(3));
    if (to > from)
        pre.push('-t', (to - from).toFixed(3));
    const args = [...pre, '-i', file,
        '-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'];
    const hwArgs = [...pre, ...QSV_ARGS, '-i', file,
        '-vf', "scale_qsv=w=320:h=180,hwdownload,format=nv12,select='gt(scene,0.3)',showinfo",
        '-an', '-f', 'null', '-'];
    const parse = stderr => [...String(stderr).matchAll(/pts_time:([0-9.]+)/gu)]
        .map(match => Number(match[1]))
        .filter(value => Number.isFinite(value));
    if (HW_ON) {
        try {
            const { stderr } = await run('ffmpeg', hwArgs, { maxBuffer: 64 * 1024 * 1024 });
            return parse(stderr);
        }
        catch (error) {
            logHwFallback(file, '全片场景检测', error);
        }
    }
    try {
        const { stderr } = await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
        return parse(stderr);
    }
    catch {
        return [];
    }
}

/**
 * 自适应采样密度：以 1fps 为底盘，按 10 秒窗口内的切镜数升降。
 * 切镜密集（蒙太奇/快剪）升到 3~8fps；长镜头/静态降到每 3 秒一帧。
 * 预算封顶后按重要性裁剪：切镜点优先，其次升级档，最后均匀覆盖。
 */
export function planAdaptiveSampling({ duration, cuts, budgetFrames }) {
    const windows = [];
    for (let from = 0; from < duration; from += DENSITY_WINDOW_SEC) {
        const to = Math.min(duration, from + DENSITY_WINDOW_SEC);
        const count = cuts.filter(at => at >= from && at < to).length;
        const fps = count >= 10 ? 8 : count >= 5 ? 3 : count >= 2 ? 1 : 1 / 3;
        windows.push({ from, to, cuts: count, fps });
    }
    const candidates = [];
    const add = (at, priority, windowIndex) => {
        const value = Number(Number(at).toFixed(2));
        if (!Number.isFinite(value) || value < 0 || value >= duration)
            return;
        if (candidates.some(item => Math.abs(item.at - value) < 0.2))
            return;
        candidates.push({ at: value, priority, windowIndex });
    };
    // 1) 切镜点最高优先
    for (const cut of cuts)
        add(cut, 3, Math.floor(cut / DENSITY_WINDOW_SEC));
    // 2) 各窗口按自适应密度铺点
    windows.forEach((window, index) => {
        const step = 1 / window.fps;
        for (let at = window.from + step / 2; at < window.to; at += step)
            add(at, window.fps > 1 ? 2 : 0, index);
    });
    const ranked = [...candidates].sort((first, second) => second.priority - first.priority
        || first.at - second.at);
    const selected = [];
    const take = item => {
        if (selected.some(exist => Math.abs(exist.at - item.at) < 0.2))
            return;
        selected.push(item);
    };
    // 切镜点先占预算的一半，再补升级档；最后的额度从低优先级里均匀取。
    const cutBudget = Math.min(ranked.filter(item => item.priority === 3).length, Math.ceil(budgetFrames / 2));
    let used = 0;
    for (const item of ranked.filter(entry => entry.priority === 3)) {
        if (used >= cutBudget)
            break;
        take(item);
        used += 1;
    }
    for (const item of ranked.filter(entry => entry.priority === 2)) {
        if (selected.length >= budgetFrames)
            break;
        take(item);
    }
    const rest = ranked.filter(item => item.priority === 0 && !selected.includes(item));
    while (selected.length < budgetFrames && rest.length > 0) {
        const stride = Math.max(1, Math.floor(rest.length / Math.max(1, budgetFrames - selected.length)));
        take(rest.splice(0, 1)[0]);
        if (stride > 1)
            rest.splice(0, stride - 1);
    }
    const keptByWindow = new Map();
    for (const item of selected)
        keptByWindow.set(item.windowIndex, (keptByWindow.get(item.windowIndex) ?? 0) + 1);
    const degraded = windows.map((window, index) => {
        const planned = Math.round((window.to - window.from) * window.fps);
        const kept = keptByWindow.get(index) ?? 0;
        if (planned <= kept || window.fps <= 1)
            return null;
        return {
            from: Math.round(window.from),
            to: Math.round(window.to),
            fps: window.fps,
            planned,
            kept,
            reason: '预算裁剪',
        };
    }).filter(Boolean);
    return {
        targets: selected.sort((first, second) => first.at - second.at),
        stats: {
            baselineFps: 1 / 3,
            windowSec: DENSITY_WINDOW_SEC,
            windows: windows.length,
            upgradedWindows: windows.filter(window => window.fps > 1).length,
            busiestCuts: windows.reduce((best, window) => Math.max(best, window.cuts), 0),
            candidates: candidates.length,
            kept: selected.length,
            trimmed: Math.max(0, candidates.length - selected.length),
            degraded,
            budgetFrames,
        },
    };
}

/**
 * 一条视频的选帧全流程：关键帧基线 + 可疑 GOP 场景救回 + 预算裁剪。
 * 返回的 chosen 已按时间排序；未入选的帧已删除，入选帧留在 workDir 下。
 * @param {{file:string, workDir:string, maxFrames:number, onYield?:(stage:string)=>void}} input
 */
export async function collectFrames({ file, workDir, maxFrames, duration = 0, onYield } = {}) {
    const check = stage => (typeof onYield === 'function' ? onYield(stage) : undefined);
    const timing = {};
    try {
        check('取帧前');
        let stepAt = Date.now();
        const keys = await keyframeTable(file);
        const extracted = await extractKeyframes(file, join(workDir, 'base'));
        timing.keyframes = Date.now() - stepAt;
        if (extracted.names.length !== keys.length)
            throw new Error('关键帧数量不一致：' + extracted.names.length + ' vs ' + keys.length);

        const candidates = extracted.names.map((path, index) => ({ at: keys[index].at, path, why: 'keyframe' }));

        // 可疑 GOP 的场景兜底：只解这些窗口，不整片全解码。
        const { picked, medianBytes } = suspiciousGops(keys);
        stepAt = Date.now();
        const sceneHits = [];
        for (const index of picked) {
            check('场景兜底中');
            const start = keys[index].at;
            const end = index + 1 < keys.length
                ? keys[index + 1].at
                : Math.min(duration > 0 ? duration : start + 10, start + 10);
            if (!(end > start))
                continue;
            for (const at of await sceneInWindow(file, start, end - start, join(workDir, 'scene')))
                sceneHits.push(at);
        }
        timing.sceneRescue = Date.now() - stepAt;

        stepAt = Date.now();
        const rescueCandidates = [];
        // 和关键帧落在同一时刻的命中不算“救回”，避免同一画面抓两次。
        const rescueTimes = [...new Set(sceneHits.map(t => Number(t.toFixed(2))))]
            .filter(at => !keys.some(key => Math.abs(key.at - at) < MIN_KEY_GAP_SEC));
        for (const at of rescueTimes) {
            const path = join(workDir, 'scene-' + Math.round(at * 1000) + '.jpg');
            try {
                const size = await grabFrame(file, at, path);
                rescueCandidates.push({ at, path, why: 'scene', bytes: size });
            }
            catch {
                // 个别时间点抓不到就跳过，不影响整体
            }
        }
        timing.grabRescue = Date.now() - stepAt;

        const chosen = selectFrames([...rescueCandidates, ...candidates.map(item => ({ ...item, bytes: 0 }))], Math.min(maxFrames, 12));
        // 未入选的帧立刻删掉，只留下要看的。
        const keep = new Set(chosen.map(item => item.path));
        for (const path of [...extracted.names, ...rescueCandidates.map(item => item.path)]) {
            if (!keep.has(path))
                await rm(path, { force: true });
        }
        return {
            chosen,
            timing,
            keys,
            picked: picked.length,
            rescueCandidates,
            sceneHits,
            medianBytes,
        };
    }
    catch (error) {
        await rm(workDir, { recursive: true, force: true });
        throw error;
    }
}
