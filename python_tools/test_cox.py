import unittest
import numpy as np
import pandas as pd
from cox_calculator import calculate_cox, find_optimal_map

class TestCoxCalculator(unittest.TestCase):
    
    def test_downsampling_shape(self):
        # 100 samples of 2-second data = 200 seconds.
        # Downsampled to 10-second averages = 20 samples.
        map_data = np.random.uniform(60, 90, 100)
        scto2_data = np.random.uniform(50, 75, 100)
        
        df_10s = calculate_cox(map_data, scto2_data, sampling_interval_s=2)
        self.assertEqual(len(df_10s), 20)
        self.assertIn('MAP', df_10s.columns)
        self.assertIn('SctO2', df_10s.columns)
        self.assertIn('COx', df_10s.columns)
        self.assertIn('Time_s', df_10s.columns)
        self.assertIn('Time_hr', df_10s.columns)
        
    def test_rolling_correlation_perfection(self):
        # Generate perfectly correlated data
        # To get rolling COx, we need at least 30 samples of 10s data (150 samples of 2s data)
        n_samples = 200
        map_data = np.linspace(60, 100, n_samples)
        scto2_data = map_data * 0.5 + 20 # Perfectly linear y = 0.5x + 20
        
        df_10s = calculate_cox(map_data, scto2_data, sampling_interval_s=2)
        # Check that once we have enough window data (30th point), the correlation is ~1.0
        valid_cox = df_10s['COx'].dropna()
        self.assertTrue(len(valid_cox) > 0)
        for val in valid_cox:
            self.assertAlmostEqual(val, 1.0, places=5)
            
    def test_optimal_map_finding(self):
        # Build dummy df_10s with known MAP and COx values
        # We need enough data to pass the 1% threshold.
        # Let's create 200 epochs of 10s data (total epochs = 200)
        # Bins: 50-55, 55-60, ..., 120-125
        # Let's distribute MAP between 50 and 80.
        # Bins with data:
        # MAP = 52 (bin 50-55): 50 epochs, avg COx = 0.5
        # MAP = 57 (bin 55-60): 50 epochs, avg COx = -0.3  <-- This should be optimal
        # MAP = 62 (bin 60-65): 50 epochs, avg COx = 0.1
        # MAP = 67 (bin 65-70): 50 epochs, avg COx = 0.2
        
        map_values = [52]*50 + [57]*50 + [62]*50 + [67]*50
        cox_values = [0.5]*50 + [-0.3]*50 + [0.1]*50 + [0.2]*50
        
        df_10s = pd.DataFrame({
            'MAP': map_values,
            'SctO2': [60]*200, # dummy
            'COx': cox_values
        })
        
        results = find_optimal_map(df_10s)
        self.assertEqual(results['optimal_bin'], '55-60')
        self.assertEqual(results['optimal_map'], 57.5) # Midpoint of 55 and 60

if __name__ == '__main__':
    unittest.main()
