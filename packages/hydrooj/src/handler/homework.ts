import yaml from 'js-yaml';
import moment from 'moment-timezone';
import { ObjectID } from 'mongodb';
import AdmZip from 'adm-zip';
import { Time } from '@hydrooj/utils/lib/utils';
import {
    ValidationError, HomeworkNotLiveError, ProblemNotFoundError,
    HomeworkNotAttendedError, BadRequestError,
} from '../error';
import {
    PenaltyRules, Tdoc, ProblemDoc, User,
} from '../interface';
import {
    Route, Handler, Types, param, query,
} from '../service/server';
import * as bus from '../service/bus';
import domain from '../model/domain';
import { PERM, PRIV } from '../model/builtin';
import user from '../model/user';
import * as system from '../model/system';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import problem from '../model/problem';
import record from '../model/record';
import storage from '../model/storage';
import * as document from '../model/document';
import paginate from '../lib/paginate';

const validatePenaltyRules = (input: string) => yaml.load(input);
const convertPenaltyRules = validatePenaltyRules;

class HomeworkMainHandler extends Handler {
    async get({ domainId }) {
        const tdocs = await contest.getMulti(domainId, {}, document.TYPE_HOMEWORK).toArray();
        const calendar = [];
        for (const tdoc of tdocs) {
            const cal = { ...tdoc, url: this.url('homework_detail', { tid: tdoc.docId }) };
            if (contest.isExtended(tdoc) || contest.isDone(tdoc)) {
                cal.endAt = tdoc.endAt;
                cal.penaltySince = tdoc.penaltySince;
            } else cal.endAt = tdoc.penaltySince;
            calendar.push(cal);
        }
        const path = [
            ['Hydro', 'homepage'],
            ['homework_main', null],
        ];
        this.response.body = { tdocs, calendar, path };
        this.response.template = 'homework_main.html';
    }
}

class HomeworkDetailHandler extends Handler {
    @param('tid', Types.ObjectID)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, tid: ObjectID, page = 1) {
        const tdoc = await contest.get(domainId, tid, document.TYPE_HOMEWORK);
        const [tsdoc, pdict] = await Promise.all([
            contest.getStatus(domainId, tdoc.docId, this.user._id, document.TYPE_HOMEWORK),
            problem.getList(domainId, tdoc.pids, true),
        ]);
        const psdict = {};
        let rdict = {};
        let attended = false;
        if (tsdoc) {
            attended = tsdoc.attend === 1;
            for (const pdetail of tsdoc.journal || []) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid] = { _id: pdetail.rid };
            }
            if (contest.canShowRecord.call(this, tdoc) && tsdoc.journal) {
                rdict = await record.getList(
                    domainId,
                    tsdoc.journal.map((pdetail) => pdetail.rid),
                    true,
                );
            }
        }
        // discussion
        const [ddocs, dpcount, dcount] = await paginate(
            discussion.getMulti(domainId, { parentType: tdoc.docType, parentId: tdoc.docId }),
            page,
            system.get('pagination.discussion'),
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(tdoc.owner);
        const udict = await user.getList(domainId, uids);
        const path = [
            ['Hydro', 'homepage'],
            ['homework_main', 'homework_main'],
            [tdoc.title, null, null, true],
        ];
        const index = tdoc.pids.map((i) => i.toString());
        for (const key in pdict) {
            const i = (index.indexOf(key) + 10).toString(36).toUpperCase();
            if (i !== '9') pdict[key].pid = i;
        }
        this.response.template = 'homework_detail.html';
        this.response.body = {
            tdoc, tsdoc, attended, udict, pdict, psdict, rdict, ddocs, page, dpcount, dcount, path,
        };
    }

    @param('tid', Types.ObjectID)
    async postAttend(domainId: string, tid: ObjectID) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        const tdoc = await contest.get(domainId, tid, document.TYPE_HOMEWORK);
        if (contest.isDone(tdoc)) throw new HomeworkNotLiveError(tdoc.docId);
        await contest.attend(domainId, tdoc.docId, this.user._id, document.TYPE_HOMEWORK);
        this.back();
    }

    @param('tid', Types.ObjectID)
    async postDelete(domainId: string, tid: ObjectID) {
        const tdoc = await contest.get(domainId, tid, document.TYPE_HOMEWORK);
        if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await contest.del(domainId, tid, document.TYPE_HOMEWORK);
        this.response.redirect = this.url('homework_main');
    }
}

