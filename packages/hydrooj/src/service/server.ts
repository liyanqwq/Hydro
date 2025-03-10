import assert from 'assert';
import { PassThrough } from 'stream';
import { resolve } from 'path';
import os from 'os';
import http from 'http';
import moment from 'moment-timezone';
import {
    isSafeInteger, Dictionary, filter, cloneDeep,
} from 'lodash';
import { ObjectID } from 'mongodb';
import Koa, { Context } from 'koa';
import Body from 'koa-body';
import Compress from 'koa-compress';
import Router from 'koa-router';
import proxy from 'koa-proxies';
import cache from 'koa-static-cache';
import sockjs from 'sockjs';
import cac from 'cac';
import { createHash } from 'crypto';
import * as bus from './bus';
import { errorMessage } from '../utils';
import { User, DomainDoc } from '../interface';
import { Logger } from '../logger';
import {
    UserNotFoundError, BlacklistedError, PermissionError,
    UserFacingError, ValidationError, PrivilegeError,
    CsrfTokenError, InvalidOperationError, MethodNotAllowedError,
    NotFoundError, HydroError, SystemError,
} from '../error';
import { isContent, isName, isTitle } from '../lib/validator';
import avatar from '../lib/avatar';
import user from '../model/user';
import domain from '../model/domain';
import * as system from '../model/system';
import blacklist from '../model/blacklist';
import token from '../model/token';
import * as opcount from '../model/opcount';
import { PERM, PRIV } from '../model/builtin';

const argv = cac().parse();
const logger = new Logger('server');
export const app = new Koa();
export const server = http.createServer(app.callback());
export const router = new Router();

type MethodDecorator = (target: any, name: string, obj: any) => any;
type Converter = (value: any) => any;
type Validator = (value: any) => boolean;
interface ParamOption {
    name: string,
    source: 'all' | 'get' | 'post' | 'route',
    isOptional?: boolean,
    convert?: Converter,
    validate?: Validator,
}

type Type = [Converter, Validator, boolean?];

export interface Types {
    Content: Type,
    Name: Type,
    Title: Type,
    String: Type,
    Int: Type,
    UnsignedInt: Type,
    PositiveInt: Type,
    Float: Type,
    ObjectID: Type,
    Boolean: Type,
    Date: Type,
    Time: Type,
    Range: (range: Array<string | number> | Dictionary<any>) => Type,
    Array: Type,
    NumericArray: Type,
    Set: Type,
}

export const Types: Types = {
    Content: [(v) => v.toString(), isContent],
    Name: [(v) => v.toString(), isName],
    Title: [(v) => v.toString(), isTitle],
    String: [(v) => v.toString(), null],
    Int: [(v) => parseInt(v, 10), (v) => isSafeInteger(parseInt(v, 10))],
    UnsignedInt: [(v) => parseInt(v, 10), (v) => parseInt(v, 10) >= 0],
    PositiveInt: [(v) => parseInt(v, 10), (v) => parseInt(v, 10) > 0],
    Float: [(v) => parseFloat(v), (v) => {
        const t = parseFloat(v);
        return t && !Number.isNaN(t) && Number.isFinite(t);
    }],
    // eslint-disable-next-line no-shadow
    ObjectID: [(v) => new ObjectID(v), ObjectID.isValid],
    Boolean: [(v) => !!v, null, true],
    Date: [
        (v) => {
            const d = v.split('-');
            assert(d.length === 3);
            return `${d[0]}-${d[1].length === 1 ? '0' : ''}${d[1]}-${d[2].length === 1 ? '0' : ''}${d[2]}`;
        },
        (v) => {
            const d = v.split('-');
            assert(d.length === 3);
            const st = `${d[0]}-${d[1].length === 1 ? '0' : ''}${d[1]}-${d[2].length === 1 ? '0' : ''}${d[2]}`;
            return moment(st).isValid();
        },
    ],
    Time: [
        (v) => {
            const t = v.split(':');
            assert(t.length === 2);
            return `${(t[0].length === 1 ? '0' : '') + t[0]}:${t[1].length === 1 ? '0' : ''}${t[1]}`;
        },
        (v) => {
            const t = v.split(':');
            assert(t.length === 2);
            return moment(`2020-01-01 ${(t[0].length === 1 ? '0' : '') + t[0]}:${t[1].length === 1 ? '0' : ''}${t[1]}`).isValid();
        },
    ],
    Range: (range) => [
        (v) => {
            if (range instanceof Array) {
                for (const item of range) {
                    if (typeof item === 'number') {
                        if (item === parseInt(v, 10)) return parseInt(v, 10);
                    } else if (item === v) return v;
                }
            }
            return v;
        },
        (v) => {
            if (range instanceof Array) {
                for (const item of range) {
                    if (typeof item === 'string') {
                        if (item === v) return true;
                    } else if (typeof item === 'number') {
                        if (item === parseInt(v, 10)) return true;
                    }
                }
            } else {
                for (const key in range) {
                    if (key === v) return true;
                }
            }
            return false;
        },
    ],
    Array: [(v) => {
        if (v instanceof Array) return v;
        return v ? [v] : [];
    }, null],
    NumericArray: [(v) => {
        if (v instanceof Array) return v.map(Number);
        return v ? [Number(v)] : [];
    }, (v) => {
        if (v instanceof Array) return !v.map(Number).includes(NaN);
        return !Number.isNaN(+v);
    }],
    Set: [(v) => {
        if (v instanceof Array) return new Set(v);
        return v ? new Set([v]) : new Set();
    }, null],
};

