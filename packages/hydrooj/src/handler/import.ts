/* eslint-disable no-await-in-loop */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import assert from 'assert';
import superagent from 'superagent';
import { filter } from 'lodash';
import { PassThrough } from 'stream';
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import { ValidationError, RemoteOnlineJudgeError } from '../error';
import { Logger } from '../logger';
import type { ContentNode } from '../interface';
import problem, { ProblemDoc } from '../model/problem';
import TaskModel from '../model/task';
import { PERM, PRIV } from '../model/builtin';
import {
    Route, Handler, Types, post,
} from '../service/server';
import { isPid, parsePid } from '../lib/validator';
import download from '../lib/download';
import { buildContent } from '../lib/content';
import { ProblemAdd } from '../lib/ui';

const RE_SYZOJ = /(https?):\/\/([^/]+)\/(problem|p)\/([0-9]+)\/?/i;
const logger = new Logger('import.syzoj');

async function syzojSync(info) {
    const {
        protocol, host, body, pid, domainId, docId,
    } = info;
    const judge = body.judgeInfo;
    const r = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/downloadProblemFiles`)
        .send({
            problemId: +pid,
            type: 'TestData',
            filenameList: body.testData.map((node) => node.filename),
        });
    const urls = {};
    if (r.body.error) return;
    for (const t of r.body.downloadInfo) urls[t.filename] = t.downloadUrl;
    for (const f of body.testData) {
        const p = new PassThrough();
        superagent.get(urls[f.filename]).pipe(p);
        // eslint-disable-next-line no-await-in-loop
        await problem.addTestdata(domainId, docId, f.filename, p);
    }
    if (judge) {
        const config = {
            time: `${judge.timeLimit}ms`,
            memory: `${judge.memoryLimit}m`,
            // TODO other config
        };
        await problem.addTestdata(domainId, docId, 'config.yaml', Buffer.from(yaml.dump(config)));
    }
    const a = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/downloadProblemFiles`)
        .send({
            problemId: +pid,
            type: 'AdditionalFile',
            filenameList: body.additionalFiles.map((node) => node.filename),
        });
    const aurls = {};
    if (a.body.error) return;
    for (const t of a.body.downloadInfo) aurls[t.filename] = t.downloadUrl;
    for (const f of body.additionalFiles) {
        const p = new PassThrough();
        superagent.get(aurls[f.filename]).pipe(p);
        // eslint-disable-next-line no-await-in-loop
        await problem.addAdditionalFile(domainId, docId, f.filename, p);
    }
}
TaskModel.Worker.addHandler('import.syzoj', syzojSync);

