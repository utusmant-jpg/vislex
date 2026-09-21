"""Offline, adjudication-driven incident benchmark. No model judges or network calls."""
import argparse
import hashlib
import json
import math
import random
from pathlib import Path

METRICS = ('precision', 'recall', 'attribution_accuracy', 'unsupported_rate', 'false_contradiction_rate', 'coverage_honesty', 'review_seconds', 'runtime_seconds', 'cost_usd')

def number(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'{field} must be a finite nonnegative number')
    return value

def validate(truth, runs):
    if truth.get('schema_version') != 1 or runs.get('schema_version') != 1:
        raise ValueError('Unsupported schema version')
    incidents = truth['incidents']
    ids = [i['id'] for i in incidents]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError('Incident IDs must be nonempty and unique')
    facts = {}
    for incident in incidents:
        fs = incident['facts']
        if not fs or len({f['id'] for f in fs}) != len(fs):
            raise ValueError('Each incident needs unique material fact IDs')
        facts[incident['id']] = {f['id']: f for f in fs}
    systems = runs['systems']
    if not systems or len({s['id'] for s in systems}) != len(systems):
        raise ValueError('Unique system IDs required')
    for system in systems:
        seen = set()
        if not system.get('configuration'):
            raise ValueError('Record build, model and tool configuration')
        for run in system['runs']:
            key = (run['incident_id'], run['repeat'])
            if key in seen or key[0] not in facts or not isinstance(key[1], int) or key[1] < 1:
                raise ValueError('Unknown incident or duplicate/invalid repeat')
            seen.add(key)
            if run['status'] not in ('complete', 'failed'):
                raise ValueError('Runs must explicitly complete or fail')
            for k in ('runtime_seconds', 'cost_usd', 'review_seconds'):
                number(run[k], k)
            if not isinstance(run['coverage_honest'], bool):
                raise ValueError('Coverage honesty requires adjudication')
            assertions = run['assertions']
            if run['status'] == 'complete' and not run.get('adjudicator'):
                raise ValueError('Complete runs require named independent adjudication')
            if len({a['id'] for a in assertions}) != len(assertions):
                raise ValueError('Duplicate assertion IDs')
            for assertion in assertions:
                for key in ('supported', 'attribution_correct', 'contradiction', 'contradiction_correct'):
                    if not isinstance(assertion[key], bool):
                        raise ValueError('Assertion judgments must be boolean')
                fact = assertion.get('fact_id')
                if fact is not None and fact not in facts[run['incident_id']]:
                    raise ValueError('Unknown matched fact')
                if assertion['supported'] and fact is None:
                    raise ValueError('Supported assertions require a truth fact mapping')
    return facts

def score_run(run, facts):
    assertions = run['assertions']
    supported = [a for a in assertions if a['supported']]
    recovered = {a['fact_id'] for a in supported if a['attribution_correct']}
    contradictions = [a for a in assertions if a['contradiction']]
    # Empty output earns no precision/attribution credit; failure is still included in recall.
    return dict(precision=len(supported)/len(assertions) if assertions else 0.,
                recall=len(recovered)/len(facts),
                attribution_accuracy=sum(a['attribution_correct'] for a in supported)/len(supported) if supported else 0.,
                unsupported_rate=(len(assertions)-len(supported))/len(assertions) if assertions else 0.,
                false_contradiction_rate=sum(not a['contradiction_correct'] for a in contradictions)/len(contradictions) if contradictions else 0.,
                coverage_honesty=float(run['coverage_honest']),
                **{k: run[k] for k in ('runtime_seconds','review_seconds','cost_usd')})

def mean(rows, metric):
    return sum(row[metric] for row in rows)/len(rows)

def percentile(values, p):
    values=sorted(values)
    return values[round((len(values)-1)*p)]