function _buildParam(name: string, source: 'get' | 'post' | 'all' | 'route', ...args: Array<Type | boolean | Validator | Converter>) {
    let cursor = 0;
    const v: ParamOption = { name, source };
    let isValidate = true;
    while (cursor < args.length) {
        const current = args[cursor];
        if (current instanceof Array) {
            const type = current;
            if (type[0]) v.convert = type[0];
            if (type[1]) v.validate = type[1];
            if (type[2]) v.isOptional = type[2];
        } else if (typeof current === 'boolean') v.isOptional = current;
        else if (isValidate) {
            if (current !== null) v.validate = current;
            isValidate = false;
        } else v.convert = current;
        cursor++;
    }
    return v;
}

function _descriptor(v: ParamOption) {
    return function desc(this: Handler, target: any, funcName: string, obj: any) {
        if (!target.__param) target.__param = {};
        if (!target.__param[target.constructor.name]) target.__param[target.constructor.name] = {};
        if (!target.__param[target.constructor.name][funcName]) {
            target.__param[target.constructor.name][funcName] = [{ name: 'domainId', type: 'string', source: 'route' }];
            const originalMethod = obj.value;
            obj.value = function validate(this: Handler, rawArgs: any, ...extra: any[]) {
                if (typeof rawArgs !== 'object' || extra.length) return originalMethod.call(this, rawArgs, ...extra);
                const c = [];
                const arglist: ParamOption[] = this.__param[target.constructor.name][funcName];
                for (const item of arglist) {
                    const src = item.source === 'all'
                        ? rawArgs
                        : item.source === 'get'
                            ? this.request.query
                            : item.source === 'route'
                                ? { ...this.request.params, domainId: this.domainId }
                                : this.request.body;
                    const value = src[item.name];
                    if (!item.isOptional || value) {
                        if (!value) throw new ValidationError(item.name);
                        if (item.validate && !item.validate(value)) throw new ValidationError(item.name);
                        if (item.convert) c.push(item.convert(value));
                        else c.push(value);
                    } else c.push(undefined);
                }
                return originalMethod.call(this, ...c);
            };
        }
        target.__param[target.constructor.name][funcName].splice(1, 0, v);
        return obj;
    };
}

type DescriptorBuilder =
    ((name: string, type: Type) => MethodDecorator)
    & ((name: string, type: Type, validate: null, convert: Converter) => MethodDecorator)
    & ((name: string, type: Type, validate?: Validator, convert?: Converter) => MethodDecorator)
    & ((name: string, type?: Type, isOptional?: boolean, validate?: Validator, convert?: Converter) => MethodDecorator)
    & ((name: string, ...args: Array<Type | boolean | Validator | Converter>) => MethodDecorator);

export const get: DescriptorBuilder = (name, ...args) => _descriptor(_buildParam(name, 'get', ...args));
export const query: DescriptorBuilder = (name, ...args) => _descriptor(_buildParam(name, 'get', ...args));
export const post: DescriptorBuilder = (name, ...args) => _descriptor(_buildParam(name, 'post', ...args));
export const route: DescriptorBuilder = (name, ...args) => _descriptor(_buildParam(name, 'route', ...args));
export const param: DescriptorBuilder = (name, ...args) => _descriptor(_buildParam(name, 'all', ...args));

