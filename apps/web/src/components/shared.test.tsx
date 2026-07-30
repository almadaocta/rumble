// @vitest-environment jsdom
// Component-level smoke tests for the shared stat-display primitives — these
// complement the pure-logic tests in lib/training.test.ts by verifying the
// component actually renders that logic correctly, not just that the math
// is right in isolation.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BarStat, SegmentedStats } from './shared';

describe('BarStat', () => {
  it('shows the value and unit', () => {
    render(<BarStat value={70} unit="g" label="Protein" color="#92400e" pct={50} />);
    expect(screen.getByText('70')).toBeInTheDocument();
    expect(screen.getByText('g')).toBeInTheDocument();
    expect(screen.getByText('Protein')).toBeInTheDocument();
  });

  it('shows the target as "/ target" when provided', () => {
    render(<BarStat value={70} target={140} unit="g" label="Protein" color="#92400e" pct={50} />);
    expect(screen.getByText('/ 140g')).toBeInTheDocument();
  });

  // Regression test: an unlogged macro used to render "0", which reads as
  // "you ate zero grams of protein today" rather than "not logged yet" — a
  // real bug found and fixed earlier in this project.
  it('renders "—" instead of "0" when noData is set, not scoring emptiness as the worst value', () => {
    render(<BarStat value={0} unit="g" label="Protein" color="#92400e" pct={0} noData />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('SegmentedStats', () => {
  it('renders each item\'s label and value', () => {
    render(
      <SegmentedStats
        items={[
          { value: 53, label: 'CTL', intensity: 0.5 },
          { value: 65, label: 'ATL', intensity: 0.6 },
        ]}
      />,
    );
    expect(screen.getByText('CTL')).toBeInTheDocument();
    expect(screen.getByText('53')).toBeInTheDocument();
    expect(screen.getByText('ATL')).toBeInTheDocument();
    expect(screen.getByText('65')).toBeInTheDocument();
  });

  it('renders "—" for a noData item instead of its numeric value', () => {
    render(
      <SegmentedStats
        items={[{ value: 1180, unit: 'kcal', label: 'Consumed', intensity: 0.4, noData: true }]}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('1180')).not.toBeInTheDocument();
  });
});
