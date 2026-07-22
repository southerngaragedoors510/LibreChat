import { useMemo } from 'react';
import { VisuallyHidden } from '@ariakit/react';
import { Spinner, TooltipAnchor } from '@librechat/client';
import { CheckCircle2, MousePointerClick, SettingsIcon } from 'lucide-react';
import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { CustomMenu as Menu, CustomMenuItem as MenuItem, CustomMenuSeparator } from '../CustomMenu';
import MarketplaceItem, { marketplaceSearchMatches } from './Marketplace';
import { filterModels, shouldRenderEndpointOption } from '../utils';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { renderEndpointModels } from './EndpointModelItem';
import { ModelSpecItem } from './ModelSpecItem';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface EndpointItemProps {
  endpoint: Endpoint;
  endpointIndex: number;
}

/**
 * Max model rows rendered at once for a single endpoint. Bounds the DOM/observer
 * cost of very large `fetch:true` model lists (e.g. OpenRouter, 300+); the rest
 * remain reachable via the endpoint's search box. Chosen generously so ordinary
 * providers (well under this many models) are never capped.
 */
const MODEL_RENDER_CAP = 100;

const SettingsButton = ({
  endpoint,
  className,
  handleOpenKeyDialog,
}: {
  endpoint: Endpoint;
  className?: string;
  handleOpenKeyDialog: (endpoint: EModelEndpoint, e: React.MouseEvent) => void;
}) => {
  const localize = useLocalize();
  const text = localize('com_endpoint_config_key');

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!endpoint.value) {
      return;
    }
    e.stopPropagation();
    handleOpenKeyDialog(endpoint.value as EModelEndpoint, e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (endpoint.value) {
        handleOpenKeyDialog(endpoint.value as EModelEndpoint, e as unknown as React.MouseEvent);
      }
    }
  };

  return (
    <button
      type="button"
      id={`endpoint-${endpoint.value}-settings`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/button flex items-center gap-1.5 rounded-md px-1.5',
        'text-text-secondary transition-colors duration-150',
        'hover:bg-surface-tertiary hover:text-text-primary',
        'focus-visible:bg-surface-tertiary focus-visible:text-text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        className,
      )}
      aria-label={`${text} ${endpoint.label}`}
    >
      <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        aria-hidden="true"
        className={cn(
          'grid overflow-hidden transition-[grid-template-columns,opacity] duration-150 ease-out',
          'grid-cols-[0fr] opacity-0',
          'group-hover/button:grid-cols-[1fr] group-hover/button:opacity-100',
          'group-focus-visible/button:grid-cols-[1fr] group-focus-visible/button:opacity-100',
        )}
      >
        <span className="min-w-0 truncate pr-0.5">{text}</span>
      </span>
    </button>
  );
};

/**
 * Lazily-rendered content for an endpoint submenu. By extracting this into a
 * separate component, the expensive model-list rendering (and per-item hooks
 * such as MutationObservers in EndpointModelItem) only runs when the submenu
 * is actually mounted — which Ariakit defers via `unmountOnHide`.
 */
function EndpointMenuContent({
  endpoint,
  endpointIndex,
}: {
  endpoint: Endpoint;
  endpointIndex: number;
}) {
  const localize = useLocalize();
  const { agentsMap, assistantsMap, modelSpecs, selectedValues, endpointSearchValues } =
    useModelSelectorContext();
  const { modelSpec: selectedSpec } = selectedValues;
  const searchValue = endpointSearchValues[endpoint.value] || '';

  const endpointSpecs = useMemo(() => {
    if (!modelSpecs || !modelSpecs.length) {
      return [];
    }
    return modelSpecs.filter((spec: TModelSpec) => spec.group === endpoint.value);
  }, [modelSpecs, endpoint.value]);

  if (isAssistantsEndpoint(endpoint.value) && endpoint.models === undefined) {
    return (
      <div
        className="flex items-center justify-center p-2"
        role="status"
        aria-label={localize('com_ui_loading')}
      >
        <Spinner aria-hidden="true" />
      </div>
    );
  }

  const filteredModels = searchValue
    ? filterModels(
        endpoint,
        (endpoint.models || []).map((model) => model.name),
        searchValue,
        agentsMap,
        assistantsMap,
      )
    : null;
  const allModelNames = filteredModels ?? endpoint.models?.map((model) => model.name) ?? [];
  // Windowing: cap how many model rows are mounted at once. A `fetch:true`
  // provider (e.g. OpenRouter) can carry 300+ models; mounting them all makes
  // opening the submenu slow (each row is an Ariakit item + observers). Render
  // only the first MODEL_RENDER_CAP; the rest stay reachable via the endpoint's
  // own search box, which re-filters the full list. (Full DOM virtualization is
  // avoided deliberately: it would break Ariakit's cross-item keyboard
  // navigation and typeahead, which can't navigate to unmounted items.)
  const capped = allModelNames.length > MODEL_RENDER_CAP;
  const renderedModels = capped ? allModelNames.slice(0, MODEL_RENDER_CAP) : allModelNames;
  const showMarketplace =
    endpoint.showMarketplace === true && marketplaceSearchMatches(searchValue, localize);
  const hasSelectableRows = endpointSpecs.length > 0 || renderedModels.length > 0;

  return (
    <>
      {showMarketplace && <MarketplaceItem label={localize('com_agents_marketplace')} />}
      {showMarketplace && hasSelectableRows && <CustomMenuSeparator />}
      {endpointSpecs.map((spec: TModelSpec) => (
        <ModelSpecItem key={spec.name} spec={spec} isSelected={selectedSpec === spec.name} />
      ))}
      {endpoint.models &&
        renderEndpointModels(endpoint, endpoint.models, renderedModels, endpointIndex)}
      {capped && (
        <div
          className="px-3 py-2 text-xs text-text-secondary"
          role="note"
          data-testid="model-list-capped-note"
        >
          {localize('com_endpoint_models_capped', {
            0: String(MODEL_RENDER_CAP),
            1: String(allModelNames.length),
          })}
        </div>
      )}
    </>
  );
}

