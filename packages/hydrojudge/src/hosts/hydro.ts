/* eslint-disable no-await-in-loop */
import path from 'path';
import axios from 'axios';
import fs from 'fs-extra';
import WebSocket from 'ws';
import cac from 'cac';
import { noop } from 'lodash';
import { ObjectID } from 'mongodb';
import { LangConfig } from '@hydrooj/utils/lib/lang';
import * as tmpfs from '../tmpfs';
import log from '../log';
import { compilerText, Queue } from '../utils';
import { getConfig } from '../config';
import { FormatError, CompileError, SystemError } from '../error';
import { STATUS_COMPILE_ERROR, STATUS_SYSTEM_ERROR } from '../status';
import readCases from '../cases';
import judge from '../judge';
import * as sysinfo from '../sysinfo';

const argv = cac().parse();

class JudgeTask {
    stat: Record<string, Date>;
    session: any;
    host: string;
    request: any;
    ws: WebSocket;
    tag: any;
    type: any;
    domainId: string;
    pid: string;
    rid: string;
    lang: string;
    code: string;
    tmpdir: string;
    input?: string;
    clean: Function[];
    data: any[];
    folder: string;
    config: any;
    nextId = 1;
    nextWaiting = [];
    getLang: (name: string) => LangConfig;

    constructor(session: Hydro, request, ws: WebSocket) {
        this.stat = {};
        this.stat.receive = new Date();
        this.session = session;
        this.host = session.config.host;
        this.request = request;
        this.ws = ws;
        this.getLang = session.getLang;
    }

    async handle() {
        this.next = this.next.bind(this);
        this.end = this.end.bind(this);
        this.stat.handle = new Date();
        this.tag = this.request.tag;
        this.type = this.request.type;
        this.domainId = this.request.pdomain;
        this.pid = this.request.pid.toString();
        this.rid = this.request.rid;
        this.lang = this.request.lang;
        this.code = this.request.code;
        this.config = this.request.config;
        this.input = this.request.input;
        this.data = this.request.data;
        this.tmpdir = path.resolve(getConfig('tmp_dir'), this.host, this.rid);
        this.clean = [];
        fs.ensureDirSync(this.tmpdir);
        tmpfs.mount(this.tmpdir, '512m');
        log.info('Submission: %s/%s/%s pid=%s', this.host, this.domainId, this.rid, this.pid);
        try {
            if (typeof this.input === 'string') await this.run();
            else await this.doSubmission();
        } catch (e) {
            if (e instanceof CompileError) {
                this.next({ compiler_text: compilerText(e.stdout, e.stderr) });
                this.end({
                    status: STATUS_COMPILE_ERROR, score: 0, time_ms: 0, memory_kb: 0,
                });
            } else if (e instanceof FormatError) {
                this.next({ judge_text: 'Testdata configuration incorrect.' });
                this.next({ judge_text: { message: e.message, params: e.params } });
                this.end({
                    status: STATUS_SYSTEM_ERROR, score: 0, time_ms: 0, memory_kb: 0,
                });
            } else {
                log.error(e);
                this.next({ message: { message: e.message, params: e.params || [], ...argv.options.debug ? { stack: e.stack } : {} } });
                this.end({
                    status: STATUS_SYSTEM_ERROR, score: 0, time_ms: 0, memory_kb: 0,
                });
            }
        }
        for (const clean of this.clean) await clean().catch(noop);
        tmpfs.umount(this.tmpdir);
        fs.removeSync(this.tmpdir);
    }

    async run() {
        this.stat.judge = new Date();
        await judge.run.judge(this);
    }

    async doSubmission() {
        this.stat.cache_start = new Date();
        this.folder = await this.session.cacheOpen(this.domainId, this.pid, this.data, this.next);
        this.stat.read_cases = new Date();
        this.config = await readCases(
            this.folder,
            { ...this.config, detail: this.session.config.detail },
            { next: this.next },
        );
        this.stat.judge = new Date();
        await judge[this.config.type || 'default'].judge(this);
    }