export function requireCsrfToken(target: any, funcName: string, obj: any) {
    const originalMethod = obj.value;
    obj.value = async function checkCsrfToken(...args: any[]) {
        if (this.getCsrfToken(this.session._id) !== this.args.csrfToken) {
            throw new CsrfTokenError(this.args.csrfToken);
        }
        return await originalMethod.call(this, ...args);
    };
    return obj;
}

export async function prepare() {
    app.keys = system.get('session.keys') as unknown as string[];
    app.use(proxy('/fs', {
        target: system.get('file.endPoint'),
        changeOrigin: true,
        rewrite: (p) => p.replace('/fs', ''),
    }));
    app.use(Compress());
    if (argv.options.public) {
        app.use(cache(argv.options.public, {
            maxAge: 0,
        }));
    } else {
        app.use(cache(resolve(os.tmpdir(), 'hydro', 'public'), {
            maxAge: 30 * 24 * 60 * 60,
        }));
    }
    if (process.env.DEV) {
        app.use(async (ctx: Context, next: Function) => {
            const startTime = new Date().getTime();
            await next();
            const endTime = new Date().getTime();
            if (ctx.nolog || ctx.response.headers.nolog) return;
            ctx._remoteAddress = ctx.request.ip;
            logger.debug(`${ctx.request.method} ${ctx.request.path} ${ctx.response.status} ${endTime - startTime}ms ${ctx.response.length}`);
        });
    }
    app.use(Body({
        multipart: true,
        formidable: {
            maxFileSize: 256 * 1024 * 1024,
        },
    }));
}

export interface UiContextBase {
    cdn_prefix: string;
    url_prefix: string;
}
export const UiContextBase: UiContextBase = {
    cdn_prefix: '/',
    url_prefix: '/',
};

function serializer(k: string, v: any) {
    if (k.startsWith('_') && k !== '_id') return undefined;
    if (typeof v === 'bigint') return `BigInt::${v.toString()}`;
    return v;
}

export class HandlerCommon {
    domainId: string;
    domain: DomainDoc;
    user: User;
    session: Record<string, any>;
    request: Record<string, any>;
    extraTitleContent?: string;

    async limitRate(op: string, periodSecs: number, maxOperations: number) {
        if (this.user && this.user.hasPriv(PRIV.PRIV_UNLIMITED_ACCESS)) return;
        await opcount.inc(op, this.request.ip, periodSecs, maxOperations);
    }

    translate(str: string) {
        if (!str) return '';
        return str.toString().translate(this.user.viewLang, this.session.viewLang, system.get('server.language'));
    }

    renderTitle(str: string) {
        if (this.extraTitleContent) return `${this.translate(str)} - ${this.extraTitleContent} - ${system.get('server.name')}`;
        return `${this.translate(str)} - ${system.get('server.name')}`;
    }

    checkPerm(...args: bigint[]) {
        // @ts-ignore
        if (!this.user.hasPerm(...args)) throw new PermissionError(...args);
    }

    checkPriv(...args: number[]) {
        // @ts-ignore
        if (!this.user.hasPriv(...args)) throw new PrivilegeError(...args);
    }

    async renderHTML(name: string, context: any): Promise<string> {
        const UserContext: any = {
            ...this.user,
            avatar: avatar(this.user.avatar || '', 128),
            perm: this.user.perm.toString(),
            viewLang: this.translate('__id'),
        };
        if (!global.Hydro.lib.template) return JSON.stringify(context, serializer);
        const res = await global.Hydro.lib.template.render(name, {
            handler: this,
            UserContext,
            url: this.url.bind(this),
            _: this.translate.bind(this),
            ...context,
        });
        return res;
    }

