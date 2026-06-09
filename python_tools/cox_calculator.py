#!/usr/bin/env python3
"""
COx Calculator and Patient Simulator
Reference Paper:
  Ameloot et al., "An observational near-infrared spectroscopy study on cerebral 
  autoregulation in post-cardiac arrest patients: Time to drop 'one-size-fits-all' 
  hemodynamic targets?" (Resuscitation, 2015)
"""

import os
import argparse
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

def calculate_cox(map_data, scto2_data, sampling_interval_s=2):
    """
    Calculates the Cerebral Oxymetry Index (COx) from MAP and SctO2 data.
    
    Parameters:
      map_data (array-like): Time series of Mean Arterial Pressure (mmHg).
      scto2_data (array-like): Time series of Cerebral Tissue Oxygen Saturation (%).
      sampling_interval_s (int): Sampling interval in seconds (default: 2s).
      
    Returns:
      pd.DataFrame: A DataFrame with the 10-second averages, rolling COx, and bins.
    """
    # 1. Create initial DataFrame
    df = pd.DataFrame({
        'MAP': map_data,
        'SctO2': scto2_data
    })
    
    # 2. Downsample to 10-second averages
    # Since sampling is every 2 seconds, a 10-second window has 5 samples.
    samples_per_10s = int(10 / sampling_interval_s)
    if samples_per_10s < 1:
        samples_per_10s = 1
        
    df_10s = df.groupby(df.index // samples_per_10s).mean()
    df_10s['Time_s'] = df_10s.index * 10
    df_10s['Time_hr'] = df_10s['Time_s'] / 3600.0
    
    # 3. Calculate rolling COx over moving 5-minute windows
    # A 5-minute window has 300 seconds. With 10s samples, this is a window of 30 samples.
    window_size = 30
    df_10s['COx'] = df_10s['SctO2'].rolling(window=window_size, min_periods=window_size).corr(df_10s['MAP'])
    df_10s['MAP_mean_5min'] = df_10s['MAP'].rolling(window=window_size, min_periods=window_size).mean()
    
    return df_10s

def find_optimal_map(df_10s):
    """
    Identifies the optimal MAP by binning COx values into 5 mmHg MAP bins.
    Excludes bins containing less than 1% of the total recording period.
    
    Parameters:
      df_10s (pd.DataFrame): DataFrame containing 'MAP' and 'COx'.
      
    Returns:
      dict: Summary of the binning and the optimal MAP.
    """
    # Exclude rows where COx is NaN (first 5 minutes of recording)
    valid_data = df_10s.dropna(subset=['COx']).copy()
    total_epochs = len(valid_data)
    
    if total_epochs == 0:
        return {"optimal_bin": None, "optimal_map": None, "bin_summary": pd.DataFrame()}
        
    # Define 5 mmHg bins from 50 to 130 mmHg
    bin_edges = np.arange(50, 131, 5)
    bin_labels = [f"{bin_edges[i]}-{bin_edges[i+1]}" for i in range(len(bin_edges)-1)]
    
    # Bin the data using the MAP values (5-minute rolling average MAP is preferred if available)
    map_col = 'MAP_mean_5min' if 'MAP_mean_5min' in valid_data.columns else 'MAP'
    valid_data['MAP_bin'] = pd.cut(valid_data[map_col], bins=bin_edges, labels=bin_labels, right=False)
    
    # Group by bin and calculate average COx and percentage of data
    grouped = valid_data.groupby('MAP_bin', observed=False).agg(
        avg_COx=('COx', 'mean'),
        count=('COx', 'count')
    ).reset_index()
    
    grouped['percentage'] = (grouped['count'] / total_epochs) * 100
    
    # Filter out bins with less than 1% of data
    filtered_grouped = grouped[grouped['percentage'] >= 1.0].copy()
    
    if filtered_grouped.empty:
        # Fallback to no filter if all bins are small
        filtered_grouped = grouped[grouped['count'] > 0].copy()
        
    if filtered_grouped.empty:
        return {"optimal_bin": None, "optimal_map": None, "bin_summary": grouped}
        
    # Find the bin with the most negative average COx value
    best_row = filtered_grouped.loc[filtered_grouped['avg_COx'].idxmin()]
    optimal_bin_str = best_row['MAP_bin']
    
    # Extract numeric bounds from the label string
    low_bound, high_bound = map(float, optimal_bin_str.split('-'))
    optimal_map_val = (low_bound + high_bound) / 2.0
    
    return {
        "optimal_bin": optimal_bin_str,
        "optimal_map": optimal_map_val,
        "bin_summary": grouped,
        "filtered_summary": filtered_grouped
    }

def simulate_patient_data(phenotype='preserved', duration_hours=24, sampling_interval_s=2):
    """
    Simulates realistic 24-hour physiological data for MAP and SctO2.
    
    Phenotypes:
      - 'preserved': Autoregulation is active above LLA = 55 mmHg.
      - 'disturbed': Autoregulation is shifted right / impaired; SctO2 is linear with MAP below 95 mmHg.
    """
    total_samples = int(duration_hours * 3600 / sampling_interval_s)
    
    # 1. Generate realistic MAP profile (fluctuates over 24h)
    # Using a random walk with mean-reversion (Ornstein-Uhlenbeck-like process)
    np.random.seed(42 if phenotype == 'preserved' else 100)
    
    if phenotype == 'preserved':
        base_map = 75.0
        noise_std = 8.0
        drift_rate = 0.005
    else:
        # Disturbed patients often have higher MAP variability or need higher pressure support
        base_map = 80.0
        noise_std = 12.0
        drift_rate = 0.005
        
    map_signal = np.zeros(total_samples)
    current_map = base_map
    for i in range(total_samples):
        # random walk with attraction to base_map
        current_map += drift_rate * (base_map - current_map) + np.random.normal(0, 0.4)
        map_signal[i] = current_map
        
    # Add some cyclic fluctuations (e.g. nurse adjustments, circadian rhythm)
    time_h = np.linspace(0, duration_hours, total_samples)
    map_signal += 8.0 * np.sin(2 * np.pi * time_h / 6.0) # 6h cycles
    map_signal += 5.0 * np.sin(2 * np.pi * time_h / 24.0) # 24h circadian cycle
    map_signal = np.clip(map_signal, 45, 125) # clip to realistic ranges
    
    # 2. Generate SctO2 based on MAP and phenotype
    scto2_signal = np.zeros(total_samples)
    
    if phenotype == 'preserved':
        # Lower limit of autoregulation (LLA) is at 55 mmHg
        # Above LLA, SctO2 is stable around 68%
        # Below LLA, SctO2 drops linearly with pressure
        lla = 55.0
        for i in range(total_samples):
            map_val = map_signal[i]
            if map_val >= lla:
                # Active autoregulation: SctO2 is stable, minor random noise
                # Let's add a tiny negative slope (vasoconstriction/autoregulatory fine-tuning)
                scto2_val = 68.0 - 0.015 * (map_val - lla) + np.random.normal(0, 1.5)
            else:
                # Failed autoregulation (below LLA): SctO2 falls with pressure
                scto2_val = 68.0 - 0.8 * (lla - map_val) + np.random.normal(0, 1.5)
            scto2_signal[i] = scto2_val
            
    else: # disturbed / right-shifted
        # LLA is shifted right to 95 mmHg
        # Below 95 mmHg, SctO2 is strongly dependent on MAP
        lla = 95.0
        for i in range(total_samples):
            map_val = map_signal[i]
            if map_val >= lla:
                # Stabilizes above 95 mmHg
                scto2_val = 77.0 - 0.02 * (map_val - lla) + np.random.normal(0, 1.5)
            else:
                # High linear dependency below 95 mmHg
                scto2_val = 77.0 - 0.45 * (lla - map_val) + np.random.normal(0, 1.5)
            scto2_signal[i] = scto2_val
            
    # Add high-frequency noise and capillary pulsations to SctO2
    scto2_signal = np.clip(scto2_signal, 35, 95)
    
    return map_signal, scto2_signal

def generate_patient_plots(df_10s, optimal_results, phenotype, output_path):
    """
    Generates a three-panel plot matching Figure 1 of the Ameloot 2015 paper.
    """
    optimal_map = optimal_results['optimal_map']
    optimal_bin = optimal_results['optimal_bin']
    bin_summary = optimal_results['bin_summary']
    
    # Configure custom styling for a premium aesthetic
    plt.rcParams['font.family'] = 'sans-serif'
    plt.rcParams['font.sans-serif'] = ['DejaVu Sans', 'Arial', 'Helvetica']
    
    fig, axes = plt.subplots(3, 1, figsize=(10, 14), gridspec_kw={'height_ratios': [1.2, 1, 1.2]})
    
    title_suffix = "Preserved Autoregulation" if phenotype == 'preserved' else "Disturbed Autoregulation"
    fig.suptitle(f"Cerebral Autoregulation Analysis: Patient Phenotype - {title_suffix}", 
                 fontsize=16, fontweight='bold', color='#1a1a1a', y=0.98)
    
    # ------------------ PANEL A: SctO2 vs MAP Scatter Plot ------------------
    ax = axes[0]
    ax.scatter(df_10s['MAP'], df_10s['SctO2'], color='#95a5a6', alpha=0.3, s=4, label='10s Epochs')
    
    # Calculate average SctO2 per mmHg MAP for a cleaner curve representation (just like paper's scatter plot)
    avg_scto2_per_map = df_10s.groupby(df_10s['MAP'].round()).mean(numeric_only=True)
    ax.plot(avg_scto2_per_map.index, avg_scto2_per_map['SctO2'], color='#2c3e50', linewidth=2.5, label='Mean SctO2 per mmHg MAP')
    
    # Fit linear regression over the entire range to show R^2 and equation
    valid = df_10s.dropna(subset=['MAP', 'SctO2'])
    slope, intercept = np.polyfit(valid['MAP'], valid['SctO2'], 1)
    r_val = np.corrcoef(valid['MAP'], valid['SctO2'])[0, 1]
    r_squared = r_val ** 2
    
    x_range = np.linspace(df_10s['MAP'].min(), df_10s['MAP'].max(), 100)
    y_fit = slope * x_range + intercept
    ax.plot(x_range, y_fit, color='#e74c3c', linestyle='--', linewidth=1.5, label=f'Linear Fit (R² = {r_squared:.4f})')
    
    # Display formula
    ax.text(0.7, 0.15, f"y = {slope:.4f}x + {intercept:.3f}\nR² = {r_squared:.4f}", 
            transform=ax.transAxes, fontsize=11, color='#2c3e50',
            bbox=dict(facecolor='white', alpha=0.8, edgecolor='#bdc3c7', boxstyle='round,pad=0.5'))
    
    ax.set_title("A: Cerebral Saturation (SctO2) vs Mean Arterial Pressure (MAP)", fontsize=12, fontweight='bold', loc='left')
    ax.set_xlabel("MAP (mmHg)", fontsize=10)
    ax.set_ylabel("SctO2 (%)", fontsize=10)
    ax.set_xlim(45, 125)
    ax.set_ylim(35, 95)
    ax.grid(True, linestyle=':', alpha=0.6)
    ax.legend(loc='upper left', frameon=True, facecolor='white', edgecolor='#bdc3c7')
    
    # ------------------ PANEL B: COx vs MAP Bins ------------------
    ax = axes[1]
    bins = bin_summary['MAP_bin'].astype(str).tolist()
    avg_cox = bin_summary['avg_COx'].tolist()
    percentages = bin_summary['percentage'].tolist()
    
    # Choose bar colors (highlight the optimal MAP bin)
    colors = []
    for b, pct in zip(bins, percentages):
        if b == optimal_bin:
            colors.append('#27ae60') # Bright green for optimal MAP
        elif pct < 1.0:
            colors.append('#d5dbdb') # Light grey for excluded bins (< 1% data)
        else:
            colors.append('#34495e') # Standard slate blue
            
    bars = ax.bar(bins, avg_cox, color=colors, edgecolor='#2c3e50', width=0.6, zorder=3)
    
    # Place a star over the optimal MAP bin
    if optimal_bin in bins:
        opt_idx = bins.index(optimal_bin)
        bar_height = avg_cox[opt_idx]
        star_y = bar_height - 0.05 if bar_height < 0 else bar_height + 0.05
        ax.plot(opt_idx, star_y, marker='*', markersize=14, color='#f1c40f', markeredgecolor='#d35400', zorder=5)
        ax.text(opt_idx, star_y + (0.05 if star_y > 0 else -0.09), "Optimal", 
                ha='center', va='center', fontsize=9, fontweight='bold', color='#27ae60', zorder=5)

    ax.axhline(0, color='black', linewidth=0.8, zorder=2)
    ax.set_title("B: Cerebral Autoregulation Index (COx) per 5 mmHg MAP Bins", fontsize=12, fontweight='bold', loc='left')
    ax.set_xlabel("MAP Bin (mmHg)", fontsize=10)
    ax.set_ylabel("Mean COx", fontsize=10)
    ax.set_ylim(-0.4, 0.4)
    ax.grid(True, axis='y', linestyle=':', alpha=0.6)
    plt.setp(ax.get_xticklabels(), rotation=30, ha='right')
    
    # Add a legend explaining bar colors
    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor='#34495e', edgecolor='#2c3e50', label='Valid Bins (≥1% data)'),
        Patch(facecolor='#27ae60', edgecolor='#2c3e50', label='Optimal MAP Bin'),
        Patch(facecolor='#d5dbdb', edgecolor='#2c3e50', label='Excluded Bins (<1% data)')
    ]
    ax.legend(handles=legend_elements, loc='upper right', frameon=True, facecolor='white', edgecolor='#bdc3c7')
    
    # ------------------ PANEL C: MAP Time Series ------------------
    ax = axes[2]
    ax.plot(df_10s['Time_hr'], df_10s['MAP'], color='#7f8c8d', linewidth=1.5, label='MAP (10s Average)')
    
    # Draw horizontal optimal MAP line
    ax.axhline(optimal_map, color='#27ae60', linestyle='--', linewidth=2.5, label=f'Optimal MAP ({optimal_map:.1f} mmHg)')
    
    # Calculate percentage of time spent UNDER the optimal MAP
    valid_map = df_10s.dropna(subset=['MAP'])
    time_under = (valid_map['MAP'] < optimal_map).sum() / len(valid_map) * 100
    
    # Shading the area under the optimal MAP
    ax.fill_between(df_10s['Time_hr'], df_10s['MAP'], optimal_map, 
                    where=(df_10s['MAP'] < optimal_map), 
                    interpolate=True, color='#e74c3c', alpha=0.15, label='Time under Optimal MAP')
    
    ax.text(0.05, 0.15, f"Time under Optimal MAP: {time_under:.1f}%", 
            transform=ax.transAxes, fontsize=12, fontweight='bold', color='#c0392b',
            bbox=dict(facecolor='white', alpha=0.9, edgecolor='#e74c3c', boxstyle='round,pad=0.5'))
            
    ax.set_title("C: Mean Arterial Pressure (MAP) Timeline & Optimal Target", fontsize=12, fontweight='bold', loc='left')
    ax.set_xlabel("Time (hours)", fontsize=10)
    ax.set_ylabel("MAP (mmHg)", fontsize=10)
    ax.set_xlim(0, 24)
    ax.set_ylim(30, 150)
    ax.grid(True, linestyle=':', alpha=0.6)
    ax.legend(loc='upper right', frameon=True, facecolor='white', edgecolor='#bdc3c7')
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    print(f"Successfully generated plot: {output_path}")
    return time_under

