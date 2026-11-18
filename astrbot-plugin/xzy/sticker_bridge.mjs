/**
 * 表情包选图桥（Python 插件 ↔ E:\Bonsai\astrbot-eval\inst\data\xzy\persona\sticker-lib.mjs）。
 *
 * 选图只有 sticker-lib.pickSticker 一套：索引、打分、情绪门槛、10 分钟全局冷却、
 * 同会话最近 3 张排除、黑名单都在那边。Python 侧不复制这套逻辑，只通过 stdin
 * 传 JSON、stdout 取一行 JSON。
 *
 * 用法（stdin）: {"cmd":"pick","text":"...","emotion":"...","chatId":"group:1","turnId":"msg:9"}
 *               {"cmd":"note","id":"st_xxx","chatId":"group:1","turnId":"msg:9","now":1700000000000}
 * 环境变量:
 *   QQ_STICKER_LIB   覆盖 sticker-lib.mjs 路径
 *   QQ_STICKER_ROOT / QQ_STICKER_WORK  由 sticker-lib.mjs 自己读取
 */
import { pathToFileURL } from 'node:url';

const libPath = process.env.QQ_STICKER_LIB || 'E:\\Bonsai\\astrbot-eval\\inst\\data\\xzy\\persona\\sticker-lib.mjs';

let lib;
try {
    lib = await import(pathToFileURL(libPath).href);
}
catch (error) {
    console.log(JSON.stringify({ ok: false, reason: 'lib-unavailable', error: String(error) }));
    process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let payload;
try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
catch (error) {
    console.log(JSON.stringify({ ok: false, reason: 'bad-payload', error: String(error) }));
    process.exit(0);
}

const cmd = String(payload.cmd || 'pick');
try {
    if (cmd === 'note') {
        await lib.noteStickerSelected(
            String(payload.id || ''),
            String(payload.chatId || ''),
            Number(payload.now) || Date.now(),
            String(payload.turnId || ''),
        );
        console.log(JSON.stringify({ ok: true }));
    }
    else {
        const result = await lib.pickSticker({
            text: String(payload.text || ''),
            emotion: String(payload.emotion || ''),
            chatId: String(payload.chatId || ''),
            turnId: String(payload.turnId || ''),
        });
        console.log(JSON.stringify(result));
    }
}
catch (error) {
    console.log(JSON.stringify({ ok: false, reason: 'lib-error', error: String(error?.message || error) }));
}