    url(name: string, kwargs: any = {}) {
        let res = '#';
        const args: any = {};
        // eslint-disable-next-line @typescript-eslint/no-shadow
        const query: any = {};
        for (const key in kwargs) {
            if (kwargs[key] instanceof ObjectID) args[key] = kwargs[key].toHexString();
            else args[key] = kwargs[key].toString().replace(/\//g, '%2F');
        }
        for (const key in kwargs.query || {}) {
            if (query[key] instanceof ObjectID) query[key] = kwargs.query[key].toHexString();
            else query[key] = kwargs.query[key].toString().replace(/\//g, '%2F');
        }
        try {
            const { anchor } = args;
            if (args.domainId) name += '_with_domainId';
            else if ((!this.request.host || this.domain?.host !== this.request.host) && this.domainId !== 'system') {
                name += '_with_domainId';
                args.domainId = this.domainId;
            }
            res = router.url(name, args, { query });
            if (anchor) return `${res}#${anchor}`;
        } catch (e) {
            logger.warn(e.message);
            logger.info('%s %o', name, args);
            if (!e.message.includes('Expected') || !e.message.includes('to match')) logger.info('%s', e.stack);
        }
        return res;
    }
}

export class Handler extends HandlerCommon {
    UiContext: any;
    args: any;
    ctx: Koa.Context;

    request: {
        method: string,
        host: string,
        hostname: string,
        ip: string,
        headers: any,
        cookies: any,
        body: any,
        files: any,
        query: any,
        path: string,
        params: any,
        referer: string,
        json: boolean,
    };

    response: {
        body: any,
        type: string,
        status: number,
        template?: string,
        redirect?: string,
        disposition?: string,
        attachment: (name: string, stream?: any) => void,
    };

    csrfToken: string;
    loginMethods: any;
    noCheckPermView: boolean;
    __param: Record<string, ParamOption[]>;

    constructor(ctx: Koa.Context) {
        super();
        this.ctx = ctx;
        this.request = {
            method: ctx.request.method.toLowerCase(),
            host: ctx.request.host,
            hostname: ctx.request.hostname,
            ip: ctx.request.ip,
            headers: ctx.request.headers,
            cookies: ctx.cookies,
            body: ctx.request.body,
            files: ctx.request.files,
            query: ctx.query,
            path: ctx.path,
            params: ctx.params,
            referer: ctx.request.headers.referer,
            json: (ctx.request.headers.accept || '').includes('application/json'),
        };
        this.response = {
            body: {},
            type: '',
            status: null,
            template: null,
            redirect: null,
            attachment: (name, streamOrBuffer) => {
                ctx.attachment(name);
                if (streamOrBuffer instanceof Buffer) {
                    this.response.body = null;
                    ctx.body = streamOrBuffer;
                } else {
                    this.response.body = null;
                    ctx.body = streamOrBuffer.pipe(new PassThrough());
                }
            },
            disposition: null,
        };
        this.UiContext = cloneDeep(UiContextBase);
        if (!process.env.DEV) this.UiContext.cdn_prefix = system.get('server.cdn');
        this.session = {};
        const [xff, xhost] = system.getMany(['server.xff', 'server.xhost']);
        if (xff) this.request.ip = this.request.headers[xff.toLowerCase()] || this.request.ip;
        if (xhost) this.request.host = this.request.headers[xhost.toLowerCase()] || this.request.host;
        this.noCheckPermView = false;
    }

    // eslint-disable-next-line class-methods-use-this
    getCsrfToken(id: string) {
        return createHash('md5').update(`csrf_token${id}`).digest('hex');
    }

    async render(name: string, context: any) {
        this.response.body = await this.renderHTML(name, context);
        this.response.type = 'text/html';
    }

    back(body?: any) {
        this.response.body = body || this.response.body || {};
        this.response.redirect = this.request.headers.referer || '/';
    }

    binary(data: any, name: string) {
        this.response.body = data;
        this.response.template = null;
        this.response.type = 'application/octet-stream';
        if (name) this.response.disposition = `attachment; filename="${encodeURIComponent(name)}"`;
    }

    async getSession() {
        const sid = this.request.cookies.get('sid');
        this.session = await token.get(sid, token.TYPE_SESSION);
        if (!this.session) this.session = { uid: 0 };
    }

    async init({ domainId }) {
        if (!argv.options.benchmark) await this.limitRate('global', 10, 88);
        const [absoluteDomain, inferDomain, bdoc] = await Promise.all([
            domain.get(domainId),
            domain.getByHost(this.request.host),
            blacklist.get(`ip::${this.request.ip}`),
            this.getSession(),
        ]);
        if (bdoc) throw new BlacklistedError(this.request.ip);
        if (inferDomain && !this.request.path.startsWith('/d/')) {
            this.domainId = inferDomain._id;
            this.args.domainId = inferDomain._id;
            this.domain = inferDomain;
            domainId = inferDomain._id;
        } else if (absoluteDomain) this.domain = absoluteDomain;
        else {
            this.args.domainId = 'system';
            this.user = await user.getById('system', this.session.uid);
            if (!this.user) this.user = await user.getById('system', 0);
            throw new NotFoundError(domainId);
        }
        this.UiContext.domainId = this.domainId;
        this.user = await user.getById(domainId, this.session.uid, this.session.scope);
        if (!this.user) {
            this.session.uid = 0;
            this.session.scope = PERM.PERM_ALL.toString();
            this.user = await user.getById(domainId, this.session.uid, this.session.scope);
        }
        if (this.user._id === 0 && this.session.viewLang) this.user.viewLang = this.session.viewLang;
        this.user.avatarUrl = avatar(this.user.avatar, 128);
        this.csrfToken = this.getCsrfToken(this.session._id || String.random(32));
        this.UiContext.csrfToken = this.csrfToken;
        this.loginMethods = filter(Object.keys(global.Hydro.lib), (str) => str.startsWith('oauth_'))
            .map((key) => ({
                id: key.split('_')[1],
                icon: global.Hydro.lib[key].icon,
                text: global.Hydro.lib[key].text,
            }));
        if (!this.noCheckPermView && !this.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) this.checkPerm(PERM.PERM_VIEW);
        if (this.request.method === 'post' && this.request.headers.referer) {
            const host = new URL(this.request.headers.referer).host;
            if (host !== this.request.host) throw new CsrfTokenError(host);
        }
    }

    async finish() {
        if (!this.response.body) return;
        try {
            await this.renderBody();
        } catch (err) {
            const error = errorMessage(err);
            this.response.status = error instanceof UserFacingError ? error.code : 500;
            if (this.request.json) this.response.body = { error };
            else {
                try {
                    await this.render(error instanceof UserFacingError ? 'error.html' : 'bsod.html', { error });
                } catch (e) {
                    logger.error(e);
                    // this.response.body.error = {};
                }
            }
        }
        await this.putResponse();
        await this.saveCookie();
    }

    async renderBody() {
        if (this.response.redirect) {
            this.response.body = this.response.body || {};
            this.response.body.url = this.response.redirect;
        }
        if (this.response.type) return;
        if (
            this.request.json || this.response.redirect
            || this.request.query.noTemplate || !this.response.template) {
            try {
                this.response.body = JSON.stringify(this.response.body, serializer);
            } catch (e) {
                this.response.body = new SystemError('Serialize failure', e.message);
            }
            this.response.type = 'application/json';
        } else if (this.response.body || this.response.template) {
            const templateName = this.request.query.template || this.response.template;
            if (templateName) {
                this.response.body = this.response.body || {};
                const s = templateName.split('.');
                if (global.Hydro.ui.template[`${s[0]}.${this.domainId}.${s[1]}`]) {
                    await this.render(`${s[0]}.${this.domainId}.${s[1]}`, this.response.body);
                } else await this.render(templateName, this.response.body);
            }
        }
    }

    async putResponse() {
        if (this.response.disposition) this.ctx.set('Content-Disposition', this.response.disposition);
        if (!this.response.body) return;
        if (this.response.redirect && !this.request.json) {
            this.ctx.response.type = 'application/octet-stream';
            this.ctx.response.status = 302;
            this.ctx.redirect(this.response.redirect);
        } else {
            this.ctx.response.body = this.response.body;
            this.ctx.response.status = this.response.status || 200;
            this.ctx.response.type = this.request.json
                ? 'application/json'
                : this.response.type
                    ? this.response.type
                    : this.ctx.response.type;
        }
    }

    async saveCookie() {
        const expireSeconds = this.session.save
            ? system.get('session.saved_expire_seconds')
            : system.get('session.unsaved_expire_seconds');
        const $update = {
            updateIp: this.request.ip,
            updateUa: this.request.headers['user-agent'] || '',
        };
        const $create = {
            createIp: this.request.ip,
            createUa: this.request.headers['user-agent'] || '',
            createHost: this.request.host,
        };
        if (this.session._id) {
            await token.update(this.session._id, token.TYPE_SESSION, expireSeconds, { ...this.session, ...$update });
        } else {
            [, this.session] = await token.add(token.TYPE_SESSION, expireSeconds, { ...this.session, ...$update, ...$create });
        }
        const cookie = {
            secure: !!system.get('session.secure'),
            httpOnly: false,
        };
        this.ctx.cookies.set('sid', this.session._id, cookie);
    }

    async onerror(error: HydroError) {
        if (!error.msg) error.msg = () => error.message;
        if (error instanceof UserFacingError && !process.env.DEV) error.stack = '';
        if (!(error instanceof NotFoundError)) {
            logger.error(`User: ${this.user._id}(${this.user.uname}) Path: ${this.request.path}`, error.msg(), error.params);
            if (error.stack) logger.error(error.stack);
        }
        this.response.status = error instanceof UserFacingError ? error.code : 500;
        this.response.template = error instanceof UserFacingError ? 'error.html' : 'bsod.html';
        this.response.body = {
            error: { message: error.msg(), params: error.params, stack: errorMessage(error.stack) },
        };
        await this.finish().catch(() => { });
    }
}

async function handle(ctx, HandlerClass, checker) {
    global.Hydro.stat.reqCount++;
    const args = {
        domainId: 'system', ...ctx.params, ...ctx.query, ...ctx.request.body,
    };
    const h = new HandlerClass(ctx);
    h.args = args;
    h.domainId = args.domainId;
    try {
        const method = ctx.method.toLowerCase();
        let operation: string;
        if (method === 'post' && ctx.request.body.operation) {
            operation = `_${ctx.request.body.operation}`
                .replace(/_([a-z])/gm, (s) => s[1].toUpperCase());
        }

        await bus.serial('handler/create', h);

        await h.init(args);
        if (checker) checker.call(h);
        if (method === 'post') {
            if (operation) {
                if (typeof h[`post${operation}`] !== 'function') {
                    throw new InvalidOperationError(operation);
                }
            } else if (typeof h.post !== 'function') {
                throw new MethodNotAllowedError(method);
            }
        } else if (typeof h[method] !== 'function' && typeof h.all !== 'function') {
            throw new MethodNotAllowedError(method);
        }

        await bus.bail('handler/init', h);
        await bus.bail(`handler/before-prepare/${HandlerClass.name.replace(/Handler$/, '')}`, h);
        await bus.bail('handler/before-prepare', h);
        if (h._prepare) await h._prepare(args);
        if (h.prepare) await h.prepare(args);
        await bus.bail(`handler/before/${HandlerClass.name.replace(/Handler$/, '')}`, h);
        await bus.bail('handler/before', h);
        if (h[method]) await h[method](args);
        if (operation) await h[`post${operation}`](args);
        await bus.bail(`handler/after/${HandlerClass.name.replace(/Handler$/, '')}`, h);
        await bus.bail('handler/after', h);
        if (h.cleanup) await h.cleanup(args);
        if (h.finish) await h.finish(args);
        await bus.bail(`handler/finish/${HandlerClass.name.replace(/Handler$/, '')}`, h);
        await bus.bail('handler/finish', h);
    } catch (e) {
        try {
            await h.onerror(e);
        } catch (err) {
            h.response.code = 500;
            h.response.body = `${err.message}\n${err.stack}`;
        }
    }
}

const Checker = (permPrivChecker) => {
    let perm: bigint;
    let priv: number;
    let checker = () => { };
    for (const item of permPrivChecker) {
        if (typeof item === 'object') {
            if (typeof item.call !== 'undefined') {
                checker = item;
            } else if (typeof item[0] === 'number') {
                priv = item;
            } else if (typeof item[0] === 'bigint') {
                perm = item;
            }
        } else if (typeof item === 'number') {
            priv = item;
        } else if (typeof item === 'bigint') {
            perm = item;
        }
    }
    return function check() {
        checker();
        if (perm) this.checkPerm(perm); // lgtm [js/trivial-conditional]
        if (priv) this.checkPriv(priv);
    };
};

export function Route(name: string, path: string, RouteHandler: any, ...permPrivChecker) {
    const checker = Checker(permPrivChecker);
    router.all(name, path, (ctx) => handle(ctx, RouteHandler, checker));
    router.all(`${name}_with_domainId`, `/d/:domainId${path}`, (ctx) => handle(ctx, RouteHandler, checker));
}

export class ConnectionHandler extends HandlerCommon {
    conn: sockjs.Connection;
    args: Record<string, any>;
    request: {
        params: Record<string, any>;
        headers: Record<string, string>;
        ip: string;
    };

    constructor(conn: sockjs.Connection) {
        super();
        this.conn = conn;
        this.request = {
            params: {},
            headers: conn.headers,
            ip: this.conn.remoteAddress,
        };
        this.session = {};
        const p: any = (conn.url.split('?')[1] || '').split('&');
        for (const i in p) p[i] = p[i].split('=');
        for (const i in p) this.request.params[p[i][0]] = decodeURIComponent(p[i][1]);
    }

    send(data: any) {
        this.conn.write(JSON.stringify(data, serializer));
    }

    close(code: number, reason: string) {
        this.conn.close(code.toString(), reason);
    }

    async message(message: any) { } // eslint-disable-line

    onerror(err: HydroError) {
        if (err instanceof UserFacingError) err.stack = this.conn.pathname;
        if (!(err instanceof NotFoundError)) {
            logger.error(`Path:${this.conn.pathname}, User:${this.user._id}(${this.user.uname})`);
            logger.error(err);
        }
        this.send({
            error: {
                name: err.name,
                params: err.params || [],
            },
        });
        this.close(4000, err.toString());
    }

    async getSession(cookieHeader: string) {
        const cookies: any = {};
        const ref = cookieHeader.split(';');
        for (let j = 0; j < ref.length; j++) {
            const cookie = ref[j];
            const parts = cookie.split('=');
            cookies[parts[0].trim()] = (parts[1] || '').trim();
        }
        this.session = await token.get(cookies.sid || '', token.TYPE_SESSION);
        if (!this.session) this.session = { uid: 0, domainId: 'system' };
    }

    @param('cookie', Types.String)
    async init(domainId: string, cookie: string) {
        [this.domain] = await Promise.all([
            domain.get(domainId),
            this.getSession(cookie),
        ]);
        const [bdoc, udoc] = await Promise.all([
            blacklist.get(this.request.ip),
            user.getById(domainId, this.session.uid, this.session.scope),
        ]);
        if (bdoc) throw new BlacklistedError(this.request.ip);
        if (!udoc) throw new UserNotFoundError(this.session.uid);
        this.user = udoc;
        if (this.user._id === 0 && this.session.viewLang) this.user.viewLang = this.session.viewLang;
    }
}

export function Connection(
    name: string, prefix: string,
    RouteConnHandler: any,
    ...permPrivChecker: Array<number | bigint | Function>
) {
    const log = (v: string, fmt: string, ...args: any[]) => logger.debug(fmt, ...args);
    const sock = sockjs.createServer({ prefix, log });
    const checker = Checker(permPrivChecker);
    sock.on('connection', async (conn) => {
        const h: Dictionary<any> = new RouteConnHandler(conn);
        try {
            const args = { domainId: 'system', ...h.request.params };
            h.args = args;
            h.domainId = args.domainId;
            const cookie = await new Promise((r) => {
                conn.once('data', r);
            });
            args.cookie = cookie;
            await h.init(args);
            conn.write(JSON.stringify({ event: 'auth' }));
            checker.call(h);

            if (h._prepare) await h._prepare(args);
            if (h.prepare) await h.prepare(args);
            if (h.message) {
                conn.on('data', (data) => {
                    h.message(JSON.parse(data));
                });
            }
            conn.on('close', async () => {
                if (h.cleanup) await h.cleanup(args);
                if (h.finish) await h.finish(args);
            });
        } catch (e) {
            logger.warn('%o', e);
            await h.onerror(e);
        }
    });
    sock.installHandlers(server);
}

let started = false;

// TODO use postInit?
export function start() {
    if (started) return;
    const port = system.get('server.port');
    app.use(router.routes()).use(router.allowedMethods());
    server.listen(argv.options.port || port);
    logger.success('Server listening at: %d', argv.options.port || port);
    started = true;
}

global.Hydro.service.server = {
    Types,
    app,
    server,
    router,
    UiContextBase,
    get,
    query,
    post,
    route,
    param,
    requireCsrfToken,
    HandlerCommon,
    Handler,
    ConnectionHandler,
    Route,
    Connection,
    prepare,
    start,
};