class ProblemImportSYZOJHandler extends Handler {
    async get() {
        this.response.template = 'problem_import_syzoj.html';
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['problem_main', 'problem_main'],
                ['problem_import_syzoj', null],
            ],
        };
    }

    async v2(domainId: string, target: string, hidden = false, url: string) {
        const res = await superagent.get(`${url}export`);
        assert(res.status === 200, new RemoteOnlineJudgeError('Cannot connect to target server'));
        assert(res.body.success, new RemoteOnlineJudgeError((res.body.error || {}).message));
        const p = res.body.obj;
        const content: ContentNode[] = [];
        if (p.description) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Problem Description'),
                text: p.description,
            });
        }
        if (p.input_format) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Input Format'),
                text: p.input_format,
            });
        }
        if (p.output_format) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Output Format'),
                text: p.output_format,
            });
        }
        if (p.example) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Sample'),
                text: p.example,
            });
        }
        if (p.hint) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Hint'),
                text: p.hint,
            });
        }
        if (p.limit_and_hint) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Limit And Hint'),
                text: p.limit_and_hint,
            });
        }
        if (p.have_additional_file) {
            content.push({
                type: 'Text',
                subType: 'markdown',
                sectionTitle: this.translate('Additional File'),
                text: `${url}download/additional_file`,
            });
        }
        const c = buildContent(content, 'markdown');
        const docId = await problem.add(
            domainId, target, p.title, c, this.user._id, p.tags || [], hidden,
        );
        const r = download(`${url}testdata/download`);
        const file = path.resolve(os.tmpdir(), 'hydro', `import_${domainId}_${docId}.zip`);
        const w = fs.createWriteStream(file);
        try {
            await new Promise((resolve, reject) => {
                w.on('finish', resolve);
                w.on('error', reject);
                r.pipe(w);
            });
            const zip = new AdmZip(file);
            const entries = zip.getEntries();
            for (const entry of entries) {
                // eslint-disable-next-line no-await-in-loop
                await problem.addTestdata(domainId, docId, entry.entryName, entry.getData());
            }
            const filename = p.file_io_input_name ? p.file_io_input_name.split('.')[0] : null;
            const config = {
                time: `${p.time_limit}ms`,
                memory: `${p.memory_limit}m`,
                filename,
                type: p.type === 'traditional' ? 'default' : p.type,
            };
            await problem.addTestdata(domainId, docId, 'config.yaml', Buffer.from(yaml.dump(config)));
        } finally {
            fs.unlinkSync(file);
        }
        return docId;
    }

    async v3(
        domainId: string, target: string, hidden: boolean,
        protocol: string, host: string, pid: string | number,
        wait = false,
    ) {
        let tagsOfLocale = this.user.viewLang || this.session.viewLang;
        if (tagsOfLocale === 'en') tagsOfLocale = 'en_US';
        else tagsOfLocale = 'zh_CN';
        const result = await superagent.post(`${protocol}://${host === 'loj.ac' ? 'api.loj.ac.cn' : host}/api/problem/getProblem`)
            .send({
                displayId: +pid,
                localizedContentsOfAllLocales: true,
                tagsOfLocale,
                samples: true,
                judgeInfo: true,
                testData: true,
                additionalFiles: true,
            });
        const content = {};
        for (const c of result.body.localizedContentsOfAllLocales) {
            const sections = c.contentSections;
            for (const section of sections) {
                section.subType = 'markdown';
                if (section.type === 'Sample') {
                    section.payload = [
                        result.body.samples[section.sampleId].inputData,
                        result.body.samples[section.sampleId].outputData,
                    ];
                    delete section.sampleId;
                }
            }
            let locale = c.locale;
            if (locale === 'en_US') locale = 'en';
            else if (locale === 'zh_CN') locale = 'zh';
            content[locale] = sections;
        }
        const tags = result.body.tagsOfLocale.map((node) => node.name);
        const title = [
            ...filter(
                result.body.localizedContentsOfAllLocales,
                (node) => node.locale === (this.user.viewLang || this.session.viewLang),
            ),
            ...result.body.localizedContentsOfAllLocales,
        ][0].title;
        const docId = await problem.add(
            domainId, target, title, JSON.stringify(content), this.user._id, tags || [], hidden,
        );
        const payload = {
            protocol, host, pid, domainId, docId, body: result.body,
        };
        if (wait) await syzojSync(payload);
        else await TaskModel.add({ ...payload, type: 'schedule', subType: 'import.syzoj' });
        return docId;
    }

    @post('url', Types.Content, true)
    @post('pid', Types.Name, true, isPid, parsePid)
    @post('hidden', Types.Boolean)
    @post('prefix', Types.Name, true)
    @post('start', Types.UnsignedInt, true)
    @post('end', Types.UnsignedInt, true)
    async post(
        domainId: string, url: string, targetPid: string, hidden = false,
        prefix: string, start: number, end: number,
    ) {
        if (prefix) {
            let version = 2;
            if (!prefix.endsWith('/')) prefix += '/';
            if (prefix.endsWith('/p/')) version = 3;
            else if (!prefix.endsWith('/problem/')) prefix += 'problem/';
            const base = `${prefix}${start}/`;
            assert(base.match(RE_SYZOJ), new ValidationError('prefix'));
            const [, protocol, host] = RE_SYZOJ.exec(base);
            (async () => {
                for (let i = start; i <= end; i++) {
                    // eslint-disable-next-line no-await-in-loop
                    if (version === 3) await this.v3(domainId, undefined, hidden, protocol, host, i, true);
                    // eslint-disable-next-line no-await-in-loop
                    else await this.v2(domainId, undefined, hidden, prefix + i);
                    logger.info('%s %d-%d-%d', prefix, start, i, end);
                }
            })().catch(logger.error);
            this.response.redirect = this.url('problem_main');
        } else {
            assert(url.match(RE_SYZOJ), new ValidationError('url'));
            if (!url.endsWith('/')) url += '/';
            const [, protocol, host, n, pid] = RE_SYZOJ.exec(url);
            const docId = n === 'p'
                ? await this.v3(domainId, targetPid, hidden, protocol, host, pid, false)
                : await this.v2(domainId, targetPid, hidden, url);
            this.response.body = { pid: targetPid || docId };
            this.response.redirect = this.url('problem_detail', { pid: targetPid || docId });
        }
    }
}