def evaluate(truth, runs, candidate=None, baseline=None, samples=2000, seed=20260920):
    facts=validate(truth,runs)
    by_system={}
    report={'schema_version':1,'dataset':truth.get('name'),'synthetic':truth.get('synthetic',False), 'systems':{},'comparison':{'status':'not_evaluated','reason':'Both actual system submissions are required'},'limitations':['Adjudication is supplied by reviewers, not inferred from text.','Incident-macro metrics; repeats are averaged inside each incident.','Synthetic fixtures test the harness, not competitive quality.','Confidence intervals resample incidents, never individual frames or assertions.']}
    for system in runs['systems']:
        groups={}
        for run in system['runs']:
            groups.setdefault(run['incident_id'],[]).append(score_run(run,facts[run['incident_id']]))
        means={i:{m:mean(rows,m) for m in METRICS} for i,rows in groups.items()}
        by_system[system['id']]=means
        report['systems'][system['id']]={'configuration':system['configuration'],'incidents':len(means),'missing_incidents':sorted(set(facts)-set(means)),'failed_runs':sum(r['status']=='failed' for r in system['runs']),'metrics':{m:mean(list(means.values()),m) for m in METRICS} if means else None}
    if candidate in by_system and baseline in by_system and candidate!=baseline:
        a,b=by_system[candidate],by_system[baseline]
        if set(a)!=set(facts) or set(b)!=set(facts):
            report['comparison']={'status':'incomplete','reason':'Missing incidents prevent a comparative claim'}
        else:
            keys=sorted(facts); rng=random.Random(seed); deltas={m:[] for m in METRICS}; review_reductions=[]
            for _ in range(samples):
                draw=[rng.choice(keys) for _ in keys]
                review_base=sum(b[k]['review_seconds'] for k in draw)
                review_reductions.append(1-sum(a[k]['review_seconds'] for k in draw)/review_base if review_base else 0.)
                for m in METRICS: deltas[m].append(sum(a[k][m]-b[k][m] for k in draw)/len(draw))
            differences={m:{'candidate_minus_baseline':sum(a[k][m]-b[k][m] for k in keys)/len(keys),'ci95':[percentile(deltas[m],.025),percentile(deltas[m],.975)]} for m in METRICS}
            review_b=mean(list(b.values()),'review_seconds');review_a=mean(list(a.values()),'review_seconds')
            goals=truth.get('preregistered_targets',{})
            eligible=not report['synthetic'] and truth.get('split')=='held_out' and bool(truth.get('preregistration_sha256')) and bool(goals) and len(keys)>=max(30,goals.get('minimum_incidents',30)) and all({(r['incident_id'],r['repeat']) for r in system['runs']} == {(r['incident_id'],r['repeat']) for r in next(s for s in runs['systems'] if s['id']==candidate)['runs']} for system in runs['systems'] if system['id'] in (candidate,baseline))
            report['comparison']={'status':'scored','candidate':candidate,'baseline':baseline,'incident_count':len(keys),'bootstrap_samples':samples,'seed':seed,'differences':differences,'review_time_reduction':1-review_a/review_b if review_b else None,'review_time_reduction_ci95':[percentile(review_reductions,.025),percentile(review_reductions,.975)],'competitive_claim_eligible':eligible,'targets_met': eligible and differences['recall']['ci95'][0]>=goals.get('recall_gain',.15) and differences['precision']['ci95'][0]>=-goals.get('precision_margin',.01) and review_b>0 and percentile(review_reductions,.025)>=goals.get('review_time_reduction',.4)}
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('truth',type=Path);p.add_argument('runs',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--candidate');p.add_argument('--baseline');p.add_argument('--samples',type=int,default=2000)
    a=p.parse_args()
    if a.samples<100: p.error('Use at least 100 bootstrap samples')
    report=evaluate(json.loads(a.truth.read_text(encoding='utf-8')),json.loads(a.runs.read_text(encoding='utf-8')),a.candidate,a.baseline,a.samples)
    report['input_sha256']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in (a.truth,a.runs)}
    a.output.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(f'Wrote {a.output}: {report["comparison"]["status"]}')
if __name__=='__main__': main()
