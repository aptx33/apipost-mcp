// @ts-nocheck
import { performance } from 'node:perf_hooks';

export function normalizedRoute(method, url) {
    const path = String(url).replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '').split('?')[0]
        .replace(/\/+/g, '/').replace(/\/$/, '').replace(/\{([^}]+)\}/g, ':$1');
    return `${String(method).toUpperCase()} ${path || '/'}`;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function jsonValue(value) {
    try { return { parsed: true, value: JSON.parse(value) }; } catch { return { parsed: false, value }; }
}
function wireValue(value) { return typeof value === 'string' ? value : JSON.stringify(value); }

// 仅比较调用方明确提交的契约，忽略版本和自动生成的参数 ID。
export function contractDifferences(actual, expected, item) {
    if (!actual) return ['target'];
    const differences = [];
    const compare = (path, a, b) => { if (!same(a, b)) differences.push(path); };
    for (const key of ['name', 'method', 'url', 'description']) {
        if (item.action === 'create' || Object.hasOwn(item, key)) compare(key, actual[key], expected[key]);
    }
    if (item.action === 'create') compare('parent_id', actual.parent_id, expected.parent_id);
    for (const [input, section, member] of [['headers', 'header', 'parameter'], ['query', 'query', 'parameter'],
        ['cookies', 'cookie', 'parameter'], ['restful', 'restful', 'parameter'], ['body', 'body', 'raw_parameter']]) {
        if (!Object.hasOwn(item, input)) continue;
        const wanted = expected.request[section][member] || [], received = actual.request?.[section]?.[member] || [];
        compare(`request.${section}.keys`, received.map(p => p.key).sort(), wanted.map(p => p.key).sort());
        for (const field of wanted) {
            const found = received.find(p => p.key === field.key);
            if (!found) continue;
            for (const key of ['description', 'field_type', 'schema']) compare(`request.${section}.${field.key}.${key}`, found[key], field[key]);
            compare(`request.${section}.${field.key}.required`, Number(found.not_null) === 1, Number(field.not_null) === 1);
            if (input !== 'body') compare(`request.${section}.${field.key}.value`, wireValue(found.value), wireValue(field.value));
        }
    }
    if (Object.hasOwn(item, 'body') || Object.hasOwn(item, 'bodyRaw')) {
        compare('request.body.raw', jsonValue(actual.request?.body?.raw), jsonValue(expected.request.body.raw));
        compare('request.body.mode', actual.request?.body?.mode, expected.request.body.mode);
    }
    if (Object.hasOwn(item, 'auth')) compare('request.auth', actual.request?.auth, expected.request.auth);
    if (Object.hasOwn(item, 'responses')) {
        const wanted = expected.response.example, received = actual.response?.example || [];
        compare('response.example.length', received.length, wanted.length);
        wanted.forEach((response, i) => {
            if (!received[i]) return;
            for (const path of ['raw', 'mock']) {
                const a = path === 'raw' ? received[i].raw : received[i].expect?.mock;
                const b = path === 'raw' ? response.raw : response.expect?.mock;
                compare(`response[${i}].${path}`, jsonValue(a), jsonValue(b));
            }
            for (const key of ['schema', 'name', 'code', 'content_type']) compare(`response[${i}].expect.${key}`, received[i].expect?.[key], response.expect?.[key]);
        });
    }
    return differences;
}

const inputKeys = new Set(['key', 'action', 'target_id', 'expected_fingerprint', 'method', 'url', 'name', 'parent_id',
    'description', 'headers', 'query', 'cookies', 'restful', 'body', 'bodyRaw', 'auth', 'responses']);

