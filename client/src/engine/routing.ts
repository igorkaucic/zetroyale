// ══════════════════════════════════════════════════
//  ZET ROYALE V2 — Client Routing Engine
//  Matches server journey chains against live vehicles.
// ══════════════════════════════════════════════════

import type { RawVehicle, EnrichedVehicle, Journey, JourneyLeg, ActiveLeg, UserProfile, TransitLocation } from '../types/transit';
import { haversineM, calculateHeading } from './math';

/**
 * Enrich raw vehicles with distance/ETA to a target stop.
 */
export function enrichVehicles(
    vehicles: RawVehicle[],
    targetStop: TransitLocation | null,
    _relevantRoutes: string[] = []
): EnrichedVehicle[] {
    return vehicles.map(v => {
        let distToTarget = 0;
        let etaToTarget = 0;
        let approachingTarget = false;

        if (targetStop && targetStop.lat !== 0) {
            distToTarget = haversineM(v.lat, v.lon, targetStop.lat, targetStop.lon) / 1000;
            const speed = Math.max(v.speed > 5 ? v.speed : 25, 10);
            etaToTarget = (distToTarget / speed) * 60;

            const h = v.heading || v.bearing || 0;
            if (h !== 0) {
                const brng = calculateHeading(v.lat, v.lon, targetStop.lat, targetStop.lon);
                let diff = Math.abs(h - brng);
                if (diff > 180) diff = 360 - diff;
                approachingTarget = diff <= 90;
            }
        }

        return {
            ...v,
            approachingTarget,
            distToTarget,
            etaToTarget,
            avgSpeed: v.speed,
            heading: v.heading || v.bearing || 0,
        } as EnrichedVehicle;
    });
}

/**
 * Find the best vehicle to track.
 * Prefers: currently tracked > approaching + closest ETA
 */
export function getBestVehicle(
    vehicles: EnrichedVehicle[],
    currentTrackedId: string | null
): EnrichedVehicle | null {
    if (vehicles.length === 0) return null;

    if (currentTrackedId) {
        const current = vehicles.find(v => v.id === currentTrackedId);
        if (current && current.approachingTarget && current.distToTarget < 15) {
            return current;
        }
    }

    const approaching = vehicles.filter(v => v.approachingTarget && v.distToTarget < 15);
    if (approaching.length > 0) {
        return approaching.sort((a, b) => a.etaToTarget - b.etaToTarget)[0];
    }

    return [...vehicles].sort((a, b) => a.distToTarget - b.distToTarget)[0];
}

/**
 * Detect which leg the user is on based on GPS + profile.
 */
export function detectActiveLeg(
    userLat: number,
    userLon: number,
    profile: UserProfile
): ActiveLeg {
    if (!profile || !profile.home || profile.home.lat === 0) return { type: 'idle' };

    const home = profile.home;
    const allPlaces = [...(profile.hubs || []), ...(profile.destinations || [])];
    if (allPlaces.length === 0) return { type: 'idle' };

    // Always route FROM current GPS position TO the farthest saved location.
    // Logic: you want to GO to the place you're NOT at. The farthest one is the destination.
    const distToHome = haversineM(userLat, userLon, home.lat, home.lon);

    // Build candidates: home + all places
    const candidates: { loc: TransitLocation; dist: number }[] = [
        { loc: home, dist: distToHome },
    ];
    allPlaces.forEach(p => {
        candidates.push({ loc: p, dist: haversineM(userLat, userLon, p.lat, p.lon) });
    });

    // Destination = the farthest location from user's GPS
    candidates.sort((a, b) => b.dist - a.dist);
    const destination = candidates[0].loc;

    // Origin = a virtual "current location" marker (the planner uses GPS coords anyway)
    const origin: TransitLocation = {
        id: 'gps_current',
        name: 'Current Location',
        type: 'home' as any, // doesn't matter, planner uses GPS
        lat: userLat,
        lon: userLon,
        connectedRoutes: [],
    };

    return { type: 'custom', from: origin, to: destination };
}

