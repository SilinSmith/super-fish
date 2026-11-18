// 归一化平台层唯一入口。
// 消费者（插件 inbound/bridge/outbound、qq-persona proxy、测试）一律从这里 import，
// 不允许再指向插件 node_modules 内的副本。
export * from './event.js';
export * from './schema.js';
