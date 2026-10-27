// Fixture for tests/hexagen-contract.test.sh. Pure domain code with no imports; never run.
export interface Order {
  readonly id: string;
  readonly totalCents: number;
}

export const addLine = (order: Order, cents: number): Order => ({
  ...order,
  totalCents: order.totalCents + cents,
});