def main():
    parser = argparse.ArgumentParser(description="Calculate Cerebral Oxymetry Index (COx) and optimal MAP.")
    parser.add_argument('--input', type=str, help='Path to custom CSV file containing MAP and SctO2 columns.')
    parser.add_argument('--simulate', choices=['preserved', 'disturbed', 'both'], default='both',
                        help='Simulate patient data with preserved, disturbed, or both autoregulation profiles.')
    parser.add_argument('--output-dir', type=str, default='.', help='Directory to save output files and plots.')
    parser.add_argument('--sampling-rate', type=float, default=2.0, help='Data sampling rate in seconds (default: 2s).')
    
    args = parser.parse_args()
    
    os.makedirs(args.output_dir, exist_ok=True)
    
    if args.input:
        # Process user-provided CSV data
        if not os.path.exists(args.input):
            print(f"Error: Input file {args.input} does not exist.")
            return
            
        print(f"Reading patient data from {args.input}...")
        df_input = pd.read_csv(args.input)
        
        # Verify columns
        required_cols = ['MAP', 'SctO2']
        if not all(col in df_input.columns for col in required_cols):
            print(f"Error: CSV file must contain 'MAP' and 'SctO2' columns. Found columns: {list(df_input.columns)}")
            return
            
        print("Calculating COx and optimal MAP...")
        df_10s = calculate_cox(df_input['MAP'], df_input['SctO2'], sampling_interval_s=args.sampling_rate)
        results = find_optimal_map(df_10s)
        
        print(f"Optimal MAP Bin: {results['optimal_bin']} mmHg (Midpoint: {results['optimal_map']} mmHg)")
        
        # Generate plot
        out_plot_name = os.path.basename(args.input).replace('.csv', '_cox_plot.png')
        out_plot_path = os.path.join(args.output_dir, out_plot_name)
        time_under = generate_patient_plots(df_10s, results, 'custom', out_plot_path)
        print(f"Time spent under optimal MAP: {time_under:.2f}%")
        
        # Save output calculations
        out_csv_path = os.path.join(args.output_dir, os.path.basename(args.input).replace('.csv', '_cox_processed.csv'))
        df_10s.to_csv(out_csv_path, index=False)
        print(f"Processed time-series saved to: {out_csv_path}")
        
    else:
        # Run simulation
        phenotypes_to_run = ['preserved', 'disturbed'] if args.simulate == 'both' else [args.simulate]
        
        for pheno in phenotypes_to_run:
            print(f"\n--- Simulating 24h data for Patient with {pheno.upper()} Autoregulation ---")
            map_data, scto2_data = simulate_patient_data(phenotype=pheno)
            
            # Calculate COx
            df_10s = calculate_cox(map_data, scto2_data, sampling_interval_s=args.sampling_rate)
            results = find_optimal_map(df_10s)
            
            print(f"Results for {pheno.upper()} Autoregulation:")
            print(f"  Calculated Optimal MAP Range: {results['optimal_bin']} mmHg")
            print(f"  Optimal MAP Representative Value: {results['optimal_map']} mmHg")
            
            # Print bin breakdown
            print("\n  MAP Bins Summary Table:")
            summary_df = results['bin_summary']
            print(summary_df[['MAP_bin', 'avg_COx', 'percentage']].to_string(index=False))
            
            # Generate plots
            plot_path = os.path.join(args.output_dir, f"patient_{pheno}_results.png")
            time_under = generate_patient_plots(df_10s, results, pheno, plot_path)
            
            # Save CSV file
            csv_path = os.path.join(args.output_dir, f"patient_{pheno}_raw_data.csv")
            df_raw = pd.DataFrame({'MAP': map_data, 'SctO2': scto2_data})
            df_raw.to_csv(csv_path, index=False)
            
            processed_csv_path = os.path.join(args.output_dir, f"patient_{pheno}_processed.csv")
            df_10s.to_csv(processed_csv_path, index=False)
            print(f"  Raw data saved to: {csv_path}")
            print(f"  Processed time-series saved to: {processed_csv_path}")

if __name__ == "__main__":
    main()
