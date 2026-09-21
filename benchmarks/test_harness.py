import copy, json, unittest
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
if __name__=='__main__': unittest.main()