export function EndpointItem({ endpoint, endpointIndex }: EndpointItemProps) {
  const localize = useLocalize();
  const {
    selectedValues,
    handleOpenKeyDialog,
    handleSelectEndpoint,
    endpointSearchValues,
    setEndpointSearchValue,
    endpointRequiresUserKey,
  } = useModelSelectorContext();
  const { endpoint: selectedEndpoint, modelSpec: selectedSpec } = selectedValues;

  const searchValue = endpointSearchValues[endpoint.value] || '';
  const isUserProvided = useMemo(
    () => endpointRequiresUserKey(endpoint.value),
    [endpointRequiresUserKey, endpoint.value],
  );

  const isAssistantsNotLoaded =
    isAssistantsEndpoint(endpoint.value) && endpoint.models === undefined;

  const renderIconLabel = () => (
    <div className="flex min-w-0 items-center gap-2">
      {endpoint.icon && (
        <div className="flex shrink-0 items-center justify-center" aria-hidden="true">
          {endpoint.icon}
        </div>
      )}
      <span className="truncate text-left">{endpoint.label}</span>
    </div>
  );

  const isEndpointSelected = !selectedSpec && selectedEndpoint === endpoint.value;

  if (!shouldRenderEndpointOption(endpoint)) {
    return null;
  }

  if (endpoint.hasModels) {
    const placeholder =
      isAgentsEndpoint(endpoint.value) || isAssistantsEndpoint(endpoint.value)
        ? localize('com_endpoint_search_var', { 0: endpoint.label })
        : localize('com_endpoint_search_endpoint_models', { 0: endpoint.label });
    return (
      <Menu
        id={`endpoint-${endpoint.value}-menu`}
        key={`endpoint-${endpoint.value}-item`}
        searchValue={searchValue}
        onSearch={(value) => setEndpointSearchValue(endpoint.value, value)}
        combobox={<input placeholder=" " />}
        comboboxLabel={placeholder}
        onClick={() => handleSelectEndpoint(endpoint)}
        label={
          <div className="group flex w-full min-w-0 items-center justify-between gap-1.5 py-1 text-sm">
            {renderIconLabel()}
            <div className="flex shrink-0 items-center gap-1">
              {isUserProvided && (
                <SettingsButton endpoint={endpoint} handleOpenKeyDialog={handleOpenKeyDialog} />
              )}
              {isEndpointSelected && (
                <>
                  <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
                  <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
                </>
              )}
            </div>
          </div>
        }
      >
        <EndpointMenuContent endpoint={endpoint} endpointIndex={endpointIndex} />
      </Menu>
    );
  } else {
    return (
      <MenuItem
        id={`endpoint-${endpoint.value}-menu`}
        key={`endpoint-${endpoint.value}-item`}
        onClick={() => handleSelectEndpoint(endpoint)}
        aria-selected={isEndpointSelected || undefined}
        className="group flex w-full cursor-pointer items-center justify-between gap-1.5 py-2 text-sm"
      >
        {renderIconLabel()}
        <div className="flex shrink-0 items-center gap-2">
          {endpointRequiresUserKey(endpoint.value) && (
            <SettingsButton endpoint={endpoint} handleOpenKeyDialog={handleOpenKeyDialog} />
          )}
          {isAssistantsNotLoaded && (
            <TooltipAnchor
              description={localize('com_ui_click_to_view_var', { 0: endpoint.label })}
              side="top"
              render={
                <span className="flex items-center">
                  <MousePointerClick className="size-4 text-text-secondary" aria-hidden="true" />
                </span>
              }
            />
          )}
          {isEndpointSelected && !isAssistantsNotLoaded && (
            <>
              <CheckCircle2 className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
              <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
            </>
          )}
        </div>
      </MenuItem>
    );
  }
}

export function renderEndpoints(mappedEndpoints: Endpoint[]) {
  return mappedEndpoints.map((endpoint, index) => (
    <EndpointItem
      endpoint={endpoint}
      endpointIndex={index}
      key={`endpoint-${endpoint.value}-${index}`}
    />
  ));
}
