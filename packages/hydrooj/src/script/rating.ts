/* eslint-disable no-await-in-loop */
import { unionWith, NumericDictionary } from 'lodash';
import { ObjectID, FilterQuery } from 'mongodb';
import { Tdoc, ProblemDoc, Udoc } from '../interface';
import db from '../service/db';
import domain from '../model/domain';
import * as contest from '../model/contest';
import problem from '../model/problem';
import record from '../model/record';
import { STATUS } from '../model/builtin';
import rating from '../lib/rating';
import paginate from '../lib/paginate';

export const description = 'Calculate rp of a domain, or all domains';

type ND = NumericDictionary<number>;

async function runProblem(pdoc: ProblemDoc, udict: ND): Promise<void>;
async function runProblem(domainId: string, pid: number, udict: ND): Promise<void>;
async function runProblem(...arg: any[]) {
    const pdoc: ProblemDoc = (typeof arg[0] === 'string')
        ? await problem.get(arg[0], arg[1])
        : arg[0];
    const udict: ND = (typeof arg[0] === 'string') ? arg[2] : arg[1];
    const [, nPages] = await paginate(
        problem.getMultiStatus(
            pdoc.domainId, { docId: pdoc.docId, rid: { $ne: null } },
        ),
        1,
        100,
    );
    const nAccept = await problem.getMultiStatus(
        pdoc.domainId, { docId: pdoc.docId, status: STATUS.STATUS_ACCEPTED },
    ).count();
    const p = (pdoc.difficulty || 5) / (Math.sqrt(Math.sqrt(nAccept)) + 1);
    for (let page = 1; page <= nPages; page++) {
        const [psdocs] = await paginate(
            problem.getMultiStatus(
                pdoc.domainId, { docId: pdoc.docId, rid: { $ne: null } },
            ),
            page,
            100,
        ) as any[][];
        const rdict = await record.getList(pdoc.domainId, psdocs.map((psdoc) => psdoc.rid), true);
        for (const psdoc of psdocs) {
            if (rdict[psdoc.rid.toHexString()]) {
                const rp = rdict[psdoc.rid.toHexString()].score * p;
                udict[psdoc.uid] = (udict[psdoc.uid] || 1500) + rp;
            }
        }
    }
}

async function runContest(tdoc: Tdoc<30 | 60>, udict: ND, report: Function): Promise<void>;
async function runContest(
    domainId: string, tid: ObjectID, udict: ND, report: Function
): Promise<void>;
async function runContest(...arg: any[]) {
    const start = new Date().getTime();
    const tdoc: Tdoc<30 | 60> = (typeof arg[0] === 'string')
        ? await contest.get(arg[0], arg[1], -1)
        : arg[0];
    const udict: ND = (typeof arg[0] === 'string') ? arg[2] : arg[1];
    const report = (typeof arg[0] === 'string') ? arg[3] : arg[2];
    const cursor = contest.getMultiStatus(tdoc.domainId, tdoc.docId, tdoc.docType)
        .sort(contest.RULES[tdoc.rule].statusSort);
    if (!await cursor.count()) return;
    const rankedTsdocs = await contest.RULES[tdoc.rule].ranked(tdoc, cursor);
    const users = [];
    for (const result of rankedTsdocs) {
        users.push({ uid: result[1].uid, rank: result[0], old: udict[result[1].uid] || 1500 });
    }
    // FIXME sum(rating.new) always less than sum(rating.old)
    const rated = rating(users);
    for (const udoc of rated) udict[udoc.uid] = udoc.new;
    await report({
        case: {
            status: STATUS.STATUS_ACCEPTED,
            message: `Contest ${tdoc.title} finished`,
            time: new Date().getTime() - start,
            memory: 0,
            score: 0,
        },
    });
}

