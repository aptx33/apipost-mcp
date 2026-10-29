import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { runBenchmark } from '../scripts/benchmark-sync.mjs';
import { contractDifferences } from '../dist/sync-batch.js';

// MCP 子进程仅连接本机模拟服务器，不读取任何个人配置或真实凭据。
async function fixture(t, securityMode = 'limited', hooks = {}) {
    const documents = new Map();
    const requests = [];
    const mock = createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        const body = text ? JSON.parse(text) : {};
        requests.push({ path: req.url, body });
        let data;
        if (req.url === '/open/team/list') data = [{ team_id: 'team', name: 'mock-team' }];
        else if (req.url.startsWith('/open/project/list')) data = [{ project_id: 'project', name: 'mock-project' }];
        else if (req.url === '/open/apis/create' || req.url === '/open/apis/update') {
            const doc = structuredClone(body);
            const behavior = hooks.write?.(doc, req.url);
            if (behavior === 'reject') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ code: 1, msg: '模拟明确拒绝' }));
                return;
            }
            if (behavior === 'disconnect-before') { req.socket.destroy(); return; }
            // 模拟服务端规范化，验证客户端没有依赖本地推算的版本或参数值类型。
            doc.version = 1000 + requests.length;
            for (const group of [doc.request?.header?.parameter || [], doc.request?.query?.parameter || [], doc.request?.body?.raw_parameter || []]) {
                for (const field of group) {
                    if (field.not_null === 0) field.not_null = 1;
                    field.value = typeof field.value === 'string' ? field.value : JSON.stringify(field.value);
                }
            }
            documents.set(doc.target_id, doc);
            hooks.corrupt?.(doc);
            if (behavior === 'disconnect-after') { req.socket.destroy(); return; }
            data = { target_id: doc.target_id };
        } else if (req.url === '/open/apis/details') {
            data = { list: body.target_ids.filter(id => documents.has(id)).map(id => documents.get(id)).reverse() };
        } else if (req.url.startsWith('/open/apis/list')) {
            data = { list: [...documents.values()].filter(doc => doc.status !== -1) };
        } else if (req.url === '/open/apis/delete') {
            for (const id of body.target_ids) if (documents.has(id)) documents.get(id).status = -1;
            data = {};
        } else {
            res.writeHead(404).end();
            return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 0, data }));
    });
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    let logs = '';
    let child;
    // 当前 SDK 0.4 的 stdio 客户端固定继承 stderr；测试传输单独捕获日志以验证无凭据输出。
    const transport = {
        async start() {
            child = spawn(process.execPath, ['dist/index.js'], { env: {
                APIPOST_HOST: `http://127.0.0.1:${mock.address().port}`,
                APIPOST_TOKEN: 'local-test-token',
                APIPOST_SECURITY_MODE: securityMode,
                APIPOST_DEFAULT_TEAM_NAME: 'mock-team',
                APIPOST_DEFAULT_PROJECT_NAME: 'mock-project',
                APIPOST_URL_PREFIX: '', APIPOST_INLINE_COMMENTS: 'false'
            }, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stderr.on('data', chunk => { logs += chunk; });
            createInterface({ input: child.stdout }).on('line', line => this.onmessage?.(JSON.parse(line)));
            child.on('error', error => this.onerror?.(error));
            child.on('close', () => this.onclose?.());
            await once(child, 'spawn');
        },
        async send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
        async close() {
            if (child && child.exitCode === null) {
                const closed = once(child, 'close');
                child.kill();
                await closed;
            }
        }
    };
    const client = new Client({ name: 'sync-test', version: '1' }, { capabilities: {} });
    t.after(async () => {
        await client.close();
        await new Promise(resolve => mock.close(resolve));
        assert.ok(!logs.includes('local-test-token'), '日志不得暴露凭据');
    });
    await client.connect(transport);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const read = async ids => JSON.parse((await call('apipost_details', { target_ids: ids })).content[0].text);
    return { documents, requests, call, read, client, logs: () => logs };
}

const rawRequest = JSON.stringify({ uuid: 'test-prescription', unanswered: null, empty: '', medication: false,
    count: 0, symptoms: ['none', 'pain', 'pain'], nested: [{ value: null }, { value: true }] });
const bodyFields = [
    { key: 'uuid', type: 'string', desc: '处方标识', required: true, example: 'test-prescription' },
    { key: 'unanswered', type: 'string', desc: '未回答', required: false, example: null },
    { key: 'medication', type: 'boolean', desc: '是否用药', example: false },
    { key: 'count', type: 'integer', desc: '次数', example: 0 }
];
const responseData = { success: true, message: { nullable: null, empty: '', flag: false,
    symptoms: ['none', 'pain', 'pain'], rows: Array.from({ length: 7 }, (_, i) => ({ no: i + 1, text: '训练内容'.repeat(30) })) } };
const responses = [{ name: '真实响应', status: 200, data: responseData, fields: [
    { key: 'success', type: 'boolean', desc: '是否成功' },
    { key: 'message', type: 'object', desc: '业务数据' },
    { key: 'message.nullable', type: 'string', desc: '可空答案', schema: { type: ['string', 'null'] } },
    { key: 'message.empty', type: 'string', desc: '备注' },
    { key: 'message.flag', type: 'boolean', desc: '回答' },
    { key: 'message.symptoms', type: 'array', desc: '多选答案', schema: { type: 'array', items: { type: 'string' } } },
    { key: 'message.rows', type: 'array', desc: '七次记录' },
    { key: 'message.rows[].no', type: 'integer', desc: '序号' },
    { key: 'message.rows[].text', type: 'string', desc: '训练内容' }
] }];
async function create(f, extra = {}) {
    const result = await f.call('apipost_smart_create', {
        method: 'POST', url: 'http://localhost/epm/mock', name: '本地模拟接口',
        body: JSON.stringify(bodyFields), bodyRaw: rawRequest, responses: JSON.stringify(responses), ...extra
    });
    assert.ok(!result.isError, result.content[0].text);
    return [...f.documents.keys()].at(-1);
}

test('完整批量读取、选填转换、原文及响应类型保真', async t => {
    const f = await fixture(t);
    const tools = (await f.client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === 'apipost_details'));
    assert.ok(tools.find(tool => tool.name === 'apipost_smart_create').inputSchema.properties.bodyRaw);
    assert.ok(tools.find(tool => tool.name === 'apipost_update').inputSchema.properties.expected_fingerprint);
    const first = await create(f);
    const second = await create(f, { url: '/second' });
    const before = f.requests.length;
    const detail = await f.read([first, second, 'missing']);
    assert.equal(f.requests.length - before, 1, '批量回读只应有一次 HTTP 请求');
    assert.deepEqual(detail.list.map(doc => doc.target_id), [first, second]);
    assert.deepEqual(detail.missing_ids, ['missing']);
    const beforeInvalid = f.requests.length;
    const invalid = await f.call('apipost_details', { target_ids: [first, first] });
    assert.equal(invalid.isError, true);
    assert.equal(f.requests.length, beforeInvalid);
    const doc = detail.list[0];
    assert.equal(doc.request.body.raw, rawRequest);
    assert.deepEqual(doc.request.body.raw_parameter.map(p => p.not_null), [1, -1, -1, -1]);
    const response = doc.response.example[0];
    assert.ok(response.raw.length > 200);
    assert.deepEqual(JSON.parse(response.raw), responseData);
    assert.deepEqual(JSON.parse(response.expect.mock), responseData);
    assert.deepEqual(response.raw_parameter, []);
    assert.deepEqual(response.expect.schema.properties.message.properties.nullable.type, ['string', 'null']);
    assert.equal(response.expect.schema.properties.message.properties.symptoms.items.type, 'string');
    const single = JSON.parse((await f.call('apipost_detail', { target_id: first, format: 'json' })).content[0].text);
    assert.deepEqual(single.list, [doc]);
    const text = (await f.call('apipost_detail', { target_id: first })).content[0].text;
    assert.match(text, /未回答\n\s+类型: string, 必需: 否/);
    assert.match(f.logs(), /\[ApiPost\] POST \/open\/apis\/details 200 \d+ms/);
});

