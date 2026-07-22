import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointItem } from '../EndpointItem';

const mockHandleSelectEndpoint = jest.fn();
const mockHandleOpenKeyDialog = jest.fn();
const mockSetEndpointSearchValue = jest.fn();

let mockSelectedValues: SelectedValues = { endpoint: '', model: '', modelSpec: '' };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
  useIsActiveItem: () => ({ ref: { current: null }, isActive: false }),
}));

let mockEndpointSearchValues: Record<string, string> = {};

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    agentsMap: undefined,
    assistantsMap: undefined,
    modelSpecs: [],
    selectedValues: mockSelectedValues,
    endpointSearchValues: mockEndpointSearchValues,
    handleOpenKeyDialog: mockHandleOpenKeyDialog,
    handleSelectEndpoint: mockHandleSelectEndpoint,
    handleSelectModel: jest.fn(),
    setEndpointSearchValue: mockSetEndpointSearchValue,
    endpointRequiresUserKey: () => false,
    isFavoriteModel: () => false,
    isFavoriteAgent: () => false,
    toggleFavoriteModel: jest.fn(),
    toggleFavoriteAgent: jest.fn(),
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    CustomMenu: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) =>
      React.createElement('div', null, label, children),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLButtonElement>,
    ) {
      return React.createElement('button', { ref, type: 'button', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
  };
});

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

const customEndpoint: Endpoint = {
  value: 'custom',
  label: 'Custom',
  hasModels: false,
  icon: null,
};

describe('EndpointItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    mockEndpointSearchValues = {};
  });

  it('does not render agents as a leaf endpoint when no selectable rows exist', () => {
    render(<EndpointItem endpoint={disabledAgentsEndpoint} endpointIndex={0} />);

    expect(screen.queryByText('My Agents')).not.toBeInTheDocument();
    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
  });

  it('keeps non-agent endpoints without models selectable', () => {
    render(<EndpointItem endpoint={customEndpoint} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(mockHandleSelectEndpoint).toHaveBeenCalledWith(customEndpoint);
  });

  // --- Fix D: windowing (render-cap) for very large model lists ---

  const makeEndpointWithModels = (count: number): Endpoint =>
    ({
      value: 'bigprovider',
      label: 'Big Provider',
      hasModels: true,
      icon: null,
      models: Array.from({ length: count }, (_, i) => ({ name: `model-${i}` })),
    }) as Endpoint;

  it('renders every model and no cap note when the list is under the cap', () => {
    render(<EndpointItem endpoint={makeEndpointWithModels(50)} endpointIndex={0} />);

    expect(screen.getByText('model-0')).toBeInTheDocument();
    expect(screen.getByText('model-49')).toBeInTheDocument();
    expect(screen.queryByTestId('model-list-capped-note')).not.toBeInTheDocument();
  });

  it('caps rendered rows at 100 and shows a search hint when the list exceeds the cap', () => {
    render(<EndpointItem endpoint={makeEndpointWithModels(300)} endpointIndex={0} />);

    // First 100 rendered, the rest omitted from the DOM.
    expect(screen.getByText('model-0')).toBeInTheDocument();
    expect(screen.getByText('model-99')).toBeInTheDocument();
    expect(screen.queryByText('model-100')).not.toBeInTheDocument();
    expect(screen.queryByText('model-299')).not.toBeInTheDocument();

    // The hint tells the user the rest are reachable via search.
    const note = screen.getByTestId('model-list-capped-note');
    expect(note).toHaveTextContent('com_endpoint_models_capped');
    expect(note).toHaveTextContent('300');
  });

  it('applies the cap to search results, not just the unfiltered list', () => {
    // With an active search, filterModels narrows to names containing "model-1";
    // that still exceeds 100 (model-1, model-10..19, model-100..199, ...), so the
    // cap must still apply.
    mockEndpointSearchValues = { bigprovider: 'model-1' };
    render(<EndpointItem endpoint={makeEndpointWithModels(300)} endpointIndex={0} />);

    expect(screen.getByTestId('model-list-capped-note')).toBeInTheDocument();
  });
});
