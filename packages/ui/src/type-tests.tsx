import type { ReactElement } from 'react';
import {
  Accordion,
  Banner,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  EmptyState,
  Fact,
  IconButton,
  KeyValueList,
  KeyValueRow,
  PageHeader,
  RouteChip,
  Select,
  StatCard,
  Stepper,
  Switch,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  type BadgeKind,
  type FactState,
  type RouteChipVariant,
  type SemanticTone,
  type StepState,
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
type ExpectedSemanticTones = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'decision';
type ExpectedStepStates = 'done' | 'active' | 'pending';

const badgeKindsAreExact: Equal<BadgeKind, ExpectedBadgeKinds> = true;
const factStatesAreExact: Equal<FactState, ExpectedFactStates> = true;
const routeChipVariantsAreExact: Equal<RouteChipVariant, ExpectedRouteChipVariants> = true;
const semanticTonesAreExact: Equal<SemanticTone, ExpectedSemanticTones> = true;
const stepStatesAreExact: Equal<StepState, ExpectedStepStates> = true;
const noExtraBadgeKind: IsNever<Exclude<BadgeKind, ExpectedBadgeKinds>> = true;
const noExtraFactState: IsNever<Exclude<FactState, ExpectedFactStates>> = true;
const noExtraSemanticTone: IsNever<Exclude<SemanticTone, ExpectedSemanticTones>> = true;

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

const cardHeaderElement: ReactElement = (
  <CardHeader title="Capacity" subtitle="Slots per lane" actions={<Chip tone="ok">ok</Chip>} />
);
const cardBodyElement: ReactElement = <CardBody flush>edge-to-edge</CardBody>;
const cardFooterElement: ReactElement = <CardFooter>footnote</CardFooter>;
const pageHeaderElement: ReactElement = (
  <PageHeader pretitle="lane" title="Lanes" description="Station lanes" actions={<Chip>meta</Chip>} />
);
const emptyStateElement: ReactElement = (
  <EmptyState title="No lanes" description="Nothing assigned yet" />
);
const bannerElement: ReactElement = (
  <Banner tone="decision" title="Blocked" meta="one-way door">
    this lane is blocked
  </Banner>
);
const buttonElement: ReactElement = (
  <Button tone="accent" variant="solid" size="lg">
    Dispatch
  </Button>
);
const switchElement: ReactElement = <Switch checked onChange={(next: boolean) => next} label="show ended" />;
const selectElement: ReactElement = (
  <Select label="project" defaultValue="core">
    <option value="core">core</option>
  </Select>
);
const accordionElement: ReactElement = (
  <Accordion summary="Worktree" meta="/tmp">
    content
  </Accordion>
);
const statCardElement: ReactElement = (
  <StatCard label="attempts" value={3} subtext="today" tone="ok" progress={60} />
);
const tableElement: ReactElement = (
  <TableContainer>
    <Table stickyHeader>
      <Thead>
        <Tr>
          <Th mono strong align="right">
            lane
          </Th>
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td mono strong align="right">
            7
          </Td>
        </Tr>
      </Tbody>
    </Table>
  </TableContainer>
);
const keyValueListElement: ReactElement = (
  <KeyValueList>
    <KeyValueRow term="worktree" mono>
      /tmp/fleet
    </KeyValueRow>
  </KeyValueList>
);
const stepperElement: ReactElement = (
  <Stepper
    steps={[
      { id: 'dispatch', label: 'Dispatch', state: 'done' },
      { id: 'verify', label: 'Verify', state: 'active', tone: 'accent' },
      { id: 'decide', label: 'Decide', state: 'pending', tone: 'decision' },
    ]}
  />
);
const chipElement: ReactElement = <Chip tone="warn" mono title="route gap">gap</Chip>;

export {
  badgeKindsAreExact,
  factStatesAreExact,
  routeChipVariantsAreExact,
  semanticTonesAreExact,
  stepStatesAreExact,
  noExtraBadgeKind,
  noExtraFactState,
  noExtraSemanticTone,
  badgeElement,
  factElement,
  cardElement,
  iconButtonElement,
  routeChipElement,
  cardHeaderElement,
  cardBodyElement,
  cardFooterElement,
  pageHeaderElement,
  emptyStateElement,
  bannerElement,
  buttonElement,
  switchElement,
  selectElement,
  accordionElement,
  statCardElement,
  tableElement,
  keyValueListElement,
  stepperElement,
  chipElement,
};