"""Research arithmetic checks; #17 must test the real domain implementation."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class FixtureContract(unittest.TestCase):
    def test_registered_and_unregistered(self):
        costs = sum((90000, 30000, 15000, 10000))
        self.assertEqual(costs, 145000)
        self.assertEqual(250000 - costs, 105000)
        self.assertEqual(105000 * 100, 250000 * 42)
        self.assertEqual(25000 - (9000 + 1500), 14500)
        self.assertEqual(275000 - 100000, 175000)
        self.assertEqual(99000 - 40000, 59000)
        self.assertEqual(250000 - 100000, 150000)
        self.assertEqual(90000 - 40000, 50000)

    def test_credit_eligibility(self):
        for credit, cost, profit, net in ((0, 146500, 103500, 16000),
                                         (750, 145750, 104250, 15250),
                                         (1500, 145000, 105000, 14500)):
            self.assertEqual(145000 + 1500 - credit, cost)
            self.assertEqual(250000 - cost, profit)
            self.assertEqual(25000 - 9000 - credit, net)

    def test_exact_rational_cash_examples(self):
        # Independent exact integer inequalities verify nearest-cent results.
        for numerator, denominator, expected in ((100000, 11, 9091),
                                                  (40000, 11, 3636),
                                                  (10500 * 1000, 21000, 500)):
            self.assertLessEqual(abs(numerator - expected * denominator) * 2,
                                 denominator)
        self.assertEqual(25000 - 9091, 15909)
        self.assertEqual(9091 - 3636, 5455)

    def test_contract_is_linked_and_rules_are_sourced(self):
        text = (ROOT / 'docs/research/domain-gst-profit.md').read_text()
        for rule in range(1, 11):
            line = next(part for part in text.split('\n- ') if part.startswith(f'**R{rule} —'))
            self.assertIn('[S', line)
        self.assertIn('research/domain-gst-profit.md', (ROOT / 'docs/GST.md').read_text())
        self.assertNotIn('Status: proposed', (ROOT / 'docs/GST.md').read_text())


if __name__ == '__main__':
    unittest.main()