/**
 * Get route IDs relevant to the active leg.
 * Returns empty — routes are populated from the journey planner API response.
 */
export function getRelevantRoutes(_leg: ActiveLeg, _profile?: UserProfile): string[] {
    return [];
}

/**
 * Match server journey chain legs against live vehicle positions.
 * Returns a Journey with real-time ETAs and vehicle locks.
 */
export function computeJourneyLegs(
    chainLegs: any[],
    vehicles: any[],
    userLat: number,
    userLon: number
): Journey | null {
    if (!chainLegs || chainLegs.length === 0) return null;

    let cumulativeEta = 0;
    let allFeasible = true;

    const legs: JourneyLeg[] = chainLegs.map((leg: any, idx: number) => {
        const boardStop: TransitLocation = {
            id: leg.departureStop?.id || '', name: leg.departureStop?.name || '',
            lat: leg.departureStop?.lat || 0, lon: leg.departureStop?.lon || 0,
            type: 'hub', connectedRoutes: [leg.route]
        };
        const exitStop: TransitLocation = {
            id: leg.arrivalStop?.id || '', name: leg.arrivalStop?.name || '',
            lat: leg.arrivalStop?.lat || 0, lon: leg.arrivalStop?.lon || 0,
            type: 'destination', connectedRoutes: [leg.route]
        };

        // ── TRIP-AWARE VEHICLE MATCHING ──
        // Priority 1: Match by exact tripId from the journey planner.
        // The server already computed the exact GTFS trip — if that vehicle
        // is broadcasting GPS, lock onto it directly. No guessing.
        let vehicle: any = null;
        
        if (leg.tripId) {
            vehicle = vehicles.find((v: any) => v.tripId === leg.tripId) || null;
        }
        
        // Priority 2: If no exact tripId match (bus has no GPS), try route + direction.
        // But ONLY match vehicles that are still approaching the board stop,
        // not ones that have already passed it heading away.
        if (!vehicle) {
            const routeVehicles = vehicles.filter((v: any) => {
                if (String(v.routeId) !== String(leg.route) && String(v.routeId) !== String(leg.routeId)) return false;
                const dist = haversineM(v.lat, v.lon, boardStop.lat, boardStop.lon);
                if (dist > 15000) return false; // Too far away
                
                // GEOMETRIC DIRECTION FILTER
                // Ensure the vehicle's ultimate terminus is closer to the exit stop than the board stop.
                const termLat = v.terminusLat || (v.trueDest ? v.trueDest.lat : 0);
                const termLon = v.terminusLon || (v.trueDest ? v.trueDest.lon : 0);
                if (termLat && termLon && exitStop.lat && exitStop.lon) {
                    const boardDistToTerm = haversineM(boardStop.lat, boardStop.lon, termLat, termLon);
                    const exitDistToTerm = haversineM(exitStop.lat, exitStop.lon, termLat, termLon);
                    if (exitDistToTerm > boardDistToTerm + 300) {
                        return false; // Wrong direction!
                    }
                }
                
                // APPROACH FILTER: Vehicle must be heading in the direction of the journey leg.
                // It must be heading roughly from boardStop to exitStop.
                const h = v.heading || v.bearing || 0;
                if (h !== 0 && exitStop.lat && exitStop.lon) {
                    // What is the direction of the actual journey?
                    const legBearing = calculateHeading(boardStop.lat, boardStop.lon, exitStop.lat, exitStop.lon);
                    let diff = Math.abs(h - legBearing);
                    if (diff > 180) diff = 360 - diff;
                    
                    // Allow up to 90 degrees deviation (buses don't travel in straight lines)
                    // If it's more than 90, it's generally heading the wrong way.
                    if (diff > 90) {
                        return false;
                    }
                }

                // If it passed the stop, drop it (unless very close)
                if (h !== 0 && dist > 500) {
                    const brngToBoard = calculateHeading(v.lat, v.lon, boardStop.lat, boardStop.lon);
                    let angleDiff = Math.abs(h - brngToBoard);
                    if (angleDiff > 180) angleDiff = 360 - angleDiff;
                    if (angleDiff > 90) return false; // Heading away from board stop
                }

                return true;
            });
            routeVehicles.sort((a: any, b: any) => {
                const da = haversineM(a.lat, a.lon, boardStop.lat, boardStop.lon);
                const db = haversineM(b.lat, b.lon, boardStop.lat, boardStop.lon);
                return da - db;
            });

            vehicle = routeVehicles.length > 0 ? routeVehicles[0] : null;
        }

        // Compute ETA to board stop
        let vehicleEtaToBoardStop = 99;
        if (vehicle) {
            const dist = haversineM(vehicle.lat, vehicle.lon, boardStop.lat, boardStop.lon) / 1000;
            const speed = Math.max(vehicle.speed > 5 ? vehicle.speed : 25, 10);
            vehicleEtaToBoardStop = Math.round((dist / speed) * 60);
        }

        const rideMinutes = leg.rideMinutes || 10;
        const walkMinutes = leg.walkMinutes || 0;

        // Transfer buffer: for leg > 0, how much time between arriving at transfer and next vehicle
        let transferBuffer: number | null = null;
        if (idx > 0) {
            const prevLeg = chainLegs[idx - 1];
            transferBuffer = leg.waitMinutes || 2;
        }

        // A leg is feasible if we have a live vehicle OR if the server provided a scheduled departure.
        // The bus is still coming — it just might not have GPS turned on yet.
        const hasSchedule = !!leg.departure;
        const isFeasible = vehicle !== null || hasSchedule || idx > 0;
        if (idx === 0 && !vehicle && !hasSchedule) allFeasible = false;

        cumulativeEta += (idx === 0 ? walkMinutes : 0) + (leg.waitMinutes || 0) + rideMinutes;

        return {
            legIndex: idx,
            route: leg.route,
            vehicle: vehicle as EnrichedVehicle | null,
            boardStop,
            exitStop,
            vehicleEtaToBoardStop,
            rideTimeMinutes: rideMinutes,
            cumulativeEta,
            transferBuffer,
            isFeasible,
            // Pass through schedule data so the UI can show scheduled time when no GPS vehicle
            timeUserArrivesAtBoardStop: walkMinutes,
            scheduledDeparture: leg.departure || null,
        };
    });

    return {
        legs,
        totalMinutes: cumulativeEta,
        isFeasible: allFeasible,
        computedAt: Date.now(),
    };
}