    next(data, id?: number) {
        log.debug('Next: %d %o', id, data);
        data.key = 'next';
        data.rid = new ObjectID(this.rid);
        if (data.time_ms) data.time = data.time_ms;
        if (data.memory_kb) data.memory = data.memory_kb;
        if (data.compiler_text) data.compilerText = data.compiler_text;
        if (data.judge_text) data.message = data.judge_text;
        delete data.time_ms;
        delete data.memory_kb;
        delete data.compiler_text;
        delete data.judge_text;
        if (data.case) {
            data.case = {
                status: data.case.status,
                time: data.case.time_ms || data.case.time,
                memory: data.case.memory_kb || data.case.memory,
                message: data.case.message || data.case.judgeText || data.case.judge_text || '',
            };
        }
        if (id) {
            if (id === this.nextId) {
                this.ws.send(JSON.stringify(data));
                this.nextId++;
                let t = true;
                while (t) {
                    t = false;
                    for (const i in this.nextWaiting) {
                        if (this.nextId === this.nextWaiting[i].id) {
                            this.ws.send(JSON.stringify(this.nextWaiting[i].data));
                            this.nextId++;
                            this.nextWaiting.splice(+i, 1);
                            t = true;
                        }
                    }
                }
            } else this.nextWaiting.push({ data, id });
        } else this.ws.send(JSON.stringify(data));
    }

    end(data) {
        log.info('End: %o', data);
        data.key = 'end';
        data.rid = new ObjectID(this.request.rid);
        data.time = data.time_ms ?? data.time;
        data.memory = data.memory_kb ?? data.memory;
        this.ws.send(JSON.stringify(data));
    }
}

export default class Hydro {
    config: any;
    axios: any;
    ws: WebSocket;
    language: Record<string, LangConfig>;

    constructor(config) {
        this.config = config;
        this.config.detail = this.config.detail ?? true;
        this.config.cookie = this.config.cookie || '';
        this.config.last_update_at = this.config.last_update_at || 0;
        if (!this.config.server_url.startsWith('http')) this.config.server_url = `http://${this.config.server_url}`;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = `${this.config.server_url}/`;
        this.getLang = this.getLang.bind(this);
    }

    async init() {
        await this.setCookie(this.config.cookie || '');
        await this.ensureLogin();
        setInterval(() => { this.axios.get('judge/noop'); }, 30000000);
    }

    async cacheOpen(domainId: string, pid: string, files: any[], next?) {
        const domainDir = path.join(getConfig('cache_dir'), this.config.host, domainId);
        const filePath = path.join(domainDir, pid); await fs.ensureDir(filePath);
        if (!files?.length) throw new SystemError('Problem data not found.');
        let etags: Record<string, string> = {};
        try {
            etags = JSON.parse(fs.readFileSync(path.join(filePath, 'etags')).toString());
        } catch (e) { /* ignore */ }
        const version = {};
        const filenames = [];
        const allFiles = new Set<string>();
        for (const file of files) {
            allFiles.add(file.name);
            version[file.name] = file.etag + file.lastModified;
            if (etags[file.name] !== file.etag + file.lastModified) filenames.push(file.name);
        }
        for (const name in etags) {
            if (!allFiles.has(name) && fs.existsSync(path.join(filePath, name))) await fs.rm(path.join(filePath, name));
        }
        if (filenames.length) {
            log.info(`Getting problem data: ${this.config.host}/${domainId}/${pid}`);
            if (next) next({ judge_text: '正在同步测试数据，请稍后' });
            await this.ensureLogin();
            const res = await this.axios.post(`/d/${domainId}/judge/files`, {
                pid,
                files: filenames,
            });
            for (const name in res.data.links) {
                if (name.includes('/')) await fs.ensureDir(path.join(filePath, name.split('/')[0]));
                const f = await this.axios.get(res.data.links[name], { responseType: 'stream' });
                const w = fs.createWriteStream(path.join(filePath, name));
                f.data.pipe(w);
                await new Promise((resolve, reject) => {
                    w.on('finish', resolve);
                    w.on('error', reject);
                });
            }
            fs.writeFileSync(path.join(filePath, 'etags'), JSON.stringify(version));
            await this.processData(filePath).catch(noop);
        }
        fs.writeFileSync(path.join(filePath, 'lastUsage'), new Date().getTime().toString());
        return filePath;
    }

