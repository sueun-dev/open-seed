/**
 * Spawn Reservation System (inspired by oh-my-openagent).
 *
 * Prevents concurrent agent overload by:
 * - Limiting total active agent spawns
 * - Reserving slots before spawning
 * - Queuing excess requests
 * - Tracking parent-child session relationships
 * - Releasing slots on completion or failure
 */

export interface SpawnReservation {
  id: string;
  sessionId: string;
  parentSessionId?: string;
  roleId: string;
  status: "reserved" | "active" | "completed" | "failed";
  reservedAt: string;
  activatedAt?: string;
  completedAt?: string;
}

export interface SpawnLimits {
  maxConcurrentAgents: number;
  maxPerParentSession: number;
  maxQueueDepth: number;
}

const DEFAULT_LIMITS: SpawnLimits = {
  maxConcurrentAgents: 6,
  maxPerParentSession: 4,
  maxQueueDepth: 20
};

export class SpawnReservationManager {
  private reservations: Map<string, SpawnReservation> = new Map();
  private queue: Array<{
    resolve: (reservation: SpawnReservation) => void;
    reject: (error: Error) => void;
    request: { sessionId: string; parentSessionId?: string; roleId: string };
  }> = [];
  private limits: SpawnLimits;

  constructor(limits?: Partial<SpawnLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async reserve(params: {
    sessionId: string;
    parentSessionId?: string;
    roleId: string;
  }): Promise<SpawnReservation> {
    // Check if we can reserve immediately
    if (this.canReserve(params.parentSessionId)) {
      return this.createReservation(params);
    }

    // Check queue depth
    if (this.queue.length >= this.limits.maxQueueDepth) {
      throw new Error(`Spawn queue full (${this.limits.maxQueueDepth}). Cannot queue more agents.`);
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, request: params });
    });
  }

  activate(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Reservation not found: ${reservationId}`);
    reservation.status = "active";
    reservation.activatedAt = new Date().toISOString();
  }

  complete(reservationId: string): void {
    this.finish(reservationId, "completed");
  }

  fail(reservationId: string): void {
    this.finish(reservationId, "failed");
  }

  private finish(reservationId: string, status: "completed" | "failed"): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    reservation.status = status;
    reservation.completedAt = new Date().toISOString();
    this.reservations.delete(reservationId);

    // Process queue
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.canReserve(next.request.parentSessionId)) break;
      this.queue.shift();
      const reservation = this.createReservation(next.request);
      next.resolve(reservation);
    }
  }

  private canReserve(parentSessionId?: string): boolean {
    const active = this.getActiveCount();
    if (active >= this.limits.maxConcurrentAgents) return false;

    if (parentSessionId) {
      const parentActive = this.getActiveCountForParent(parentSessionId);
      if (parentActive >= this.limits.maxPerParentSession) return false;
    }

    return true;
  }

  private createReservation(params: {
    sessionId: string;
    parentSessionId?: string;
    roleId: string;
  }): SpawnReservation {
    const reservation: SpawnReservation = {
      id: `rsv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: params.sessionId,
      parentSessionId: params.parentSessionId,
      roleId: params.roleId,
      status: "reserved",
      reservedAt: new Date().toISOString()
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  getActiveCount(): number {
    return Array.from(this.reservations.values())
      .filter((r) => r.status === "reserved" || r.status === "active").length;
  }

  getActiveCountForParent(parentSessionId: string): number {
    return Array.from(this.reservations.values())
      .filter((r) => r.parentSessionId === parentSessionId && (r.status === "reserved" || r.status === "active")).length;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getStatus(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    reservations: SpawnReservation[];
  } {
    return {
      active: this.getActiveCount(),
      queued: this.queue.length,
      maxConcurrent: this.limits.maxConcurrentAgents,
      reservations: Array.from(this.reservations.values())
    };
  }
}
