// ══════════════════════════════════════════════════
//  ZET ROYALE V2 — Spatial Math Engine
// ══════════════════════════════════════════════════

/** Haversine distance in kilometers between two coordinates */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Distance in meters */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversine(lat1, lon1, lat2, lon2) * 1000;
}

/**
 * Compute ETA in minutes from a vehicle to a target coordinate.
 * Uses the vehicle's effective speed with a floor of 16 km/h
 * and a road curvature factor of 1.15.
 */
export function computeETA(
  vehicleLat: number, vehicleLon: number,
  targetLat: number, targetLon: number,
  effectiveSpeedKmh: number
): number {
  const dist = haversine(vehicleLat, vehicleLon, targetLat, targetLon);
  const roadFactor = 1.15;
  const speed = Math.max(effectiveSpeedKmh, 16);
  return Math.round((dist * roadFactor) / speed * 60);
}

/**
 * UNIVERSAL DIRECTION DETECTION
 * Instead of checking latitude delta (which only works for N-S routes),
 * we check: "is this vehicle getting closer to the target, or further away?"
 * Works for any geometry — north-south, east-west, diagonal.
 */
export function isApproachingTarget(
  prevLat: number, prevLon: number,
  currLat: number, currLon: number,
  targetLat: number, targetLon: number,
  wasApproaching: boolean
): boolean {
  const prevDist = haversine(prevLat, prevLon, targetLat, targetLon);
  const currDist = haversine(currLat, currLon, targetLat, targetLon);
  
  // Apply a 50m (0.05km) hysteresis to prevent GPS jitter from flipping the direction.
  if (wasApproaching) {
    // If it was approaching, it must move AWAY by > 50m to be considered 'not approaching'.
    if (currDist > prevDist + 0.05) return false;
    return true;
  } else {
    // If it was NOT approaching, it must move CLOSER by > 50m to be considered 'approaching'.
    if (currDist < prevDist - 0.05) return true;
    return false;
  }
}

/** Walking time in minutes from point A to point B at 1.4 m/s */
export function walkingTime(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const distM = haversineM(lat1, lon1, lat2, lon2);
  return distM / (1.4 * 60); // 1.4 m/s walking speed
}

/** Calculate true bearing (0-360) from point A to point B */
export function calculateHeading(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

export function fmtTime(min: number | null): string {
  if (min == null || isNaN(min)) return '--:--';
  const isNeg = min < 0;
  const absMin = Math.abs(min);
  let m = Math.floor(absMin);
  let s = Math.round((absMin - m) * 60);
  
  if (s === 60) {
    m += 1;
    s = 0;
  }
  
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${isNeg ? '-' : ''}${String(h).padStart(2, '0')}:${String(remM).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  
  return `${isNeg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format minutes as "Xm" string */
export function fmtMin(min: number | null): string {
  if (min == null || isNaN(min)) return '--m';
  return `${Math.round(min)}m`;
}
