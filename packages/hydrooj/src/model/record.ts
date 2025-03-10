import {
    ObjectID, Collection, UpdateQuery,
    PushOperator, MatchKeysAndValues, OnlyFieldsOfType,
    FilterQuery,
} from 'mongodb';
import { sum } from 'lodash';
import moment from 'moment';
import { STATUS } from './builtin';
import task from './task';
import problem from './problem';
import {
    RecordDoc, ContestInfo, ProblemConfigFile, ExternalProblemId,
} from '../interface';
import { ArgMethod, buildProjection, Time } from '../utils';
import { MaybeArray } from '../typeutils';
import * as bus from '../service/bus';
import db from '../service/db';

class RecordModel {
    static coll: Collection<RecordDoc> = db.collection('record');
    static PROJECTION_LIST: (keyof RecordDoc)[] = [
        '_id', 'score', 'time', 'memory', 'lang',
        'uid', 'pid', 'rejudged', 'hidden', 'progress',
        'contest', 'effective', 'judger', 'judgeAt', 'status',
        'pdomain',
    ];

    static async submissionPriority(uid: number, base: number = 0) {
        const pending = await task.count({ uid });
        const timeRecent = await RecordModel.coll
            .find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, uid }).project({ time: 1 }).toArray();
        return base - ((pending + 0.5) * (sum(timeRecent.map((i) => i.time || 0)) / 10000));
    }

    static async get(_id: ObjectID): Promise<RecordDoc | null>
    static async get(domainId: string, _id: ObjectID): Promise<RecordDoc | null>
    static async get(arg0, arg1?) {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await RecordModel.coll.findOne({ _id });
        if (!res) return null;
        if (res.domainId === (domainId || res.domainId)) return res;
        return null;
    }

    @ArgMethod
    static async stat(domainId?: string) {
        const [d5min, d1h, day, week, month, year, total] = await Promise.all([
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find(domainId ? { domainId } : {}).count(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    static async judge(domainId: string, rid: ObjectID, priority = 0, config: ProblemConfigFile = {}) {
        const rdoc = await RecordModel.get(domainId, rid);
        let data = [];
        if (rdoc.pid) {
            const pdoc = await problem.get(rdoc.pdomain, rdoc.pid);
            data = pdoc.data;
        }
        delete rdoc._id;
        await task.add({
            ...rdoc,
            priority,
            type: 'judge',
            rid,
            domainId,
            config,
            data,
        });
    }

    static async add(
        domainId: string, pid: ExternalProblemId | number, uid: number,
        lang: string, code: string, addTask: boolean, contestOrConfig?: ContestInfo | string,
    ) {
        let pdomain = domainId;
        if (typeof pid === 'string') {
            pdomain = pid.split(':')[0];
            pid = +pid.split(':')[1];
        }
        const data: RecordDoc = {
            status: STATUS.STATUS_WAITING,
            _id: new ObjectID(),
            uid,
            code,
            lang,
            pdomain,
            pid,
            domainId,
            score: 0,
            time: 0,
            memory: 0,
            hidden: false,
            judgeTexts: [],
            compilerTexts: [],
            testCases: [],
            judger: null,
            judgeAt: null,
            rejudged: false,
        };
        let isContest = false;
        if (typeof contestOrConfig === 'string') {
            // is Run
            data.input = contestOrConfig;
            data.hidden = true;
        } else {
            data.contest = contestOrConfig;
            isContest = true;
        }
        const res = await RecordModel.coll.insertOne(data);
        if (addTask) {
            const priority = await RecordModel.submissionPriority(uid, isContest ? 50 : 0);
            await RecordModel.judge(domainId, res.insertedId, priority);
        }
        return res.insertedId;
    }

    static getMulti(domainId: string, query: any) {
        return RecordModel.coll.find({ ...query, domainId });
    }

    static async update(
        domainId: string, _id: MaybeArray<ObjectID>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
    ): Promise<RecordDoc | null> {
        const $update: UpdateQuery<RecordDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        if (_id instanceof Array) {
            await RecordModel.coll.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            const res = await RecordModel.coll.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
            return res.value;
        }
        return await RecordModel.get(domainId, _id);
    }

    static async updateMulti(
        domainId: string, $match: FilterQuery<RecordDoc>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
    ) {
        const $update: UpdateQuery<RecordDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        const res = await RecordModel.coll.updateMany({ domainId, ...$match }, $update);
        return res.modifiedCount;
    }

    static reset(domainId: string, rid: MaybeArray<ObjectID>, isRejudge: boolean) {
        const upd: any = {
            score: 0,
            status: STATUS.STATUS_WAITING,
            time: 0,
            memory: 0,
            testCases: [],
            judgeTexts: [],
            compilerTexts: [],
            judgeAt: null,
            judger: null,
        };
        if (isRejudge) upd.rejudged = true;
        return RecordModel.update(domainId, rid, upd);
    }

    static count(domainId: string, query: any) {
        return RecordModel.coll.find({ domainId, ...query }).count();
    }

    static async getList(
        domainId: string, rids: ObjectID[], showHidden: boolean, fields?: (keyof RecordDoc)[],
    ): Promise<Record<string, Partial<RecordDoc>>> {
        const r = {};
        rids = Array.from(new Set(rids));
        let cursor = RecordModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) {
            if (rdoc.hidden && !showHidden) r[rdoc._id.toHexString()] = null;
            else r[rdoc._id.toHexString()] = rdoc;
        }
        return r;
    }

    @ArgMethod
    static getUserInProblemMulti(domainId: string, uid: number, pid: ExternalProblemId | number, contestInfo?: ContestInfo) {
        let pdomain = domainId;
        if (typeof pid === 'string') {
            pdomain = pid.split(':')[0];
            pid = +pid.split(':')[1];
        }
        if (!contestInfo) {
            return RecordModel.coll.find({
                domainId, uid, pdomain, pid, contest: null,
            });
        }
        return RecordModel.coll.find({
            domainId, uid, pdomain, pid, contest: contestInfo,
        });
    }

    @ArgMethod
    static getByUid(domainId: string, uid: number, limit: number): Promise<RecordDoc[]> {
        return RecordModel.coll.find({ domainId, uid, hidden: false }).sort({ _id: -1 }).limit(limit).toArray();
    }
}

// Mark problem as deleted
bus.on('problem/delete', (domainId, docId) => RecordModel.coll.updateMany({ pdomain: domainId, pid: docId }, { $set: { pid: -1 } }));
bus.on('domain/delete', (domainId) => Promise.all([
    RecordModel.coll.deleteMany({ domainId }),
    RecordModel.coll.updateMany({ pdomain: domainId }, { $set: { docId: -1 } }),
]));

export default RecordModel;
global.Hydro.model.record = RecordModel;
