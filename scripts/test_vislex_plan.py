"""Tests for the plan navigator only, not the application."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('vislex_plan', Path(__file__).with_name('vislex_plan.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PlanTests(unittest.TestCase):
    def setUp(self):
        def task(tid, deps):
            return dict(id=tid, depends_on=deps, title=tid, files=['x'], problem='p', changes=['c'], acceptance=['a'], tests=['t'])
        self.plan = dict(schema=1, tasks=[task('R00', []), task('R01', ['R00'])])
        self.status = dict(schema=1, tasks={i: {'state': 'pending'} for i in ('R00', 'R01')})
    def test_initial_ready(self):
        self.assertEqual([t['id'] for t in module.ready(self.plan, self.status)], ['R00'])
    def test_verified_prerequisite_unlocks(self):
        self.status['tasks']['R00'] = dict(state='verified', commit='example', evidence='actual evidence reference')
        self.assertEqual([t['id'] for t in module.ready(self.plan, self.status)], ['R01'])
    def test_implemented_does_not_unlock(self):
        self.status['tasks']['R00']['state'] = 'implemented'
        self.assertEqual(module.ready(self.plan, self.status), [])
    def test_duplicate_rejected(self):
        self.plan['tasks'].append(copy.deepcopy(self.plan['tasks'][0]))
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_cycle_rejected(self):
        self.plan['tasks'][0]['depends_on'] = ['R01']
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_unknown_dependency_rejected(self):
        self.plan['tasks'][1]['depends_on'] = ['R99']
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_false_verified_rejected(self):
        self.status['tasks']['R00']['state'] = 'verified'
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_blocker_required(self):
        self.status['tasks']['R00']['state'] = 'blocked'
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_status_inventory_mismatch(self):
        self.status['tasks'].pop('R01')
        with self.assertRaises(ValueError): module.validate(self.plan, self.status)
    def test_inputs_not_mutated(self):
        before = copy.deepcopy((self.plan, self.status))
        module.ready(self.plan, self.status)
        self.assertEqual((self.plan, self.status), before)

if __name__ == '__main__':
    unittest.main()