test('文案和字段更新保留原始示例，指纹冲突停止写入', async t => {
    const f = await fixture(t);
    const id = await create(f);
    f.documents.get(id).request.custom = { retained: true };
    f.documents.get(id).request.query.custom = { retained: true };
    f.documents.get(id).response.custom = { retained: true };
    let detail = await f.read([id]);
    const original = structuredClone(detail.list[0]);
    let result = await f.call('apipost_update', { target_id: id, description: '新的调用说明',
        expected_fingerprint: detail.fingerprints[id] });
    assert.ok(!result.isError, result.content[0].text);
    detail = await f.read([id]);
    assert.deepEqual(detail.list[0].request, original.request);
    assert.deepEqual(detail.list[0].response, original.response);
    assert.equal(detail.fingerprints[id], (await f.read([id])).fingerprints[id], '无变化回读指纹应稳定');
    result = await f.call('apipost_update', { target_id: id, body: JSON.stringify(bodyFields.map(p => ({ ...p, desc: p.desc + '说明' }))),
        expected_fingerprint: detail.fingerprints[id] });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(f.documents.get(id).request.body.raw, rawRequest);
    const after = await f.read([id]);
    const fingerprint = after.fingerprints[id];
    f.documents.get(id).request = Object.fromEntries(Object.entries(f.documents.get(id).request).reverse());
    f.documents.get(id).version += 1;
    assert.equal((await f.read([id])).fingerprints[id], fingerprint, '对象键顺序和服务端版本不改变内容指纹');
    // 模拟另一用户在回读后修改字段。
    f.documents.get(id).description = '人工新修改';
    const writes = f.requests.filter(r => r.path === '/open/apis/update').length;
    result = await f.call('apipost_update', { target_id: id, description: '过期草稿', expected_fingerprint: after.fingerprints[id] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /内容已变化/);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/update').length, writes);
    assert.equal(f.documents.get(id).description, '人工新修改');
});

test('只读安全模式允许批量读取，拒绝所有写入', async t => {
    const f = await fixture(t, 'readonly');
    assert.deepEqual((await f.read(['missing'])).missing_ids, ['missing']);
    for (const [name, args] of [
        ['apipost_smart_create', { method: 'GET', name: '不应创建', url: '/never' }],
        ['apipost_update', { target_id: 'never', description: '不应修改' }],
        ['apipost_sync_batch', { items: [batchItem('never')] }],
        ['apipost_delete', { api_ids: ['never'] }]
    ]) {
        assert.equal((await f.call(name, args)).isError, true);
    }
    assert.equal(f.requests.filter(r => /\/apis\/(create|update|delete)$/.test(r.path)).length, 0);
});

test('显式 null 和原生响应保真，非法载荷不写入', async t => {
    const f = await fixture(t);
    const id = await create(f, { bodyRaw: undefined });
    assert.equal(JSON.parse(f.documents.get(id).request.body.raw).unanswered, null);
    const native = structuredClone(f.documents.get(id).response.example);
    let result = await f.call('apipost_update', { target_id: id, responses: JSON.stringify(native) });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(f.documents.get(id).response.example, native);
    const parameters = structuredClone(f.documents.get(id).request.body.raw_parameter);
    result = await f.call('apipost_update', { target_id: id, bodyRaw: rawRequest });
    assert.ok(!result.isError);
    assert.deepEqual(f.documents.get(id).request.body.raw_parameter, parameters);
    assert.equal(f.documents.get(id).request.body.raw, rawRequest);
    for (const args of [{ body: 'invalid' }, { body: '{}' }, { bodyRaw: 'invalid' },
        { body: JSON.stringify([{ key: 'x', desc: '说明', required: 'false' }]) },
        { responses: JSON.stringify([responses[0], native[0]]) }]) {
        const count = f.requests.filter(r => r.path === '/open/apis/update').length;
        result = await f.call('apipost_update', { target_id: id, ...args });
        assert.equal(result.isError, true);
        assert.equal(f.requests.filter(r => r.path === '/open/apis/update').length, count);
    }
    for (const data of [null, false, 0, '']) {
        result = await f.call('apipost_update', { target_id: id, responses: JSON.stringify([{ ...responses[0], data }]) });
        assert.ok(!result.isError);
        // 字符串空值也必须作为 JSON 字符串保存。
        assert.equal(JSON.parse(f.documents.get(id).response.example[0].raw), data);
    }
    result = await f.call('apipost_update', { target_id: id, body: '[]', responses: '[]' });
    assert.ok(!result.isError);
    assert.equal(f.documents.get(id).request.body.mode, 'none');
    assert.deepEqual(f.documents.get(id).response.example, []);
});

const batchItem = (key, extra = {}) => ({ key, action: 'create', name: '完整批量示例', method: 'POST',
    url: `http://localhost/epm/batch/${key}`, body: JSON.stringify(bodyFields), bodyRaw: rawRequest,
    responses: JSON.stringify(responses), ...extra });
const parseResult = result => {
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
};

test('结构化创建和列表不解析文案，删除以有效列表验收', async t => {
    const f = await fixture(t, 'full');
    const folder = parseResult(await f.call('apipost_create_folder', { name: '搜索条件也包含名字', format: 'json' }));
    assert.ok(f.documents.has(folder.target_id));
    const created = parseResult(await f.call('apipost_smart_create', { method: 'GET', url: '/structured', name: '结构化接口', parent_id: folder.target_id, format: 'json' }));
    const list = parseResult(await f.call('apipost_list', { search: '不存在的关键词', format: 'json' }));
    assert.equal(list.matched_count, 0);
    assert.deepEqual(list.items, []);
    const folderList = parseResult(await f.call('apipost_list', { parent_id: folder.target_id, format: 'json' }));
    assert.equal(folderList.items[0].target_id, created.target_id);
    const removed = parseResult(await f.call('apipost_delete', { api_ids: [created.target_id], format: 'json' }));
    assert.equal(removed.request_succeeded, true);
    assert.equal(removed.verified, true);
    assert.equal((await f.read([created.target_id])).list[0].status, -1, '删除后详情仍保留');
    const text = await f.call('apipost_list', {});
    assert.match(text.content[0].text, /项目列表/);
});

test('批量预检、完整新增、重复查重、无变化和指纹冲突', async t => {
    const f = await fixture(t);
    let result = await f.call('apipost_sync_batch', { items: [batchItem('valid'), batchItem('invalid', { body: '{}' })] });
    assert.equal(result.isError, true);
    assert.equal(f.documents.size, 0, '整批本地预检失败不得部分写入');
    const items = ['first', 'second', 'third'].map(key => batchItem(key));
    let batch = parseResult(await f.call('apipost_sync_batch', { items }));
    assert.equal(batch.success, true);
    assert.deepEqual(batch.results.map(r => r.status), ['created', 'created', 'created']);
    const ids = batch.results.map(r => r.target_id);
    const docs = await f.read(ids);
    for (const doc of docs.list) {
        assert.equal(doc.request.body.raw, rawRequest);
        assert.deepEqual(JSON.parse(doc.response.example[0].raw), responseData);
        assert.equal(doc.request.body.raw_parameter[1].not_null, -1);
    }
    batch = parseResult(await f.call('apipost_sync_batch', { items }));
    assert.deepEqual(batch.results.map(r => r.status), ['conflict', 'conflict', 'conflict']);
    assert.equal(f.documents.size, 3);
    const update = { ...items[0], action: 'update', target_id: ids[0], expected_fingerprint: docs.fingerprints[ids[0]] };
    let writes = f.requests.filter(r => r.path === '/open/apis/update').length;
    batch = parseResult(await f.call('apipost_sync_batch', { items: [update] }));
    assert.equal(batch.results[0].status, 'unchanged');
    assert.equal(f.requests.filter(r => r.path === '/open/apis/update').length, writes);
    batch = parseResult(await f.call('apipost_sync_batch', { items: [{ ...update, description: '新的字段契约说明' }] }));
    assert.equal(batch.results[0].status, 'updated');
    batch = parseResult(await f.call('apipost_sync_batch', { items: [{ ...update, description: '过期覆盖' }] }));
    assert.equal(batch.results[0].status, 'conflict');
    assert.equal(f.documents.get(ids[0]).description, '新的字段契约说明');
    batch = parseResult(await f.call('apipost_sync_batch', { items: [batchItem('duplicate-a', { url: '/same/{id}/' }), batchItem('duplicate-b', { url: '/same/:id?x=1' })] }));
    assert.deepEqual(batch.results.map(r => r.status), ['conflict', 'conflict']);
    const deletes = f.requests.filter(r => r.path === '/open/apis/delete').length;
    assert.equal((await f.call('apipost_delete', { api_ids: ids, format: 'json' })).isError, true);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/delete').length, deletes, 'limited 模式不能越权清理');
});

test('明确失败继续，网络结果不明停止且不重试', async t => {
    const f = await fixture(t, 'limited', { write: doc => doc.url.endsWith('/reject') ? 'reject'
        : doc.url.endsWith('/unknown') ? 'disconnect-after' : undefined });
    const batch = parseResult(await f.call('apipost_sync_batch', { items: ['reject', 'accepted', 'unknown', 'never'].map(key => batchItem(key)) }));
    assert.deepEqual(batch.results.map(r => r.status), ['failed', 'created', 'created', 'unverified']);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/create').length, 3);
    assert.equal(f.documents.size, 2);
    assert.match(batch.results[3].error, /未尝试/);
});

test('验收发现截断、null或布尔变化及字段说明丢失', async t => {
    const f = await fixture(t, 'limited', { corrupt: doc => {
        if (doc.target_type !== 'api') return;
        const raw = JSON.parse(doc.request.body.raw); raw.unanswered = ''; raw.medication = true;
        doc.request.body.raw = JSON.stringify(raw);
        doc.request.body.raw_parameter[0].description = '';
        const response = doc.response.example[0];
        const data = JSON.parse(response.raw); data.message.rows.length = 1;
        response.raw = JSON.stringify(data);
    } });
    const batch = parseResult(await f.call('apipost_sync_batch', { items: [batchItem('corrupt')] }));
    assert.equal(batch.success, false);
    assert.equal(batch.results[0].status, 'unverified');
    assert.ok(batch.results[0].differences.includes('request.body.raw'));
    assert.ok(batch.results[0].differences.includes('request.body.uuid.description'));
    assert.ok(batch.results[0].differences.includes('response[0].raw'));
    const actual = structuredClone([...f.documents.values()][0]), expected = structuredClone(actual);
    expected.response.example[0].raw = '"OK"'; actual.response.example[0].raw = 'OK';
    assert.ok(contractDifferences(actual, expected, { action: 'update', responses: '[]' }).includes('response[0].raw'), '无效JSON不能与合法JSON字符串判为相等');
});

const durationSchema = { type: ['number', 'null'], description: '预计时长，可空', minimum: 0, maximum: 1000 };
function numberBodyItem(key, fullParent = true) {
    return batchItem(key, {
        body: JSON.stringify([
            { key: 'snapshot', type: 'object', desc: '训练快照', required: false,
                schema: fullParent ? { type: ['object', 'null'], properties: { duration: durationSchema } } : { type: 'object' } },
            { key: 'snapshot.duration', type: 'number', desc: '预计时长，可空', required: false, schema: durationSchema }
        ]), bodyRaw: JSON.stringify({ snapshot: { duration: 70 } })
    });
}
function simplifyDuration(doc) {
    doc.request.body.raw_parameter.find(p => p.key === 'snapshot.duration').schema = { type: 'number' };
}

test('数字参数行简化但父级完整契约保留时一次通过，再同步不写入', async t => {
    const f = await fixture(t, 'limited', { corrupt: simplifyDuration });
    const item = numberBodyItem('nullable-number');
    let batch = parseResult(await f.call('apipost_sync_batch', { items: [item] }));
    assert.equal(batch.success, true);
    const id = batch.results[0].target_id;
    assert.equal(batch.results[0].status, 'created');
    const normalized = [{ path: 'request.body.snapshot.duration.schema', reason: 'body_number_schema_simplified',
        authoritativeSchemaPath: 'request.body.snapshot.schema',
        message: '数字参数行被平台简化；匹配的父级完整对象schema保留了可空性及全部约束' }];
    assert.deepEqual(batch.results[0].normalizations, normalized);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/create').length, 1);
    let docs = await f.read([id]);
    const update = { ...item, action: 'update', target_id: id, expected_fingerprint: docs.fingerprints[id] };
    batch = parseResult(await f.call('apipost_sync_batch', { items: [update] }));
    assert.equal(batch.results[0].status, 'unchanged');
    assert.deepEqual(batch.results[0].normalizations, normalized);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/update').length, 0);
    batch = parseResult(await f.call('apipost_sync_batch', { items: [{ ...update, description: '仅修改接口说明' }] }));
    assert.equal(batch.results[0].status, 'updated');
    assert.deepEqual(batch.results[0].normalizations, normalized);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/update').length, 1);
    docs = await f.read([id]);
    const doc = docs.list[0];
    assert.deepEqual(doc.request.body.raw_parameter[0].schema.properties.duration, durationSchema);
    assert.deepEqual(JSON.parse(doc.request.body.raw), { snapshot: { duration: 70 } });
    assert.ok(Array.isArray(contractDifferences(doc, doc, update)), '原导出接口仍返回差异数组');
});

test('缺少父级完整schema不能把数字简化当作验收成功', async t => {
    const f = await fixture(t, 'limited', { corrupt: simplifyDuration });
    const batch = parseResult(await f.call('apipost_sync_batch', { items: [numberBodyItem('no-parent-schema', false)] }));
    assert.equal(batch.success, false);
    assert.equal(batch.results[0].status, 'unverified');
    assert.deepEqual(batch.results[0].normalizations, []);
    assert.ok(batch.results[0].differences.includes('request.body.snapshot.duration.schema'));
    assert.match(batch.results[0].error, /缺少契约一致的父级完整对象schema/);
    assert.equal(f.requests.filter(r => r.path === '/open/apis/create').length, 1, '工具不自动重试');
});

test('数字简化不得掩盖父级约束、字段属性、请求或响应变化', async t => {
    const cases = [
        ['父级缺失', doc => { doc.request.body.raw_parameter.shift(); }, 'request.body.keys'],
        ['可空性丢失', doc => { doc.request.body.raw_parameter[0].schema.properties.duration.type = 'number'; }, 'request.body.snapshot.schema'],
        ['约束丢失', doc => { delete doc.request.body.raw_parameter[0].schema.properties.duration.minimum; }, 'request.body.snapshot.schema'],
        ['字段类型变化', doc => { doc.request.body.raw_parameter[1].field_type = 'integer'; }, 'request.body.snapshot.duration.field_type'],
        ['说明丢失', doc => { doc.request.body.raw_parameter[1].description = ''; }, 'request.body.snapshot.duration.description'],
        ['必填变化', doc => { doc.request.body.raw_parameter[1].not_null = 1; }, 'request.body.snapshot.duration.required'],
        ['请求原值变化', doc => { doc.request.body.raw = JSON.stringify({ snapshot: { duration: null } }); }, 'request.body.raw'],
        ['响应原值变化', doc => { doc.response.example[0].raw = JSON.stringify({ success: false }); }, 'response[0].raw']
    ];
    for (const [name, corrupt, expectedPath] of cases) {
        await t.test(name, async t => {
            const f = await fixture(t, 'limited', { corrupt: doc => { simplifyDuration(doc); corrupt(doc); } });
            const batch = parseResult(await f.call('apipost_sync_batch', { items: [numberBodyItem('strict-number')] }));
            assert.equal(batch.success, false);
            assert.equal(batch.results[0].status, 'unverified');
            assert.ok(batch.results[0].differences.includes(expectedPath));
            if (name !== '请求原值变化' && name !== '响应原值变化') assert.deepEqual(batch.results[0].normalizations, []);
        });
    }
});

test('数值例外不扩展到Query或响应schema', async t => {
    const f = await fixture(t);
    const id = await create(f);
    const doc = (await f.read([id])).list[0];
    const expected = structuredClone(doc), actual = structuredClone(doc);
    expected.request.query.parameter = [
        { key: 'snapshot', field_type: 'object', schema: { type: 'object', properties: { duration: durationSchema } } },
        { key: 'snapshot.duration', field_type: 'number', schema: durationSchema }
    ];
    actual.request.query = structuredClone(expected.request.query);
    actual.request.query.parameter[1].schema = { type: 'number' };
    assert.ok(contractDifferences(actual, expected, { action: 'update', query: '[]' }).includes('request.query.snapshot.duration.schema'));
    expected.response.example[0].expect.schema = durationSchema;
    actual.response.example[0].expect.schema = { type: 'number' };
    assert.ok(contractDifferences(actual, expected, { action: 'update', responses: '[]' }).includes('response[0].expect.schema'));
});

test('测速成功及局部失败均仅清理本批对象，原接口保持不变', async t => {
    for (const fail of [false, true]) {
        const f = await fixture(t, 'full', { write: doc => fail && doc.url?.includes('__apipost_benchmark') && doc.url.endsWith('/1') ? 'reject' : undefined });
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push(await create(f, { url: `/source/${i}` }));
        const original = await f.read(ids);
        const result = await runBenchmark(f.call, ids);
        assert.equal(result.success, !fail);
        assert.equal(result.cleanupComplete, true);
        assert.equal(result.originalsUnchanged, true);
        assert.equal([...f.documents.values()].filter(doc => doc.status !== -1).length, 3);
        assert.deepEqual((await f.read(ids)).fingerprints, original.fingerprints);
    }
});

test('测速目录出现外部对象时不级联删除，报告遗留目标', async t => {
    const f = await fixture(t, 'full');
    const id = await create(f);
    const invoke = async (name, args) => {
        const response = await f.call(name, args);
        if (name === 'apipost_create_folder' && !response.isError) {
            const folder = JSON.parse(response.content[0].text).target_id;
            f.documents.set('foreign', { target_id: 'foreign', target_type: 'api', parent_id: folder, name: '外部对象', url: '/foreign', method: 'GET', status: 1 });
        }
        return response;
    };
    const result = await runBenchmark(invoke, [id]);
    assert.equal(result.success, false);
    assert.equal(result.cleanupComplete, false);
    assert.ok(result.remainingIds.includes('foreign'));
    assert.ok(result.remainingIds.includes(result.folderId));
    assert.equal(f.documents.get('foreign').status, 1);
    assert.notEqual(f.documents.get(result.folderId).status, -1);
});
