import type { MeteringClient, TraceContext } from "@helix/sdk-types";

export interface EmitSeatDeltaInput {
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly orgId: string;
  readonly quantity: number;
  readonly source: string;
  readonly reason: string;
  readonly actorId: string;
  readonly invitedByActorId?: string | undefined;
  readonly trace?: TraceContext | undefined;
}

export function emitSeatDelta(input: EmitSeatDeltaInput): void {
  void input.metering
    ?.emit(
      input.orgId,
      {
        type: "seats.delta",
        quantity: input.quantity,
        metadata: {
          source: input.source,
          reason: input.reason,
          actorId: input.actorId,
          ...(input.invitedByActorId === undefined
            ? {}
            : { invitedByActorId: input.invitedByActorId }),
        },
      },
      input.trace,
    )
    .catch((error: unknown) => {
      input.onMeteringError?.(error);
    });
}