/**
 * Pick the best journey chain from evaluated options.
 */
export function findBestChain(
    evaluated: { index: number; journey: Journey | null }[],
    _userLat: number,
    _userLon: number,
    activeRouteId?: string | null
): { index: number; journey: Journey } | null {
    const valid = evaluated.filter(e => e.journey !== null && e.journey.isFeasible) as { index: number; journey: Journey }[];

    if (valid.length > 0) {
        valid.sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);
        
        if (activeRouteId) {
            const current = valid.find(e => e.journey.legs.length > 0 && e.journey.legs[0].route === activeRouteId);
            if (current) {
                const absoluteBest = valid[0];
                // Stickiness: don't jump to a new vehicle unless it's >3 minutes faster.
                // This prevents UI thrashing when GPS accuracy jumps and alters walking distances.
                if (current.journey.totalMinutes <= absoluteBest.journey.totalMinutes + 3) {
                    return current;
                }
            }
        }
        
        return valid[0];
    }

    // Fallback: even infeasible is better than nothing
    const any = evaluated.filter(e => e.journey !== null) as { index: number; journey: Journey }[];
    if (any.length > 0) {
        any.sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);
        return any[0];
    }

    return null;
}

/**
 * Should we break the current vehicle lock?
 */
export function shouldBreakLock(
    _userLat: number,
    _userLon: number,
    _boardStop: TransitLocation | null,
    _vehicleEta: number | null,
    _startTime: number | null
): { shouldBreak: boolean; lateStartTime: number | null } {
    return { shouldBreak: false, lateStartTime: null };
}
