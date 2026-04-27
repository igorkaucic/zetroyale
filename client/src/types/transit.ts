// ══════════════════════════════════════════════════
//  ZET ROYALE V2 — Core Type Definitions
// ══════════════════════════════════════════════════

/** Raw vehicle data from the server (dumb proxy) */
export interface RawVehicle {
  id: string;
  routeId: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing: number;
  speed: number;
  heading: number;
  directionId: number | null;
  headsign?: string;
  terminusName?: string;
  terminusLat?: number;
  terminusLon?: number;
  trueDest?: { name: string; lat: number; lon: number } | null;
  isHZPP?: boolean;
  delay?: number;
  timestamp: number;
}

/** Server API response */
export interface ApiBusResponse {
  vehicles: RawVehicle[];
  lastUpdate: number;
  vehicleCount: number;
  routeCount: number;
}

/** A vehicle enriched with client-side computed data */
export interface EnrichedVehicle extends RawVehicle {
  /** Is this vehicle getting closer to the user's active target? */
  approachingTarget: boolean;
  /** Distance in km to the user's active target stop */
  distToTarget: number;
  /** ETA in minutes to the user's active target stop */
  etaToTarget: number;
  /** Computed average speed from history */
  avgSpeed: number;
  /** Computed heading from GPS delta (0-360) */
  heading: number;
  /** Previous positions for direction computation */
  prevLat?: number;
  prevLon?: number;
}

// ── Hub-and-Spoke Profile Types ────────────────────

export type LocationType = 'home' | 'hub' | 'destination' | 'target' | 'transfer';

/** A named location in the user's transit graph */
export interface TransitLocation {
  id: string;
  name: string;
  type: LocationType;
  lat: number;
  lon: number;
  /** Route IDs that connect this location to its hub (e.g., ['268', '7']) */
  connectedRoutes: string[];
  /** For destinations: which hub ID this destination routes through */
  hubId?: string;
}

/** The user's full transit profile stored in localStorage */
export interface UserProfile {
  id: string;
  name: string;
  home: TransitLocation | null;
  hubs: TransitLocation[];
  destinations: TransitLocation[];
}

/** Which leg of the journey the user is currently on */
export type ActiveLeg = 
  | { type: 'home_to_hub'; from: TransitLocation; to: TransitLocation }
  | { type: 'hub_to_destination'; from: TransitLocation; to: TransitLocation }
  | { type: 'destination_to_hub'; from: TransitLocation; to: TransitLocation }
  | { type: 'hub_to_home'; from: TransitLocation; to: TransitLocation }
  | { type: 'custom'; from: TransitLocation; to: TransitLocation }
  | { type: 'idle' };

/** Phase of the user's current extraction */
export type Phase = 'train' | 'walk' | 'extract';

// ── Multi-Leg Journey Planning ──────────────────────

/** One leg of a computed multi-vehicle journey */
export interface JourneyLeg {
  /** 0-based leg index */
  legIndex: number;
  /** Route ID for this leg, e.g. '268', '7', 'HŽPP' */
  route: string;
  /** Best live vehicle found for this leg. null = no vehicle in feed yet */
  vehicle: EnrichedVehicle | null;
  /** Where the user boards this vehicle */
  boardStop: TransitLocation;
  /** Where the user exits this vehicle (transfer point or final destination) */
  exitStop: TransitLocation;
  /** Minutes until the vehicle arrives at the board stop, from NOW */
  vehicleEtaToBoardStop: number;
  /** Estimated minutes spent riding from boardStop to exitStop */
  rideTimeMinutes: number;
  /** Minutes from NOW until this leg is complete (user arrives at exitStop) */
  cumulativeEta: number;
  /**
   * For transfer legs (legIndex > 0):
   * How many minutes the user has at the transfer stop before the connecting
   * vehicle departs. Positive = you make it. Negative = you miss it.
   * null for the first leg (no prior leg to transfer from).
   */
  transferBuffer: number | null;
  /** Can the user make this connection given current vehicle positions? */
  isFeasible: boolean;
  /** Walk time from user to board stop, in minutes */
  timeUserArrivesAtBoardStop?: number;
  /** Scheduled departure time string from GTFS (e.g. "07:22:20"), for schedule-only display */
  scheduledDeparture?: string | null;
}

/** A complete computed journey from current position to destination */
export interface Journey {
  legs: JourneyLeg[];
  /** Total minutes from NOW until user arrives at final destination */
  totalMinutes: number;
  /** True only if ALL legs are feasible simultaneously */
  isFeasible: boolean;
  /** Unix timestamp when this was computed */
  computedAt: number;
}