export async function syncBatch(items, io) {
    const start = performance.now(), timings = { preparationMs: 0, writeMs: 0, verificationMs: 0 };
    if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('items 必须包含1～100项');
    const keys = new Set(), updateIds = new Set();
    // 完整载荷预检在所有远端写入之前完成。
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('items 每项必须为对象');
        if (Object.keys(item).some(k => !inputKeys.has(k))) throw new Error('items 含未支持的字段');
        for (const key of Object.keys(item)) if (typeof item[key] !== 'string') throw new Error(`字段 ${key} 必须为字符串`);
        if (typeof item.key !== 'string' || !item.key.trim() || keys.has(item.key)) throw new Error('key 必须非空且唯一');
        keys.add(item.key);
        if (!['create', 'update'].includes(item.action)) throw new Error('action 必须为 create 或 update');
        if (Object.hasOwn(item, 'method') && !['GET', 'POST', 'PUT', 'DELETE'].includes(item.method)) throw new Error('method 不受支持');
        for (const key of ['name', 'url']) if (Object.hasOwn(item, key) && !item[key].trim()) throw new Error(`${key} 不得为空`);
        if (item.action === 'create') {
            if (!item.name?.trim() || !item.url?.trim() || !['GET', 'POST', 'PUT', 'DELETE'].includes(item.method)) throw new Error('新增须提供 name、method、url');
            if (item.target_id || item.expected_fingerprint) throw new Error('新增不接受 target_id 或指纹');
        } else {
            if (!item.target_id?.trim() || !/^[a-f0-9]{64}$/.test(item.expected_fingerprint || '')) throw new Error('更新须提供 target_id 和 expected_fingerprint');
            if (updateIds.has(item.target_id)) throw new Error('同批不能重复更新同一目标');
            updateIds.add(item.target_id);
            if (Object.hasOwn(item, 'parent_id')) throw new Error('批量更新不支持移动目录');
        }
        io.prepare(item, undefined);
    }
    const projectList = await io.list();
    const results = items.map(item => ({ key: item.key, action: item.action, target_id: item.target_id, status: 'unverified', differences: [] }));
    const expected = new Map(), attempted = new Set();
    const routeCounts = new Map();
    for (const item of items.filter(i => i.action === 'create')) {
        const route = normalizedRoute(item.method, io.url(item.url));
        routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
    }
    timings.preparationMs = performance.now() - start;
    let stop = false;
    for (let i = 0; i < items.length; i++) {
        const item = items[i], result = results[i], began = performance.now();
        if (stop) { result.error = '上游写入结果不明，未尝试此项'; continue; }
        try {
            let original;
            if (item.action === 'create') {
                const route = normalizedRoute(item.method, io.url(item.url));
                const matches = projectList.filter(d => d.target_type === 'api' && normalizedRoute(d.method, d.url) === route);
                if (routeCounts.get(route) > 1 || matches.length) {
                    result.status = 'conflict'; result.error = '同批或云端已存在相同 method + path'; continue;
                }
            } else {
                original = (await io.details([item.target_id]))[0];
                if (!original || original.target_type !== 'api' || Number(original.status) === -1 || io.fingerprint(original) !== item.expected_fingerprint) {
                    result.status = 'conflict'; result.error = '目标缺失、已删除或内容指纹已变化'; continue;
                }
            }
            const template = io.prepare(item, original);
            expected.set(i, template);
            if (original && !contractDifferences(original, template, item).length) {
                result.status = 'unchanged'; result.version = original.version; continue;
            }
            attempted.add(i);
            // 请求发出前登记 ID，网络结果不明时仍可回读定位。
            result.target_id = template.target_id;
            try {
                result.target_id = await io.write(item.action, template);
            } catch (error) {
                result.error = error.confirmedFailure ? '服务端明确拒绝写入' : '写入结果不明，已停止后续写入';
                if (error.confirmedFailure) { result.status = 'failed'; attempted.delete(i); }
                else {
                    stop = true;
                    if (item.action === 'create') {
                        try {
                            const matches = (await io.list()).filter(d => d.target_type === 'api'
                                && d.parent_id === template.parent_id && normalizedRoute(d.method, d.url) === normalizedRoute(template.method, template.url));
                            if (matches.length === 1) result.target_id = matches[0].target_id;
                        } catch { /* 最终回读仍尝试已登记的目标 ID。 */ }
                    }
                }
            }
        } catch (error) {
            result.status = 'failed'; result.error = '读取或准备目标失败，未写入';
        } finally { result.writeMs = +(performance.now() - began).toFixed(1); }
    }
    timings.writeMs = performance.now() - start - timings.preparationMs;
    const verificationStart = performance.now();
    if (attempted.size) {
        try {
            const docs = await io.details([...attempted].map(i => results[i].target_id));
            for (const i of attempted) {
                const result = results[i], doc = docs.find(d => d.target_id === result.target_id);
                result.differences = contractDifferences(doc, expected.get(i), items[i]);
                if (doc) result.version = doc.version;
                if (!result.differences.length) { result.status = items[i].action === 'create' ? 'created' : 'updated'; delete result.error; }
            }
        } catch { for (const i of attempted) results[i].error = '写后完整回读失败，尚未验收'; }
    }
    timings.verificationMs = performance.now() - verificationStart;
    timings.totalMs = performance.now() - start;
    for (const key of Object.keys(timings)) timings[key] = +timings[key].toFixed(1);
    return { results, timings, success: results.every(r => ['created', 'updated', 'unchanged'].includes(r.status)) };
}