class HomeworkDetailProblemHandler extends Handler {
    tdoc: Tdoc<60>;
    pdoc: ProblemDoc;
    tsdoc: any;
    udoc: User;
    attended: boolean;

    @param('tid', Types.ObjectID)
    @param('pid', Types.String)
    async _prepare(domainId: string, tid: ObjectID, _pid: string) {
        this.tdoc = await contest.get(domainId, tid, document.TYPE_HOMEWORK);
        const pid = this.tdoc.pids[parseInt(_pid, 36) - 10];
        if (!pid) throw new ProblemNotFoundError(domainId, tid, _pid);
        const pdomainId = typeof pid === 'string' ? pid.split(':')[0] : domainId;
        const ppid = typeof pid === 'number' ? pid : +pid.split(':')[1];
        [this.udoc, this.pdoc, this.tsdoc] = await Promise.all([
            user.getById(domainId, this.tdoc.owner),
            problem.get(pdomainId, ppid),
            contest.getStatus(domainId, tid, this.user._id, document.TYPE_HOMEWORK),
        ]);
        this.pdoc.pid = _pid;
        this.attended = this.tsdoc && this.tsdoc.attend === 1;
        this.response.body = {
            tdoc: this.tdoc,
            pdoc: this.pdoc,
            tsdoc: this.tsdoc,
            udoc: this.udoc,
            attended: this.attended,
        };
    }

    @param('tid', Types.ObjectID)
    @param('pid', Types.Name)
    async get(domainId: string, tid: ObjectID, pid: string) {
        if (!contest.isDone(this.tdoc)) {
            if (!this.attended) throw new HomeworkNotAttendedError(tid);
            if (contest.isNotStarted(this.tdoc)) throw new HomeworkNotLiveError(tid);
        }
        this.response.template = 'problem_detail.html';
        this.response.body.page_name = 'homework_detail_problem';
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['homework_main', 'homework_main'],
            [this.tdoc.title, 'homework_detail', { tid }, true],
            [this.pdoc.title, null, null, true],
        ];
        // Navigate to current additional file download
        // e.g. ![img](a.jpg) will navigate to ![img](./pid/file/a.jpg)
        this.response.body.pdoc.content = this.response.body.pdoc.content
            .replace(/\(file:\/\//g, `(./${pid}/file/`);
    }
}

export class HomeworkProblemFileDownloadHandler extends HomeworkDetailProblemHandler {
    @query('type', Types.Range(['additional_file', 'testdata']), true)
    @param('filename', Types.Name)
    @param('noDisposition', Types.Boolean)
    // @ts-ignore
    async get(domainId: string, type = 'additional_file', filename: string, noDisposition = false) {
        if (type === 'testdata' && !this.user.own(this.pdoc)) {
            if (!this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)) this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
        }
        this.response.redirect = await storage.signDownloadLink(
            `problem/${this.pdoc.domainId}/${this.pdoc.docId}/${type}/${filename}`,
            noDisposition ? undefined : filename, false, 'user',
        );
    }
}

class HomeworkDetailProblemSubmitHandler extends HomeworkDetailProblemHandler {
    @param('tid', Types.ObjectID)
    async prepare(domainId: string, tid: ObjectID) {
        if (!this.attended) throw new HomeworkNotAttendedError(tid);
        if (!contest.isOngoing(this.tdoc)) throw new HomeworkNotLiveError(tid);
    }

    @param('tid', Types.ObjectID)
    @param('pid', Types.String)
    async get(domainId: string, tid: ObjectID, _pid: string) {
        const pid = this.tdoc.pids[parseInt(_pid, 36) - 10];
        this.response.body.rdocs = contest.canShowRecord.call(this, this.tdoc)
            ? await record.getUserInProblemMulti(domainId, this.user._id, pid, { type: document.TYPE_HOMEWORK, tid })
                .sort('_id', -1).limit(10).toArray()
            : [];
        this.response.body.path = [
            ['Hydro', 'homepage'],
            ['homework_main', 'homework_main'],
            [this.tdoc.title, 'homework_detail', { tid }, true],
            [this.pdoc.title, 'homework_detail_problem', { tid, pid }, true],
            ['homework_detail_problem_submit', null],
        ];
        this.response.template = 'problem_submit.html';
    }

