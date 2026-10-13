import type { ReactElement } from 'react';
import {
  Badge,
  Card,
  Fact,
  IconButton,
  RouteChip,
  type BadgeKind,
  type FactState,
  type RouteChipVariant,
} from './index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

type ExpectedBadgeKinds =
  | 'active'
  | 'ended'
  | 'unknown'
  | 'blocked'
  | 'queued'
  | 'accepted'
  | 'failed'
  | 'fix'
  | 'keeper'
  | 'candidate';
type ExpectedFactStates = 'yes' | 'no' | 'unknown' | 'stale';
type ExpectedRouteChipVariants = 'plain' | 'gap';

const badgeKindsAreExact: Equal<BadgeKind, ExpectedBadgeKinds> = true;
const factStatesAreExact: Equal<FactState, ExpectedFactStates> = true;
const routeChipVariantsAreExact: Equal<RouteChipVariant, ExpectedRouteChipVariants> = true;
const noExtraBadgeKind: IsNever<Exclude<BadgeKind, ExpectedBadgeKinds>> = true;
const noExtraFactState: IsNever<Exclude<FactState, ExpectedFactStates>> = true;

const badgeElement: ReactElement = <Badge kind="active">running</Badge>;
const factElement: ReactElement = <Fact state="unknown" />;
const cardElement: ReactElement = (
  <Card padded>
    <p>inside</p>
  </Card>
);
const iconButtonElement: ReactElement = (
  <IconButton label="Read the station again">
    <svg viewBox="0 0 24 24" aria-hidden="true" />
  </IconButton>
);
const routeChipElement: ReactElement = <RouteChip variant="gap">gap</RouteChip>;

export {
  badgeKindsAreExact,
  factStatesAreExact,
  routeChipVariantsAreExact,
  noExtraBadgeKind,
  noExtraFactState,
  badgeElement,
  factElement,
  cardElement,
  iconButtonElement,
  routeChipElement,
};