    getLang(name: string) {
        if (this.language[name]) return this.language[name];
        throw new SystemError('Unsupported language {0}', [name]);
    }

    async consume(queue: Queue<any>) {
        log.info('正在连接 %sjudge/conn', this.config.server_url);
        const res = await this.axios.get('judge/conn/info');
        this.ws = new WebSocket(`${this.config.server_url.replace(/^http/i, 'ws')}judge/conn/websocket?t=${res.data.entropy}`);
        this.ws.on('open', () => {
            this.ws.send(this.config.cookie);
            global.onDestory.push(() => this.ws.close());
            const content = this.config.minPriority !== undefined
                ? `{"key":"prio","prio":${this.config.minPriority}}`
                : '{"key":"ping"}';
            setInterval(() => this.ws.send(content), 30000);
        });
        this.ws.on('message', (data) => {
            const request = JSON.parse(data.toString());
            if (request.language) this.language = request.language;
            if (request.task) queue.push(new JudgeTask(this, request.task, this.ws));
        });
        this.ws.on('close', (data, reason) => {
            log.warn(`[${this.config.host}] Websocket 断开:`, data, reason);
            setTimeout(() => this.retry(queue), 30000);
        });
        this.ws.on('error', (e) => {
            log.error(`[${this.config.host}] Websocket 错误:`, e);
            setTimeout(() => this.retry(queue), 30000);
        });
        await new Promise((resolve) => {
            this.ws.once('open', async () => {
                if (!this.config.noStatus) {
                    const info = await sysinfo.get();
                    this.ws.send(JSON.stringify({ key: 'status', info }));
                    setInterval(async () => {
                        const [mid, inf] = await sysinfo.update();
                        this.ws.send(JSON.stringify({ key: 'status', info: { mid, ...inf } }));
                    }, 1200000);
                }
                resolve(null);
            });
        });
        log.info(`[${this.config.host}] 已连接`);
    }

    async setCookie(cookie: string) {
        this.config.cookie = cookie;
        this.axios = axios.create({
            baseURL: this.config.server_url,
            timeout: 30000,
            headers: {
                accept: 'application/json',
                'Content-Type': 'application/json',
                cookie: this.config.cookie,
            },
        });
    }

    async login() {
        log.info('[%s] Updating session', this.config.host);
        const res = await this.axios.post('login', {
            uname: this.config.uname, password: this.config.password, rememberme: 'on',
        });
        await this.setCookie(res.headers['set-cookie'].join(';'));
    }

    async ensureLogin() {
        try {
            await this.axios.get('judge?check=true');
        } catch (e) {
            await this.login();
        }
    }

    async processData(folder: string) { // eslint-disable-line class-methods-use-this
        let files = await fs.readdir(folder);
        let ini = false;
        if (files.length <= 2) {
            if (files.length === 2) files.splice(files.indexOf('version'), 1);
            const s = fs.statSync(path.resolve(folder, files[0]));
            if (s.isDirectory()) folder = path.resolve(folder, files[0]);
        }
        files = await fs.readdir(folder);
        for (const i of files) {
            if (i.toLowerCase() === 'config.ini') {
                ini = true;
                await fs.rename(`${folder}/${i}`, `${folder}/config.ini`);
                break;
            }
        }
        if (ini) {
            for (const i of files) {
                if (i.toLowerCase() === 'input') await fs.rename(`${folder}/${i}`, `${folder}/input`);
                else if (i.toLowerCase() === 'output') await fs.rename(`${folder}/${i}`, `${folder}/output`);
            }
            files = await fs.readdir(`${folder}/input`);
            for (const i of files) await fs.rename(`${folder}/input/${i}`, `${folder}/input/${i.toLowerCase()}`);
            files = await fs.readdir(`${folder}/output`);
            for (const i of files) await fs.rename(`${folder}/output/${i}`, `${folder}/output/${i.toLowerCase()}`);
        }
    }

    async retry(queue: Queue<any>) {
        this.consume(queue).catch(() => {
            setTimeout(() => this.retry(queue), 30000);
        });
    }
}
