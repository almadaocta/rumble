// @vitest-environment jsdom
// A data-fetching component test — the highest-value kind of frontend
// smoke test, since it exercises loading real (mocked) data through state
// and rendering, not just static props.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NutritionTab } from './NutritionTab';

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NutritionTab', () => {
  it('shows the empty-state message when nothing is logged today', async () => {
    mockFetchOnce({ logged: false, calories: null, carbsG: null, proteinG: null, fatG: null, meals: [] });

    render(<NutritionTab />);

    expect(await screen.findByText('Log your meals via chat to track macros')).toBeInTheDocument();
    expect(screen.queryByText(/Today's meals/)).not.toBeInTheDocument();
  });

  it('shows logged meals collapsed by default, expandable on click', async () => {
    mockFetchOnce({
      logged: true,
      calories: 1180,
      carbsG: 145,
      proteinG: 70,
      fatG: 32,
      meals: [
        {
          id: '1',
          mealType: 'lunch',
          description: '140g rice, chicken breast',
          calories: 1180,
          carbsG: 145,
          proteinG: 70,
          fatG: 32,
          estimated: true,
        },
      ],
    });

    render(<NutritionTab />);

    const toggle = await screen.findByText("Today's meals (1)");
    expect(screen.queryByText('140g rice, chicken breast')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(await screen.findByText('140g rice, chicken breast')).toBeInTheDocument();
    expect(screen.getByText(/estimated/)).toBeInTheDocument();
  });
});