    @param('tid', Types.ObjectID)
    @param('pid', Types.String)
    @param('code', Types.Content)
    @param('lang', Types.Name)
    @param('pretest', Types.Boolean)
    @param('input', Types.String, true)
    async post(domainId: string, tid: ObjectID, _pid: string, code: string, lang: string, pretest = false, input = '') {
        const pid = this.tdoc.pids[parseInt(_pid, 36) - 10];
        if (this.response.body.pdoc.config?.langs && !this.response.body.pdoc.config.langs.includes(lang)) {
            throw new BadRequestError('Language not allowed.');
        }
        await this.limitRate('add_record', 60, 5);
        const rid = await record.add(domainId, pid, this.user._id, lang, code, true, pretest ? input : {
            type: document.TYPE_HOMEWORK,
            tid,
        });
        const pdomainId = typeof pid === 'string' ? pid.split(':')[0] : domainId;
        const ppid = typeof pid === 'number' ? pid : +pid.split(':')[1];
        const rdoc = await record.get(domainId, rid);
        if (pretest) {
            await Promise.all([
                problem.inc(pdomainId, ppid, 'nSubmit', 1),
                domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
                contest.updateStatus(domainId, tid, this.user._id,
                    rid, pid, false, 0, document.TYPE_HOMEWORK),
            ]);
        }
        bus.boardcast('record/change', rdoc);
        this.response.body.tid = tid;
        this.response.body.rid = rid;
        if (pretest || contest.canShowRecord.call(this, this.tdoc)) this.response.redirect = this.url('record_detail', { rid });
        else this.response.redirect = this.url('homework_detail', { tid });
    }
}

class HomeworkEditHandler extends Handler {
    @param('tid', Types.ObjectID, true)
    async get(domainId: string, tid: ObjectID) {
        const tdoc = tid
            ? await contest.get(domainId, tid, document.TYPE_HOMEWORK)
            : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const extensionDays = tid
            ? Math.round(
                (tdoc.endAt.getTime() - tdoc.penaltySince.getTime()) / (Time.day / 100),
            ) / 100
            : 1;
        const path = [
            ['Hydro', 'homepage'],
            ['homework_main', 'homework_main'],
            ...tid
                ? [
                    [tdoc.title, 'homework_detail', { tid }, true],
                    ['homework_edit', null],
                ]
                : [['homework_create', null]],
        ];
        const beginAt = tid
            ? moment(tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        const penaltySince = tid
            ? moment(tdoc.penaltySince).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        this.response.template = 'homework_edit.html';
        this.response.body = {
            tdoc,
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('hh:mm'),
            datePenaltyText: penaltySince.format('YYYY-M-D'),
            timePenaltyText: penaltySince.format('hh:mm'),
            extensionDays,
            penaltyRules: tid ? yaml.dump(tdoc.penaltyRules) : null,
            pids: tid ? tdoc.pids.join(',') : '',
            path,
            page_name: tid ? 'homework_edit' : 'homework_create',
        };
    }

    @param('tid', Types.ObjectID, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('penaltySinceDate', Types.Date)
    @param('penaltySinceTime', Types.Time)
    @param('extensionDays', Types.Float)
    @param('penaltyRules', Types.Content, validatePenaltyRules, convertPenaltyRules)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    async post(
        domainId: string, tid: ObjectID, beginAtDate: string, beginAtTime: string,
        penaltySinceDate: string, penaltySinceTime: string, extensionDays: number,
        penaltyRules: PenaltyRules, title: string, content: string, _pids: string, rated = false,
    ) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => {
            i = i.trim();
            if ((+i).toString() === i) return +i;
            return i;
        }).filter((i) => i);
        const tdoc = tid
            ? await contest.get(domainId, tid, document.TYPE_HOMEWORK)
            : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const penaltySince = moment.tz(`${penaltySinceDate} ${penaltySinceTime}`, this.user.timeZone);
        if (!penaltySince.isValid()) throw new ValidationError('endAtDate', 'endAtTime');
        const endAt = penaltySince.clone().add(extensionDays, 'days');
        if (beginAt.isSameOrAfter(penaltySince)) throw new ValidationError('endAtDate', 'endAtTime');
        if (penaltySince.isAfter(endAt)) throw new ValidationError('extensionDays');
        await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), true);
        if (!tid) {
            tid = await contest.add(domainId, title, content, this.user._id,
                'homework', beginAt.toDate(), endAt.toDate(), pids, rated,
                { penaltySince: penaltySince.toDate(), penaltyRules }, document.TYPE_HOMEWORK);
        } else {
            await contest.edit(domainId, tid, {
                title, content, beginAt: beginAt.toDate(), endAt: endAt.toDate(), pids, penaltySince: penaltySince.toDate(), penaltyRules, rated,
            }, document.TYPE_HOMEWORK);
            if (tdoc.beginAt !== beginAt.toDate()
                || tdoc.endAt !== endAt.toDate()
                || tdoc.penaltySince !== penaltySince.toDate()
                || tdoc.pids.sort().join(' ') !== pids.sort().join(' ')) {
                await contest.recalcStatus(domainId, tdoc.docId, document.TYPE_HOMEWORK);
            }
        }
        this.response.body = { tid };
        this.response.redirect = this.url('homework_detail', { tid });
    }
}