export async function calcLevel(domainId: string, report: Function) {
    const filter = { rp: { $ne: 1500, $exists: true } };
    const ducnt = await domain.getMultiUserInDomain(domainId, filter).count();
    if (!ducnt) return;
    let last = { rp: null };
    let rank = 0;
    let count = 0;
    const coll = db.collection('domain.user');
    const ducur = domain.getMultiUserInDomain(domainId, filter).project({ rp: 1 }).sort({ rp: -1 });
    let bulk = coll.initializeUnorderedBulkOp();
    while (await ducur.hasNext()) {
        const dudoc = await ducur.next();
        if ([0, 1].includes(dudoc.uid)) continue;
        count++;
        if (!dudoc.rp) dudoc.rp = null;
        if (dudoc.rp !== last.rp) rank = count;
        bulk.find({ _id: dudoc._id }).updateOne({ $set: { rank } });
        last = dudoc;
        if (count % 100 === 0) report({ message: `#${count}: Rank ${rank}` });
    }
    await bulk.execute();
    const levels = global.Hydro.model.builtin.LEVELS;
    bulk = coll.initializeUnorderedBulkOp();
    for (let i = 0; i < levels.length; i++) {
        const query: FilterQuery<Udoc> = {
            domainId,
            $and: [{ rank: { $lte: (levels[i] * count) / 100 } }],
        };
        if (i < levels.length - 1) query.$and.push({ rank: { $gt: (levels[i + 1] * count) / 100 } });
        bulk.find(query).update({ $set: { level: i } });
    }
    await bulk.execute();
}

async function runInDomain(id: string, isSub: boolean, report: Function) {
    const info = await domain.getUnion(id);
    info.union.push(id);
    const udict: ND = {};
    const deltaudict: ND = {};
    const domainId = info ? { $in: info.union } : { $exists: false };
    const dudocs = unionWith([
        ...await domain.getMultiUserInDomain(id).toArray(),
        ...await domain.getMultiUserInDomain('', { domainId }).toArray(),
    ], (a, b) => a.uid === b.uid);
    for (const dudoc of dudocs) deltaudict[dudoc.uid] = dudoc.rpdelta;
    const contests: Tdoc<30 | 60>[] = await contest.getMulti('', { domainId, rated: true })
        .sort('endAt', -1).toArray() as any;
    await report({ message: `Found ${contests.length} contests in ${id}` });
    for (const i in contests) {
        const tdoc = contests[i];
        await runContest(tdoc, udict, report);
        if (!isSub) {
            await report({
                progress: Math.floor(((parseInt(i, 10) + 1) / contests.length) * 100),
            });
        }
    }
    // TODO pagination
    const problems = await problem.getMulti('', { domainId, hidden: false }).toArray();
    await report({ message: `Found ${problems.length} problems in ${id}` });
    for (const i in problems) {
        const pdoc = problems[i];
        await runProblem(pdoc, udict);
        if (!isSub) {
            await report({
                progress: Math.floor(((parseInt(i, 10) + 1) / problems.length) * 100),
            });
        }
    }
    await domain.setMultiUserInDomain(id, {}, { rp: 1500 });
    const tasks = [];
    for (const uid in udict) {
        const rp = udict[uid] + (deltaudict[uid] || 0);
        const update: any = { $set: { rp } };
        if (isSub) update.$push = { ratingHistory: rp };
        tasks.push(domain.updateUserInDomain(id, +uid, update));
    }
    await Promise.all(tasks);
    await calcLevel(id, report);
}

export async function run({ domainId }, report: Function) {
    if (!domainId) {
        const domains = await domain.getMulti().toArray();
        await report({ message: `Found ${domains.length} domains` });
        for (const i in domains) {
            const start = new Date().getTime();
            await runInDomain(domains[i]._id, true, report);
            await report({
                case: {
                    status: STATUS.STATUS_ACCEPTED,
                    message: `Domain ${domains[i]._id} finished`,
                    time: new Date().getTime() - start,
                    memory: 0,
                    score: 0,
                },
                progress: Math.floor(((parseInt(i, 10) + 1) / domains.length) * 100),
            });
        }
    } else await runInDomain(domainId, false, report);
    return true;
}

export const validate = {
    domainId: 'string?',
};

global.Hydro.script.rp = { run, description, validate };
