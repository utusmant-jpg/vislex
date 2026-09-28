import copy, hashlib, json, unittest
from pathlib import Path
from harness import evaluate
ROOT=Path(__file__).parent
class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.truth=json.loads((ROOT/'synthetic-truth.json').read_text())
        self.runs=json.loads((ROOT/'synthetic-runs.json').read_text())
    def test_missing_competitor_is_not_a_win(self):
        self.assertEqual(evaluate(self.truth,self.runs,'vislex','harvey',100)['comparison']['status'],'not_evaluated')
    def test_synthetic_cannot_support_competitive_claim(self):
        r=evaluate(self.truth,self.runs,'vislex','baseline',100)['comparison']
        self.assertFalse(r['targets_met']); self.assertFalse(r['competitive_claim_eligible'])
    def test_unattributed_fact_does_not_count_for_recall(self):
        r=evaluate(self.truth,self.runs,samples=100)
        self.assertEqual(r['systems']['baseline']['metrics']['recall'],.5)
    def test_failed_run_is_not_dropped(self):
        self.runs['systems'][0]['runs'][0].update(status='failed',assertions=[])
        r=evaluate(self.truth,self.runs,samples=100)
        self.assertEqual(r['systems']['vislex']['metrics']['recall'],.5)
        self.assertEqual(r['systems']['vislex']['failed_runs'],1)
    def test_missing_case_blocks_comparison(self):
        self.runs['systems'][0]['runs'].pop()
        self.assertEqual(evaluate(self.truth,self.runs,'vislex','baseline',100)['comparison']['status'],'incomplete')
    def test_unknown_fact_rejected(self):
        self.runs['systems'][0]['runs'][0]['assertions'][0]['fact_id']='fabricated'
        with self.assertRaises(ValueError): evaluate(self.truth,self.runs)
    def test_invalid_cost_rejected(self):
        self.runs['systems'][0]['runs'][0]['cost_usd']=float('nan')
        with self.assertRaises(ValueError): evaluate(self.truth,self.runs)
    def test_deterministic_cluster_bootstrap(self):
        self.assertEqual(evaluate(self.truth,self.runs,'vislex','baseline',100),evaluate(self.truth,self.runs,'vislex','baseline',100))
    def test_competitive_gate_requires_matching_preregistration_and_repeats(self):
        self.truth['synthetic']=False
        self.truth['split']='held_out'
        self.truth['incidents']=[dict(copy.deepcopy(self.truth['incidents'][0]),id=f'i-{n}') for n in range(30)]
        self.truth['preregistered_targets']={'minimum_incidents':30,'recall_gain':0.15,'precision_margin':0.01,'review_time_reduction':0.4}
        for system in self.runs['systems']:
            template=system['runs'][0]
            system['runs']=[dict(copy.deepcopy(template),incident_id=i['id'],repeat=repeat) for i in self.truth['incidents'] for repeat in (1,2)]
        ids=sorted(i['id'] for i in self.truth['incidents'])
        artifact={'schema_version':1,'dataset':self.truth['name'],'split':'held_out','candidate':'vislex','baseline':'baseline','incident_ids_sha256':hashlib.sha256(json.dumps(ids,separators=(',',':')).encode()).hexdigest(),'targets':self.truth['preregistered_targets']}
        digest=hashlib.sha256(json.dumps(artifact,sort_keys=True).encode()).hexdigest()
        self.truth['preregistration_sha256']=digest
        def eligible(art=artifact, sha=digest):
            return evaluate(self.truth,self.runs,'vislex','baseline',100,preregistration=art,preregistration_sha256=sha)['comparison']['competitive_claim_eligible']
        self.assertFalse(eligible(sha='a'*64))
        self.assertFalse(eligible(art={**artifact,'baseline':'other'}))
        self.assertTrue(eligible())
        self.runs['systems'][1]['runs'].pop()
        self.assertFalse(eligible())
if __name__=='__main__': unittest.main()