class HomeworkScoreboardHandler extends Handler {
    @param('tid', Types.ObjectID)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, tid: ObjectID, page = 1) {
        const [tdoc, rows, udict, , nPages] = await contest.getScoreboard.call(
            this, domainId, tid, false,
            page, document.TYPE_HOMEWORK,
        );
        const path = [
            ['Hydro', 'homepage'],
            ['homework_main', 'homework_main'],
            [tdoc.title, 'homework_detail', { tid }, true],
            ['homework_scoreboard', null],
        ];
        this.response.template = 'contest_scoreboard.html';
        this.response.body = {
            tdoc, rows, path, udict, page, nPages, page_name: 'homework_scoreboard',
        };
    }
}

class HomeworkScoreboardDownloadHandler extends Handler {
    @param('tid', Types.ObjectID)
    @param('ext', Types.Name)
    async get(domainId: string, tid: ObjectID, ext: string) {
        await this.limitRate('scoreboard_download', 120, 3);
        const getContent = {
            csv: (rows) => `\uFEFF${rows.map((c) => (c.map((i) => i.value).join(','))).join('\n')}`,
            html: (rows) => this.renderHTML('contest_scoreboard_download_html.html', { rows }),
        };
        if (!getContent[ext]) throw new ValidationError('ext');
        const [tdoc, rows] = await contest.getScoreboard.call(this, domainId, tid, true, 0, document.TYPE_HOMEWORK);
        this.binary(await getContent[ext](rows), `${tdoc.title}.${ext}`);
    }
}

class HomeworkCodeHandler extends Handler {
    @param('tid', Types.ObjectID)
    async get(domainId: string, tid: ObjectID) {
        if (!this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE)) this.checkPerm(PERM.PERM_READ_RECORD_CODE);
        await this.limitRate('homework_code', 3600, 60);
        const [tdoc, tsdocs] = await contest.getAndListStatus(
            domainId, tid, document.TYPE_HOMEWORK,
        );
        const rnames = {};
        for (const tsdoc of tsdocs) {
            for (const pid in tsdoc.detail || {}) {
                rnames[tsdoc.detail[pid].rid] = `U${tsdoc.uid}_P${pid}_R${tsdoc.detail[pid].rid}`;
            }
        }
        const zip = new AdmZip();
        const rdocs = await record.getMulti(domainId, {
            _id: { $in: Array.from(Object.keys(rnames)).map((id) => new ObjectID(id)) },
        }).toArray();
        for (const rdoc of rdocs) {
            zip.addFile(`${rnames[rdoc._id.toHexString()]}.${rdoc.lang}`, Buffer.from(rdoc.code));
        }
        this.binary(zip.toBuffer(), `${tdoc.title}.zip`);
    }
}

export async function apply() {
    Route('homework_main', '/homework', HomeworkMainHandler, PERM.PERM_VIEW_HOMEWORK);
    Route('homework_create', '/homework/create', HomeworkEditHandler);
    Route('homework_detail', '/homework/:tid', HomeworkDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    Route('homework_scoreboard', '/homework/:tid/scoreboard', HomeworkScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    Route(
        'homework_scoreboard_download', '/homework/:tid/scoreboard/download/:ext',
        HomeworkScoreboardDownloadHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD,
    );
    Route('homework_detail_problem', '/homework/:tid/p/:pid', HomeworkDetailProblemHandler, PERM.PERM_VIEW_HOMEWORK);
    Route(
        'homework_detail_problem_file_download', '/homework/:tid/p/:pid/file/:filename',
        HomeworkProblemFileDownloadHandler, PERM.PERM_VIEW_PROBLEM,
    );
    Route('homework_detail_problem_submit', '/homework/:tid/p/:pid/submit', HomeworkDetailProblemSubmitHandler, PERM.PERM_SUBMIT_PROBLEM);
    Route('homework_code', '/homework/:tid/code', HomeworkCodeHandler, PERM.PERM_VIEW_HOMEWORK);
    Route('homework_edit', '/homework/:tid/edit', HomeworkEditHandler);
}

global.Hydro.handler.homework = apply;