class ProblemImportHydroHandler extends Handler {
    async get() {
        this.response.template = 'problem_import.html';
    }

    async post({ domainId, keepUser }) {
        if (keepUser) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        if (!this.request.files.file) throw new ValidationError('file');
        const tmpdir = path.join(os.tmpdir(), 'hydro', `${Math.random()}.import`);
        const zip = new AdmZip(this.request.files.file.path);
        await new Promise((resolve, reject) => {
            zip.extractAllToAsync(tmpdir, true, (err) => {
                if (err) reject(err);
                resolve(null);
            });
        });
        try {
            const problems = await fs.readdir(tmpdir);
            for (const i of problems) {
                const files = await fs.readdir(path.join(tmpdir, i));
                if (!files.includes('problem.yaml')) continue;
                const content = fs.readFileSync(path.join(tmpdir, i, 'problem.yaml'), 'utf-8');
                const pdoc: ProblemDoc = yaml.load(content) as any;
                const current = await problem.get(domainId, pdoc.pid);
                const pid = current ? undefined : pdoc.pid;
                const docId = await problem.add(
                    domainId, pid, pdoc.title, pdoc.content,
                    keepUser ? pdoc.owner : this.user._id, pdoc.tag, pdoc.hidden,
                );
                if (files.includes('testdata')) {
                    const datas = await fs.readdir(path.join(tmpdir, i, 'testdata'), { withFileTypes: true });
                    for (const f of datas) {
                        if (f.isDirectory()) {
                            const sub = await fs.readdir(path.join(tmpdir, i, 'testdata', f.name));
                            for (const s of sub) {
                                const stream = fs.createReadStream(path.join(tmpdir, i, 'testdata', f.name, s));
                                await problem.addTestdata(domainId, docId, `${f.name}/${s}`, stream);
                            }
                        } else if (f.isFile()) {
                            const stream = fs.createReadStream(path.join(tmpdir, i, 'testdata', f.name));
                            await problem.addTestdata(domainId, docId, f.name, stream);
                        }
                    }
                }
                if (files.includes('additional_file')) {
                    const datas = await fs.readdir(path.join(tmpdir, i, 'additional_file'), { withFileTypes: true });
                    for (const f of datas) {
                        if (f.isFile()) {
                            const stream = fs.createReadStream(path.join(tmpdir, i, 'additional_file', f.name));
                            await problem.addAdditionalFile(domainId, docId, f.name, stream);
                        }
                    }
                }
            }
        } finally {
            await fs.remove(tmpdir);
        }
        this.response.redirect = this.url('problem_main');
    }
}

export async function apply() {
    ProblemAdd('problem_import_hydro', {}, 'copy', 'Import From Hydro');
    Route('problem_import_syzoj', '/problem/import/syzoj', ProblemImportSYZOJHandler, PERM.PERM_CREATE_PROBLEM);
    Route('problem_import_hydro', '/problem/import/hydro', ProblemImportHydroHandler, PERM.PERM_CREATE_PROBLEM);
}

global.Hydro.handler.import = apply;
