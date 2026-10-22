import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// 业务样例只在内存流转；输出只包含目标 ID、验收结果和耗时。
export async function runBenchmark(invoke, sourceIds) {
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 100 || new Set(sourceIds).size !== sourceIds.length) {
        throw new Error('须显式提供1～100个唯一来源接口 ID');
    }
    const started = performance.now(), timings = {}, run = `临时同步测速_${randomUUID()}`;
    const result = { run, createdIds: [], cleanupComplete: false, originalsUnchanged: null, timings };
    const step = async (key, fn) => {
        const t = performance.now();
        try { return await fn(); } finally { timings[key] = +(performance.now() - t).toFixed(1); }
    };
    const call = async (name, args) => {
        const response = await invoke(name, args);
        if (response.isError) throw new Error(`工具 ${name} 未成功`);
        return JSON.parse(response.content.find(c => c.type === 'text').text);
    };
    let source, items = [], folder;
    const fields = params => (params || []).map(p => ({ key: p.key, desc: p.description,
        type: p.field_type, schema: p.schema, required: Number(p.not_null) === 1, example: p.value }));
    try {
        await step('preparationMs', async () => {
            source = await call('apipost_details', { target_ids: sourceIds });
            if (source.missing_ids.length || source.list.length !== sourceIds.length) throw new Error('来源接口不完整');
            items = source.list.map((doc, i) => {
                if (doc.target_type !== 'api' || Number(doc.status) === -1) throw new Error('来源必须为有效接口');
                const p = { key: String(i), action: 'create', name: doc.name, method: doc.method,
                    url: `http://localhost/epm/__apipost_benchmark/${run}/${i}`,
                    description: doc.description || '', responses: JSON.stringify(doc.response.example),
                    query: JSON.stringify(fields(doc.request?.query?.parameter)),
                    restful: JSON.stringify(fields(doc.request?.restful?.parameter)) };
                if (doc.request?.body?.mode === 'json') {
                    p.bodyRaw = doc.request.body.raw;
                    p.body = JSON.stringify(fields(doc.request.body.raw_parameter));
                }
                return p;
            });
            const existing = await call('apipost_list', { format: 'json', search: run, show_all: true });
            if (existing.matched_count) throw new Error('临时标识已有匹配对象');
        });
        await step('folderMs', async () => {
            const created = await call('apipost_create_folder', { format: 'json', name: run, parent_id: '0' });
            folder = created.target_id;
            result.folderId = folder;
        });
        await step('batchMs', async () => {
            const batch = await call('apipost_sync_batch', { items: items.map(item => ({ ...item, parent_id: folder })) });
            result.batch = batch;
            result.createdIds = batch.results.filter(r => r.target_id).map(r => r.target_id);
            if (!batch.success) throw new Error('批量新增未全部通过验收');
        });
    } catch { result.error = '临时新增或验收未完成，详见本批结果'; }
    finally {
        await step('cleanupMs', async () => {
            try {
                // 创建响应丢失时按本次唯一标识恢复目录，不能按模糊名称扩大删除范围。
                if (!folder) {
                    const found = await call('apipost_list', { format: 'json', search: run, target_type: 'folder', show_all: true });
                    const candidates = found.items.filter(d => d.name === run && d.parent_id === '0');
                    if (candidates.length > 1) throw new Error('临时目录定位不唯一');
                    folder = candidates[0]?.target_id;
                    result.folderId = folder;
                }
                if (folder) {
                    const children = await call('apipost_list', { format: 'json', parent_id: folder, show_all: true });
                    const owned = children.items.filter(d => d.target_type === 'api' && items.some(i => i.url === d.url && i.method === d.method && i.name === d.name));
                    result.createdIds = [...new Set([...result.createdIds, ...owned.map(d => d.target_id)])];
                    if (result.createdIds.some(id => sourceIds.includes(id))) throw new Error('清理目标与来源接口冲突');
                    if (owned.length) {
                        const deleted = await call('apipost_delete', { format: 'json', api_ids: owned.map(d => d.target_id) });
                        if (!deleted.verified) throw new Error('临时接口清理未确认');
                    }
                    const remaining = await call('apipost_list', { format: 'json', parent_id: folder, show_all: true });
                    if (remaining.matched_count) {
                        result.remainingIds = [...remaining.items.map(d => d.target_id), folder];
                        throw new Error('目录含未清理对象，不删除目录');
                    }
                    if (sourceIds.includes(folder)) throw new Error('临时目录 ID 与来源冲突');
                    const deleted = await call('apipost_delete', { format: 'json', api_ids: [folder] });
                    if (!deleted.verified) throw new Error('临时目录清理未确认');
                }
                const remaining = await call('apipost_list', { format: 'json', search: run, show_all: true });
                result.remainingIds = remaining.items.map(d => d.target_id);
                result.cleanupComplete = remaining.matched_count === 0;
            } catch {
                result.cleanupError = '清理未确认，请只核对本次目录及登记目标';
                result.remainingIds ??= [...result.createdIds, ...(folder ? [folder] : [])];
            }
        });
        if (source) await step('originalVerificationMs', async () => {
            try {
                const after = await call('apipost_details', { target_ids: sourceIds });
                result.originalsUnchanged = !after.missing_ids.length && sourceIds.every(id => after.fingerprints[id] === source.fingerprints[id]);
            } catch { result.originalsUnchanged = false; }
        });
    }
    timings.totalMs = +(performance.now() - started).toFixed(1);
    result.success = !result.error && result.cleanupComplete && result.originalsUnchanged === true;
    return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ids = process.argv.find(a => a.startsWith('--source-ids='))?.slice('--source-ids='.length).split(',');
    if (!ids?.length || !process.argv.includes('--allow-temporary-write-and-cleanup') || process.env.APIPOST_SECURITY_MODE !== 'full') {
        console.error('需要 --source-ids=id1,id2,...、--allow-temporary-write-and-cleanup 以及仅当前进程 APIPOST_SECURITY_MODE=full');
        process.exitCode = 1;
    } else {
        const started = performance.now(), client = new Client({ name: 'apipost-sync-benchmark', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: process.env });
        try {
            await client.connect(transport);
            const connectMs = +(performance.now() - started).toFixed(1);
            const result = await runBenchmark((name, args) => client.callTool({ name, arguments: args }), ids);
            await client.close();
            console.log(JSON.stringify({ ...result, connectMs, scriptTotalMs: +(performance.now() - started).toFixed(1) }));
            if (!result.success) process.exitCode = 1;
        } catch { console.error('测速运行失败；若已创建对象，检查本次输出的登记目标'); process.exitCode = 1; }
        finally { await client.close(); }
    }
}
